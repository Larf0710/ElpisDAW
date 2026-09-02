import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  localEngineLogger,
  toDiagnosticErrorFields,
} from './diagnosticLogger.mjs';
import { resolveProjectPath } from './projectRootAuthority.mjs';

export const GENERATED_ARTIFACT_DESTINATIONS = Object.freeze({
  'ace-step': 'renders/ace-step',
  'ace-step-lyrics': 'renders/ace-step/lyrics',
  export: 'exports',
  instrument: 'renders/instruments',
  mixdown: 'mixdowns',
  'print-mix': 'print-mixes',
  recording: 'recordings',
  'stable-audio-3': 'renders/stable-audio-3',
  'stem-print': 'stem-prints',
});

const ARTIFACT_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;
const ARTIFACT_ID_PATTERN =
  /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class GeneratedArtifactFinalizationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'GeneratedArtifactFinalizationError';
  }
}

export class GeneratedArtifactFinalizer {
  #activeOperations = new Set();
  #logger;
  #projectRootAuthority;
  #reservations = new Map();

  constructor({ logger = localEngineLogger, projectRootAuthority }) {
    if (!projectRootAuthority || typeof projectRootAuthority.getSnapshot !== 'function') {
      throw new TypeError('GeneratedArtifactFinalizer requires a ProjectRootAuthority.');
    }

    if (!isDiagnosticLogger(logger)) {
      throw new TypeError('GeneratedArtifactFinalizer requires a diagnostic logger.');
    }

    this.#logger = logger;
    this.#projectRootAuthority = projectRootAuthority;
  }

  getActiveReservationCount() {
    return this.#reservations.size;
  }

  hasActiveWork() {
    return this.#reservations.size > 0 || this.#activeOperations.size > 0;
  }

  async reserve(options) {
    const operation = this.#reserveArtifact(options);
    this.#activeOperations.add(operation);

    try {
      return await operation;
    } finally {
      this.#activeOperations.delete(operation);
    }
  }

  async #reserveArtifact({ artifactId: requestedArtifactId, destination, extension }) {
    const relativeDirectory = resolveArtifactDestination(destination);
    const normalizedExtension = normalizeArtifactExtension(extension);
    const artifactId = normalizeArtifactId(requestedArtifactId);
    const projectRoot = this.#projectRootAuthority.getSnapshot();

    if (projectRoot.status !== 'READY') {
      throw new GeneratedArtifactFinalizationError(
        'PROJECT_ROOT_REQUIRED',
        'Select a Project Root before staging a generated file.',
      );
    }

    const targetDirectory = await resolveCanonicalArtifactDirectory(
      projectRoot.rootPath,
      relativeDirectory,
    );
    const reservationId = `reservation-${randomUUID()}`;
    const finalFileName = `${artifactId}${normalizedExtension}`;
    const finalPath = join(targetDirectory, finalFileName);
    const stagingPath = join(targetDirectory, `.${finalFileName}.${reservationId}.partial`);
    const stagingHandle = await open(stagingPath, 'wx', 0o600);
    await stagingHandle.close();

