import { describe, expect, it } from 'vitest';
import {
  beginAutoPatchRuntimeStage,
  completeAutoPatchRuntimeStage,
  createAutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinatorResolution,
  type AutoPatchRuntimeStageDispatch,
} from './autoPatchRuntimeCoordinator';
import {
  createCompletedResult,
  createRuntimeTarget,
  createScope,
  createValidatedPreflight,
  editedArtifactId,
  editedClipTakeId,
  soundFontResourceId,
  soundFontRevision,
  sourceArtifactId,
  sourceClipTakeId,
  stageInstrumentId,
  stageMidiEditId,
  targetClipId,
} from './autoPatchExecutionFrontier.testFixture';
import {
  AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
  createAutoPatchStageAdapterPlan,
} from './autoPatchStageAdapter';
import { createEditedMidiArtifact } from './midiEditArtifact';
import { createMidiContentHash } from './midiContentHash';
import { sampleProject } from './sampleProject';
import type {
  EditedMidiArtifact,
  EditedMidiClipTake,
  ManualMidiArtifact,
  ManualMidiClipTake,
  ProjectState,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';
import type { LocalEngineSoundFontResource } from './localEngineClient';

describe('Auto Patch Stage Adapter', () => {
  it('materializes an exact FluidSynth Job request from an immutable dispatch', () => {
    const fixture = createMidiProjectFixture();
    const dispatch = createInstrumentDispatch(fixture);
    const resolution = createAutoPatchStageAdapterPlan(
      dispatch,
      fixture.editedProject,
      [createSoundFontResource()],
    );

    expect(resolution).toMatchObject({
      canPlan: true,
      plan: {
        adapterId: AUTO_PATCH_FLUIDSYNTH_STAGE_ADAPTER_ID,
        attemptId: 'attempt-instrument',
        kind: 'local-engine-job',
        request: {
          inputArtifacts: [
            {
              artifactId: editedArtifactId,
              kind: 'midi',
            },
          ],
          lineage: {
            parentArtifactIds: [editedArtifactId],
            parentClipTakeIds: [editedClipTakeId],
          },
          modelId: soundFontResourceId,
          modelRevision: soundFontRevision,
          parameters: {
            preset: { bank: 0, program: 0 },
            soundFont: {
              relativePath: 'soundfonts/Piano.sf2',
              resourceId: soundFontResourceId,
              revisionToken: soundFontRevision,
            },
            sourceMidiContentHash: fixture.editedContentHash,
            sourceMidiRevision: 1,
          },
          providerId: 'local-fluidsynth',
          taskId: 'midi-to-audio',
        },
        runId: 'run-stage-adapter',
        scope: { stageId: stageInstrumentId },
        sourceClipId: targetClipId,
      },
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    if (resolution.canPlan) {
      expect(Object.isFrozen(resolution.plan.request)).toBe(true);
      expect(Object.isFrozen(resolution.plan.scope)).toBe(true);
    }
  });

  it('rejects a dispatch when the exact Active MIDI Take has changed', () => {
    const fixture = createMidiProjectFixture();
    const dispatch = createInstrumentDispatch(fixture);

    expect(
      createAutoPatchStageAdapterPlan(
        dispatch,
        fixture.sourceProject,
        [createSoundFontResource()],
      ),
    ).toEqual({
      canPlan: false,
      cause: 'runtime-midi-input-stale',
      message:
        'MIDI TO AUDIO dispatch no longer matches the exact Active MIDI Artifact and Take.',
      reason: 'source-midi-mismatch',
    });
  });

  it('rejects a stale SoundFont revision at execution time', () => {
    const fixture = createMidiProjectFixture();
    const dispatch = createInstrumentDispatch(fixture);

    expect(
      createAutoPatchStageAdapterPlan(
        dispatch,
        fixture.editedProject,
        [
          {
            ...createSoundFontResource(),
            revisionToken: 'b'.repeat(64),
          },
        ],
      ),
    ).toEqual({
      canPlan: false,
      cause: 'soundfont-resource-unavailable',
      message:
        'MIDI TO AUDIO SoundFont is missing, stale, or ambiguous at Stage execution time.',
      reason: 'resource-unavailable',
    });
  });

  it('does not pretend an unsupported built-in Stage has an adapter', () => {
    const fixture = createMidiProjectFixture();
    const dispatch = createMidiEditDispatch(fixture.sourceContentHash);

    expect(
      createAutoPatchStageAdapterPlan(
        dispatch,
        fixture.sourceProject,
        [],
      ),
    ).toEqual({
      canPlan: false,
      cause: 'stage-adapter-unavailable',
      message:
        'No production Stage Adapter is registered for humstudio.patch.midi-edit.',
      reason: 'adapter-unavailable',
    });
  });

  it('rejects mock Instrument parameters instead of silently ignoring them', () => {
    const fixture = createMidiProjectFixture();
    const dispatch = createInstrumentDispatch(fixture);
    const parameterizedDispatch: AutoPatchRuntimeStageDispatch = {
      ...dispatch,
      node: {
        ...dispatch.node,
        parameters: [
          {
            id: 'brightness',
            kind: 'slider',
            label: 'Brightness',
            max: 100,
            min: 0,
            step: 1,
            unit: '%',
            value: 58,
          },
        ],
      },
    };

    expect(
      createAutoPatchStageAdapterPlan(
        parameterizedDispatch,
        fixture.editedProject,
        [createSoundFontResource()],
      ),
    ).toMatchObject({
      canPlan: false,
      cause: 'instrument-dispatch-invalid',
      reason: 'dispatch-invalid',
    });
  });
});

type MidiProjectFixture = Readonly<{
  editedContentHash: string;
  editedProject: ProjectState;
  sourceContentHash: string;
  sourceProject: ProjectState;
}>;

function createMidiProjectFixture(): MidiProjectFixture {
  const createdAt = '2026-07-31T00:00:00.000Z';
  const midi = {
    bpm: 120,
    notes: [
      {
        id: 'note-source',
        lengthTicks: 960,
        pitch: 60,
        startTick: 0,
        velocity: 100,
      },
    ],
    ticksPerQuarter: TICKS_PER_QUARTER,
  };
  const sourceContentHash = createMidiContentHash(midi);
  const sourceArtifact: ManualMidiArtifact = {
    artifactId: sourceArtifactId,
    contentHash: sourceContentHash,
    createdAt,
    kind: 'midi',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    manualProvenance: {
      editorId: 'piano-roll',
      editorVersion: '1',
      taskId: 'manual-midi',
    },
    midi,
    revision: 1,
    sourceManualId: 'manual-midi-source',
    updatedAt: createdAt,
  };
  const sourceTake: ManualMidiClipTake = {
    artifactId: sourceArtifactId,
    clipTakeId: sourceClipTakeId,
    contentHash: sourceContentHash,
    createdAt,
    label: 'Source MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceManualId: sourceArtifact.sourceManualId,
    sourceType: 'manual',
    updatedAt: createdAt,
  };
  const sourceProject = JSON.parse(
    JSON.stringify(sampleProject),
  ) as ProjectState;
  sourceProject.artifacts = [sourceArtifact];
  sourceProject.tracks.push({
    clips: [
      {
        activeClipTakeId: sourceClipTakeId,
        clipTakes: [sourceTake],
        color: '#3b82f6',
        createdAt,
        id: targetClipId,
        lengthTicks: 7_680,
        name: 'Auto Patch MIDI',
        soundFont: {
          bank: 0,
          program: 0,
          resource: {
            format: 'sf2',
            library: 'project',
            relativePath: 'soundfonts/Piano.sf2',
            resourceId: soundFontResourceId,
          },
        },
        startTick: 0,
        type: 'midi-notes',
        version: 1,
      },
    ],
    id: 'track-auto-patch-midi',
    level: -6,
    name: 'Auto Patch MIDI',
    parentGroupId: null,
    type: 'midi',
  });

  const editedArtifact = createEditedMidiArtifact({
    artifactId: editedArtifactId,
    createdAt: '2026-07-31T00:01:00.000Z',
    notes: [{ ...midi.notes[0], pitch: 62 }],
    sourceArtifact,
    sourceClipTake: sourceTake,
    sourceEditId: 'edit-auto-patch',
  });
  const editedContentHash = requireEditedContentHash(editedArtifact);
  const editedTake: EditedMidiClipTake = {
    artifactId: editedArtifactId,
    clipTakeId: editedClipTakeId,
    contentHash: editedContentHash,
    createdAt: editedArtifact.createdAt,
    label: 'Edited MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceEditId: editedArtifact.sourceEditId,
    sourceType: 'edit',
    updatedAt: editedArtifact.updatedAt,
  };
  const editedProject = JSON.parse(
    JSON.stringify(sourceProject),
  ) as ProjectState;
  editedProject.artifacts = [sourceArtifact, editedArtifact];
  const target = editedProject.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === targetClipId);

  if (!target) {
    throw new Error('Missing Auto Patch MIDI test Clip');
  }

  target.activeClipTakeId = editedClipTakeId;
  target.clipTakes = [sourceTake, editedTake];
  target.version += 1;

  return {
    editedContentHash,
    editedProject,
    sourceContentHash,
    sourceProject,
  };
}

function createMidiEditDispatch(
  sourceContentHash: string,
): AutoPatchRuntimeStageDispatch {
  const coordinator = requireCoordinator(
    createAutoPatchRuntimeCoordinator({
      createdAt: '2026-07-31T00:00:00.000Z',
      runId: 'run-stage-adapter',
      runtimeTargets: [createRuntimeTarget()],
      stageResults: [],
      validatedPreflight: createValidatedPreflight({
        sourceContentHash,
      }),
    }),
  );

  return requireDispatch(
    beginAutoPatchRuntimeStage(coordinator, {
      attemptId: 'attempt-midi-edit',
      startedAt: '2026-07-31T00:00:10.000Z',
    }),
  );
}

function createInstrumentDispatch(
  fixture: MidiProjectFixture,
): AutoPatchRuntimeStageDispatch {
  const coordinator = requireCoordinator(
    createAutoPatchRuntimeCoordinator({
      createdAt: '2026-07-31T00:00:00.000Z',
      runId: 'run-stage-adapter',
      runtimeTargets: [createRuntimeTarget()],
      stageResults: [],
      validatedPreflight: createValidatedPreflight({
        sourceContentHash: fixture.sourceContentHash,
      }),
    }),
  );
  const midiRunning = requireCoordinator(
    beginAutoPatchRuntimeStage(coordinator, {
      attemptId: 'attempt-midi-edit',
      startedAt: '2026-07-31T00:00:10.000Z',
    }),
  );

  if (midiRunning.status !== 'RUNNING') {
    throw new Error('MIDI Edit Stage must be running');
  }

  const instrumentReady = requireCoordinator(
    completeAutoPatchRuntimeStage(midiRunning, {
      attemptId: 'attempt-midi-edit',
      result: createCompletedResult(
        createScope(stageMidiEditId),
        midiRunning.activeStage.fingerprint,
        'result-midi-edit',
        [editedArtifactId],
        [editedClipTakeId],
      ),
      runtimeTarget: createRuntimeTarget({
        artifactIds: [editedArtifactId],
        artifactIdentities: [
          {
            artifactId: editedArtifactId,
            mediaType: 'midi',
            midi: {
              contentHash: fixture.editedContentHash,
              revision: 1,
            },
          },
        ],
        clipTakeIds: [editedClipTakeId],
      }),
    }),
  );

  return requireDispatch(
    beginAutoPatchRuntimeStage(instrumentReady, {
      attemptId: 'attempt-instrument',
      startedAt: '2026-07-31T00:01:10.000Z',
    }),
  );
}

function createSoundFontResource(): LocalEngineSoundFontResource {
  return {
    format: 'sf2',
    lastModifiedAt: '2026-07-31T00:00:00.000Z',
    library: 'project',
    name: 'Piano.sf2',
    relativePath: 'soundfonts/Piano.sf2',
    resourceId: soundFontResourceId,
    revisionToken: soundFontRevision,
    sizeBytes: 1_024,
    status: 'AVAILABLE',
  };
}

function requireEditedContentHash(
  artifact: EditedMidiArtifact,
): string {
  if (!artifact.contentHash) {
    throw new Error('Edited MIDI test Artifact requires a content hash');
  }

  return artifact.contentHash;
}

function requireCoordinator(
  resolution: AutoPatchRuntimeCoordinatorResolution,
): AutoPatchRuntimeCoordinator {
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  return resolution.coordinator;
}

function requireDispatch(
  resolution: AutoPatchRuntimeCoordinatorResolution,
): AutoPatchRuntimeStageDispatch {
  if (!resolution.ok || !resolution.dispatch) {
    throw new Error(
      resolution.ok
        ? 'Runtime resolution did not include a Stage dispatch'
        : resolution.message,
    );
  }

  return resolution.dispatch;
}
