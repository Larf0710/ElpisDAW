import { HUMSTUDIO_AUDIO_FORMAT } from './humStudioAudioFormat.js';

export const TIMELINE_EXPORT_PLAN_VERSION = 1;
export const TIMELINE_EXPORT_TICKS_PER_QUARTER = 960;

export const TIMELINE_EXPORT_AUDIO_FORMAT = Object.freeze({
  bitsPerSample: HUMSTUDIO_AUDIO_FORMAT.bitsPerSample,
  channels: HUMSTUDIO_AUDIO_FORMAT.channels,
  mimeType: HUMSTUDIO_AUDIO_FORMAT.mimeType,
  sampleRate: HUMSTUDIO_AUDIO_FORMAT.sampleRate,
});

export const TIMELINE_EXPORT_MIDI_FORMAT = Object.freeze({
  fileFormat: 0,
  mimeType: 'audio/midi',
  trackCount: 1,
});
