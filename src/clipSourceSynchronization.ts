import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import type { AudioArtifact, ClipSourceFile } from './types';

export function createSynchronizedClipSourceFile(
  artifact: AudioArtifact,
  currentSourceFile?: ClipSourceFile,
  availabilityEvidence?: GeneratedAudioCommitAvailabilityEvidence,
): ClipSourceFile {
  const currentMatches = doesClipSourceFileMatchArtifact(
    currentSourceFile,
    artifact,
  );
  const isVerifiedAvailable = Boolean(
    availabilityEvidence?.availableArtifactIds.includes(artifact.artifactId),
  );

  if (
    isVerifiedAvailable &&
    (!availabilityEvidence ||
      Number.isNaN(Date.parse(availabilityEvidence.checkedAt)))
  ) {
    throw new Error('Generated audio availability evidence checkedAt is invalid.');
  }

  if (currentMatches && !isVerifiedAvailable) {
    return currentSourceFile as ClipSourceFile;
  }

  return {
    durationSeconds: artifact.audio.durationSeconds,
    mimeType: artifact.audio.mimeType,
    name: artifact.file.name,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
    sourceId: artifact.artifactId,
    status: isVerifiedAvailable
      ? 'available'
      : currentMatches
        ? (currentSourceFile as ClipSourceFile).status
        : 'unresolved',
    ...(isVerifiedAvailable
      ? { checkedAt: availabilityEvidence?.checkedAt }
      : currentMatches && currentSourceFile?.checkedAt
        ? { checkedAt: currentSourceFile.checkedAt }
        : {}),
    ...(currentMatches && currentSourceFile?.lastModified !== undefined
      ? { lastModified: currentSourceFile.lastModified }
      : {}),
  };
}

export function doesClipSourceFileMatchArtifact(
  sourceFile: ClipSourceFile | undefined,
  artifact: AudioArtifact,
): boolean {
  return Boolean(
    sourceFile &&
      sourceFile.sourceId === artifact.artifactId &&
      sourceFile.name === artifact.file.name &&
      sourceFile.relativePath === artifact.file.relativePath &&
      sourceFile.sizeBytes === artifact.file.sizeBytes &&
      sourceFile.durationSeconds === artifact.audio.durationSeconds &&
      sourceFile.mimeType === artifact.audio.mimeType &&
      sourceFile.path === undefined &&
      sourceFile.lastKnownPath === undefined,
  );
}
