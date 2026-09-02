import { resolveActiveMidiTake } from './activeMidiTake';
import { isSourceBackedAudioClip } from './audioClipSource';
import {
  createFullSourceAudioClipTiming,
  secondsToTimelineTicks,
  timelineTicksToSeconds,
} from './audioClipTiming';
import {
  createInstrumentRenderJobRequest,
  INSTRUMENT_RENDER_TASK_ID,
  type InstrumentRenderSoundFontResource,
} from './instrumentRenderContract';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import {
  createCompletedAudioJobRegistration,
  type ProjectArtifactRegistrationFailureReason,
} from './projectArtifactRegistration';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

export type InstrumentRenderRegistrationOptions = Readonly<{
  activate?: boolean;
  label?: string;
  sourceAvailability?: GeneratedAudioCommitAvailabilityEvidence;
  sourceClipId: string;
  targetClipId: string;
}>;

export type InstrumentRenderRegistrationFailureReason =
  | ProjectArtifactRegistrationFailureReason
  | 'job-contract-invalid'
  | 'source-midi-unavailable'
  | 'target-not-instrument-audio'
  | 'target-timing-invalid'
  | 'target-source-mismatch';

export type InstrumentRenderRegistrationUpdate =
  | Readonly<{
      artifact: GeneratedAudioArtifact & { destination: 'instrument' };
      canRegister: true;
      clipTake: GeneratedAudioClipTake;
      project: ProjectState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason: InstrumentRenderRegistrationFailureReason;
    }>;

export function createInstrumentRenderRegistration(
  project: ProjectState,
  job: LocalEngineGpuJobRecord,
  options: InstrumentRenderRegistrationOptions,
): InstrumentRenderRegistrationUpdate {
  const source = resolveActiveMidiTake(project, options.sourceClipId);

  if (!source.canResolve) {
    return fail(
      'source-midi-unavailable',
      `Instrument Render source is unavailable: ${source.message}`,
    );
  }

  const sourceMatches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === options.sourceClipId);

  if (
    sourceMatches.length !== 1 ||
    !doesJobSoundFontMatchSourceClip(job, sourceMatches[0])
  ) {
    return fail(
      'job-contract-invalid',
      'Instrument Render SoundFont no longer matches the source MIDI Clip.',
    );
  }

  const targetMatches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === options.targetClipId);

  if (targetMatches.length !== 1) {
    return fail(
      'clip-not-found',
      `Instrument Audio Clip does not resolve uniquely: ${options.targetClipId}.`,
    );
  }

  const targetClip = targetMatches[0];

  if (targetClip.type !== 'instrument-audio') {
    return fail(
      'target-not-instrument-audio',
      `${targetClip.name} cannot receive an Instrument Render Take.`,
    );
  }

  if (targetClip.sourceClipId !== options.sourceClipId) {
    return fail(
      'target-source-mismatch',
      `${targetClip.name} does not derive from the selected MIDI Clip.`,
    );
  }

  if (job.state !== 'COMPLETED') {
    return fail(
      'job-not-completed',
      `Instrument Render registration requires a COMPLETED Job, not ${job.state}.`,
    );
  }

  const expectedRequest = createExpectedRequest(job, source.plan);

  if (
    !expectedRequest ||
    job.taskId !== INSTRUMENT_RENDER_TASK_ID ||
    !areJsonValuesEqual(job.request, expectedRequest)
  ) {
    return fail(
      'job-contract-invalid',
      'Instrument Render Job no longer matches the Active MIDI Take or render contract.',
    );
  }

  const registration = createCompletedAudioJobRegistration(project, job, {
    activate: options.activate,
    clipId: options.targetClipId,
    label: options.label,
    sourceAvailability: options.sourceAvailability,
  });

  if (!registration.canRegister) {
    return registration;
  }

  if (
    registration.artifact.destination !== 'instrument' ||
    registration.artifact.provenance.taskId !== INSTRUMENT_RENDER_TASK_ID ||
    registration.clipTake.mediaType !== 'audio' ||
    registration.clipTake.sourceType !== 'job'
  ) {
    return fail(
      'job-result-invalid',
      'Completed Instrument Render Job did not produce an Instrument Audio Take.',
    );
  }

  const instrumentArtifact = registration.artifact as GeneratedAudioArtifact & {
    destination: 'instrument';
  };
  let registeredProject = registration.project;
  const registeredTarget = registeredProject.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === targetClip.id)!;

  if (
    registration.status === 'REGISTERED' &&
    registeredTarget.activeClipTakeId === registration.clipTake.clipTakeId
  ) {
    if (targetClip.audioTiming && !isSourceBackedAudioClip(registeredTarget)) {
      return fail(
        'target-timing-invalid',
        `${targetClip.name} retained Audio timing does not fit the rendered Take.`,
      );
    }

    // Only a new, empty output receives full-source timing. Existing Takes and
    // explicit trims keep their saved placement, including idempotent retries.
    if (
      !targetClip.audioTiming &&
      !targetClip.sourceFile &&
      !targetClip.activeClipTakeId &&
      !targetClip.clipTakes?.length
    ) {
      if (
        !Number.isFinite(project.bpm) || project.bpm <= 0 ||
        !Number.isSafeInteger(project.totalTicks) || project.totalTicks <= 0 ||
        !Number.isSafeInteger(targetClip.startTick) || targetClip.startTick < 0 ||
        !Number.isSafeInteger(targetClip.lengthTicks) || targetClip.lengthTicks <= 0
      ) {
        return fail(
          'target-timing-invalid',
          'Instrument Render requires valid Project and Clip timing.',
        );
      }
      const durationSeconds = instrumentArtifact.audio.durationSeconds;
      const audioTiming = createFullSourceAudioClipTiming(durationSeconds);
      const lengthTicks = secondsToTimelineTicks(durationSeconds, project.bpm);
      const endTick = targetClip.startTick + lengthTicks;

      if (
        !Number.isSafeInteger(endTick) || endTick > project.totalTicks ||
        durationSeconds > timelineTicksToSeconds(
          project.totalTicks - targetClip.startTick,
          project.bpm,
        )
      ) {
        return fail(
          'target-timing-invalid',
          `${targetClip.name} rendered tail exceeds Timeline Length. Extend the Timeline before rendering.`,
        );
      }

      const targetTrack = project.tracks.find((track) => track.clips.includes(targetClip))!;
      const previousEndTick = targetClip.startTick + targetClip.lengthTicks;
      const newOverlap = targetTrack.clips.find((clip) =>
        clip.id !== targetClip.id &&
        clip.startTick >= previousEndTick &&
        timelineTicksToSeconds(clip.startTick - targetClip.startTick, project.bpm) < durationSeconds,
      );

      if (newOverlap) {
        return fail(
          'target-timing-invalid',
          `${targetClip.name} rendered tail would overlap ${newOverlap.name}. Make room before rendering.`,
        );
      }

      registeredProject = {
        ...registeredProject,
        tracks: registeredProject.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            clip.id === targetClip.id ? { ...clip, audioTiming, lengthTicks } : clip,
          ),
        })),
      };
    }
  }

  return {
    artifact: instrumentArtifact,
    canRegister: true,
    clipTake: registration.clipTake,
    project: registeredProject,
    status: registration.status,
  };
}

