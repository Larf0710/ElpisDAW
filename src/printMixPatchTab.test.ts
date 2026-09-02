import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getPatchTabDefinition,
  inferBuiltinPatchTabTypeId,
  migratePatchTabContract,
} from './patchTabPortContract';
import {
  createPrintMixPatchTab,
  isPrintMixPatchTab,
  resolvePrintMixNormalize,
} from './printMixPatchTab';
import type { PatchTab } from './types';

describe('PRINT MIX PatchTab contract', () => {
  it('defines a separate versioned multi-Clip node with Audio-only Normalize default On', () => {
    const patchTab = createPrintMixPatchTab('print-mix', 4);

    expect(patchTab).toMatchObject({
      name: 'PRINT MIX',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
      nodeVersion: '1.0.0',
    });
    expect(getPatchTabDefinition(patchTab)).toMatchObject({
      inputs: [
        {
          cardinality: { min: 2, max: 'many' },
          id: 'media-in',
        },
      ],
      outputs: [
        { dataCategory: 'audio', id: 'audio-out', role: 'print-mix' },
        { dataCategory: 'midi', id: 'midi-out', role: 'print-mix' },
      ],
    });
    expect(isPrintMixPatchTab(patchTab)).toBe(true);
    expect(resolvePrintMixNormalize(patchTab)).toBe(true);
    expect(Object.isFrozen(patchTab)).toBe(true);
  });

  it('keeps historical Clip Filer nodes distinguishable and never name-migrates them to PRINT MIX', () => {
    const historical: PatchTab = {
      colorIndex: 4,
      description: 'Historical export node',
      id: 'historical-clip-filer',
      inputType: 'Selected Clip',
      name: 'Clip Filer',
      outputType: 'Export File',
      parameters: [],
      status: 'ready',
    };
    const userRenamedHistorical = { ...historical, name: 'PRINT MIX' };

    expect(migratePatchTabContract(historical)).toMatchObject({
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
      nodeVersion: '1.0.0',
    });
    expect(inferBuiltinPatchTabTypeId(userRenamedHistorical)).toBeUndefined();
    expect(migratePatchTabContract(userRenamedHistorical)).toEqual(
      userRenamedHistorical,
    );
    expect(isPrintMixPatchTab(userRenamedHistorical)).toBe(false);
  });

  it('fails closed on a stale or colliding persisted contract snapshot', () => {
    const patchTab = structuredClone(createPrintMixPatchTab('print-mix', 0));
    if (!patchTab.portContractSnapshot) {
      throw new Error('Missing PRINT MIX contract snapshot fixture.');
    }
    patchTab.portContractSnapshot.inputs[0].cardinality.min = 1;

    expect(isPrintMixPatchTab(patchTab)).toBe(false);
  });
});
