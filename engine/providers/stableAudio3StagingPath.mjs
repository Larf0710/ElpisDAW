import { isAbsolute } from 'node:path';

export function createStableAudio3PartialWavPath(stagingPath) {
  if (
    typeof stagingPath !== 'string' ||
    !isAbsolute(stagingPath) ||
    !stagingPath.toLowerCase().endsWith('.partial')
  ) {
    throw new TypeError('Stable Audio 3 staging path must be an absolute .partial path.');
  }

  return `${stagingPath}.wav`;
}
