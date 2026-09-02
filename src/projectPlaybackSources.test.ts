import { describe, expect, it, vi } from 'vitest';

import {
  collectProjectPlaybackAudioSources,
  createProjectPlaybackSourceAvailabilitySnapshot,
} from './projectPlaybackSources';
import { SessionAudioSourceRegistry } from './sessionAudioSourceRegistry';
import type {
  LocalEngineGeneratedAudioDescriptor,
} from './localEngineClient';
import type {
  ProjectPlaybackEvent,
  ProjectPlaybackSchedule,
} from './projectPlaybackRuntime';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

describe('createProjectPlaybackSourceAvailabilitySnapshot', () => {
  it('combines Active Take Engine access with legacy session files', () => {
    const project = createProject();
    const registry = new SessionAudioSourceRegistry();
    const legacyFile = createFile('legacy.wav');

    registry.register('legacy-source', legacyFile);

    expect(
      createProjectPlaybackSourceAvailabilitySnapshot(
        project,
        registry,
        true,
      ),
    ).toEqual({
      'artifact-generated': 'openable',
      'legacy-source': 'openable',
    });
    expect(
      createProjectPlaybackSourceAvailabilitySnapshot(
        project,
        registry,
        false,
      ),
    ).toEqual({
      'artifact-generated': 'unknown',
      'legacy-source': 'openable',
    });
  });

  it('does not fall back to stale legacy metadata when an Active Take is invalid', () => {
    const project = createProject();
    const registry = new SessionAudioSourceRegistry();
    const activeClip = project.tracks[0].clips[0];

    activeClip.sourceFile = {
      durationSeconds: 1,
      name: 'stale.wav',
      sourceId: 'stale-source',
      status: 'available',
    };
    activeClip.activeClipTakeId = 'clip-take-missing';
    registry.register('stale-source', createFile('stale.wav'));

    const snapshot = createProjectPlaybackSourceAvailabilitySnapshot(
      project,
      registry,
      true,
    );

    expect(snapshot).toEqual({
      'legacy-source': 'unknown',
    });
    expect(snapshot).not.toHaveProperty('stale-source');
  });
});

