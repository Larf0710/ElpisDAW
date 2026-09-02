import { writeFile } from 'node:fs/promises';

export const MAX_RECORDING_WAV_BYTES = 128 * 1024 * 1024;

export class RecordingWavValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordingWavValidationError';
  }
}

export class RecordingArtifactWriter {
  #generatedArtifactFinalizer;

  constructor({ generatedArtifactFinalizer }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError('RecordingArtifactWriter requires a GeneratedArtifactFinalizer.');
    }

    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
  }

  async saveWav(value) {
    const wavBytes = toBuffer(value);
    const audio = inspectRecordingWav(wavBytes);
    const reservation = await this.#generatedArtifactFinalizer.reserve({
      destination: 'recording',
      extension: '.wav',
    });

    try {
      await writeFile(reservation.stagingPath, wavBytes, { flag: 'r+' });
      const finalized = await this.#generatedArtifactFinalizer.finalize(
        reservation.reservationId,
      );

      return Object.freeze({
        artifactId: finalized.artifactId,
        audio,
        createdAt: reservation.createdAt,
        destination: 'recording',
        file: finalized.file,
        kind: 'audio',
        status: 'FINALIZED',
      });
    } catch (error) {
      try {
        await this.#generatedArtifactFinalizer.discard(reservation.reservationId);
      } catch (discardError) {
        throw new AggregateError(
          [error, discardError],
          'Recording save failed and its staging file could not be discarded.',
        );
      }

      throw error;
    }
  }
}

export function inspectRecordingWav(value) {
  const wavBytes = toBuffer(value);

  if (wavBytes.length < 44) {
    throw new RecordingWavValidationError(
      'Recording WAV must contain a complete RIFF/WAVE header and audio data.',
    );
  }

  if (
    readAscii(wavBytes, 0) !== 'RIFF' ||
    readAscii(wavBytes, 8) !== 'WAVE'
  ) {
    throw new RecordingWavValidationError(
      'Recording file must use the RIFF/WAVE container.',
    );
  }

  if (wavBytes.readUInt32LE(4) + 8 !== wavBytes.length) {
    throw new RecordingWavValidationError(
      'Recording WAV RIFF size does not match the uploaded file.',
    );
  }

  let format;
  let dataByteLength;
  let offset = 12;

  while (offset + 8 <= wavBytes.length) {
    const chunkId = readAscii(wavBytes, offset);
    const chunkByteLength = wavBytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkByteLength;

    if (chunkEnd > wavBytes.length) {
      throw new RecordingWavValidationError(
        `Recording WAV ${chunkId || 'unknown'} chunk exceeds the uploaded file.`,
      );
    }

    if (chunkId === 'fmt ' && format === undefined) {
      format = inspectFormatChunk(wavBytes, chunkStart, chunkByteLength);
    } else if (chunkId === 'data' && dataByteLength === undefined) {
      dataByteLength = chunkByteLength;
    }

    offset = chunkEnd + (chunkByteLength % 2);
  }

  if (offset !== wavBytes.length) {
    throw new RecordingWavValidationError(
      'Recording WAV contains an incomplete chunk header or padding byte.',
    );
  }

  if (!format) {
    throw new RecordingWavValidationError('Recording WAV is missing its fmt chunk.');
  }

  if (dataByteLength === undefined || dataByteLength === 0) {
    throw new RecordingWavValidationError(
      'Recording WAV must contain a non-empty data chunk.',
    );
  }

  if (dataByteLength % format.blockAlign !== 0) {
    throw new RecordingWavValidationError(
      'Recording WAV data is not aligned to complete audio frames.',
    );
  }

  const durationSeconds = dataByteLength / format.byteRate;

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RecordingWavValidationError(
      'Recording WAV duration must be greater than zero.',
    );
  }

  return Object.freeze({
    bitsPerSample: format.bitsPerSample,
    channels: format.channels,
    durationSeconds,
    mimeType: 'audio/wav',
    sampleRate: format.sampleRate,
  });
}

function inspectFormatChunk(wavBytes, chunkStart, chunkByteLength) {
  if (chunkByteLength < 16) {
    throw new RecordingWavValidationError(
      'Recording WAV fmt chunk must contain the PCM format fields.',
    );
  }

  const audioFormat = wavBytes.readUInt16LE(chunkStart);
  const channels = wavBytes.readUInt16LE(chunkStart + 2);
  const sampleRate = wavBytes.readUInt32LE(chunkStart + 4);
  const byteRate = wavBytes.readUInt32LE(chunkStart + 8);
  const blockAlign = wavBytes.readUInt16LE(chunkStart + 12);
  const bitsPerSample = wavBytes.readUInt16LE(chunkStart + 14);
  const expectedBlockAlign = channels * (bitsPerSample / 8);
  const expectedByteRate = sampleRate * expectedBlockAlign;

  if (audioFormat !== 1) {
    throw new RecordingWavValidationError(
      'Recording WAV must use uncompressed PCM audio.',
    );
  }

  if (channels !== 1 && channels !== 2) {
    throw new RecordingWavValidationError(
      'ElpisDAW recording WAV must contain one mono or stereo channel pair.',
    );
  }

  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new RecordingWavValidationError(
      'Recording WAV sample rate must be between 8 kHz and 192 kHz.',
    );
  }

  if (bitsPerSample !== 16) {
    throw new RecordingWavValidationError(
      'ElpisDAW v0.1 recording WAV must use 16-bit PCM samples.',
    );
  }

  if (blockAlign !== expectedBlockAlign || byteRate !== expectedByteRate) {
    throw new RecordingWavValidationError(
      'Recording WAV PCM rate and frame metadata are inconsistent.',
    );
  }

  return Object.freeze({
    bitsPerSample,
    blockAlign,
    byteRate,
    channels,
    sampleRate,
  });
}

function readAscii(buffer, offset) {
  return buffer.toString('ascii', offset, offset + 4);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new TypeError('Recording WAV must be provided as binary bytes.');
}
