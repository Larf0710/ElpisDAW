import { isAbsolute } from 'node:path';

export function createAceStepPartialWavPath(stagingPath) {
  if (
    typeof stagingPath !== 'string' ||
    !isAbsolute(stagingPath) ||
    !stagingPath.toLowerCase().endsWith('.partial')
  ) {
    throw new TypeError('ACE-Step staging path must be an absolute .partial path.');
  }

  return `${stagingPath}.wav`;
}
