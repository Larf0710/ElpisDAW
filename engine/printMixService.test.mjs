import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PRINT_MIX_BITS_PER_SAMPLE,
  PRINT_MIX_CHANNELS,
  PRINT_MIX_MIME_TYPE,
  PRINT_MIX_NORMALIZE_TARGET_DBFS,
  PRINT_MIX_PLAN_VERSION,
  PRINT_MIX_RENDERER_ID,
  PRINT_MIX_RENDERER_VERSION,
  PRINT_MIX_SAMPLE_RATE,
  createPrintMixArtifactId,
} from '../shared/printMixProtocol.js';

import { createPrintMixRequest, parsePrintMixOperation } from '../src/printMixOperation.ts';
import { createPrintMixPlan } from '../src/printMixPlan.ts';
import {
  PRINT_MIX_TEST_OPERATION_ID,
  PRINT_MIX_TEST_OPERATION_ID_2,
  createPrintMixAudioProject,
} from '../src/printMixTestFixture.ts';
import { createOutputWave, writeOutputBlock } from './projectPcmMixdownRenderer.mjs';
import {
  PrintMixOperationCoordinator,
  PrintMixService,
} from './printMixService.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('PrintMixService', () => {
  it('reads only frozen generated sources and atomically finalizes one operation-owned WAV', async () => {
    const request = createAudioRequest();
    const directory = await createTemporaryDirectory();
    const calls = [];
    const sourceWave = createWave(0.25);
    const finalizer = createFinalizer(directory, calls);
    const reader = {
      async readWav(descriptor) {
        calls.push(`read:${descriptor.sourceId}`);
        return {
          bytes: sourceWave,
          contentLength: sourceWave.length,
          contentType: 'audio/wav',
        };
      },
    };
    const service = new PrintMixService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader: reader,
    });
    const coordinator = new PrintMixOperationCoordinator({ service });
    const operation = await coordinator.execute(request);
    const parsed = await parsePrintMixOperation(operation, request);

    expect(parsed).toBeDefined();
    expect(operation).toMatchObject({
      operationId: PRINT_MIX_TEST_OPERATION_ID,
      result: {
        artifact: { destination: 'print-mix' },
        printMix: { mediaType: 'audio', sourceCount: 2 },
        status: 'COMPLETED',
      },
    });
    expect(calls).toEqual([
      'reserve:print-mix',
      'read:artifact-audio-source-1',
      'read:artifact-audio-source-2',
      'finalize',
    ]);
    const finalBytes = await readFile(finalizer.finalPath);
    expect(finalBytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(finalBytes.toString('ascii', 8, 12)).toBe('WAVE');

    const recovered = await coordinator.execute(request);
    expect(recovered).toBe(operation);
    expect(calls.filter((call) => call === 'finalize')).toHaveLength(1);
  });

  it('discards partial output and leaves no finalized result on render failure', async () => {
    const request = createAudioRequest();
    const directory = await createTemporaryDirectory();
    const calls = [];
    const finalizer = createFinalizer(directory, calls);
    const sourceWave = createWave(0.25);
    const service = new PrintMixService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader: {
        async readWav() {
          return {
            bytes: sourceWave,
            contentLength: sourceWave.length,
            contentType: 'audio/wav',
          };
        },
      },
      renderer: {
        render() {
          throw new Error('render failed');
        },
      },
    });

    await expect(service.renderAndSave(request.plan)).rejects.toThrow(
      'render failed',
    );
    expect(calls).toContain('discard');
    expect(calls).not.toContain('finalize');
    await expect(stat(finalizer.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deduplicates concurrent recovery and rejects colliding or unrelated operation identity', async () => {
    const request = createAudioRequest();
    let complete;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    const service = {
      renderAndSave: vi.fn(() => pending),
    };
    const coordinator = new PrintMixOperationCoordinator({ service });
    const first = coordinator.execute(request);
    const recovery = coordinator.execute(request);
    const collision = structuredClone(request);
    collision.plan.normalize = !collision.plan.normalize;

    await expect(coordinator.execute(collision)).rejects.toMatchObject({
      code: 'PRINT_MIX_OPERATION_CONFLICT',
    });

    const other = structuredClone(request);
    other.operationId = PRINT_MIX_TEST_OPERATION_ID_2;
    other.plan.operationId = PRINT_MIX_TEST_OPERATION_ID_2;
    await expect(coordinator.execute(other)).rejects.toMatchObject({
      code: 'PRINT_MIX_OPERATION_BUSY',
    });

    const completedResult = createCompletedServiceResult(request.plan);
    complete(completedResult);
    await expect(first).resolves.toMatchObject({ result: completedResult });
    await expect(recovery).resolves.toMatchObject({ result: completedResult });
    expect(service.renderAndSave).toHaveBeenCalledTimes(1);
  });

  it('reports unknown finalization outcome without attempting a second Artifact identity', async () => {
    const request = createAudioRequest();
    const directory = await createTemporaryDirectory();
    const sourceWave = createWave(0.25);
    const finalizer = createFinalizer(directory, []);
    finalizer.finalize = async () => {
      throw new Error('response lost after rename boundary');
    };
    finalizer.discard = async () => {
      throw new Error('reservation outcome unavailable');
    };
    const service = new PrintMixService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader: {
        async readWav() {
          return {
            bytes: sourceWave,
            contentLength: sourceWave.length,
            contentType: 'audio/wav',
          };
        },
      },
    });

    await expect(service.renderAndSave(request.plan)).rejects.toEqual(
      expect.objectContaining({
        code: 'PRINT_MIX_OUTCOME_UNKNOWN',
        name: 'PrintMixServiceError',
      }),
    );
  });

  it('aborts and awaits the active operation during shutdown, then rejects new work', async () => {
    const request = createAudioRequest();
    const activity = [];
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const service = {
      renderAndSave: vi.fn(async (_plan, { signal }) => {
        markStarted();
        if (!signal.aborted) {
          await new Promise((resolve) =>
            signal.addEventListener('abort', resolve, { once: true }),
          );
        }
        throw Object.assign(new Error('shutdown abort'), {
          code: 'PRINT_MIX_ABORTED',
        });
      }),
    };
    const coordinator = new PrintMixOperationCoordinator({
      onActiveChange: (isActive) => activity.push(isActive),
      service,
    });
    const execution = coordinator.execute(request);
    await started;

    await coordinator.shutdown();
    await expect(execution).rejects.toMatchObject({
      code: 'PRINT_MIX_ABORTED',
    });
    await expect(coordinator.execute(request)).rejects.toMatchObject({
      code: 'ENGINE_CLOSING',
    });
    expect(activity).toEqual([true, false]);
    expect(service.renderAndSave).toHaveBeenCalledTimes(1);
  });
});

