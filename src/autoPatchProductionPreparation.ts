import {
  createAutoPatchPreflightPlan,
} from './autoPatchPreflightPlan';
import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import {
  validateAutoPatchProductionCapabilityPreflight,
} from './autoPatchProductionCapabilityPreflight';
import {
  createAutoPatchRuntimeCoordinator,
  type AutoPatchReadyRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import {
  validateAutoPatchStagePreflight,
  type AutoPatchVerifiedStageRuntimeProfile,
} from './autoPatchStagePreflight';
import type { AutoPatchRuntimeTargetSnapshot } from './autoPatchExecutionFrontier';
import {
  FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
  FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
} from './fluidSynthInstrumentRender';
import { INSTRUMENT_RENDER_TASK_ID } from './instrumentRenderContract';
import type { LocalEngineSoundFontResource } from './localEngineClient';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { resolveInstrumentSoundFont } from './soundFontPatchTab';
import type { ProjectArtifact, ProjectState } from './types';

export type AutoPatchProductionPreparationRequest = Readonly<{
  createdAt: string;
  fallbackClipId?: string;
  planId: string;
  runId: string;
  standalonePatchTabId?: string;
  verifiedAudioArtifactIds: readonly string[];
  verifiedSoundFontResources: readonly LocalEngineSoundFontResource[];
}>;

export type AutoPatchProductionPreparation =
  | Readonly<{
      canRun: true;
      coordinator: AutoPatchReadyRuntimeCoordinator;
      stageCount: number;
      targetClipIds: readonly string[];
      verifiedAudioArtifactIds: readonly string[];
      verifiedSoundFontResources: readonly LocalEngineSoundFontResource[];
      status: 'RUN_READY';
    }>
  | Readonly<{
      canRun: false;
      cause: string;
      message: string;
      reason:
        | 'preflight-plan-rejected'
        | 'runtime-profile-rejected'
        | 'coordinator-rejected'
        | 'production-capability-rejected';
      status: 'BLOCKED';
    }>;

export function prepareAutoPatchProductionRun(
  project: ProjectState,
  request: AutoPatchProductionPreparationRequest,
): AutoPatchProductionPreparation {
  const planning = createAutoPatchPreflightPlan(project, {
    createdAt: request.createdAt,
    ...(request.fallbackClipId
      ? { fallbackClipId: request.fallbackClipId }
      : {}),
    planId: request.planId,
    ...(request.standalonePatchTabId
      ? { standalonePatchTabId: request.standalonePatchTabId }
      : {}),
    verifiedAudioArtifactIds: request.verifiedAudioArtifactIds,
  });

  if (!planning.canPlan) {
    return blocked(
      'preflight-plan-rejected',
      planning.cause,
      planning.message,
    );
  }

  const profiles = createRuntimeProfiles(
    planning.plan,
    request.verifiedSoundFontResources,
  );

  if (!profiles.ok) {
    return blocked(
      'runtime-profile-rejected',
      profiles.cause,
      profiles.message,
    );
  }

  const stagePreflight = validateAutoPatchStagePreflight(
    planning.plan,
    profiles.profiles,
    request.verifiedSoundFontResources,
  );

  if (!stagePreflight.canValidate) {
    return blocked(
      'runtime-profile-rejected',
      stagePreflight.cause,
      stagePreflight.message,
    );
  }

  const coordinator = createAutoPatchRuntimeCoordinator({
    createdAt: request.createdAt,
    runId: request.runId,
    runtimeTargets: createRuntimeTargets(project, stagePreflight.validated),
    stageResults: project.tabFlowStageResults,
    validatedPreflight: stagePreflight.validated,
  });

  if (!coordinator.ok) {
    return blocked(
      'coordinator-rejected',
      coordinator.cause,
      coordinator.message,
    );
  }

  if (coordinator.coordinator.status !== 'READY') {
    return blocked(
      'production-capability-rejected',
      'production-run-no-executable-stage',
      'Auto Patch has no changed production Stage to run.',
    );
  }

  const capability = validateAutoPatchProductionCapabilityPreflight(
    project,
    coordinator.coordinator,
  );

  if (!capability.canStart) {
    return blocked(
      'production-capability-rejected',
      capability.cause,
      capability.message,
    );
  }

  return Object.freeze({
    canRun: true as const,
    coordinator: capability.coordinator,
    stageCount: capability.stageScopes.length,
    targetClipIds: Object.freeze([
      ...planning.plan.graphSnapshot.targetClipIds,
    ]),
    verifiedAudioArtifactIds: Object.freeze([
      ...request.verifiedAudioArtifactIds,
    ]),
    verifiedSoundFontResources: Object.freeze([
      ...request.verifiedSoundFontResources,
    ]),
    status: 'RUN_READY' as const,
  });
}

type RuntimeProfilePreparation =
  | Readonly<{
      ok: true;
      profiles: readonly AutoPatchVerifiedStageRuntimeProfile[];
    }>
  | Readonly<{
      cause: string;
      message: string;
      ok: false;
    }>;

function createRuntimeProfiles(
  plan: Parameters<typeof validateAutoPatchStagePreflight>[0],
  soundFonts: readonly LocalEngineSoundFontResource[],
): RuntimeProfilePreparation {
  const profiles: AutoPatchVerifiedStageRuntimeProfile[] = [];

  for (const targetPlan of plan.targetPlans) {
    const target = plan.graphSnapshot.targets.find(
      (candidate) => candidate.clipId === targetPlan.targetClipId,
    );

    if (!target) {
      return profileFailure(
        'production-target-snapshot-missing',
        `Target Clip ${targetPlan.targetClipId} is missing from the immutable graph snapshot.`,
      );
    }

    for (const familyPlan of targetPlan.families) {
      const family = plan.graphSnapshot.families.find(
        (candidate) =>
          candidate.familyId === familyPlan.familyId &&
          candidate.familyRevision === familyPlan.familyRevision,
      );

      if (!family) {
        return profileFailure(
          'production-family-snapshot-missing',
          `Flow Family ${familyPlan.familyId} is missing from the immutable graph snapshot.`,
        );
      }

      for (const stage of familyPlan.stages) {
        const patchTab = family.patchTabs.find(
          (candidate) => candidate.id === stage.scope.stageId,
        );

        if (!patchTab) {
          return profileFailure(
            'production-stage-snapshot-missing',
            `Stage ${stage.scope.stageId} is missing from the immutable graph snapshot.`,
          );
        }

        if (
          patchTab.nodeTypeId ===
          BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3
        ) {
          profiles.push({
            execution: {
              kind: 'provider',
              modelId: STABLE_AUDIO_3_MODEL_ID,
              modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
              providerId: STABLE_AUDIO_3_PROVIDER_ID,
              providerRevision:
                STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
              taskId: STABLE_AUDIO_3_TASK_ID,
            },
            resourceInputs: [],
            scope: { ...stage.scope },
          });
          continue;
        }

        if (patchTab.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.instrument) {
          profiles.push({
            execution: { kind: 'builtin' },
            resourceInputs: [],
            scope: { ...stage.scope },
          });
          continue;
        }

        const soundFontResolution = resolveInstrumentSoundFont(
          family.patchTabs,
          family.connections,
          patchTab.id,
          target.soundFont,
          soundFonts,
        );

        if (!soundFontResolution.canResolve) {
          return profileFailure(
            'soundfont-resource-unavailable',
            soundFontResolution.message,
          );
        }

        const { bank, program, resource: soundFont } =
          soundFontResolution.selection;
        profiles.push({
          execution: {
            kind: 'provider',
            modelId: soundFont.resourceId,
            modelRevision: soundFont.revisionToken,
            providerId: FLUIDSYNTH_INSTRUMENT_PROVIDER_ID,
            providerRevision: FLUIDSYNTH_INSTRUMENT_PROVIDER_VERSION,
            taskId: INSTRUMENT_RENDER_TASK_ID,
          },
          resourceInputs: [
            {
              portId: 'soundfont-in',
              resourceId: soundFont.resourceId,
              revision: soundFont.revisionToken,
              selections: {
                bank,
                program,
              },
            },
          ],
          scope: { ...stage.scope },
        });
      }
    }
  }

  return Object.freeze({
    ok: true as const,
    profiles: Object.freeze(profiles),
  });
}

function createRuntimeTargets(
  project: ProjectState,
  validated: Parameters<typeof createAutoPatchRuntimeCoordinator>[0]['validatedPreflight'],
): readonly AutoPatchRuntimeTargetSnapshot[] {
  const artifacts = project.artifacts ?? [];
  const artifactCounts = new Map<string, number>();

  artifacts.forEach((artifact) => {
    artifactCounts.set(
      artifact.artifactId,
      (artifactCounts.get(artifact.artifactId) ?? 0) + 1,
    );
  });

  return Object.freeze(
    validated.plan.targetPlans.map((targetPlan) => ({
      artifactIdentities: Object.freeze(
        targetPlan.availability.artifactIds
          .map((artifactId) =>
            artifactCounts.get(artifactId) === 1
              ? createArtifactIdentity(
                  artifacts.find(
                    (artifact) => artifact.artifactId === artifactId,
                  ),
                )
              : undefined,
          )
          .filter(
            (
              identity,
            ): identity is AutoPatchRuntimeTargetSnapshot['artifactIdentities'][number] =>
              identity !== undefined,
          ),
      ),
      availability: Object.freeze({
        artifactIds: Object.freeze([
          ...targetPlan.availability.artifactIds,
        ]),
        clipTakeIds: Object.freeze([
          ...targetPlan.availability.clipTakeIds,
        ]),
      }),
      targetClipId: targetPlan.targetClipId,
    })),
  );
}

function createArtifactIdentity(
  artifact: ProjectArtifact | undefined,
): AutoPatchRuntimeTargetSnapshot['artifactIdentities'][number] | undefined {
  if (!artifact) {
    return undefined;
  }

  if (artifact.kind === 'audio') {
    return Object.freeze({
      artifactId: artifact.artifactId,
      mediaType: 'audio' as const,
    });
  }

  const contentHash =
    'contentHash' in artifact ? artifact.contentHash : undefined;
  const revision = 'revision' in artifact ? artifact.revision : undefined;

  if (
    typeof contentHash !== 'string' ||
    !contentHash ||
    !Number.isSafeInteger(revision) ||
    (revision ?? -1) < 0
  ) {
    return undefined;
  }

  return Object.freeze({
    artifactId: artifact.artifactId,
    mediaType: 'midi' as const,
    midi: Object.freeze({
      contentHash,
      revision: revision as number,
    }),
  });
}

function profileFailure(
  cause: string,
  message: string,
): Extract<RuntimeProfilePreparation, { ok: false }> {
  return Object.freeze({ cause, message, ok: false as const });
}

function blocked(
  reason: Extract<AutoPatchProductionPreparation, { canRun: false }>['reason'],
  cause: string,
  message: string,
): Extract<AutoPatchProductionPreparation, { canRun: false }> {
  return Object.freeze({
    canRun: false as const,
    cause,
    message,
    reason,
    status: 'BLOCKED' as const,
  });
}
