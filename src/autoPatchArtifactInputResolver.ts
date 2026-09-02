import type {
  AutoPatchFamilyGraphSnapshot,
  AutoPatchPatchTabSnapshot,
  AutoPatchTargetSnapshot,
} from './autoPatchGraphSnapshot';
import type { AutoPatchPreflightStage } from './autoPatchPreflightPlan';
import type { TabFlowStageArtifactInput } from './tabFlowChangedStage';
import type { CompletedTabFlowStageResultRecord } from './types';

export type AutoPatchRuntimeArtifactIdentity = Readonly<{
  artifactId: string;
  mediaType: 'audio' | 'midi';
  midi?: Readonly<{
    contentHash: string;
    revision: number;
  }>;
}>;

export type AutoPatchArtifactInputResolution =
  | Readonly<{
      artifactInputs: readonly TabFlowStageArtifactInput[];
      canResolve: true;
    }>
  | Readonly<{
      canResolve: false;
      cause: string;
      message: string;
    }>;

export function resolveAutoPatchStageArtifactInputs(
  family: AutoPatchFamilyGraphSnapshot,
  patchTab: AutoPatchPatchTabSnapshot,
  stage: AutoPatchPreflightStage,
  target: AutoPatchTargetSnapshot,
  reusedResultsByStageId: ReadonlyMap<
    string,
    CompletedTabFlowStageResultRecord
  >,
  artifactIdentitiesById: ReadonlyMap<
    string,
    AutoPatchRuntimeArtifactIdentity
  >,
): AutoPatchArtifactInputResolution {
  const artifactInputs: TabFlowStageArtifactInput[] = [];

  for (const port of patchTab.portContract.inputs) {
    if (port.domain !== 'artifact') {
      continue;
    }

    const bindings = patchTab.inputBindings.filter(
      (binding) => binding.portId === port.id,
    );
    const artifactIds: string[] = [];
    const clipTakeIds: string[] = [];
    const midiIdentities: NonNullable<
      TabFlowStageArtifactInput['midi']
    >[] = [];

    for (const binding of bindings) {
      if (binding.kind === 'timeline-range') {
        return failure(
          'timeline-range-unsupported',
          `Stage ${stage.scope.stageId} cannot fingerprint Timeline Range inputs yet.`,
        );
      }

      if (binding.kind === 'timeline-selection') {
        artifactIds.push(target.activeTake.artifactId);
        clipTakeIds.push(target.activeTake.clipTakeId);

        if (target.activeTake.mediaType === 'midi') {
          const midiIdentity = getTargetMidiIdentity(target);

          if (!midiIdentity) {
            return failure(
              'midi-identity-missing',
              `Target Clip ${target.clipId} Active MIDI Take is missing content identity.`,
            );
          }

          midiIdentities.push(midiIdentity);
        }

        continue;
      }

      if (binding.kind !== 'connection') {
        continue;
      }

      const connections = stage.incomingConnectionIds
        .map((connectionId) =>
          family.connections.find(
            (connection) => connection.id === connectionId,
          ),
        )
        .filter(
          (
            connection,
          ): connection is AutoPatchFamilyGraphSnapshot['connections'][number] =>
            connection?.toPortId === port.id &&
            binding.connectionIds.includes(connection.id),
        );

      for (const connection of connections) {
        const upstreamPatchTab = family.patchTabs.find(
          (candidate) => candidate.id === connection.fromPatchTabId,
        );
        const upstreamResult = reusedResultsByStageId.get(
          connection.fromPatchTabId,
        );
        const artifactOutputs = upstreamPatchTab?.portContract.outputs.filter(
          (output) => output.domain === 'artifact',
        );
        const outputPort = artifactOutputs?.find(
          (output) => output.id === connection.fromPortId,
        );

        if (
          !upstreamPatchTab ||
          !upstreamResult ||
          !outputPort ||
          artifactOutputs?.length !== 1
        ) {
          return failure(
            'upstream-output-unresolved',
            `Connection ${connection.id} cannot resolve one exact reusable upstream Artifact output.`,
          );
        }

        artifactIds.push(...upstreamResult.outputArtifactIds);
        clipTakeIds.push(...upstreamResult.outputClipTakeIds);

        if (outputPort.dataCategory === 'midi') {
          for (const artifactId of upstreamResult.outputArtifactIds) {
            const identity = artifactIdentitiesById.get(artifactId);

            if (
              !identity ||
              identity.mediaType !== 'midi' ||
              !identity.midi
            ) {
              return failure(
                'midi-identity-missing',
                `Reusable MIDI Artifact ${artifactId} is missing content identity.`,
              );
            }

            midiIdentities.push({ ...identity.midi });
          }
        }
      }
    }

    if (
      new Set(artifactIds).size !== artifactIds.length ||
      new Set(clipTakeIds).size !== clipTakeIds.length
    ) {
      return failure(
        'artifact-input-duplicate',
        `Stage ${stage.scope.stageId} Port ${port.id} resolves duplicate Artifact or ClipTake input identity.`,
      );
    }

    if (midiIdentities.length > 1) {
      return failure(
        'midi-fan-in-unsupported',
        `Stage ${stage.scope.stageId} Port ${port.id} requires per-Artifact MIDI identity support before multi-source fingerprinting.`,
      );
    }

    if (artifactIds.length > 0 || clipTakeIds.length > 0) {
      artifactInputs.push({
        artifactIds,
        clipTakeIds,
        ...(midiIdentities[0] ? { midi: midiIdentities[0] } : {}),
        portId: port.id,
      });
    }
  }

  return freezeDeep({ artifactInputs, canResolve: true });
}

function getTargetMidiIdentity(
  target: AutoPatchTargetSnapshot,
): NonNullable<TabFlowStageArtifactInput['midi']> | undefined {
  return typeof target.activeTake.contentHash === 'string' &&
    target.activeTake.contentHash.length > 0 &&
    Number.isSafeInteger(target.activeTake.revision) &&
    (target.activeTake.revision ?? -1) >= 0
    ? {
        contentHash: target.activeTake.contentHash,
        revision: target.activeTake.revision as number,
      }
    : undefined;
}

function failure(
  cause: string,
  message: string,
): AutoPatchArtifactInputResolution {
  return freezeDeep({ canResolve: false, cause, message });
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => {
      freezeDeep(child);
    });
    Object.freeze(value);
  }

  return value as DeepReadonly<T>;
}
