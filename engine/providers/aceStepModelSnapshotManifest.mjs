import {
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_MODEL_REPOSITORY,
  ACE_STEP_PROVIDER_REPOSITORY,
} from './aceStepRuntimeProfile.mjs';

export const ACE_STEP_MODEL_MANIFEST_VERSION = '1';
export const ACE_STEP_MODEL_METADATA_URL =
  `https://huggingface.co/api/models/${ACE_STEP_MODEL_REPOSITORY}/revision/` +
  `${ACE_STEP_MODEL_REVISION}?blobs=true`;
export const ACE_STEP_MODEL_SOURCE_URL =
  `https://huggingface.co/${ACE_STEP_MODEL_REPOSITORY}/tree/` +
  ACE_STEP_MODEL_REVISION;
export const ACE_STEP_PROVIDER_SOURCE_URL =
  `${ACE_STEP_PROVIDER_REPOSITORY}/tree/${ACE_STEP_PROVIDER_CODE_REVISION}`;

export const ACE_STEP_PINNED_MODEL_SNAPSHOT_MANIFEST = deepFreeze({
  files: [
    {
      path: 'apg_guidance.py',
      sha256: '0c0ce9755952c99307ecad2fac67863d43258e34541cd37ce2f2221f59e76b15',
      sizeBytes: 7_956,
    },
    {
      path: 'config.json',
      sha256: '9bb4f832f2e5e6c8bf7bddab3c6a6da1b13c01d072efbf0ed3c830536c473359',
      sizeBytes: 1_940,
    },
    {
      path: 'configuration_acestep_v15.py',
      sha256: 'b89870c5c7a7ce060eb0bcdbb5ffc86b0b1a324ca325a26be552ea1b42496dc5',
      sizeBytes: 13_130,
    },
    {
      path: 'model.safetensors',
      sha256: '4177f600501a6d4bd81cadaa0abac557ffd15c54e5c8cb52053cdb24a0844d6b',
      sizeBytes: 4_787_825_604,
    },
    {
      path: 'modeling_acestep_v15_base.py',
      sha256: 'd5f67ca269f8b854a86e203b843534ab62728193e45277115f667b00ab5aa2b6',
      sizeBytes: 95_545,
    },
    {
      path: 'silence_latent.pt',
      sha256: 'a778e9dd942f5e8b2c09c55370782d318834432b03dabbcdf70e6ed49ad6358b',
      sizeBytes: 3_841_215,
    },
  ],
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
