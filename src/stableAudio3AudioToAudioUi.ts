import type { AutoPatchProductionUiState } from './autoPatchProductionUiState';
import { isAutoPatchProductionUiActive } from './autoPatchProductionUiState';
import type { ClipType } from './types';

export type StableAudio3AudioToAudioUiPresentation = Readonly<{
  buttonLabel: 'RUN A2A';
  canRun: boolean;
  detail: string;
  eyebrow: 'Stable Audio 3 A2A';
  title: 'Create SA3 Master' | 'Transform Selected Audio';
}>;

export function createStableAudio3AudioToAudioUiPresentation(input: Readonly<{
  autoPatchState: AutoPatchProductionUiState;
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  source?: Readonly<{ name: string; type: ClipType }>;
}>): StableAudio3AudioToAudioUiPresentation {
  const sourceIsRawMix = input.source?.type === 'mixdown';
  const sourceIsSupported =
    sourceIsRawMix || input.source?.type === 'instrument-audio';
  const isActive = isAutoPatchProductionUiActive(input.autoPatchState);
  const canRun = Boolean(
    sourceIsSupported &&
      input.engineAcceptsNewJobs &&
      input.isProjectRootReady &&
      !isActive,
  );
  const detail = isActive
    ? input.autoPatchState.message
    : !sourceIsSupported
      ? 'SELECT RAW MIX OR INSTRUMENT AUDIO'
      : !input.isProjectRootReady
        ? 'SELECT PROJECT ROOT'
        : !input.engineAcceptsNewJobs
          ? input.engineAvailabilityMessage
          : sourceIsRawMix
            ? `${input.source?.name ?? 'RAW MIX'} / NEW MUTED MASTER TRACK`
            : input.source?.name ?? 'SELECT INSTRUMENT AUDIO';

  return Object.freeze({
    buttonLabel: 'RUN A2A' as const,
    canRun,
    detail,
    eyebrow: 'Stable Audio 3 A2A' as const,
    title: sourceIsRawMix
      ? 'Create SA3 Master' as const
      : 'Transform Selected Audio' as const,
  });
}
