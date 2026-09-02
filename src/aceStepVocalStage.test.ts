import { describe, expect, it } from 'vitest';

import type { AceStepJobRequest } from './aceStepJobContract';
import {
  resolveAceStepTextToAudioGuide,
  resolveAceStepVocalTarget,
  runAceStepTextToAudioVocalStage,
  runAceStepVocalStage,
  type AceStepVocalStageClient,
} from './aceStepVocalStage';
import type {
  LocalEngineAceStepLyricsSaveResult,
  LocalEngineAceStepLyricsSnapshot,
  LocalEngineGpuJobRecord,
  LocalEngineGpuJobRemovalResult,
  LocalEngineGpuJobResult,
  LocalEngineGpuJobSnapshotResult,
} from './localEngineClient';
import { sampleProject } from './sampleProject';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  MidiArtifact,
  MidiClipTake,
  ProjectState,
} from './types';

const CREATED_AT = '2026-08-12T13:00:00.000Z';
const FINISHED_AT = '2026-08-12T13:00:10.000Z';
const LYRICS_ARTIFACT_ID =
  'artifact-12345678-1234-4abc-8def-1234567890ab';

describe('runAceStepVocalStage', () => {
  it('resolves the selected Vocal Clip back through Guide Audio to corrected MIDI', () => {
    expect(resolveAceStepVocalTarget(createProject(), 'clip-vocal-a')).toEqual({
      canResolve: true,
      guideClipId: 'clip-guide-a',
      guideClipName: 'Instrument Guide',
      guideDurationSeconds: 10,
      midiClipId: 'clip-midi-a',
      midiClipName: 'Corrected MIDI',
      targetClipId: 'clip-vocal-a',
      targetClipName: 'Vocal',
    });
  });

  it('saves Lyrics, observes one immutable Job, and registers an inactive Vocal Take', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient();
    const progress: string[] = [];

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 2,
      onProgress: (event) => progress.push(event.state),
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(client.savedLyrics).toEqual(['Stay with me\nThrough the night']);
    expect(client.enqueuedRequests).toEqual([result.request]);
    expect(client.pollCount).toBe(1);
    expect(progress).toEqual([
      'SAVING_LYRICS',
      'ENQUEUEING',
      'QUEUED',
      'COMPLETED',
    ]);
    expect(result.request.inputArtifacts).toEqual([
      {
        artifactId: 'artifact-guide-a',
        kind: 'audio',
        relativePath: 'renders/instruments/artifact-guide-a.wav',
        sizeBytes: 1_920_044,
      },
      {
        artifactId: LYRICS_ARTIFACT_ID,
        kind: 'lyrics',
        relativePath: `renders/ace-step/lyrics/${LYRICS_ARTIFACT_ID}.txt`,
      },
    ]);
    expect(result.artifact).toMatchObject({
      artifactId: 'artifact-ace-vocal-a',
      destination: 'ace-step',
      sourceJobId: 'job-ace-stage-a',
    });
    expect(result.clipTake).toMatchObject({
      artifactId: 'artifact-ace-vocal-a',
      clipTakeId: 'clip-take-artifact-ace-vocal-a',
      label: 'Lead Vocal Take',
      sourceJobId: 'job-ace-stage-a',
    });

    const target = findClip(result.project, 'clip-vocal-a');

    expect(target.activeClipTakeId).toBe('clip-take-existing-vocal');
    expect(target.clipTakes).toHaveLength(2);
    expect(target.sourceFile?.sourceId).toBe('artifact-existing-vocal');
    expect(result.project.artifacts).toContainEqual(result.artifact);
    expect(result.project).not.toBe(project);
  });

  it('rejects an invalid Clip role chain before retaining Lyrics', async () => {
    const project = createProject();
    findClip(project, 'clip-vocal-a').sourceClipId = 'clip-other';
    const client = new FakeAceStepStageClient();

    const result = await runAceStepVocalStage(client, createInput(project));

    expect(result).toMatchObject({
      ok: false,
      project,
      reason: 'input-invalid',
      status: 'FAILED',
    });
    expect(client.savedLyrics).toEqual([]);
    expect(client.enqueuedRequests).toEqual([]);
  });

  it('requires an existing active Vocal Take so registration stays inactive', async () => {
    const project = createProject();
    const target = findClip(project, 'clip-vocal-a');
    target.activeClipTakeId = undefined;
    target.clipTakes = undefined;
    const client = new FakeAceStepStageClient();

    const result = await runAceStepVocalStage(client, createInput(project));

    expect(result).toMatchObject({
      ok: false,
      project,
      reason: 'input-invalid',
      status: 'FAILED',
    });
    expect(client.savedLyrics).toEqual([]);
    expect(client.enqueuedRequests).toEqual([]);
  });

  it('fails closed when the immutable Lyrics snapshot cannot be saved', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      lyricsResult: {
        message: 'Project Root is not configured.',
        ok: false,
        reason: 'http-error',
      },
    });

    const result = await runAceStepVocalStage(client, createInput(project));

    expect(result).toMatchObject({
      message: 'Project Root is not configured.',
      ok: false,
      project,
      reason: 'lyrics-save-failed',
      status: 'FAILED',
    });
    expect(client.enqueuedRequests).toEqual([]);
  });

  it('rejects Provider identity or request drift while polling', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      pollJob: (request) => ({
        ...createJob(request, 'PROCESSING'),
        request: {
          ...request,
          parameters: { ...request.parameters, caption: 'Changed caption' },
        },
      }),
    });

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 2,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      project,
      reason: 'job-contract-drift',
      status: 'FAILED',
    });
    expect(result.ok || result.lyricsSnapshot).toEqual(createLyricsSnapshot());
    expect(project.artifacts).toHaveLength(3);
  });

  it('reports terminal Job failure without registering partial output', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      pollJob: (request) => ({
        ...createJob(request, 'FAILED'),
        error: { code: 'provider-failed', message: 'ACE worker failed.' },
        finishedAt: FINISHED_AT,
      }),
    });

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 2,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      message: 'ACE worker failed.',
      ok: false,
      project,
      reason: 'job-failed',
      status: 'FAILED',
    });
    expect(result.ok || result.lyricsSnapshot).toEqual(createLyricsSnapshot());
    expect(findClip(project, 'clip-vocal-a').clipTakes).toHaveLength(1);
  });

  it('returns a resumable pending observation when the bounded poll limit is reached', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      pollJob: (request) => createJob(request, 'PROCESSING'),
    });
    const waits: number[] = [];

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 1,
      pollIntervalMs: 25,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      project,
      reason: 'poll-limit-reached',
      status: 'PENDING',
    });
    expect(result.ok || result.job?.state).toBe('PROCESSING');
    expect(result.ok || result.request).toEqual(client.enqueuedRequests[0]);
    expect(waits).toEqual([25]);
    expect(client.pollCount).toBe(1);
  });

  it('removes only the exact queued Job and settles CANCELED without Project mutation', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient();
    const controller = new AbortController();

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 2,
      onProgress: ({ state }) => {
        if (state === 'QUEUED') controller.abort();
      },
      pollIntervalMs: 0,
      signal: controller.signal,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      project,
      reason: 'queued-job-removed',
      status: 'CANCELED',
    });
    expect(client.removeCalls).toEqual(['job-ace-stage-a']);
    expect(client.cancelCalls).toEqual([]);
    expect(client.pollCount).toBe(0);
    expect(project.artifacts).toHaveLength(3);
    expect(findClip(project, 'clip-vocal-a').clipTakes).toHaveLength(1);
  });

  it('requests exact active cancellation once and waits for authoritative CANCELED', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      pollJobs: [
        (request) => createJob(request, 'PROCESSING'),
        (request) => createJob(request, 'CANCELED'),
      ],
    });
    const controller = new AbortController();
    const progress: string[] = [];

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 3,
      onProgress: ({ state }) => {
        progress.push(state);
        if (state === 'PROCESSING') controller.abort();
      },
      pollIntervalMs: 0,
      signal: controller.signal,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({
      job: { state: 'CANCELED' },
      ok: false,
      project,
      reason: 'job-canceled',
      status: 'CANCELED',
    });
    expect(client.cancelCalls).toEqual(['job-ace-stage-a']);
    expect(client.removeCalls).toEqual([]);
    expect(progress).toContain('CANCEL_REQUESTED');
    expect(findClip(project, 'clip-vocal-a').clipTakes).toHaveLength(1);
  });

  it('does not duplicate cancellation for an already CANCEL_REQUESTED Job', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      enqueueState: 'CANCEL_REQUESTED',
      pollJob: (request) => createJob(request, 'CANCELED'),
    });
    const controller = new AbortController();

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 2,
      onProgress: ({ state }) => {
        if (state === 'CANCEL_REQUESTED') controller.abort();
      },
      pollIntervalMs: 0,
      signal: controller.signal,
      wait: async () => undefined,
    });

    expect(result).toMatchObject({ reason: 'job-canceled', status: 'CANCELED' });
    expect(client.cancelCalls).toEqual([]);
    expect(client.removeCalls).toEqual([]);
  });

  it('lets SAVING completion win and does not issue a late cancellation', async () => {
    const project = createProject();
    const client = new FakeAceStepStageClient({
      pollJobs: [
        (request) => createJob(request, 'SAVING'),
        (request) => createJob(request, 'COMPLETED'),
      ],
    });
    const controller = new AbortController();

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 3,
      onProgress: ({ state }) => {
        if (state === 'SAVING') controller.abort();
      },
      pollIntervalMs: 0,
      signal: controller.signal,
      wait: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(client.cancelCalls).toEqual([]);
    expect(client.removeCalls).toEqual([]);
  });

  it('fails stale Job ownership before any cancellation side effect', async () => {
    const project = createProject();
    const controller = new AbortController();
    const client = new FakeAceStepStageClient({
      pollJob: (request) => ({
        ...createJob(request, 'PROCESSING'),
        request: {
          ...request,
          parameters: { ...request.parameters, seed: request.parameters.seed + 1 },
        },
      }),
    });

    const result = await runAceStepVocalStage(client, createInput(project), {
      maxPollAttempts: 2,
      pollIntervalMs: 0,
      signal: controller.signal,
      wait: async () => {
        controller.abort();
      },
    });

    expect(result).toMatchObject({
      reason: 'job-contract-drift',
      status: 'FAILED',
    });
    expect(client.cancelCalls).toEqual([]);
    expect(client.removeCalls).toEqual([]);
    expect(project.artifacts).toHaveLength(3);
  });

  it('creates one aligned Vocal Track only after a finalized T2A Guide succeeds', async () => {
    const project = createTextToAudioProject();
    const client = new FakeAceStepStageClient();

    expect(resolveAceStepTextToAudioGuide(project, 'clip-sa3-t2a-a')).toEqual({
      canResolve: true,
      guideArtifactId: 'artifact-sa3-t2a-a',
      guideClipId: 'clip-sa3-t2a-a',
      guideClipTakeId: 'clip-take-sa3-t2a-a',
      guideDurationSeconds: 10,
      guideLengthTicks: 7_680,
      guideStartTick: 960,
    });

    const result = await runAceStepTextToAudioVocalStage(
      client,
      {
        caption: 'Warm intimate lead vocal following the backing',
        guideClipId: 'clip-sa3-t2a-a',
        lyrics: 'Stay with me\nThrough the night',
        mode: 'stable-audio-3-text-to-audio',
        project,
        seed: 7,
        target: {
          clipId: 'clip-vocal-new',
          clipName: 'Vocals',
          createdAt: CREATED_AT,
          trackId: 'track-vocal-new',
          trackName: 'Vocals',
        },
        vocalLanguage: 'en',
      },
      { maxPollAttempts: 2, pollIntervalMs: 0, wait: async () => undefined },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.request.guideSource).toMatchObject({
      artifactId: 'artifact-sa3-t2a-a',
      clipTakeId: 'clip-take-sa3-t2a-a',
      kind: 'stable-audio-3-text-to-audio',
      taskId: 'text-to-audio',
    });
    expect(result.request.lineage.parentClipTakeIds).toEqual([
      'clip-take-sa3-t2a-a',
    ]);
    expect(findClip(result.project, 'clip-vocal-new')).toMatchObject({
      activeClipTakeId: result.clipTake.clipTakeId,
      lengthTicks: 7_680,
      sourceClipId: 'clip-sa3-t2a-a',
      startTick: 960,
      type: 'vocal-audio',
    });
    expect(result.project.tracks.find(({ id }) => id === 'track-vocal-new')).toMatchObject({
      name: 'Vocals',
      type: 'vocal',
    });
    expect(project.tracks).toHaveLength(1);
  });

  it('creates no Vocal placeholder when a T2A Guide Job fails', async () => {
    const project = createTextToAudioProject();
    const client = new FakeAceStepStageClient({
      pollJob: (request) => ({
        ...createJob(request, 'FAILED'),
        error: { code: 'provider-failed', message: 'ACE worker failed.' },
      }),
    });
    const result = await runAceStepTextToAudioVocalStage(
      client,
      {
        caption: 'Warm intimate lead vocal following the backing',
        guideClipId: 'clip-sa3-t2a-a',
        lyrics: 'Stay with me\nThrough the night',
        mode: 'stable-audio-3-text-to-audio',
        project,
        seed: 7,
        target: {
          clipId: 'clip-vocal-new',
          clipName: 'Vocals',
          createdAt: CREATED_AT,
          trackId: 'track-vocal-new',
          trackName: 'Vocals',
        },
        vocalLanguage: 'en',
      },
      { maxPollAttempts: 2, pollIntervalMs: 0, wait: async () => undefined },
    );

    expect(result).toMatchObject({ ok: false, project, status: 'FAILED' });
    expect(project.tracks).toHaveLength(1);
    expect(project.tracks.flatMap(({ clips }) => clips)).not.toContainEqual(
      expect.objectContaining({ id: 'clip-vocal-new' }),
    );
  });

  it('rejects a colliding T2A Active Take before Lyrics save or Queue enqueue', async () => {
    const project = createTextToAudioProject();
    const guideClip = project.tracks[0]?.clips[0];
    const guideTake = guideClip?.clipTakes?.[0];

    if (!guideClip || !guideTake) {
      throw new Error('T2A fixture requires one Guide Active Take.');
    }

    guideClip.clipTakes = [guideTake, { ...guideTake }];
    const client = new FakeAceStepStageClient();
    const result = await runAceStepTextToAudioVocalStage(client, {
      caption: 'Warm intimate lead vocal following the backing',
      guideClipId: guideClip.id,
      lyrics: 'Stay with me\nThrough the night',
      mode: 'stable-audio-3-text-to-audio',
      project,
      seed: 7,
      target: {
        clipId: 'clip-vocal-new',
        clipName: 'Vocals',
        createdAt: CREATED_AT,
        trackId: 'track-vocal-new',
        trackName: 'Vocals',
      },
      vocalLanguage: 'en',
    });

    expect(result).toMatchObject({
      ok: false,
      project,
      reason: 'input-invalid',
      status: 'FAILED',
    });
    expect(client.savedLyrics).toEqual([]);
    expect(client.enqueuedRequests).toEqual([]);
    expect(project.tracks).toHaveLength(1);
  });
});

