import type { AppConfig } from './config';
import type { InstagramCapabilities, InstagramMediaConstraints } from './instagramIntegration';
import { InstagramProvider } from './instagramProvider';

export interface InstagramDeploymentStatus {
  configured: boolean;
  onboardingEnabled: boolean;
  state: 'READY' | 'APP_REVIEW_REQUIRED' | 'NOT_CONFIGURED';
  apiVersion: string;
  policyProfile: 'instagram_public_safe';
  pilotCapabilities: Pick<InstagramCapabilities, 'accountRead' | 'mediaRead' | 'imagePublish' | 'carouselPublish' | 'reelPublish' | 'storyPublish' | 'insightsRead'>;
}

/** Phase 1 intentionally exposes image/carousel only. Later placements require a reviewed configuration change. */
export const instagramDeploymentStatus = (config: AppConfig): InstagramDeploymentStatus => {
  const configured = Boolean(config.instagramAppId && config.instagramAppSecret && config.instagramOAuthRedirectUri && config.instagramDeliverySecret && config.instagramDeliveryBaseUrl?.startsWith('https://'));
  return {
    configured,
    onboardingEnabled: configured && config.instagramAppReviewComplete === true,
    state: !configured ? 'NOT_CONFIGURED' : config.instagramAppReviewComplete ? 'READY' : 'APP_REVIEW_REQUIRED',
    apiVersion: config.instagramGraphApiVersion || 'v26.0',
    policyProfile: 'instagram_public_safe',
    pilotCapabilities: { accountRead: true, mediaRead: config.instagramMetadataImportEnabled === true, imagePublish: true, carouselPublish: true, reelPublish: config.instagramReelsEnabled === true, storyPublish: config.instagramStoriesEnabled === true, insightsRead: config.instagramInsightsEnabled === true }
  };
};

export const createManagedInstagramProvider = (config: AppConfig): InstagramProvider | undefined => {
  const deployment = instagramDeploymentStatus(config);
  if (!deployment.onboardingEnabled) return undefined;
  return new InstagramProvider({
    appId: config.instagramAppId!, appSecret: config.instagramAppSecret!, redirectUri: config.instagramOAuthRedirectUri!,
    apiVersion: config.instagramGraphApiVersion || 'v26.0',
    approvedCapabilities: {
      accountRead: true, imagePublish: true, carouselPublish: true,
      mediaRead: config.instagramMetadataImportEnabled === true, reelPublish: config.instagramReelsEnabled === true, storyPublish: config.instagramStoriesEnabled === true, mediaUpdate: false,
      mediaDeleteOrArchive: false, insightsRead: config.instagramInsightsEnabled === true, commentsRead: false, commentsReply: false
    }
  });
};

/** Versioned pilot constraints; update only alongside provider validation and release approval. */
export const INSTAGRAM_PILOT_MEDIA_CONSTRAINTS: InstagramMediaConstraints = Object.freeze({
  imageMimeTypes: ['image/jpeg'], videoMimeTypes: ['video/mp4'], maximumImageBytes: 8 * 1024 * 1024,
  maximumVideoBytes: 100 * 1024 * 1024, maximumReelDurationSeconds: 900, maximumStoryDurationSeconds: 60,
  minimumAspectRatio: 0.8, maximumAspectRatio: 1.91,
  maximumCarouselItems: 10, maximumCaptionCharacters: 2200
});

/** Normalization registry for the approved adapter version; no demographics or viewer identities. */
export const INSTAGRAM_PILOT_INSIGHT_METRICS = Object.freeze({
  reach: 'reach', views: 'views', likes: 'likes', comments: 'comments', saves: 'saved', shares: 'shares'
} as const);
