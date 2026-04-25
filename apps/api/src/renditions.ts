import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

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

const readSourceMetadata = async (sourceBuffer: Buffer, bucket: string, sourceKey: string): Promise<{ width: number; height: number }> => {
  const metadata = await sharp(sourceBuffer, { limitInputPixels: false }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new Error(`Could not determine source image dimensions for s3://${bucket}/${sourceKey}`);
  }

  return { width, height };
};

const pickSquareCrop = (width: number, height: number, requested?: SquareCropInput): SquareCropInput => {
  const maxSide = Math.min(width, height);
  if (!requested) {
    return {
      x: Math.floor((width - maxSide) / 2),
      y: Math.floor((height - maxSide) / 2),
      size: maxSide
    };
  }

  const requestedSize = clamp(Math.floor(requested.size), 1, maxSide);
  return {
    x: clamp(Math.floor(requested.x), 0, width - requestedSize),
    y: clamp(Math.floor(requested.y), 0, height - requestedSize),
    size: requestedSize
  };
};

const pickCoverCrop = (
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  focalPoint: FocalPointInput,
  requested?: CoverCropInput
): CoverCropInput => {
  if (requested) {
    const width = clamp(Math.floor(requested.width), 1, sourceWidth);
    const height = clamp(Math.floor(requested.height), 1, sourceHeight);
    return {
      x: clamp(Math.floor(requested.x), 0, sourceWidth - width),
      y: clamp(Math.floor(requested.y), 0, sourceHeight - height),
      width,
      height
    };
  }

  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = sourceWidth / sourceHeight;
  const cropWidth = sourceAspect > targetAspect ? Math.round(sourceHeight * targetAspect) : sourceWidth;
  const cropHeight = sourceAspect > targetAspect ? sourceHeight : Math.round(sourceWidth / targetAspect);
  const centerX = clamp(focalPoint.x, 0, 1) * sourceWidth;
  const centerY = clamp(focalPoint.y, 0, 1) * sourceHeight;

  return {
    x: clamp(Math.round(centerX - cropWidth / 2), 0, sourceWidth - cropWidth),
    y: clamp(Math.round(centerY - cropHeight / 2), 0, sourceHeight - cropHeight),
    width: cropWidth,
    height: cropHeight
  };
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
  const { width, height } = await readSourceMetadata(sourceBuffer, bucket, sourceKey);
  const crop = pickSquareCrop(width, height, squareCrop);

  const keys = {
    w320: `${targetPrefix}/renditions/w320.jpg`,
    w640: `${targetPrefix}/renditions/w640.jpg`,
    w1280: `${targetPrefix}/renditions/w1280.jpg`,
    w1920: `${targetPrefix}/renditions/w1920.jpg`,
    square256: `${targetPrefix}/renditions/square256.jpg`,
    square512: `${targetPrefix}/renditions/square512.jpg`,
    square1024: `${targetPrefix}/renditions/square1024.jpg`
  };

  const longEdgeSteps: Array<[keyof typeof keys, number]> = [
    ['w320', 320],
    ['w640', 640],
    ['w1280', 1280],
    ['w1920', 1920]
  ];

  for (const [name, size] of longEdgeSteps) {
    const output = await sharp(sourceBuffer, { limitInputPixels: false })
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    await writeS3Object(s3, bucket, keys[name], output);
  }

  const squareSteps: Array<[keyof typeof keys, number]> = [
    ['square256', 256],
    ['square512', 512],
    ['square1024', 1024]
  ];

  for (const [name, size] of squareSteps) {
    const output = await sharp(sourceBuffer, { limitInputPixels: false })
      .extract({ left: crop.x, top: crop.y, width: crop.size, height: crop.size })
      .resize(size, size)
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    await writeS3Object(s3, bucket, keys[name], output);
  }

  return {
    keys,
    squareCrop: crop,
    sourceWidth: width,
    sourceHeight: height,
    aspectRatio: Number((width / height).toFixed(5))
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
  const { s3, bucket, sourceKey, targetPrefix, crops } = params;
  const sourceBuffer = await readS3Object(s3, bucket, sourceKey);
  const { width, height } = await readSourceMetadata(sourceBuffer, bucket, sourceKey);
  const focalPoint = {
    x: clamp(params.focalPoint?.x ?? 0.5, 0, 1),
    y: clamp(params.focalPoint?.y ?? 0.5, 0, 1)
  };

  const renditionKeys = {
    desktop: `${targetPrefix}/renditions/desktop.jpg`,
    tablet: `${targetPrefix}/renditions/tablet.jpg`,
    mobile: `${targetPrefix}/renditions/mobile.jpg`
  };
  const outputSizes = {
    desktop: { width: 2400, height: 900 },
    tablet: { width: 1600, height: 700 },
    mobile: { width: 900, height: 1200 }
  };
  const generatedCrops = {
    desktop: pickCoverCrop(width, height, outputSizes.desktop.width, outputSizes.desktop.height, focalPoint, crops?.desktop),
    tablet: pickCoverCrop(width, height, outputSizes.tablet.width, outputSizes.tablet.height, focalPoint, crops?.tablet),
    mobile: pickCoverCrop(width, height, outputSizes.mobile.width, outputSizes.mobile.height, focalPoint, crops?.mobile)
  };

  for (const name of Object.keys(renditionKeys) as Array<keyof typeof renditionKeys>) {
    const crop = generatedCrops[name];
    const size = outputSizes[name];
    const output = await sharp(sourceBuffer, { limitInputPixels: false })
      .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
      .resize(size.width, size.height)
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    await writeS3Object(s3, bucket, renditionKeys[name], output);
  }

  return {
    sourceKey,
    renditionKeys,
    crops: generatedCrops,
    focalPoint,
    sourceWidth: width,
    sourceHeight: height
  };
};