type FakeClientOptions = Readonly<{
  cancelState?: LocalEngineGpuJobRecord['state'];
  enqueueState?: LocalEngineGpuJobRecord['state'];
  lyricsResult?: LocalEngineAceStepLyricsSaveResult;
  pollJob?: (request: AceStepJobRequest) => LocalEngineGpuJobRecord;
  pollJobs?: readonly ((request: AceStepJobRequest) => LocalEngineGpuJobRecord)[];
}>;

class FakeAceStepStageClient implements AceStepVocalStageClient {
  readonly cancelCalls: string[] = [];
  readonly enqueuedRequests: AceStepJobRequest[] = [];
  readonly removeCalls: string[] = [];
  readonly savedLyrics: string[] = [];
  pollCount = 0;

  readonly #lyricsResult: LocalEngineAceStepLyricsSaveResult;
  readonly #cancelState: LocalEngineGpuJobRecord['state'];
  readonly #enqueueState: LocalEngineGpuJobRecord['state'];
  readonly #pollJob: (request: AceStepJobRequest) => LocalEngineGpuJobRecord;
  readonly #pollJobs?: readonly ((request: AceStepJobRequest) => LocalEngineGpuJobRecord)[];

  constructor(options: FakeClientOptions = {}) {
    this.#cancelState = options.cancelState ?? 'CANCEL_REQUESTED';
    this.#enqueueState = options.enqueueState ?? 'QUEUED';
    this.#lyricsResult = options.lyricsResult ?? {
      lyricsSnapshot: createLyricsSnapshot(),
      ok: true,
    };
    this.#pollJob =
      options.pollJob ?? ((request) => createJob(request, 'COMPLETED'));
    this.#pollJobs = options.pollJobs;
  }

  async saveAceStepLyrics(
    lyrics: string,
  ): Promise<LocalEngineAceStepLyricsSaveResult> {
    this.savedLyrics.push(lyrics);
    return this.#lyricsResult;
  }

  async enqueueAceStepJob(
    request: AceStepJobRequest,
  ): Promise<LocalEngineGpuJobResult> {
    this.enqueuedRequests.push(request);
    return { job: createJob(request, this.#enqueueState), ok: true };
  }

  async cancelJob(jobId: string): Promise<LocalEngineGpuJobResult> {
    this.cancelCalls.push(jobId);
    const request = this.enqueuedRequests[0];

    if (!request) {
      throw new Error('Test client canceled before enqueue.');
    }

    return { job: createJob(request, this.#cancelState), ok: true };
  }

  async getJobs(): Promise<LocalEngineGpuJobSnapshotResult> {
    this.pollCount += 1;
    const request = this.enqueuedRequests[0];

    if (!request) {
      throw new Error('Test client was polled before enqueue.');
    }

    const pollJob = this.#pollJobs?.[
      Math.min(this.pollCount - 1, this.#pollJobs.length - 1)
    ];

    return {
      ok: true,
      snapshot: {
        acceptingJobs: true,
        jobs: [(pollJob ?? this.#pollJob)(request)],
      },
    };
  }

  async removeQueuedJob(
    jobId: string,
  ): Promise<LocalEngineGpuJobRemovalResult> {
    this.removeCalls.push(jobId);
    const request = this.enqueuedRequests[0];

    if (!request) {
      throw new Error('Test client removed before enqueue.');
    }

    return { ok: true, removedJob: createJob(request, 'QUEUED') };
  }
}

function createInput(project: ProjectState) {
  return {
    caption: 'Warm intimate lead vocal following the corrected melody',
    guideClipId: 'clip-guide-a',
    label: 'Lead Vocal Take',
    lyrics: 'Stay with me\nThrough the night',
    midiClipId: 'clip-midi-a',
    project,
    seed: 1_370_421,
    targetClipId: 'clip-vocal-a',
    vocalLanguage: 'en',
  } as const;
}

function createProject(): ProjectState {
  const project = structuredClone(sampleProject);
  const track = project.tracks[0];

  if (!track) {
    throw new Error('Sample Project requires one Track for this fixture.');
  }

  const midiArtifact = createMidiArtifact();
  const guideArtifact = createGuideArtifact();
  const existingVocalArtifact = createExistingVocalArtifact();
  const midiClipTake = createMidiClipTake();
  const guideClipTake: GeneratedAudioClipTake = {
    artifactId: guideArtifact.artifactId,
    clipTakeId: 'clip-take-guide-a',
    createdAt: guideArtifact.createdAt,
    label: 'Instrument Guide',
    mediaType: 'audio',
    sourceJobId: guideArtifact.sourceJobId,
    sourceType: 'job',
  };
  const existingVocalTake: GeneratedAudioClipTake = {
    artifactId: existingVocalArtifact.artifactId,
    clipTakeId: 'clip-take-existing-vocal',
    createdAt: existingVocalArtifact.createdAt,
    label: 'Existing Vocal',
    mediaType: 'audio',
    sourceJobId: existingVocalArtifact.sourceJobId,
    sourceType: 'job',
  };
  const baseClip = track.clips[0];

  if (!baseClip) {
    throw new Error('Sample Project requires one Clip for this fixture.');
  }

  return {
    ...project,
    artifacts: [midiArtifact, guideArtifact, existingVocalArtifact],
    tracks: [
      {
        ...track,
        clips: [
          createClip(baseClip, {
            activeClipTakeId: midiClipTake.clipTakeId,
            clipTakes: [midiClipTake],
            id: 'clip-midi-a',
            name: 'Corrected MIDI',
            type: 'edited-midi',
          }),
          createClip(baseClip, {
            activeClipTakeId: guideClipTake.clipTakeId,
            clipTakes: [guideClipTake],
            id: 'clip-guide-a',
            name: 'Instrument Guide',
            sourceClipId: 'clip-midi-a',
            type: 'instrument-audio',
          }),
          createClip(baseClip, {
            activeClipTakeId: existingVocalTake.clipTakeId,
            clipTakes: [existingVocalTake],
            id: 'clip-vocal-a',
            name: 'Vocal',
            sourceClipId: 'clip-guide-a',
            sourceFile: {
              durationSeconds: 8,
              mimeType: 'audio/wav',
              name: existingVocalArtifact.file.name,
              relativePath: existingVocalArtifact.file.relativePath,
              sizeBytes: existingVocalArtifact.file.sizeBytes,
              sourceId: existingVocalArtifact.artifactId,
              status: 'unresolved',
            },
            type: 'vocal-audio',
          }),
        ],
        id: 'track-ace-stage',
        name: 'ACE-Step Stage',
      },
    ],
  };
}

function createTextToAudioProject(): ProjectState {
  const artifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-sa3-t2a-a',
    audio: { channels: 2, durationSeconds: 10, mimeType: 'audio/wav' },
    createdAt: '2026-08-12T12:30:00.000Z',
    destination: 'stable-audio-3',
    file: {
      extension: '.wav',
      name: 'artifact-sa3-t2a-a.wav',
      relativePath: 'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'stable-audio-3-medium',
      modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      parameters: {
        channels: 2,
        durationSeconds: 10,
        prompt: 'Focused instrumental backing',
        sampleRate: 44_100,
        seed: 7,
      },
      providerId: 'local-stable-audio-3',
      seed: 7,
      taskId: 'text-to-audio',
    },
    sourceJobId: 'job-sa3-t2a-a',
  };
  const clipTake: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-sa3-t2a-a',
    createdAt: artifact.createdAt,
    label: 'SA3 T2A Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  const project = structuredClone(sampleProject);
  const baseClip = project.tracks[0]?.clips[0];

  if (!baseClip) throw new Error('Sample Project fixture requires one Clip.');

  return {
    ...project,
    artifacts: [artifact],
    selection: { items: [] },
    tracks: [
      {
        clips: [
          createClip(baseClip, {
            activeClipTakeId: clipTake.clipTakeId,
            clipTakes: [clipTake],
            id: 'clip-sa3-t2a-a',
            lengthTicks: 7_680,
            name: 'Generated Audio',
            sourceFile: {
              durationSeconds: 10,
              mimeType: 'audio/wav',
              name: artifact.file.name,
              relativePath: artifact.file.relativePath,
              sizeBytes: artifact.file.sizeBytes,
              sourceId: artifact.artifactId,
              status: 'available',
            },
            startTick: 960,
            type: 'ai-fill-audio',
          }),
        ],
        id: 'track-sa3-t2a-a',
        level: 0,
        name: 'Generated Audio',
        type: 'generated_audio',
      },
    ],
  };
}

function createClip(base: Clip, overrides: Partial<Clip>): Clip {
  return {
    ...base,
    activeClipTakeId: undefined,
    clipTakes: undefined,
    sourceClipId: undefined,
    sourceFile: undefined,
    ...overrides,
  };
}

function createLyricsSnapshot(): LocalEngineAceStepLyricsSnapshot {
  return {
    artifactId: LYRICS_ARTIFACT_ID,
    createdAt: CREATED_AT,
    destination: 'ace-step-lyrics',
    file: {
      extension: '.txt',
      name: `${LYRICS_ARTIFACT_ID}.txt`,
      relativePath: `renders/ace-step/lyrics/${LYRICS_ARTIFACT_ID}.txt`,
      sizeBytes: 31,
    },
    kind: 'lyrics',
    sha256: 'a'.repeat(64),
    status: 'FINALIZED',
  };
}

function createMidiArtifact(): MidiArtifact {
  return {
    artifactId: 'artifact-midi-a',
    contentHash: 'midi-content-hash-a',
    createdAt: '2026-08-12T12:00:00.000Z',
    editProvenance: {
      editorId: 'humstudio-midi-editor',
      editorVersion: '1',
      taskId: 'midi-edit',
    },
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-midi-source'],
      parentClipTakeIds: ['clip-take-midi-source'],
    },
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
    revision: 1,
    sourceEditId: 'midi-edit-a',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}

function createMidiClipTake(): MidiClipTake {
  return {
    artifactId: 'artifact-midi-a',
    clipTakeId: 'clip-take-midi-a',
    contentHash: 'midi-content-hash-a',
    createdAt: '2026-08-12T12:00:00.000Z',
    label: 'Corrected MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceEditId: 'midi-edit-a',
    sourceType: 'edit',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}

function createGuideArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-guide-a',
    audio: {
      channels: 2,
      durationSeconds: 10,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-12T12:30:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-guide-a.wav',
      relativePath: 'renders/instruments/artifact-guide-a.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    provenance: {
      modelId: 'soundfont-renderer',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-guide-a',
  };
}

function createExistingVocalArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-existing-vocal',
    audio: { channels: 2, durationSeconds: 8, mimeType: 'audio/wav' },
    createdAt: '2026-08-12T12:40:00.000Z',
    destination: 'ace-step',
    file: {
      extension: '.wav',
      name: 'artifact-existing-vocal.wav',
      relativePath: 'renders/ace-step/artifact-existing-vocal.wav',
      sizeBytes: 3_072_088,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-guide-old', 'artifact-lyrics-old'],
      parentClipTakeIds: ['clip-take-midi-old'],
    },
    provenance: {
      modelId: 'acestep-v15-base',
      modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
      parameters: { seed: 7 },
      providerId: 'local-ace-step',
      seed: 7,
      taskId: 'guide-audio-to-vocals',
    },
    sourceJobId: 'job-existing-vocal',
  };
}

function createJob(
  request: AceStepJobRequest,
  state: LocalEngineGpuJobRecord['state'],
): LocalEngineGpuJobRecord {
  const terminal =
    state === 'COMPLETED' ||
    state === 'FAILED' ||
    state === 'CANCELED' ||
    state === 'INTERRUPTED';

  return {
    attempt: 1,
    createdAt: CREATED_AT,
    ...(terminal ? { finishedAt: FINISHED_AT } : {}),
    history: [
      { attempt: 1, at: CREATED_AT, state: 'QUEUED' },
      ...(state === 'QUEUED'
        ? []
        : [{ attempt: 1, at: FINISHED_AT, state }] as const),
    ],
    jobId: 'job-ace-stage-a',
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    ...(state === 'COMPLETED'
      ? {
          result: {
            artifact: {
              artifactId: 'artifact-ace-vocal-a',
              createdAt: FINISHED_AT,
              destination: 'ace-step',
              file: {
                extension: '.wav',
                name: 'artifact-ace-vocal-a.wav',
                relativePath: 'renders/ace-step/artifact-ace-vocal-a.wav',
                sizeBytes: 3_840_088,
              },
              kind: 'audio',
              lineage: request.lineage,
              provenance: {
                modelId: request.modelId,
                modelRevision: request.modelRevision,
                parameters: request.parameters,
                providerId: request.providerId,
                seed: request.parameters.seed,
                taskId: request.taskId,
              },
            },
            generation: {
              bytesWritten: 3_840_088,
              channels: 2,
              durationSeconds: 10,
              mimeType: 'audio/wav',
              providerCompletedAt: FINISHED_AT,
            },
          },
        }
      : {}),
    ...(state === 'QUEUED' ? {} : { startedAt: CREATED_AT }),
    state,
    taskId: request.taskId,
    updatedAt: terminal ? FINISHED_AT : CREATED_AT,
  };
}

function findClip(project: ProjectState, clipId: string): Clip {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Test Clip not found: ${clipId}.`);
  }

  return clip;
}
