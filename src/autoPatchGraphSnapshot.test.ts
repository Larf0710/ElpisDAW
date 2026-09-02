import { describe, expect, it } from 'vitest';

import { createAutoPatchGraphSnapshot } from './autoPatchGraphSnapshot';
import { createMidiContentHash } from './midiContentHash';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import { createDefaultRecordingSettings } from './recordingSettings';
import type {
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ManualMidiArtifact,
  ManualMidiClipTake,
  PatchTab,
  PatchTabDefinition,
  ProjectState,
  TabFlowConnection,
  TabFlowLine,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

const createdAt = '2026-07-31T05:00:00.000Z';

describe('createAutoPatchGraphSnapshot', () => {
  it('freezes targets, Active Take identity, graph order, contracts, and parameters', () => {
    const project = createProject();
    const resolution = createAutoPatchGraphSnapshot(project, {
      snapshotId: 'snapshot-1',
      createdAt,
      targetClipIds: ['clip-midi'],
    });

    expect(resolution).toMatchObject({
      canBuild: true,
      snapshot: {
        snapshotId: 'snapshot-1',
        targetClipIds: ['clip-midi'],
        targets: [
          {
            clipId: 'clip-midi',
            trackId: 'track-midi',
            clipVersion: 1,
            startTick: 0,
            lengthTicks: TICKS_PER_QUARTER * 4,
            activeTake: {
              artifactId: 'artifact-midi',
              clipTakeId: 'take-midi',
              contentHash: 'hash-1',
              revision: 1,
            },
            soundFont: {
              bank: 0,
              program: 0,
              resource: {
                resourceId: 'soundfont-1',
              },
            },
          },
        ],
        familyOrder: ['family-1'],
        families: [
          {
            familyId: 'family-1',
            familyRevision: 3,
            connectionOrder: ['connection-a-b'],
            patchTabOrder: ['patch-a', 'patch-b'],
            connections: [
              {
                fromPortId: 'midi-out',
                toPortId: 'midi-in',
                activation: 'on',
                createdOrder: 0,
              },
            ],
            patchTabs: [
              {
                id: 'patch-a',
                nodeTypeId: 'test.source',
                nodeVersion: '1.0.0',
              },
              {
                id: 'patch-b',
                parameters: [
                  {
                    id: 'mode',
                    value: 'balanced',
                    options: ['balanced', 'quality'],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    if (!resolution.canBuild) {
      throw new Error(resolution.message);
    }

    const snapshot = resolution.snapshot;
    const sourceDefinition = project.patchTabs[0].portContractSnapshot;

    project.bpm = 90;
    project.connections[0].fromPatchTabId = 'changed';
    (project.tabFlowLines?.[0].connectionIds ?? []).push('changed');
    project.patchTabs[1].parameters[0] = {
      id: 'mode',
      label: 'Mode',
      kind: 'select',
      value: 'quality',
      options: ['quality'],
    };
    if (sourceDefinition) {
      sourceDefinition.outputs[0].label = 'Changed';
    }
    project.tracks[0].clips[0].soundFont!.bank = 12;
    project.tracks[0].clips[0].lengthTicks = TICKS_PER_QUARTER * 8;
    project.tracks[0].clips[0].clipTakes![0].artifactId = 'changed';

    expect(snapshot.projectContext.bpm).toBe(120);
    expect(snapshot.families[0].connections[0].fromPatchTabId).toBe('patch-a');
    expect(snapshot.families[0].lines[0].connectionIds).toEqual([
      'connection-a-b',
    ]);
    expect(snapshot.families[0].patchTabs[0].portContract.outputs[0].label).toBe(
      'MIDI',
    );
    expect(snapshot.families[0].patchTabs[1].parameters[0]).toMatchObject({
      value: 'balanced',
      options: ['balanced', 'quality'],
    });
    expect(snapshot.targets[0].soundFont?.bank).toBe(0);
    expect(snapshot.targets[0].lengthTicks).toBe(TICKS_PER_QUARTER * 4);
    expect(snapshot.targets[0].activeTake.artifactId).toBe('artifact-midi');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.targets[0].activeTake)).toBe(true);
    expect(Object.isFrozen(snapshot.families[0].connections)).toBe(true);
    expect(
      Object.isFrozen(
        snapshot.families[0].patchTabs[0].portContract.outputs[0].produces,
      ),
    ).toBe(true);
  });

  it('derives initial identity for generated MIDI that omits stored identity', () => {
    const project = createGeneratedMidiProject();
    const artifact = project.artifacts?.[0];

    if (!artifact || artifact.kind !== 'midi') {
      throw new Error('Generated MIDI fixture Artifact is missing.');
    }

    expect(
      createAutoPatchGraphSnapshot(project, {
        snapshotId: 'snapshot-generated-midi',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: true,
      snapshot: {
        targets: [
          {
            activeTake: {
              contentHash: createMidiContentHash(artifact.midi),
              revision: 1,
            },
          },
        ],
      },
    });
  });

  it('preserves explicit generated MIDI identity precedence and malformed values', () => {
    const explicitProject = createGeneratedMidiProject();
    const explicitArtifact = explicitProject.artifacts?.[0] as
      | (GeneratedMidiArtifact & {
          contentHash: string;
          revision: number;
        })
      | undefined;
    const explicitTake = explicitProject.tracks[0].clips[0]
      .clipTakes?.[0] as
      | (GeneratedMidiClipTake & {
          contentHash: string;
          revision: number;
        })
      | undefined;

    if (!explicitArtifact || !explicitTake) {
      throw new Error('Generated MIDI explicit identity fixture is missing.');
    }

    explicitArtifact.contentHash = 'artifact-explicit-hash';
    explicitArtifact.revision = 7;
    explicitTake.contentHash = 'take-explicit-hash';
    explicitTake.revision = 3;

    expect(
      createAutoPatchGraphSnapshot(explicitProject, {
        snapshotId: 'snapshot-generated-midi-explicit',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: true,
      snapshot: {
        targets: [
          {
            activeTake: {
              contentHash: 'artifact-explicit-hash',
              revision: 7,
            },
          },
        ],
      },
    });

    const malformedProject = createGeneratedMidiProject();
    const malformedArtifact = malformedProject.artifacts?.[0] as
      | (GeneratedMidiArtifact & {
          contentHash: string;
          revision: number;
        })
      | undefined;

    if (!malformedArtifact) {
      throw new Error('Generated MIDI malformed identity fixture is missing.');
    }

    malformedArtifact.contentHash = '';
    malformedArtifact.revision = -1;

    expect(
      createAutoPatchGraphSnapshot(malformedProject, {
        snapshotId: 'snapshot-generated-midi-malformed',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: true,
      snapshot: {
        targets: [
          {
            activeTake: {
              contentHash: '',
              revision: -1,
            },
          },
        ],
      },
    });
  });

  it('uses stable topological PatchTab order for branches and merges', () => {
    const project = createProject();
    project.patchTabs = ['patch-a', 'patch-b', 'patch-c', 'patch-d'].map(
      (id, index) => createPatchTab(id, index),
    );
    project.connections = [
      createConnection('connection-c-d', 'patch-c', 'patch-d', 3),
      createConnection('connection-a-c', 'patch-a', 'patch-c', 1),
      createConnection('connection-b-d', 'patch-b', 'patch-d', 2),
      createConnection('connection-a-b', 'patch-a', 'patch-b', 0),
    ];
    project.tabFlowLines = [
      createLine(
        'family-1',
        project.connections.map((connection) => connection.id),
      ),
    ];

    const resolution = createAutoPatchGraphSnapshot(project, {
      snapshotId: 'snapshot-branch',
      createdAt,
      targetClipIds: ['clip-midi'],
    });

    expect(resolution).toMatchObject({
      canBuild: true,
      snapshot: {
        families: [
          {
            patchTabOrder: ['patch-a', 'patch-b', 'patch-c', 'patch-d'],
            connectionOrder: [
              'connection-a-b',
              'connection-a-c',
              'connection-b-d',
              'connection-c-d',
            ],
          },
        ],
      },
    });
  });

  it('applies ON Family preflight as an all-or-none gate', () => {
    const project = createProject();
    project.patchTabs.push(createPatchTab('patch-c', 2));
    project.connections.push({
      ...createConnection('connection-a-c', 'patch-a', 'patch-c', 1),
      activation: 'off',
      enabled: false,
    });
    project.tabFlowLines = [
      createLine('family-1', ['connection-a-b']),
      {
        ...createLine('family-2', ['connection-a-c']),
        order: 1,
      },
    ];

    expect(
      createAutoPatchGraphSnapshot(project, {
        snapshotId: 'snapshot-blocked',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'family-blocked',
      familyId: 'family-2',
    });
  });

  it('snapshots only an explicitly Timeline-bound unconnected Stable Audio 3 PatchTab as a standalone Family', () => {
    const project = createProject();
    const definition = getBuiltinPatchTabDefinitions().find(
      (candidate) =>
        candidate.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
    );

    if (!definition) {
      throw new Error('Stable Audio 3 definition is missing.');
    }

    project.patchTabs = [
      {
        colorIndex: 0,
        description: 'Standalone SA3 snapshot fixture.',
        id: 'sa3-master',
        inputBindings: [
          {
            kind: 'timeline-selection',
            portId: 'audio-in',
            selectionKind: 'clip',
          },
        ],
        inputType: 'Audio',
        name: 'SA3 A2A',
        nodeTypeId: definition.nodeTypeId,
        nodeVersion: definition.nodeVersion,
        outputType: 'Audio',
        parameters: [],
        portContractSnapshot: definition,
        status: 'ready',
      },
    ];
    project.connections = [];
    project.tabFlowLines = [];

    expect(
      createAutoPatchGraphSnapshot(project, {
        snapshotId: 'snapshot-standalone-sa3',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: true,
      snapshot: {
        families: [
          {
            connectionOrder: [],
            connections: [],
            familyId: 'standalone-stable-audio-3:sa3-master',
            familyRevision: 1,
            lineOrder: [],
            lines: [],
            patchTabOrder: ['sa3-master'],
          },
        ],
      },
    });

    project.patchTabs[0] = {
      ...project.patchTabs[0],
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
    };

    expect(
      createAutoPatchGraphSnapshot(project, {
        snapshotId: 'snapshot-no-generic-standalone',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'no-enabled-family',
    });
  });

  it('rejects cyclic graphs that pass basic connection compatibility', () => {
    const project = createProject();
    project.connections.push(
      createConnection('connection-b-a', 'patch-b', 'patch-a', 1),
    );
    project.tabFlowLines = [
      createLine('family-1', ['connection-a-b', 'connection-b-a']),
    ];

    expect(
      createAutoPatchGraphSnapshot(project, {
        snapshotId: 'snapshot-cycle',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'graph-invalid',
      familyId: 'family-1',
    });
  });

  it('requires one matching Active Take and Artifact for every resolved target', () => {
    const project = createProject();
    project.tracks[0].clips[0].activeClipTakeId = undefined;

    expect(
      createAutoPatchGraphSnapshot(project, {
        snapshotId: 'snapshot-no-take',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'active-take-required',
    });

    const mismatchedProject = createProject();
    (
      mismatchedProject.artifacts?.[0] as ManualMidiArtifact
    ).contentHash = 'changed';

    expect(
      createAutoPatchGraphSnapshot(mismatchedProject, {
        snapshotId: 'snapshot-mismatch',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'artifact-invalid',
    });

    const duplicateTakeProject = createProject();
    duplicateTakeProject.tracks.push({
      id: 'track-other',
      name: 'Other',
      type: 'midi',
      level: 1,
      clips: [
        {
          ...duplicateTakeProject.tracks[0].clips[0],
          id: 'clip-other',
        },
      ],
    });

    expect(
      createAutoPatchGraphSnapshot(duplicateTakeProject, {
        snapshotId: 'snapshot-duplicate-take',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'active-take-invalid',
    });
  });

  it('rejects ambiguous target identity and reused ON Family connections', () => {
    const ambiguousProject = createProject();
    ambiguousProject.tracks.push({
      id: 'track-other',
      name: 'Other',
      type: 'midi',
      level: 1,
      clips: [{ ...ambiguousProject.tracks[0].clips[0] }],
    });

    expect(
      createAutoPatchGraphSnapshot(ambiguousProject, {
        snapshotId: 'snapshot-ambiguous',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'target-ambiguous',
    });

    const reusedConnectionProject = createProject();
    reusedConnectionProject.tabFlowLines = [
      createLine('family-1', ['connection-a-b']),
      {
        ...createLine('family-2', ['connection-a-b']),
        order: 1,
      },
    ];

    expect(
      createAutoPatchGraphSnapshot(reusedConnectionProject, {
        snapshotId: 'snapshot-reused',
        createdAt,
        targetClipIds: ['clip-midi'],
      }),
    ).toMatchObject({
      canBuild: false,
      reason: 'graph-invalid',
      familyId: 'family-2',
    });
  });
});

function createProject(): ProjectState {
  const activeTake: ManualMidiClipTake = {
    artifactId: 'artifact-midi',
    clipTakeId: 'take-midi',
    contentHash: 'hash-1',
    createdAt,
    label: 'Manual MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceManualId: 'manual-midi-1',
    sourceType: 'manual',
    updatedAt: createdAt,
  };
  const artifact: ManualMidiArtifact = {
    artifactId: 'artifact-midi',
    contentHash: 'hash-1',
    createdAt,
    kind: 'midi',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    manualProvenance: {
      editorId: 'humstudio.piano-roll',
      editorVersion: '1',
      taskId: 'manual-midi',
    },
    midi: {
      bpm: 120,
      notes: [],
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    revision: 1,
    sourceManualId: 'manual-midi-1',
    updatedAt: createdAt,
  };

  return {
    name: 'Snapshot Test',
    bpm: 120,
    key: 'C Major',
    status: 'READY',
    isLooping: false,
    selectedPatchTabId: 'patch-a',
    patchTabs: [
      createPatchTab('patch-a', 0),
      createPatchTab('patch-b', 1),
    ],
    connections: [
      {
        ...createConnection('connection-a-b', 'patch-a', 'patch-b', 0),
        activation: undefined,
        createdOrder: undefined,
        fromPortId: undefined,
        toPortId: undefined,
      },
    ],
    tabFlowLines: [createLine('family-1', ['connection-a-b'])],
    tracks: [
      {
        id: 'track-midi',
        name: 'MIDI',
        type: 'midi',
        level: 1,
        clips: [
          {
            id: 'clip-midi',
            type: 'midi-notes',
            name: 'MIDI Clip',
            startTick: 0,
            lengthTicks: TICKS_PER_QUARTER * 4,
            color: '#0000ff',
            activeClipTakeId: activeTake.clipTakeId,
            clipTakes: [activeTake],
            soundFont: {
              bank: 0,
              program: 0,
              resource: {
                format: 'sf2',
                library: 'project',
                relativePath: 'SoundFonts/test.sf2',
                resourceId: 'soundfont-1',
              },
            },
            createdAt,
            version: 1,
          },
        ],
      },
    ],
    artifacts: [artifact],
    selection: {
      items: [{ type: 'clip', id: 'clip-midi' }],
    },
    takes: [],
    playheadTick: 0,
    totalTicks: TICKS_PER_QUARTER * 16,
    gridResolution: '1/16',
    recordingSettings: createDefaultRecordingSettings(),
  };
}

function createGeneratedMidiProject(): ProjectState {
  const project = createProject();
  const artifact: GeneratedMidiArtifact = {
    artifactId: 'artifact-midi',
    createdAt,
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-recording'],
      parentClipTakeIds: ['take-recording'],
    },
    midi: {
      bpm: 120,
      notes: [
        {
          confidence: 0.94,
          id: 'note-basic-pitch-a4',
          lengthTicks: 960,
          pitch: 69,
          startTick: 0,
          velocity: 110,
        },
      ],
      ticksPerQuarter: TICKS_PER_QUARTER,
    },
    provenance: {
      modelId: 'basic-pitch-icassp-2022',
      modelRevision: '0.4.0-onnx',
      parameters: {},
      providerId: 'local-basic-pitch',
      taskId: 'hum-to-midi',
    },
    sourceJobId: 'job-basic-pitch-snapshot',
  };
  const activeTake: GeneratedMidiClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'take-midi',
    createdAt,
    label: 'Basic Pitch MIDI',
    mediaType: 'midi',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };

  project.artifacts = [artifact];
  project.tracks[0].clips[0].clipTakes = [activeTake];
  project.tracks[0].clips[0].activeClipTakeId = activeTake.clipTakeId;

  return project;
}

function createPatchTab(id: string, colorIndex: number): PatchTab {
  const definition = createDefinition(
    `test.${id === 'patch-a' ? 'source' : 'processor'}`,
  );

  return {
    id,
    name: id,
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
    portContractSnapshot: definition,
    inputBindings:
      id === 'patch-a'
        ? [
            {
              portId: 'midi-in',
              kind: 'timeline-selection',
              selectionKind: 'clip',
            },
          ]
        : [
            {
              portId: 'midi-in',
              kind: 'connection',
              connectionIds: [],
            },
          ],
    colorIndex,
    inputType: 'MIDI',
    outputType: 'MIDI',
    status: 'ready',
    description: '',
    parameters:
      id === 'patch-b'
        ? [
            {
              id: 'mode',
              label: 'Mode',
              kind: 'select',
              value: 'balanced',
              options: ['balanced', 'quality'],
            },
          ]
        : [],
  };
}

function createDefinition(nodeTypeId: string): PatchTabDefinition {
  return {
    schemaVersion: 1,
    nodeTypeId,
    nodeVersion: '1.0.0',
    defaultName: nodeTypeId,
    nodeCategory: 'process',
    inputs: [
      {
        id: 'midi-in',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        accepts: [{ id: 'humstudio.midi', major: 1 }],
        allowedBindings: ['connection', 'timeline-selection'],
        cardinality: {
          min: 0,
          max: 'many',
        },
      },
    ],
    outputs: [
      {
        id: 'midi-out',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        produces: { id: 'humstudio.midi', major: 1 },
        fanOut: 'many',
      },
    ],
  };
}

function createConnection(
  id: string,
  fromPatchTabId: string,
  toPatchTabId: string,
  order: number,
): TabFlowConnection {
  return {
    id,
    fromPatchTabId,
    toPatchTabId,
    fromPortId: 'midi-out',
    toPortId: 'midi-in',
    activation: 'on',
    createdOrder: order,
    signalType: 'MIDI',
    order,
    latencyMs: 0,
    enabled: true,
  };
}

function createLine(
  id: string,
  connectionIds: string[],
): TabFlowLine {
  return {
    id,
    name: id,
    order: 0,
    enabled: true,
    revision: 3,
    connectionIds,
  };
}
