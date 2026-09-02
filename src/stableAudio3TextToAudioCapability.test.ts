import { describe, expect, it } from 'vitest';

import { AUDIO_GENERATION_REGION_TICKS_PER_BAR } from './audioGenerationRegion';
import {
  CURRENT_STABLE_AUDIO_3_TEXT_TO_AUDIO_RUNTIME_CAPABILITY,
  resolveStableAudio3TextToAudioCapability,
  type StableAudio3TextToAudioCapabilityInput,
  type StableAudio3TextToAudioRuntimeCapability,
} from './stableAudio3TextToAudioCapability';
import type { ProjectState, Track } from './types';

const MODEL_REVISION = '27b5a21b791b1b033d193a9e1e3ce78493f102f9';
const RUNTIME_PROFILE =
  'windows-x64-cpython-3-10-pytorch-2-7-1-cu126-flash-attention-2-8-3';

describe('Stable Audio 3 text-to-audio capability gate', () => {
  it('pins the reviewed source-free Runtime capability identity', () => {
    expect(CURRENT_STABLE_AUDIO_3_TEXT_TO_AUDIO_RUNTIME_CAPABILITY).toEqual(
      createCapability(),
    );
    expect(
      Object.isFrozen(CURRENT_STABLE_AUDIO_3_TEXT_TO_AUDIO_RUNTIME_CAPABILITY),
    ).toBe(true);
  });
  it('creates an enqueue-ready source-free Job from the captured Playhead plan', () => {
    const result = resolveStableAudio3TextToAudioCapability(
      createProject({
        playheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
      }),
      createInput(),
      createCapability(),
    );

    expect(result).toMatchObject({
      canEnqueue: true,
      plan: {
        kind: 'local-engine-gpu-job',
        output: {
          generationPosition: {
            capturedPlayheadTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
            choice: 'playhead',
            resolvedStartTick: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 2,
          },
          generationRegion: {
            durationSeconds: 16,
            outputTarget: {
              kind: 'new-track',
              trackId: 'sa3-t2a-track-1',
              trackType: 'generated_audio',
            },
          },
          materialization: { kind: 'after-generation-success' },
        },
        request: {
          inputArtifacts: [],
          lineage: {
            parentArtifactIds: [],
            parentClipTakeIds: [],
          },
          parameters: {
            durationSeconds: 16,
            prompt: 'Warm analog synths with a patient cinematic build',
            seed: 17,
          },
          taskId: 'text-to-audio',
        },
        runtime: {
          modelCompatibility: 'PARTIAL_SUPPORT',
          profileId: RUNTIME_PROFILE,
          providerVersion: '0.1.0',
          supportsCancellation: true,
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);

    if (result.canEnqueue) {
      expect(Object.isFrozen(result.plan)).toBe(true);
      expect(Object.isFrozen(result.plan.runtime)).toBe(true);
    }
  });

  it('derives Duration from Bars and captured Tempo for Timeline Start', () => {
    const result = resolveStableAudio3TextToAudioCapability(
      createProject({ bpm: 90, playheadTick: 12_000 }),
      createInput({
        output: {
          ...createInput().output,
          bars: 4,
          generationPosition: 'timeline-start',
        },
      }),
      createCapability(),
    );

    expect(result).toMatchObject({
      canEnqueue: true,
      plan: {
        output: {
          generationPosition: {
            capturedPlayheadTick: 12_000,
            choice: 'timeline-start',
            resolvedStartTick: 0,
          },
        },
        request: {
          parameters: { durationSeconds: 32 / 3 },
        },
      },
    });
  });

  it('rejects A2A identity instead of silently routing it as T2A', () => {
    expect(
      resolveStableAudio3TextToAudioCapability(
        createProject(),
        {
          ...createInput(),
          execution: {
            ...createInput().execution,
            taskId: 'audio-to-audio',
          },
        },
        createCapability(),
      ),
    ).toMatchObject({
      canEnqueue: false,
      cause: 'stable-audio-3-t2a-execution-invalid',
      reason: 'execution-invalid',
    });
    expect(
      resolveStableAudio3TextToAudioCapability(
        createProject(),
        createInput(),
        {
          ...createCapability(),
          taskId: 'audio-to-audio',
        },
      ),
    ).toMatchObject({
      canEnqueue: false,
      cause: 'stable-audio-3-t2a-capability-mismatch',
      reason: 'profile-invalid',
    });
  });

  it('blocks unverified Runtime and incompatible Model capability', () => {
    expect(
      resolveStableAudio3TextToAudioCapability(
        createProject(),
        createInput(),
        createCapability({ runtimeCompatibility: 'UNVERIFIED' }),
      ),
    ).toMatchObject({
      canEnqueue: false,
      cause: 'stable-audio-3-t2a-runtime-unverified',
      reason: 'runtime-unverified',
    });
    expect(
      resolveStableAudio3TextToAudioCapability(
        createProject(),
        createInput(),
        createCapability({ modelCompatibility: 'INCOMPATIBLE' }),
      ),
    ).toMatchObject({
      canEnqueue: false,
      cause: 'stable-audio-3-t2a-model-incompatible',
      reason: 'model-incompatible',
    });
  });

  it('blocks Bars that exceed the Provider duration at the captured Tempo', () => {
    expect(
      resolveStableAudio3TextToAudioCapability(
        createProject({ bpm: 4 }),
        createInput(),
        createCapability(),
      ),
    ).toMatchObject({
      canEnqueue: false,
      cause: 'stable-audio-3-t2a-duration-unsupported',
      reason: 'duration-unsupported',
    });
  });

  it('propagates output identity conflicts before enqueue', () => {
    expect(
      resolveStableAudio3TextToAudioCapability(
        createProject({
          tracks: [createTrack({ id: 'sa3-t2a-track-1' })],
        }),
        createInput(),
        createCapability(),
      ),
    ).toMatchObject({
      canEnqueue: false,
      cause: 'generation-region-new-track-id-conflict',
      reason: 'output-invalid',
    });
  });
});

function createInput(
  overrides: Partial<StableAudio3TextToAudioCapabilityInput> = {},
): StableAudio3TextToAudioCapabilityInput {
  return {
    execution: {
      modelId: 'stable-audio-3-medium',
      modelRevision: MODEL_REVISION,
      providerId: 'local-stable-audio-3',
      taskId: 'text-to-audio',
    },
    output: {
      bars: 8,
      createdAt: '2026-08-06T00:00:00.000Z',
      generationPosition: 'playhead',
      outputClipId: 'sa3-t2a-clip-1',
      outputClipName: 'SA3 T2A Clip',
      outputTrackId: 'sa3-t2a-track-1',
      outputTrackName: 'SA3 T2A',
    },
    prompt: 'Warm analog synths with a patient cinematic build',
    seed: 17,
    ...overrides,
  };
}

function createCapability(
  overrides: Readonly<{
    modelCompatibility?: StableAudio3TextToAudioRuntimeCapability['model']['compatibility'];
    runtimeCompatibility?: StableAudio3TextToAudioRuntimeCapability['runtime']['compatibility'];
  }> = {},
): StableAudio3TextToAudioRuntimeCapability {
  return {
    model: {
      compatibility: overrides.modelCompatibility ?? 'PARTIAL_SUPPORT',
      modelId: 'stable-audio-3-medium',
      revision: MODEL_REVISION,
    },
    providerId: 'local-stable-audio-3',
    providerVersion: '0.1.0',
    runtime: {
      compatibility: overrides.runtimeCompatibility ?? 'COMPATIBLE',
      profileId: RUNTIME_PROFILE,
    },
    supportsCancellation: true,
    taskId: 'text-to-audio',
  };
}

function createProject(
  overrides: Partial<ProjectState> & { tracks?: Track[] } = {},
): ProjectState {
  return {
    artifacts: [],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'SA3 T2A Capability Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: AUDIO_GENERATION_REGION_TICKS_PER_BAR * 16,
    tracks: [],
    ...overrides,
  };
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    clips: [],
    id: 'existing-track',
    level: 0,
    name: 'Existing Track',
    type: 'audio',
    ...overrides,
  };
}
