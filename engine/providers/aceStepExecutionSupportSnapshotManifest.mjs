import {
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PROVIDER_REPOSITORY,
  ACE_STEP_SUPPORT_MODEL_REPOSITORY,
  ACE_STEP_SUPPORT_MODEL_REVISION,
} from './aceStepRuntimeProfile.mjs';
import { ACE_STEP_MODEL_MANIFEST_VERSION } from './aceStepModelSnapshotManifest.mjs';

export const ACE_STEP_EXECUTION_SUPPORT_METADATA_URL =
  `https://huggingface.co/api/models/${ACE_STEP_SUPPORT_MODEL_REPOSITORY}/revision/` +
  `${ACE_STEP_SUPPORT_MODEL_REVISION}?blobs=true`;
export const ACE_STEP_EXECUTION_SUPPORT_SOURCE_URL =
  `https://huggingface.co/${ACE_STEP_SUPPORT_MODEL_REPOSITORY}/tree/` +
  ACE_STEP_SUPPORT_MODEL_REVISION;
export const ACE_STEP_EXECUTION_SUPPORT_PROVIDER_SOURCE_URL =
  `${ACE_STEP_PROVIDER_REPOSITORY}/tree/${ACE_STEP_PROVIDER_CODE_REVISION}`;

export const ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST = deepFreeze({
  files: [
    {
      path: 'Qwen3-Embedding-0.6B/added_tokens.json',
      sha256: 'c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680',
      sizeBytes: 707,
    },
    {
      path: 'Qwen3-Embedding-0.6B/chat_template.jinja',
      sha256: '87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5',
      sizeBytes: 4_116,
    },
    {
      path: 'Qwen3-Embedding-0.6B/config.json',
      sha256: 'bb23c1607cfe059a58d8f0196cf1cebb52082b1056b8e358a579da80a5759420',
      sizeBytes: 1_359,
    },
    {
      path: 'Qwen3-Embedding-0.6B/merges.txt',
      sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',
      sizeBytes: 1_671_853,
    },
    {
      path: 'Qwen3-Embedding-0.6B/model.safetensors',
      sha256: '0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd',
      sizeBytes: 1_191_586_416,
    },
    {
      path: 'Qwen3-Embedding-0.6B/special_tokens_map.json',
      sha256: '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd',
      sizeBytes: 613,
    },
    {
      path: 'Qwen3-Embedding-0.6B/tokenizer.json',
      sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a',
      sizeBytes: 11_423_705,
    },
    {
      path: 'Qwen3-Embedding-0.6B/tokenizer_config.json',
      sha256: '443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0',
      sizeBytes: 5_404,
    },
    {
      path: 'Qwen3-Embedding-0.6B/vocab.json',
      sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',
      sizeBytes: 2_776_833,
    },
    {
      path: 'vae/config.json',
      sha256: '14e019904df567f26df750317a70e2bd08f9f8f3c40ff4a24c97d1cd3f20ccd2',
      sizeBytes: 425,
    },
    {
      path: 'vae/diffusion_pytorch_model.safetensors',
      sha256: 'da17edb604c40deaf09e9b24974e590d1ca83a374070e5d0884cfa4bed9a99b0',
      sizeBytes: 337_431_388,
    },
  ],
  manifestVersion: ACE_STEP_MODEL_MANIFEST_VERSION,
  modelMetadataUrl: ACE_STEP_EXECUTION_SUPPORT_METADATA_URL,
  modelRepository: ACE_STEP_SUPPORT_MODEL_REPOSITORY,
  modelRevision: ACE_STEP_SUPPORT_MODEL_REVISION,
  modelSourceUrl: ACE_STEP_EXECUTION_SUPPORT_SOURCE_URL,
  providerRepository: ACE_STEP_PROVIDER_REPOSITORY,
  providerRevision: ACE_STEP_PROVIDER_CODE_REVISION,
  providerSourceUrl: ACE_STEP_EXECUTION_SUPPORT_PROVIDER_SOURCE_URL,
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
