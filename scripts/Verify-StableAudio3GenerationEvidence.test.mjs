import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadStableAudio3GenerationEvidenceFile,
  runStableAudio3GenerationEvidenceCli,
  StableAudio3GenerationEvidenceCliError,
} from './Verify-StableAudio3GenerationEvidence.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('Stable Audio 3 generation evidence CLI', () => {
  it('composes the verifier and emits a sanitized success envelope', async () => {
    const paths = await createPaths();
    const evidence = { acceptanceVersion: '1' };
    const files = Object.freeze({
      input: Object.freeze({
        sha256: 'a'.repeat(64),
        sizeBytes: 100,
        wave: Object.freeze({
          channels: 1,
          container: 'RIFF/WAVE',
          durationSeconds: 1,
          sampleRate: 44_100,
        }),
      }),
      model: Object.freeze([
        Object.freeze({
          path: 'model.safetensors',
          sha256: 'b'.repeat(64),
          sizeBytes: 200,
        }),
      ]),
      output: Object.freeze({
        sha256: 'c'.repeat(64),
        sizeBytes: 300,
        wave: Object.freeze({
          channels: 2,
          container: 'RIFF/WAVE',
          durationSeconds: 1,
          sampleRate: 44_100,
        }),
      }),
    });
    const calls = [];
    const output = [];
    const exitCode = await runStableAudio3GenerationEvidenceCli(
      [
        paths.evidencePath,
        paths.inputPath,
        paths.modelRootPath,
        paths.outputPath,
      ],
      {
        loadEvidence: async (path) => {
          calls.push({ kind: 'load', path });
          return evidence;
        },
        verifyEvidenceFiles: async (value, locations) => {
          calls.push({ evidence: value, kind: 'verify', locations });
          return {
            assessment: {
              status: 'ACCEPTED_FOR_REVIEW',
              supportsCancellation: false,
            },
            files,
            status: 'FILES_VERIFIED',
          };
        },
        writeOutput: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { kind: 'load', path: paths.evidencePath },
      {
        evidence,
        kind: 'verify',
        locations: {
          inputPath: paths.inputPath,
          modelRootPath: paths.modelRootPath,
          outputPath: paths.outputPath,
        },
      },
    ]);
    expect(JSON.parse(output.join(''))).toEqual({
      assessment: {
        status: 'ACCEPTED_FOR_REVIEW',
        supportsCancellation: false,
      },
      files,
      status: 'FILES_VERIFIED',
    });
    expect(output.join('')).not.toContain(paths.directory);
  });

  it('returns exit code 2 for evidence rejection without leaking error details', async () => {
    const paths = await createPaths();
    const error = Object.assign(new Error(`Secret path: ${paths.inputPath}`), {
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
    });
    const output = [];
    const exitCode = await runStableAudio3GenerationEvidenceCli(
      [
        paths.evidencePath,
        paths.inputPath,
        paths.modelRootPath,
        paths.outputPath,
      ],
      {
        loadEvidence: async () => ({}),
        verifyEvidenceFiles: async () => {
          throw error;
        },
        writeOutput: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(output.join(''))).toEqual({
      error: {
        code: 'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
        message:
          'Stable Audio 3 generation evidence did not pass verification.',
      },
      status: 'VERIFICATION_REJECTED',
    });
    expect(output.join('')).not.toContain(paths.directory);
  });

  it('returns exit code 1 for invalid usage before loading evidence', async () => {
    const loadEvidence = vi.fn();
    const output = [];
    const exitCode = await runStableAudio3GenerationEvidenceCli(
      ['relative-evidence.json'],
      {
        loadEvidence,
        writeOutput: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(1);
    expect(loadEvidence).not.toHaveBeenCalled();
    expect(JSON.parse(output.join(''))).toMatchObject({
      error: { code: 'STABLE_AUDIO_3_EVIDENCE_CLI_USAGE_INVALID' },
      status: 'VERIFICATION_FAILED',
    });
  });

  it('sanitizes an unexpected error code before writing output', async () => {
    const paths = await createPaths();
    const output = [];
    const exitCode = await runStableAudio3GenerationEvidenceCli(
      [
        paths.evidencePath,
        paths.inputPath,
        paths.modelRootPath,
        paths.outputPath,
      ],
      {
        loadEvidence: async () => ({}),
        verifyEvidenceFiles: async () => {
          throw Object.assign(new Error('Unexpected failure.'), {
            code: paths.inputPath,
          });
        },
        writeOutput: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join(''))).toEqual({
      error: {
        code: 'STABLE_AUDIO_3_EVIDENCE_VERIFICATION_FAILED',
        message:
          'Stable Audio 3 generation evidence could not be verified.',
      },
      status: 'VERIFICATION_FAILED',
    });
    expect(output.join('')).not.toContain(paths.directory);
  });

  it('rejects an invalid verifier response as an execution failure', async () => {
    const paths = await createPaths();
    const output = [];
    const exitCode = await runStableAudio3GenerationEvidenceCli(
      [
        paths.evidencePath,
        paths.inputPath,
        paths.modelRootPath,
        paths.outputPath,
      ],
      {
        loadEvidence: async () => ({}),
        verifyEvidenceFiles: async () => ({
          assessment: {
            status: 'ACCEPTED_FOR_REVIEW',
            supportsCancellation: false,
          },
          files: {
            absolutePath: paths.inputPath,
          },
          status: 'FILES_VERIFIED',
        }),
        writeOutput: (value) => output.push(value),
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join(''))).toMatchObject({
      error: {
        code: 'STABLE_AUDIO_3_EVIDENCE_VERIFIER_RESPONSE_INVALID',
      },
      status: 'VERIFICATION_FAILED',
    });
    expect(output.join('')).not.toContain(paths.directory);
  });

  it('loads one bounded regular UTF-8 JSON file', async () => {
    const paths = await createPaths();
    const evidence = {
      acceptanceVersion: '1',
      nested: { status: 'UNVERIFIED' },
    };
    await writeFile(paths.evidencePath, JSON.stringify(evidence));

    await expect(
      loadStableAudio3GenerationEvidenceFile(paths.evidencePath),
    ).resolves.toEqual(evidence);
  });

  it('rejects linked, oversized, malformed, and invalid UTF-8 JSON', async () => {
    const paths = await createPaths();
    const targetDirectory = join(paths.directory, 'target-directory');
    const linkedPath = join(paths.directory, 'linked-directory');
    await mkdir(targetDirectory);
    await symlink(targetDirectory, linkedPath, 'junction');

    await expect(
      loadStableAudio3GenerationEvidenceFile(linkedPath),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_JSON_INVALID',
    });

    await writeFile(paths.evidencePath, Buffer.alloc(1024 * 1024 + 1, 32));
    await expect(
      loadStableAudio3GenerationEvidenceFile(paths.evidencePath),
    ).rejects.toBeInstanceOf(StableAudio3GenerationEvidenceCliError);

    await writeFile(paths.evidencePath, '{not-json}');
    await expect(
      loadStableAudio3GenerationEvidenceFile(paths.evidencePath),
    ).rejects.toThrow('malformed');

    await writeFile(paths.evidencePath, Buffer.from([0xc3, 0x28]));
    await expect(
      loadStableAudio3GenerationEvidenceFile(paths.evidencePath),
    ).rejects.toThrow('valid UTF-8');
  });
});

async function createPaths() {
  const directory = await mkdtemp(
    join(tmpdir(), 'humstudio-stable-audio-3-evidence-cli-'),
  );
  temporaryDirectories.add(directory);
  return {
    directory,
    evidencePath: join(directory, 'evidence.json'),
    inputPath: join(directory, 'input.wav'),
    modelRootPath: join(directory, 'model'),
    outputPath: join(directory, 'output.wav'),
  };
}
