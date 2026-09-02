import { describe, expect, it } from 'vitest';

import {
  createTestRawMixdownPlanV3,
  createTestStemPrintPlanV1,
} from './projectMixdownTestFixtures.mjs';
import {
  ProjectMixdownWorkerClient,
  ProjectMixdownWorkerError,
} from './projectMixdownWorkerClient.mjs';

const SAMPLE_RATE = 44_100;
const TEST_TIMELINE_TICKS_PER_BEAT = 960;
// Keep compact frame-level fixtures coherent with integer Timeline ticks.
const TEST_BPM =
  (60 * SAMPLE_RATE) / TEST_TIMELINE_TICKS_PER_BEAT;
const MALFORMED_WORKER_URL = new URL(
  './projectMixdownMalformedWorker.fixture.mjs',
  import.meta.url,
);
const FAILING_WORKER_URL = new URL(
  './projectMixdownFailingWorker.fixture.mjs',
  import.meta.url,
);
const EXITING_WORKER_URL = new URL(
  './projectMixdownExitingWorker.fixture.mjs',
  import.meta.url,
);
const WRONG_OPERATION_WORKER_URL = new URL(
  './projectMixdownWrongOperationWorker.fixture.mjs',
  import.meta.url,
);

describe('ProjectMixdownWorkerClient', () => {
  it('renders outside the Engine event loop and returns canonical PCM WAV bytes', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const frameCount = 200_000;
    const source = createConstantPcm16Wave({ frameCount, sample: 4_000 });
    const plan = createPlan(source, frameCount);
    let settled = false;
    const rendering = client
      .render(plan, new Map([['source-1', source]]))
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(client.isRunning()).toBe(true);

    const result = await rendering;

    expect(result).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
      frameCount,
      mimeType: 'audio/wav',
      sampleRate: SAMPLE_RATE,
    });
    expect(readOutputFrame(result.bytes, 0)).toEqual([2_828, 2_828]);
    expect(readOutputFrame(result.bytes, frameCount - 1)).toEqual([2_828, 2_828]);
    expect(result).not.toHaveProperty('meterSummary');
    expect(client.isRunning()).toBe(false);
  });

  it('propagates renderer validation failures and releases the Worker', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });
    source.writeUInt16LE(3, 20);
    const plan = createPlan(source, 1);

    await expect(
      client.render(plan, new Map([['source-1', source]])),
    ).rejects.toMatchObject({ code: 'MIXDOWN_SOURCE_WAV_INVALID' });
    expect(client.isRunning()).toBe(false);
  });

  it.each([
    ['Channel', undefined],
    ['Group', 'group-1'],
  ])('renders an in-memory %s Stem Print through the shared Worker', async (
    _label,
    groupTrackId,
  ) => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const source = createConstantPcm16Wave({ frameCount: 2, sample: 4_000 });
    const result = await client.renderStemPrint(
      createStemPlan(source, 2, groupTrackId),
      new Map([['source-1', source]]),
    );

    expect(result).toMatchObject({
      bitsPerSample: 16,
      channels: 2,
      frameCount: 2,
      mimeType: 'audio/wav',
      sampleRate: SAMPLE_RATE,
    });
    expect(readOutputFrame(result.bytes, 0)).toEqual([2_828, 2_828]);
    expect(client.isRunning()).toBe(false);
  });

  it('rejects an unsupported Stem Plan before PCM rendering', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });
    const plan = createStemPlan(source, 1);
    plan.version = 2;

    await expect(client.renderStemPrint(
      plan,
      new Map([['source-1', source]]),
    )).rejects.toMatchObject({ code: 'STEM_PRINT_PLAN_INVALID' });
    expect(client.isRunning()).toBe(false);
  });

  it('rejects RIFF/WAVE output with JUNK and NOPE chunk identifiers', async () => {
    const client = new ProjectMixdownWorkerClient({
      renderTimeoutMs: 5_000,
      workerUrl: MALFORMED_WORKER_URL,
    });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });

    await expect(
      client.render(
        createPlan(source, 1),
        new Map([['source-1', source]]),
      ),
    ).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_RESPONSE_INVALID' });
    expect(client.isRunning()).toBe(false);
  });

  it('rejects a response for the wrong render operation', async () => {
    const client = new ProjectMixdownWorkerClient({
      renderTimeoutMs: 5_000,
      workerUrl: WRONG_OPERATION_WORKER_URL,
    });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });

    await expect(client.renderStemPrint(
      createStemPlan(source, 1),
      new Map([['source-1', source]]),
    )).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_RESPONSE_INVALID' });
    expect(client.isRunning()).toBe(false);
  });

  it('force-terminates active rendering when aborted', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const source = createConstantPcm16Wave({ frameCount: 500_000, sample: 2_000 });
    const plan = createPlan(source, 500_000);
    const controller = new AbortController();
    const rendering = client.render(
      plan,
      new Map([['source-1', source]]),
      { signal: controller.signal },
    );
    controller.abort();

    await expect(rendering).rejects.toMatchObject({ code: 'MIXDOWN_ABORTED' });
    expect(client.isRunning()).toBe(false);
  });

  it('rejects concurrent render requests until the active Worker is released', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const firstSource = createConstantPcm16Wave({
      frameCount: 500_000,
      sample: 1_000,
    });
    const secondSource = createConstantPcm16Wave({ frameCount: 1, sample: 0 });
    const controller = new AbortController();
    const firstRender = client.render(
      createPlan(firstSource, 500_000),
      new Map([['source-1', firstSource]]),
      { signal: controller.signal },
    );

    await expect(
      client.render(
        createPlan(secondSource, 1),
        new Map([['source-1', secondSource]]),
      ),
    ).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_BUSY' });
    controller.abort();
    await expect(firstRender).rejects.toMatchObject({ code: 'MIXDOWN_ABORTED' });
    expect(client.isRunning()).toBe(false);
  });

  it('shares one busy lock between Raw Mixdown and Stem Print operations', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const source = createConstantPcm16Wave({ frameCount: 500_000, sample: 1_000 });
    const controller = new AbortController();
    const rendering = client.render(
      createPlan(source, 500_000),
      new Map([['source-1', source]]),
      { signal: controller.signal },
    );

    await expect(client.renderStemPrint(
      createStemPlan(source, 500_000),
      new Map([['source-1', source]]),
    )).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_BUSY' });
    controller.abort();
    await expect(rendering).rejects.toMatchObject({ code: 'MIXDOWN_ABORTED' });
  });

  it('terminates a Worker that exceeds its bounded render timeout', async () => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 1 });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });

    await expect(
      client.render(
        createPlan(source, 1),
        new Map([['source-1', source]]),
      ),
    ).rejects.toMatchObject({ code: 'MIXDOWN_WORKER_TIMEOUT' });
    expect(client.isRunning()).toBe(false);
  });

  it('rejects invalid source Maps before creating a Worker', async () => {
    const client = new ProjectMixdownWorkerClient();

    await expect(client.render({}, new Map())).rejects.toBeInstanceOf(
      ProjectMixdownWorkerError,
    );
    await expect(client.render({}, new Map())).rejects.toMatchObject({
      code: 'MIXDOWN_WORKER_REQUEST_INVALID',
    });
    expect(client.isRunning()).toBe(false);
  });

  it.each([
    ['Raw Mixdown', (client, plan, sources) => client.render(plan, sources)],
    ['Stem Print', (client, plan, sources) => client.renderStemPrint(plan, sources)],
  ])('copies caller-owned source bytes before %s transfer', async (
    label,
    render,
  ) => {
    const client = new ProjectMixdownWorkerClient({ renderTimeoutMs: 5_000 });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 1_234 });
    const callerBytes = new Uint8Array(source);
    const before = Uint8Array.from(callerBytes);
    const plan = label === 'Stem Print'
      ? createStemPlan(callerBytes, 1)
      : createPlan(callerBytes, 1);

    await render(client, plan, new Map([['source-1', callerBytes]]));

    expect(callerBytes.byteLength).toBe(before.byteLength);
    expect(callerBytes).toEqual(before);
  });

  it.each([
    ['failure', FAILING_WORKER_URL, 'MIXDOWN_WORKER_FAILED'],
    ['early exit', EXITING_WORKER_URL, 'MIXDOWN_WORKER_EXITED'],
  ])('bounds a Worker %s and releases the client', async (
    _label,
    workerUrl,
    code,
  ) => {
    const client = new ProjectMixdownWorkerClient({
      renderTimeoutMs: 5_000,
      workerUrl,
    });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });

    await expect(client.renderStemPrint(
      createStemPlan(source, 1),
      new Map([['source-1', source]]),
    )).rejects.toMatchObject({ code });
    expect(client.isRunning()).toBe(false);
  });

  it('sanitizes a Worker failure message at the client boundary', async () => {
    const client = new ProjectMixdownWorkerClient({
      renderTimeoutMs: 5_000,
      workerUrl: FAILING_WORKER_URL,
    });
    const source = createConstantPcm16Wave({ frameCount: 1, sample: 0 });

    try {
      await client.renderStemPrint(
        createStemPlan(source, 1),
        new Map([['source-1', source]]),
      );
      throw new Error('Expected Stem Print Worker failure.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MIXDOWN_WORKER_FAILED',
        message: 'Project Mixdown Worker failed.',
      });
      expect(error.message).not.toContain('Injected Worker failure detail');
    }
  });
});

