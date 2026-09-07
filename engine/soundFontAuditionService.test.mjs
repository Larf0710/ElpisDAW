import {
  access,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectRootAuthority } from './projectRootAuthority.mjs';
import { SoundFontCatalog } from './soundFontCatalog.mjs';
import {
  SoundFontAuditionError,
  SoundFontAuditionService,
} from './soundFontAuditionService.mjs';

const temporaryRoots = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((path) => rm(path, { force: true, recursive: true })),
  );
  temporaryRoots.clear();
});

describe('SoundFontAuditionService', () => {
  it('renders a catalog-verified SoundFont to WAV and removes temporary files', async () => {
    const { catalog, resource, rootPath } = await createCatalogFixture();
    const before = new Set(await listAuditionTemporaryDirectories());
    const fluidSynthRuntime = {
      renderMidiToWav: vi.fn(async ({ midiPath, outputPath, soundFontPath }) => {
        const midi = await readFile(midiPath);
        expect(midi.subarray(0, 4).toString('ascii')).toBe('MThd');
        expect((await realpath(soundFontPath)).toLowerCase()).toBe(
          (await realpath(join(rootPath, 'soundfonts', 'Keys.sf2'))).toLowerCase(),
        );
        await writeFile(outputPath, createPcmWav());
      }),
    };
    const service = new SoundFontAuditionService({
      fluidSynthRuntime,
      soundFontCatalog: catalog,
    });

    const result = await service.render(createRequest(resource));

    expect(result.contentType).toBe('audio/wav');
    expect(result.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(fluidSynthRuntime.renderMidiToWav).toHaveBeenCalledOnce();
    const after = await listAuditionTemporaryDirectories();
    expect(after.filter((path) => !before.has(path))).toEqual([]);
  });

  it('cancels an active render and still removes its temporary directory', async () => {
    const { catalog, resource } = await createCatalogFixture();
    const fluidSynthRuntime = {
      renderMidiToWav: vi.fn(
        ({ signal }) =>
          new Promise((resolveRender, rejectRender) => {
            signal.addEventListener(
              'abort',
              () => rejectRender(new SoundFontAuditionError(
                'SOUNDFONT_AUDITION_CANCELED',
                'SoundFont audition was canceled.',
              )),
              { once: true },
            );
          }),
      ),
    };
    const service = new SoundFontAuditionService({
      fluidSynthRuntime,
      soundFontCatalog: catalog,
    });
    const abortController = new AbortController();
    const render = service.render(createRequest(resource), {
      signal: abortController.signal,
    });
    await vi.waitFor(() =>
      expect(fluidSynthRuntime.renderMidiToWav).toHaveBeenCalledOnce(),
    );
    abortController.abort();

    await expect(render).rejects.toMatchObject({
      code: 'SOUNDFONT_AUDITION_CANCELED',
    });
    await service.shutdown();
  });

  it('honors a signal that was already canceled before rendering starts', async () => {
    const { catalog, resource } = await createCatalogFixture();
    const fluidSynthRuntime = {
      renderMidiToWav: vi.fn(async ({ signal }) => {
        expect(signal.aborted).toBe(true);
        throw new SoundFontAuditionError(
          'SOUNDFONT_AUDITION_CANCELED',
          'SoundFont audition was canceled.',
        );
      }),
    };
    const service = new SoundFontAuditionService({
      fluidSynthRuntime,
      soundFontCatalog: catalog,
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      service.render(createRequest(resource), {
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({
      code: 'SOUNDFONT_AUDITION_CANCELED',
    });
    expect(fluidSynthRuntime.renderMidiToWav).toHaveBeenCalledOnce();
  });

  it('rejects an audition when the catalog revision changed', async () => {
    const { catalog, resource, rootPath } = await createCatalogFixture();
    await writeFile(join(rootPath, 'soundfonts', 'Keys.sf2'), 'changed-sf2');
    const service = new SoundFontAuditionService({
      fluidSynthRuntime: { renderMidiToWav: vi.fn() },
      soundFontCatalog: catalog,
    });

    await expect(service.render(createRequest(resource))).rejects.toMatchObject({
      code: 'SOUNDFONT_REVISION_CHANGED',
    });
  });
});

async function createCatalogFixture() {
  const rootPath = await mkdtemp(join(tmpdir(), 'humstudio-audition-project-'));
  temporaryRoots.add(rootPath);
  const authority = new ProjectRootAuthority();
  await authority.configure(rootPath);
  await writeFile(join(rootPath, 'soundfonts', 'Keys.sf2'), 'test-sf2');
  const catalog = new SoundFontCatalog({ projectRootAuthority: authority });
  const snapshot = await catalog.list();
  const resource = snapshot.resources[0];
  expect(resource).toBeDefined();
  return { catalog, resource, rootPath };
}

function createRequest(resource) {
  return {
    bank: 0,
    midi: {
      bpm: 120,
      notes: [
        {
          id: 'note-1',
          lengthTicks: 960,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: 960,
    },
    program: 0,
    soundFont: {
      format: resource.format,
      library: resource.library,
      relativePath: resource.relativePath,
      resourceId: resource.resourceId,
      revisionToken: resource.revisionToken,
    },
  };
}

async function listAuditionTemporaryDirectories() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  const paths = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith('humstudio-soundfont-audition-'),
    )
    .map((entry) => join(tmpdir(), entry.name))
    .sort();

  await Promise.all(paths.map((path) => access(path)));
  return paths;
}

function createPcmWav() {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(0, 40);
  return wav;
}
