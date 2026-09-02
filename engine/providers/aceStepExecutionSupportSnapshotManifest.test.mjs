import { describe, expect, it } from 'vitest';

import {
  ACE_STEP_EXECUTION_SUPPORT_METADATA_URL,
  ACE_STEP_EXECUTION_SUPPORT_PROVIDER_SOURCE_URL,
  ACE_STEP_EXECUTION_SUPPORT_SOURCE_URL,
  ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST,
} from './aceStepExecutionSupportSnapshotManifest.mjs';
import {
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PROVIDER_REPOSITORY,
  ACE_STEP_SUPPORT_MODEL_REPOSITORY,
  ACE_STEP_SUPPORT_MODEL_REVISION,
} from './aceStepRuntimeProfile.mjs';

describe('ACE-Step pinned execution-support snapshot manifest', () => {
  it('pins immutable official Provider and support-model provenance', () => {
    expect(ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST).toMatchObject({
      manifestVersion: '1',
      modelMetadataUrl:
        'https://huggingface.co/api/models/ACE-Step/Ace-Step1.5/revision/' +
        '19671f406d603126926c1b7e2adc169acbcade22?blobs=true',
      modelRepository: 'ACE-Step/Ace-Step1.5',
      modelRevision: '19671f406d603126926c1b7e2adc169acbcade22',
      modelSourceUrl:
        'https://huggingface.co/ACE-Step/Ace-Step1.5/tree/' +
        '19671f406d603126926c1b7e2adc169acbcade22',
      providerRepository: 'https://github.com/ace-step/ACE-Step-1.5',
      providerRevision: 'dce621408bee8c31b4fcf4811682eb9359e1bc94',
    });
    expect(ACE_STEP_EXECUTION_SUPPORT_METADATA_URL).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.modelMetadataUrl,
    );
    expect(ACE_STEP_EXECUTION_SUPPORT_SOURCE_URL).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.modelSourceUrl,
    );
    expect(ACE_STEP_EXECUTION_SUPPORT_PROVIDER_SOURCE_URL).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.providerSourceUrl,
    );
    expect(ACE_STEP_SUPPORT_MODEL_REPOSITORY).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.modelRepository,
    );
    expect(ACE_STEP_SUPPORT_MODEL_REVISION).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.modelRevision,
    );
    expect(ACE_STEP_PROVIDER_REPOSITORY).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.providerRepository,
    );
    expect(ACE_STEP_PROVIDER_CODE_REVISION).toBe(
      ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST.providerRevision,
    );
  });

  it('covers every VAE and text-encoder file loaded by DiT-only generation', () => {
    const manifest = ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST;

    expect(manifest.files).toHaveLength(11);
    expect(manifest.files.map(({ path }) => path)).toEqual([
      'Qwen3-Embedding-0.6B/added_tokens.json',
      'Qwen3-Embedding-0.6B/chat_template.jinja',
      'Qwen3-Embedding-0.6B/config.json',
      'Qwen3-Embedding-0.6B/merges.txt',
      'Qwen3-Embedding-0.6B/model.safetensors',
      'Qwen3-Embedding-0.6B/special_tokens_map.json',
      'Qwen3-Embedding-0.6B/tokenizer.json',
      'Qwen3-Embedding-0.6B/tokenizer_config.json',
      'Qwen3-Embedding-0.6B/vocab.json',
      'vae/config.json',
      'vae/diffusion_pytorch_model.safetensors',
    ]);
    expect(
      manifest.files.reduce((total, file) => total + file.sizeBytes, 0),
    ).toBe(1_544_902_819);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.files)).toBe(true);
    expect(manifest.files.every(Object.isFrozen)).toBe(true);
  });
});
