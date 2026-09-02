import { describe, expect, it } from 'vitest';

import { createInstrumentRenderJobRequest } from './instrumentRenderContract';
import {
  createInstrumentRenderRegistration,
  doesInstrumentRenderJobMatchRequest,
} from './instrumentRenderRegistration';
import { createMidiContentHash } from './midiContentHash';
import { createAudioClipRightTrimUpdate } from './audioClipTrim';
import { isSourceBackedAudioClip } from './audioClipSource';
import { secondsToTimelineTicks } from './audioClipTiming';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import type {
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('createInstrumentRenderRegistration', () => {
  it('initializes a new output from the full rendered duration without changing its MIDI source', () => {
    const project = createProject();
    const before = structuredClone(project);
    const durationSeconds = 72_013 / 48_000;
    const result = createInstrumentRenderRegistration(project, createCompletedJob({ durationSeconds }), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    });
    if (!result.canRegister) throw new Error(result.message);
    const clip = findClip(result.project, 'clip-instrument');
    expect(clip.lengthTicks).toBe(secondsToTimelineTicks(durationSeconds, project.bpm));
    expect(clip.audioTiming).toEqual({
      timeBase: 'absolute-seconds', sourceStartSeconds: 0, sourceEndSeconds: durationSeconds,
    });
    expect(isSourceBackedAudioClip(clip)).toBe(true);
    expect(findClip(result.project, 'clip-midi')).toEqual(findClip(before, 'clip-midi'));
    expect(project).toEqual(before);

    const shortened = createAudioClipRightTrimUpdate(result.project.tracks, clip.id, 960, project.totalTicks, project.bpm);
    if (!shortened.canTrim) throw new Error(shortened.message);
    const restored = createAudioClipRightTrimUpdate(shortened.tracks, clip.id, clip.lengthTicks, project.totalTicks, project.bpm);
    if (!restored.canTrim) throw new Error(restored.message);
    expect(restored.clip.audioTiming.sourceEndSeconds).toBe(durationSeconds);
  });

  it('preserves an explicit trim when registering a Take', () => {
    const project = createProject();
    const target = findClip(project, 'clip-instrument');
    target.audioTiming = { timeBase: 'absolute-seconds', sourceStartSeconds: 0.25, sourceEndSeconds: 0.75 };
    target.lengthTicks = 960;
    const result = createInstrumentRenderRegistration(project, createCompletedJob({ durationSeconds: 2 }), {
      sourceClipId: 'clip-midi', targetClipId: target.id,
    });
    if (!result.canRegister) throw new Error(result.message);
    expect(findClip(result.project, target.id)).toMatchObject({ lengthTicks: 960, audioTiming: target.audioTiming });
  });

  it('does not migrate the timing of an already registered legacy Clip', () => {
    const first = createInstrumentRenderRegistration(createProject(), createCompletedJob(), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    });
    if (!first.canRegister) throw new Error(first.message);
    const legacy = structuredClone(first.project);
    delete findClip(legacy, 'clip-instrument').audioTiming;
    findClip(legacy, 'clip-instrument').lengthTicks = 960;
    const before = structuredClone(legacy);
    const repeated = createInstrumentRenderRegistration(legacy, createCompletedJob(), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    });
    expect(repeated).toMatchObject({ canRegister: true, status: 'ALREADY_REGISTERED', project: before });
    if (!repeated.canRegister) throw new Error(repeated.message);
    expect(repeated.project).toBe(legacy);
  });

  it('rejects a new tail outside Timeline Length or newly overlapping a neighbor without changing the Project', () => {
    for (const boundary of ['timeline', 'neighbor']) {
      const project = createProject();
      if (boundary === 'timeline') project.totalTicks = 1920;
      else project.tracks[2].clips.push({ ...findClip(project, 'clip-instrument'), id: 'neighbor', startTick: 2500, lengthTicks: 480 });
      const before = structuredClone(project);
      expect(createInstrumentRenderRegistration(project, createCompletedJob({ durationSeconds: 2 }), {
        sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
      })).toMatchObject({ canRegister: false, reason: 'target-timing-invalid' });
      expect(project).toEqual(before);
    }
  });

  it('rejects an active Take that cannot contain retained explicit timing', () => {
    const project = createProject();
    findClip(project, 'clip-instrument').audioTiming = {
      timeBase: 'absolute-seconds', sourceStartSeconds: 0.5, sourceEndSeconds: 2,
    };
    expect(createInstrumentRenderRegistration(project, createCompletedJob(), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    })).toMatchObject({ canRegister: false, reason: 'target-timing-invalid' });
  });

  it('preserves a retained trim across active and inactive subsequent Takes', () => {
    const first = createInstrumentRenderRegistration(createProject(), createCompletedJob({ durationSeconds: 2 }), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    });
    if (!first.canRegister) throw new Error(first.message);
    const trimmedProject = structuredClone(first.project);
    const target = findClip(trimmedProject, 'clip-instrument');
    target.audioTiming = {
      timeBase: 'absolute-seconds', sourceStartSeconds: 0.25, sourceEndSeconds: 0.75,
    };
    target.lengthTicks = 960;
    const second = createInstrumentRenderRegistration(trimmedProject, createCompletedJob({ suffix: '-second' }), {
      sourceClipId: 'clip-midi', targetClipId: target.id,
    });
    if (!second.canRegister) throw new Error(second.message);
    const active = findClip(second.project, target.id);
    expect(active).toMatchObject({
      activeClipTakeId: second.clipTake.clipTakeId,
      lengthTicks: 960,
      audioTiming: target.audioTiming,
      sourceFile: { durationSeconds: 1, sourceId: second.artifact.artifactId },
    });
    const inactive = createInstrumentRenderRegistration(second.project, createCompletedJob({
      durationSeconds: 0.25, suffix: '-inactive',
    }), { activate: false, sourceClipId: 'clip-midi', targetClipId: target.id });
    if (!inactive.canRegister) throw new Error(inactive.message);
    expect(findClip(inactive.project, target.id)).toMatchObject({
      activeClipTakeId: active.activeClipTakeId,
      lengthTicks: 960,
      audioTiming: active.audioTiming,
      sourceFile: active.sourceFile,
    });
    expect(findClip(inactive.project, target.id).clipTakes).toHaveLength(3);
  });

  it.each(['timeline', 'neighbor'])('rejects a fractional-tick tail past the %s boundary', (boundary) => {
    const project = createProject();
    if (boundary === 'timeline') {
      project.totalTicks = 2880;
    } else {
      project.tracks[2].clips.push({
        ...findClip(project, 'clip-instrument'), id: 'neighbor', startTick: 2880,
      });
    }
    expect(createInstrumentRenderRegistration(project, createCompletedJob({ durationSeconds: 72_001 / 48_000 }), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    })).toMatchObject({ canRegister: false, reason: 'target-timing-invalid' });
  });

  it('does not reinterpret an existing output overlap when adding full-source timing', () => {
    const project = createProject();
    project.tracks[2].clips.push({
      ...findClip(project, 'clip-instrument'), id: 'existing-overlap', startTick: 960,
    });
    expect(createInstrumentRenderRegistration(project, createCompletedJob({ durationSeconds: 2 }), {
      sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
    })).toMatchObject({ canRegister: true, status: 'REGISTERED' });
  });

  it('rejects invalid new Clip placement without throwing or changing the Project', () => {
    for (const timing of [{ startTick: -1 }, { startTick: 0.5 }, { lengthTicks: 0 }]) {
      const project = createProject();
      Object.assign(findClip(project, 'clip-instrument'), timing);
      const before = structuredClone(project);
      expect(createInstrumentRenderRegistration(project, createCompletedJob(), {
        sourceClipId: 'clip-midi', targetClipId: 'clip-instrument',
      })).toMatchObject({ canRegister: false, reason: 'target-timing-invalid' });
      expect(project).toEqual(before);
    }
  });

  it('registers one finalized Instrument Audio Take against the current Active MIDI Take', () => {
    const project = createProject();
    const sourceClip = findClip(project, 'clip-midi');
    const targetClip = findClip(project, 'clip-instrument');
    const registration = createInstrumentRenderRegistration(
      project,
      createCompletedJob(),
      {
        label: 'SoundFont Render 01',
        sourceClipId: sourceClip.id,
        targetClipId: targetClip.id,
      },
    );

    expect(registration).toMatchObject({
      artifact: {
        audio: {
          channels: 2,
          mimeType: 'audio/wav',
        },
        destination: 'instrument',
        kind: 'audio',
        lineage: {
          parentArtifactIds: ['artifact-midi'],
          parentClipTakeIds: ['clip-take-midi'],
        },
        sourceJobId: 'job-instrument-render',
      },
      canRegister: true,
      clipTake: {
        label: 'SoundFont Render 01',
        mediaType: 'audio',
        sourceJobId: 'job-instrument-render',
        sourceType: 'job',
      },
      status: 'REGISTERED',
    });

    if (!registration.canRegister) {
      throw new Error(registration.message);
    }

    const registeredTarget = findClip(
      registration.project,
      'clip-instrument',
    );

    expect(registration.project).not.toBe(project);
    expect(registration.project.artifacts).toHaveLength(3);
    expect(registeredTarget.clipTakes).toEqual([registration.clipTake]);
    expect(registeredTarget.activeClipTakeId).toBe(
      registration.clipTake.clipTakeId,
    );
    expect(targetClip.clipTakes).toBeUndefined();
  });

  it('is idempotent for the same completed Job and target', () => {
    const first = createInstrumentRenderRegistration(
      createProject(),
      createCompletedJob(),
      {
        sourceClipId: 'clip-midi',
        targetClipId: 'clip-instrument',
      },
    );

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    const repeated = createInstrumentRenderRegistration(
      first.project,
      createCompletedJob(),
      {
        label: 'Ignored Repeat Label',
        sourceClipId: 'clip-midi',
        targetClipId: 'clip-instrument',
      },
    );

    expect(repeated).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });

    if (!repeated.canRegister) {
      throw new Error(repeated.message);
    }

    expect(repeated.project).toBe(first.project);
    expect(repeated.artifact).toBe(first.artifact);
    expect(repeated.clipTake).toBe(first.clipTake);
  });

  it('rejects stale Jobs after the Active MIDI Take changes', () => {
    const project = createProject();
    const midiClip = findClip(project, 'clip-midi');
    midiClip.activeClipTakeId = 'clip-take-midi-new';
    midiClip.clipTakes?.push({
      ...createMidiTake(),
      artifactId: 'artifact-midi-new',
      clipTakeId: 'clip-take-midi-new',
      sourceJobId: 'job-hum-to-midi-new',
    });
    project.artifacts?.push({
      ...createMidiArtifact(),
      artifactId: 'artifact-midi-new',
      sourceJobId: 'job-hum-to-midi-new',
    });

    expect(
      createInstrumentRenderRegistration(project, createCompletedJob(), {
        sourceClipId: 'clip-midi',
        targetClipId: 'clip-instrument',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'job-contract-invalid',
    });
  });

  it('rejects a non-Instrument target or a target from another MIDI Clip', () => {
    const wrongType = createProject();
    findClip(wrongType, 'clip-instrument').type = 'arrangement';

    expect(
      createInstrumentRenderRegistration(wrongType, createCompletedJob(), {
        sourceClipId: 'clip-midi',
        targetClipId: 'clip-instrument',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'target-not-instrument-audio',
    });

    const wrongSource = createProject();
    findClip(wrongSource, 'clip-instrument').sourceClipId = 'clip-midi-other';

    expect(
      createInstrumentRenderRegistration(wrongSource, createCompletedJob(), {
        sourceClipId: 'clip-midi',
        targetClipId: 'clip-instrument',
      }),
    ).toMatchObject({
      canRegister: false,
      reason: 'target-source-mismatch',
    });
  });

  it('accepts a connected or built-in SoundFont when the MIDI Clip has no explicit voice', () => {
    const job = createCompletedJob({ withSoundFont: true });
    const registration = createInstrumentRenderRegistration(
      createProject(),
      job,
      {
        sourceClipId: 'clip-midi',
        targetClipId: 'clip-instrument',
      },
    );

    expect(registration).toMatchObject({
      canRegister: true,
      status: 'REGISTERED',
    });
    expect(doesInstrumentRenderJobMatchRequest(job, job.request)).toBe(true);
  });

  it('rejects a completed SoundFont Job after the explicit MIDI Clip voice changes', () => {
    const project = createProject();
    findClip(project, 'clip-midi').soundFont = {
      bank: 0,
      program: 25,
      resource: {
        format: 'sf2',
        library: 'builtin',
        relativePath: 'soundfonts/Mock.sf2',
        resourceId: 'soundfont-0123456789abcdef0123456789abcdef',
      },
    };

    expect(
      createInstrumentRenderRegistration(
        project,
        createCompletedJob({ withSoundFont: true }),
        {
          sourceClipId: 'clip-midi',
          targetClipId: 'clip-instrument',
        },
      ),
    ).toMatchObject({
      canRegister: false,
      reason: 'job-contract-invalid',
    });
  });
});

