import { isAbsolute } from 'node:path';

export const PROVIDER_WORKER_PROTOCOL_VERSION = '1';

export const PROVIDER_ARTIFACT_KINDS = Object.freeze([
  'audio',
  'midi',
  'lyrics',
  'stem-set',
  'metadata',
]);

export const PROVIDER_COMPATIBILITY_RESULTS = Object.freeze([
  'COMPATIBLE',
  'PARTIAL_SUPPORT',
  'UNVERIFIED',
  'INCOMPATIBLE',
]);

const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_JSON_DEPTH = 16;

export class ProviderContractValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PROVIDER_CONTRACT_INVALID';
    this.name = 'ProviderContractValidationError';
  }
}

export function validateProviderDescriptor(value) {
  if (!isRecord(value)) {
    throw new ProviderContractValidationError('Provider descriptor must be an object.');
  }

  const providerId = validateId(value.providerId, 'Provider ID');
  const displayName = validateString(value.displayName, 'Provider display name', MAX_TEXT_LENGTH);
  const capabilities = validateCapabilities(value.capabilities);
  const capabilityTaskIds = new Set(capabilities.map((capability) => capability.taskId));
  const models = validateModels(value.models, capabilityTaskIds);
  const runtime = validateRuntime(value.runtime);

  return Object.freeze({
    capabilities,
    displayName,
    models,
    providerId,
    protocolVersion: validateProtocolVersion(value.protocolVersion),
    runtime,
  });
}

export function validateProviderJob(value) {
  if (!isRecord(value)) {
    throw new ProviderContractValidationError('Provider Job must be an object.');
  }

  if (!Array.isArray(value.inputArtifacts)) {
    throw new ProviderContractValidationError('Provider Job inputArtifacts must be an array.');
  }

  const inputArtifactIds = new Set();
  const inputArtifacts = Object.freeze(
    value.inputArtifacts.map((artifact, index) => {
      const validated = validateInputArtifact(artifact, index);

      if (inputArtifactIds.has(validated.artifactId)) {
        throw new ProviderContractValidationError(
          `Provider Job input artifact ID must be unique: ${validated.artifactId}.`,
        );
      }

      inputArtifactIds.add(validated.artifactId);
      return validated;
    }),
  );

  return Object.freeze({
    inputArtifacts,
    jobId: validateId(value.jobId, 'Provider Job ID'),
    modelId: validateId(value.modelId, 'Provider Job model ID'),
    modelRevision: validateString(
      value.modelRevision,
      'Provider Job model revision',
      MAX_TEXT_LENGTH,
    ),
    output: validateOutputArtifact(value.output),
    parameters: validateJsonObject(value.parameters, 'Provider Job parameters'),
    providerId: validateId(value.providerId, 'Provider Job provider ID'),
    taskId: validateId(value.taskId, 'Provider Job Task ID'),
  });
}

export function providerDeclaresJob(provider, job) {
  const { capability, model } = findProviderJobDeclaration(provider, job);
  const inputKindsMatch =
    capability?.inputArtifactKinds.length === job.inputArtifacts.length &&
    capability.inputArtifactKinds.every(
      (kind, index) => job.inputArtifacts[index]?.kind === kind,
    );

  return (
    provider.providerId === job.providerId &&
    capability?.outputArtifactKind === job.output.kind &&
    inputKindsMatch &&
    Boolean(model?.taskIds.includes(job.taskId)) &&
    Boolean(model)
  );
}

export function providerSupportsJob(provider, job) {
  const { model } = findProviderJobDeclaration(provider, job);

  return (
    providerDeclaresJob(provider, job) &&
    provider.runtime.compatibility === 'COMPATIBLE' &&
    isExecutableCompatibility(model?.compatibility)
  );
}

export function providerSupportsModelLoad(provider, modelId, revision) {
  const model = provider.models.find(
    (candidate) => candidate.modelId === modelId && candidate.revision === revision,
  );

  return (
    provider.runtime.compatibility === 'COMPATIBLE' &&
    isExecutableCompatibility(model?.compatibility)
  );
}

