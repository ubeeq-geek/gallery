import type { AiDisclosure } from './domain';
import {
  capabilityFor,
  type IntegrationMediaType,
  type IntegrationPlatformId
} from './integrationCapabilities';

export type IntegrationPreflightIntent = 'publish' | 'announce';
export type IntegrationPreflightSeverity = 'blocking' | 'warning';

export interface IntegrationPreflightInput {
  platform: IntegrationPlatformId;
  intent?: IntegrationPreflightIntent;
  mediaTypes?: readonly IntegrationMediaType[];
  aiDisclosures?: readonly AiDisclosure[];
  /**
   * Number of assets in one remote publication (for example, carousel
   * children). A selection of independent Works must not be passed here:
   * bulk publishing creates one remote publication per Work.
   */
  itemCount?: number;
  caption?: string;
  mimeTypes?: readonly string[];
  bytes?: number;
}

export interface IntegrationPreflightIssue {
  code:
    | 'unsupported_operation'
    | 'unsupported_media'
    | 'configuration_required'
    | 'mixed_ai_carousel'
    | 'maximum_items_exceeded'
    | 'caption_too_long'
    | 'unsupported_mime_type'
    | 'asset_too_large';
  severity: IntegrationPreflightSeverity;
  message: string;
}

export interface IntegrationPreflightResult {
  platform: IntegrationPlatformId;
  intent: IntegrationPreflightIntent;
  issues: IntegrationPreflightIssue[];
  ok: boolean;
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const supportsMimeType = (allowed: readonly string[], mimeType: string): boolean =>
  allowed.some((pattern) => pattern === mimeType || (pattern.endsWith('/*') && mimeType.startsWith(pattern.slice(0, -1))));

/**
 * Destination-neutral validation for the Review & publish flow.
 *
 * This deliberately validates only facts that are known before a job is
 * queued. Provider API calls, account health, and permission checks still run
 * in the durable external-job worker immediately before delivery.
 */
export const preflightIntegrationPublication = (
  input: IntegrationPreflightInput
): IntegrationPreflightResult => {
  const capability = capabilityFor(input.platform);
  const intent = input.intent ?? 'publish';
  const issues: IntegrationPreflightIssue[] = [];
  const mediaTypes = unique(input.mediaTypes ?? []);

  if (capability.limits.rollout?.state === 'configuration_required') {
    issues.push({
      code: 'configuration_required',
      severity: 'blocking',
      message: `${capability.label} has not been configured for this deployment.`
    });
  }

  if (intent === 'announce' ? !capability.announce : mediaTypes.some((type) => !capability.publish[type])) {
    issues.push({
      code: 'unsupported_operation',
      severity: 'blocking',
      message: intent === 'announce'
        ? `${capability.label} cannot announce this publication.`
        : `${capability.label} cannot publish one or more selected Work types.`
    });
  }

  for (const mediaType of mediaTypes) {
    if (intent === 'publish' && !capability.publish[mediaType]) {
      issues.push({
        code: 'unsupported_media',
        severity: 'blocking',
        message: `${capability.label} does not support publishing ${mediaType} Works.`
      });
    }
  }

  if (
    mediaTypes.includes('carousel') &&
    capability.aiLabel.carouselPrecision === 'whole-carousel' &&
    unique(input.aiDisclosures ?? []).length > 1
  ) {
    issues.push({
      code: 'mixed_ai_carousel',
      severity: 'warning',
      message: `${capability.label} can disclose AI provenance only for the whole carousel. Its parent publication will use one disclosure for mixed assets.`
    });
  }

  const mediaLimits = capability.limits.media;
  if (mediaLimits?.maximumItems !== undefined && input.itemCount !== undefined && input.itemCount > mediaLimits.maximumItems) {
    issues.push({
      code: 'maximum_items_exceeded',
      severity: 'blocking',
      message: `${capability.label} allows at most ${mediaLimits.maximumItems} items in this publication.`
    });
  }
  if (
    mediaLimits?.maximumCaptionCharacters !== undefined &&
    input.caption !== undefined &&
    input.caption.length > mediaLimits.maximumCaptionCharacters
  ) {
    issues.push({
      code: 'caption_too_long',
      severity: 'blocking',
      message: `${capability.label} captions are limited to ${mediaLimits.maximumCaptionCharacters.toLocaleString()} characters.`
    });
  }
  if (
    mediaLimits?.allowedMimeTypes?.length &&
    input.mimeTypes?.some((mimeType) => !supportsMimeType(mediaLimits.allowedMimeTypes!, mimeType))
  ) {
    issues.push({
      code: 'unsupported_mime_type',
      severity: 'blocking',
      message: `${capability.label} does not support one or more selected media file types.`
    });
  }
  if (mediaLimits?.maximumBytes !== undefined && input.bytes !== undefined && input.bytes > mediaLimits.maximumBytes) {
    issues.push({
      code: 'asset_too_large',
      severity: 'blocking',
      message: `${capability.label} supports files up to ${Math.round(mediaLimits.maximumBytes / 1024 / 1024)} MB.`
    });
  }

  return {
    platform: input.platform,
    intent,
    issues,
    ok: !issues.some((issue) => issue.severity === 'blocking')
  };
};
