import { describe, expect, it } from 'vitest';

import {
  STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
  STABLE_AUDIO_3_GENERATION_EVIDENCE_SHA256,
  STABLE_AUDIO_3_GENERATION_OUTPUT_SHA256,
  STABLE_AUDIO_3_GENERATION_VERIFICATION_SHA256,
  STABLE_AUDIO_3_LICENSE_PROFILE,
  STABLE_AUDIO_3_RUNTIME_PROFILE,
  STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
} from './stableAudio3RuntimeProfile.mjs';

describe('current Stable Audio 3 Runtime Profile', () => {
  it('promotes only the exact Runtime backed by verified real generation', () => {
    expect(STABLE_AUDIO_3_RUNTIME_PROFILE).toMatchObject({
      blockers: [],
      compatibility: 'COMPATIBLE',
      model: {
        access: 'GATED_TERMS_ACCEPTED',
        revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      },
      profileId: STABLE_AUDIO_3_RUNTIME_PROFILE_ID,
      promotionReview: {
        assessment: 'ACCEPTED_FOR_REVIEW',
        evidenceSha256: STABLE_AUDIO_3_GENERATION_EVIDENCE_SHA256,
        evidenceProfileId: STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
        fileStatus: 'FILES_VERIFIED',
        generationOutputSha256: STABLE_AUDIO_3_GENERATION_OUTPUT_SHA256,
        reviewedAt: '2026-08-05',
        verificationSha256: STABLE_AUDIO_3_GENERATION_VERIFICATION_SHA256,
      },
      runtime: {
        cuda: '12.6.3-native-windows-toolkit',
        flashAttention: '2.8.3-native-windows-local-wheel',
        flashAttentionSourceRevision:
          '060c9188beec3a8b62b33a3bfa6d5d2d44975fab',
        flashAttentionWheelSha256:
          '74e2409ecafcfe1a5f07e64acfd309d87f0f1a69cdc557861c72787767031a28',
        flashAttentionWheelTag: 'cp310-cp310-win_amd64',
      },
      target: {
        platform: 'win32',
        pythonLauncherDetected: true,
        verifiedAt: '2026-08-05',
      },
    });
    expect(STABLE_AUDIO_3_RUNTIME_PROFILE.blockers).toHaveLength(0);
    expect(STABLE_AUDIO_3_LICENSE_PROFILE.review).toEqual({
      distributionApproved: false,
      modelAccessAccepted: true,
      transitiveDependencyLicenses: 'PENDING',
    });
    expect(STABLE_AUDIO_3_LICENSE_PROFILE.textEncoder.termsAccepted).toBe(true);
  });

  it('keeps the factual profile and license boundaries immutable', () => {
    expect(Object.isFrozen(STABLE_AUDIO_3_RUNTIME_PROFILE)).toBe(true);
    expect(Object.isFrozen(STABLE_AUDIO_3_RUNTIME_PROFILE.blockers)).toBe(true);
    expect(Object.isFrozen(STABLE_AUDIO_3_RUNTIME_PROFILE.promotionReview)).toBe(
      true,
    );
    expect(Object.isFrozen(STABLE_AUDIO_3_RUNTIME_PROFILE.target)).toBe(true);
    expect(Object.isFrozen(STABLE_AUDIO_3_LICENSE_PROFILE)).toBe(true);
    expect(Object.isFrozen(STABLE_AUDIO_3_LICENSE_PROFILE.review)).toBe(true);
  });
});
