import { describe, expect, it } from 'vitest';

import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { resolvePatchTabTemplateAvailability } from './patchTabTemplateAvailability';

describe('PatchTab template availability', () => {
  it('makes ACE Vocals available after real Base-model verification', () => {
    expect(
      resolvePatchTabTemplateAvailability({
        name: 'ACE Vocals',
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
      }),
    ).toEqual({
      canCreate: true,
      label: 'ACE Vocals',
    });
  });

  it('leaves available templates unchanged', () => {
    expect(
      resolvePatchTabTemplateAvailability({
        name: 'ACE COVER',
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover,
      }),
    ).toEqual({
      canCreate: true,
      label: 'ACE COVER',
    });
  });
});
