import { describe, expect, it } from 'vitest';

import { lookupReusableTabFlowStageResult } from './tabFlowReusableResult';
import {
  createTabFlowResultAvailability,
  type TabFlowProjectAvailabilityState,
} from './tabFlowResultAvailability';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ManualMidiArtifact,
  ManualMidiClipTake,
} from './types';

const midiArtifact: ManualMidiArtifact = {
  artifactId: 'artifact-midi',
  createdAt: '2026-07-31T01:00:00.000Z',
  kind: 'midi',
  lineage: {
    parentArtifactIds: [],
    parentClipTakeIds: [],
  },
  manualProvenance: {
    editorId: 'humstudio-piano-roll',
    editorVersion: '1.0.0',
    taskId: 'manual-midi',
  },
  midi: {
    bpm: 120,
    notes: [],
    ticksPerQuarter: 960,
  },
  contentHash: 'fnv1a64-midi',
  revision: 1,
  sourceManualId: 'manual-midi-1',
  updatedAt: '2026-07-31T01:00:00.000Z',
};

const midiTake: ManualMidiClipTake = {
  artifactId: midiArtifact.artifactId,
  clipTakeId: 'take-midi',
  createdAt: '2026-07-31T01:00:00.000Z',
  label: 'Manual MIDI',
  mediaType: 'midi',
  contentHash: midiArtifact.contentHash,
  revision: midiArtifact.revision,
  sourceManualId: midiArtifact.sourceManualId,
  sourceType: 'manual',
  updatedAt: midiArtifact.updatedAt,
};

const audioArtifact: GeneratedAudioArtifact = {
  artifactId: 'artifact-audio',
  audio: {
    channels: 2,
    durationSeconds: 4,
    mimeType: 'audio/wav',
  },
  createdAt: '2026-07-31T02:00:00.000Z',
  destination: 'instrument',
  file: {
    extension: '.wav',
    name: 'instrument.wav',
    relativePath: 'generated/instrument.wav',
    sizeBytes: 819_244,
  },
  kind: 'audio',
  lineage: {
    parentArtifactIds: [midiArtifact.artifactId],
    parentClipTakeIds: [midiTake.clipTakeId],
  },
  provenance: {
    modelId: 'fluidsynth',
    modelRevision: '2.5.7',
    parameters: {},
    providerId: 'local-fluidsynth',
    taskId: 'midi-to-audio',
  },
  sourceJobId: 'job-instrument',
};

const audioTake: GeneratedAudioClipTake = {
  artifactId: audioArtifact.artifactId,
  clipTakeId: 'take-audio',
  createdAt: '2026-07-31T02:00:00.000Z',
  label: 'Instrument Audio',
  mediaType: 'audio',
  sourceJobId: audioArtifact.sourceJobId,
  sourceType: 'job',
};

function createClip(
  id: string,
  type: Clip['type'],
  clipTakes: Clip['clipTakes'],
): Clip {
  return {
    id,
    type,
    name: id,
    startTick: 0,
    lengthTicks: 3_840,
    color: '#267dff',
    activeClipTakeId: clipTakes?.[0]?.clipTakeId,
    clipTakes,
    createdAt: '2026-07-31T00:00:00.000Z',
    version: 1,
  };
}

function createProject(): TabFlowProjectAvailabilityState {
  return {
    artifacts: [midiArtifact, audioArtifact],
    tracks: [
      {
        clips: [
          createClip('clip-midi', 'midi-notes', [midiTake]),
          createClip('clip-audio', 'instrument-audio', [audioTake]),
        ],
      },
    ],
  };
}

