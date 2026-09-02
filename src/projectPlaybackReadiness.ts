export function canReadGeneratedAudioForProjectPlayback({
  hasGeneratedAudioReader,
  projectRootReady,
}: Readonly<{
  hasGeneratedAudioReader: boolean;
  projectRootReady: boolean;
}>): boolean {
  return hasGeneratedAudioReader && projectRootReady;
}
