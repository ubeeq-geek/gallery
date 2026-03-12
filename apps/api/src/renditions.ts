import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Jimp } from 'jimp';

export interface SquareCropInput {
  x: number;
  y: number;
  size: number;
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

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const pickSquareCrop = (width: number, height: number, requested?: SquareCropInput): SquareCropInput => {
  const maxSide = Math.min(width, height);
  if (!requested) {
    const x = Math.floor((width - maxSide) / 2);
    const y = Math.floor((height - maxSide) / 2);
    return { x, y, size: maxSide };
  }

  const requestedSize = clamp(Math.floor(requested.size), 1, maxSide);
  const x = clamp(Math.floor(requested.x), 0, width - requestedSize);
  const y = clamp(Math.floor(requested.y), 0, height - requestedSize);
  return { x, y, size: requestedSize };
};

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

const toJpegBuffer = async (image: any): Promise<Buffer> => image.getBuffer('image/jpeg');

export const generateImageRenditions = async (params: {
  s3: S3Client;
  bucket: string;
  sourceKey: string;
  targetPrefix: string;
  squareCrop?: SquareCropInput;
}): Promise<GeneratedRenditions> => {
  const { s3, bucket, sourceKey, targetPrefix, squareCrop } = params;

  const sourceBuffer = await readS3Object(s3, bucket, sourceKey);
  const sourceImage = await Jimp.read(sourceBuffer);
  const width = sourceImage.bitmap.width;
  const height = sourceImage.bitmap.height;

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
    const resized = sourceImage.clone().scaleToFit({ w: size, h: size });
    const output = await toJpegBuffer(resized);
    await writeS3Object(s3, bucket, keys[name], output);
  }

  const squareSteps: Array<[keyof typeof keys, number]> = [
    ['square256', 256],
    ['square512', 512],
    ['square1024', 1024]
  ];

  for (const [name, size] of squareSteps) {
    const squared = sourceImage.clone().crop({ x: crop.x, y: crop.y, w: crop.size, h: crop.size }).resize({ w: size, h: size });
    const output = await toJpegBuffer(squared);
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
