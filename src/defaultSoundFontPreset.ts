import defaultSoundFontManifest from '../shared/defaultSoundFontManifest.json';

import type { LocalEngineSoundFontResource } from './localEngineClient';

export const HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH =
  defaultSoundFontManifest.preferredSoundFontRelativePath;

export function getPreferredSoundFontResource(
  resources: readonly LocalEngineSoundFontResource[],
  assignedResourceId?: string,
) {
  return (
    (assignedResourceId
      ? resources.find((resource) => resource.resourceId === assignedResourceId)
      : undefined) ??
    resources.find(
      (resource) =>
        resource.library === 'builtin' &&
        resource.relativePath === HUMSTUDIO_DEFAULT_SOUNDFONT_RELATIVE_PATH,
    ) ??
    resources[0]
  );
}
