import { describe, expect, it } from 'vitest';

import { createMixerProjectStemPrintControlModel } from './projectStemPrintUiState';

const ready = {
  engineAcceptsNewJobs: true,
  engineAvailabilityMessage: 'READY',
  hasRawMixdownLock: false,
  hasSelection: true,
  isProjectRootReady: true,
} as const;

describe('Mixer Project Stem Print control model', () => {
  it('requires one target before enabling STEM PRINT', () => {
    expect(createMixerProjectStemPrintControlModel({
      ...ready,
      hasSelection: false,
      state: { status: 'IDLE' },
    })).toMatchObject({ canRun: false, label: 'SELECT TARGETS' });
    expect(createMixerProjectStemPrintControlModel({
      ...ready,
      state: { status: 'IDLE' },
    })).toMatchObject({ canRun: true, label: 'READY' });
  });

  it('exposes contextual cancel and exact recovery actions', () => {
    expect(createMixerProjectStemPrintControlModel({
      ...ready,
      state: { status: 'RUNNING' },
    })).toMatchObject({ canCancel: true, showCancel: true });
    expect(createMixerProjectStemPrintControlModel({
      ...ready,
      state: { status: 'OUTCOME_UNKNOWN' },
    })).toMatchObject({ canRecover: true, showRecover: true });
  });

  it('blocks Stem dispatch while Raw Mixdown owns the render lock', () => {
    expect(createMixerProjectStemPrintControlModel({
      ...ready,
      hasRawMixdownLock: true,
      state: { status: 'IDLE' },
    })).toMatchObject({ canRun: false, label: 'BUSY' });
  });

  it('keeps an unknown Stem outcome dominant over new dispatch', () => {
    expect(createMixerProjectStemPrintControlModel({
      ...ready,
      hasRawMixdownLock: true,
      state: { status: 'OUTCOME_UNKNOWN' },
    })).toMatchObject({ canRun: false, label: 'OUTCOME UNKNOWN' });
  });
});