describe('TabFlow Project and Engine result availability', () => {
  it('keeps inline MIDI available without Engine file verification', () => {
    const availability = createTabFlowResultAvailability(createProject(), {
      targetClipId: 'clip-midi',
      verifiedAudioArtifactIds: [],
    });

    expect(availability).toEqual({
      artifactIds: ['artifact-midi'],
      clipTakeIds: ['take-midi'],
    });
  });

  it('requires Engine verification for an Audio Artifact and its ClipTake', () => {
    const project = createProject();
    const offline = createTabFlowResultAvailability(project, {
      targetClipId: 'clip-audio',
      verifiedAudioArtifactIds: [],
    });
    const online = createTabFlowResultAvailability(project, {
      targetClipId: 'clip-audio',
      verifiedAudioArtifactIds: ['artifact-audio'],
    });

    expect(offline.artifactIds).toEqual(['artifact-midi']);
    expect(offline.clipTakeIds).toEqual([]);
    expect(online.artifactIds).toEqual([
      'artifact-audio',
      'artifact-midi',
    ]);
    expect(online.clipTakeIds).toEqual(['take-audio']);
  });

  it('excludes a ClipTake whose media or source identity does not match', () => {
    const project = createProject();
    const invalidTake = {
      ...audioTake,
      sourceJobId: 'job-other',
    };
    const invalidProject: TabFlowProjectAvailabilityState = {
      ...project,
      tracks: [
        {
          clips: [
            createClip('clip-audio', 'instrument-audio', [invalidTake]),
          ],
        },
      ],
    };

    expect(
      createTabFlowResultAvailability(invalidProject, {
        targetClipId: 'clip-audio',
        verifiedAudioArtifactIds: ['artifact-audio'],
      }).clipTakeIds,
    ).toEqual([]);
  });

  it('excludes duplicate Artifact and ClipTake identities', () => {
    const project = createProject();
    const duplicateProject: TabFlowProjectAvailabilityState = {
      artifacts: [
        ...(project.artifacts ?? []),
        { ...midiArtifact },
      ],
      tracks: [
        {
          clips: [
            createClip('clip-midi', 'midi-notes', [midiTake]),
            createClip('clip-midi-copy', 'midi-notes', [{ ...midiTake }]),
          ],
        },
      ],
    };
    const availability = createTabFlowResultAvailability(duplicateProject, {
      targetClipId: 'clip-midi',
      verifiedAudioArtifactIds: [],
    });

    expect(availability.artifactIds).toEqual([]);
    expect(availability.clipTakeIds).toEqual([]);
  });

  it('returns an empty snapshot when the target Clip is missing or ambiguous', () => {
    const project = createProject();
    const ambiguousProject: TabFlowProjectAvailabilityState = {
      ...project,
      tracks: [
        ...project.tracks,
        {
          clips: [createClip('clip-midi', 'midi-notes', [midiTake])],
        },
      ],
    };

    expect(
      createTabFlowResultAvailability(project, {
        targetClipId: 'clip-missing',
        verifiedAudioArtifactIds: [],
      }),
    ).toEqual({ artifactIds: [], clipTakeIds: [] });
    expect(
      createTabFlowResultAvailability(ambiguousProject, {
        targetClipId: 'clip-midi',
        verifiedAudioArtifactIds: [],
      }),
    ).toEqual({ artifactIds: [], clipTakeIds: [] });
  });

  it('drives reusable-result lookup from the verified snapshot', () => {
    const project = createProject();
    const candidate = {
      resultId: 'result-instrument',
      scope: {
        familyId: 'flow-family-1',
        familyRevision: 1,
        targetClipId: 'clip-audio',
        stageId: 'midi-to-audio',
      },
      fingerprint: 'tabflow-fnv1a64-current',
      state: 'COMPLETED' as const,
      finishedAt: '2026-07-31T02:00:00.000Z',
      outputArtifactIds: ['artifact-audio'],
      outputClipTakeIds: ['take-audio'],
    };
    const query = {
      scope: candidate.scope,
      fingerprint: candidate.fingerprint,
    };

    expect(
      lookupReusableTabFlowStageResult(
        query,
        [candidate],
        createTabFlowResultAvailability(project, {
          targetClipId: 'clip-audio',
          verifiedAudioArtifactIds: [],
        }),
      ).reusableResult.isAvailable,
    ).toBe(false);
    expect(
      lookupReusableTabFlowStageResult(
        query,
        [candidate],
        createTabFlowResultAvailability(project, {
          targetClipId: 'clip-audio',
          verifiedAudioArtifactIds: ['artifact-audio'],
        }),
      ).reusableResult.isAvailable,
    ).toBe(true);
  });

  it('returns sorted immutable arrays without mutating Project state', () => {
    const project = createProject();
    const availability = createTabFlowResultAvailability(project, {
      targetClipId: 'clip-audio',
      verifiedAudioArtifactIds: ['artifact-audio'],
    });

    expect(Object.isFrozen(availability)).toBe(true);
    expect(Object.isFrozen(availability.artifactIds)).toBe(true);
    expect(Object.isFrozen(availability.clipTakeIds)).toBe(true);
    expect(Object.isFrozen(project)).toBe(false);
  });
});