function createCompletedJob(
  options: Readonly<{ withSoundFont?: boolean; durationSeconds?: number; suffix?: string }> = {},
): LocalEngineGpuJobRecord {
  const midiArtifact = createMidiArtifact();
  const request = createInstrumentRenderJobRequest({
    gainDb: -3,
    modelId: options.withSoundFont
      ? 'soundfont-0123456789abcdef0123456789abcdef'
      : 'mock-soundfont-v1',
    modelRevision: options.withSoundFont
      ? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      : '1',
    plan: {
      midi: {
        ...midiArtifact.midi,
        ticksPerQuarter: 960,
      },
      source: {
        artifactId: 'artifact-midi',
        clipId: 'clip-midi',
        clipTakeId: 'clip-take-midi',
        contentHash: createMidiContentHash(midiArtifact.midi),
        label: 'MIDI Take 01',
        revision: 1,
        sourceType: 'job',
      },
    },
    preset: {
      bank: 0,
      program: 24,
    },
    providerId: 'mock-provider',
    providerVersion: '1',
    sampleRate: 8_000,
    ...(options.withSoundFont
      ? {
          soundFont: {
            format: 'sf2' as const,
            library: 'builtin' as const,
            relativePath: 'soundfonts/Mock.sf2',
            resourceId: 'soundfont-0123456789abcdef0123456789abcdef',
            revisionToken:
              '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        }
      : {}),
  });
  const createdAt = '2026-07-26T09:00:00.000Z';
  const finishedAt = '2026-07-26T09:00:01.000Z';
  const durationSeconds = options.durationSeconds ?? 1;
  const sizeBytes = 44 + Math.round(durationSeconds * 8_000) * 4;
  const artifactId = `artifact-instrument${options.suffix ?? ''}`;

  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: createdAt, state: 'LOADING_MODEL' },
      { attempt: 1, at: createdAt, state: 'PROCESSING' },
      { attempt: 1, at: finishedAt, state: 'SAVING' },
      { attempt: 1, at: finishedAt, state: 'COMPLETED' },
    ],
    jobId: `job-instrument-render${options.suffix ?? ''}`,
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request,
    result: {
      artifact: {
        artifactId,
        createdAt: finishedAt,
        destination: 'instrument',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `renders/instruments/${artifactId}.wav`,
          sizeBytes,
        },
        kind: 'audio',
        lineage: request.lineage,
        provenance: {
          modelId: request.modelId,
          modelRevision: request.modelRevision,
          parameters: request.parameters,
          providerId: request.providerId,
          taskId: request.taskId,
        },
      },
      generation: {
        bytesWritten: sizeBytes,
        channels: 2,
        durationSeconds,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    state: 'COMPLETED',
    taskId: request.taskId,
    updatedAt: finishedAt,
  };
}

