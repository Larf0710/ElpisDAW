import { describe, expect, it } from 'vitest';

import {
  StableAudio3GenerationAcceptanceError,
  assessStableAudio3GenerationAcceptance,
  validateStableAudio3GenerationAcceptanceRecord,
} from './stableAudio3GenerationAcceptance.mjs';
import {
  STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_MODEL_REPOSITORY,
  STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
} from './stableAudio3RuntimeProfile.mjs';

describe('Stable Audio 3 generation acceptance evidence', () => {
  it('accepts exact completed target evidence for review without promoting a Runtime', () => {
    const assessment = assessStableAudio3GenerationAcceptance(createEvidence());

    expect(assessment).toMatchObject({
      blockers: [],
      runtimeAssessment: { status: 'READY_FOR_MODEL_PROBE' },
      status: 'ACCEPTED_FOR_REVIEW',
      supportsCancellation: false,
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.blockers)).toBe(true);
    expect(Object.isFrozen(assessment.evidence)).toBe(true);
    expect(Object.isFrozen(assessment.evidence.model.files)).toBe(true);
    expect(
      Object.isFrozen(assessment.evidence.runtime.packages.torch),
    ).toBe(true);
  });

  it('records supported cancellation without changing technical acceptance', () => {
    const assessment = assessStableAudio3GenerationAcceptance(
      createEvidence({ cancellation: { outcome: 'SUPPORTED' } }),
    );

    expect(assessment.status).toBe('ACCEPTED_FOR_REVIEW');
    expect(assessment.supportsCancellation).toBe(true);
  });

  it('rejects identity drift, unpinned Models, and unsupported WAV properties', () => {
    const evidence = createEvidence();
    const assessment = assessStableAudio3GenerationAcceptance({
      ...evidence,
      generation: {
        ...evidence.generation,
        output: {
          ...evidence.generation.output,
          channels: 1,
          durationSeconds: 381,
          sampleRate: 48_000,
        },
      },
      model: {
        ...evidence.model,
        repository: 'example/other-model',
        revision: 'main',
      },
      provider: {
        codeRevision: 'f'.repeat(40),
        packageVersion: '9.9.9',
      },
      sourceProfileId: 'other-runtime-profile',
    });

    expect(assessment.status).toBe('REJECTED');
    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'RUNTIME_PROFILE_MISMATCH',
      'PROVIDER_CODE_REVISION_MISMATCH',
      'PROVIDER_PACKAGE_VERSION_MISMATCH',
      'MODEL_REPOSITORY_MISMATCH',
      'MODEL_REVISION_UNPINNED',
      'OUTPUT_CHANNELS_MISMATCH',
      'OUTPUT_SAMPLE_RATE_MISMATCH',
      'OUTPUT_DURATION_UNSUPPORTED',
    ]);
  });

  it('rejects a different pinned Model or Flash Attention version', () => {
    const evidence = createEvidence();
    const assessment = assessStableAudio3GenerationAcceptance({
      ...evidence,
      model: {
        ...evidence.model,
        revision: 'f'.repeat(40),
      },
      runtime: {
        ...evidence.runtime,
        packages: {
          ...evidence.runtime.packages,
          flashAttention: createPackage('2.7.4'),
        },
      },
    });

    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'MODEL_REVISION_MISMATCH',
      'FLASH_ATTENTION_VERSION_MISMATCH',
    ]);
    expect(assessment.status).toBe('REJECTED');
  });

  it('retains exact dependency blockers when the Runtime is not ready', () => {
    const evidence = createEvidence();
    const assessment = assessStableAudio3GenerationAcceptance({
      ...evidence,
      runtime: {
        ...evidence.runtime,
        packages: {
          ...evidence.runtime.packages,
          flashAttention: createMissingPackage(),
        },
      },
    });

    expect(assessment).toMatchObject({
      blockers: [
        {
          code: 'RUNTIME_NOT_READY',
        },
      ],
      runtimeAssessment: {
        status: 'UNVERIFIED',
      },
      status: 'REJECTED',
    });
    expect(
      assessment.runtimeAssessment.blockers.map(({ code }) => code),
    ).toEqual(['FLASH_ATTENTION_MISSING']);
  });

  it('rejects malformed and incomplete evidence instead of normalizing it', () => {
    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...createEvidence(),
        unexpected: true,
      }),
    ).toThrowError(StableAudio3GenerationAcceptanceError);

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...createEvidence(),
        generation: {
          ...createEvidence().generation,
          status: 'FAILED',
        },
      }),
    ).toThrow('requires one completed probe');

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...createEvidence(),
        cancellation: { outcome: 'NOT_TESTED' },
      }),
    ).toThrow('cancellation outcome is invalid');
  });

  it('rejects unsafe, duplicate, or unsorted model file evidence', () => {
    const evidence = createEvidence();

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...evidence,
        model: {
          ...evidence.model,
          files: [createModelFile('../model.safetensors', 'a')],
        },
      }),
    ).toThrow('file path is unsafe');

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...evidence,
        model: {
          ...evidence.model,
          files: [
            createModelFile('model.safetensors', 'a'),
            createModelFile('model.safetensors', 'b'),
          ],
        },
      }),
    ).toThrow('must be unique and sorted');

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...evidence,
        model: {
          ...evidence.model,
          files: [
            createModelFile('z-model.safetensors', 'a'),
            createModelFile('a-config.json', 'b'),
          ],
        },
      }),
    ).toThrow('must be unique and sorted');
  });

  it('rejects unverifiable hashes and impossible measurement values', () => {
    const evidence = createEvidence();

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...evidence,
        generation: {
          ...evidence.generation,
          inputSha256: 'NOT-A-HASH',
        },
      }),
    ).toThrow('lowercase SHA-256');

    expect(() =>
      validateStableAudio3GenerationAcceptanceRecord({
        ...evidence,
        generation: {
          ...evidence.generation,
          elapsedMilliseconds: 0,
        },
      }),
    ).toThrow('elapsed time is invalid');
  });
});

