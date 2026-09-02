import { AUDIO_DURATION_EPSILON_SECONDS } from './audioClipTiming';
import type { AudioClipTiming, Clip, ClipSourceFile } from './types';

export type SourceBackedAudioClip = Clip & {
  audioTiming: AudioClipTiming;
  sourceFile: ClipSourceFile & { durationSeconds: number };
};

export function isSourceBackedAudioClip(clip: Clip): clip is SourceBackedAudioClip {
  const audioTiming = clip.audioTiming;
  const sourceDurationSeconds = clip.sourceFile?.durationSeconds;

  return Boolean(
    audioTiming?.timeBase === 'absolute-seconds' &&
      isFiniteNonNegativeNumber(audioTiming.sourceStartSeconds) &&
      isFinitePositiveNumber(audioTiming.sourceEndSeconds) &&
      audioTiming.sourceEndSeconds > audioTiming.sourceStartSeconds &&
      isFinitePositiveNumber(sourceDurationSeconds) &&
      audioTiming.sourceEndSeconds <= sourceDurationSeconds + AUDIO_DURATION_EPSILON_SECONDS,
  );
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
