import { describe, expect, it } from 'vitest';

import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { activateClipTake } from './clipTakeActivation';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  GeneratedMidiClipTake,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

describe('resolveActiveAudioTakeSource', () => {
  it('resolves an immutable generated WAV source from the Active Take', () => {
    const project = createGeneratedProject();
    const originalClip = project.tracks[0].clips[0];
    const resolution = resolveActiveAudioTakeSource(project, originalClip.id);

    expect(resolution).toMatchObject({
      canResolve: true,
      plan: {
        clip: {
          activeClipTakeId: 'clip-take-generated',
          lengthTicks: 2_400,
          sourceFile: {
            durationSeconds: 1.25,
            mimeType: 'audio/wav',
            name: 'artifact-generated.wav',
            relativePath: 'renders/instruments/artifact-generated.wav',
            sizeBytes: 48_044,
            sourceId: 'artifact-generated',
            status: 'available',
          },
        },
        descriptor: {
          kind: 'generated',
          name: 'artifact-generated.wav',
          relativePath: 'renders/instruments/artifact-generated.wav',
          sizeBytes: 48_044,
          sourceId: 'artifact-generated',
        },
        source: {
          artifactId: 'artifact-generated',
          clipId: 'clip-audio',
          clipTakeId: 'clip-take-generated',
        },
      },
    });

    if (!resolution.canResolve) {
      throw new Error(resolution.message);
    }

    expect(resolution.plan.descriptor).not.toHaveProperty('mimeType');
    expect(resolution.plan.clip).not.toBe(originalClip);
    expect(originalClip.lengthTicks).toBe(3_840);
    expect(originalClip.sourceFile?.sourceId).toBe('legacy-stale-source');
    expect(Object.isFrozen(resolution.plan)).toBe(true);
    expect(Object.isFrozen(resolution.plan.descriptor)).toBe(true);
    expect(Object.isFrozen(resolution.plan.source)).toBe(true);
  });

  it('uses the same generated-read boundary for finalized Recording Artifacts', () => {
    const project = createRecordingProject();
    const resolution = resolveActiveAudioTakeSource(
      project,
      'clip-recording',
    );

    expect(resolution).toMatchObject({
      canResolve: true,
      plan: {
        descriptor: {
          kind: 'generated',
          name: 'artifact-recording.wav',
          relativePath: 'recordings/artifact-recording.wav',
          sizeBytes: 96_044,
          sourceId: 'artifact-recording',
        },
      },
    });
  });

  it('accepts only the explicit Project audio directory allowlist', () => {
    const supportedPaths = [
      'recordings/artifact-generated.wav',
      'renders/instruments/artifact-generated.wav',
      'renders/stable-audio-3/artifact-generated.wav',
      'renders/ace-step/artifact-generated.wav',
      'mixdowns/artifact-generated.wav',
      'print-mixes/artifact-generated.wav',
      'exports/artifact-generated.wav',
    ];

    for (const relativePath of supportedPaths) {
      const project = createGeneratedProject();
      const artifact = findGeneratedArtifact(project);

      artifact.file.name = 'artifact-generated.wav';
      artifact.file.relativePath = relativePath;

      expect(
        resolveActiveAudioTakeSource(project, 'clip-audio'),
      ).toMatchObject({ canResolve: true });
    }

    for (const relativePath of [
      '../source.wav',
      'renders/instruments/../source.wav',
      'renders/cache/source.wav',
      'models/source.wav',
      'renders/instruments/source.wav.partial',
    ]) {
      const project = createGeneratedProject();
      findGeneratedArtifact(project).file.relativePath = relativePath;

      expect(
        resolveActiveAudioTakeSource(project, 'clip-audio'),
      ).toMatchObject({
        canResolve: false,
        reason: 'file-invalid',
      });
    }
  });

  it('rejects missing, duplicate, foreign, or non-Audio Active Takes', () => {
    const missing = createGeneratedProject();
    missing.tracks[0].clips[0].activeClipTakeId = 'clip-take-missing';

    expect(
      resolveActiveAudioTakeSource(missing, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const duplicate = createGeneratedProject();
    duplicate.tracks.push({
      clips: [
        {
          ...duplicate.tracks[0].clips[0],
          id: 'clip-duplicate-owner',
          clipTakes: [
            {
              ...(duplicate.tracks[0].clips[0]
                .clipTakes?.[0] as GeneratedAudioClipTake),
            },
          ],
        },
      ],
      id: 'track-duplicate-owner',
      level: 0,
      name: 'Duplicate Owner',
      type: 'audio',
    });

    expect(
      resolveActiveAudioTakeSource(duplicate, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const foreign = createGeneratedProject();
    const foreignTake = foreign.tracks[0].clips[0]
      .clipTakes?.[0] as GeneratedAudioClipTake;

    foreign.tracks[0].clips[0].clipTakes = [];
    foreign.tracks.push({
      clips: [
        {
          ...foreign.tracks[0].clips[0],
          activeClipTakeId: foreignTake.clipTakeId,
          clipTakes: [foreignTake],
          id: 'clip-foreign-owner',
        },
      ],
      id: 'track-foreign-owner',
      level: 0,
      name: 'Foreign Owner',
      type: 'audio',
    });

    expect(
      resolveActiveAudioTakeSource(foreign, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-found',
    });

    const wrongMedia = createGeneratedProject();
    const midiTake: GeneratedMidiClipTake = {
      artifactId: 'artifact-midi',
      clipTakeId: 'clip-take-midi',
      createdAt: '2026-07-26T00:00:00.000Z',
      label: 'MIDI Take 01',
      mediaType: 'midi',
      sourceJobId: 'job-midi',
      sourceType: 'job',
    };

    wrongMedia.tracks[0].clips[0].activeClipTakeId = midiTake.clipTakeId;
    wrongMedia.tracks[0].clips[0].clipTakes = [midiTake];

    expect(
      resolveActiveAudioTakeSource(wrongMedia, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'active-take-not-audio',
    });
  });

  it('rejects Artifact identity, WAV metadata, and timing mismatches', () => {
    const wrongSource = createGeneratedProject();
    (
      wrongSource.tracks[0].clips[0]
        .clipTakes?.[0] as GeneratedAudioClipTake
    ).sourceJobId = 'job-wrong';

    expect(
      resolveActiveAudioTakeSource(wrongSource, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'artifact-invalid',
    });

    const wrongMime = createGeneratedProject();
    findGeneratedArtifact(wrongMime).audio.mimeType = 'audio/mpeg';

    expect(
      resolveActiveAudioTakeSource(wrongMime, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'artifact-invalid',
    });

    const wrongSize = createGeneratedProject();
    findGeneratedArtifact(wrongSize).file.sizeBytes = 44;

    expect(
      resolveActiveAudioTakeSource(wrongSize, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'file-invalid',
    });

    const wrongTiming = createGeneratedProject();
    wrongTiming.tracks[0].clips[0].audioTiming = {
      sourceEndSeconds: 2,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    };

    expect(
      resolveActiveAudioTakeSource(wrongTiming, 'clip-audio'),
    ).toMatchObject({
      canResolve: false,
      reason: 'timing-invalid',
    });
  });

  it('preserves a resolvable Active Take when shorter-Take activation fails closed', () => {
    const project = createGeneratedProject();
    const clip = project.tracks[0].clips[0];
    const currentArtifact = findGeneratedArtifact(project);
    const shorterArtifact: GeneratedAudioArtifact = {
      ...createGeneratedArtifact(),
      artifactId: 'artifact-generated-shorter',
      audio: {
        ...currentArtifact.audio,
        durationSeconds: 0.25,
      },
      file: {
        ...currentArtifact.file,
        name: 'artifact-generated-shorter.wav',
        relativePath: 'renders/instruments/artifact-generated-shorter.wav',
        sizeBytes: 9_644,
      },
      sourceJobId: 'job-generated-shorter',
    };
    const shorterTake: GeneratedAudioClipTake = {
      artifactId: shorterArtifact.artifactId,
      clipTakeId: 'clip-take-generated-shorter',
      createdAt: shorterArtifact.createdAt,
      label: 'Generated Take 02',
      mediaType: 'audio',
      sourceJobId: shorterArtifact.sourceJobId,
      sourceType: 'job',
    };
    clip.audioTiming = {
      sourceEndSeconds: currentArtifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    };
    clip.clipTakes = [...(clip.clipTakes ?? []), shorterTake];
    project.artifacts = [...(project.artifacts ?? []), shorterArtifact];

    const originalResolution = resolveActiveAudioTakeSource(
      project,
      clip.id,
    );
    const activation = activateClipTake(
      project,
      clip.id,
      shorterTake.clipTakeId,
    );

    expect(originalResolution).toMatchObject({ canResolve: true });
    expect(activation).toMatchObject({
      canActivate: false,
      reason: 'timing-invalid',
    });
    expect(clip.activeClipTakeId).toBe('clip-take-generated');
    expect(resolveActiveAudioTakeSource(project, clip.id)).toMatchObject({
      canResolve: true,
    });
  });
});

function createGeneratedProject(): ProjectState {
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
    name: 'Active Audio Source Test',
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
            id: 'clip-audio',
            lengthTicks: 3_840,
            name: 'Generated Audio',
            sourceFile: {
              durationSeconds: 9,
              name: 'legacy.wav',
              sourceId: 'legacy-stale-source',
              status: 'available',
            },
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-audio',
        level: -5,
        name: 'Generated Audio',
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
      durationSeconds: 1.25,
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

function createRecordingProject(): ProjectState {
  const artifact: RecordingAudioArtifact = {
    artifactId: 'artifact-recording',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 1,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    },
    capture: { source: 'microphone' },
    createdAt: '2026-07-26T00:00:00.000Z',
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
  const take: RecordingAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-recording',
    createdAt: artifact.createdAt,
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
  const project = createGeneratedProject();

  project.artifacts = [artifact];
  project.tracks[0].clips = [
    {
      activeClipTakeId: take.clipTakeId,
      clipTakes: [take],
      color: '#ff4d5d',
      createdAt: artifact.createdAt,
      id: 'clip-recording',
      lengthTicks: 1_920,
      name: 'Recording',
      startTick: 0,
      type: 'hum-audio',
      version: 1,
    },
  ];

  return project;
}

function findGeneratedArtifact(
  project: ProjectState,
): GeneratedAudioArtifact {
  const artifact = project.artifacts?.[0];

  if (
    !artifact ||
    artifact.kind !== 'audio' ||
    !('sourceJobId' in artifact)
  ) {
    throw new Error('Generated Audio Artifact fixture is missing.');
  }

  return artifact;
}
