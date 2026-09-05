import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import {
  SoundFontCatalog,
  SoundFontCatalogError,
} from './soundFontCatalog.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('SoundFontCatalog', () => {
  it('requires Project Root before scanning SoundFonts', async () => {
    const catalog = new SoundFontCatalog({
      projectRootAuthority: new ProjectRootAuthority(),
    });

    await expect(catalog.list()).rejects.toMatchObject({
      code: 'PROJECT_ROOT_REQUIRED',
    });
  });

  it('lists only regular sf2 and sf3 files with Project-relative metadata', async () => {
    const rootPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    const projectRoot = await authority.configure(rootPath);
    const soundFontDirectory = join(projectRoot.rootPath, 'soundfonts');
    const nestedDirectory = join(soundFontDirectory, 'Orchestra');
    await mkdir(nestedDirectory);
    await writeFile(join(soundFontDirectory, 'Electric Piano.sf2'), 'sf2 data');
    await writeFile(join(nestedDirectory, 'Strings.SF3'), 'sf3 data');
    await writeFile(join(soundFontDirectory, 'README.txt'), 'ignored');
    const catalog = new SoundFontCatalog({ projectRootAuthority: authority });

    const snapshot = await catalog.list();

    expect(snapshot).toMatchObject({
      directory: 'soundfonts',
      issues: [],
      resources: [
        {
          format: 'sf2',
          name: 'Electric Piano.sf2',
          relativePath: 'soundfonts/Electric Piano.sf2',
          status: 'AVAILABLE',
        },
        {
          format: 'sf3',
          name: 'Strings.SF3',
          relativePath: 'soundfonts/Orchestra/Strings.SF3',
          status: 'AVAILABLE',
        },
      ],
      supportedFormats: ['sf2', 'sf3'],
    });
    expect(Number.isNaN(Date.parse(snapshot.scannedAt))).toBe(false);
    expect(snapshot.resources[0].resourceId).toMatch(/^soundfont-[a-f0-9]{32}$/);
    expect(snapshot.resources[0].revisionToken).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain(projectRoot.rootPath);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resources)).toBe(true);
  });

  it('changes the revision token without changing resource identity when a file changes', async () => {
    const rootPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    const projectRoot = await authority.configure(rootPath);
    const filePath = join(projectRoot.rootPath, 'soundfonts', 'Instrument.sf2');
    await writeFile(filePath, 'first');
    const catalog = new SoundFontCatalog({ projectRootAuthority: authority });
    const first = await catalog.list();

    await writeFile(filePath, 'a different size');
    const changedStat = await stat(filePath);
    expect(changedStat.size).not.toBe(first.resources[0].sizeBytes);
    const second = await catalog.list();

    expect(second.resources[0].resourceId).toBe(first.resources[0].resourceId);
    expect(second.resources[0].revisionToken).not.toBe(first.resources[0].revisionToken);
  });

  it('lists and resolves the pinned built-in SoundFont without exposing a Project duplicate', async () => {
    const rootPath = await createTemporaryDirectory();
    const runtimeRootPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    const projectRoot = await authority.configure(rootPath);
    const relativePath = 'soundfonts/HumStudio Default/MuseScore_General.sf3';
    const absolutePath = join(runtimeRootPath, 'MuseScore_General.sf3');
    const bytes = Buffer.from('builtin-soundfont');
    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(absolutePath, bytes);
    await mkdir(join(projectRoot.rootPath, 'soundfonts', 'HumStudio Default'), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot.rootPath, ...relativePath.split('/')),
      'legacy-project-copy',
    );
    const catalog = new SoundFontCatalog({
      builtinSoundFonts: [
        {
          absolutePath,
          expectedSha256,
          format: 'sf3',
          library: 'builtin',
          name: 'MuseScore_General.sf3',
          relativePath,
          runtimeRootPath,
          sizeBytes: bytes.length,
        },
      ],
      projectRootAuthority: authority,
    });

    const snapshot = await catalog.list();

    expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.resources[0]).toMatchObject({
      library: 'builtin',
      name: 'MuseScore_General.sf3',
      relativePath,
      revisionToken: expectedSha256,
    });
    const resolved = await catalog.resolve(snapshot.resources[0]);
    expect(resolved.library).toBe('builtin');
    expect(resolved.absolutePath.toLowerCase()).toBe(
      (await realpath(absolutePath)).toLowerCase(),
    );
  });

  it('rejects a built-in SoundFont whose pinned bytes changed after listing', async () => {
    const rootPath = await createTemporaryDirectory();
    const runtimeRootPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    await authority.configure(rootPath);
    const absolutePath = join(runtimeRootPath, 'Default.sf3');
    const bytes = Buffer.from('first');
    await writeFile(absolutePath, bytes);
    const catalog = new SoundFontCatalog({
      builtinSoundFonts: [
        {
          absolutePath,
          expectedSha256: createHash('sha256').update(bytes).digest('hex'),
          format: 'sf3',
          library: 'builtin',
          name: 'Default.sf3',
          relativePath: 'soundfonts/HumStudio Default/Default.sf3',
          runtimeRootPath,
          sizeBytes: bytes.length,
        },
      ],
      projectRootAuthority: authority,
    });
    const snapshot = await catalog.list();
    await writeFile(absolutePath, 'other');

    await expect(catalog.resolve(snapshot.resources[0])).rejects.toMatchObject({
      code: 'SOUNDFONT_REVISION_CHANGED',
    });
  });

  it('validates its required authority dependency', () => {
    expect(() => new SoundFontCatalog({})).toThrow(TypeError);
    expect(
      () =>
        new SoundFontCatalog({
          projectRootAuthority: { getSnapshot: 'not-a-function' },
        }),
    ).toThrow('ProjectRootAuthority');
    expect(new SoundFontCatalog({
      projectRootAuthority: new ProjectRootAuthority(),
    })).toBeInstanceOf(SoundFontCatalog);
    expect(SoundFontCatalogError.prototype).toBeInstanceOf(Error);
  });
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-soundfont-catalog-'));
  temporaryDirectories.add(directory);
  return directory;
}
