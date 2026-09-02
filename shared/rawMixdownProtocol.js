export const RAW_MIXDOWN_PLAN_VERSION_V1 = 1;
export const RAW_MIXDOWN_PLAN_VERSION_V2 = 2;
export const RAW_MIXDOWN_PLAN_VERSION = 3;
export const RAW_MIXDOWN_SAMPLE_RATE = 44_100;
export const RAW_MIXDOWN_CHANNELS = 2;
export const RAW_MIXDOWN_BITS_PER_SAMPLE = 16;
export const RAW_MIXDOWN_ENCODING = 'pcm-signed-integer';
export const RAW_MIXDOWN_EXTENSION = '.wav';
export const RAW_MIXDOWN_MIME_TYPE = 'audio/wav';
export const PROJECT_MIXDOWN_RENDERER_ID = 'humstudio-pcm-mixdown';
export const PROJECT_MIXDOWN_RENDERER_VERSION_V1 = '0.1.0';
export const PROJECT_MIXDOWN_RENDERER_VERSION = '0.2.0';

export const RAW_MIXDOWN_WAVE_FORMAT = Object.freeze({
  bitsPerSample: RAW_MIXDOWN_BITS_PER_SAMPLE,
  channels: RAW_MIXDOWN_CHANNELS,
  encoding: RAW_MIXDOWN_ENCODING,
  extension: RAW_MIXDOWN_EXTENSION,
  mimeType: RAW_MIXDOWN_MIME_TYPE,
  sampleRate: RAW_MIXDOWN_SAMPLE_RATE,
});
