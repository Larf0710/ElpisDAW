import { describe, expect, it } from 'vitest';

import {
  createAutoPatchRuntimeCoordinator,
  type AutoPatchRuntimeCoordinatorResolution,
} from './autoPatchRuntimeCoordinator';
import {
  validateAutoPatchProductionCapabilityPreflight,
  type AutoPatchReadyRuntimeCoordinator,
} from './autoPatchProductionCapabilityPreflight';
import {
  createCompletedResult,
  createRuntimeTarget,
  createScope,
  createValidatedPreflight,
  editedArtifactId,
  editedClipTakeId,
  stageInstrumentId,
  stageMidiEditId,
} from './autoPatchExecutionFrontier.testFixture';
import { sampleProject } from './sampleProject';
import type { AutoPatchValidatedPreflight } from './autoPatchStagePreflight';

const createdAt = '2026-08-01T00:00:00.000Z';

describe('Auto Patch production capability preflight', () => {
  it('proves one supported Family before the first attempt', () => {
    const coordinator = createReadyCoordinator(
      createValidatedPreflight(),
      [createRuntimeTarget()],
    );
    const resolution =
      validateAutoPatchProductionCapabilityPreflight(
        sampleProject,
        coordinator,
      );

    expect(resolution).toMatchObject({
      canStart: true,
      coordinator,
      family: {
        familyId: 'family-main',
        familyRevision: 1,
      },
      project: sampleProject,
      stageScopes: [
        { stageId: stageMidiEditId },
        { stageId: stageInstrumentId },
      ],
      status: 'READY',
      targetClipIds: ['clip-midi'],
    });
    expect(coordinator.attempts).toHaveLength(0);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(
      resolution.canStart && Object.isFrozen(resolution.stageScopes),
    ).toBe(true);
  });

  it('preserves canonical target order for more than one Clip', () => {
    const targetClipIds = ['clip-midi-b', 'clip-midi-a'];
    const validatedPreflight = createMultiTargetValidatedPreflight(
      targetClipIds,
    );
    const runtimeTargets = validatedPreflight.plan.graphSnapshot.targets
      .map((target) => ({
        artifactIdentities: [],
        availability: {
          artifactIds: [target.activeTake.artifactId],
          clipTakeIds: [target.activeTake.clipTakeId],
        },
        targetClipId: target.clipId,
      }))
      .reverse();
    const coordinator = createReadyCoordinator(
      validatedPreflight,
      runtimeTargets,
    );

    expect(
      validateAutoPatchProductionCapabilityPreflight(
        sampleProject,
        coordinator,
      ),
    ).toMatchObject({
      canStart: true,
      targetClipIds,
      stageScopes: [
        { targetClipId: 'clip-midi-b', stageId: stageMidiEditId },
        { targetClipId: 'clip-midi-b', stageId: stageInstrumentId },
        { targetClipId: 'clip-midi-a', stageId: stageMidiEditId },
        { targetClipId: 'clip-midi-a', stageId: stageInstrumentId },
      ],
    });
  });

  it('blocks multiple independent Families without allocating an attempt', () => {
    const coordinator = createReadyCoordinator(
      createMultiFamilyValidatedPreflight(),
      [createRuntimeTarget()],
    );
    const attempts = coordinator.attempts;
    const resolution =
      validateAutoPatchProductionCapabilityPreflight(
        sampleProject,
        coordinator,
      );

    expect(resolution).toMatchObject({
      canStart: false,
      cause: 'production-driver-family-count-unsupported',
      coordinator,
      project: sampleProject,
      reason: 'multi-family-driver-not-supported',
      status: 'BLOCKED',
    });
    expect(resolution.coordinator).toBe(coordinator);
    expect(resolution.project).toBe(sampleProject);
    expect(coordinator.status).toBe('READY');
    expect(coordinator.activeAttempt).toBeNull();
    expect(coordinator.attempts).toBe(attempts);
    expect(coordinator.attempts).toHaveLength(0);
  });

  it.each([
    [stageMidiEditId, 'execute'],
    [stageInstrumentId, 'pending'],
  ] as const)(
    'blocks unsupported %s scope while it is %s',
    (stageId, action) => {
      const validatedPreflight = withUnsupportedStage(
        createValidatedPreflight(),
        stageId,
      );
      const coordinator = createReadyCoordinator(
        validatedPreflight,
        [createRuntimeTarget()],
      );
      const blockedStage = coordinator.frontier.targets[0].families[0]
        .stages.find((stage) => stage.scope.stageId === stageId);
      const attempts = coordinator.attempts;
      const resolution =
        validateAutoPatchProductionCapabilityPreflight(
          sampleProject,
          coordinator,
        );

      expect(blockedStage?.action).toBe(action);
      expect(resolution).toMatchObject({
        canStart: false,
        cause: 'production-stage-unsupported',
        coordinator,
        project: sampleProject,
        reason: 'unsupported-stage',
        scope: { stageId },
        status: 'BLOCKED',
      });
      expect(resolution.coordinator).toBe(coordinator);
      expect(resolution.project).toBe(sampleProject);
      expect(coordinator.status).toBe('READY');
      expect(coordinator.activeAttempt).toBeNull();
      expect(coordinator.attempts).toBe(attempts);
      expect(coordinator.attempts).toHaveLength(0);
    },
  );

  it('does not block an unsupported Stage whose exact result is reusable', () => {
    const validatedPreflight = withUnsupportedStage(
      createValidatedPreflight(),
      stageMidiEditId,
    );
    const firstCoordinator = createReadyCoordinator(
      validatedPreflight,
      [createRuntimeTarget()],
    );
    const reusableResult = createCompletedResult(
      createScope(stageMidiEditId),
      firstCoordinator.activeStage.fingerprint,
      'result-unsupported-reused',
      [editedArtifactId],
      [editedClipTakeId],
    );
    const coordinator = createReadyCoordinator(
      validatedPreflight,
      [
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
      [reusableResult],
    );
    const resolution =
      validateAutoPatchProductionCapabilityPreflight(
        sampleProject,
        coordinator,
      );

    expect(coordinator.frontier.targets[0].families[0].stages).toMatchObject([
      { action: 'reuse', scope: { stageId: stageMidiEditId } },
      { action: 'execute', scope: { stageId: stageInstrumentId } },
    ]);
    expect(resolution).toMatchObject({
      canStart: true,
      stageScopes: [{ stageId: stageInstrumentId }],
      status: 'READY',
    });
  });
});

function createReadyCoordinator(
  validatedPreflight: AutoPatchValidatedPreflight,
  runtimeTargets: Parameters<
    typeof createAutoPatchRuntimeCoordinator
  >[0]['runtimeTargets'],
  stageResults: Parameters<
    typeof createAutoPatchRuntimeCoordinator
  >[0]['stageResults'] = [],
): AutoPatchReadyRuntimeCoordinator {
  const resolution = createAutoPatchRuntimeCoordinator({
    createdAt,
    runId: 'run-production-capability',
    runtimeTargets,
    stageResults,
    validatedPreflight,
  });
  const coordinator = requireCoordinator(resolution);

  if (coordinator.status !== 'READY') {
    throw new Error('Expected a READY production capability fixture.');
  }

  return coordinator;
}

function createMultiTargetValidatedPreflight(
  targetClipIds: readonly string[],
): AutoPatchValidatedPreflight {
  const base = createValidatedPreflight();
  const baseTarget = base.plan.graphSnapshot.targets[0];
  const baseTargetPlan = base.plan.targetPlans[0];
  const targets = targetClipIds.map((targetClipId, index) => {
    const suffix = index + 1;

    return {
      ...baseTarget,
      activeTake: {
        ...baseTarget.activeTake,
        artifactId: `artifact-midi-source-${suffix}`,
        clipTakeId: `take-midi-source-${suffix}`,
        contentHash: `source-hash-${suffix}`,
      },
      clipId: targetClipId,
      trackId: `track-midi-${suffix}`,
    };
  });
  const targetPlans = targets.map((target) => ({
    ...baseTargetPlan,
    availability: {
      artifactIds: [target.activeTake.artifactId],
      clipTakeIds: [target.activeTake.clipTakeId],
    },
    families: baseTargetPlan.families.map((family) => ({
      ...family,
      stages: family.stages.map((stage) => ({
        ...stage,
        scope: {
          ...stage.scope,
          targetClipId: target.clipId,
        },
      })),
    })),
    targetClipId: target.clipId,
  }));

  return {
    ...base,
    plan: {
      ...base.plan,
      graphSnapshot: {
        ...base.plan.graphSnapshot,
        targetClipIds: [...targetClipIds],
        targets,
      },
      targetPlans,
    },
    stages: targetClipIds.flatMap((targetClipId) =>
      base.stages.map((stage) => ({
        ...stage,
        scope: { ...stage.scope, targetClipId },
      })),
    ),
  };
}

function createMultiFamilyValidatedPreflight(): AutoPatchValidatedPreflight {
  const base = createValidatedPreflight();
  const baseFamily = base.plan.graphSnapshot.families[0];
  const baseFamilyPlan = base.plan.targetPlans[0].families[0];
  const secondFamilyId = 'family-secondary';
  const secondMidiEditId = 'stage-midi-edit-secondary';
  const secondInstrumentId = 'stage-instrument-secondary';
  const secondConnectionId = 'connection-midi-instrument-secondary';
  const stageIdMap = new Map([
    [stageMidiEditId, secondMidiEditId],
    [stageInstrumentId, secondInstrumentId],
  ]);
  const connectionIdMap = new Map([
    ['connection-midi-instrument', secondConnectionId],
  ]);
  const secondFamily = {
    ...baseFamily,
    connectionOrder: [secondConnectionId],
    connections: baseFamily.connections.map((connection) => ({
      ...connection,
      fromPatchTabId:
        stageIdMap.get(connection.fromPatchTabId) ??
        connection.fromPatchTabId,
      id: connectionIdMap.get(connection.id) ?? connection.id,
      toPatchTabId:
        stageIdMap.get(connection.toPatchTabId) ??
        connection.toPatchTabId,
    })),
    familyId: secondFamilyId,
    lineOrder: [secondFamilyId],
    lines: baseFamily.lines.map((line) => ({
      ...line,
      connectionIds: line.connectionIds.map(
        (connectionId) =>
          connectionIdMap.get(connectionId) ?? connectionId,
      ),
      id: secondFamilyId,
      order: 2,
    })),
    order: 2,
    patchTabOrder: baseFamily.patchTabOrder.map(
      (stageId) => stageIdMap.get(stageId) ?? stageId,
    ),
    patchTabs: baseFamily.patchTabs.map((patchTab) => ({
      ...patchTab,
      id: stageIdMap.get(patchTab.id) ?? patchTab.id,
      inputBindings: patchTab.inputBindings.map((binding) =>
        binding.kind === 'connection'
          ? {
              ...binding,
              connectionIds: binding.connectionIds.map(
                (connectionId) =>
                  connectionIdMap.get(connectionId) ?? connectionId,
              ),
            }
          : { ...binding },
      ),
    })),
  };
  const secondFamilyPlan = {
    ...baseFamilyPlan,
    familyId: secondFamilyId,
    stages: baseFamilyPlan.stages.map((stage) => ({
      ...stage,
      dependsOnStageIds: stage.dependsOnStageIds.map(
        (stageId) => stageIdMap.get(stageId) ?? stageId,
      ),
      incomingConnectionIds: stage.incomingConnectionIds.map(
        (connectionId) =>
          connectionIdMap.get(connectionId) ?? connectionId,
      ),
      scope: {
        ...stage.scope,
        familyId: secondFamilyId,
        stageId: stageIdMap.get(stage.scope.stageId) ?? stage.scope.stageId,
      },
    })),
  };

  return {
    ...base,
    plan: {
      ...base.plan,
      graphSnapshot: {
        ...base.plan.graphSnapshot,
        families: [...base.plan.graphSnapshot.families, secondFamily],
        familyOrder: [
          ...base.plan.graphSnapshot.familyOrder,
          secondFamilyId,
        ],
      },
      targetPlans: base.plan.targetPlans.map((targetPlan) => ({
        ...targetPlan,
        families: [...targetPlan.families, secondFamilyPlan],
      })),
    },
    stages: [
      ...base.stages,
      ...base.stages.map((stage) => ({
        ...stage,
        portBindings: stage.portBindings.map((binding) => ({
          ...binding,
          connectionIds: binding.connectionIds.map(
            (connectionId) =>
              connectionIdMap.get(connectionId) ?? connectionId,
          ),
        })),
        scope: {
          ...stage.scope,
          familyId: secondFamilyId,
          stageId: stageIdMap.get(stage.scope.stageId) ?? stage.scope.stageId,
        },
      })),
    ],
  };
}

function withUnsupportedStage(
  preflight: AutoPatchValidatedPreflight,
  stageId: string,
): AutoPatchValidatedPreflight {
  return {
    ...preflight,
    plan: {
      ...preflight.plan,
      graphSnapshot: {
        ...preflight.plan.graphSnapshot,
        families: preflight.plan.graphSnapshot.families.map((family) => ({
          ...family,
          patchTabs: family.patchTabs.map((patchTab) =>
            patchTab.id === stageId
              ? {
                  ...patchTab,
                  nodeTypeId: 'test.unsupported-stage',
                }
              : patchTab,
          ),
        })),
      },
    },
  };
}

function requireCoordinator(
  resolution: AutoPatchRuntimeCoordinatorResolution,
) {
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }

  return resolution.coordinator;
}
