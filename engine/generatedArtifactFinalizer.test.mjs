import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GeneratedArtifactFinalizationError,
  GeneratedArtifactFinalizer,
} from './generatedArtifactFinalizer.mjs';
import { ProjectRootAuthority } from './projectRootAuthority.mjs';

const temporaryDirectories = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe('GeneratedArtifactFinalizer', () => {
  it('promotes only a non-empty staged file into its final Project-relative path', async () => {
    const { finalizer, rootPath } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({
      destination: 'stable-audio-3',
      extension: '.WAV',
    });
    const generatedBytes = Buffer.from('RIFF-generated-audio');
    await writeFile(reservation.stagingPath, generatedBytes);

    const finalized = await finalizer.finalize(reservation.reservationId);
    const finalPath = join(rootPath, ...finalized.file.relativePath.split('/'));

    expect(finalized).toMatchObject({
      artifactId: reservation.artifactId,
      destination: 'stable-audio-3',
      file: {
        extension: '.wav',
        sizeBytes: generatedBytes.length,
      },
      status: 'FINALIZED',
    });
    expect(finalized.file.relativePath).toMatch(
      /^renders\/stable-audio-3\/artifact-[0-9a-f-]+\.wav$/,
    );
    await expect(readFile(finalPath)).resolves.toEqual(generatedBytes);
    await expect(access(reservation.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('requires a ready Project Root and rejects destination or extension traversal', async () => {
    const authority = new ProjectRootAuthority();
    const finalizer = new GeneratedArtifactFinalizer({ projectRootAuthority: authority });

    await expect(
      finalizer.reserve({ destination: 'instrument', extension: '.wav' }),
    ).rejects.toMatchObject({ code: 'PROJECT_ROOT_REQUIRED' });

    const rootPath = await createTemporaryDirectory();
    await authority.configure(rootPath);
    await expect(
      finalizer.reserve({ destination: '../outside', extension: '.wav' }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_DESTINATION_INVALID' });
    await expect(
      finalizer.reserve({ destination: 'instrument', extension: '../wav' }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXTENSION_INVALID' });
  });

  it('reserves one validated caller-owned Artifact identity without changing it', async () => {
    const { finalizer } = await createReadyFinalizer();
    const artifactId = 'artifact-11111111-1111-4111-8111-111111111111';
    const reservation = await finalizer.reserve({
      artifactId,
      destination: 'mixdown',
      extension: '.wav',
    });

    expect(reservation).toMatchObject({
      artifactId,
      finalRelativePath: `mixdowns/${artifactId}.wav`,
    });
    await finalizer.discard(reservation.reservationId);
    await expect(
      finalizer.reserve({
        artifactId: 'artifact-not-valid',
        destination: 'mixdown',
        extension: '.wav',
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_ID_INVALID' });
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('keeps empty or missing staged output out of final destinations', async () => {
    const { finalizer, rootPath } = await createReadyFinalizer();
    const emptyReservation = await finalizer.reserve({ destination: 'mixdown', extension: '.wav' });

    await expect(finalizer.finalize(emptyReservation.reservationId)).rejects.toMatchObject({
      code: 'ARTIFACT_STAGING_EMPTY',
    });
    expect(finalizer.getActiveReservationCount()).toBe(1);
    await finalizer.discard(emptyReservation.reservationId);
    await expect(access(emptyReservation.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(rootPath, ...emptyReservation.finalRelativePath.split('/')))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const missingReservation = await finalizer.reserve({ destination: 'export', extension: '.wav' });
    await rm(missingReservation.stagingPath, { force: true });
    await expect(finalizer.finalize(missingReservation.reservationId)).rejects.toMatchObject({
      code: 'ARTIFACT_STAGING_MISSING',
    });
    await finalizer.discard(missingReservation.reservationId);
  });

  it('never overwrites an existing final destination', async () => {
    const { finalizer, rootPath } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({ destination: 'ace-step', extension: '.wav' });
    const finalPath = join(rootPath, ...reservation.finalRelativePath.split('/'));
    await writeFile(reservation.stagingPath, 'new output', 'utf8');
    await writeFile(finalPath, 'existing output', 'utf8');

    await expect(finalizer.finalize(reservation.reservationId)).rejects.toMatchObject({
      code: 'ARTIFACT_DESTINATION_EXISTS',
    });
    await expect(readFile(finalPath, 'utf8')).resolves.toBe('existing output');
    await expect(readFile(reservation.stagingPath, 'utf8')).resolves.toBe('new output');
    await finalizer.discard(reservation.reservationId);
  });

  it('discards every active staging file during Engine cleanup', async () => {
    const { finalizer } = await createReadyFinalizer();
    const first = await finalizer.reserve({ destination: 'instrument', extension: '.wav' });
    const second = await finalizer.reserve({ destination: 'export', extension: '.flac' });

    await finalizer.discardAll();

    await expect(access(first.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(second.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('waits for in-flight finalization before shutdown cleanup completes', async () => {
    const { finalizer, rootPath } = await createReadyFinalizer();
    const reservation = await finalizer.reserve({ destination: 'export', extension: '.wav' });
    await writeFile(reservation.stagingPath, 'finished output', 'utf8');

    const finalization = finalizer.finalize(reservation.reservationId);
    const cleanup = finalizer.discardAll();
    const finalized = await finalization;
    await cleanup;

    await expect(
      readFile(join(rootPath, ...finalized.file.relativePath.split('/')), 'utf8'),
    ).resolves.toBe('finished output');
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('waits for in-flight reservation creation and then discards it during cleanup', async () => {
    const { finalizer } = await createReadyFinalizer();
    const reservationPromise = finalizer.reserve({ destination: 'instrument', extension: '.wav' });
    const cleanupPromise = finalizer.discardAll();
    const reservation = await reservationPromise;
    await cleanupPromise;

    await expect(access(reservation.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(finalizer.getActiveReservationCount()).toBe(0);
  });

  it('uses explicit finalization errors for unknown reservations', async () => {
    const { finalizer } = await createReadyFinalizer();

    await expect(finalizer.finalize('reservation-missing')).rejects.toBeInstanceOf(
      GeneratedArtifactFinalizationError,
    );
    await expect(finalizer.finalize('reservation-missing')).rejects.toMatchObject({
      code: 'ARTIFACT_RESERVATION_NOT_FOUND',
    });
  });
});

async function createReadyFinalizer() {
  const rootPath = await createTemporaryDirectory();
  const authority = new ProjectRootAuthority();
  await authority.configure(rootPath);
  return {
    finalizer: new GeneratedArtifactFinalizer({ projectRootAuthority: authority }),
    rootPath,
  };
}

async function createTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'humstudio-artifact-finalizer-'));
  temporaryDirectories.add(directory);
  return directory;
}
