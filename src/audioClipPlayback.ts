import {
  AUDIO_DURATION_EPSILON_SECONDS,
  secondsToTimelineTickOffset,
  timelineTicksToSeconds,
} from './audioClipTiming';
import {
  isSourceBackedAudioClip,
  type SourceBackedAudioClip,
} from './audioClipSource';
import { recordProjectPlaybackDiagnostic } from './projectPlaybackDiagnostics';
import type { Track } from './types';

const AUDIO_PLAYBACK_PROGRESS_INTERVAL_MS = 80;

export type AudioClipPlaybackPlan = {
  clip: SourceBackedAudioClip;
  clipEndTick: number;
  clipStartTick: number;
  playbackEndSeconds: number;
  playbackStartSeconds: number;
  playbackStartTick: number;
  sourceId: string;
};

export type AudioClipPlaybackAvailability =
  | {
      canPlay: true;
      plan: AudioClipPlaybackPlan;
    }
  | {
      canPlay: false;
      message: string;
      reason:
        | 'clip-not-found'
        | 'not-source-backed'
        | 'source-unavailable'
        | 'source-id-missing'
        | 'invalid-position'
        | 'invalid-range';
    };

export type AudioClipPlaybackRuntimeCallbacks = {
  onComplete: (plan: AudioClipPlaybackPlan) => void;
  onError: (message: string, plan: AudioClipPlaybackPlan) => void;
  onProgress: (playheadTick: number, plan: AudioClipPlaybackPlan) => void;
};

export type AudioClipPlaybackRuntimeOptions = {
  loopEnabled?: boolean;
};

export function createAudioPlaybackContentFingerprint(
  bpm: number,
  tracks: readonly Track[],
): string {
  return JSON.stringify({ bpm, tracks });
}

type ActiveAudioClipPlayback = {
  animationFrameId?: number;
  audio: HTMLAudioElement;
  callbacks: AudioClipPlaybackRuntimeCallbacks;
  lastPlayheadUpdateAt: number;
  loopEnabled: boolean;
  objectUrl: string;
  plan: AudioClipPlaybackPlan;
  bpm: number;
};

export class AudioClipPlaybackRuntime {
  private activePlayback?: ActiveAudioClipPlayback;

  isPlaying(): boolean {
    return this.activePlayback !== undefined;
  }

  play(
    file: File,
    plan: AudioClipPlaybackPlan,
    bpm: number,
    callbacks: AudioClipPlaybackRuntimeCallbacks,
    options: AudioClipPlaybackRuntimeOptions = {},
  ): void {
    if (this.activePlayback) {
      throw new Error('Audio playback is already active.');
    }

    const objectUrl = URL.createObjectURL(file);
    let activePlayback: ActiveAudioClipPlayback | undefined;

    try {
      const audio = new Audio();
      const playbackSession: ActiveAudioClipPlayback = {
        audio,
        bpm,
        callbacks,
        lastPlayheadUpdateAt: 0,
        loopEnabled: options.loopEnabled ?? false,
        objectUrl,
        plan,
      };
      activePlayback = playbackSession;
      this.activePlayback = playbackSession;

      recordProjectPlaybackDiagnostic('legacy-audio-element-created', {
        fileName: file.name,
        fileSizeBytes: file.size,
        fileType: file.type,
        networkState: audio.networkState,
        playbackEndSeconds: plan.playbackEndSeconds,
        playbackStartSeconds: plan.playbackStartSeconds,
        readyState: audio.readyState,
      });

      audio.preload = 'auto';
      audio.onloadedmetadata = () =>
        recordLegacyAudioElementState('legacy-audio-loaded-metadata', audio);
      audio.oncanplay = () =>
        recordLegacyAudioElementState('legacy-audio-can-play', audio);
      audio.onplaying = () =>
        recordLegacyAudioElementState('legacy-audio-playing', audio);
      audio.onended = () => {
        recordLegacyAudioElementState('legacy-audio-ended', audio);
        this.handlePlaybackBoundary(playbackSession);
      };
      audio.onerror = () => {
        recordLegacyAudioElementState('legacy-audio-error', audio, {
          mediaErrorCode: audio.error?.code,
          mediaErrorMessage: audio.error?.message,
        });
        this.fail(
          playbackSession,
          `Playback failed: ${plan.clip.sourceFile.name} could not be decoded by this browser.`,
        );
      };
      audio.src = objectUrl;
      audio.currentTime = plan.playbackStartSeconds;

      void audio
        .play()
        .then(() => {
          recordLegacyAudioElementState('legacy-audio-play-resolved', audio);
          this.startProgressLoop(playbackSession);
        })
        .catch((error: unknown) => {
          recordLegacyAudioElementState('legacy-audio-play-rejected', audio, {
            errorMessage: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
          });
          this.fail(
            playbackSession,
            `Playback blocked: ${plan.clip.sourceFile.name} could not start. Check browser audio permission and try again.`,
          );
        });
    } catch (error) {
      recordProjectPlaybackDiagnostic('legacy-audio-synchronous-error', {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
        fileName: file.name,
        playbackStartSeconds: plan.playbackStartSeconds,
      });
      if (activePlayback) {
        this.release(activePlayback);
      } else {
        URL.revokeObjectURL(objectUrl);
      }
      throw error;
    }
  }

