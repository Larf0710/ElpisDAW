import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_ROOT_DIRECTORIES,
  PROJECT_ROOT_MARKER_FILE_NAME,
  ProjectRootAuthority,
  resolveCanonicalDirectory,
  resolveDefaultProjectRootStateFilePath,
  resolveProjectPath,
} from './projectRootAuthority.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('ProjectRootAuthority', () => {
  it('keeps Project Root state under the portable data root when configured', async () => {
    const dataRoot = await createTemporaryDirectory();

    expect(
      resolveDefaultProjectRootStateFilePath({ dataRoot, platform: 'win32' }),
    ).toBe(join(dataRoot, 'UserData', 'project-root.json'));
  });

  it('canonicalizes an existing directory and creates the standard Project layout', async () => {
    const selectedPath = await createTemporaryDirectory();
    const authority = new ProjectRootAuthority();
    const snapshot = await authority.configure(selectedPath);

    expect(snapshot).toMatchObject({
      directories: PROJECT_ROOT_DIRECTORIES,
      rootPath: await resolveCanonicalDirectory(selectedPath),
      status: 'READY',
    });
    expect(snapshot.projectFileName).toBe(`${snapshot.rootName}.humstudio.json`);
    await expect(readProjectRootMarker(snapshot.rootPath)).resolves.toEqual({
      app: 'ElpisDAW',
      kind: 'project-root',
      version: 1,
    });

    for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
      await expect(stat(join(snapshot.rootPath, relativePath))).resolves.toMatchObject({});
    }
  });

  it('rejects a non-empty arbitrary directory without modifying it or the active Root', async () => {
    const currentRootPath = await createTemporaryDirectory();
    const rejectedPath = await createTemporaryDirectory();
    const stateDirectory = await createTemporaryDirectory();
    const stateFilePath = join(stateDirectory, 'engine-state', 'project-root.json');
    await writeFile(join(rejectedPath, 'existing-notes.txt'), 'keep me', 'utf8');
    const authority = new ProjectRootAuthority({ stateFilePath });
    const currentSnapshot = await authority.configure(currentRootPath);
    const storedStateBeforeRejection = await readFile(stateFilePath, 'utf8');

    await expect(authority.configure(rejectedPath)).rejects.toThrow(
      'This folder contains files but is not a recognized ElpisDAW Project Root. Choose a new empty folder or an existing ElpisDAW Project Root.',
    );

    expect(authority.getSnapshot()).toBe(currentSnapshot);
    await expect(readdir(rejectedPath)).resolves.toEqual(['existing-notes.txt']);
    await expect(readFile(join(rejectedPath, 'existing-notes.txt'), 'utf8')).resolves.toBe(
      'keep me',
    );
    await expect(readFile(stateFilePath, 'utf8')).resolves.toBe(storedStateBeforeRejection);
  });

  it('accepts an existing Root identified by a valid marker and repairs its layout', async () => {
    const selectedPath = await createTemporaryDirectory();
    await writeFile(
      join(selectedPath, PROJECT_ROOT_MARKER_FILE_NAME),
      JSON.stringify({ app: 'ElpisDAW', kind: 'project-root', version: 1 }),
      'utf8',
    );
    const authority = new ProjectRootAuthority();

    await expect(authority.configure(selectedPath)).resolves.toMatchObject({
      rootPath: await resolveCanonicalDirectory(selectedPath),
      status: 'READY',
    });

    for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
      await expect(stat(join(selectedPath, relativePath))).resolves.toMatchObject({});
    }
  });

  it('migrates a valid saved legacy Project Root by adding its marker', async () => {
    const selectedPath = await createTemporaryDirectory();
    const rootName = selectedPath.split(/[\\/]/).pop();
    await writeFile(
      join(selectedPath, `${rootName}.humstudio.json`),
      JSON.stringify({
        app: 'HumSTUDIO',
        savedAt: '2026-09-13T00:00:00.000Z',
        version: '0.1.0',
        workspace: { project: { name: 'Legacy Song' } },
      }),
      'utf8',
    );
    await writeFile(join(selectedPath, 'cover-notes.txt'), 'preserve me', 'utf8');
    const authority = new ProjectRootAuthority();

    await expect(authority.configure(selectedPath)).resolves.toMatchObject({
      projectFile: { status: 'EXISTS' },
      status: 'READY',
    });
    await expect(readProjectRootMarker(selectedPath)).resolves.toMatchObject({
      app: 'ElpisDAW',
      kind: 'project-root',
      version: 1,
    });
    await expect(readFile(join(selectedPath, 'cover-notes.txt'), 'utf8')).resolves.toBe(
      'preserve me',
    );
  });

  it('migrates an unsaved legacy Root only when its complete managed layout exists', async () => {
    const selectedPath = await createTemporaryDirectory();

    for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
      await mkdir(join(selectedPath, relativePath), { recursive: true });
    }

    const authority = new ProjectRootAuthority();
    await expect(authority.configure(selectedPath)).resolves.toMatchObject({
      projectFile: { status: 'MISSING' },
      status: 'READY',
    });
    await expect(readProjectRootMarker(selectedPath)).resolves.toMatchObject({
      app: 'ElpisDAW',
      kind: 'project-root',
      version: 1,
    });
  });

  it('rejects an invalid marker without repairing or provisioning the directory', async () => {
    const selectedPath = await createTemporaryDirectory();
    const provisionProjectRoot = vi.fn();
    await writeFile(
      join(selectedPath, PROJECT_ROOT_MARKER_FILE_NAME),
      JSON.stringify({ app: 'AnotherApp', kind: 'project-root', version: 1 }),
      'utf8',
    );
    const authority = new ProjectRootAuthority({ provisionProjectRoot });

    await expect(authority.configure(selectedPath)).rejects.toThrow(
      'Project Root marker is invalid or unsupported.',
    );
    await expect(readdir(selectedPath)).resolves.toEqual([PROJECT_ROOT_MARKER_FILE_NAME]);
    expect(provisionProjectRoot).not.toHaveBeenCalled();
  });

  it('rejects an invalid legacy Project JSON without creating managed directories', async () => {
    const selectedPath = await createTemporaryDirectory();
    const rootName = selectedPath.split(/[\\/]/).pop();
    const projectFileName = `${rootName}.humstudio.json`;
    await writeFile(join(selectedPath, projectFileName), '{broken', 'utf8');
    const authority = new ProjectRootAuthority();

    await expect(authority.configure(selectedPath)).rejects.toThrow(
      'Legacy Project JSON is invalid or unsupported.',
    );
    await expect(readdir(selectedPath)).resolves.toEqual([projectFileName]);
  });

  it('rejects a marked Root with a conflicting managed path before repairing it', async () => {
    const selectedPath = await createTemporaryDirectory();
    await writeFile(
      join(selectedPath, PROJECT_ROOT_MARKER_FILE_NAME),
      JSON.stringify({ app: 'ElpisDAW', kind: 'project-root', version: 1 }),
      'utf8',
    );
    await writeFile(join(selectedPath, 'recordings'), 'not a directory', 'utf8');
    const authority = new ProjectRootAuthority();

    await expect(authority.configure(selectedPath)).rejects.toThrow(
      'Existing Project Root layout is invalid or unsafe.',
    );
    await expect(readdir(selectedPath)).resolves.toEqual([
      PROJECT_ROOT_MARKER_FILE_NAME,
      'recordings',
    ]);
  });

  it('does not replace the current Root when a new selection is invalid', async () => {
    const selectedPath = await createTemporaryDirectory();
    const invalidPath = join(selectedPath, 'not-a-directory.txt');
    const authority = new ProjectRootAuthority();
    const currentSnapshot = await authority.configure(selectedPath);
    await writeFile(invalidPath, 'not a directory', 'utf8');

    await expect(authority.configure(invalidPath)).rejects.toThrow('existing directory');
    expect(authority.getSnapshot()).toBe(currentSnapshot);
  });

  it('runs an optional provisioner after creating the standard layout', async () => {
    const selectedPath = await createTemporaryDirectory();
    const provisionedPaths = [];
    const authority = new ProjectRootAuthority({
      provisionProjectRoot: async ({ rootPath }) => {
        const defaultDirectory = join(rootPath, 'soundfonts', 'HumStudio Default');
        await mkdir(defaultDirectory, { recursive: true });
        await writeFile(join(defaultDirectory, 'Default.sf3'), 'fixture', 'utf8');
        provisionedPaths.push(rootPath);
      },
    });

    const snapshot = await authority.configure(selectedPath);

    expect(provisionedPaths).toEqual([snapshot.rootPath]);
    await expect(
      readFile(
        join(snapshot.rootPath, 'soundfonts', 'HumStudio Default', 'Default.sf3'),
        'utf8',
      ),
    ).resolves.toBe('fixture');
  });

  it('rejects absolute and traversal paths from Project-relative resolution', async () => {
    const selectedPath = await createTemporaryDirectory();
    const canonicalRoot = await resolveCanonicalDirectory(selectedPath);

    expect(() => resolveProjectPath(canonicalRoot, '../outside.wav')).toThrow('escapes');
    expect(() => resolveProjectPath(canonicalRoot, canonicalRoot)).toThrow('relative');
    await expect(resolveCanonicalDirectory('.')).rejects.toThrow('absolute path');
  });

  it('restores the last validated Root from Engine-owned state after restart', async () => {
    const selectedPath = await createTemporaryDirectory();
    const stateDirectory = await createTemporaryDirectory();
    const stateFilePath = join(stateDirectory, 'engine-state', 'project-root.json');
    const firstAuthority = new ProjectRootAuthority({ stateFilePath });
    const configuredRoot = await firstAuthority.configure(selectedPath);
    const storedState = JSON.parse(await readFile(stateFilePath, 'utf8'));

    expect(storedState).toEqual({
      app: 'HumStudio Local Engine',
      projectRoot: {
        configuredAt: configuredRoot.configuredAt,
        rootPath: configuredRoot.rootPath,
      },
      version: 1,
    });
    expect(JSON.stringify(storedState)).not.toContain('token');
    await writeFile(join(configuredRoot.rootPath, configuredRoot.projectFileName), '{}', 'utf8');

    const restartedAuthority = new ProjectRootAuthority({ stateFilePath });
    await expect(restartedAuthority.restore()).resolves.toMatchObject({
      projectFile: { sizeBytes: 2, status: 'EXISTS' },
      rootPath: configuredRoot.rootPath,
      status: 'READY',
    });
  });

  it('reports corrupt stored state without preventing a new Root selection', async () => {
    const selectedPath = await createTemporaryDirectory();
    const stateDirectory = await createTemporaryDirectory();
    const stateFilePath = join(stateDirectory, 'project-root.json');
    await writeFile(stateFilePath, '{broken', 'utf8');
    const authority = new ProjectRootAuthority({ stateFilePath });

    await expect(authority.restore()).resolves.toMatchObject({
      recoveryIssue: expect.stringContaining('not valid JSON'),
      status: 'UNSET',
    });
    await expect(authority.configure(selectedPath)).resolves.toMatchObject({
      rootPath: await resolveCanonicalDirectory(selectedPath),
      status: 'READY',
    });
  });
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-project-root-'));
  temporaryDirectories.add(directory);
  return directory;
}

async function readProjectRootMarker(rootPath) {
  return JSON.parse(await readFile(join(rootPath, PROJECT_ROOT_MARKER_FILE_NAME), 'utf8'));
}
