import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  StableAudio3GenerationEvidenceFileError,
  verifyStableAudio3GenerationEvidenceFiles,
} from './stableAudio3GenerationEvidenceFiles.mjs';
import {
  STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_MODEL_REPOSITORY,
  STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
  STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
} from './stableAudio3RuntimeProfile.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('Stable Audio 3 generation evidence files', () => {
  it('verifies actual input, output, and model files without returning absolute paths', async () => {
    const fixture = await createFixture();
    const result = await verifyStableAudio3GenerationEvidenceFiles(
      fixture.evidence,
      fixture.locations,
    );

    expect(result).toMatchObject({
      assessment: { status: 'ACCEPTED_FOR_REVIEW' },
      files: {
        input: {
          sha256: fixture.evidence.generation.inputSha256,
          wave: {
            channels: 1,
            container: 'RIFF/WAVE',
            sampleRate: 44_100,
          },
        },
        model: fixture.evidence.model.files,
        output: {
          sha256: fixture.evidence.generation.output.sha256,
          wave: {
            channels: 2,
            container: 'RIFF/WAVE',
            durationSeconds: fixture.evidence.generation.output.durationSeconds,
            sampleRate: 44_100,
          },
        },
      },
      status: 'FILES_VERIFIED',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.files.model)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(fixture.directory);
  });

  it('rejects unaccepted evidence before inspecting the supplied paths', async () => {
    const fixture = await createFixture();

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          model: { ...fixture.evidence.model, revision: 'main' },
        },
        {
          inputPath: join(fixture.directory, 'missing-input.wav'),
          modelRootPath: join(fixture.directory, 'missing-model'),
          outputPath: join(fixture.directory, 'missing-output.wav'),
        },
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_REJECTED',
    });
  });

  it('rejects mismatched input, output, and model hashes', async () => {
    const fixture = await createFixture();

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          generation: {
            ...fixture.evidence.generation,
            inputSha256: '1'.repeat(64),
          },
        },
        fixture.locations,
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
    });

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          generation: {
            ...fixture.evidence.generation,
            output: {
              ...fixture.evidence.generation.output,
              sha256: '2'.repeat(64),
            },
          },
        },
        fixture.locations,
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
    });

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          model: {
            ...fixture.evidence.model,
            files: fixture.evidence.model.files.map((file) => ({
              ...file,
              sha256: '3'.repeat(64),
            })),
          },
        },
        fixture.locations,
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
    });
  });

  it('compares measured output WAVE properties with the evidence envelope', async () => {
    const fixture = await createFixture();

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          generation: {
            ...fixture.evidence.generation,
            output: {
              ...fixture.evidence.generation.output,
              durationSeconds:
                fixture.evidence.generation.output.durationSeconds / 2,
            },
          },
        },
        fixture.locations,
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_MISMATCH',
    });
  });

  it('accepts a measured IEEE-float output WAVE', async () => {
    const fixture = await createFixture();
    const floatOutput = createWave({
      bitsPerSample: 32,
      channels: 2,
      durationSeconds: 0.25,
      formatTag: 3,
      sampleRate: 44_100,
    });
    await writeFile(fixture.locations.outputPath, floatOutput);
    const evidence = {
      ...fixture.evidence,
      generation: {
        ...fixture.evidence.generation,
        output: {
          ...fixture.evidence.generation.output,
          sha256: sha256(floatOutput),
          sizeBytes: floatOutput.length,
        },
      },
    };

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(evidence, fixture.locations),
    ).resolves.toMatchObject({
      files: { output: { wave: { channels: 2, sampleRate: 44_100 } } },
      status: 'FILES_VERIFIED',
    });
  });

  it('rejects malformed audio even when its hash matches the evidence', async () => {
    const fixture = await createFixture();
    const invalidBytes = Buffer.from('not-a-wave');
    await writeFile(fixture.locations.inputPath, invalidBytes);

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          generation: {
            ...fixture.evidence.generation,
            inputSha256: sha256(invalidBytes),
          },
        },
        fixture.locations,
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_WAV_INVALID',
    });
  });

  it('rejects a model path whose canonical target escapes its root', async () => {
    const fixture = await createFixture();
    const outsideDirectory = await createTemporaryDirectory();
    const outsideFile = join(outsideDirectory, 'model.safetensors');
    const linkedDirectory = join(fixture.locations.modelRootPath, 'linked');
    const modelBytes = Buffer.from('outside-model-weights');
    await writeFile(outsideFile, modelBytes);
    await symlink(outsideDirectory, linkedDirectory, 'junction');

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(
        {
          ...fixture.evidence,
          model: {
            ...fixture.evidence.model,
            files: [
              {
                path: 'linked/model.safetensors',
                sha256: sha256(modelBytes),
                sizeBytes: modelBytes.length,
              },
            ],
          },
        },
        fixture.locations,
      ),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_OUTSIDE_MODEL_ROOT',
    });
  });

  it('rejects linked roots, relative requests, and identical input/output files', async () => {
    const fixture = await createFixture();
    const linkedRoot = join(fixture.directory, 'linked-model-root');
    await symlink(fixture.locations.modelRootPath, linkedRoot, 'junction');

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(fixture.evidence, {
        ...fixture.locations,
        modelRootPath: linkedRoot,
      }),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
    });

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(fixture.evidence, {
        ...fixture.locations,
        inputPath: 'relative.wav',
      }),
    ).rejects.toBeInstanceOf(StableAudio3GenerationEvidenceFileError);

    const inputBytes = createWave({
      channels: 2,
      durationSeconds: 0.25,
      sampleRate: 44_100,
    });
    await writeFile(fixture.locations.inputPath, inputBytes);
    const sameFileEvidence = {
      ...fixture.evidence,
      generation: {
        ...fixture.evidence.generation,
        inputSha256: sha256(inputBytes),
        output: {
          ...fixture.evidence.generation.output,
          sha256: sha256(inputBytes),
          sizeBytes: inputBytes.length,
        },
      },
    };

    await expect(
      verifyStableAudio3GenerationEvidenceFiles(sameFileEvidence, {
        ...fixture.locations,
        outputPath: fixture.locations.inputPath,
      }),
    ).rejects.toMatchObject({
      code: 'STABLE_AUDIO_3_EVIDENCE_FILE_INVALID',
    });
  });
});

