import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import { GeneratedAudioReader } from './generatedAudioReader.mjs';
import {
  MAX_PROJECT_MIXDOWN_SOURCE_BYTES,
  ProjectMixdownService,
} from './projectMixdownService.mjs';
import { ProjectMixdownWorkerClient } from './projectMixdownWorkerClient.mjs';
import { createTestRawMixdownPlanV3 } from './projectMixdownTestFixtures.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';

const SAMPLE_RATE = 44_100;
const TEST_TIMELINE_TICKS_PER_BEAT = 960;
// Keep compact frame-level fixtures coherent with integer Timeline ticks.
const TEST_BPM =
  (60 * SAMPLE_RATE) / TEST_TIMELINE_TICKS_PER_BEAT;
const MALFORMED_WORKER_URL = new URL(
  './projectMixdownMalformedWorker.fixture.mjs',
  import.meta.url,
);
const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('ProjectMixdownService', () => {
  it('reads generated and external sources and atomically finalizes one Mixdown WAV', async () => {
    const { rootPath, service } = await createReadyService();
    const externalDirectory = await createTemporaryDirectory('humstudio-mixdown-external-');
    const generatedBytes = createPcm16Wave({ frames: [[1_000], [2_000]] });
    const externalBytes = createPcm16Wave({
      frames: [[3_000, -3_000], [4_000, -4_000]],
    });
    const generated = await writeGeneratedSource(
      rootPath,
      'generated-source',
      generatedBytes,
    );
    const external = await writeExternalSource(
      externalDirectory,
      'external-source',
      externalBytes,
    );
    const durationSeconds = 2 / SAMPLE_RATE;
    const plan = createPlan({
      durationSeconds,
      sources: [generated, external],
      tracks: [
        createTrack({
          events: [
            createEvent({ durationSeconds, sourceId: generated.sourceId }),
          ],
          trackId: 'generated-track',
        }),
        createTrack({
          events: [
            createEvent({
              clipId: 'external-clip',
              durationSeconds,
              sourceId: external.sourceId,
            }),
          ],
          trackId: 'external-track',
        }),
      ],
    });

    const result = await service.renderAndSave(plan);
    const finalPath = join(
      rootPath,
      ...result.artifact.file.relativePath.split('/'),
    );
    const finalBytes = await readFile(finalPath);

    expect(result).toMatchObject({
      artifact: {
        destination: 'mixdown',
        kind: 'audio',
        provenance: {
          planVersion: 3,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
          sourceIds: ['generated-source', 'external-source'],
        },
      },
      mixdown: {
        bitsPerSample: 16,
        bytesWritten: finalBytes.byteLength,
        channels: 2,
        frameCount: 2,
        sampleRate: SAMPLE_RATE,
        sourceCount: 2,
        trackCount: 2,
      },
      status: 'COMPLETED',
    });
    expect(result.artifact.file.relativePath).toMatch(
      /^mixdowns\/artifact-[0-9a-f-]+\.wav$/,
    );
    expect(readPcmFrames(finalBytes)).toEqual([
      [3_707, -2_293],
      [5_414, -2_586],
    ]);
    expect(result).not.toHaveProperty('meterSummary');
    expect(result.mixdown).not.toHaveProperty('meterSummary');
    expect(result.artifact.provenance).not.toHaveProperty('meterSummary');
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([
      result.artifact.file.name,
    ]);
  });

  it('rejects external metadata drift and removes its staging reservation', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const externalDirectory = await createTemporaryDirectory('humstudio-mixdown-drift-');
    const originalBytes = createPcm16Wave({ frames: [[1_000]] });
    const descriptor = await writeExternalSource(
      externalDirectory,
      'external-source',
      originalBytes,
    );
    const plan = createSingleSourcePlan(descriptor);
    await writeFile(
      descriptor.path,
      createPcm16Wave({ frames: [[1_000], [2_000]] }),
    );

    await expect(service.renderAndSave(plan)).rejects.toMatchObject({
      code: 'MIXDOWN_EXTERNAL_SOURCE_METADATA_MISMATCH',
    });
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('keeps unsupported source PCM out of the final Mixdown directory', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const unsupportedBytes = createPcm16Wave({ frames: [[1_000]] });
    unsupportedBytes.writeUInt16LE(3, 20);
    const descriptor = await writeGeneratedSource(
      rootPath,
      'unsupported-source',
      unsupportedBytes,
    );

    await expect(
      service.renderAndSave(createSingleSourcePlan(descriptor)),
    ).rejects.toMatchObject({ code: 'MIXDOWN_SOURCE_WAV_INVALID' });
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('rejects invalid Worker success output without finalizing or completing', async () => {
    const { finalizer, rootPath, service } = await createReadyService({
      workerUrl: MALFORMED_WORKER_URL,
    });
    const bytes = createPcm16Wave({ frames: [[0]] });
    const descriptor = await writeGeneratedSource(rootPath, 'source-1', bytes);
    let completedResult;

    await expect(
      service.renderAndSave(createSingleSourcePlan(descriptor)).then((result) => {
        completedResult = result;
        return result;
      }),
    ).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_RESPONSE_INVALID' });
    expect(completedResult).toBeUndefined();
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('enforces generated Project-path authority before rendering', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const bytes = createPcm16Wave({ frames: [[0]] });
    const descriptor = generatedDescriptor(
      'outside-source',
      bytes,
      'outside/outside-source.wav',
    );

    await expect(
      service.renderAndSave(createSingleSourcePlan(descriptor)),
    ).rejects.toMatchObject({ code: 'GENERATED_AUDIO_REQUEST_INVALID' });
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('honors an already-aborted signal without creating staging work', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const bytes = createPcm16Wave({ frames: [[0]] });
    const descriptor = await writeGeneratedSource(rootPath, 'source-1', bytes);
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.renderAndSave(createSingleSourcePlan(descriptor), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'MIXDOWN_ABORTED' });
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('snapshots the Plan and rejects concurrent Mixdown work', async () => {
    const rootPath = await createTemporaryDirectory('humstudio-mixdown-busy-');
    const authority = new ProjectRootAuthority();
    await authority.configure(rootPath);
    const finalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority: authority,
    });
    const bytes = createPcm16Wave({ frames: [[2_000]] });
    const descriptor = generatedDescriptor('source-1', bytes);
    const plan = createSingleSourcePlan(descriptor);
    let resolveRead;
    let markReadStarted;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const pendingRead = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const observedDescriptors = [];
    const service = new ProjectMixdownService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader: {
        async readWav(observedDescriptor) {
          observedDescriptors.push(observedDescriptor);
          markReadStarted();
          return pendingRead;
        },
      },
      mixdownRenderer: new ProjectMixdownWorkerClient({
        renderTimeoutMs: 5_000,
      }),
    });

    const firstRun = service.renderAndSave(plan);
    await readStarted;
    plan.sources[0].sourceId = 'tampered-source';
    plan.tracks[0].events[0].sourceId = 'tampered-source';

    await expect(service.renderAndSave(plan)).rejects.toMatchObject({
      code: 'MIXDOWN_SERVICE_BUSY',
    });
    resolveRead({
      bytes,
      contentLength: bytes.byteLength,
      contentType: 'audio/wav',
    });
    const result = await firstRun;

    expect(observedDescriptors[0].sourceId).toBe('source-1');
    expect(result.artifact.provenance.sourceIds).toEqual(['source-1']);
    expect(result.artifact.provenance.plan.sources[0].sourceId).toBe('source-1');
    expect(
      Object.isFrozen(result.artifact.provenance.plan.tracks[0].events[0]),
    ).toBe(true);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('rejects an oversized aggregate source set before reserving output', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const bytes = createPcm16Wave({ frames: [[0]] });
    const descriptor = {
      ...generatedDescriptor('source-1', bytes),
      sizeBytes: MAX_PROJECT_MIXDOWN_SOURCE_BYTES + 1,
    };

    await expect(
      service.renderAndSave(createSingleSourcePlan(descriptor)),
    ).rejects.toMatchObject({ code: 'MIXDOWN_SOURCE_BUDGET_EXCEEDED' });
    expect(await readdir(join(rootPath, 'mixdowns'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });
});

async function createReadyService({ workerUrl } = {}) {
  const rootPath = await createTemporaryDirectory('humstudio-mixdown-service-');
  const authority = new ProjectRootAuthority();
  await authority.configure(rootPath);
  const finalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority: authority,
  });
  const generatedAudioReader = new GeneratedAudioReader({
    projectRootAuthority: authority,
  });
  return {
    finalizer,
    rootPath,
    service: new ProjectMixdownService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader,
      mixdownRenderer: new ProjectMixdownWorkerClient({
        renderTimeoutMs: 5_000,
        workerUrl,
      }),
    }),
  };
}

async function writeGeneratedSource(rootPath, sourceId, bytes) {
  const relativePath = `renders/stable-audio-3/${sourceId}.wav`;
  await writeFile(join(rootPath, ...relativePath.split('/')), bytes);
  return generatedDescriptor(sourceId, bytes, relativePath);
}

async function writeExternalSource(directory, sourceId, bytes) {
  const path = join(directory, `${sourceId}.wav`);
  await writeFile(path, bytes);
  const sourceStat = await stat(path);
  return {
    kind: 'external',
    lastModified: Math.round(sourceStat.mtimeMs),
    name: `${sourceId}.wav`,
    path,
    sizeBytes: bytes.byteLength,
    sourceId,
  };
}

function generatedDescriptor(
  sourceId,
  bytes,
  relativePath = `renders/stable-audio-3/${sourceId}.wav`,
) {
  return {
    kind: 'generated',
    name: `${sourceId}.wav`,
    relativePath,
    sizeBytes: bytes.byteLength,
    sourceId,
  };
}

function createSingleSourcePlan(descriptor) {
  const durationSeconds = 1 / SAMPLE_RATE;
  return createPlan({
    durationSeconds,
    sources: [descriptor],
    tracks: [
      createTrack({
        events: [
          createEvent({ durationSeconds, sourceId: descriptor.sourceId }),
        ],
      }),
    ],
  });
}

function createPlan({ durationSeconds, sources, tracks }) {
  return createTestRawMixdownPlanV3({
    bpm: TEST_BPM,
    durationSeconds,
    endTick: secondsToTestTimelineTicks(durationSeconds),
    sources,
    tracks,
  });
}

function createTrack({ events, gainDb = 0, pan = 0, trackId = 'track-1' }) {
  return { events, gainDb, pan, trackId };
}

function createEvent({ clipId = 'clip-1', durationSeconds, sourceId }) {
  return {
    clipId,
    clipName: clipId,
    durationSeconds,
    sourceId,
    sourceStartSeconds: 0,
    startOffsetSeconds: 0,
    timelineEndTick: secondsToTestTimelineTicks(durationSeconds),
    timelineStartTick: 0,
  };
}

function secondsToTestTimelineTicks(seconds) {
  return Math.max(
    1,
    Math.round(
      (seconds * TEST_BPM * TEST_TIMELINE_TICKS_PER_BEAT) / 60,
    ),
  );
}

function createPcm16Wave({ frames, sampleRate = SAMPLE_RATE }) {
  const channels = frames[0]?.length ?? 1;
  const dataByteLength = frames.length * channels * 2;
  const bytes = Buffer.alloc(44 + dataByteLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataByteLength, 40);

  frames.forEach((frame, frameIndex) => {
    frame.forEach((sample, channel) => {
      bytes.writeInt16LE(sample, 44 + (frameIndex * channels + channel) * 2);
    });
  });

  return bytes;
}

function readPcmFrames(bytes) {
  const channels = bytes.readUInt16LE(22);
  const dataByteLength = bytes.readUInt32LE(40);
  const frameCount = dataByteLength / (channels * 2);
  return Array.from({ length: frameCount }, (_, frame) => [
    bytes.readInt16LE(44 + frame * channels * 2),
    bytes.readInt16LE(46 + frame * channels * 2),
  ]);
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
