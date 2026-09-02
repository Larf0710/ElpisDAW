import { describe, expect, it } from 'vitest';

import {
  prepareAutoPatchProductionRun,
} from './autoPatchProductionPreparation';
import {
  createProductionProject,
  createRawMixdownStableAudio3ProductionProject,
  productionCreatedAt as createdAt,
  productionSoundFont as soundFont,
  productionSoundFontResourceId as soundFontResourceId,
  productionSoundFontRevision as soundFontRevision,
  rawMixdownArtifactId,
  rawMixdownClipId,
  rawMixdownClipTakeId,
} from './autoPatchProductionPreparation.testFixture';
import { HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH } from './defaultSoundFontPreset';
import { createSoundFontPatchTab } from './soundFontPatchTab';

const builtInDefaultSoundFont = Object.freeze({
  ...soundFont,
  format: 'sf3' as const,
  library: 'builtin' as const,
  name: 'MuseScore General',
  relativePath: HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
  resourceId: `soundfont-${'d'.repeat(32)}`,
  revisionToken: 'e'.repeat(64),
});

describe('Auto Patch production preparation', () => {
  it('prepares one supported MIDI Edit to Instrument run from current Project state', () => {
    const project = createProductionProject();
    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-production-ui',
      runId: 'run-production-ui',
      verifiedAudioArtifactIds: [],
      verifiedSoundFontResources: [soundFont],
    });

    expect(preparation).toMatchObject({
      canRun: true,
      coordinator: {
        activeStage: { scope: { stageId: 'midi-edit' } },
        runId: 'run-production-ui',
        status: 'READY',
      },
      stageCount: 2,
      status: 'RUN_READY',
      verifiedSoundFontResources: [
        { resourceId: soundFontResourceId, revisionToken: soundFontRevision },
      ],
    });

    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }

    expect(preparation.targetClipIds).toHaveLength(1);
    expect(preparation.coordinator.runtimeTargets[0]).toMatchObject({
      artifactIdentities: [
        {
          mediaType: 'midi',
          midi: { revision: 1 },
        },
      ],
      targetClipId: preparation.targetClipIds[0],
    });
  });

  it('prepares the default built-in MIDI Edit to MIDI TO AUDIO to SA3 A2A route', () => {
    const project = createProductionProject({
      includeStableAudio3: true,
      soundFont: builtInDefaultSoundFont,
    });
    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-default-midi-sa3-a2a',
      runId: 'run-default-midi-sa3-a2a',
      verifiedAudioArtifactIds: [],
      verifiedSoundFontResources: [builtInDefaultSoundFont],
    });

    expect(preparation).toMatchObject({
      canRun: true,
      stageCount: 3,
      status: 'RUN_READY',
    });
    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }
    expect(
      preparation.coordinator.validatedPreflight.stages.find(
        (stage) => stage.scope.stageId === 'instrument',
      ),
    ).toMatchObject({
      resourceInputs: [
        {
          portId: 'soundfont-in',
          resourceId: builtInDefaultSoundFont.resourceId,
          selections: { bank: 0, program: 0 },
        },
      ],
    });
  });

  it('uses a connected SoundFont PatchTab without scheduling it as a production Stage', () => {
    const project = createProductionProject();
    const soundFontPatchTab = createSoundFontPatchTab('soundfont', 1);
    soundFontPatchTab.parameters = soundFontPatchTab.parameters.map((parameter) =>
      parameter.id === 'soundfont-resource' && parameter.kind === 'select'
        ? {
            ...parameter,
            options: [soundFont.relativePath],
            value: soundFont.relativePath,
          }
        : parameter,
    );
    const instrument = project.patchTabs.find(
      (patchTab) => patchTab.id === 'instrument',
    );

    if (!instrument || !project.tabFlowLines?.[0]) {
      throw new Error('Production fixture routing is missing.');
    }

    instrument.inputBindings = [
      {
        connectionIds: ['connection-midi-instrument'],
        kind: 'connection',
        portId: 'midi-in',
      },
      {
        connectionIds: ['connection-soundfont-instrument'],
        kind: 'connection',
        portId: 'soundfont-in',
      },
    ];
    project.patchTabs.splice(1, 0, soundFontPatchTab);
    project.connections.push({
      activation: 'on',
      createdOrder: 1,
      enabled: true,
      fromPatchTabId: 'soundfont',
      fromPortId: 'soundfont-out',
      id: 'connection-soundfont-instrument',
      latencyMs: 0,
      order: 1,
      signalType: 'SOUNDFONT',
      toPatchTabId: 'instrument',
      toPortId: 'soundfont-in',
    });
    project.tabFlowLines[0].connectionIds.push(
      'connection-soundfont-instrument',
    );
    project.tracks = project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        const { soundFont: _soundFont, ...clipWithoutAssignment } = clip;
        return clipWithoutAssignment;
      }),
    }));

    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-connected-soundfont',
      runId: 'run-connected-soundfont',
      verifiedAudioArtifactIds: [],
      verifiedSoundFontResources: [soundFont],
    });

    expect(preparation).toMatchObject({
      canRun: true,
      stageCount: 2,
      status: 'RUN_READY',
    });

    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }

    expect(
      preparation.coordinator.validatedPreflight.stages.map(
        (stage) => stage.scope.stageId,
      ),
    ).toEqual(['midi-edit', 'instrument']);
    expect(
      preparation.coordinator.validatedPreflight.stages.find(
        (stage) => stage.scope.stageId === 'instrument',
      ),
    ).toMatchObject({
      resourceInputs: [
        {
          portId: 'soundfont-in',
          resourceId: soundFont.resourceId,
          selections: { bank: 0, program: 0 },
        },
      ],
    });
  });

  it('blocks a stale or missing Project SoundFont before Driver allocation', () => {
    const preparation = prepareAutoPatchProductionRun(
      createProductionProject(),
      {
        createdAt,
        planId: 'plan-production-ui',
        runId: 'run-production-ui',
        verifiedAudioArtifactIds: [],
        verifiedSoundFontResources: [],
      },
    );

    expect(preparation).toMatchObject({
      canRun: false,
      cause: 'soundfont-resource-unavailable',
      reason: 'runtime-profile-rejected',
      status: 'BLOCKED',
    });
  });

  it('blocks an incompatible visible MIDI Edit contract before Driver allocation', () => {
    const project = createProductionProject();
    project.patchTabs[0] = {
      ...project.patchTabs[0],
      parameters: [
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
      ],
    };

    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-production-ui',
      runId: 'run-production-ui',
      verifiedAudioArtifactIds: [],
      verifiedSoundFontResources: [soundFont],
    });

    expect(preparation).toMatchObject({
      canRun: false,
      cause: 'midi-edit-quantize-parameter-invalid',
      reason: 'runtime-profile-rejected',
      status: 'BLOCKED',
    });
  });

  it('prepares the exact backend Stable Audio 3 Provider profile as a third Stage', () => {
    const preparation = prepareAutoPatchProductionRun(
      createProductionProject({ includeStableAudio3: true }),
      {
        createdAt,
        planId: 'plan-production-stable-audio-3',
        runId: 'run-production-stable-audio-3',
        verifiedAudioArtifactIds: [],
        verifiedSoundFontResources: [soundFont],
      },
    );

    expect(preparation).toMatchObject({
      canRun: true,
      stageCount: 3,
      status: 'RUN_READY',
    });

    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }

    const stableStage =
      preparation.coordinator.validatedPreflight.stages.find(
        (stage) => stage.scope.stageId === 'stable-audio-3',
      );

    expect(stableStage).toMatchObject({
      execution: {
        kind: 'provider',
        modelId: 'stable-audio-3-medium',
        providerId: 'local-stable-audio-3',
        providerRevision: '0.1.0',
        taskId: 'audio-to-audio',
      },
      portBindings: [
        {
          connectionIds: ['connection-instrument-stable-audio-3'],
          portId: 'audio-in',
          sourceCount: 1,
        },
      ],
      resourceInputs: [],
    });
  });

  it('prepares one standalone Stable Audio 3 Stage from an explicitly selected Raw Mixdown', () => {
    const preparation = prepareAutoPatchProductionRun(
      createRawMixdownStableAudio3ProductionProject(),
      {
        createdAt,
        planId: 'plan-production-sa3-master',
        runId: 'run-production-sa3-master',
        standalonePatchTabId: 'stable-audio-3',
        verifiedAudioArtifactIds: [rawMixdownArtifactId],
        verifiedSoundFontResources: [],
      },
    );

    expect(preparation).toMatchObject({
      canRun: true,
      coordinator: {
        activeStage: {
          artifactInputs: [
            {
              artifactIds: [rawMixdownArtifactId],
              clipTakeIds: [rawMixdownClipTakeId],
              portId: 'audio-in',
            },
          ],
          scope: {
            familyId: 'standalone-stable-audio-3:stable-audio-3',
            stageId: 'stable-audio-3',
            targetClipId: rawMixdownClipId,
          },
        },
        status: 'READY',
      },
      stageCount: 1,
      targetClipIds: [rawMixdownClipId],
      verifiedAudioArtifactIds: [rawMixdownArtifactId],
      verifiedSoundFontResources: [],
      status: 'RUN_READY',
    });
  });

  it('runs an explicitly selected standalone SA3 Stage without executing an unrelated connected MIDI Flow', () => {
    const rawMixProject = createRawMixdownStableAudio3ProductionProject();
    const midiFlowProject = createProductionProject();
    const project = {
      ...rawMixProject,
      connections: midiFlowProject.connections,
      patchTabs: [
        ...midiFlowProject.patchTabs,
        ...rawMixProject.patchTabs,
      ],
      tabFlowLines: midiFlowProject.tabFlowLines,
    };
    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-production-explicit-sa3-master',
      runId: 'run-production-explicit-sa3-master',
      standalonePatchTabId: 'stable-audio-3',
      verifiedAudioArtifactIds: [rawMixdownArtifactId],
      verifiedSoundFontResources: [],
    });

    expect(preparation).toMatchObject({
      canRun: true,
      coordinator: {
        activeStage: {
          scope: {
            familyId: 'standalone-stable-audio-3:stable-audio-3',
            stageId: 'stable-audio-3',
          },
        },
      },
      stageCount: 1,
    });

    const implicit = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-production-implicit-mixed-flow',
      runId: 'run-production-implicit-mixed-flow',
      verifiedAudioArtifactIds: [rawMixdownArtifactId],
      verifiedSoundFontResources: [],
    });

    expect(implicit).toMatchObject({
      canRun: false,
      cause: 'soundfont-resource-unavailable',
      reason: 'runtime-profile-rejected',
    });
  });

  it('rejects an explicit PatchTab that is not one exact standalone SA3 Stage', () => {
    const preparation = prepareAutoPatchProductionRun(
      createRawMixdownStableAudio3ProductionProject(),
      {
        createdAt,
        planId: 'plan-production-missing-standalone',
        runId: 'run-production-missing-standalone',
        standalonePatchTabId: 'missing-sa3',
        verifiedAudioArtifactIds: [rawMixdownArtifactId],
        verifiedSoundFontResources: [],
      },
    );

    expect(preparation).toMatchObject({
      canRun: false,
      cause: 'standalone-stable-audio-3-unavailable',
      reason: 'preflight-plan-rejected',
    });
  });

  it('keeps a standalone Raw Mixdown source fail-closed until its WAV is verified', () => {
    const preparation = prepareAutoPatchProductionRun(
      createRawMixdownStableAudio3ProductionProject(),
      {
        createdAt,
        planId: 'plan-production-sa3-master-unverified',
        runId: 'run-production-sa3-master-unverified',
        verifiedAudioArtifactIds: [],
        verifiedSoundFontResources: [],
      },
    );

    expect(preparation).toMatchObject({
      canRun: false,
      cause: 'active-source-unavailable',
      reason: 'preflight-plan-rejected',
      status: 'BLOCKED',
    });
  });

  it('blocks an invalid Stable Audio 3 parameter before Driver allocation', () => {
    const project = createProductionProject({
      includeStableAudio3: true,
    });
    const stableAudio3 = project.patchTabs.find(
      (patchTab) => patchTab.id === 'stable-audio-3',
    );

    if (!stableAudio3) {
      throw new Error('Stable Audio 3 PatchTab is missing.');
    }

    stableAudio3.parameters = stableAudio3.parameters.map((parameter) =>
      parameter.id === 'strength' && parameter.kind === 'slider'
        ? { ...parameter, value: 1.5 }
        : parameter,
    );

    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt,
      planId: 'plan-production-stable-audio-3',
      runId: 'run-production-stable-audio-3',
      verifiedAudioArtifactIds: [],
      verifiedSoundFontResources: [soundFont],
    });

    expect(preparation).toMatchObject({
      canRun: false,
      cause: 'stable-audio-3-strength-invalid',
      reason: 'runtime-profile-rejected',
      status: 'BLOCKED',
    });
  });
});
