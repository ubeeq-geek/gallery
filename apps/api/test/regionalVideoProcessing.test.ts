import { extractValidatedFrames, validateFfprobeOutput, type VideoToolAdapter } from '../src/regionalVideoProcessing';

const probe = { format: { duration: '10.25', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', bit_rate: '5000000' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, side_data_list: [{ rotation: 90 }] }, { codec_type: 'audio', codec_name: 'aac' }] };

describe('regional video processing', () => {
  it('validates FFprobe metadata and creates a deterministic frame plan', () => {
    expect(validateFfprobeOutput(probe)).toMatchObject({ validationProfile: 'FFPROBE_VIDEO_V1', durationSeconds: 10.25, videoCodec: 'h264', width: 1920, height: 1080, rotation: 90, hasAudio: true, audioCodec: 'aac', frameTimestampsMs: [0, 3000, 6000, 9000, 10249] });
  });

  it.each([
    [{ ...probe, format: { ...probe.format, duration: '0' } }, 'Malformed video'],
    [{ ...probe, streams: [{ codec_type: 'video', codec_name: 'mpeg2video', width: 1920, height: 1080 }] }, 'Unsupported video codec'],
    [{ ...probe, format: { ...probe.format, format_name: 'asf' } }, 'Unsupported video container']
  ])('rejects unsupported or malformed input', (value, message) => expect(() => validateFfprobeOutput(value)).toThrow(message));

  it('extracts every planned frame before returning validated metadata', async () => {
    const extractFrame = jest.fn().mockResolvedValue(undefined);
    const tools: VideoToolAdapter = { probe: jest.fn().mockResolvedValue(probe), extractFrame };
    const metadata = await extractValidatedFrames({ inputPath: '/tmp/input', outputPath: (timestamp) => `/tmp/${timestamp}.jpg`, tools });
    expect(extractFrame).toHaveBeenCalledTimes(metadata.frameTimestampsMs.length);
    expect(extractFrame).toHaveBeenLastCalledWith('/tmp/input', '/tmp/10249.jpg', 10249);
  });
});

