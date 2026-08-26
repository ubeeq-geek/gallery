import { Readable } from 'node:stream';
import { CopyObjectCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from './config';
import { FederationError } from './federation';
import type { FederationAssetStorage } from './federationAssetTransfer';

const safeKey = (prefix: string, key: string): string => {
  const normalizedPrefix = prefix.replace(/^\/+/, '').replace(/\/?$/, '/');
  const normalizedKey = key.replace(/^\/+/, '');
  if (!normalizedKey.startsWith(normalizedPrefix) || normalizedKey.includes('../')) throw new FederationError('asset_storage_forbidden', 'Federation asset key is outside the configured prefix');
  return normalizedKey;
};

export class S3FederationAssetStorage implements FederationAssetStorage {
  constructor(private readonly client: S3Client, private readonly bucket: string, private readonly prefix: string) {}
  async putQuarantine(key: string, body: AsyncIterable<Uint8Array>, metadata: Record<string, string>): Promise<void> {
    const objectKey = safeKey(this.prefix, key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: Readable.from(body), Metadata: metadata, ServerSideEncryption: 'AES256' }));
  }
  async promote(quarantineKey: string, destinationKey: string): Promise<void> {
    const source = safeKey(this.prefix, quarantineKey); const destination = safeKey(this.prefix, destinationKey);
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: destination, CopySource: `${this.bucket}/${source.split('/').map(encodeURIComponent).join('/')}`, ServerSideEncryption: 'AES256', MetadataDirective: 'COPY' }));
    await this.delete(source);
  }
  async delete(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(this.prefix, key) })); }
}

export const createFederationAssetStorage = (config: AppConfig): FederationAssetStorage => {
  if (!config.federationAssetBucket) throw new FederationError('federation_not_configured', 'Federation asset bucket is not configured');
  return new S3FederationAssetStorage(new S3Client({ region: config.awsRegion }), config.federationAssetBucket, config.federationAssetPrefix);
};

