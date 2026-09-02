import type { ProjectJsonValue } from './types';

const FNV_1A_64_OFFSET = 14_695_981_039_346_656_037n;
const FNV_1A_64_PRIME = 1_099_511_628_211n;
const FNV_1A_64_MASK = 0xffff_ffff_ffff_ffffn;

type StageScalar = string | number;

export type TabFlowStageArtifactInput = Readonly<{
  portId: string;
  artifactIds: readonly string[];
  clipTakeIds: readonly string[];
  midi?: Readonly<{
    contentHash: string;
    revision: number;
  }>;
}>;

export type TabFlowStageResourceInput = Readonly<{
  portId: string;
  resourceId: string;
  revision: string;
  selections: Readonly<Record<string, StageScalar>>;
}>;

export type TabFlowStageFingerprintInput = Readonly<{
  artifactInputs: readonly TabFlowStageArtifactInput[];
  node: Readonly<{
    patchTabId: string;
    nodeTypeId: string;
    nodeVersion: string;
    parameters: Readonly<Record<string, StageScalar>>;
  }>;
  projectContext: Readonly<Record<string, ProjectJsonValue>>;
  provider?: Readonly<{
    providerId: string;
    providerRevision: string;
    taskId: string;
    modelId: string;
    modelRevision: string;
  }>;
  resourceInputs: readonly TabFlowStageResourceInput[];
}>;

export type TabFlowStageCandidate = Readonly<{
  stageId: string;
  dependsOnStageIds: readonly string[];
  fingerprint: string;
}>;

export type TabFlowReusableStageResult = Readonly<{
  stageId: string;
  fingerprint: string;
  isAvailable: boolean;
}>;

export type TabFlowChangedStageReason =
  | 'fingerprint-changed'
  | 'missing-result'
  | 'upstream-changed';

export type TabFlowChangedStagePlanEntry = Readonly<{
  stageId: string;
  action: 'execute' | 'reuse';
  fingerprint: string;
  reasons: readonly TabFlowChangedStageReason[];
}>;

export function createTabFlowStageFingerprint(
  input: TabFlowStageFingerprintInput,
): string {
  const serialized = serializeCanonicalValue({
    artifactInputs: [...input.artifactInputs]
      .sort((left, right) => compareStableText(left.portId, right.portId))
      .map((artifactInput) => ({
        artifactIds: [...artifactInput.artifactIds],
        clipTakeIds: [...artifactInput.clipTakeIds],
        midi: artifactInput.midi
          ? {
              contentHash: artifactInput.midi.contentHash,
              revision: artifactInput.midi.revision,
            }
          : null,
        portId: artifactInput.portId,
      })),
    node: {
      nodeTypeId: input.node.nodeTypeId,
      nodeVersion: input.node.nodeVersion,
      parameters: input.node.parameters,
      patchTabId: input.node.patchTabId,
    },
    projectContext: input.projectContext,
    provider: input.provider
      ? {
          modelId: input.provider.modelId,
          modelRevision: input.provider.modelRevision,
          providerId: input.provider.providerId,
          providerRevision: input.provider.providerRevision,
          taskId: input.provider.taskId,
        }
      : null,
    resourceInputs: [...input.resourceInputs]
      .sort((left, right) => compareStableText(left.portId, right.portId))
      .map((resourceInput) => ({
        portId: resourceInput.portId,
        resourceId: resourceInput.resourceId,
        revision: resourceInput.revision,
        selections: resourceInput.selections,
      })),
  });
  let hash = FNV_1A_64_OFFSET;

  for (let index = 0; index < serialized.length; index += 1) {
    const codeUnit = serialized.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = (hash * FNV_1A_64_PRIME) & FNV_1A_64_MASK;
    hash ^= BigInt(codeUnit >>> 8);
    hash = (hash * FNV_1A_64_PRIME) & FNV_1A_64_MASK;
  }

  return `tabflow-fnv1a64-${hash.toString(16).padStart(16, '0')}`;
}

export function planChangedTabFlowStages(
  stages: readonly TabFlowStageCandidate[],
  reusableResults: readonly TabFlowReusableStageResult[],
): readonly TabFlowChangedStagePlanEntry[] {
  const reusableResultMap = createReusableResultMap(reusableResults);
  const seenStageIds = new Set<string>();
  const executedStageIds = new Set<string>();
  const plan: TabFlowChangedStagePlanEntry[] = [];

  stages.forEach((stage) => {
    requireNonEmptyString(stage.stageId, 'TabFlow stage ID');
    requireNonEmptyString(stage.fingerprint, `TabFlow stage ${stage.stageId} fingerprint`);

    if (seenStageIds.has(stage.stageId)) {
      throw new Error(`Duplicate TabFlow stage ID: ${stage.stageId}`);
    }

    const dependencyIds = new Set<string>();

    stage.dependsOnStageIds.forEach((dependencyId) => {
      requireNonEmptyString(
        dependencyId,
        `TabFlow stage ${stage.stageId} dependency ID`,
      );

      if (dependencyIds.has(dependencyId)) {
        throw new Error(
          `Duplicate dependency ${dependencyId} for TabFlow stage ${stage.stageId}`,
        );
      }

      if (!seenStageIds.has(dependencyId)) {
        throw new Error(
          `TabFlow stage ${stage.stageId} depends on ${dependencyId} before it is planned`,
        );
      }

      dependencyIds.add(dependencyId);
    });

    const reusableResult = reusableResultMap.get(stage.stageId);
    const reasons: TabFlowChangedStageReason[] = [];

    if ([...dependencyIds].some((dependencyId) => executedStageIds.has(dependencyId))) {
      reasons.push('upstream-changed');
    }

    if (!reusableResult?.isAvailable) {
      reasons.push('missing-result');
    } else if (reusableResult.fingerprint !== stage.fingerprint) {
      reasons.push('fingerprint-changed');
    }

    const action = reasons.length > 0 ? 'execute' : 'reuse';

    if (action === 'execute') {
      executedStageIds.add(stage.stageId);
    }

    plan.push(
      Object.freeze({
        stageId: stage.stageId,
        action,
        fingerprint: stage.fingerprint,
        reasons: Object.freeze(reasons),
      }),
    );
    seenStageIds.add(stage.stageId);
  });

  return Object.freeze(plan);
}

function createReusableResultMap(
  reusableResults: readonly TabFlowReusableStageResult[],
): Map<string, TabFlowReusableStageResult> {
  const resultMap = new Map<string, TabFlowReusableStageResult>();

  reusableResults.forEach((result) => {
    requireNonEmptyString(result.stageId, 'Reusable TabFlow stage ID');
    requireNonEmptyString(
      result.fingerprint,
      `Reusable TabFlow stage ${result.stageId} fingerprint`,
    );

    if (resultMap.has(result.stageId)) {
      throw new Error(`Duplicate reusable TabFlow stage result: ${result.stageId}`);
    }

    resultMap.set(result.stageId, result);
  });

  return resultMap;
}

function serializeCanonicalValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('TabFlow fingerprint values must contain finite numbers');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalValue).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeCanonicalValue(record[key])}`,
      )
      .join(',')}}`;
  }

  throw new Error(`Unsupported TabFlow fingerprint value: ${typeof value}`);
}

function requireNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
