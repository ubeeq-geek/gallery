import type { AssetRevision, DurableWorkflowService } from './durableWorkflows';

export interface ProcessingSource {
  tenantId: string;
  assetId: string;
  bytes: Uint8Array;
  expectedChecksumSha256?: string;
  maxBytes?: number;
}

export interface RenditionOutput {
  kind: string;
  bytes: Uint8Array;
  objectKey: string;
}

export interface ProcessingTools {
  extractMetadata(source: ProcessingSource): Promise<Record<string, string | number | boolean | null>>;
  render(source: ProcessingSource, kind: string): Promise<RenditionOutput>;
}

/**
 * Coordinates processing while leaving moderation outcomes to callers. The
 * orchestrator only enforces durable admission decisions and records results.
 */
export class ProcessingOrchestrator {
  constructor(private readonly workflows: DurableWorkflowService, private readonly tools: ProcessingTools) {}

  async execute(input: {
    jobId: string;
    workerId: string;
    source: ProcessingSource;
    renditionKinds: string[];
  }): Promise<AssetRevision> {
    const { jobId, workerId, source } = input;
    try {
      const processingAdmission = await this.workflows.checkAdmission(source.tenantId, [source.assetId], 'processing');
      if (!processingAdmission.admitted) throw Object.assign(new Error('Processing is held for review'), { code: 'ADMISSION_HELD', retryable: false });

      const validated = this.workflows.validateSource(source);
      const metadata = await this.tools.extractMetadata(source);
      const renditions = [];
      for (const kind of [...new Set(input.renditionKinds)]) {
        const request = await this.workflows.requestRendition(source.assetId, validated.checksumSha256, kind);
        const output = request.status === 'complete' && request.result
          ? { kind, bytes: new Uint8Array(), objectKey: request.result.objectKey }
          : await this.tools.render(source, kind);
        const result = request.result || { checksumSha256: this.workflows.checksum(output.bytes), objectKey: output.objectKey };
        await this.workflows.completeRendition(request.requestId, result);
        renditions.push({ requestId: request.requestId, kind, ...result });
      }

      const publicationAdmission = await this.workflows.checkAdmission(source.tenantId, [source.assetId], 'publishing');
      if (!publicationAdmission.admitted) throw Object.assign(new Error('Publication is held for review'), { code: 'ADMISSION_HELD', retryable: false });
      const revision = await this.workflows.publishAssetRevision({
        tenantId: source.tenantId,
        assetId: source.assetId,
        sourceChecksumSha256: validated.checksumSha256,
        metadata,
        renditions
      });
      await this.workflows.succeed(jobId, workerId, { assetId: source.assetId, revisionId: revision.revisionId });
      return revision;
    } catch (error) {
      const failure = error as Error & { code?: string; retryable?: boolean };
      await this.workflows.fail(jobId, workerId, {
        code: failure.code || 'PROCESSING_FAILED',
        message: failure.message,
        retryable: failure.retryable !== false
      });
      throw error;
    }
  }
}
