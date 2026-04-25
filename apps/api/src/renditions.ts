import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface SquareCropInput {
  x: number;
  y: number;
  size: number;
}

export interface CoverCropInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocalPointInput {
  x: number;
  y: number;
}

export interface GeneratedRenditions {
  keys: {
    w320: string;
    w640: string;
    w1280: string;
    w1920: string;
    square256: string;
    square512: string;
    square1024: string;
  };
  squareCrop: SquareCropInput;
  sourceWidth: number;
  sourceHeight: number;
  aspectRatio: number;
}

export interface GeneratedCreatorProfileRenditions {
  sourceKey: string;
  thumbnailKeys: {
    square256: string;
    square512: string;
    square1024: string;
  };
  squareCrop: SquareCropInput;
  sourceWidth: number;
  sourceHeight: number;
}

export interface GeneratedCreatorCoverRenditions {
  sourceKey: string;
  renditionKeys: {
    desktop: string;
    tablet: string;
    mobile: string;
  };
  crops: {
    desktop: CoverCropInput;
    tablet: CoverCropInput;
    mobile: CoverCropInput;
  };
  focalPoint: FocalPointInput;
  sourceWidth: number;
  sourceHeight: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const readS3Object = async (s3: S3Client, bucket: string, key: string): Promise<Buffer> => {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) {
    throw new Error(`S3 object has no body: s3://${bucket}/${key}`);
  }
  const bytes = await object.Body.transformToByteArray();
  return Buffer.from(bytes);
};

const writeS3Object = async (s3: S3Client, bucket: string, key: string, body: Buffer): Promise<void> => {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable'
    })
  );
};

const copyS3Object = async (s3: S3Client, bucket: string, sourceKey: string, targetKey: string): Promise<void> => {
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    CopySource: `${bucket}/${sourceKey}`,
    Key: targetKey,
    ContentType: 'image/jpeg',
    CacheControl: 'public, max-age=31536000, immutable',
    MetadataDirective: 'REPLACE'
  }));
};

const pickSquareCrop = (requested?: SquareCropInput): SquareCropInput => {
  if (!requested) {
    return { x: 0, y: 0, size: 1 };
  }
  const size = Math.max(1, Math.floor(requested.size));
  return { x: Math.max(0, Math.floor(requested.x)), y: Math.max(0, Math.floor(requested.y)), size };
};

export const generateImageRenditions = async (params: {
  s3: S3Client;
  bucket: string;
  sourceKey: string;
  targetPrefix: string;
  squareCrop?: SquareCropInput;
}): Promise<GeneratedRenditions> => {
  const { s3, bucket, sourceKey, targetPrefix, squareCrop } = params;
  const sourceBuffer = await readS3Object(s3, bucket, sourceKey);

  const keys = {
    w320: `${targetPrefix}/renditions/w320.jpg`,
    w640: `${targetPrefix}/renditions/w640.jpg`,
    w1280: `${targetPrefix}/renditions/w1280.jpg`,
    w1920: `${targetPrefix}/renditions/w1920.jpg`,
    square256: `${targetPrefix}/renditions/square256.jpg`,
    square512: `${targetPrefix}/renditions/square512.jpg`,
    square1024: `${targetPrefix}/renditions/square1024.jpg`
  };

  for (const key of Object.values(keys)) {
    await writeS3Object(s3, bucket, key, sourceBuffer);
  }

  const crop = pickSquareCrop(squareCrop);
  return {
    keys,
    squareCrop: crop,
    sourceWidth: 0,
    sourceHeight: 0,
    aspectRatio: 1
  };
};

export const generateCreatorProfileRenditions = async (params: {
  s3: S3Client;
  bucket: string;
  sourceKey: string;
  targetPrefix: string;
  squareCrop?: SquareCropInput;
}): Promise<GeneratedCreatorProfileRenditions> => {
  const generated = await generateImageRenditions(params);
  return {
    sourceKey: params.sourceKey,
    thumbnailKeys: {
      square256: generated.keys.square256,
      square512: generated.keys.square512,
      square1024: generated.keys.square1024
    },
    squareCrop: generated.squareCrop,
    sourceWidth: generated.sourceWidth,
    sourceHeight: generated.sourceHeight
  };
};

export const generateCreatorCoverRenditions = async (params: {
  s3: S3Client;
  bucket: string;
  sourceKey: string;
  targetPrefix: string;
  crops?: Partial<Record<'desktop' | 'tablet' | 'mobile', CoverCropInput>>;
  focalPoint?: FocalPointInput;
}): Promise<GeneratedCreatorCoverRenditions> => {
  const { s3, bucket, sourceKey, targetPrefix, crops, focalPoint } = params;
  const renditionKeys = {
    desktop: `${targetPrefix}/renditions/desktop.jpg`,
    tablet: `${targetPrefix}/renditions/tablet.jpg`,
    mobile: `${targetPrefix}/renditions/mobile.jpg`
  };
  await copyS3Object(s3, bucket, sourceKey, renditionKeys.desktop);
  await copyS3Object(s3, bucket, sourceKey, renditionKeys.tablet);
  await copyS3Object(s3, bucket, sourceKey, renditionKeys.mobile);

  return {
    sourceKey,
    renditionKeys,
    crops: {
      desktop: crops?.desktop || { x: 0, y: 0, width: 2400, height: 900 },
      tablet: crops?.tablet || { x: 0, y: 0, width: 1600, height: 700 },
      mobile: crops?.mobile || { x: 0, y: 0, width: 900, height: 1200 }
    },
    focalPoint: {
      x: clamp(focalPoint?.x ?? 0.5, 0, 1),
      y: clamp(focalPoint?.y ?? 0.5, 0, 1)
    },
    sourceWidth: 0,
    sourceHeight: 0
  };
};
