import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACE_STEP_LEGO_PROBE_CHANNELS,
  ACE_STEP_LEGO_PROBE_DURATION_SECONDS,
  ACE_STEP_LEGO_PROBE_SAMPLE_RATE,
  createAceStepLegoProbeGuideWave,
  writeAceStepLegoProbeFixture,
} from './Generate-AceStepLegoProbeFixture.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('ACE-Step Lego Probe fixture', () => {
  it('creates one deterministic stereo 48 kHz PCM16 guide wave', () => {
    const first = createAceStepLegoProbeGuideWave();
    const second = createAceStepLegoProbeGuideWave();
    const expectedDataBytes =
      ACE_STEP_LEGO_PROBE_SAMPLE_RATE *
      ACE_STEP_LEGO_PROBE_DURATION_SECONDS *
      ACE_STEP_LEGO_PROBE_CHANNELS *
      2;

    expect(first).toEqual(second);
    expect(first.byteLength).toBe(44 + expectedDataBytes);
    expect(first.toString('ascii', 0, 4)).toBe('RIFF');
    expect(first.readUInt32LE(4)).toBe(first.byteLength - 8);
    expect(first.toString('ascii', 8, 12)).toBe('WAVE');
    expect(first.readUInt16LE(20)).toBe(1);
    expect(first.readUInt16LE(22)).toBe(ACE_STEP_LEGO_PROBE_CHANNELS);
    expect(first.readUInt32LE(24)).toBe(ACE_STEP_LEGO_PROBE_SAMPLE_RATE);
    expect(first.readUInt16LE(34)).toBe(16);
    expect(first.readUInt32LE(40)).toBe(expectedDataBytes);
    expect(first.subarray(44).some((value) => value !== 0)).toBe(true);
  });

  it('writes an immutable fixture set with matching hashes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'humstudio-ace-step-fixture-'));
    temporaryDirectories.push(parent);
    const outputDirectory = join(parent, 'fixture');
    const fixture = await writeAceStepLegoProbeFixture(outputDirectory);
    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'));

    expect(manifest).toEqual(fixture.manifest);
    expect(await readFile(fixture.guidePath)).toEqual(
      createAceStepLegoProbeGuideWave(),
    );
    expect(await readFile(fixture.lyricsPath, 'utf8')).toContain(
      'Morning light is calling',
    );
    await expect(
      writeAceStepLegoProbeFixture(outputDirectory),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects relative output paths', async () => {
    await expect(
      writeAceStepLegoProbeFixture('relative-fixture'),
    ).rejects.toThrowError('fixture directory must be absolute');
  });
});
