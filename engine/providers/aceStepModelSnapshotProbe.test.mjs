import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AceStepModelSnapshotProbeError,
  hashFileHandleWithBoundedReads,
  probeAceStepModelSnapshot,
  resolveAceStepModelRootFromEnvironment,
  validateAceStepModelSnapshotManifest,
} from './aceStepModelSnapshotProbe.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('ACE-Step Model Snapshot Probe', () => {
  it('accepts an exact small fixture and ignores extras outside the verified set', async () => {
    const modelRoot = await createTemporaryDirectory();
    await mkdir(join(modelRoot, 'nested'));
    const configBytes = Buffer.from('{"model":"fixture"}\n');
    const weightsBytes = Buffer.from('fixture-weights');
    await writeFile(join(modelRoot, 'config.json'), configBytes);
    await writeFile(join(modelRoot, 'nested', 'weights.bin'), weightsBytes);
    await writeFile(join(modelRoot, '.cache-metadata.json'), 'ignored');
    const manifest = createFixtureManifest([
      manifestFile('nested/weights.bin', weightsBytes),
      manifestFile('config.json', configBytes),
    ]);

    const assessment = await probeAceStepModelSnapshot(modelRoot, { manifest });

    expect(assessment).toEqual({
      blockers: [],
      manifest: {
        manifestVersion: '1',
        modelRepository: 'Fixture/acestep-model',
        modelRevision: '1'.repeat(40),
        providerRevision: '2'.repeat(40),
      },
      snapshot: {
        extraFilesPolicy: 'IGNORED_OUTSIDE_VERIFIED_SET',
        requiredFileCount: 2,
        totalRequiredBytes: configBytes.length + weightsBytes.length,
        verifiedFileCount: 2,
      },
      status: 'READY_FOR_REAL_GENERATION_PROBE',
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.blockers)).toBe(true);
    expect(Object.isFrozen(assessment.snapshot)).toBe(true);
  });

  it('supports an injectable bounded fixture hasher without weakening size checks', async () => {
    const modelRoot = await createTemporaryDirectory();
    const bytes = Buffer.from('small-placeholder');
    await writeFile(join(modelRoot, 'model.safetensors'), bytes);
    const expectedSha256 = 'a'.repeat(64);
    const calls = [];
    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      hashFile: async (fileHandle, sizeBytes) => {
        calls.push({ fileHandlePresent: fileHandle !== undefined, sizeBytes });
        return expectedSha256;
      },
      manifest: createFixtureManifest([
        {
          path: 'model.safetensors',
          sha256: expectedSha256,
          sizeBytes: bytes.length,
        },
      ]),
    });

    expect(assessment.status).toBe('READY_FOR_REAL_GENERATION_PROBE');
    expect(calls).toEqual([
      { fileHandlePresent: true, sizeBytes: bytes.length },
    ]);
  });

  it('reports missing, size-mismatched, and hash-mismatched files in path order', async () => {
    const modelRoot = await createTemporaryDirectory();
    const expectedB = Buffer.from('expected-b');
    const actualC = Buffer.from('actual-c');
    const expectedC = Buffer.from('expect-c');
    await writeFile(join(modelRoot, 'b.bin'), 'wrong');
    await writeFile(join(modelRoot, 'c.bin'), actualC);
    const manifest = createFixtureManifest([
      manifestFile('c.bin', expectedC),
      manifestFile('a.bin', Buffer.from('missing')),
      manifestFile('b.bin', expectedB),
    ]);

    const assessment = await probeAceStepModelSnapshot(modelRoot, { manifest });

    expect(assessment.status).toBe('UNVERIFIED');
    expect(assessment.blockers.map(({ code }) => code)).toEqual([
      'ACE_STEP_MODEL_FILE_MISSING',
      'ACE_STEP_MODEL_FILE_SIZE_MISMATCH',
      'ACE_STEP_MODEL_FILE_SHA256_MISMATCH',
    ]);
    expect(assessment.blockers.map(({ message }) => message)).toEqual([
      expect.stringContaining('a.bin'),
      expect.stringContaining('b.bin'),
      expect.stringContaining('c.bin'),
    ]);
    expect(assessment.snapshot.verifiedFileCount).toBe(0);
  });

  it('rejects wrong-case path aliases before file content can substitute', async () => {
    const modelRoot = await createTemporaryDirectory();
    const bytes = Buffer.from('config');
    await writeFile(join(modelRoot, 'Config.json'), bytes);

    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      manifest: createFixtureManifest([manifestFile('config.json', bytes)]),
    });

    expect(assessment.blockers).toEqual([
      expect.objectContaining({ code: 'ACE_STEP_MODEL_FILE_PATH_ALIAS' }),
    ]);
  });

  it('rejects linked or reparse-point path segments', async () => {
    const modelRoot = await createTemporaryDirectory();
    const outsideRoot = await createTemporaryDirectory();
    const bytes = Buffer.from('external-model');
    await writeFile(join(outsideRoot, 'model.bin'), bytes);
    await symlink(
      outsideRoot,
      join(modelRoot, 'nested'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      manifest: createFixtureManifest([
        manifestFile('nested/model.bin', bytes),
      ]),
    });

    expect(assessment.blockers).toEqual([
      expect.objectContaining({ code: 'ACE_STEP_MODEL_FILE_REPARSE_POINT' }),
    ]);
  });

  it('rejects a canonical file escape even when metadata imitates a regular file', async () => {
    const modelRoot = await createTemporaryDirectory();
    const outsideRoot = await createTemporaryDirectory();
    const bytes = Buffer.from('model');
    const modelPath = join(modelRoot, 'model.bin');
    const outsidePath = join(outsideRoot, 'model.bin');
    await writeFile(modelPath, bytes);
    await writeFile(outsidePath, bytes);
    const canonicalRoot = await realpath(modelRoot);
    const canonicalModelPath = join(canonicalRoot, 'model.bin');
    const canonicalOutsidePath = await realpath(outsidePath);

    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      fileSystem: {
        lstat,
        open,
        readdir,
        realpath: async (path) =>
          path === canonicalModelPath
            ? canonicalOutsidePath
            : await realpath(path),
      },
      manifest: createFixtureManifest([manifestFile('model.bin', bytes)]),
    });

    expect(assessment.blockers).toEqual([
      expect.objectContaining({ code: 'ACE_STEP_MODEL_FILE_ROOT_ESCAPE' }),
    ]);
  });

  it('rejects non-regular required files', async () => {
    const modelRoot = await createTemporaryDirectory();
    await mkdir(join(modelRoot, 'model.bin'));

    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      manifest: createFixtureManifest([
        manifestFile('model.bin', Buffer.from('model')),
      ]),
    });

    expect(assessment.blockers).toEqual([
      expect.objectContaining({ code: 'ACE_STEP_MODEL_FILE_NOT_REGULAR' }),
    ]);
  });

  it('rejects malformed manifests, duplicates, and case collisions', () => {
    const file = manifestFile('model.bin', Buffer.from('model'));

    for (const manifest of [
      { ...createFixtureManifest([file]), unexpected: true },
      createFixtureManifest([file, file]),
      createFixtureManifest([
        file,
        { ...file, path: 'MODEL.bin' },
      ]),
      createFixtureManifest([{ ...file, path: '../model.bin' }]),
      {
        ...createFixtureManifest([file]),
        modelSourceUrl:
          'https://huggingface.co/Fixture/acestep-model/tree/main',
      },
    ]) {
      expect(() => validateAceStepModelSnapshotManifest(manifest)).toThrowError(
        expect.objectContaining({ code: 'ACE_STEP_MODEL_MANIFEST_INVALID' }),
      );
    }
  });

  it('distinguishes invalid requests from an unavailable absolute root', async () => {
    await expect(probeAceStepModelSnapshot('relative/model')).rejects.toMatchObject({
      code: 'ACE_STEP_MODEL_PROBE_REQUEST_INVALID',
    });

    const parent = await createTemporaryDirectory();
    const assessment = await probeAceStepModelSnapshot(join(parent, 'missing'), {
      manifest: createFixtureManifest([
        manifestFile('model.bin', Buffer.from('model')),
      ]),
    });

    expect(assessment.status).toBe('UNVERIFIED');
    expect(assessment.blockers).toEqual([
      {
        code: 'ACE_STEP_MODEL_ROOT_UNAVAILABLE',
        message: 'ACE-Step Model root is unavailable.',
      },
    ]);
  });

  it('keeps public blockers stable and excludes raw exception and root details', async () => {
    const modelRoot = await createTemporaryDirectory();
    const secretDetail = 'secret-token-and-private-root';
    const manifest = createFixtureManifest([
      manifestFile('b.bin', Buffer.from('b')),
      manifestFile('a.bin', Buffer.from('a')),
    ]);
    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      fileSystem: {
        lstat,
        open,
        readdir: async () => {
          throw new Error(secretDetail);
        },
        realpath,
      },
      manifest,
    });
    const publicJson = JSON.stringify(assessment);

    expect(assessment.blockers.map(({ message }) => message)).toEqual([
      expect.stringContaining('a.bin'),
      expect.stringContaining('b.bin'),
    ]);
    expect(publicJson).not.toContain(secretDetail);
    expect(publicJson).not.toContain(modelRoot);
  });

  it('reports an opened file identity change without leaking raw or root details', async () => {
    const modelRoot = await createTemporaryDirectory();
    const modelPath = join(modelRoot, 'model.bin');
    const bytes = Buffer.from('model');
    const secretDetail = 'raw-private-file-identity-detail';
    await writeFile(modelPath, bytes);
    let handleStatCalls = 0;

    const assessment = await probeAceStepModelSnapshot(modelRoot, {
      fileSystem: {
        lstat,
        open: async (path, flags) => {
          const fileHandle = await open(path, flags);
          const initialStat = await fileHandle.stat();
          const changedStat = Object.create(initialStat);
          Object.defineProperties(changedStat, {
            dev: {
              enumerable: true,
              value: initialStat.dev === 0 ? 1 : 0,
            },
            ino: {
              enumerable: true,
              value: initialStat.ino === 0 ? 1 : 0,
            },
            rawError: {
              enumerable: true,
              value: new Error(secretDetail),
            },
          });

          return {
            close: fileHandle.close.bind(fileHandle),
            read: fileHandle.read.bind(fileHandle),
            stat: async () => {
              handleStatCalls += 1;
              return handleStatCalls === 1 ? initialStat : changedStat;
            },
          };
        },
        readdir,
        realpath,
      },
      hashFile: async () => manifestFile('model.bin', bytes).sha256,
      manifest: createFixtureManifest([manifestFile('model.bin', bytes)]),
    });
    const publicJson = JSON.stringify(assessment);

    expect(handleStatCalls).toBe(2);
    expect(assessment.status).toBe('UNVERIFIED');
    expect(assessment.snapshot.verifiedFileCount).toBe(0);
    expect(assessment.blockers).toEqual([
      {
        code: 'ACE_STEP_MODEL_FILE_CHANGED',
        message:
          'ACE-Step Model file changed during verification. Required path: model.bin',
      },
    ]);
    expect(publicJson).not.toContain(secretDetail);
    expect(publicJson).not.toContain(modelRoot);
  });

  it('hashes through bounded reads instead of buffering a whole multi-GB file', async () => {
    const sizeBytes = 2 * 1024 * 1024 + 17;
    const reads = [];
    const digest = await hashFileHandleWithBoundedReads(
      {
        read: async (buffer, offset, length, position) => {
          reads.push({ length, position });
          buffer.fill(0, offset, offset + length);
          return { bytesRead: length };
        },
      },
      sizeBytes,
    );

    expect(reads).toEqual([
      { length: 1024 * 1024, position: 0 },
      { length: 1024 * 1024, position: 1024 * 1024 },
      { length: 17, position: 2 * 1024 * 1024 },
    ]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves the declared environment variable outside pure probing', () => {
    const modelRoot = join(tmpdir(), 'ace-step-model');

    expect(
      resolveAceStepModelRootFromEnvironment({
        HUMSTUDIO_ACE_STEP_MODEL_ROOT: modelRoot,
      }),
    ).toBe(modelRoot);
    expect(() => resolveAceStepModelRootFromEnvironment({})).toThrowError(
      expect.objectContaining({ code: 'ACE_STEP_MODEL_PROBE_REQUEST_INVALID' }),
    );
  });

  it('uses a typed error without exposing filesystem causes', async () => {
    await expect(probeAceStepModelSnapshot(undefined)).rejects.toBeInstanceOf(
      AceStepModelSnapshotProbeError,
    );
  });
});

function createFixtureManifest(files) {
  const modelRepository = 'Fixture/acestep-model';
  const modelRevision = '1'.repeat(40);
  const providerRepository = 'https://github.com/example/provider';
  const providerRevision = '2'.repeat(40);

  return {
    files,
    manifestVersion: '1',
    modelMetadataUrl:
      `https://huggingface.co/api/models/${modelRepository}/revision/` +
      `${modelRevision}?blobs=true`,
    modelRepository,
    modelRevision,
    modelSourceUrl:
      `https://huggingface.co/${modelRepository}/tree/${modelRevision}`,
    providerRepository,
    providerRevision,
    providerSourceUrl: `${providerRepository}/tree/${providerRevision}`,
  };
}

function manifestFile(path, bytes) {
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(
    join(tmpdir(), 'humstudio-ace-step-model-probe-'),
  );
  temporaryDirectories.add(directory);
  return directory;
}