describe('collectProjectPlaybackAudioSources', () => {
  it('preserves exact long-form SA3 and ACE generated descriptors through the authenticated reader boundary', async () => {
    const sa3 = {
      kind: 'generated' as const,
      name: 'artifact-d2c49203-a0a0-40f7-9752-9239edeab7f4.wav',
      relativePath:
        'renders/stable-audio-3/artifact-d2c49203-a0a0-40f7-9752-9239edeab7f4.wav',
      sizeBytes: 51_609_644,
      sourceId: 'artifact-d2c49203-a0a0-40f7-9752-9239edeab7f4',
    } satisfies LocalEngineGeneratedAudioDescriptor;
    const ace = {
      kind: 'generated' as const,
      name: 'artifact-b069b22a-5b04-4883-8d04-755b87fcf887.wav',
      relativePath:
        'renders/ace-step/artifact-b069b22a-5b04-4883-8d04-755b87fcf887.wav',
      sizeBytes: 51_609_644,
      sourceId: 'artifact-b069b22a-5b04-4883-8d04-755b87fcf887',
    } satisfies LocalEngineGeneratedAudioDescriptor;
    const reader = {
      readGeneratedAudioWav: vi.fn(async () => ({
        ok: true as const,
        wav: new Blob([new Uint8Array(44)], { type: 'audio/wav' }),
      })),
    };
    const result = collectProjectPlaybackAudioSources(
      [createSchedule(
        [sa3, ace],
        [
          createEvent('clip-sa3', sa3.sourceId),
          createEvent('clip-ace', ace.sourceId),
        ],
      )],
      new SessionAudioSourceRegistry(),
      reader,
    );

    expect(result.canOpen).toBe(true);
    expect(reader.readGeneratedAudioWav).toHaveBeenNthCalledWith(1, sa3);
    expect(reader.readGeneratedAudioWav).toHaveBeenNthCalledWith(2, ace);

    if (result.canOpen) {
      expect(result.sources.get(sa3.sourceId)).toMatchObject({
        kind: 'generated',
        name: sa3.name,
      });
      expect(result.sources.get(ace.sourceId)).toMatchObject({
        kind: 'generated',
        name: ace.name,
      });
      await Promise.all([...result.sources.values()].map((source) => source.data));
    }
  });

  it('collects generated WAV promises and legacy session Files by source id', async () => {
    const descriptor = createGeneratedDescriptor();
    const wav = new Blob([new Uint8Array(48)], { type: 'audio/wav' });
    const legacyFile = createFile('legacy.wav');
    const registry = new SessionAudioSourceRegistry();
    const reader = {
      readGeneratedAudioWav: vi.fn(async () => ({ ok: true as const, wav })),
    };
    const schedule = createSchedule(
      [descriptor],
      [
        createEvent('clip-generated', descriptor.sourceId),
        createEvent('clip-legacy', 'legacy-source'),
      ],
    );

    registry.register('legacy-source', legacyFile);

    const result = collectProjectPlaybackAudioSources(
      [schedule],
      registry,
      reader,
    );

    expect(result.canOpen).toBe(true);

    if (!result.canOpen) {
      throw new Error(result.message);
    }

    expect(reader.readGeneratedAudioWav).toHaveBeenCalledWith(descriptor);
    expect(await result.sources.get(descriptor.sourceId)?.data).toBe(wav);
    expect(result.sources.get(descriptor.sourceId)?.kind).toBe('generated');
    expect(result.sources.get('legacy-source')).toEqual({
      data: legacyFile,
      kind: 'session',
      name: legacyFile.name,
    });
  });

  it('collects an ephemeral MIDI playback cache before session lookup', () => {
    const cacheSource = {
      data: new Blob([new Uint8Array(48)], { type: 'audio/wav' }),
      kind: 'midi-cache' as const,
      name: 'MIDI Clip / Piano.wav',
    };
    const result = collectProjectPlaybackAudioSources(
      [createSchedule([], [createEvent('clip-midi', 'midi-cache:clip-midi')])],
      new SessionAudioSourceRegistry(),
      undefined,
      new Map([['midi-cache:clip-midi', cacheSource]]),
    );

    expect(result.canOpen).toBe(true);
    if (result.canOpen) {
      expect(result.sources.get('midi-cache:clip-midi')).toBe(cacheSource);
    }
  });

  it('surfaces generated read failures through the runtime source promise', async () => {
    const descriptor = createGeneratedDescriptor();
    const result = collectProjectPlaybackAudioSources(
      [createSchedule([descriptor], [createEvent('clip-generated', descriptor.sourceId)])],
      new SessionAudioSourceRegistry(),
      {
        readGeneratedAudioWav: vi.fn(async () => ({
          message: 'Generated WAV is missing.',
          ok: false as const,
          reason: 'http-error' as const,
          status: 404,
        })),
      },
    );

    expect(result.canOpen).toBe(true);

    if (!result.canOpen) {
      throw new Error(result.message);
    }

    await expect(
      result.sources.get(descriptor.sourceId)?.data,
    ).rejects.toThrow('Generated WAV is missing.');
  });

  it('rejects missing readers, missing session files, and conflicting descriptors', () => {
    const descriptor = createGeneratedDescriptor();
    const generatedSchedule = createSchedule(
      [descriptor],
      [createEvent('clip-generated', descriptor.sourceId)],
    );
    const sessionSchedule = createSchedule(
      [],
      [createEvent('clip-legacy', 'legacy-source')],
    );
    const conflictSchedule = createSchedule(
      [{ ...descriptor, sizeBytes: descriptor.sizeBytes + 1 }],
      [createEvent('clip-generated', descriptor.sourceId)],
    );
    const registry = new SessionAudioSourceRegistry();

    expect(
      collectProjectPlaybackAudioSources([generatedSchedule], registry),
    ).toMatchObject({
      canOpen: false,
      message: expect.stringContaining('requires Local Engine access'),
    });
    expect(
      collectProjectPlaybackAudioSources([sessionSchedule], registry),
    ).toMatchObject({
      canOpen: false,
      message: expect.stringContaining('not available in this session'),
    });
    expect(
      collectProjectPlaybackAudioSources(
        [generatedSchedule, conflictSchedule],
        registry,
      ),
    ).toMatchObject({
      canOpen: false,
      message: expect.stringContaining('conflicting descriptors'),
    });
  });
});

