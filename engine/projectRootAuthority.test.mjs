import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROJECT_ROOT_DIRECTORIES,
  ProjectRootAuthority,
  resolveCanonicalDirectory,
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

    for (const relativePath of PROJECT_ROOT_DIRECTORIES) {
      await expect(stat(join(snapshot.rootPath, relativePath))).resolves.toMatchObject({});
    }
  });

  it('does not replace the current Root when a new selection is invalid', async () => {
    const selectedPath = await createTemporaryDirectory();
    const invalidPath = join(selectedPath, 'not-a-directory.txt');
    await writeFile(invalidPath, 'not a directory', 'utf8');
    const authority = new ProjectRootAuthority();
    const currentSnapshot = await authority.configure(selectedPath);

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