    const reservation = {
      artifactId,
      createdAt: new Date().toISOString(),
      destination,
      extension: normalizedExtension,
      finalFileName,
      finalPath,
      finalRelativePath: `${relativeDirectory}/${finalFileName}`,
      reservationId,
      stagingPath,
      state: 'STAGING',
    };
    this.#reservations.set(reservationId, reservation);
    this.#logger.debug('ARTIFACT', 'ARTIFACT_RESERVED', {
      artifactId,
      destination,
      relativePath: reservation.finalRelativePath,
      reservationId,
      state: reservation.state,
    });

    return createPublicReservation(reservation);
  }

  async finalize(reservationId) {
    const reservation = this.#requireReservation(reservationId);

    if (reservation.state !== 'STAGING') {
      throw new GeneratedArtifactFinalizationError(
        'ARTIFACT_RESERVATION_BUSY',
        'Generated file reservation is already being finalized or discarded.',
      );
    }

    const operation = this.#finalizeReservation(reservation);
    this.#activeOperations.add(operation);

    try {
      return await operation;
    } finally {
      this.#activeOperations.delete(operation);
    }
  }

  async #finalizeReservation(reservation) {
    reservation.state = 'FINALIZING';
    this.#logger.trace('ARTIFACT', 'FILE_FINALIZATION_STEP', {
      artifactId: reservation.artifactId,
      destination: reservation.destination,
      phase: 'VALIDATE_STAGING',
      relativePath: reservation.finalRelativePath,
      reservationId: reservation.reservationId,
    });

    try {
      let stagingStat;

      try {
        stagingStat = await lstat(reservation.stagingPath);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          throw new GeneratedArtifactFinalizationError(
            'ARTIFACT_STAGING_MISSING',
            'Generated staging output is missing and cannot be finalized.',
          );
        }

        throw error;
      }

      if (!stagingStat.isFile() || stagingStat.isSymbolicLink()) {
        throw new GeneratedArtifactFinalizationError(
          'ARTIFACT_STAGING_INVALID',
          'Generated staging output must be a regular file.',
        );
      }

      if (stagingStat.size === 0) {
        throw new GeneratedArtifactFinalizationError(
          'ARTIFACT_STAGING_EMPTY',
          'Generated staging output is empty and cannot be finalized.',
        );
      }

      const stagingHandle = await open(reservation.stagingPath, 'r+');

      try {
        await stagingHandle.sync();
      } finally {
        await stagingHandle.close();
      }

      await assertDestinationMissing(reservation.finalPath);
      this.#logger.trace('ARTIFACT', 'FILE_FINALIZATION_STEP', {
        artifactId: reservation.artifactId,
        destination: reservation.destination,
        phase: 'ATOMIC_RENAME',
        relativePath: reservation.finalRelativePath,
        reservationId: reservation.reservationId,
        sizeBytes: stagingStat.size,
      });
      await rename(reservation.stagingPath, reservation.finalPath);

      const finalizedArtifact = Object.freeze({
        artifactId: reservation.artifactId,
        destination: reservation.destination,
        file: Object.freeze({
          extension: reservation.extension,
          name: reservation.finalFileName,
          relativePath: reservation.finalRelativePath,
          sizeBytes: stagingStat.size,
        }),
        finalizedAt: new Date().toISOString(),
        reservationId: reservation.reservationId,
        status: 'FINALIZED',
      });
      this.#reservations.delete(reservation.reservationId);
      this.#logger.info('ARTIFACT', 'OUTPUT_FINALIZED', {
        artifactId: reservation.artifactId,
        destination: reservation.destination,
        relativePath: reservation.finalRelativePath,
        reservationId: reservation.reservationId,
        sizeBytes: stagingStat.size,
      });
      return finalizedArtifact;
    } catch (error) {
      reservation.state = 'STAGING';
      this.#logger.error('ARTIFACT', 'FINALIZATION_FAILED', {
        ...toDiagnosticErrorFields(error),
        artifactId: reservation.artifactId,
        destination: reservation.destination,
        relativePath: reservation.finalRelativePath,
        reservationId: reservation.reservationId,
      });
      throw error;
    }
  }

  async discard(reservationId) {
    const reservation = this.#requireReservation(reservationId);

    if (reservation.state !== 'STAGING') {
      throw new GeneratedArtifactFinalizationError(
        'ARTIFACT_RESERVATION_BUSY',
        'Generated file reservation is already being finalized or discarded.',
      );
    }

    const operation = this.#discardReservation(reservation);
    this.#activeOperations.add(operation);

    try {
      return await operation;
    } finally {
      this.#activeOperations.delete(operation);
    }
  }

  async #discardReservation(reservation) {
    reservation.state = 'DISCARDING';

    try {
      await rm(reservation.stagingPath, { force: true });
      this.#reservations.delete(reservation.reservationId);
      this.#logger.info('ARTIFACT', 'OUTPUT_DISCARDED', {
        artifactId: reservation.artifactId,
        destination: reservation.destination,
        relativePath: reservation.finalRelativePath,
        reservationId: reservation.reservationId,
      });
      return Object.freeze({ reservationId: reservation.reservationId, status: 'DISCARDED' });
    } catch (error) {
      reservation.state = 'STAGING';
      this.#logger.error('ARTIFACT', 'DISCARD_FAILED', {
        ...toDiagnosticErrorFields(error),
        artifactId: reservation.artifactId,
        destination: reservation.destination,
        relativePath: reservation.finalRelativePath,
        reservationId: reservation.reservationId,
      });
      throw error;
    }
  }

  async discardAll() {
    await Promise.allSettled([...this.#activeOperations]);
    const reservationIds = [...this.#reservations.keys()];
    const results = await Promise.allSettled(
      reservationIds.map((reservationId) => this.discard(reservationId)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );

    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more generated staging files could not be discarded.');
    }
  }

  #requireReservation(reservationId) {
    if (typeof reservationId !== 'string' || reservationId.length === 0) {
      throw new GeneratedArtifactFinalizationError(
        'ARTIFACT_RESERVATION_INVALID',
        'Generated file reservation ID is required.',
      );
    }

    const reservation = this.#reservations.get(reservationId);

    if (!reservation) {
      throw new GeneratedArtifactFinalizationError(
        'ARTIFACT_RESERVATION_NOT_FOUND',
        'Generated file reservation was not found or is already complete.',
      );
    }

    return reservation;
  }
}

function isDiagnosticLogger(value) {
  return (
    value &&
    typeof value.debug === 'function' &&
    typeof value.info === 'function' &&
    typeof value.trace === 'function' &&
    typeof value.error === 'function'
  );
}

function normalizeArtifactId(value) {
  if (value === undefined) {
    return `artifact-${randomUUID()}`;
  }

  if (typeof value !== 'string' || !ARTIFACT_ID_PATTERN.test(value)) {
    throw new GeneratedArtifactFinalizationError(
      'ARTIFACT_ID_INVALID',
      'Generated artifact identity is invalid.',
    );
  }

  return value;
}

function resolveArtifactDestination(destination) {
  if (
    typeof destination !== 'string' ||
    !Object.prototype.hasOwnProperty.call(GENERATED_ARTIFACT_DESTINATIONS, destination)
  ) {
    throw new GeneratedArtifactFinalizationError(
      'ARTIFACT_DESTINATION_INVALID',
      'Generated artifact destination is not supported.',
    );
  }

  return GENERATED_ARTIFACT_DESTINATIONS[destination];
}

function normalizeArtifactExtension(extension) {
  if (typeof extension !== 'string') {
    throw new GeneratedArtifactFinalizationError(
      'ARTIFACT_EXTENSION_INVALID',
      'Generated artifact extension must be a string.',
    );
  }

  const normalizedExtension = extension.trim().toLowerCase();

  if (!ARTIFACT_EXTENSION_PATTERN.test(normalizedExtension)) {
    throw new GeneratedArtifactFinalizationError(
      'ARTIFACT_EXTENSION_INVALID',
      'Generated artifact extension must use one dot followed by letters or numbers.',
    );
  }

  return normalizedExtension;
}

async function resolveCanonicalArtifactDirectory(rootPath, relativeDirectory) {
  const directoryPath = resolveProjectPath(rootPath, relativeDirectory);
  const canonicalDirectory = await realpath(directoryPath);
  const relativePath = relative(rootPath, canonicalDirectory);

  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  ) {
    return canonicalDirectory;
  }

  throw new GeneratedArtifactFinalizationError(
    'ARTIFACT_DESTINATION_ESCAPE',
    'Generated artifact destination escapes the Project Root.',
  );
}

async function assertDestinationMissing(finalPath) {
  try {
    await lstat(finalPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  throw new GeneratedArtifactFinalizationError(
    'ARTIFACT_DESTINATION_EXISTS',
    'Generated artifact destination already exists and will not be overwritten.',
  );
}

function createPublicReservation(reservation) {
  return Object.freeze({
    artifactId: reservation.artifactId,
    createdAt: reservation.createdAt,
    destination: reservation.destination,
    finalRelativePath: reservation.finalRelativePath,
    reservationId: reservation.reservationId,
    stagingPath: reservation.stagingPath,
    status: 'STAGING',
  });
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}