function createPlan(source, frameCount) {
  const durationSeconds = frameCount / SAMPLE_RATE;
  const endTick = secondsToTestTimelineTicks(durationSeconds);
  return createTestRawMixdownPlanV3({
    bpm: TEST_BPM,
    durationSeconds,
    endTick,
    sources: [
      {
        kind: 'generated',
        name: 'source-1.wav',
        relativePath: 'renders/stable-audio-3/source-1.wav',
        sizeBytes: source.byteLength,
        sourceId: 'source-1',
      },
    ],
    tracks: [
      {
        events: [
          {
            clipId: 'clip-1',
            clipName: 'clip-1',
            durationSeconds,
            sourceId: 'source-1',
            sourceStartSeconds: 0,
            startOffsetSeconds: 0,
            timelineEndTick: endTick,
            timelineStartTick: 0,
          },
        ],
        gainDb: 0,
        pan: 0,
        trackId: 'track-1',
      },
    ],
  });
}

function createStemPlan(source, frameCount, groupTrackId) {
  const rawPlan = createPlan(source, frameCount);
  const track = {
    ...rawPlan.tracks[0],
    ...(groupTrackId ? { groupTrackId } : {}),
  };

  return createTestStemPrintPlanV1({
    bpm: rawPlan.bpm,
    durationSeconds: rawPlan.durationSeconds,
    endTick: rawPlan.endTick,
    selectedTargets: groupTrackId
      ? [{
          groupTrackId,
          kind: 'group',
          resolvedTrackId: track.trackId,
        }]
      : [{
          kind: 'channel',
          resolvedTrackId: track.trackId,
          trackId: track.trackId,
        }],
    sources: rawPlan.sources,
    tracks: [track],
  });
}

function secondsToTestTimelineTicks(seconds) {
  return Math.max(
    1,
    Math.round(
      (seconds * TEST_BPM * TEST_TIMELINE_TICKS_PER_BEAT) / 60,
    ),
  );
}

function createConstantPcm16Wave({ frameCount, sample }) {
  const dataByteLength = frameCount * 2;
  const bytes = Buffer.alloc(44 + dataByteLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataByteLength, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    bytes.writeInt16LE(sample, 44 + frame * 2);
  }

  return bytes;
}

function readOutputFrame(bytes, frame) {
  return [
    bytes.readInt16LE(44 + frame * 4),
    bytes.readInt16LE(46 + frame * 4),
  ];
}