function createProject(): ProjectState {
  const recordingArtifact = createRecordingArtifact();
  const recordingTake = createRecordingTake();
  const midiArtifact = createMidiArtifact();
  const midiTake = createMidiTake();

  return {
    artifacts: [recordingArtifact, midiArtifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Instrument Registration Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: {
      items: [],
    },
    status: 'READY',
    takes: [],
    totalTicks: 7_680,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: recordingTake.clipTakeId,
            clipTakes: [recordingTake],
            color: '#ff8c5a',
            createdAt: '2026-07-26T08:00:00.000Z',
            id: 'clip-audio',
            lengthTicks: 1_920,
            name: 'Hum Audio',
            startTick: 0,
            type: 'hum-audio',
            version: 1,
          },
        ],
        id: 'track-audio',
        level: -6,
        name: 'Hum Audio',
        type: 'audio',
      },
      {
        clips: [
          {
            activeClipTakeId: midiTake.clipTakeId,
            clipTakes: [midiTake],
            color: '#4de1ff',
            createdAt: '2026-07-26T08:01:00.000Z',
            id: 'clip-midi',
            lengthTicks: 1_920,
            name: 'MIDI Notes',
            sourceClipId: 'clip-audio',
            startTick: 0,
            type: 'midi-notes',
            version: 1,
          },
        ],
        id: 'track-midi',
        level: -6,
        name: 'MIDI Notes',
        type: 'midi',
      },
      {
        clips: [
          {
            color: '#8dff6b',
            createdAt: '2026-07-26T08:02:00.000Z',
            id: 'clip-instrument',
            lengthTicks: 1_920,
            name: 'Instrument Audio',
            sourceClipId: 'clip-midi',
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-instrument',
        level: -5,
        name: 'Instrument Audio',
        type: 'audio',
      },
    ],
  };
}