  stop(): AudioClipPlaybackPlan | undefined {
    const activePlayback = this.activePlayback;

    if (!activePlayback) {
      return undefined;
    }

    recordLegacyAudioElementState(
      'legacy-audio-stop-requested',
      activePlayback.audio,
      { clipId: activePlayback.plan.clip.id },
    );
    this.release(activePlayback);
    return activePlayback.plan;
  }

  setLoopEnabled(loopEnabled: boolean): void {
    if (this.activePlayback) {
      this.activePlayback.loopEnabled = loopEnabled;
    }
  }

  private startProgressLoop(activePlayback: ActiveAudioClipPlayback): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    const updatePlaybackProgress = (timestamp: number) => {
      if (this.activePlayback !== activePlayback) {
        return;
      }

      if (
        activePlayback.audio.ended ||
        activePlayback.audio.currentTime >=
          activePlayback.plan.playbackEndSeconds - AUDIO_DURATION_EPSILON_SECONDS
      ) {
        if (!this.handlePlaybackBoundary(activePlayback)) {
          return;
        }
      }

      if (timestamp - activePlayback.lastPlayheadUpdateAt >= AUDIO_PLAYBACK_PROGRESS_INTERVAL_MS) {
        activePlayback.lastPlayheadUpdateAt = timestamp;
        activePlayback.callbacks.onProgress(
          getAudioClipPlaybackTick(activePlayback.plan, activePlayback.audio.currentTime, activePlayback.bpm),
          activePlayback.plan,
        );
      }

      activePlayback.animationFrameId = window.requestAnimationFrame(updatePlaybackProgress);
    };

    activePlayback.animationFrameId = window.requestAnimationFrame(updatePlaybackProgress);
  }

  private handlePlaybackBoundary(activePlayback: ActiveAudioClipPlayback): boolean {
    if (this.activePlayback !== activePlayback) {
      return false;
    }

    if (!activePlayback.loopEnabled) {
      this.complete(activePlayback);
      return false;
    }

    activePlayback.audio.currentTime = activePlayback.plan.clip.audioTiming.sourceStartSeconds;
    activePlayback.lastPlayheadUpdateAt = 0;
    activePlayback.callbacks.onProgress(activePlayback.plan.clipStartTick, activePlayback.plan);

    if (activePlayback.audio.paused) {
      void activePlayback.audio.play().catch(() =>
        this.fail(
          activePlayback,
          `Playback blocked: ${activePlayback.plan.clip.sourceFile.name} could not restart its loop.`,
        ),
      );
    }

    return true;
  }

  private complete(activePlayback: ActiveAudioClipPlayback): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    recordLegacyAudioElementState('legacy-audio-complete', activePlayback.audio, {
      clipId: activePlayback.plan.clip.id,
    });
    this.release(activePlayback);
    activePlayback.callbacks.onComplete(activePlayback.plan);
  }

  private fail(activePlayback: ActiveAudioClipPlayback, message: string): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    recordLegacyAudioElementState('legacy-audio-failed', activePlayback.audio, {
      clipId: activePlayback.plan.clip.id,
      message,
    });
    this.release(activePlayback);
    activePlayback.callbacks.onError(message, activePlayback.plan);
  }

  private release(activePlayback: ActiveAudioClipPlayback): void {
    if (this.activePlayback !== activePlayback) {
      return;
    }

    this.activePlayback = undefined;

    if (activePlayback.animationFrameId !== undefined) {
      window.cancelAnimationFrame(activePlayback.animationFrameId);
    }

    activePlayback.audio.onended = null;
    activePlayback.audio.onerror = null;
    activePlayback.audio.oncanplay = null;
    activePlayback.audio.onloadedmetadata = null;
    activePlayback.audio.onplaying = null;
    activePlayback.audio.pause();
    activePlayback.audio.removeAttribute('src');
    activePlayback.audio.load();
    URL.revokeObjectURL(activePlayback.objectUrl);
  }
}