async function createFixture() {
  const directory = await createTemporaryDirectory();
  const modelRootPath = join(directory, 'model');
  const modelDirectory = join(modelRootPath, 'weights');
  const modelPath = join(modelDirectory, 'model.safetensors');
  const inputPath = join(directory, 'input.wav');
  const outputPath = join(directory, 'output.wav');
  await mkdir(modelDirectory, { recursive: true });

  const inputBytes = createWave({
    channels: 1,
    durationSeconds: 0.125,
    sampleRate: 44_100,
  });
  const outputBytes = createWave({
    channels: 2,
    durationSeconds: 0.25,
    sampleRate: 44_100,
  });
  const modelBytes = Buffer.from('stable-audio-3-model-weights');
  await Promise.all([
    writeFile(inputPath, inputBytes),
    writeFile(modelPath, modelBytes),
    writeFile(outputPath, outputBytes),
  ]);

  const outputDurationSeconds =
    (outputBytes.length - 44) / (44_100 * 2 * 2);
  const evidence = createEvidence({
    generation: {
      elapsedMilliseconds: 42_000,
      inputSha256: sha256(inputBytes),
      output: {
        channels: 2,
        container: 'RIFF/WAVE',
        durationSeconds: outputDurationSeconds,
        sampleRate: 44_100,
        sha256: sha256(outputBytes),
        sizeBytes: outputBytes.length,
      },
      peakGpuMemoryMiB: 10_240,
      status: 'COMPLETED',
    },
    model: {
      files: [
        {
          path: 'weights/model.safetensors',
          sha256: sha256(modelBytes),
          sizeBytes: modelBytes.length,
        },
      ],
      repository: STABLE_AUDIO_3_MODEL_REPOSITORY,
      revision: STABLE_AUDIO_3_MODEL_REVISION,
    },
  });

  return {
    directory,
    evidence,
    locations: { inputPath, modelRootPath, outputPath },
  };
}

function createEvidence(overrides = {}) {
  return {
    acceptanceVersion: '1',
    cancellation: { outcome: 'UNSUPPORTED' },
    generation: overrides.generation,
    model: overrides.model,
    provider: {
      codeRevision: STABLE_AUDIO_3_PROVIDER_CODE_REVISION,
      packageVersion: STABLE_AUDIO_3_PROVIDER_PACKAGE_VERSION,
    },
    runtime: createReadyRuntimeReport(),
    sourceProfileId: STABLE_AUDIO_3_GENERATION_EVIDENCE_PROFILE_ID,
  };
}

function createReadyRuntimeReport() {
  return {
    architecture: 'AMD64',
    cuda: {
      available: true,
      buildVersion: '12.6',
      deviceName: 'NVIDIA GeForce RTX 4060 Ti',
      probeErrorType: null,
      totalMemoryMiB: 16_380,
    },
    packages: {
      flashAttention: createPackage('2.8.3'),
      stableAudio3: createPackage('0.1.0'),
      torch: createPackage('2.7.1+cu126'),
      torchaudio: createPackage('2.7.1+cu126'),
    },
    platform: 'win32',
    probeVersion: '1',
    python: { implementation: 'CPython', version: '3.10.6' },
  };
}

function createPackage(version) {
  return {
    available: true,
    importable: true,
    importErrorType: null,
    version,
  };
}

function createWave({
  bitsPerSample = 16,
  channels,
  durationSeconds,
  formatTag = 1,
  sampleRate,
}) {
  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = frameCount * blockAlign;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(formatTag, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(
    join(tmpdir(), 'humstudio-stable-audio-3-evidence-files-'),
  );
  temporaryDirectories.add(directory);
  return directory;
}
