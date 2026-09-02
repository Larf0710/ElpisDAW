import { describe, expect, it } from 'vitest';

import { STABLE_AUDIO_3_PROVIDER_ID } from '../shared/stableAudio3Protocol.js';
import { resolveFinalFilerExportTarget } from './finalFilerExportTarget';
import {
  FINAL_FILER_TEST_MASTER_CLIP_ID,
  FINAL_FILER_TEST_RAW_CLIP_ID,
  createFinalFilerTestProject,
  createFinalFilerTestWav,
} from './finalFilerTestFixture';
import {
  createFinalFilerSourceReport,
  parseFinalFilerWavMetadata,
  sha256Blob,
  sha256Text,
} from './finalFilerSourceReport';

describe('FINAL FILER Source Report', () => {
  it.each([
    ['Raw Mix', 'raw', FINAL_FILER_TEST_RAW_CLIP_ID],
    ['Stable Audio 3 Master', 'master', FINAL_FILER_TEST_MASTER_CLIP_ID],
  ] as const)('creates a deterministic %s report with non-self-referential integrity', async (
    sourceClass,
    selected,
    clipId,
  ) => {
    const project = createFinalFilerTestProject(selected);
    const resolution = resolveFinalFilerExportTarget(project, clipId);
    const wav = createFinalFilerTestWav();

    if (!resolution.canExport) {
      throw new Error(resolution.message);
    }

    const request = {
      buildIdentity: { gitCommit: 'ce09e2f', version: '0.1.0' },
      exportedAtUtc: '2026-08-16T12:34:56.000Z',
      fileName: 'HumStudio-delivery.wav',
      mediaSha256: await sha256Blob(wav),
      project,
      target: resolution.exportTarget,
      wavMetadata: await parseFinalFilerWavMetadata(wav),
    };
    const first = await createFinalFilerSourceReport(request);
    const second = await createFinalFilerSourceReport(request);

    expect(second).toEqual(first);
    expect(first.fileName).toBe('HumStudio-delivery-source-report.txt');
    expect(first.text).toContain(`Final Source Class: ${sourceClass}`);
    expect(first.text).toContain('Exported At UTC: 2026-08-16T12:34:56.000Z');
    expect(first.text).toContain('ElpisDAW Version: 0.1.0');
    expect(first.text).toContain('Git Commit: ce09e2f');
    expect(first.text).toContain('WAV Sample Rate: 44100');
    expect(first.text).toContain('WAV Channels: 2');
    expect(first.text).toContain('WAV Bits Per Sample: 16');
    expect(first.text).toContain('WAV Media SHA-256:');
    expect(first.text).toContain(
      `Integrity Hash: SHA-256 ${await sha256Text(first.body)}`,
    );
    expect(first.body).not.toContain('Integrity Hash:');
    expect(first.text).not.toMatch(/[a-z]:\\|\\\\|bearer\s|token=/i);

    if (selected === 'master') {
      expect(first.text).toContain(
        `Stable Audio 3 Provider: ${STABLE_AUDIO_3_PROVIDER_ID}`,
      );
      expect(first.text).toContain('Stable Audio 3 Seed: 42');
      expect(first.text).toContain('"prompt":"Master polish"');
    } else {
      expect(first.text).toContain('Stable Audio 3 Provider: Unavailable');
    }
  });

  it('reports unavailable build identity instead of leaking path or token-like values', async () => {
    const project = createFinalFilerTestProject();
    const resolution = resolveFinalFilerExportTarget(
      project,
      FINAL_FILER_TEST_RAW_CLIP_ID,
    );
    const wav = createFinalFilerTestWav();

    if (!resolution.canExport) {
      throw new Error(resolution.message);
    }

    const report = await createFinalFilerSourceReport({
      buildIdentity: {
        gitCommit: 'C:\\Users\\person\\secret',
        version: 'token=do-not-emit',
      },
      exportedAtUtc: '2026-08-16T12:34:56.000Z',
      fileName: 'delivery.wav',
      mediaSha256: await sha256Blob(wav),
      project,
      target: resolution.exportTarget,
      wavMetadata: await parseFinalFilerWavMetadata(wav),
    });

    expect(report.text).toContain('ElpisDAW Version: Unavailable');
    expect(report.text).toContain('Git Commit: Unavailable');
    expect(report.text).not.toContain('person');
    expect(report.text).not.toContain('do-not-emit');
  });

  it('rejects malformed WAV metadata and non-canonical UTC input', async () => {
    await expect(
      parseFinalFilerWavMetadata(new Blob(['not wav'], { type: 'audio/wav' })),
    ).rejects.toThrow(/invalid WAV/i);

    const project = createFinalFilerTestProject();
    const resolution = resolveFinalFilerExportTarget(
      project,
      FINAL_FILER_TEST_RAW_CLIP_ID,
    );

    if (!resolution.canExport) {
      throw new Error(resolution.message);
    }

    await expect(
      createFinalFilerSourceReport({
        buildIdentity: {},
        exportedAtUtc: '2026-08-16',
        fileName: 'delivery.wav',
        mediaSha256: 'a'.repeat(64),
        project,
        target: resolution.exportTarget,
        wavMetadata: {
          bitsPerSample: 16,
          channels: 2,
          dataBytes: 4,
          durationSeconds: 1 / 44_100,
          frameCount: 1,
          sampleRate: 44_100,
        },
      }),
    ).rejects.toThrow(/UTC timestamp/i);
  });
});
