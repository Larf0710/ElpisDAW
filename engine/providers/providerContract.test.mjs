import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_COMPATIBILITY_RESULTS,
  ProviderContractValidationError,
  providerDeclaresJob,
  providerSupportsJob,
  providerSupportsModelLoad,
  validateProviderDescriptor,
  validateProviderJob,
} from './providerContract.mjs';
import {
  MOCK_HUM_TO_MIDI_MODEL_ID,
  MOCK_HUM_TO_MIDI_MODEL_REVISION,
  MOCK_HUM_TO_MIDI_TASK_ID,
  MOCK_INSTRUMENT_RENDER_MODEL_ID,
  MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
  MOCK_INSTRUMENT_RENDER_TASK_ID,
  MOCK_PROVIDER_DESCRIPTOR,
  MOCK_PROVIDER_ID,
  MOCK_PROVIDER_MODEL_ID,
  MOCK_PROVIDER_MODEL_REVISION,
  MOCK_PROVIDER_TASK_ID,
} from './mockProviderDefinition.mjs';

describe('Provider Contract', () => {
  it('keeps Provider, Model, Capability, and Task identities explicit and immutable', () => {
    const job = validateProviderJob(createMockJob());

    expect(MOCK_PROVIDER_DESCRIPTOR).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          outputArtifactKind: 'audio',
          supportsCancellation: false,
          taskId: MOCK_PROVIDER_TASK_ID,
        }),
        expect.objectContaining({
          inputArtifactKinds: ['audio'],
          outputArtifactKind: 'midi',
          supportsCancellation: false,
          taskId: MOCK_HUM_TO_MIDI_TASK_ID,
        }),
        expect.objectContaining({
          inputArtifactKinds: ['midi'],
          outputArtifactKind: 'audio',
          supportsCancellation: false,
          taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
        }),
      ]),
      models: expect.arrayContaining([
        expect.objectContaining({
          compatibility: 'COMPATIBLE',
          modelId: MOCK_PROVIDER_MODEL_ID,
          revision: MOCK_PROVIDER_MODEL_REVISION,
        }),
        expect.objectContaining({
          compatibility: 'COMPATIBLE',
          modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
          revision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
        }),
        expect.objectContaining({
          compatibility: 'COMPATIBLE',
          modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
          revision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
        }),
      ]),
      providerId: MOCK_PROVIDER_ID,
    });
    expect(providerSupportsJob(MOCK_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(Object.isFrozen(MOCK_PROVIDER_DESCRIPTOR)).toBe(true);
    expect(Object.isFrozen(MOCK_PROVIDER_DESCRIPTOR.capabilities)).toBe(true);
    expect(Object.isFrozen(job.parameters)).toBe(true);
  });

  it('separates a declared Job from an executable Runtime', () => {
    const job = validateProviderJob(createMockJob());
    const provider = validateProviderDescriptor({
      ...MOCK_PROVIDER_DESCRIPTOR,
      runtime: {
        ...MOCK_PROVIDER_DESCRIPTOR.runtime,
        compatibility: 'UNVERIFIED',
      },
    });

    expect(PROVIDER_COMPATIBILITY_RESULTS).toContain('UNVERIFIED');
    expect(providerDeclaresJob(provider, job)).toBe(true);
    expect(
      providerSupportsModelLoad(
        provider,
        MOCK_PROVIDER_MODEL_ID,
        MOCK_PROVIDER_MODEL_REVISION,
      ),
    ).toBe(false);
    expect(providerSupportsJob(provider, job)).toBe(false);
  });

  it('supports explicit inline MIDI output without a staging file', () => {
    const job = validateProviderJob(createHumToMidiJob());

    expect(job.output).toEqual({ kind: 'midi' });
    expect(providerSupportsJob(MOCK_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(() =>
      validateProviderJob({
        ...createHumToMidiJob(),
        output: {
          kind: 'midi',
          stagingPath: join(tmpdir(), 'midi.partial'),
        },
      }),
    ).toThrow('must not declare a stagingPath');
  });

  it('preserves immutable inline MIDI input without granting a file path', () => {
    const job = validateProviderJob(createInstrumentRenderJob());

    expect(job.inputArtifacts[0]).toMatchObject({
      artifactId: 'artifact-midi-a',
      kind: 'midi',
      midi: {
        bpm: 120,
        ticksPerQuarter: 960,
      },
    });
    expect(job.inputArtifacts[0].path).toBeUndefined();
    expect(Object.isFrozen(job.inputArtifacts[0].midi)).toBe(true);
    expect(Object.isFrozen(job.inputArtifacts[0].midi.notes)).toBe(true);
    expect(providerSupportsJob(MOCK_PROVIDER_DESCRIPTOR, job)).toBe(true);
    expect(() =>
      validateProviderJob({
        ...createInstrumentRenderJob(),
        inputArtifacts: [
          {
            ...createInstrumentRenderJob().inputArtifacts[0],
            path: join(tmpdir(), 'source.mid'),
          },
        ],
      }),
    ).toThrow('must not declare both path and inline MIDI');
  });

  it('does not derive Task support from the Provider family', () => {
    const job = validateProviderJob({ ...createMockJob(), taskId: 'vocal-generation' });
    const wrongOutput = validateProviderJob({
      ...createMockJob(),
      output: { kind: 'metadata', stagingPath: join(tmpdir(), 'metadata.partial') },
    });

    expect(providerSupportsJob(MOCK_PROVIDER_DESCRIPTOR, job)).toBe(false);
    expect(providerSupportsJob(MOCK_PROVIDER_DESCRIPTOR, wrongOutput)).toBe(false);
  });

  it('rejects undeclared Model Tasks and duplicate Capability Tasks', () => {
    const duplicateCapability = MOCK_PROVIDER_DESCRIPTOR.capabilities[0];

    expect(() =>
      validateProviderDescriptor({
        ...MOCK_PROVIDER_DESCRIPTOR,
        capabilities: [duplicateCapability, duplicateCapability],
      }),
    ).toThrow('unique');
    expect(() =>
      validateProviderDescriptor({
        ...MOCK_PROVIDER_DESCRIPTOR,
        models: [
          {
            ...MOCK_PROVIDER_DESCRIPTOR.models[0],
            taskIds: ['unknown-task'],
          },
        ],
      }),
    ).toThrow('declared Capability');
  });

  it('rejects relative or final output paths and non-JSON parameters', () => {
    expect(() =>
      validateProviderJob({
        ...createMockJob(),
        output: { kind: 'audio', stagingPath: 'relative.partial' },
      }),
    ).toThrow(ProviderContractValidationError);
    expect(() =>
      validateProviderJob({
        ...createMockJob(),
        output: { kind: 'audio', stagingPath: join(tmpdir(), 'final.wav') },
      }),
    ).toThrow('.partial');
    expect(() =>
      validateProviderJob({
        ...createMockJob(),
        parameters: { unsupported: undefined },
      }),
    ).toThrow('non-JSON');
  });
});

