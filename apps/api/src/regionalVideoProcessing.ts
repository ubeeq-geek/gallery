import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deterministicVideoFramePlan } from './regionalMedia';

const execFileAsync = promisify(execFile);

export interface VideoValidationProfile {
  profile: string;
  maxDurationSeconds: number;
  maxWidth: number;
  maxHeight: number;
  allowedContainers: string[];
  allowedVideoCodecs: string[];
  frameIntervalSeconds: number;
}

export const DEFAULT_VIDEO_VALIDATION_PROFILE: VideoValidationProfile = Object.freeze({
  // Kept within the bounded 14-minute serverless worker envelope. Longer
  // inputs require a separately versioned distributed extraction profile.
  profile: 'FFPROBE_VIDEO_V1', maxDurationSeconds: 900, maxWidth: 7680, maxHeight: 4320,
  allowedContainers: ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm'],
  allowedVideoCodecs: ['h264', 'hevc', 'vp8', 'vp9', 'av1'], frameIntervalSeconds: 3
});

export interface ValidatedVideoMetadata {
  validationProfile: string;
  durationSeconds: number;
  container: string;
  videoCodec: string;
  width: number;
  height: number;
  bitrate?: number;
  rotation: number;
  hasAudio: boolean;
  audioCodec?: string;
  frameTimestampsMs: number[];
}

type FfprobeJson = { format?: { duration?: string; format_name?: string; bit_rate?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: Array<{ rotation?: number }> }> };

export const validateFfprobeOutput = (probe: FfprobeJson, profile: VideoValidationProfile = DEFAULT_VIDEO_VALIDATION_PROFILE): ValidatedVideoMetadata => {
  const video = probe.streams?.find(({ codec_type }) => codec_type === 'video');
  const audio = probe.streams?.find(({ codec_type }) => codec_type === 'audio');
  const durationSeconds = Number(probe.format?.duration);
  const container = probe.format?.format_name || '';
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Malformed video or missing decodable video stream');
  if (durationSeconds > profile.maxDurationSeconds) throw new Error('Video duration exceeds the active validation profile');
  if (!profile.allowedContainers.includes(container)) throw new Error(`Unsupported video container: ${container || 'unknown'}`);
  if (!video.codec_name || !profile.allowedVideoCodecs.includes(video.codec_name)) throw new Error(`Unsupported video codec: ${video.codec_name || 'unknown'}`);
  if (!video.width || !video.height || video.width > profile.maxWidth || video.height > profile.maxHeight) throw new Error('Video dimensions exceed the active validation profile');
  const rotation = Number(video.side_data_list?.find(({ rotation }) => typeof rotation === 'number')?.rotation ?? video.tags?.rotate ?? 0);
  return {
    validationProfile: profile.profile, durationSeconds, container, videoCodec: video.codec_name, width: video.width, height: video.height,
    bitrate: probe.format?.bit_rate ? Number(probe.format.bit_rate) : undefined, rotation: Number.isFinite(rotation) ? rotation : 0,
    hasAudio: Boolean(audio), audioCodec: audio?.codec_name,
    frameTimestampsMs: deterministicVideoFramePlan(durationSeconds, profile.frameIntervalSeconds)
  };
};

export interface VideoToolAdapter {
  probe(inputPath: string): Promise<FfprobeJson>;
  extractFrame(inputPath: string, outputPath: string, timestampMs: number): Promise<void>;
}

export class FfmpegVideoToolAdapter implements VideoToolAdapter {
  constructor(private readonly ffprobePath = process.env.FFPROBE_PATH || '/opt/bin/ffprobe', private readonly ffmpegPath = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg') {}
  async probe(inputPath: string): Promise<FfprobeJson> {
    const { stdout } = await execFileAsync(this.ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', inputPath], { maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout) as FfprobeJson;
  }
  async extractFrame(inputPath: string, outputPath: string, timestampMs: number): Promise<void> {
    await execFileAsync(this.ffmpegPath, ['-nostdin', '-v', 'error', '-ss', (timestampMs / 1000).toFixed(3), '-i', inputPath, '-frames:v', '1', '-map_metadata', '-1', '-vf', 'scale=min(1920\\,iw):-2', '-q:v', '3', '-y', outputPath], { maxBuffer: 4 * 1024 * 1024 });
  }
}

export const extractValidatedFrames = async (input: { inputPath: string; outputPath(timestampMs: number): string; tools: VideoToolAdapter; profile?: VideoValidationProfile }): Promise<ValidatedVideoMetadata> => {
  const metadata = validateFfprobeOutput(await input.tools.probe(input.inputPath), input.profile);
  for (const timestampMs of metadata.frameTimestampsMs) await input.tools.extractFrame(input.inputPath, input.outputPath(timestampMs), timestampMs);
  return metadata;
};