function createProject(): ProjectState {
  const artifact = createGeneratedArtifact();
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-generated',
    createdAt: artifact.createdAt,
    label: 'Generated Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };

  return {
    artifacts: [artifact],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Project Playback Source Test',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 1,
      metronomeEnabled: true,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    takes: [],
    totalTicks: 7_680,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: take.clipTakeId,
            clipTakes: [take],
            color: '#8dff6b',
            createdAt: artifact.createdAt,
            id: 'clip-generated',
            lengthTicks: 1_920,
            name: 'Generated Audio',
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-generated',
        level: -5,
        name: 'Generated Audio',
        type: 'audio',
      },
      {
        clips: [
          {
            audioTiming: {
              sourceEndSeconds: 1,
              sourceStartSeconds: 0,
              timeBase: 'absolute-seconds',
            },
            color: '#5e8fb8',
            createdAt: artifact.createdAt,
            id: 'clip-legacy',
            lengthTicks: 1_920,
            name: 'Legacy Audio',
            sourceFile: {
              durationSeconds: 1,
              name: 'legacy.wav',
              sourceId: 'legacy-source',
              status: 'available',
            },
            startTick: 1_920,
            type: 'hum-audio',
            version: 1,
          },
        ],
        id: 'track-legacy',
        level: -6,
        name: 'Legacy Audio',
        type: 'audio',
      },
    ],
  };
}

function createGeneratedArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-generated',
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-26T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-generated.wav',
      relativePath: 'renders/instruments/artifact-generated.wav',
      sizeBytes: 48_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi'],
      parentClipTakeIds: ['clip-take-midi'],
    },
    provenance: {
      modelId: 'mock-model',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-generated',
  };
}

function createGeneratedDescriptor(): LocalEngineGeneratedAudioDescriptor {
  return {
    kind: 'generated',
    name: 'artifact-generated.wav',
    relativePath: 'renders/instruments/artifact-generated.wav',
    sizeBytes: 48,
    sourceId: 'artifact-generated',
  };
}

function createSchedule(
  generatedSources: readonly LocalEngineGeneratedAudioDescriptor[],
  events: readonly ProjectPlaybackEvent[],
): ProjectPlaybackSchedule {
  return {
    durationSeconds: 1,
    endTick: 1_920,
    masterFaderDb: 0,
    mixerDspVersion: 1,
    plan: {
      audibleRange: { endTick: 1_920, startTick: 0 },
      endTick: 1_920,
      generatedSources,
      isIncomplete: false,
      missingSourceCount: 0,
      mixerSnapshot: {
        channels: [],
        master: {
          busId: 'stereo-master',
          faderDb: 0,
          inserts: [],
        },
        schemaVersion: 1,
      },
      purpose: 'selection-playback',
      sourceIssues: [],
      startTick: 0,
      target: { kind: 'track', trackId: 'track-audio' },
      tracks: [],
    },
    startTick: 0,
    tracks: [
      {
        events,
        gainDb: 0,
        pan: 0,
        trackId: 'track-audio',
      },
    ],
  };
}

function createEvent(
  clipId: string,
  sourceId: string,
): ProjectPlaybackEvent {
  return {
    clipId,
    clipName: clipId,
    durationSeconds: 1,
    sourceId,
    sourceStartSeconds: 0,
    startOffsetSeconds: 0,
    timelineEndTick: 1_920,
    timelineStartTick: 0,
  };
}

function createFile(name: string): File {
  return {
    arrayBuffer: async () => new ArrayBuffer(48),
    name,
  } as File;
}