function recordLegacyAudioElementState(
  stage: string,
  audio: HTMLAudioElement,
  details: Readonly<Record<string, unknown>> = {},
): void {
  recordProjectPlaybackDiagnostic(stage, {
    currentTime: audio.currentTime,
    duration: audio.duration,
    ended: audio.ended,
    muted: audio.muted,
    networkState: audio.networkState,
    paused: audio.paused,
    readyState: audio.readyState,
    volume: audio.volume,
    ...details,
  });
}

export function createAudioClipPlaybackPlan(
  tracks: Track[],
  clipId: string,
  playheadTick: number,
  bpm: number,
): AudioClipPlaybackAvailability {
  const clip = tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === clipId);

  if (!clip) {
    return {
      canPlay: false,
      message: 'Playback blocked: select one imported or relinked audio clip.',
      reason: 'clip-not-found',
    };
  }

  if (!isSourceBackedAudioClip(clip)) {
    return {
      canPlay: false,
      message: `Playback blocked: ${clip.name} does not have reliable source timing.`,
      reason: 'not-source-backed',
    };
  }

  if (clip.sourceFile.status !== 'available') {
    return {
      canPlay: false,
      message: `Playback blocked: ${clip.sourceFile.name} needs relink for this session.`,
      reason: 'source-unavailable',
    };
  }

  const sourceId = clip.sourceFile.sourceId?.trim();

  if (!sourceId) {
    return {
      canPlay: false,
      message: `Playback blocked: ${clip.name} does not have a source identity.`,
      reason: 'source-id-missing',
    };
  }

  if (!Number.isFinite(playheadTick) || !isFinitePositiveNumber(bpm)) {
    return {
      canPlay: false,
      message: `Playback blocked: ${clip.name} received an invalid Timeline position.`,
      reason: 'invalid-position',
    };
  }

  const clipStartTick = Math.round(clip.startTick);
  const clipEndTick = clipStartTick + Math.round(clip.lengthTicks);

  if (clipStartTick < 0 || clipEndTick <= clipStartTick) {
    return {
      canPlay: false,
      message: `Playback blocked: ${clip.name} has an invalid Timeline range.`,
      reason: 'invalid-range',
    };
  }

  const normalizedPlayheadTick = Math.round(playheadTick);
  const isPlayheadInsideClip =
    normalizedPlayheadTick >= clipStartTick && normalizedPlayheadTick < clipEndTick;
  const requestedStartTick = isPlayheadInsideClip ? normalizedPlayheadTick : clipStartTick;
  const requestedStartSeconds =
    clip.audioTiming.sourceStartSeconds +
    timelineTicksToSeconds(requestedStartTick - clipStartTick, bpm);
  const shouldRestartFromClipStart =
    requestedStartSeconds >= clip.audioTiming.sourceEndSeconds - AUDIO_DURATION_EPSILON_SECONDS;
  const playbackStartTick = shouldRestartFromClipStart ? clipStartTick : requestedStartTick;
  const playbackStartSeconds = shouldRestartFromClipStart
    ? clip.audioTiming.sourceStartSeconds
    : Math.max(clip.audioTiming.sourceStartSeconds, requestedStartSeconds);

  if (
    playbackStartSeconds < 0 ||
    playbackStartSeconds >= clip.audioTiming.sourceEndSeconds - AUDIO_DURATION_EPSILON_SECONDS
  ) {
    return {
      canPlay: false,
      message: `Playback blocked: ${clip.name} has no playable source range.`,
      reason: 'invalid-range',
    };
  }

  return {
    canPlay: true,
    plan: {
      clip,
      clipEndTick,
      clipStartTick,
      playbackEndSeconds: clip.audioTiming.sourceEndSeconds,
      playbackStartSeconds,
      playbackStartTick,
      sourceId,
    },
  };
}

export function getAudioClipPlaybackTick(
  plan: AudioClipPlaybackPlan,
  sourcePositionSeconds: number,
  bpm: number,
): number {
  if (!Number.isFinite(sourcePositionSeconds) || !isFinitePositiveNumber(bpm)) {
    return plan.playbackStartTick;
  }

  const clampedSourcePosition = Math.min(
    plan.playbackEndSeconds,
    Math.max(plan.clip.audioTiming.sourceStartSeconds, sourcePositionSeconds),
  );
  const sourceOffsetSeconds = clampedSourcePosition - plan.clip.audioTiming.sourceStartSeconds;
  const timelineTick = plan.clipStartTick + secondsToTimelineTickOffset(sourceOffsetSeconds, bpm);

  return Math.min(plan.clipEndTick, Math.max(plan.clipStartTick, timelineTick));
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
