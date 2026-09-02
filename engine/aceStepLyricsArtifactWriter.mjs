import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

export const MAX_ACE_STEP_LYRICS_BYTES = 16 * 1024;
export const MAX_ACE_STEP_LYRICS_CHARACTERS = 4_096;
export const MAX_ACE_STEP_LYRICS_REQUEST_BYTES = 32 * 1024;

export class AceStepLyricsValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'AceStepLyricsValidationError';
  }
}

export class AceStepLyricsArtifactWriter {
  #generatedArtifactFinalizer;

  constructor({ generatedArtifactFinalizer }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError(
        'AceStepLyricsArtifactWriter requires a GeneratedArtifactFinalizer.',
      );
    }

    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
  }

  async saveLyrics(value) {
    const lyrics = validateAceStepLyrics(value);
    const bytes = Buffer.from(lyrics, 'utf8');
    const reservation = await this.#generatedArtifactFinalizer.reserve({
      destination: 'ace-step-lyrics',
      extension: '.txt',
    });

    try {
      await writeFile(reservation.stagingPath, bytes, { flag: 'r+' });
      const finalized = await this.#generatedArtifactFinalizer.finalize(
        reservation.reservationId,
      );

      return Object.freeze({
        artifactId: finalized.artifactId,
        createdAt: reservation.createdAt,
        destination: 'ace-step-lyrics',
        file: finalized.file,
        kind: 'lyrics',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        status: 'FINALIZED',
      });
    } catch (error) {
      try {
        await this.#generatedArtifactFinalizer.discard(reservation.reservationId);
      } catch (discardError) {
        throw new AggregateError(
          [error, discardError],
          'ACE-Step Lyrics save failed and its staging file could not be discarded.',
        );
      }

      throw error;
    }
  }
}

export function validateAceStepLyrics(value) {
  if (typeof value !== 'string') {
    throw invalidLyrics('ACE-Step Lyrics must be a string.');
  }

  if (
    value.length === 0 ||
    value.length > MAX_ACE_STEP_LYRICS_CHARACTERS ||
    value.trim().length === 0 ||
    value.charCodeAt(0) === 0xfeff ||
    value.includes('\0')
  ) {
    throw invalidLyrics(
      `ACE-Step Lyrics must be non-empty BOM-less text within ${MAX_ACE_STEP_LYRICS_CHARACTERS} characters.`,
    );
  }

  const bytes = Buffer.from(value, 'utf8');

  if (
    bytes.length === 0 ||
    bytes.length > MAX_ACE_STEP_LYRICS_BYTES ||
    bytes.toString('utf8') !== value
  ) {
    throw invalidLyrics(
      `ACE-Step Lyrics must be valid UTF-8 within ${MAX_ACE_STEP_LYRICS_BYTES} bytes.`,
    );
  }

  return value;
}

function invalidLyrics(message) {
  return new AceStepLyricsValidationError('ACE_STEP_LYRICS_INVALID', message);
}
