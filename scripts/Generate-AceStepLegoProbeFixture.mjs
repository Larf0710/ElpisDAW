import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ACE_STEP_LEGO_PROBE_DURATION_SECONDS = 10;
export const ACE_STEP_LEGO_PROBE_SAMPLE_RATE = 48_000;
export const ACE_STEP_LEGO_PROBE_CHANNELS = 2;
export const ACE_STEP_LEGO_PROBE_LYRICS = Object.freeze([
  '[Verse]',
  'Morning light is calling',
  'Carry every note home',
  '',
]);

const RIFF_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const BPM = 120;
const BEAT_SECONDS = 60 / BPM;
const ATTACK_SECONDS = 0.025;
const RELEASE_SECONDS = 0.08;
const CHORDS = Object.freeze([
  Object.freeze([130.8128, 164.8138, 195.9977]),
  Object.freeze([110.0, 130.8128, 164.8138]),
  Object.freeze([87.3071, 130.8128, 164.8138]),
  Object.freeze([97.9989, 146.8324, 195.9977]),
]);

export function createAceStepLegoProbeGuideWave() {
  const frameCount =
    ACE_STEP_LEGO_PROBE_SAMPLE_RATE * ACE_STEP_LEGO_PROBE_DURATION_SECONDS;
  const blockAlign = ACE_STEP_LEGO_PROBE_CHANNELS * BYTES_PER_SAMPLE;
  const dataByteLength = frameCount * blockAlign;
  const output = Buffer.alloc(RIFF_HEADER_BYTES + dataByteLength);

  writePcm16WaveHeader(output, dataByteLength, blockAlign);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeSeconds = frameIndex / ACE_STEP_LEGO_PROBE_SAMPLE_RATE;
    const beatPosition = timeSeconds / BEAT_SECONDS;
    const beatIndex = Math.floor(beatPosition);
    const beatPhaseSeconds = timeSeconds - beatIndex * BEAT_SECONDS;
    const chord = CHORDS[Math.floor(beatIndex / 4) % CHORDS.length];
    const chordEnvelope = Math.min(
      1,
      timeSeconds / 0.05,
      (ACE_STEP_LEGO_PROBE_DURATION_SECONDS - timeSeconds) / 0.08,
    );
    const pluckEnvelope = Math.min(
      1,
      beatPhaseSeconds / ATTACK_SECONDS,
      (BEAT_SECONDS - beatPhaseSeconds) / RELEASE_SECONDS,
    );
    let left = 0;
    let right = 0;

    for (let noteIndex = 0; noteIndex < chord.length; noteIndex += 1) {
      const frequency = chord[noteIndex];
      const phase = 2 * Math.PI * frequency * timeSeconds;
      const tone =
        Math.sin(phase) +
        0.18 * Math.sin(phase * 2) +
        0.07 * Math.sin(phase * 3);
      const pan = noteIndex / (chord.length - 1);

      left += tone * (1 - 0.35 * pan);
      right += tone * (0.65 + 0.35 * pan);
    }

    const clickPhase = 2 * Math.PI * 880 * beatPhaseSeconds;
    const clickEnvelope = Math.exp(-beatPhaseSeconds * 38);
    const click = Math.sin(clickPhase) * clickEnvelope * 0.09;
    const gain = Math.max(0, chordEnvelope) * Math.max(0, pluckEnvelope) * 0.105;

    writePcm16Sample(output, frameIndex, 0, left * gain + click);
    writePcm16Sample(output, frameIndex, 1, right * gain + click);
  }

  return output;
}

export async function writeAceStepLegoProbeFixture(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) {
    throw new TypeError('ACE-Step Lego Probe fixture directory must be absolute.');
  }

  await mkdir(outputDirectory, { recursive: false });

  const guidePath = join(outputDirectory, 'guide.wav');
  const lyricsPath = join(outputDirectory, 'lyrics.txt');
  const manifestPath = join(outputDirectory, 'fixture.json');
  const guideBytes = createAceStepLegoProbeGuideWave();
  const lyrics = `${ACE_STEP_LEGO_PROBE_LYRICS.join('\n')}`;
  const manifest = Object.freeze({
    channels: ACE_STEP_LEGO_PROBE_CHANNELS,
    durationSeconds: ACE_STEP_LEGO_PROBE_DURATION_SECONDS,
    guideSha256: sha256(guideBytes),
    guideSizeBytes: guideBytes.byteLength,
    lyricsSha256: sha256(Buffer.from(lyrics, 'utf8')),
    sampleRate: ACE_STEP_LEGO_PROBE_SAMPLE_RATE,
    source: 'deterministic-code-generated-compatibility-probe',
  });

  await writeFile(guidePath, guideBytes, { flag: 'wx' });
  await writeFile(lyricsPath, lyrics, { encoding: 'utf8', flag: 'wx' });
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );

  return Object.freeze({ guidePath, lyricsPath, manifest, manifestPath });
}

function writePcm16WaveHeader(output, dataByteLength, blockAlign) {
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(ACE_STEP_LEGO_PROBE_CHANNELS, 22);
  output.writeUInt32LE(ACE_STEP_LEGO_PROBE_SAMPLE_RATE, 24);
  output.writeUInt32LE(ACE_STEP_LEGO_PROBE_SAMPLE_RATE * blockAlign, 28);
  output.writeUInt16LE(blockAlign, 32);
  output.writeUInt16LE(BITS_PER_SAMPLE, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataByteLength, 40);
}

function writePcm16Sample(output, frameIndex, channelIndex, sample) {
  const boundedSample = Math.max(-1, Math.min(1, sample));
  const value = Math.max(
    -32_768,
    Math.min(32_767, Math.round(boundedSample * 30_000)),
  );
  const sampleOffset =
    RIFF_HEADER_BYTES +
    (frameIndex * ACE_STEP_LEGO_PROBE_CHANNELS + channelIndex) * BYTES_PER_SAMPLE;

  output.writeInt16LE(value, sampleOffset);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function runCli(args) {
  if (args.length !== 1 || !isAbsolute(args[0])) {
    throw new Error('Pass exactly one absolute output directory path.');
  }

  const fixture = await writeAceStepLegoProbeFixture(args[0]);
  process.stdout.write(
    `${JSON.stringify({ ...fixture.manifest, status: 'FIXTURE_READY' })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli(process.argv.slice(2));
}