function createMockJob() {
  return {
    inputArtifacts: [],
    jobId: 'job-contract-a',
    modelId: MOCK_PROVIDER_MODEL_ID,
    modelRevision: MOCK_PROVIDER_MODEL_REVISION,
    output: { kind: 'audio', stagingPath: join(tmpdir(), 'contract-output.partial') },
    parameters: {
      durationSeconds: 0.1,
      frequencyHz: 440,
      sampleRate: 8_000,
      seed: 7,
    },
    providerId: MOCK_PROVIDER_ID,
    taskId: MOCK_PROVIDER_TASK_ID,
  };
}

function createHumToMidiJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-recording-a',
        kind: 'audio',
        path: join(tmpdir(), 'artifact-recording-a.wav'),
      },
    ],
    jobId: 'job-contract-midi-a',
    modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
    modelRevision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
    output: { kind: 'midi' },
    parameters: {
      projectBpm: 120,
      seed: 7,
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      ticksPerQuarter: 960,
    },
    providerId: MOCK_PROVIDER_ID,
    taskId: MOCK_HUM_TO_MIDI_TASK_ID,
  };
}

function createInstrumentRenderJob() {
  return {
    inputArtifacts: [
      {
        artifactId: 'artifact-midi-a',
        kind: 'midi',
        midi: {
          bpm: 120,
          notes: [
            {
              id: 'note-a',
              lengthTicks: 960,
              pitch: 60,
              startTick: 0,
              velocity: 100,
            },
          ],
          ticksPerQuarter: 960,
        },
      },
    ],
    jobId: 'job-contract-instrument-a',
    modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
    modelRevision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
    output: {
      kind: 'audio',
      stagingPath: join(tmpdir(), 'instrument-output.partial'),
    },
    parameters: {
      channels: 2,
      gainDb: -3,
      preset: {
        bank: 0,
        program: 24,
      },
      providerVersion: '1',
      sampleRate: 8_000,
    },
    providerId: MOCK_PROVIDER_ID,
    taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
  };
}
