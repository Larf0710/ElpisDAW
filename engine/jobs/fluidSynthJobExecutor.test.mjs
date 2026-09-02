import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GpuJobQueue } from './gpuJobQueue.mjs';
import {
  FluidSynthJobExecutor,
  FluidSynthJobExecutorError,
} from './fluidSynthJobExecutor.mjs';

const temporaryFiles = new Set();
const queues = new Set();

afterEach(async () => {
  await Promise.allSettled([...queues].map((queue) => queue.shutdown()));
  queues.clear();
  await Promise.all(
    [...temporaryFiles].map((path) => rm(path, { force: true })),
  );
  temporaryFiles.clear();
});

describe('FluidSynthJobExecutor', () => {
  it('validates one SoundFont-bound inline MIDI request', () => {
    const { executor } = createExecutor();
    const request = executor.validateRequest(createRequest());

    expect(request).toMatchObject({
      modelId: 'soundfont-0123456789abcdef0123456789abcdef',
      output: {
        artifactKind: 'audio',
        destination: 'instrument',
        extension: '.wav',
      },
      parameters: {
        preset: { bank: 0, program: 24 },
        providerVersion: '2.5.7',
        soundFont: {
          format: 'sf2',
          library: 'project',
          relativePath: 'soundfonts/Test.sf2',
        },
      },
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    });
    expect(Object.isFrozen(request.inputArtifacts[0].midi.notes)).toBe(true);
    expect(request.inputArtifacts[0].midi.notes[0]).not.toHaveProperty(
      'confidence',
    );
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        modelRevision: 'f'.repeat(64),
      }),
    ).toThrow('Model identity');
    expect(() =>
      executor.validateRequest({
        ...createRequest(),
        parameters: {
          ...createRequest().parameters,
          soundFont: {
            ...createRequest().parameters.soundFont,
            relativePath: 'soundfonts/../Test.sf2',
          },
        },
      }),
    ).toThrow(FluidSynthJobExecutorError);
  });

  it('preserves valid MIDI note confidence including both boundaries', () => {
    const { executor } = createExecutor();
    const request = createRequest();
    request.inputArtifacts[0].midi.notes = [
      {
        confidence: 0,
        id: 'note-confidence-zero',
        lengthTicks: 480,
        pitch: 60,
        startTick: 0,
        velocity: 100,
      },
      {
        confidence: 0.625,
        id: 'note-confidence-mid',
        lengthTicks: 480,
        pitch: 64,
        startTick: 480,
        velocity: 101,
      },
      {
        confidence: 1,
        id: 'note-confidence-one',
        lengthTicks: 480,
        pitch: 67,
        startTick: 960,
        velocity: 102,
      },
    ];

    const normalized = executor.validateRequest(request);

    expect(normalized.inputArtifacts[0].midi.notes).toEqual(
      request.inputArtifacts[0].midi.notes,
    );
    expect(Object.isFrozen(normalized.inputArtifacts[0].midi.notes[0])).toBe(
      true,
    );
  });

  it.each([
    ['negative', -0.001],
    ['greater than one', 1.001],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['string', '0.5'],
    ['null', null],
    ['object', { value: 0.5 }],
  ])('rejects %s MIDI note confidence', (_label, confidence) => {
    const { executor } = createExecutor();
    const request = createRequest();
    request.inputArtifacts[0].midi.notes[0].confidence = confidence;

    expect(() => executor.validateRequest(request)).toThrow(
      'confidence must be a finite number from 0 through 1',
    );
  });

  it('finalizes one stereo PCM WAV with complete provenance', async () => {
    const { executor, finalizer, outputPath, renderer } = createExecutor();
    const queue = new GpuJobQueue({
      createJobId: () => 'job-fluid-render',
      executor,
      now: createClock(),
    });
    queues.add(queue);
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();
    const completed = queue.getJob(queued.jobId);

    expect(completed).toMatchObject({
      result: {
        artifact: {
          destination: 'instrument',
          kind: 'audio',
          provenance: {
            modelId: 'soundfont-0123456789abcdef0123456789abcdef',
            modelRevision: 'a'.repeat(64),
            parameters: {
              preset: { bank: 0, program: 24 },
              soundFont: {
                resourceId: 'soundfont-0123456789abcdef0123456789abcdef',
                revisionToken: 'a'.repeat(64),
              },
            },
            providerId: 'local-fluidsynth',
            taskId: 'midi-to-audio',
          },
        },
        generation: {
          bytesWritten: 192_044,
          channels: 2,
          durationSeconds: 1,
          mimeType: 'audio/wav',
        },
      },
      state: 'COMPLETED',
    });
    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        bank: 0,
        program: 24,
        soundFont: expect.objectContaining({
          revisionToken: 'a'.repeat(64),
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(readFile(outputPath)).resolves.toEqual(createPcmWav());
    expect(finalizer.discard).not.toHaveBeenCalled();
  });

  it('discards staging when rendering fails', async () => {
    const renderer = {
      render: vi.fn(async () => {
        throw Object.assign(new Error('Render failed deliberately.'), {
          code: 'FLUIDSYNTH_RENDER_FAILED',
        });
      }),
    };
    const { executor, finalizer } = createExecutor({ renderer });
    const queue = new GpuJobQueue({
      createJobId: () => 'job-fluid-failure',
      executor,
    });
    queues.add(queue);
    const queued = queue.enqueue(createRequest());

    await queue.waitForIdle();

    expect(queue.getJob(queued.jobId)).toMatchObject({
      error: {
        code: 'FLUIDSYNTH_RENDER_FAILED',
        message: 'Render failed deliberately.',
      },
      state: 'FAILED',
    });
    expect(finalizer.discard).toHaveBeenCalledWith('reservation-test');
  });
});

