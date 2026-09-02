import { describe, expect, it } from 'vitest';

import {
  getPreferredSoundFontResource,
  HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
} from './defaultSoundFontPreset';
import type { LocalEngineSoundFontResource } from './localEngineClient';

describe('default SoundFont preset selection', () => {
  const customResource = createResource(
    `soundfont-${'a'.repeat(32)}`,
    'soundfonts/A Custom.sf2',
  );
  const defaultResource = createResource(
    `soundfont-${'b'.repeat(32)}`,
    HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
  );

  it('keeps the clip assignment when its resource is available', () => {
    expect(
      getPreferredSoundFontResource(
        [defaultResource, customResource],
        customResource.resourceId,
      ),
    ).toBe(customResource);
  });

  it('prefers MuseScore General over an earlier custom catalog entry', () => {
    expect(getPreferredSoundFontResource([customResource, defaultResource])).toBe(
      defaultResource,
    );
  });

  it('falls back to the first custom resource when the default is unavailable', () => {
    expect(getPreferredSoundFontResource([customResource])).toBe(customResource);
  });
});

function createResource(
  resourceId: string,
  relativePath: string,
): LocalEngineSoundFontResource {
  const pathParts = relativePath.split('/');

  return {
    format: relativePath.endsWith('.sf3') ? 'sf3' : 'sf2',
    lastModifiedAt: '2026-08-22T00:00:00.000Z',
    library:
      relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH
        ? 'builtin'
        : 'project',
    name: pathParts[pathParts.length - 1],
    relativePath,
    resourceId,
    revisionToken: `${resourceId}-revision`,
    sizeBytes: 1024,
    status: 'AVAILABLE',
  };
}
