import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import type { AudioArtifact } from './types';

const MAX_GENERATED_WAV_BYTES = 512 * 1024 * 1024;
export const GENERATED_AUDIO_PROJECT_DIRECTORIES = Object.freeze([
  'recordings',
  'renders/instruments',
  'renders/stable-audio-3',
  'renders/ace-step',
  'mixdowns',
  'print-mixes',
  'stem-prints',
  'exports',
]);

export function createLocalEngineGeneratedAudioDescriptor(
  artifact: AudioArtifact,
): LocalEngineGeneratedAudioDescriptor | undefined {
  const { file } = artifact;

  if (
    artifact.artifactId.length === 0 ||
    artifact.artifactId.trim() !== artifact.artifactId ||
    artifact.artifactId.length > 256 ||
    file.extension !== '.wav' ||
    typeof file.name !== 'string' ||
    file.name.length === 0 ||
    file.name.trim() !== file.name ||
    file.name.length > 1_024 ||
    file.name.includes('/') ||
    file.name.includes('\\') ||
    file.name !== `${artifact.artifactId}.wav` ||
    !file.name.endsWith('.wav') ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 44 ||
    file.sizeBytes > MAX_GENERATED_WAV_BYTES ||
    !isNormalizedAudioProjectPath(file.relativePath, file.name)
  ) {
    return undefined;
  }

  return Object.freeze({
    kind: 'generated' as const,
    name: file.name,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    sourceId: artifact.artifactId,
  });
}

function isNormalizedAudioProjectPath(
  relativePath: string,
  fileName: string,
): boolean {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.trim() !== relativePath ||
    relativePath.length > 4_096 ||
    relativePath.includes('\\') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    return false;
  }

  const segments = relativePath.split('/');

  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    ) ||
    segments[segments.length - 1] !== fileName ||
    relativePath.toLowerCase().endsWith('.partial') ||
    !relativePath.endsWith('.wav')
  ) {
    return false;
  }

  return GENERATED_AUDIO_PROJECT_DIRECTORIES.some(
    (directory) =>
      relativePath.startsWith(`${directory}/`) &&
      relativePath.length > directory.length + 1,
  );
}
