import { describe, expect, it } from 'vitest';

import { resolveClipTakeAudioPreview } from './clipTakeAudioPreview';
import type { ProjectState } from './types';

describe('resolveClipTakeAudioPreview', () => {
  it('resolves one matching Audio Take without requiring it to be Active', () => {
    const project = createProject();
    const result = resolveClipTakeAudioPreview(
      project,
      'clip-a',
      'take-audio-preview',
    );

    expect(result).toMatchObject({
      canPreview: true,
      plan: {
        clip: { id: 'clip-a' },
        descriptor: {
          kind: 'generated',
          relativePath: 'renders/instruments/preview.wav',
          sourceId: 'artifact-audio-preview',
        },
        take: { clipTakeId: 'take-audio-preview' },
        track: { id: 'track-a' },
      },
    });
    expect(project.tracks[0].clips[0].activeClipTakeId).toBe(
      'take-audio-active',
    );
  });

  it('rejects MIDI Takes and mismatched Artifacts', () => {
    const project = createProject();

    expect(
      resolveClipTakeAudioPreview(project, 'clip-a', 'take-midi'),
    ).toMatchObject({
      canPreview: false,
      reason: 'take-not-audio',
    });

    const artifact = project.artifacts![0];

    if (
      !artifact ||
      artifact.kind !== 'audio' ||
      !('sourceJobId' in artifact)
    ) {
      throw new Error('Expected generated Audio Artifact fixture.');
    }

    project.artifacts![0] = {
      ...artifact,
      sourceJobId: 'job-wrong',
    };

    expect(
      resolveClipTakeAudioPreview(project, 'clip-a', 'take-audio-preview'),
    ).toMatchObject({
      canPreview: false,
      reason: 'artifact-invalid',
    });
  });

  it('rejects a Clip Take ID that is duplicated elsewhere in the Project', () => {
    const project = createProject();
    const sourceTake = project.tracks[0].clips[0].clipTakes?.[1];

    if (!sourceTake) {
      throw new Error('Expected Audio Clip Take fixture.');
    }

    project.tracks.push({
      clips: [
        {
          ...project.tracks[0].clips[0],
          activeClipTakeId: sourceTake.clipTakeId,
          clipTakes: [sourceTake],
          id: 'clip-b',
          name: 'Instrument 02',
        },
      ],
      id: 'track-b',
      level: -6,
      name: 'Instrument B',
      type: 'generated_audio',
    });

    expect(
      resolveClipTakeAudioPreview(project, 'clip-a', sourceTake.clipTakeId),
    ).toMatchObject({
      canPreview: false,
      reason: 'take-not-found',
    });
  });

  it('rejects explicitly unavailable Active Take sources before Engine read', () => {
    for (const [status, expectedMessage] of [
      ['missing', 'missing from the Project Root'],
      ['moved', 'no longer at its saved location'],
      ['unresolved', 'not restored from the Project Root'],
    ] as const) {
      const project = createProject();
      const clip = project.tracks[0].clips[0];

      clip.activeClipTakeId = 'take-audio-preview';
      clip.sourceFile = {
        name: 'preview.wav',
        relativePath: 'renders/instruments/preview.wav',
        sourceId: 'artifact-audio-preview',
        status,
      };

      expect(
        resolveClipTakeAudioPreview(
          project,
          clip.id,
          'take-audio-preview',
        ),
      ).toMatchObject({
        canPreview: false,
        message: expect.stringContaining(expectedMessage),
        reason: 'source-unavailable',
      });
    }
  });

  it('does not apply stale source metadata to another Take identity', () => {
    const project = createProject();
    const clip = project.tracks[0].clips[0];

    clip.activeClipTakeId = 'take-audio-preview';
    clip.sourceFile = {
      name: 'stale.wav',
      relativePath: 'renders/instruments/stale.wav',
      sourceId: 'artifact-stale',
      status: 'missing',
    };

    expect(
      resolveClipTakeAudioPreview(
        project,
        clip.id,
        'take-audio-preview',
      ),
    ).toMatchObject({ canPreview: true });
  });
});

function createProject(): ProjectState {
  return {
    artifacts: [
      {
        artifactId: 'artifact-audio-preview',
        audio: {
          channels: 2,
          durationSeconds: 1,
          mimeType: 'audio/wav',
        },
        createdAt: '2026-07-27T00:00:00.000Z',
        destination: 'instrument',
        file: {
          extension: '.wav',
          name: 'preview.wav',
          relativePath: 'renders/instruments/preview.wav',
          sizeBytes: 512,
        },
        kind: 'audio',
        lineage: {
          parentArtifactIds: [],
          parentClipTakeIds: [],
        },
        provenance: {
          modelId: 'mock-audio',
          modelRevision: '1',
          parameters: {},
          providerId: 'mock-provider',
          taskId: 'midi-to-audio',
        },
        sourceJobId: 'job-preview',
      },
    ],
    bpm: 120,
    connections: [],
    gridResolution: '1/16',
    isLooping: false,
    key: 'C',
    name: 'Preview Project',
    patchTabs: [],
    playheadTick: 0,
    recordingSettings: {
      countInBars: 0,
      metronomeEnabled: false,
      metronomeVolume: 0.5,
    },
    selectedPatchTabId: '',
    selection: { items: [] },
    status: 'READY',
    takes: [],
    totalTicks: 3840,
    tracks: [
      {
        clips: [
          {
            activeClipTakeId: 'take-audio-active',
            clipTakes: [
              {
                artifactId: 'artifact-audio-active',
                clipTakeId: 'take-audio-active',
                createdAt: '2026-07-27T00:00:00.000Z',
                label: 'Take Active',
                mediaType: 'audio',
                sourceJobId: 'job-active',
                sourceType: 'job',
              },
              {
                artifactId: 'artifact-audio-preview',
                clipTakeId: 'take-audio-preview',
                createdAt: '2026-07-27T00:00:01.000Z',
                label: 'Take Preview',
                mediaType: 'audio',
                sourceJobId: 'job-preview',
                sourceType: 'job',
              },
              {
                artifactId: 'artifact-midi',
                clipTakeId: 'take-midi',
                createdAt: '2026-07-27T00:00:02.000Z',
                label: 'Take MIDI',
                mediaType: 'midi',
                sourceJobId: 'job-midi',
                sourceType: 'job',
              },
            ],
            color: '#00ffff',
            createdAt: '2026-07-27T00:00:00.000Z',
            id: 'clip-a',
            lengthTicks: 960,
            name: 'Instrument 01',
            startTick: 0,
            type: 'instrument-audio',
            version: 1,
          },
        ],
        id: 'track-a',
        level: -3,
        name: 'Instrument',
        type: 'generated_audio',
      },
    ],
  };
}
