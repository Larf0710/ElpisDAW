import { describe, expect, it } from 'vitest';

import {
  canRequestAceStepVocalCancellation,
  isAceStepVocalUiActive,
  resolveAceStepVocalAction,
  type AceStepVocalUiState,
} from './aceStepVocalCancellation';

describe('ACE Vocals cancellation UI contract', () => {
  it.each(['QUEUED', 'LOADING_MODEL', 'PROCESSING'] as const)(
    'offers exact-owner cancellation while the Job is %s',
    (status) => {
      const state = createState(status);

      expect(resolveAceStepVocalAction({
        canGenerate: false,
        patchTabId: 'patch-ace-a',
        state,
      })).toEqual({ action: 'CANCEL', ariaBusy: true, disabled: false });
      expect(canRequestAceStepVocalCancellation(state, 'patch-ace-a')).toBe(true);
    },
  );

  it.each([
    'SAVING_LYRICS',
    'ENQUEUEING',
    'CANCEL_REQUESTED',
    'SAVING',
    'COMPLETED',
  ] as const)('uses WAIT while %s cannot be canceled safely', (status) => {
    const state = createState(status);

    expect(resolveAceStepVocalAction({
      canGenerate: false,
      patchTabId: 'patch-ace-a',
      state,
    })).toEqual({ action: 'WAIT', ariaBusy: true, disabled: true });
    expect(canRequestAceStepVocalCancellation(state, 'patch-ace-a')).toBe(false);
  });

  it('fails closed for a different PatchTab owner', () => {
    const state = createState('PROCESSING');

    expect(resolveAceStepVocalAction({
      canGenerate: true,
      patchTabId: 'patch-ace-b',
      state,
    })).toEqual({ action: 'WAIT', ariaBusy: false, disabled: true });
    expect(canRequestAceStepVocalCancellation(state, 'patch-ace-b')).toBe(false);
  });

  it('requires an accepted exact Job ID before cancellation', () => {
    const state: AceStepVocalUiState = {
      patchTabId: 'patch-ace-a',
      status: 'PROCESSING',
    };

    expect(resolveAceStepVocalAction({
      canGenerate: false,
      patchTabId: 'patch-ace-a',
      state,
    }).action).toBe('WAIT');
  });

  it('releases active ownership after CANCELED so a later generation is available', () => {
    const state = createState('CANCELED');

    expect(isAceStepVocalUiActive(state)).toBe(false);
    expect(resolveAceStepVocalAction({
      canGenerate: true,
      patchTabId: 'patch-ace-a',
      state,
    })).toEqual({ action: 'GENERATE', ariaBusy: false, disabled: false });
  });
});

function createState(status: AceStepVocalUiState['status']): AceStepVocalUiState {
  return {
    jobId: 'job-ace-a',
    patchTabId: 'patch-ace-a',
    status,
  };
}
