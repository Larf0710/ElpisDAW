export const TIMELINE_EXPORT_PLAN_VERSION: 1;
export const TIMELINE_EXPORT_TICKS_PER_QUARTER: 960;

export const TIMELINE_EXPORT_AUDIO_FORMAT: Readonly<{
  bitsPerSample: 16;
  channels: 2;
  mimeType: 'audio/wav';
  sampleRate: 48_000;
}>;

export const TIMELINE_EXPORT_MIDI_FORMAT: Readonly<{
  fileFormat: 0;
  mimeType: 'audio/midi';
  trackCount: 1;
}>;
