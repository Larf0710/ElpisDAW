import { describe, expect, it } from 'vitest';

import {
  createTabFlowStageFingerprint,
  planChangedTabFlowStages,
  type TabFlowStageCandidate,
  type TabFlowStageFingerprintInput,
} from './tabFlowChangedStage';

function createFingerprintInput(
  overrides: Partial<TabFlowStageFingerprintInput> = {},
): TabFlowStageFingerprintInput {
  return {
    artifactInputs: [
      {
        portId: 'midi-in',
        artifactIds: ['artifact-midi'],
        clipTakeIds: ['take-midi'],
        midi: {
          contentHash: 'fnv1a64-midi',
          revision: 3,
        },
      },
    ],
    node: {
      patchTabId: 'instrument',
      nodeTypeId: 'humstudio.patch.instrument',
      nodeVersion: '1.0.0',
      parameters: {
        gain: 0,
        normalize: 'off',
      },
    },
    projectContext: {
      bpm: 120,
      selectedClipId: 'clip-midi',
    },
    provider: {
      providerId: 'local-fluidsynth',
      providerRevision: '2.5.7',
      taskId: 'midi-to-audio',
      modelId: 'fluidsynth',
      modelRevision: '2.5.7',
    },
    resourceInputs: [
      {
        portId: 'soundfont-in',
        resourceId: 'soundfont-piano',
        revision: 'size-1234-mtime-5678',
        selections: {
          bank: 0,
          program: 0,
        },
      },
    ],
    ...overrides,
  };
}

function createStage(
  stageId: string,
  dependsOnStageIds: readonly string[],
  fingerprint = `${stageId}-fingerprint`,
): TabFlowStageCandidate {
  return {
    stageId,
    dependsOnStageIds,
    fingerprint,
  };
}

