import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyAiModelLibraryRuntimeBinding } from './aiModelLibraryRuntimeBinding.mjs';
import { resolveAceStepModelRootFromEnvironment } from './providers/aceStepModelSnapshotProbe.mjs';
import { resolveAceStepCheckpointsRootPath } from './providers/aceStepPythonHostClient.mjs';
import { resolveStableAudio3ModelRootPath } from './providers/stableAudio3PythonHostClient.mjs';

describe('AI Model Library runtime binding', () => {
  it('maps managed revision directories onto the existing Provider environment contract', () => {
    const environment = {};
    const aceStep = 'D:\\Portable\\ElpisDAW-Data\\Models\\ace-step\\support-revision';
    const stableAudio3 =
      'D:\\Portable\\ElpisDAW-Data\\Models\\stable-audio-3\\model-revision';

    expect(
      applyAiModelLibraryRuntimeBinding(
        {
          aiModelLibrary: {
            directories: { aceStep, loras: 'D:\\Portable\\LoRAs', stableAudio3 },
            status: 'READY',
          },
        },
        environment,
      ),
    ).toBe(true);
    expect(environment).toEqual({
      HUMSTUDIO_ACE_STEP_CHECKPOINTS_ROOT: aceStep,
      HUMSTUDIO_ACE_STEP_MODEL_ROOT: join(aceStep, 'acestep-v15-base'),
      HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT: stableAudio3,
    });
    expect(resolveAceStepCheckpointsRootPath(environment)).toBe(aceStep);
    expect(resolveAceStepModelRootFromEnvironment(environment)).toBe(
      join(aceStep, 'acestep-v15-base'),
    );
    expect(resolveStableAudio3ModelRootPath(environment)).toBe(stableAudio3);
  });

  it('leaves existing development Provider paths unchanged while storage is unset', () => {
    const environment = {
      HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT: 'E:\\ExistingModels\\stable-audio-3',
    };

    expect(
      applyAiModelLibraryRuntimeBinding(
        { aiModelLibrary: { status: 'UNSET' } },
        environment,
      ),
    ).toBe(false);
    expect(environment.HUMSTUDIO_STABLE_AUDIO_3_MODEL_ROOT).toBe(
      'E:\\ExistingModels\\stable-audio-3',
    );
  });
});