export function doesInstrumentRenderJobMatchRequest(
  job: LocalEngineGpuJobRecord,
  expectedRequest: LocalEngineGpuJobRecord['request'],
): boolean {
  return (
    job.taskId === INSTRUMENT_RENDER_TASK_ID &&
    areJsonValuesEqual(job.request, expectedRequest)
  );
}

function createExpectedRequest(
  job: LocalEngineGpuJobRecord,
  plan: Parameters<typeof createInstrumentRenderJobRequest>[0]['plan'],
) {
  const parameters = isRecord(job.request.parameters)
    ? job.request.parameters
    : undefined;
  const preset = parameters && isRecord(parameters.preset)
    ? parameters.preset
    : undefined;
  const soundFont = parameters && isRecord(parameters.soundFont)
    ? parameters.soundFont as InstrumentRenderSoundFontResource
    : undefined;

  if (!parameters || !preset) {
    return undefined;
  }

  try {
    return createInstrumentRenderJobRequest({
      gainDb: parameters.gainDb as number,
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      plan,
      preset: {
        bank: preset.bank as number,
        program: preset.program as number,
      },
      providerId: job.providerId,
      providerVersion: parameters.providerVersion as string,
      sampleRate: parameters.sampleRate as number,
      ...(soundFont ? { soundFont } : {}),
    });
  } catch {
    return undefined;
  }
}

function doesJobSoundFontMatchSourceClip(
  job: LocalEngineGpuJobRecord,
  sourceClip: ProjectState['tracks'][number]['clips'][number],
): boolean {
  const parameters = isRecord(job.request.parameters)
    ? job.request.parameters
    : undefined;
  const preset = parameters && isRecord(parameters.preset)
    ? parameters.preset
    : undefined;
  const soundFont = parameters && isRecord(parameters.soundFont)
    ? parameters.soundFont
    : undefined;
  const assignment = sourceClip.soundFont;

  // A MIDI Clip assignment is the highest-priority persisted voice. When it
  // is absent, the completed Job may legitimately contain the connected
  // SoundFont PatchTab or MIDI TO AUDIO built-in fallback selection.
  if (!assignment) {
    return true;
  }

  return Boolean(
    soundFont &&
    preset &&
    assignment.bank === preset.bank &&
    assignment.program === preset.program &&
    assignment.resource.format === soundFont.format &&
    assignment.resource.library === soundFont.library &&
    assignment.resource.relativePath === soundFont.relativePath &&
    assignment.resource.resourceId === soundFont.resourceId,
  );
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areJsonValuesEqual(value, right[index]))
    );
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        areJsonValuesEqual(left[key], right[key]),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  reason: InstrumentRenderRegistrationFailureReason,
  message: string,
): InstrumentRenderRegistrationUpdate {
  return {
    canRegister: false,
    message,
    reason,
  };
}
