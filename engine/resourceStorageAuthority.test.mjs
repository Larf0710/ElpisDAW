import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ResourceStorageAuthority,
  resolveDefaultResourceStoragePaths,
} from './resourceStorageAuthority.mjs';
import { ACE_STEP_SUPPORT_MODEL_REVISION } from './providers/aceStepRuntimeProfile.mjs';
import { STABLE_AUDIO_3_MODEL_REVISION } from '../shared/stableAudio3Protocol.js';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('ResourceStorageAuthority', () => {
  it('provisions fixed lightweight resources under the portable data root', async () => {
    const dataRoot = await createTemporaryDirectory();
    const paths = resolveDefaultResourceStoragePaths({ dataRoot, platform: 'win32' });
    const authority = new ResourceStorageAuthority({ paths });

    const snapshot = await authority.restore();

    expect(snapshot).toEqual({
      aiModelLibrary: { status: 'UNSET' },
      fixedResources: {
        basicPitchRuntime: {
          path: join(dataRoot, 'Runtimes', 'BasicPitch'),
          policy: 'APP_MANAGED',
        },
        fluidSynthRuntime: {
          path: join(dataRoot, 'Runtimes', 'FluidSynth'),
          policy: 'APP_MANAGED',
        },
        soundFonts: {
          path: join(dataRoot, 'Resources', 'SoundFonts'),
          policy: 'APP_MANAGED',
        },
      },
      portableAiModelLibraryPath: join(dataRoot, 'Models'),
      policyVersion: 2,
    });
  });

  it('binds only the large AI Model Library and restores it atomically', async () => {
    const localAppData = await createTemporaryDirectory();
    const modelRoot = await createTemporaryDirectory();
    const paths = resolveDefaultResourceStoragePaths({ localAppData, platform: 'win32' });
    const authority = new ResourceStorageAuthority({ paths });

    const configured = await authority.configureAiModelLibrary(modelRoot);
    const canonicalRoot = await realpath(modelRoot);

    expect(configured.aiModelLibrary).toMatchObject({
      directories: {
        aceStep: join(canonicalRoot, 'ace-step', ACE_STEP_SUPPORT_MODEL_REVISION),
        loras: join(canonicalRoot, 'loras'),
        stableAudio3: join(canonicalRoot, 'stable-audio-3', STABLE_AUDIO_3_MODEL_REVISION),
      },
      mode: 'EXTERNAL',
      rootPath: canonicalRoot,
      status: 'READY',
    });
    expect(JSON.parse(await readFile(paths.stateFilePath, 'utf8'))).toMatchObject({
      aiModelLibrary: { mode: 'EXTERNAL', rootPath: canonicalRoot },
      app: 'ElpisDAW',
      version: 2,
    });

    const restored = await new ResourceStorageAuthority({ paths }).restore();
    expect(restored).toEqual(configured);
  });

  it('stores portable mode without an absolute path and restores after the data root moves', async () => {
    const firstDataRoot = await createTemporaryDirectory();
    const firstPaths = resolveDefaultResourceStoragePaths({
      dataRoot: firstDataRoot,
      platform: 'win32',
    });
    const configured = await new ResourceStorageAuthority({
      paths: firstPaths,
    }).configurePortableAiModelLibrary();
    const storedState = await readFile(firstPaths.stateFilePath, 'utf8');
    const canonicalFirstDataRoot = await realpath(firstDataRoot);

    expect(configured.aiModelLibrary).toMatchObject({
      mode: 'PORTABLE',
      rootPath: join(canonicalFirstDataRoot, 'Models'),
      status: 'READY',
    });
    expect(storedState).not.toContain(firstDataRoot);
    expect(JSON.parse(storedState)).toEqual({
      aiModelLibrary: {
        configuredAt: configured.aiModelLibrary.configuredAt,
        mode: 'PORTABLE',
      },
      app: 'ElpisDAW',
      version: 2,
    });

    const movedDataRoot = await createTemporaryDirectory();
    const movedPaths = resolveDefaultResourceStoragePaths({
      dataRoot: movedDataRoot,
      platform: 'win32',
    });
    await mkdir(dirname(movedPaths.stateFilePath), { recursive: true });
    await writeFile(movedPaths.stateFilePath, storedState, 'utf8');

    const restored = await new ResourceStorageAuthority({ paths: movedPaths }).restore();
    const canonicalMovedDataRoot = await realpath(movedDataRoot);
    expect(restored.aiModelLibrary).toMatchObject({
      directories: {
        aceStep: join(
          canonicalMovedDataRoot,
          'Models',
          'ace-step',
          ACE_STEP_SUPPORT_MODEL_REVISION,
        ),
        loras: join(canonicalMovedDataRoot, 'Models', 'loras'),
        stableAudio3: join(
          canonicalMovedDataRoot,
          'Models',
          'stable-audio-3',
          STABLE_AUDIO_3_MODEL_REVISION,
        ),
      },
      mode: 'PORTABLE',
      rootPath: join(canonicalMovedDataRoot, 'Models'),
      status: 'READY',
    });
  });

  it('restores the previous version 1 external library state', async () => {
    const localAppData = await createTemporaryDirectory();
    const modelRoot = await createTemporaryDirectory();
    const paths = resolveDefaultResourceStoragePaths({ localAppData, platform: 'win32' });
    const configuredAt = '2026-09-11T00:00:00.000Z';
    await mkdir(dirname(paths.stateFilePath), { recursive: true });
    await writeFile(
      paths.stateFilePath,
      `${JSON.stringify({
        aiModelLibrary: { configuredAt, rootPath: modelRoot },
        app: 'ElpisDAW',
        version: 1,
      })}\n`,
      'utf8',
    );

    const restored = await new ResourceStorageAuthority({ paths }).restore();
    expect(restored.aiModelLibrary).toMatchObject({
      configuredAt,
      mode: 'EXTERNAL',
      rootPath: await realpath(modelRoot),
      status: 'READY',
    });
  });

  it('rejects a model root that overlaps fixed resources or the application', async () => {
    const localAppData = await createTemporaryDirectory();
    const applicationRootPath = await createTemporaryDirectory();
    const paths = resolveDefaultResourceStoragePaths({ localAppData, platform: 'win32' });
    const authority = new ResourceStorageAuthority({ applicationRootPath, paths });

    await expect(
      authority.configureAiModelLibrary(paths.appDataRoot),
    ).rejects.toThrow('managed resource root');
    await expect(
      authority.configureAiModelLibrary(applicationRootPath),
    ).rejects.toThrow('application root');
  });

  it('keeps fixed paths available when stored AI state is corrupt', async () => {
    const localAppData = await createTemporaryDirectory();
    const paths = resolveDefaultResourceStoragePaths({ localAppData, platform: 'win32' });
    const authority = new ResourceStorageAuthority({ paths });
    await authority.restore();
    await mkdir(dirname(paths.stateFilePath), { recursive: true });
    await writeFile(paths.stateFilePath, '{broken', 'utf8');

    const snapshot = await new ResourceStorageAuthority({ paths }).restore();

    expect(snapshot.aiModelLibrary).toMatchObject({
      status: 'UNSET',
    });
    expect(snapshot.aiModelLibrary.recoveryIssue).toContain('not valid JSON');
    expect(snapshot.fixedResources.soundFonts.path).toBe(paths.soundFontsPath);
  });

  it('rejects a relative LOCALAPPDATA override instead of resolving inside the checkout', () => {
    expect(() =>
      resolveDefaultResourceStoragePaths({
        localAppData: 'relative-local-app-data',
        platform: 'win32',
      }),
    ).toThrow('LOCALAPPDATA must be an absolute path');
  });

  it('rejects a relative portable data root', () => {
    expect(() =>
      resolveDefaultResourceStoragePaths({
        dataRoot: 'relative-portable-data',
        platform: 'win32',
      }),
    ).toThrow('ELPISDAW_DATA_ROOT must be an absolute path');
  });

  it('rejects model roots that use symbolic link or junction components', async () => {
    const localAppData = await createTemporaryDirectory();
    const modelTargetRoot = await createTemporaryDirectory();
    const aliasParent = await createTemporaryDirectory();
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const directAlias = join(aliasParent, 'model-root-link');
    await symlink(modelTargetRoot, directAlias, linkType);
    const authority = new ResourceStorageAuthority({
      paths: resolveDefaultResourceStoragePaths({ localAppData, platform: 'win32' }),
    });

    await expect(
      authority.configureAiModelLibrary(directAlias),
    ).rejects.toThrow('cannot be a symbolic link or junction');

    const nestedModelRoot = join(modelTargetRoot, 'nested-model-root');
    await mkdir(nestedModelRoot);
    const parentAlias = join(aliasParent, 'model-parent-link');
    await symlink(modelTargetRoot, parentAlias, linkType);

    await expect(
      authority.configureAiModelLibrary(join(parentAlias, 'nested-model-root')),
    ).rejects.toThrow('cannot resolve through a symbolic link or junction');
  });

  it('canonicalizes protected junctions before checking model-library separation', async () => {
    const applicationRootPath = await createTemporaryDirectory();
    const applicationAliasParent = await createTemporaryDirectory();
    const applicationRootAlias = join(applicationAliasParent, 'application-root-link');
    await symlink(
      applicationRootPath,
      applicationRootAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const applicationAuthority = new ResourceStorageAuthority({
      applicationRootPath: applicationRootAlias,
      paths: resolveDefaultResourceStoragePaths({
        localAppData: await createTemporaryDirectory(),
        platform: 'win32',
      }),
    });

    await expect(
      applicationAuthority.configureAiModelLibrary(applicationRootPath),
    ).rejects.toThrow('separate from the ElpisDAW application root');

    const managedTargetRoot = await createTemporaryDirectory();
    const managedAliasParent = await createTemporaryDirectory();
    const localAppDataAlias = join(managedAliasParent, 'local-app-data-link');
    await symlink(
      managedTargetRoot,
      localAppDataAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const managedAuthority = new ResourceStorageAuthority({
      paths: resolveDefaultResourceStoragePaths({
        localAppData: localAppDataAlias,
        platform: 'win32',
      }),
    });

    await expect(
      managedAuthority.configureAiModelLibrary(managedTargetRoot),
    ).rejects.toThrow('separate from the ElpisDAW managed resource root');
  });
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'elpisdaw-resource-storage-'));
  temporaryDirectories.add(directory);
  return directory;
}