function findProviderJobDeclaration(provider, job) {
  return {
    capability: provider.capabilities.find(
      (candidate) => candidate.taskId === job.taskId,
    ),
    model: provider.models.find(
      (candidate) =>
        candidate.modelId === job.modelId && candidate.revision === job.modelRevision,
    ),
  };
}

function isExecutableCompatibility(value) {
  return value === 'COMPATIBLE' || value === 'PARTIAL_SUPPORT';
}

function validateCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderContractValidationError(
      'Provider descriptor must declare at least one Capability.',
    );
  }

  const taskIds = new Set();

  return Object.freeze(
    value.map((capability, index) => {
      if (!isRecord(capability)) {
        throw new ProviderContractValidationError(
          `Provider Capability at index ${index} must be an object.`,
        );
      }

      const taskId = validateId(capability.taskId, `Provider Capability ${index} Task ID`);

      if (taskIds.has(taskId)) {
        throw new ProviderContractValidationError(
          `Provider Capability Task ID must be unique: ${taskId}.`,
        );
      }

      taskIds.add(taskId);

      if (
        !Array.isArray(capability.inputArtifactKinds) ||
        !capability.inputArtifactKinds.every(isArtifactKind)
      ) {
        throw new ProviderContractValidationError(
          `Provider Capability ${taskId} inputArtifactKinds are invalid.`,
        );
      }

      if (!isArtifactKind(capability.outputArtifactKind)) {
        throw new ProviderContractValidationError(
          `Provider Capability ${taskId} outputArtifactKind is invalid.`,
        );
      }

      if (typeof capability.supportsCancellation !== 'boolean') {
        throw new ProviderContractValidationError(
          `Provider Capability ${taskId} supportsCancellation must be boolean.`,
        );
      }

      return Object.freeze({
        inputArtifactKinds: Object.freeze([...new Set(capability.inputArtifactKinds)]),
        outputArtifactKind: capability.outputArtifactKind,
        supportsCancellation: capability.supportsCancellation,
        taskId,
      });
    }),
  );
}

function validateModels(value, capabilityTaskIds) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderContractValidationError(
      'Provider descriptor must declare at least one Model.',
    );
  }

  const modelKeys = new Set();

  return Object.freeze(
    value.map((model, index) => {
      if (!isRecord(model)) {
        throw new ProviderContractValidationError(
          `Provider Model at index ${index} must be an object.`,
        );
      }

      const modelId = validateId(model.modelId, `Provider Model ${index} ID`);
      const revision = validateString(
        model.revision,
        `Provider Model ${modelId} revision`,
        MAX_TEXT_LENGTH,
      );
      const modelKey = `${modelId}@${revision}`;

      if (modelKeys.has(modelKey)) {
        throw new ProviderContractValidationError(`Provider Model must be unique: ${modelKey}.`);
      }

      modelKeys.add(modelKey);

      if (
        typeof model.compatibility !== 'string' ||
        !PROVIDER_COMPATIBILITY_RESULTS.includes(model.compatibility)
      ) {
        throw new ProviderContractValidationError(
          `Provider Model ${modelKey} compatibility is invalid.`,
        );
      }

      if (
        !Array.isArray(model.taskIds) ||
        model.taskIds.length === 0 ||
        !model.taskIds.every((taskId) =>
          typeof taskId === 'string' && capabilityTaskIds.has(taskId),
        )
      ) {
        throw new ProviderContractValidationError(
          `Provider Model ${modelKey} must reference declared Capability Task IDs.`,
        );
      }

      return Object.freeze({
        compatibility: model.compatibility,
        modelId,
        revision,
        taskIds: Object.freeze([...new Set(model.taskIds)]),
      });
    }),
  );
}

function validateRuntime(value) {
  if (!isRecord(value)) {
    throw new ProviderContractValidationError('Provider runtime descriptor must be an object.');
  }

  return Object.freeze({
    compatibility: validateCompatibility(value.compatibility, 'Provider runtime compatibility'),
    profile: validateString(value.profile, 'Provider runtime profile', MAX_TEXT_LENGTH),
    version: validateString(value.version, 'Provider runtime version', MAX_TEXT_LENGTH),
  });
}

