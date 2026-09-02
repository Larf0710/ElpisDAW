import { describe, expect, it } from 'vitest';

import {
  ACE_STEP_BASE_QUALITY_EVIDENCE_SHA256,
  ACE_STEP_COVER_OUTPUT_SHA256,
  ACE_STEP_LICENSE_PROFILE,
  ACE_STEP_LEGO_VOCALS_OUTPUT_SHA256,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_RUNTIME_PROFILE,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_SUPPORT_MODEL_REPOSITORY,
  ACE_STEP_SUPPORT_MODEL_REVISION,
  ACE_STEP_TEXT_TO_MUSIC_OUTPUT_SHA256,
} from './aceStepRuntimeProfile.mjs';

describe('current ACE-Step Runtime Profile', () => {
  it('pins and promotes the verified Runtime, release, and Base model', () => {
    expect(ACE_STEP_RUNTIME_PROFILE).toMatchObject({
      compatibility: 'COMPATIBLE',
      generation: {
        audioFormat: 'wav',
        batchSize: 1,
        cfgIntervalEnd: 1,
        cfgIntervalStart: 0,
        dcwEnabled: false,
        guidanceScale: 8,
        inferenceSteps: 64,
        instruction: 'Generate the VOCALS track based on the audio context:',
        shift: 3,
        targetTrack: 'vocals',
        taskType: 'lego',
        thinking: false,
        useAdg: true,
      },
      model: {
        compatibility: 'COMPATIBLE',
        repository: 'ACE-Step/acestep-v15-base',
        revision: ACE_STEP_MODEL_REVISION,
        sampleRate: 48_000,
      },
      profileId: ACE_STEP_RUNTIME_PROFILE_ID,
      providerPackage: {
        python: '>=3.11,<3.13',
        releaseTag: 'v0.1.8',
        revision: ACE_STEP_PROVIDER_CODE_REVISION,
        version: '1.5.0',
      },
      runtime: {
        cudaBuild: '12.8',
        pytorch: '2.7.1+cu128',
        torchaudio: '2.7.1+cu128',
      },
      promotionReview: {
        assessment: 'REAL_BASE_QUALITY_PROFILE_VERIFIED',
        audibleAssessment: 'MASTER_CONFIRMED',
        evidenceSha256: ACE_STEP_BASE_QUALITY_EVIDENCE_SHA256,
        outputSha256ByTask: {
          cover: ACE_STEP_COVER_OUTPUT_SHA256,
          legoVocals: ACE_STEP_LEGO_VOCALS_OUTPUT_SHA256,
          textToMusic: ACE_STEP_TEXT_TO_MUSIC_OUTPUT_SHA256,
        },
      },
      targetObservation: {
        assessment: 'RUNTIME_REQUIREMENTS_MET',
        pythonVersion: '3.11.9',
      },
    });
    expect(ACE_STEP_RUNTIME_PROFILE.blockers).toEqual([]);
    expect(ACE_STEP_SUPPORT_MODEL_REPOSITORY).toBe('ACE-Step/Ace-Step1.5');
    expect(ACE_STEP_SUPPORT_MODEL_REVISION).toBe(
      '19671f406d603126926c1b7e2adc169acbcade22',
    );
  });

  it('keeps code, model, and unresolved distribution review separate', () => {
    expect(ACE_STEP_LICENSE_PROFILE).toMatchObject({
      modelWeights: {
        licenseSpdx: 'MIT',
        revision: ACE_STEP_MODEL_REVISION,
      },
      providerCode: {
        licenseSpdx: 'MIT',
        version: 'v0.1.8',
      },
      review: {
        distributionApproved: false,
        generatedOutputTerms: 'NOT_SEPARATELY_REVIEWED',
        trainingCorpusClaims: 'NOT_INDEPENDENTLY_VERIFIED',
        transitiveDependencyLicenses: 'PENDING',
      },
    });
    expect(ACE_STEP_LICENSE_PROFILE.providerCode).not.toBe(
      ACE_STEP_LICENSE_PROFILE.modelWeights,
    );
  });

  it('freezes the compatibility and license evidence', () => {
    expect(Object.isFrozen(ACE_STEP_RUNTIME_PROFILE)).toBe(true);
    expect(Object.isFrozen(ACE_STEP_RUNTIME_PROFILE.blockers)).toBe(true);
    expect(Object.isFrozen(ACE_STEP_RUNTIME_PROFILE.promotionReview)).toBe(true);
    expect(Object.isFrozen(ACE_STEP_RUNTIME_PROFILE.target.gpu)).toBe(true);
    expect(Object.isFrozen(ACE_STEP_LICENSE_PROFILE)).toBe(true);
    expect(Object.isFrozen(ACE_STEP_LICENSE_PROFILE.review)).toBe(true);
  });
});
