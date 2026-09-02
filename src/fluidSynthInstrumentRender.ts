import { resolveActiveMidiTake } from './activeMidiTake';
import {
  createInstrumentRenderJobRequest,
  type InstrumentRenderJobRequest,
} from './instrumentRenderContract';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import type { Clip, ProjectState } from './types';
import { resolveInstrumentSoundFont } from './soundFontPatchTab';

export const FLUIDSYNTH_INSTRUMENT_PROVIDER_ID = 'local-fluidsynth';
export const FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION = '2.5.7';
export const FLUIDSYNTH_INSTRUMENT_GAIN_DB = -14;
export const FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE = 48_000;

export type FluidSynthInstrumentRenderPlanResult =
  | Readonly<{
      canPlan: true;
      plan: Readonly<{
        request: InstrumentRenderJobRequest;
        sourceClipId: string;
        sourceClipName: string;
      }>;
    }>
  | Readonly<{
      canPlan: false;
      message: string;
      reason:
        | 'active-midi-unavailable'
        | 'active-midi-empty'
        | 'instrument-preset-invalid'
        | 'soundfont-connection-invalid'
        | 'soundfont-offline'
        | 'soundfont-unassigned'
        | 'source-clip-not-found'
        | 'source-not-midi';
    }>;

export function createFluidSynthInstrumentRenderPlan(
  project: ProjectState,
  sourceClipId: string,
  resources: readonly LocalEngineSoundFontResource[],
  instrumentPatchTabId?: string,
): FluidSynthInstrumentRenderPlanResult {
  const sourceClip = findUniqueClip(project, sourceClipId);

  if (!sourceClip) {
    return fail(
      'source-clip-not-found',
      `MIDI TO AUDIO source does not resolve uniquely: ${sourceClipId}.`,
    );
  }

  if (
    sourceClip.type !== 'midi-notes' &&
    sourceClip.type !== 'edited-midi'
  ) {
    return fail(
      'source-not-midi',
      `${sourceClip.name} cannot provide MIDI for MIDI TO AUDIO.`,
    );
  }

  const soundFontResolution = resolveInstrumentSoundFont(
    project.patchTabs,
    project.connections,
    instrumentPatchTabId ?? '',
    sourceClip.soundFont,
    resources,
  );

  if (!soundFontResolution.canResolve) {
    return fail(soundFontResolution.reason, soundFontResolution.message);
  }

  const activeMidiTake = resolveActiveMidiTake(project, sourceClip.id);

  if (!activeMidiTake.canResolve) {
    return fail('active-midi-unavailable', activeMidiTake.message);
  }

  if (activeMidiTake.plan.midi.notes.length === 0) {
    return fail(
      'active-midi-empty',
      'At least one MIDI note is required.',
    );
  }

  const { bank, program, resource: soundFont } =
    soundFontResolution.selection;
  const request = createInstrumentRenderJobRequest({
    gainDb: FLUIDSYNTH_INSTRUMENT_GAIN_DB,
    modelId: soundFont.resourceId,
    modelRevision: soundFont.revisionToken,
    plan: activeMidiTake.plan,
    preset: {
      bank,
      program,
    },
    providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
    providerVersion: FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
    sampleRate: FLUIDSYNTH_INSTRUMENT_SAMPLE_RATE,
    soundFont: {
      format: soundFont.format,
      library: soundFont.library,
      relativePath: soundFont.relativePath,
      resourceId: soundFont.resourceId,
      revisionToken: soundFont.revisionToken,
    },
  });

  return Object.freeze({
    canPlan: true,
    plan: Object.freeze({
      request,
      sourceClipId: sourceClip.id,
      sourceClipName: sourceClip.name,
    }),
  });
}

function findUniqueClip(
  project: ProjectState,
  clipId: string,
): Clip | undefined {
  const matches = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
  return matches.length === 1 ? matches[0] : undefined;
}

function fail(
  reason: Extract<
    FluidSynthInstrumentRenderPlanResult,
    { canPlan: false }
  >['reason'],
  message: string,
): FluidSynthInstrumentRenderPlanResult {
  return Object.freeze({
    canPlan: false,
    message,
    reason,
  });
}