function createRecordingArtifact(): RecordingAudioArtifact {
  return {
    artifactId: 'artifact-recording',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 1,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    },
    capture: {
      source: 'microphone',
    },
    createdAt: '2026-07-26T08:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording.wav',
      relativePath: 'recordings/artifact-recording.wav',
      sizeBytes: 96_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
  };
}

function createRecordingTake(): RecordingAudioClipTake {
  return {
    artifactId: 'artifact-recording',
    clipTakeId: 'clip-take-recording',
    createdAt: '2026-07-26T08:00:00.000Z',
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

function createMidiArtifact(): GeneratedMidiArtifact {
  return {
    artifactId: 'artifact-midi',
    createdAt: '2026-07-26T08:01:00.000Z',
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-recording'],
      parentClipTakeIds: ['clip-take-recording'],
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
    provenance: {
      modelId: 'mock-hum-to-midi-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'hum-to-midi',
    },
    sourceJobId: 'job-hum-to-midi',
  };
}

function createMidiTake(): GeneratedMidiClipTake {
  return {
    artifactId: 'artifact-midi',
    clipTakeId: 'clip-take-midi',
    createdAt: '2026-07-26T08:01:00.000Z',
    label: 'MIDI Take 01',
    mediaType: 'midi',
    sourceJobId: 'job-hum-to-midi',
    sourceType: 'job',
  };
}

function findClip(project: ProjectState, clipId: string) {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Clip not found: ${clipId}.`);
  }

  return clip;
}