function createEvidence(overrides = {}) {
  return {
    acceptanceVersion: '1',
    cancellation: { outcome: 'UNSUPPORTED' },
    generation: {
      elapsedMilliseconds: 42_000,
      inputSha256: 'c'.repeat(64),
      output: {
        channels: 2,
        container: 'RIFF/WAVE',
        durationSeconds: 8,
        sampleRate: 44_100,
        sha256: 'd'.repeat(64),
        sizeBytes: 2_822_444,
      },
      peakGpuMemoryMiB: 10_240,
      status: 'COMPLETED',
    },
    model: {
      files: [createModelFile('model.safetensors', 'b')],
      repository: STABLE_AUDIO_3_MODEL_REPOSITORY,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
    },
    provider: {
      codeRevision: STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
      packageVersion: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
    },
    runtime: createReadyRuntimeReport(),
    sourceProfileId: STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
    ...overrides,
  };
}

function createModelFile(path, hashCharacter) {
  return {
    path,
    sha256: hashCharacter.repeat(64),
    sizeBytes: 4_096,
  };
}

function createReadyRuntimeReport() {
  return {
    architecture: 'AMD64',
    cuda: {
      available: true,
      buildVersion: '12.6',
      deviceName: 'NVIDIA GeForce RTX 4060 Ti',
      probeErrorType: null,
      totalMemoryMiB: 16_380,
    },
    packages: {
      flashAttention: createPackage('2.8.3'),
      stableAudio3: createPackage('0.1.0'),
      torch: createPackage('2.7.1+cu126'),
      torchaudio: createPackage('2.7.1+cu126'),
    },
    platform: 'win32',
    probeVersion: '1',
    python: {
      implementation: 'CPython',
      version: '3.10.6',
    },
  };
}

function createPackage(version) {
  return {
    available: true,
    importable: true,
    importErrorType: null,
    version,
  };
}

function createMissingPackage() {
  return {
    available: false,
    importable: false,
    importErrorType: 'ModuleNotFoundError',
    version: null,
  };
}