function createExecutor({ renderer } = {}) {
  const outputPath = join(
    tmpdir(),
    `humstudio-fluid-job-${crypto.randomUUID()}.partial`,
  );
  temporaryFiles.add(outputPath);
  const finalizer = {
    discard: vi.fn(async () => {
      await rm(outputPath, { force: true });
    }),
    finalize: vi.fn(async () => ({
      artifactId: 'artifact-fluid-render',
      destination: 'instrument',
      file: {
        extension: '.wav',
        name: 'artifact-fluid-render.wav',
        relativePath: 'renders/instruments/artifact-fluid-render.wav',
        sizeBytes: 192_044,
      },
      finalizedAt: '2026-07-28T09:00:04.000Z',
      reservationId: 'reservation-test',
      status: 'FINALIZED',
    })),
    reserve: vi.fn(async () => ({
      artifactId: 'artifact-fluid-render',
      createdAt: '2026-07-28T09:00:01.000Z',
      destination: 'instrument',
      finalRelativePath: 'renders/instruments/artifact-fluid-render.wav',
      reservationId: 'reservation-test',
      stagingPath: outputPath,
      status: 'STAGING',
    })),
  };
  const resolvedRenderer =
    renderer ??
    {
      render: vi.fn(async () => {
        const bytes = createPcmWav();
        return {
          bytes,
          contentLength: bytes.length,
          contentType: 'audio/wav',
        };
      }),
    };
  const executor = new FluidSynthJobExecutor({
    generatedArtifactFinalizer: finalizer,
    now: () => '2026-07-28T09:00:03.000Z',
    soundFontAuditionService: resolvedRenderer,
  });
  return { executor, finalizer, outputPath, renderer: resolvedRenderer };
}

function createRequest() {
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
    lineage: {
      parentArtifactIds: ['artifact-midi-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    modelId: 'soundfont-0123456789abcdef0123456789abcdef',
    modelRevision: 'a'.repeat(64),
    output: {
      artifactKind: 'audio',
      destination: 'instrument',
      extension: '.wav',
    },
    parameters: {
      channels: 2,
      gainDb: -14,
      preset: { bank: 0, program: 24 },
      providerVersion: '2.5.7',
      sampleRate: 48_000,
      soundFont: {
        format: 'sf2',
        library: 'project',
        relativePath: 'soundfonts/Test.sf2',
        resourceId: 'soundfont-0123456789abcdef0123456789abcdef',
        revisionToken: 'a'.repeat(64),
      },
      sourceMidiContentHash: 'fnv1a64-0123456789abcdef',
      sourceMidiRevision: 1,
    },
    providerId: 'local-fluidsynth',
    taskId: 'midi-to-audio',
  };
}

function createPcmWav() {
  const bytes = Buffer.alloc(192_044);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48_000, 24);
  bytes.writeUInt32LE(48_000 * 2 * 2, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(192_000, 40);
  return bytes;
}

function createClock() {
  let tick = 0;
  return () => new Date(Date.parse('2026-07-28T09:00:00.000Z') + tick++).toISOString();
}
