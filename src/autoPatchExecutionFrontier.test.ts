import { describe, expect, it } from 'vitest';
import {
  createAutoPatchExecutionFrontier,
} from './autoPatchExecutionFrontier';
import {
  createCompletedResult,
  createRuntimeTarget,
  createScope,
  createValidatedPreflight,
  editedArtifactId,
  editedClipTakeId,
  instrumentArtifactId,
  instrumentClipTakeId,
  requireDefinition,
  requireFrontier,
  sourceArtifactId,
  sourceClipTakeId,
  stageInstrumentId,
  stageMidiEditId,
  targetClipId,
} from './autoPatchExecutionFrontier.testFixture';
import { validateAutoPatchPortBindings } from './autoPatchPortBindingValidation';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';

describe('Auto Patch execution frontier', () => {
  it('advances from the earliest executable Stage as exact outputs become reusable', () => {
    const validatedPreflight = createValidatedPreflight();
    const first = createAutoPatchExecutionFrontier({
      runtimeTargets: [createRuntimeTarget()],
      stageResults: [],
      validatedPreflight,
    });

    expect(first).toMatchObject({
      canPlan: true,
      frontier: {
        targets: [
          {
            families: [
              {
                stages: [
                  {
                    action: 'execute',
                    reasons: ['missing-result'],
                    artifactInputs: [
                      {
                        portId: 'midi-in',
                        artifactIds: [sourceArtifactId],
                        clipTakeIds: [sourceClipTakeId],
                        midi: {
                          contentHash: 'source-hash',
                          revision: 1,
                        },
                      },
                    ],
                  },
                  {
                    action: 'pending',
                    waitingForStageIds: [stageMidiEditId],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    if (!first.canPlan) {
      throw new Error(first.message);
    }

    const firstStages =
      first.frontier.targets[0].families[0].stages;
    const midiEditFingerprint = firstStages[0].fingerprint;

    if (!midiEditFingerprint) {
      throw new Error('MIDI EDIT fingerprint is required');
    }

    const midiEditResult = createCompletedResult(
      createScope(stageMidiEditId),
      midiEditFingerprint,
      'result-midi-edit',
      [editedArtifactId],
      [editedClipTakeId],
    );
    const second = createAutoPatchExecutionFrontier({
      runtimeTargets: [
        createRuntimeTarget({
          artifactIds: [editedArtifactId],
          artifactIdentities: [
            {
              artifactId: editedArtifactId,
              mediaType: 'midi',
              midi: {
                contentHash: 'edited-hash',
                revision: 2,
              },
            },
          ],
          clipTakeIds: [editedClipTakeId],
        }),
      ],
      stageResults: [midiEditResult],
      validatedPreflight,
    });

    expect(second).toMatchObject({
      canPlan: true,
      frontier: {
        targets: [
          {
            families: [
              {
                stages: [
                  {
                    action: 'reuse',
                    matchedResult: {
                      resultId: 'result-midi-edit',
                    },
                  },
                  {
                    action: 'execute',
                    reasons: ['missing-result'],
                    artifactInputs: [
                      {
                        portId: 'midi-in',
                        artifactIds: [editedArtifactId],
                        clipTakeIds: [editedClipTakeId],
                        midi: {
                          contentHash: 'edited-hash',
                          revision: 2,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    if (!second.canPlan) {
      throw new Error(second.message);
    }

    const instrumentFingerprint =
      second.frontier.targets[0].families[0].stages[1].fingerprint;

    if (!instrumentFingerprint) {
      throw new Error('MIDI TO AUDIO fingerprint is required');
    }

    const instrumentResult = createCompletedResult(
      createScope(stageInstrumentId),
      instrumentFingerprint,
      'result-instrument',
      [instrumentArtifactId],
      [instrumentClipTakeId],
    );
    const third = createAutoPatchExecutionFrontier({
      runtimeTargets: [
        createRuntimeTarget({
          artifactIds: [editedArtifactId, instrumentArtifactId],
          artifactIdentities: [
            {
              artifactId: editedArtifactId,
              mediaType: 'midi',
              midi: {
                contentHash: 'edited-hash',
                revision: 2,
              },
            },
          ],
          clipTakeIds: [
            editedClipTakeId,
            instrumentClipTakeId,
          ],
        }),
      ],
      stageResults: [midiEditResult, instrumentResult],
      validatedPreflight,
    });

    expect(third).toMatchObject({
      canPlan: true,
      frontier: {
        targets: [
          {
            families: [
              {
                stages: [
                  { action: 'reuse' },
                  { action: 'reuse' },
                ],
              },
            ],
          },
        ],
      },
    });

    if (!third.canPlan) {
      throw new Error(third.message);
    }

    expect(Object.isFrozen(third.frontier)).toBe(true);
    expect(
      Object.isFrozen(
        third.frontier.targets[0].families[0].stages,
      ),
    ).toBe(true);
  });

  it('invalidates the earliest changed Stage and keeps downstream fingerprints pending', () => {
    const baseline = createValidatedPreflight();
    const baselineFirst = requireFrontier(
      createAutoPatchExecutionFrontier({
        runtimeTargets: [createRuntimeTarget()],
        stageResults: [],
        validatedPreflight: baseline,
      }),
    );
    const baselineMidiEditFingerprint =
      baselineFirst.targets[0].families[0].stages[0].fingerprint;

    if (!baselineMidiEditFingerprint) {
      throw new Error('Baseline MIDI EDIT fingerprint is required');
    }

    const midiEditResult = createCompletedResult(
      createScope(stageMidiEditId),
      baselineMidiEditFingerprint,
      'result-midi-edit',
      [editedArtifactId],
      [editedClipTakeId],
    );
    const changed = createAutoPatchExecutionFrontier({
      runtimeTargets: [
        createRuntimeTarget({
          artifactIds: [editedArtifactId],
          artifactIdentities: [
            {
              artifactId: editedArtifactId,
              mediaType: 'midi',
              midi: {
                contentHash: 'edited-hash',
                revision: 2,
              },
            },
          ],
          clipTakeIds: [editedClipTakeId],
        }),
      ],
      stageResults: [midiEditResult],
      validatedPreflight: createValidatedPreflight({
        sourceContentHash: 'source-hash-changed',
        sourceRevision: 2,
      }),
    });

    expect(changed).toMatchObject({
      canPlan: true,
      frontier: {
        targets: [
          {
            families: [
              {
                stages: [
                  {
                    action: 'execute',
                    reasons: ['fingerprint-changed'],
                  },
                  {
                    action: 'pending',
                    fingerprint: null,
                    reasons: ['upstream-changed'],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it('changes only MIDI TO AUDIO when its verified resource selection changes', () => {
    const baseline = createValidatedPreflight();
    const first = requireFrontier(
      createAutoPatchExecutionFrontier({
        runtimeTargets: [createRuntimeTarget()],
        stageResults: [],
        validatedPreflight: baseline,
      }),
    );
    const midiEditFingerprint =
      first.targets[0].families[0].stages[0].fingerprint;

    if (!midiEditFingerprint) {
      throw new Error('MIDI EDIT fingerprint is required');
    }

    const midiEditResult = createCompletedResult(
      createScope(stageMidiEditId),
      midiEditFingerprint,
      'result-midi-edit',
      [editedArtifactId],
      [editedClipTakeId],
    );
    const runtimeTarget = createRuntimeTarget({
      artifactIds: [editedArtifactId, instrumentArtifactId],
      artifactIdentities: [
        {
          artifactId: editedArtifactId,
          mediaType: 'midi',
          midi: {
            contentHash: 'edited-hash',
            revision: 2,
          },
        },
      ],
      clipTakeIds: [editedClipTakeId, instrumentClipTakeId],
    });
    const second = requireFrontier(
      createAutoPatchExecutionFrontier({
        runtimeTargets: [runtimeTarget],
        stageResults: [midiEditResult],
        validatedPreflight: baseline,
      }),
    );
    const instrumentFingerprint =
      second.targets[0].families[0].stages[1].fingerprint;

    if (!instrumentFingerprint) {
      throw new Error('MIDI TO AUDIO fingerprint is required');
    }

    const instrumentResult = createCompletedResult(
      createScope(stageInstrumentId),
      instrumentFingerprint,
      'result-instrument',
      [instrumentArtifactId],
      [instrumentClipTakeId],
    );
    const changed = createAutoPatchExecutionFrontier({
      runtimeTargets: [runtimeTarget],
      stageResults: [midiEditResult, instrumentResult],
      validatedPreflight: createValidatedPreflight({ program: 1 }),
    });

    expect(changed).toMatchObject({
      canPlan: true,
      frontier: {
        targets: [
          {
            families: [
              {
                stages: [
                  { action: 'reuse' },
                  {
                    action: 'execute',
                    reasons: ['fingerprint-changed'],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it('refuses a connected reusable MIDI result without exact content identity', () => {
    const validatedPreflight = createValidatedPreflight();
    const first = requireFrontier(
      createAutoPatchExecutionFrontier({
        runtimeTargets: [createRuntimeTarget()],
        stageResults: [],
        validatedPreflight,
      }),
    );
    const fingerprint =
      first.targets[0].families[0].stages[0].fingerprint;

    if (!fingerprint) {
      throw new Error('MIDI EDIT fingerprint is required');
    }

    const result = createCompletedResult(
      createScope(stageMidiEditId),
      fingerprint,
      'result-midi-edit',
      [editedArtifactId],
      [editedClipTakeId],
    );
    const resolution = createAutoPatchExecutionFrontier({
      runtimeTargets: [
        createRuntimeTarget({
          artifactIds: [editedArtifactId],
          clipTakeIds: [editedClipTakeId],
        }),
      ],
      stageResults: [result],
      validatedPreflight,
    });

    expect(resolution).toMatchObject({
      canPlan: false,
      reason: 'fingerprint-unavailable',
      cause: 'midi-identity-missing',
      scope: {
        stageId: stageInstrumentId,
      },
    });
  });

  it('accepts Audio or MIDI Timeline Selection for the Clip Filer media Port', () => {
    const definition = requireDefinition(
      BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
    );
    const patchTab = {
      id: 'stage-clip-filer',
      inputBindings: [
        {
          kind: 'timeline-selection' as const,
          portId: 'media-in',
          selectionKind: 'clip' as const,
        },
      ],
      name: 'Clip Filer',
      nodeTypeId: definition.nodeTypeId,
      nodeVersion: definition.nodeVersion,
      parameters: [],
      portContract: definition,
    };

    expect(
      validateAutoPatchPortBindings(patchTab, [], {
        clipId: targetClipId,
        mediaType: 'audio',
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateAutoPatchPortBindings(patchTab, [], {
        clipId: targetClipId,
        mediaType: 'midi',
      }),
    ).toMatchObject({ ok: true });
  });
});
