import {
  ACE_STEP_MODEL_MANIFEST_VERSION,
  ACE_STEP_MODEL_METADATA_URL,
  ACE_STEP_MODEL_SOURCE_URL,
  ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST,
  ACE_STEP_PROVIDER_SOURCE_URL,
} from './aceStepModelSnapshotManifest.mjs';
import {
  ACE_STEP_MODEL_REPOSITORY,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PROVIDER_REPOSITORY,
} from './aceStepRuntimeProfile.mjs';

const PROVIDER_CODE_OVERRIDES = Object.freeze({
  'apg_guidance.py': Object.freeze({
    path: 'apg_guidance.py',
    sha256: 'f51c7c8ed2fcd55e24b9a8226824679a48456feafed0f34e116e5b2c24e9b967',
    sizeBytes: 627,
  }),
  'configuration_acestep_v15.py': Object.freeze({
    path: 'configuration_acestep_v15.py',
    sha256: 'a48cf207b12b24913fa680b085a410855a628e48841ab885d90c23f0ccb44dd6',
    sizeBytes: 217,
  }),
  'modeling_acestep_v15_base.py': Object.freeze({
    path: 'modeling_acestep_v15_base.py',
    sha256: 'dd8857d821f0c9cd0a04b35ca876cca332515a81bf8c4a8177770e2f074bc060',
    sizeBytes: 110_932,
  }),
});

export const ACE_STEP_PINNED_EFFECTIVE_MODEL_SNAPSHOT_MANIFEST = deepFreeze({
  files: ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST.files.map(
    (file) => PROVIDER_CODE_OVERRIDES[file.path] ?? file,
  ),
  manifestVersion: ACE_STEP_MODEL_MANIFEST_VERSION,
  modelMetadataUrl: ACE_STEP_MODEL_METADATA_URL,
  modelRepository: ACE_STEP_MODEL_REPOSITORY,
  modelRevision: ACE_STEP_MODEL_REVISION,
  modelSourceUrl: ACE_STEP_MODEL_SOURCE_URL,
  providerRepository: ACE_STEP_PROVIDER_REPOSITORY,
  providerRevision: ACE_STEP_PROVIDER_CODE_REVISION,
  providerSourceUrl: ACE_STEP_PROVIDER_SOURCE_URL,
});

function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
