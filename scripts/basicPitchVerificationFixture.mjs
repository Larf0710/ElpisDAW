import {
  BASIC_PITCH_MODEL_ID,
  BASIC_PITCH_MODEL_REVISION,
  BASIC_PITCH_PROVIDER_ID,
  BASIC_PITCH_TASK_ID,
  BASIC_PITCH_TICKS_PER_QUARTER,
} from '../engine/providers/basicPitchProviderDefinition.mjs';

export function createBasicPitchVerificationJobRequest({
  artifactId = 'artifact-basic-pitch-recording-verification',
  clipTakeId = 'clip-take-basic-pitch-recording-verification',
  frameThreshold = 0.3,
  maximumFrequencyHz = 880,
  melodiaTrick = true,
  minimumFrequencyHz = 220,
  minimumNoteLengthMs = 127.7,
  onsetThreshold = 0.5,
  projectBpm = 120,
  relativePath,
  sourceEndSeconds = 3.5,
  sourceStartSeconds = 0.5,
}) {
  return Object.freeze({
    inputArtifacts: Object.freeze([
      Object.freeze({ artifactId, kind: 'audio', relativePath }),
    ]),
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze([artifactId]),
      parentClipTakeIds: Object.freeze([clipTakeId]),
    }),
    modelId: BASIC_PITCH_MODEL_ID,
    modelRevision: BASIC_PITCH_MODEL_REVISION,
    output: Object.freeze({ artifactKind: 'midi' }),
    parameters: Object.freeze({
      frameThreshold,
      maximumFrequencyHz,
      melodiaTrick,
      minimumFrequencyHz,
      minimumNoteLengthMs,
      multiplePitchBends: false,
      onsetThreshold,
      projectBpm,
      sourceEndSeconds,
      sourceStartSeconds,
      ticksPerQuarter: BASIC_PITCH_TICKS_PER_QUARTER,
    }),
    providerId: BASIC_PITCH_PROVIDER_ID,
    taskId: BASIC_PITCH_TASK_ID,
  });
}

export function createBasicPitchHumLikeWave() {
  const sampleRate = 22_050;
  const durationSeconds = 4;
  const frameCount = sampleRate * durationSeconds;
  const output = Buffer.alloc(44 + frameCount * 2);

  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(frameCount * 2, 40);

  let phase = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeSeconds = frameIndex / sampleRate;
    const selectedTimeSeconds = timeSeconds - 0.5;
    let sample = 0;

    if (selectedTimeSeconds >= 0 && selectedTimeSeconds < 3) {
      const vibrato = 2 ** (
        (0.22 * Math.sin(2 * Math.PI * 5.2 * selectedTimeSeconds)) / 12
      );
      phase += (2 * Math.PI * 440 * vibrato) / sampleRate;
      const attack = Math.min(1, selectedTimeSeconds / 0.08);
      const release = Math.min(1, (3 - selectedTimeSeconds) / 0.12);
      const envelope = Math.max(0, Math.min(attack, release));
      sample = envelope * (
        0.72 * Math.sin(phase) +
        0.19 * Math.sin(phase * 2) +
        0.09 * Math.sin(phase * 3)
      );
    }

    const value = Math.max(-32_768, Math.min(32_767, Math.round(sample * 24_000)));
    output.writeInt16LE(value, 44 + frameIndex * 2);
  }

  return output;
}