function validateInputArtifact(value, index) {
  if (!isRecord(value)) {
    throw new ProviderContractValidationError(
      `Provider Job input artifact at index ${index} must be an object.`,
    );
  }

  const kind = validateArtifactKind(value.kind, `Provider Job input artifact ${index} kind`);
  const path = value.path === undefined
    ? undefined
    : validateAbsolutePath(value.path, `Provider Job input artifact ${index} path`);
  const midi = value.midi === undefined
    ? undefined
    : validateJsonObject(value.midi, `Provider Job input artifact ${index} MIDI`);

  if (midi !== undefined && kind !== 'midi') {
    throw new ProviderContractValidationError(
      `Provider Job input artifact ${index} inline MIDI requires kind midi.`,
    );
  }

  if (path !== undefined && midi !== undefined) {
    throw new ProviderContractValidationError(
      `Provider Job input artifact ${index} must not declare both path and inline MIDI.`,
    );
  }

  return Object.freeze({
    artifactId: validateId(value.artifactId, `Provider Job input artifact ${index} ID`),
    kind,
    ...(path ? { path } : {}),
    ...(midi ? { midi } : {}),
  });
}

function validateOutputArtifact(value) {
  if (!isRecord(value)) {
    throw new ProviderContractValidationError('Provider Job output must be an object.');
  }

  const kind = validateArtifactKind(value.kind, 'Provider Job output kind');

  if (kind === 'midi') {
    if (value.stagingPath !== undefined) {
      throw new ProviderContractValidationError(
        'Inline MIDI output must not declare a stagingPath.',
      );
    }

    return Object.freeze({ kind });
  }

  const stagingPath = validateAbsolutePath(value.stagingPath, 'Provider Job output stagingPath');

  if (!stagingPath.toLowerCase().endsWith('.partial')) {
    throw new ProviderContractValidationError(
      'Provider Job output stagingPath must reference a .partial staging file.',
    );
  }

  return Object.freeze({
    kind,
    stagingPath,
  });
}

function validateProtocolVersion(value) {
  if (value !== PROVIDER_WORKER_PROTOCOL_VERSION) {
    throw new ProviderContractValidationError(
      `Provider protocol must be v${PROVIDER_WORKER_PROTOCOL_VERSION}.`,
    );
  }

  return value;
}

function validateCompatibility(value, label) {
  if (typeof value !== 'string' || !PROVIDER_COMPATIBILITY_RESULTS.includes(value)) {
    throw new ProviderContractValidationError(`${label} is invalid.`);
  }

  return value;
}

function validateArtifactKind(value, label) {
  if (!isArtifactKind(value)) {
    throw new ProviderContractValidationError(`${label} is invalid.`);
  }

  return value;
}

function validateId(value, label) {
  const id = validateString(value, label, MAX_ID_LENGTH);

  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new ProviderContractValidationError(
      `${label} must use lowercase letters, numbers, and single hyphens.`,
    );
  }

  return id;
}

function validateAbsolutePath(value, label) {
  const path = validateString(value, label, MAX_PATH_LENGTH);

  if (!isAbsolute(path)) {
    throw new ProviderContractValidationError(`${label} must be absolute.`);
  }

  return path;
}

function validateString(value, label, maximumLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > maximumLength
  ) {
    throw new ProviderContractValidationError(
      `${label} must be a non-empty trimmed string within ${maximumLength} characters.`,
    );
  }

  return value;
}

function validateJsonObject(value, label) {
  if (!isRecord(value)) {
    throw new ProviderContractValidationError(`${label} must be an object.`);
  }

  return cloneJsonValue(value, label, 0);
}

function cloneJsonValue(value, label, depth) {
  if (depth > MAX_JSON_DEPTH) {
    throw new ProviderContractValidationError(`${label} exceeds the supported nesting depth.`);
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProviderContractValidationError(`${label} contains a non-finite number.`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) => cloneJsonValue(item, `${label}[${index}]`, depth + 1)),
    );
  }

  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          cloneJsonValue(item, `${label}.${key}`, depth + 1),
        ]),
      ),
    );
  }

  throw new ProviderContractValidationError(`${label} contains a non-JSON value.`);
}

function isArtifactKind(value) {
  return typeof value === 'string' && PROVIDER_ARTIFACT_KINDS.includes(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