describe('TabFlow changed-stage planning', () => {
  it('creates the same fingerprint for equivalent key and Port ordering', () => {
    const first = createTabFlowStageFingerprint(createFingerprintInput());
    const reorderedInput = reorderedFingerprintInput();
    const reordered = createTabFlowStageFingerprint(reorderedInput);
    const sameInputsDifferentOrder = createTabFlowStageFingerprint({
      ...reorderedInput,
      artifactInputs: [...reorderedInput.artifactInputs].reverse(),
    });

    expect(reordered).toBe(sameInputsDifferentOrder);
    expect(first).not.toBe(reordered);
    expect(first).toMatch(/^tabflow-fnv1a64-[0-9a-f]{16}$/);
  });

  it('changes the fingerprint for Active Takes, MIDI revisions, and SoundFont selections', () => {
    const original = createTabFlowStageFingerprint(createFingerprintInput());
    const activeTakeChanged = createTabFlowStageFingerprint(
      createFingerprintInput({
        artifactInputs: [
          {
            ...createFingerprintInput().artifactInputs[0],
            clipTakeIds: ['take-midi-edited'],
          },
        ],
      }),
    );
    const midiEdited = createTabFlowStageFingerprint(
      createFingerprintInput({
        artifactInputs: [
          {
            ...createFingerprintInput().artifactInputs[0],
            midi: {
              contentHash: 'fnv1a64-edited-midi',
              revision: 4,
            },
          },
        ],
      }),
    );
    const programChanged = createTabFlowStageFingerprint(
      createFingerprintInput({
        resourceInputs: [
          {
            ...createFingerprintInput().resourceInputs[0],
            selections: {
              bank: 0,
              program: 24,
            },
          },
        ],
      }),
    );
    const providerChanged = createTabFlowStageFingerprint(
      createFingerprintInput({
        provider: {
          ...createFingerprintInput().provider!,
          providerRevision: '2.6.0',
        },
      }),
    );

    expect(activeTakeChanged).not.toBe(original);
    expect(midiEdited).not.toBe(original);
    expect(programChanged).not.toBe(original);
    expect(providerChanged).not.toBe(original);
  });

  it('reuses clean MIDI EDIT output and starts at MIDI TO AUDIO after a Piano Roll edit', () => {
    const stages = [
      createStage('hum-prep', []),
      createStage('hum-to-midi', ['hum-prep']),
      createStage('midi-edit', ['hum-to-midi']),
      createStage('midi-to-audio', ['midi-edit'], 'edited-active-take'),
      createStage('sa3', ['midi-to-audio']),
    ];
    const reusableResults = stages.map((stage) => ({
      stageId: stage.stageId,
      fingerprint:
        stage.stageId === 'midi-to-audio'
          ? 'previous-active-take'
          : stage.fingerprint,
      isAvailable: true,
    }));

    expect(planChangedTabFlowStages(stages, reusableResults)).toEqual([
      expect.objectContaining({ stageId: 'hum-prep', action: 'reuse' }),
      expect.objectContaining({ stageId: 'hum-to-midi', action: 'reuse' }),
      expect.objectContaining({ stageId: 'midi-edit', action: 'reuse' }),
      expect.objectContaining({
        stageId: 'midi-to-audio',
        action: 'execute',
        reasons: ['fingerprint-changed'],
      }),
      expect.objectContaining({
        stageId: 'sa3',
        action: 'execute',
        reasons: ['upstream-changed'],
      }),
    ]);
  });

  it('executes a stage and its dependents when a reusable result is missing', () => {
    const stages = [
      createStage('source', []),
      createStage('convert', ['source']),
      createStage('render', ['convert']),
    ];

    expect(
      planChangedTabFlowStages(stages, [
        {
          stageId: 'source',
          fingerprint: 'source-fingerprint',
          isAvailable: true,
        },
        {
          stageId: 'render',
          fingerprint: 'render-fingerprint',
          isAvailable: true,
        },
      ]),
    ).toEqual([
      expect.objectContaining({ stageId: 'source', action: 'reuse' }),
      expect.objectContaining({
        stageId: 'convert',
        action: 'execute',
        reasons: ['missing-result'],
      }),
      expect.objectContaining({
        stageId: 'render',
        action: 'execute',
        reasons: ['upstream-changed'],
      }),
    ]);
  });

  it('does not dirty an independent branch', () => {
    const stages = [
      createStage('source', []),
      createStage('branch-a', ['source'], 'branch-a-new'),
      createStage('branch-b', ['source']),
    ];

    expect(
      planChangedTabFlowStages(stages, [
        {
          stageId: 'source',
          fingerprint: 'source-fingerprint',
          isAvailable: true,
        },
        {
          stageId: 'branch-a',
          fingerprint: 'branch-a-old',
          isAvailable: true,
        },
        {
          stageId: 'branch-b',
          fingerprint: 'branch-b-fingerprint',
          isAvailable: true,
        },
      ]).map(({ stageId, action }) => [stageId, action]),
    ).toEqual([
      ['source', 'reuse'],
      ['branch-a', 'execute'],
      ['branch-b', 'reuse'],
    ]);
  });

  it('returns an immutable reuse plan snapshot', () => {
    const plan = planChangedTabFlowStages(
      [createStage('source', [])],
      [
        {
          stageId: 'source',
          fingerprint: 'source-fingerprint',
          isAvailable: true,
        },
      ],
    );

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan[0])).toBe(true);
    expect(Object.isFrozen(plan[0].reasons)).toBe(true);
  });

  it('rejects a dependency that is not in topological order', () => {
    expect(() =>
      planChangedTabFlowStages(
        [
          createStage('midi-to-audio', ['midi-edit']),
          createStage('midi-edit', []),
        ],
        [],
      ),
    ).toThrow(
      'TabFlow stage midi-to-audio depends on midi-edit before it is planned',
    );
  });
});

function reorderedFingerprintInput(): TabFlowStageFingerprintInput {
  return createFingerprintInput({
    artifactInputs: [
      {
        portId: 'soundfont-sidechain',
        artifactIds: ['artifact-sidechain'],
        clipTakeIds: ['take-sidechain'],
      },
      ...createFingerprintInput().artifactInputs,
    ],
    node: {
      patchTabId: 'instrument',
      nodeTypeId: 'humstudio.patch.instrument',
      nodeVersion: '1.0.0',
      parameters: {
        normalize: 'off',
        gain: 0,
      },
    },
    projectContext: {
      selectedClipId: 'clip-midi',
      bpm: 120,
    },
  });
}
