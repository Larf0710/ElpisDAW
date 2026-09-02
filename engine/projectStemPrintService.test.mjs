import { createHash } from 'node:crypto';
import {
  access,
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

import { createCanonicalProjectRenderPlanJson } from '../shared/projectRenderPlanIdentity.js';
import { GeneratedArtifactFinalizer } from './generatedArtifactFinalizer.mjs';
import { GeneratedAudioReader } from './generatedAudioReader.mjs';
import {
  MAX_PROJECT_MIXDOWN_SOURCE_BYTES,
  ProjectMixdownService,
} from './projectMixdownService.mjs';
import { ProjectMixdownWorkerClient } from './projectMixdownWorkerClient.mjs';
import { createTestStemPrintPlanV1 } from './projectMixdownTestFixtures.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';

const SAMPLE_RATE = 44_100;
const TICKS_PER_BEAT = 960;
const TEST_BPM = (60 * SAMPLE_RATE) / TICKS_PER_BEAT;
const OUTPUT_ARTIFACT_ID =
  'artifact-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

describe('Project Stem Print service finalization', () => {
  it('reads generated and external sources and finalizes one exact Stem WAV', async () => {
    const { authority, rootPath, service } = await createReadyService();
    const externalDirectory = await createTemporaryDirectory(
      'humstudio-stem-print-external-',
    );
    const generatedBytes = createPcm16Wave([[1_000], [2_000]]);
    const externalBytes = createPcm16Wave([
      [3_000, -3_000],
      [4_000, -4_000],
    ]);
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
    const plan = createStemPlan({
      frameCount: 2,
      sources: [generated, external],
      tracks: [
        createTrack('generated-track', generated.sourceId, 2),
        createTrack('external-track', external.sourceId, 2, 'group-external'),
      ],
    });
    const expectedCanonicalPlan = createCanonicalProjectRenderPlanJson(plan);
    const result = await service.renderStemPrintAndSave(plan, {
      artifactId: OUTPUT_ARTIFACT_ID,
    });
    const finalPath = join(
      rootPath,
      ...result.artifact.file.relativePath.split('/'),
    );
    const finalBytes = await readFile(finalPath);

    expect(result).toMatchObject({
      artifact: {
        artifactId: OUTPUT_ARTIFACT_ID,
        destination: 'stem-print',
        file: {
          extension: '.wav',
          name: `${OUTPUT_ARTIFACT_ID}.wav`,
          relativePath: `stem-prints/${OUTPUT_ARTIFACT_ID}.wav`,
          sizeBytes: finalBytes.byteLength,
        },
        kind: 'audio',
        provenance: {
          canonicalPlanJson: expectedCanonicalPlan,
          planSha256: createHash('sha256')
            .update(expectedCanonicalPlan)
            .digest('hex'),
          planVersion: 1,
          rendererId: 'humstudio-pcm-mixdown',
          rendererVersion: '0.2.0',
          selectedTargets: [
            channelTarget('generated-track'),
            groupTarget('group-external', 'external-track'),
          ],
          sourceIds: ['generated-source', 'external-source'],
        },
      },
      status: 'COMPLETED',
      stemPrint: {
        bitsPerSample: 16,
        bytesWritten: finalBytes.byteLength,
        channels: 2,
        frameCount: 2,
        mimeType: 'audio/wav',
        sampleRate: SAMPLE_RATE,
        sourceCount: 2,
        targetCount: 2,
        trackCount: 2,
      },
    });
    expect(result.artifact.provenance.plan).toEqual(plan);
    expect(result.artifact.provenance.plan).not.toBe(plan);
    expect(Object.isFrozen(result.artifact.provenance.plan)).toBe(true);
    expect(finalBytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([
      `${OUTPUT_ARTIFACT_ID}.wav`,
    ]);
    await expect(new GeneratedAudioReader({
      projectRootAuthority: authority,
    }).readWav({
      kind: 'generated',
      name: result.artifact.file.name,
      relativePath: result.artifact.file.relativePath,
      sizeBytes: result.artifact.file.sizeBytes,
      sourceId: result.artifact.artifactId,
    })).resolves.toMatchObject({
      bytes: finalBytes,
      contentLength: finalBytes.byteLength,
      contentType: 'audio/wav',
    });
  });

  it('rejects external metadata drift and discards Stem staging', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const externalDirectory = await createTemporaryDirectory(
      'humstudio-stem-print-drift-',
    );
    const descriptor = await writeExternalSource(
      externalDirectory,
      'external-source',
      createPcm16Wave([[1_000]]),
    );
    await writeFile(descriptor.path, createPcm16Wave([[1_000], [2_000]]));

    await expect(
      service.renderStemPrintAndSave(createSingleSourceStemPlan(descriptor)),
    ).rejects.toMatchObject({
      code: 'MIXDOWN_EXTERNAL_SOURCE_METADATA_MISMATCH',
    });
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('enforces the shared source memory budget before reserving output', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const bytes = createPcm16Wave([[0]]);
    const descriptor = {
      ...generatedDescriptor('source-1', bytes),
      sizeBytes: MAX_PROJECT_MIXDOWN_SOURCE_BYTES + 1,
    };

    await expect(
      service.renderStemPrintAndSave(createSingleSourceStemPlan(descriptor)),
    ).rejects.toMatchObject({ code: 'MIXDOWN_SOURCE_BUDGET_EXCEEDED' });
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('rejects invalid Worker output metadata and discards staging', async () => {
    const bytes = createPcm16Wave([[0]]);
    const { finalizer, rootPath, service } = await createReadyService({
      renderer: {
        async render() {
          throw new Error('Raw Mixdown renderer must not be called.');
        },
        async renderStemPrint() {
          return {
            bitsPerSample: 16,
            bytes: createStereoOutputWave(1),
            channels: 2,
            durationSeconds: 1 / SAMPLE_RATE,
            frameCount: 1,
            mimeType: 'audio/wav',
            sampleRate: 48_000,
          };
        },
      },
    });
    const descriptor = await writeGeneratedSource(rootPath, 'source-1', bytes);

    await expect(
      service.renderStemPrintAndSave(createSingleSourceStemPlan(descriptor)),
    ).rejects.toMatchObject({ code: 'STEM_PRINT_RENDER_RESULT_INVALID' });
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('keeps malformed Worker output out of the Stem destination', async () => {
    const { finalizer, rootPath, service } = await createReadyService({
      workerUrl: MALFORMED_WORKER_URL,
    });
    const bytes = createPcm16Wave([[0]]);
    const descriptor = await writeGeneratedSource(rootPath, 'source-1', bytes);

    await expect(
      service.renderStemPrintAndSave(createSingleSourceStemPlan(descriptor)),
    ).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_RESPONSE_INVALID' });
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('cancels before rendering and removes its existing reservation', async () => {
    const rootPath = await createTemporaryDirectory(
      'humstudio-stem-print-cancel-',
    );
    const authority = new ProjectRootAuthority();
    await authority.configure(rootPath);
    const finalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority: authority,
    });
    const bytes = createPcm16Wave([[0]]);
    const descriptor = generatedDescriptor('source-1', bytes);
    let markReadStarted;
    let resolveRead;
    const readStarted = new Promise((resolve) => {
      markReadStarted = resolve;
    });
    const readResult = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const service = new ProjectMixdownService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader: {
        async readWav() {
          markReadStarted();
          return readResult;
        },
      },
      mixdownRenderer: new ProjectMixdownWorkerClient({
        renderTimeoutMs: 5_000,
      }),
    });
    const controller = new AbortController();
    const rendering = service.renderStemPrintAndSave(
      createSingleSourceStemPlan(descriptor),
      { signal: controller.signal },
    );
    await readStarted;
    await expect(service.renderAndSave({})).rejects.toMatchObject({
      code: 'MIXDOWN_SERVICE_BUSY',
    });
    controller.abort();
    resolveRead({
      bytes,
      contentLength: bytes.byteLength,
      contentType: 'audio/wav',
    });

    await expect(rendering).rejects.toMatchObject({ code: 'MIXDOWN_ABORTED' });
    expect(await readdir(join(rootPath, 'stem-prints'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('never overwrites an existing Stem destination', async () => {
    const { finalizer, rootPath, service } = await createReadyService();
    const existingPath = join(
      rootPath,
      'stem-prints',
      `${OUTPUT_ARTIFACT_ID}.wav`,
    );
    const bytes = createPcm16Wave([[0]]);
    const descriptor = await writeGeneratedSource(rootPath, 'source-1', bytes);
    await writeFile(existingPath, 'existing stem output', 'utf8');

    await expect(service.renderStemPrintAndSave(
      createSingleSourceStemPlan(descriptor),
      { artifactId: OUTPUT_ARTIFACT_ID },
    )).rejects.toMatchObject({ code: 'ARTIFACT_DESTINATION_EXISTS' });
    await expect(readFile(existingPath, 'utf8')).resolves.toBe(
      'existing stem output',
    );
    expect(await findPartialFiles(join(rootPath, 'stem-prints'))).toEqual([]);
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('reports unknown outcome without deleting a WAV finalized before response loss', async () => {
    const rootPath = await createTemporaryDirectory(
      'humstudio-stem-print-unknown-',
    );
    const authority = new ProjectRootAuthority();
    await authority.configure(rootPath);
    const finalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority: authority,
    });
    const responseLosingFinalizer = {
      reserve: (...args) => finalizer.reserve(...args),
      discard: (...args) => finalizer.discard(...args),
      async finalize(...args) {
        await finalizer.finalize(...args);
        throw new Error('Injected response loss after atomic finalization.');
      },
    };
    const service = new ProjectMixdownService({
      generatedArtifactFinalizer: responseLosingFinalizer,
      generatedAudioReader: new GeneratedAudioReader({
        projectRootAuthority: authority,
      }),
      mixdownRenderer: new ProjectMixdownWorkerClient({
        renderTimeoutMs: 5_000,
      }),
    });
    const bytes = createPcm16Wave([[0]]);
    const descriptor = await writeGeneratedSource(rootPath, 'source-1', bytes);
    const finalPath = join(
      rootPath,
      'stem-prints',
      `${OUTPUT_ARTIFACT_ID}.wav`,
    );

    await expect(service.renderStemPrintAndSave(
      createSingleSourceStemPlan(descriptor),
      { artifactId: OUTPUT_ARTIFACT_ID },
    )).rejects.toMatchObject({ code: 'STEM_PRINT_OUTCOME_UNKNOWN' });
    await expect(access(finalPath)).resolves.toBeUndefined();
    expect((await readFile(finalPath)).toString('ascii', 0, 4)).toBe('RIFF');
    expect(await findPartialFiles(join(rootPath, 'stem-prints'))).toEqual([]);
  });
});

async function createReadyService({ renderer, workerUrl } = {}) {
  const rootPath = await createTemporaryDirectory(
    'humstudio-stem-print-service-',
  );
  const authority = new ProjectRootAuthority();
  await authority.configure(rootPath);
  const finalizer = new GeneratedArtifactFinalizer({
    projectRootAuthority: authority,
  });
  return {
    authority,
    finalizer,
    rootPath,
    service: new ProjectMixdownService({
      generatedArtifactFinalizer: finalizer,
      generatedAudioReader: new GeneratedAudioReader({
        projectRootAuthority: authority,
      }),
      mixdownRenderer: renderer ?? new ProjectMixdownWorkerClient({
        renderTimeoutMs: 5_000,
        workerUrl,
      }),
    }),
  };
}

function createSingleSourceStemPlan(descriptor) {
  return createStemPlan({
    frameCount: 1,
    sources: [descriptor],
    tracks: [createTrack('track-1', descriptor.sourceId, 1)],
  });
}

function createStemPlan({ frameCount, sources, tracks }) {
  return createTestStemPrintPlanV1({
    bpm: TEST_BPM,
    durationSeconds: frameCount / SAMPLE_RATE,
    endTick: frameCount,
    selectedTargets: tracks.map((track) => track.groupTrackId
      ? groupTarget(track.groupTrackId, track.trackId)
      : channelTarget(track.trackId)),
    sources,
    tracks,
  });
}

function createTrack(trackId, sourceId, frameCount, groupTrackId) {
  return {
    events: [{
      clipId: `clip-${trackId}`,
      clipName: `clip-${trackId}`,
      durationSeconds: frameCount / SAMPLE_RATE,
      sourceId,
      sourceStartSeconds: 0,
      startOffsetSeconds: 0,
      timelineEndTick: frameCount,
      timelineStartTick: 0,
    }],
    gainDb: 0,
    ...(groupTrackId ? { groupTrackId } : {}),
    pan: 0,
    trackId,
  };
}

function channelTarget(trackId) {
  return { kind: 'channel', resolvedTrackId: trackId, trackId };
}

function groupTarget(groupTrackId, resolvedTrackId) {
  return { groupTrackId, kind: 'group', resolvedTrackId };
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

function createPcm16Wave(frames) {
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
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
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

function createStereoOutputWave(frameCount) {
  return createPcm16Wave(
    Array.from({ length: frameCount }, () => [0, 0]),
  );
}

async function findPartialFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.partial'));
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}