function createAudioRequest() {
  const project = createPrintMixAudioProject();
  const resolution = createPrintMixPlan(
    project,
    'print-mix',
    project.selection,
    PRINT_MIX_TEST_OPERATION_ID,
  );
  if (!resolution.canCreate || resolution.plan.mediaType !== 'audio') {
    throw new Error('Missing Audio PRINT MIX Plan fixture.');
  }
  return createPrintMixRequest(resolution.plan);
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-print-mix-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createFinalizer(directory, calls) {
  const artifactId = 'artifact-11111111-1111-4111-8111-111111111111';
  const stagingPath = join(directory, `.${artifactId}.wav.partial`);
  const finalPath = join(directory, `${artifactId}.wav`);
  return {
    finalPath,
    async reserve(options) {
      calls.push(`reserve:${options.destination}`);
      await writeFile(stagingPath, Buffer.alloc(0), { flag: 'wx' });
      return {
        artifactId,
        reservationId: 'reservation-print-mix',
        stagingPath,
      };
    },
    async finalize() {
      calls.push('finalize');
      const bytes = await readFile(stagingPath);
      await writeFile(finalPath, bytes, { flag: 'wx' });
      return {
        artifactId,
        destination: 'print-mix',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `print-mixes/${artifactId}.wav`,
          sizeBytes: bytes.length,
        },
        finalizedAt: '2026-08-14T03:00:00.000Z',
        status: 'FINALIZED',
      };
    },
    async discard() {
      calls.push('discard');
      await rm(stagingPath, { force: true });
    },
  };
}

function createWave(sample) {
  const frameCount = 22_050;
  const bytes = createOutputWave(frameCount);
  const left = new Float64Array(frameCount).fill(sample);
  const right = new Float64Array(frameCount).fill(sample);
  writeOutputBlock(bytes, 0, left, right);
  return bytes;
}

function createCompletedServiceResult(plan) {
  const artifactId = createPrintMixArtifactId(plan.operationId);
  const frameCount = Math.round(plan.durationSeconds * PRINT_MIX_SAMPLE_RATE);
  const sizeBytes = 44 + frameCount * 4;

  return Object.freeze({
    artifact: Object.freeze({
      artifactId,
      createdAt: '2026-08-14T03:00:00.000Z',
      destination: 'print-mix',
      file: Object.freeze({
        extension: '.wav',
        name: `${artifactId}.wav`,
        relativePath: `print-mixes/${artifactId}.wav`,
        sizeBytes,
      }),
      kind: 'audio',
      provenance: Object.freeze({
        planSha256: createHash('sha256')
          .update(JSON.stringify(plan))
          .digest('hex'),
        planVersion: PRINT_MIX_PLAN_VERSION,
        rendererId: PRINT_MIX_RENDERER_ID,
        rendererVersion: PRINT_MIX_RENDERER_VERSION,
      }),
    }),
    printMix: Object.freeze({
      appliedGain: 1,
      bitsPerSample: PRINT_MIX_BITS_PER_SAMPLE,
      bytesWritten: sizeBytes,
      channels: PRINT_MIX_CHANNELS,
      clippingWarning: false,
      durationSeconds: frameCount / PRINT_MIX_SAMPLE_RATE,
      frameCount,
      mediaType: 'audio',
      mimeType: PRINT_MIX_MIME_TYPE,
      normalize: plan.normalize,
      outputPeak: 0,
      preNormalizationPeak: 0,
      sampleRate: PRINT_MIX_SAMPLE_RATE,
      sourceCount: plan.sources.length,
      targetPeakDbfs: PRINT_MIX_NORMALIZE_TARGET_DBFS,
    }),
    status: 'COMPLETED',
  });
}
