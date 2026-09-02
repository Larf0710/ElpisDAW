import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDefaultSoundFontAssets } from './defaultSoundFontProvisioner.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('default SoundFont provisioner', () => {
  it('copies pinned assets once and accepts the verified destination afterward', async () => {
    const sourceRoot = await createTemporaryDirectory();
    const destinationRoot = await createTemporaryDirectory();
    const fixture = createFixtureManifest([
      ['Default.sf3', 'soundfont-bytes'],
      ['License.md', 'license-text'],
    ]);

    await writeFixtureAssets(sourceRoot, fixture);

    await expect(
      installDefaultSoundFontAssets({
        destinationRoot,
        manifest: fixture.manifest,
        sourceRoot,
      }),
    ).resolves.toMatchObject({ installedCount: 2, status: 'INSTALLED' });
    await expect(readFile(join(destinationRoot, 'Default.sf3'), 'utf8')).resolves.toBe(
      'soundfont-bytes',
    );
    await expect(
      installDefaultSoundFontAssets({
        destinationRoot,
        manifest: fixture.manifest,
        sourceRoot,
      }),
    ).resolves.toMatchObject({ installedCount: 0, status: 'READY' });
  });

  it('refuses to overwrite a destination that differs from the pinned asset', async () => {
    const sourceRoot = await createTemporaryDirectory();
    const destinationRoot = await createTemporaryDirectory();
    const fixture = createFixtureManifest([['Default.sf3', 'expected']]);

    await writeFixtureAssets(sourceRoot, fixture);
    await writeFile(join(destinationRoot, 'Default.sf3'), 'different', 'utf8');

    await expect(
      installDefaultSoundFontAssets({
        destinationRoot,
        manifest: fixture.manifest,
        sourceRoot,
      }),
    ).rejects.toThrow('differs from the pinned asset');
  });

  it('can leave a Project Root usable when the runtime asset is unavailable', async () => {
    const sourceRoot = await createTemporaryDirectory();
    const destinationRoot = await createTemporaryDirectory();
    const fixture = createFixtureManifest([['Default.sf3', 'expected']]);

    await expect(
      installDefaultSoundFontAssets({
        allowUnavailableSource: true,
        destinationRoot,
        manifest: fixture.manifest,
        sourceRoot,
      }),
    ).resolves.toMatchObject({
      missingFileName: 'Default.sf3',
      status: 'UNAVAILABLE',
    });
  });

  it('aborts and rejects a stalled download within the configured timeout', async () => {
    const destinationRoot = await createTemporaryDirectory();
    const fixture = createFixtureManifest([['Default.sf3', 'expected']]);
    let requestSignal;
    const fetchImpl = vi.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => undefined);
    });

    await expect(
      installDefaultSoundFontAssets({
        destinationRoot,
        downloadTimeoutMs: 10,
        fetchImpl,
        manifest: fixture.manifest,
      }),
    ).rejects.toThrow(
      'Default SoundFont download timed out for Default.sf3 after 10 ms.',
    );
    expect(requestSignal?.aborted).toBe(true);
    await expect(readFile(join(destinationRoot, 'Default.sf3'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

function createFixtureManifest(entries) {
  const fixtures = entries.map(([fileName, contents], index) => ({
    contents,
    fileName,
    kind: index === 0 ? 'soundfont' : 'license',
    sha256: createHash('sha256').update(contents).digest('hex'),
    sizeBytes: Buffer.byteLength(contents),
    url: `https://example.test/${fileName}`,
  }));

  return {
    fixtures,
    manifest: {
      assets: fixtures.map(({ contents: _contents, ...asset }) => asset),
      displayName: 'Fixture General',
      preferredSoundFontRelativePath:
        'soundfonts/HumStudio Default/Default.sf3',
      projectRelativeDirectory: 'soundfonts/HumStudio Default',
      runtimeRelativeDirectory: 'engine/bin/soundfonts/fixture/test',
      version: 'test',
    },
  };
}

async function writeFixtureAssets(sourceRoot, fixture) {
  await Promise.all(
    fixture.fixtures.map((asset) =>
      writeFile(join(sourceRoot, asset.fileName), asset.contents, 'utf8'),
    ),
  );
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-default-soundfont-'));
  temporaryDirectories.add(directory);
  return directory;
}
