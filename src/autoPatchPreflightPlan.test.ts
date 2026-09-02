import { describe, expect, it } from 'vitest';

import { createAutoPatchPreflightPlan } from './autoPatchPreflightPlan';
import {
  validateAutoPatchStagePreflight,
  type AutoPatchVerifiedStageRuntimeProfile,
} from './autoPatchStagePreflight';
import {
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
} from './fluidSynthInstrumentRender';
import { INSTRUMENT_RENDER_TASK_ID } from './instrumentRenderContract';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import { createManualMidiClip } from './manualMidiClip';
import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  PATCH_DATA_TYPES,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import { createDefaultRecordingSettings } from './recordingSettings';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  PatchTab,
  PatchTabDefinition,
  PatchTabParameter,
  ProjectState,
  TabFlowConnection,
} from './types';
import { TICKS_PER_QUARTER } from './workflow';

const createdAt = '2026-07-31T05:30:00.000Z';

describe('createAutoPatchPreflightPlan', () => {
  it('joins canonical selection, immutable graph, availability, and ordered Stage scopes', () => {
    const project = createMidiProject();
    const targetClipId = getSelectedClipId(project);
    const targetClip = project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === targetClipId);
    const resolution = createAutoPatchPreflightPlan(project, {
      planId: 'plan-1',
      createdAt,
      verifiedAudioArtifactIds: [],
    });

    expect(resolution).toMatchObject({
      canPlan: true,
      plan: {
        planId: 'plan-1',
        targetSource: 'clip-selection',
        graphSnapshot: {
          targetClipIds: [targetClipId],
          familyOrder: ['family-1'],
        },
        targetPlans: [
          {
            targetClipId,
            availability: {
              artifactIds: [targetClip?.clipTakes?.[0].artifactId],
              clipTakeIds: [targetClip?.activeClipTakeId],
            },
            families: [
              {
                familyId: 'family-1',
                familyRevision: 2,
                stages: [
                  {
                    dependsOnStageIds: [],
                    incomingConnectionIds: [],
                    scope: {
                      familyId: 'family-1',
                      familyRevision: 2,
                      stageId: 'patch-a',
                      targetClipId,
                    },
                  },
                  {
                    dependsOnStageIds: ['patch-a'],
                    incomingConnectionIds: ['connection-a-b'],
                    scope: {
                      stageId: 'patch-b',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    if (!resolution.canPlan) {
      throw new Error(resolution.message);
    }

    expect(Object.isFrozen(resolution.plan)).toBe(true);
    expect(Object.isFrozen(resolution.plan.targetPlans)).toBe(true);
    expect(
      Object.isFrozen(
        resolution.plan.targetPlans[0].families[0].stages[1].scope,
      ),
    ).toBe(true);
  });

  it('preserves fallback targeting when canonical selection is empty', () => {
    const project = createMidiProject();
    const fallbackClipId = getSelectedClipId(project);
    project.selection = { items: [] };

    expect(
      createAutoPatchPreflightPlan(project, {
        planId: 'plan-fallback',
        createdAt,
        fallbackClipId,
        verifiedAudioArtifactIds: [],
      }),
    ).toMatchObject({
      canPlan: true,
      plan: {
        targetSource: 'fallback-clip',
        graphSnapshot: {
          targetClipIds: [fallbackClipId],
        },
      },
    });
  });

  it('requires Engine-verified Audio while accepting valid inline MIDI', () => {
    const project = createAudioProject();
    const targetClipId = getSelectedClipId(project);
    const artifactId = project.artifacts?.[0].artifactId;

    expect(
      createAutoPatchPreflightPlan(project, {
        planId: 'plan-audio-offline',
        createdAt,
        verifiedAudioArtifactIds: [],
      }),
    ).toMatchObject({
      canPlan: false,
      reason: 'source-unavailable',
      targetClipId,
    });

    expect(
      createAutoPatchPreflightPlan(project, {
        planId: 'plan-audio-online',
        createdAt,
        verifiedAudioArtifactIds: artifactId ? [artifactId] : [],
      }),
    ).toMatchObject({
      canPlan: true,
      plan: {
        targetPlans: [
          {
            availability: {
              artifactIds: artifactId ? [artifactId] : [],
              clipTakeIds: ['take-audio'],
            },
          },
        ],
      },
    });
  });

  it('creates no partial plan when one target source or ON Family is blocked', () => {
    const project = createMidiProject();
    const audio = createAudioSource();
    project.artifacts = [...(project.artifacts ?? []), audio.artifact];
    project.tracks.push(audio.track);
    project.selection = {
      items: [
        { type: 'clip', id: getFirstClipId(project) },
        { type: 'clip', id: audio.clipId },
      ],
    };

    expect(
      createAutoPatchPreflightPlan(project, {
        planId: 'plan-mixed',
        createdAt,
        verifiedAudioArtifactIds: [],
      }),
    ).toMatchObject({
      canPlan: false,
      reason: 'source-unavailable',
      targetClipId: audio.clipId,
    });

    const blockedProject = createMidiProject();
    blockedProject.connections[0] = {
      ...blockedProject.connections[0],
      activation: 'off',
      enabled: false,
    };

    expect(
      createAutoPatchPreflightPlan(blockedProject, {
        planId: 'plan-blocked-family',
        createdAt,
        verifiedAudioArtifactIds: [],
      }),
    ).toMatchObject({
      canPlan: false,
      reason: 'graph-snapshot-failed',
      cause: 'family-blocked',
    });
  });
});

describe('validateAutoPatchStagePreflight', () => {
  it('freezes exact Port bindings and one verified runtime profile per Stage', () => {
    const project = createMidiProject();
    const plan = requirePreflightPlan(project);
    const profiles = createBuiltinProfiles(plan);
    const resolution = validateAutoPatchStagePreflight(
      plan,
      profiles,
      [],
    );

    expect(resolution).toMatchObject({
      canValidate: true,
      validated: {
        stages: [
          {
            execution: { kind: 'builtin' },
            portBindings: [
              {
                portId: 'midi-in',
                sourceCount: 1,
                bindingKinds: ['timeline-selection'],
                connectionIds: [],
              },
            ],
          },
          {
            portBindings: [
              {
                portId: 'midi-in',
                sourceCount: 1,
                bindingKinds: ['connection'],
                connectionIds: ['connection-a-b'],
              },
            ],
          },
        ],
      },
    });

    if (!resolution.canValidate) {
      throw new Error(resolution.message);
    }

    expect(Object.isFrozen(resolution.validated)).toBe(true);
    expect(Object.isFrozen(resolution.validated.stages)).toBe(true);
    expect(
      Object.isFrozen(resolution.validated.stages[0].portBindings[0]),
    ).toBe(true);
  });

  it('rejects a built-in MIDI Edit Stage whose visible contract exceeds Basic Quantize', () => {
    const project = createMidiProject();
    configureBuiltInMidiEdit(project, [
      {
        id: 'quantize',
        kind: 'slider',
        label: 'Quantize Strength',
        max: 100,
        min: 0,
        step: 1,
        unit: '%',
        value: 78,
      },
      {
        id: 'swing',
        kind: 'slider',
        label: 'Swing',
        max: 75,
        min: 0,
        step: 1,
        unit: '%',
        value: 12,
      },
    ]);
    const plan = requirePreflightPlan(project);

    expect(
      validateAutoPatchStagePreflight(
        plan,
        createBuiltinProfiles(plan),
        [],
      ),
    ).toMatchObject({
      canValidate: false,
      cause: 'midi-edit-parameter-unsupported',
      reason: 'contract-invalid',
      scope: {
        familyId: 'family-1',
        familyRevision: 2,
        stageId: 'patch-a',
      },
    });
  });

  it('accepts a contract-correct built-in Basic Quantize Stage', () => {
    const project = createMidiProject();
    configureBuiltInMidiEdit(project, [
      {
        id: 'quantize',
        kind: 'select',
        label: 'Quantize',
        options: ['1/8', '1/16'],
        value: '1/16',
      },
    ]);
    const plan = requirePreflightPlan(project);

    expect(
      validateAutoPatchStagePreflight(
        plan,
        createBuiltinProfiles(plan),
        [],
      ),
    ).toMatchObject({
      canValidate: true,
      validated: {
        stages: [
          {
            scope: { stageId: 'patch-a' },
          },
          {
            scope: { stageId: 'patch-b' },
          },
        ],
      },
    });
  });

  it('rejects missing required sources and stale Connection bindings', () => {
    const missingSourceProject = createMidiProject();
    missingSourceProject.patchTabs[0].inputBindings = [];
    const missingSourcePlan = requirePreflightPlan(missingSourceProject);

    expect(
      validateAutoPatchStagePreflight(
        missingSourcePlan,
        createBuiltinProfiles(missingSourcePlan),
        [],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'cardinality-invalid',
      cause: 'port-cardinality-invalid',
    });

    const staleBindingProject = createMidiProject();
    staleBindingProject.patchTabs[1].inputBindings = [
      {
        portId: 'midi-in',
        kind: 'connection',
        connectionIds: ['connection-stale'],
      },
    ];
    const staleBindingPlan = requirePreflightPlan(staleBindingProject);

    expect(
      validateAutoPatchStagePreflight(
        staleBindingPlan,
        createBuiltinProfiles(staleBindingPlan),
        [],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'binding-invalid',
      cause: 'connection-binding-mismatch',
    });

    const undeclaredConnectionProject = createMidiProject();
    undeclaredConnectionProject.patchTabs[1].inputBindings = [];
    const undeclaredConnectionPlan = requirePreflightPlan(
      undeclaredConnectionProject,
    );

    expect(
      validateAutoPatchStagePreflight(
        undeclaredConnectionPlan,
        createBuiltinProfiles(undeclaredConnectionPlan),
        [],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'binding-invalid',
      cause: 'connection-binding-incomplete',
    });
  });

  it('validates MIDI TO AUDIO against SoundFont and FluidSynth identity', () => {
    const fixture = createInstrumentPreflightFixture();
    const resolution = validateAutoPatchStagePreflight(
      fixture.plan,
      fixture.profiles,
      [fixture.soundFont],
    );

    expect(resolution).toMatchObject({
      canValidate: true,
      validated: {
        verifiedSoundFontResourceIds: [fixture.soundFont.resourceId],
        stages: [
          expect.anything(),
          {
            execution: {
              kind: 'provider',
              providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
              providerRevision:
                FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
              taskId: INSTRUMENT_RENDER_TASK_ID,
              modelId: fixture.soundFont.resourceId,
              modelRevision: fixture.soundFont.revisionToken,
            },
            resourceInputs: [
              {
                portId: 'soundfont-in',
                resourceId: fixture.soundFont.resourceId,
                revision: fixture.soundFont.revisionToken,
                selections: {
                  bank: 0,
                  program: 0,
                },
              },
            ],
          },
        ],
      },
    });
  });

  it('rejects stale SoundFont, wrong Provider, and missing Stage profiles', () => {
    const staleFixture = createInstrumentPreflightFixture();
    const staleProfiles = staleFixture.profiles.map((profile) =>
      profile.execution.kind === 'provider'
        ? {
            ...profile,
            resourceInputs: profile.resourceInputs.map((resourceInput) => ({
              ...resourceInput,
              revision: 'c'.repeat(64),
            })),
          }
        : profile,
    );

    expect(
      validateAutoPatchStagePreflight(
        staleFixture.plan,
        staleProfiles,
        [staleFixture.soundFont],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'resource-unavailable',
      cause: 'soundfont-resource-unavailable',
    });

    const staleProviderFixture = createInstrumentPreflightFixture();
    const staleProviderProfiles =
      staleProviderFixture.profiles.map((profile) =>
        profile.execution.kind === 'provider'
          ? {
              ...profile,
              execution: {
                ...profile.execution,
                providerRevision: '2.6.0',
              },
            }
          : profile,
      );

    expect(
      validateAutoPatchStagePreflight(
        staleProviderFixture.plan,
        staleProviderProfiles,
        [staleProviderFixture.soundFont],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'provider-invalid',
      cause: 'instrument-provider-mismatch',
    });

    const wrongProviderFixture = createInstrumentPreflightFixture();
    const wrongProviderProfiles =
      wrongProviderFixture.profiles.map((profile) =>
        profile.execution.kind === 'provider'
          ? {
              ...profile,
              execution: { kind: 'builtin' as const },
            }
          : profile,
      );

    expect(
      validateAutoPatchStagePreflight(
        wrongProviderFixture.plan,
        wrongProviderProfiles,
        [wrongProviderFixture.soundFont],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'provider-invalid',
      cause: 'instrument-provider-mismatch',
    });

    const missingProfileFixture = createInstrumentPreflightFixture();

    expect(
      validateAutoPatchStagePreflight(
        missingProfileFixture.plan,
        missingProfileFixture.profiles.slice(0, -1),
        [missingProfileFixture.soundFont],
      ),
    ).toMatchObject({
      canValidate: false,
      reason: 'profile-invalid',
      cause: 'runtime-profile-missing',
    });
  });
});

function createMidiProject(): ProjectState {
  const creation = createManualMidiClip(createBaseProject(), {
    createdAt,
    startTick: 0,
  });

  if (!creation.canCreate) {
    throw new Error(creation.message);
  }

  return {
    ...creation.project,
    selection: {
      items: [{ type: 'clip', id: creation.clip.id }],
    },
  };
}

function createAudioProject(): ProjectState {
  const project = createBaseProject();
  const audio = createAudioSource();

  return {
    ...project,
    artifacts: [audio.artifact],
    tracks: [audio.track],
    selection: {
      items: [{ type: 'clip', id: audio.clipId }],
    },
  };
}

function createBaseProject(): ProjectState {
  return {
    name: 'Auto Patch Preflight Test',
    bpm: 120,
    key: 'C Major',
    status: 'READY',
    isLooping: false,
    selectedPatchTabId: 'patch-a',
    patchTabs: [
      createPatchTab('patch-a', 0),
      createPatchTab('patch-b', 1),
    ],
    connections: [createConnection()],
    tabFlowLines: [
      {
        id: 'family-1',
        name: 'Flow 1',
        order: 0,
        enabled: true,
        revision: 2,
        connectionIds: ['connection-a-b'],
      },
    ],
    tracks: [],
    artifacts: [],
    selection: { items: [] },
    takes: [],
    playheadTick: 0,
    totalTicks: TICKS_PER_QUARTER * 16,
    gridResolution: '1/16',
    recordingSettings: createDefaultRecordingSettings(),
  };
}

function createPatchTab(id: string, colorIndex: number): PatchTab {
  const definition = createPatchDefinition(`test.${id}`);

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
              connectionIds: ['connection-a-b'],
            },
          ],
    colorIndex,
    inputType: 'MIDI',
    outputType: 'MIDI',
    status: 'ready',
    description: '',
    parameters: [],
  };
}

function createPatchDefinition(nodeTypeId: string): PatchTabDefinition {
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
        accepts: [PATCH_DATA_TYPES.midiNotes],
        allowedBindings: ['connection', 'timeline-selection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'midi-out',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        produces: PATCH_DATA_TYPES.midiNotes,
        fanOut: 'many',
      },
    ],
  };
}

function configureBuiltInMidiEdit(
  project: ProjectState,
  parameters: PatchTabParameter[],
): void {
  const midiEditDefinition = getBuiltinPatchTabDefinitions().find(
    (definition) =>
      definition.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
  );

  if (!midiEditDefinition) {
    throw new Error('Expected MIDI Edit definition.');
  }

  project.patchTabs[0] = {
    ...project.patchTabs[0],
    nodeTypeId: midiEditDefinition.nodeTypeId,
    nodeVersion: midiEditDefinition.nodeVersion,
    portContractSnapshot: midiEditDefinition,
    parameters,
  };
}

function createConnection(): TabFlowConnection {
  return {
    id: 'connection-a-b',
    fromPatchTabId: 'patch-a',
    toPatchTabId: 'patch-b',
    fromPortId: 'midi-out',
    toPortId: 'midi-in',
    activation: 'on',
    createdOrder: 0,
    signalType: 'MIDI',
    order: 0,
    latencyMs: 0,
    enabled: true,
  };
}

function createAudioSource(): Readonly<{
  artifact: GeneratedAudioArtifact;
  clipId: string;
  track: ProjectState['tracks'][number];
}> {
  const artifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-audio',
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt,
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-audio.wav',
      relativePath: 'renders/instruments/artifact-audio.wav',
      sizeBytes: 48,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: 'fluidsynth',
      modelRevision: '2.5.7',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-audio',
  };
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'take-audio',
    createdAt,
    label: 'Audio Take',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  const clipId = 'clip-audio';

  return {
    artifact,
    clipId,
    track: {
      id: 'track-audio',
      name: 'Audio',
      type: 'audio',
      level: 1,
      clips: [
        {
          id: clipId,
          type: 'instrument-audio',
          name: 'Audio Clip',
          startTick: 0,
          lengthTicks: TICKS_PER_QUARTER * 4,
          color: '#f54848',
          activeClipTakeId: take.clipTakeId,
          clipTakes: [take],
          createdAt,
          version: 1,
        },
      ],
    },
  };
}

function getSelectedClipId(project: ProjectState): string {
  const selectedClip = project.selection.items.find(
    (item) => item.type === 'clip',
  );

  if (!selectedClip) {
    throw new Error('Expected selected Clip fixture.');
  }

  return selectedClip.id;
}

function getFirstClipId(project: ProjectState): string {
  const clipId = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id !== 'clip-audio')?.id;

  if (!clipId) {
    throw new Error('Expected MIDI Clip fixture.');
  }

  return clipId;
}

function requirePreflightPlan(
  project: ProjectState,
) {
  const resolution = createAutoPatchPreflightPlan(project, {
    planId: 'validated-plan',
    createdAt,
    verifiedAudioArtifactIds: [],
  });

  if (!resolution.canPlan) {
    throw new Error(resolution.message);
  }

  return resolution.plan;
}

function createBuiltinProfiles(
  plan: ReturnType<typeof requirePreflightPlan>,
): AutoPatchVerifiedStageRuntimeProfile[] {
  return plan.targetPlans.flatMap((targetPlan) =>
    targetPlan.families.flatMap((family) =>
      family.stages.map((stage) => ({
        execution: { kind: 'builtin' as const },
        resourceInputs: [],
        scope: { ...stage.scope },
      })),
    ),
  );
}

function createInstrumentPreflightFixture(): Readonly<{
  plan: ReturnType<typeof requirePreflightPlan>;
  profiles: readonly AutoPatchVerifiedStageRuntimeProfile[];
  soundFont: LocalEngineSoundFontResource;
}> {
  const project = createMidiProject();
  const instrumentDefinition = getBuiltinPatchTabDefinitions().find(
    (definition) =>
      definition.nodeTypeId === BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  );

  if (!instrumentDefinition) {
    throw new Error('Expected MIDI TO AUDIO definition.');
  }

  project.patchTabs[1] = {
    ...project.patchTabs[1],
    name: 'MIDI TO AUDIO',
    nodeTypeId: instrumentDefinition.nodeTypeId,
    nodeVersion: instrumentDefinition.nodeVersion,
    portContractSnapshot: instrumentDefinition,
    inputBindings: [
      {
        portId: 'midi-in',
        kind: 'connection',
        connectionIds: ['connection-a-b'],
      },
      {
        portId: 'soundfont-in',
        kind: 'project-context',
        selector: 'clip.soundFont',
      },
    ],
  };
  const targetClipId = getSelectedClipId(project);
  const targetClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === targetClipId);
  const soundFont: LocalEngineSoundFontResource = {
    format: 'sf2',
    lastModifiedAt: createdAt,
    library: 'project',
    name: 'test.sf2',
    relativePath: 'soundfonts/test.sf2',
    resourceId: `soundfont-${'a'.repeat(32)}`,
    revisionToken: 'b'.repeat(64),
    sizeBytes: 1_024,
    status: 'AVAILABLE',
  };

  if (!targetClip) {
    throw new Error('Expected instrument target Clip.');
  }

  targetClip.soundFont = {
    bank: 0,
    program: 0,
    resource: {
      format: soundFont.format,
      library: 'project',
      relativePath: soundFont.relativePath,
      resourceId: soundFont.resourceId,
    },
  };

  const plan = requirePreflightPlan(project);
  const profiles = createBuiltinProfiles(plan).map((profile) =>
    profile.scope.stageId === 'patch-b'
      ? {
          execution: {
            kind: 'provider' as const,
            modelId: soundFont.resourceId,
            modelRevision: soundFont.revisionToken,
            providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
            providerRevision:
              FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
            taskId: INSTRUMENT_RENDER_TASK_ID,
          },
          resourceInputs: [
            {
              portId: 'soundfont-in',
              resourceId: soundFont.resourceId,
              revision: soundFont.revisionToken,
              selections: {
                bank: 0,
                program: 0,
              },
            },
          ],
          scope: profile.scope,
        }
      : profile,
  );

  return { plan, profiles, soundFont };
}
