import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';

import { FluidSynthRuntime } from '../engine/fluidSynthRuntime.mjs';
import { encodeStandardMidiFile } from '../engine/midiFileEncoder.mjs';

const inputPath = process.argv[2];

if (!inputPath) {
  throw new Error(
    'Pass an absolute .sf2 or .sf3 path to verify the FluidSynth render runtime.',
  );
}

const soundFontPath = isAbsolute(inputPath)
  ? inputPath
  : resolve(process.cwd(), inputPath);
const extension = extname(soundFontPath).toLowerCase();

if (extension !== '.sf2' && extension !== '.sf3') {
  throw new Error('FluidSynth verification requires a .sf2 or .sf3 file.');
}

const soundFontStat = await lstat(soundFontPath);

if (soundFontStat.isSymbolicLink() || !soundFontStat.isFile()) {
  throw new Error('FluidSynth verification requires a regular SoundFont file.');
}

const canonicalSoundFontPath = await realpath(soundFontPath);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'humstudio-fluidsynth-verification-'),
);
const midiPath = join(temporaryDirectory, 'verification.mid');
const outputPath = join(temporaryDirectory, 'verification.wav');

try {
  await writeFile(
    midiPath,
    encodeStandardMidiFile({
      bank: 0,
      bpm: 120,
      notes: [
        {
          id: 'verification-note',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      program: 0,
      ticksPerQuarter: 960,
    }),
    { flag: 'wx' },
  );
  const runtime = new FluidSynthRuntime();
  const runtimeInfo = await runtime.verify();
  await runtime.renderMidiToWav({
    midiPath,
    outputPath,
    soundFontPath: canonicalSoundFontPath,
  });
  const wav = await readFile(outputPath);

  if (
    wav.length < 44 ||
    wav.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    wav.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    throw new Error('FluidSynth verification output is not a valid RIFF/WAVE file.');
  }

  process.stdout.write(
    [
      `FluidSynth ${runtimeInfo.version} render verified.`,
      `SoundFont: ${canonicalSoundFontPath}`,
      `Temporary WAV bytes: ${wav.length}`,
      'Temporary verification files removed.',
    ].join('\n') + '\n',
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
