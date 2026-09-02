import { writeFile } from 'node:fs/promises';

export const FLUIDSYNTH_PROVIDER_ID = 'local-fluidsynth';
export const FLUIDSYNTH_PROVIDER_VERSION = '2.5.7';
export const FLUIDSYNTH_INSTRUMENT_RENDER_TASK_ID = 'midi-to-audio';

const MAX_MIDI_NOTES = 4_096;
const MAX_MIDI_SECONDS = 300;
const MAX_WAV_BYTES = 100 * 1024 * 1024;
const MIDI_TICKS_PER_QUARTER = 960;

export class FluidSynthJobExecutorError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'FluidSynthJobExecutorError';
  }
}

export class FluidSynthJobExecutor {
  #activeJobId;
  #generatedArtifactFinalizer;
  #now;
  #soundFontAuditionService;

  constructor({
    generatedArtifactFinalizer,
    now = () => new Date().toISOString(),
    soundFontAuditionService,
  }) {
    if (
      !generatedArtifactFinalizer ||
      typeof generatedArtifactFinalizer.reserve !== 'function' ||
      typeof generatedArtifactFinalizer.finalize !== 'function' ||
      typeof generatedArtifactFinalizer.discard !== 'function'
    ) {
      throw new TypeError('FluidSynthJobExecutor requires a GeneratedArtifactFinalizer.');
    }

    if (
      !soundFontAuditionService ||
      typeof soundFontAuditionService.render !== 'function'
    ) {
      throw new TypeError('FluidSynthJobExecutor requires a SoundFont renderer.');
    }

    if (typeof now !== 'function') {
      throw new TypeError('FluidSynthJobExecutor timestamp factory must be a function.');
    }

    this.#generatedArtifactFinalizer = generatedArtifactFinalizer;
    this.#now = now;
    this.#soundFontAuditionService = soundFontAuditionService;
  }

  canHandleRequest(value) {
    return isRecord(value) && value.providerId === FLUIDSYNTH_PROVIDER_ID;
  }

  validateRequest(value) {
    if (!isRecord(value)) {
      fail('FluidSynth Job request must be an object.');
    }

    if (
      value.providerId !== FLUIDSYNTH_PROVIDER_ID ||
      value.taskId !== FLUIDSYNTH_INSTRUMENT_RENDER_TASK_ID
    ) {
      fail('FluidSynth Job requires the local-fluidsynth MIDI TO AUDIO task.');
    }

    const parameters = validateParameters(value.parameters);
    const soundFont = parameters.soundFont;

    if (
      value.modelId !== soundFont.resourceId ||
      value.modelRevision !== soundFont.revisionToken
    ) {
      fail('FluidSynth Model identity must match the selected SoundFont revision.');
    }

    const lineage = validateLineage(value.lineage);
    const inputArtifacts = validateInputs(value.inputArtifacts, lineage);
    const output = validateOutput(value.output);

    return Object.freeze({
      inputArtifacts,
      lineage,
      modelId: soundFont.resourceId,
      modelRevision: soundFont.revisionToken,
      output,
      parameters,
      providerId: FLUIDSYNTH_PROVIDER_ID,
      taskId: FLUIDSYNTH_INSTRUMENT_RENDER_TASK_ID,
    });
  }

  async run(requestValue, { jobId, onPhase, signal }) {
    const request = this.validateRequest(requestValue);
    validateExecutionContext(jobId, onPhase, signal);

    if (this.#activeJobId) {
      throw new FluidSynthJobExecutorError(
        'FLUIDSYNTH_EXECUTOR_BUSY',
        `FluidSynth executor is already running ${this.#activeJobId}.`,
      );
    }

    this.#activeJobId = jobId;
    let finalized = false;
    let reservation;
    let result;
    let primaryError;

    try {
      throwIfAborted(signal);
      reservation = await this.#generatedArtifactFinalizer.reserve({
        destination: 'instrument',
        extension: '.wav',
      });
      throwIfAborted(signal);
      onPhase('PROCESSING');
      const rendered = await this.#soundFontAuditionService.render(
        {
          bank: request.parameters.preset.bank,
          midi: request.inputArtifacts[0].midi,
          program: request.parameters.preset.program,
          soundFont: {
            format: request.parameters.soundFont.format,
            library: request.parameters.soundFont.library,
            relativePath: request.parameters.soundFont.relativePath,
            resourceId: request.parameters.soundFont.resourceId,
            revisionToken: request.parameters.soundFont.revisionToken,
          },
        },
        {
          gain: 10 ** (request.parameters.gainDb / 20),
          sampleRate: request.parameters.sampleRate,
          signal,
        },
      );
      throwIfAborted(signal);
      validateRenderedWav(rendered, request.parameters);
      await writeFile(reservation.stagingPath, rendered.bytes, { flag: 'w' });
      throwIfAborted(signal);
      onPhase('SAVING');
      const finalizedArtifact = await this.#generatedArtifactFinalizer.finalize(
        reservation.reservationId,
      );
      finalized = true;
      result = createCompletedResult(
        request,
        rendered,
        finalizedArtifact,
        this.#now(),
      );
    } catch (error) {
      primaryError = error;
    }

    const cleanupErrors = [];

    if (reservation && !finalized) {
      try {
        await this.#generatedArtifactFinalizer.discard(reservation.reservationId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (this.#activeJobId === jobId) {
      this.#activeJobId = undefined;
    }

    if (primaryError || cleanupErrors.length > 0) {
      throw combineErrors(primaryError, cleanupErrors);
    }

    return result;
  }

  async cancel(jobId) {
    if (this.#activeJobId && this.#activeJobId !== jobId) {
      throw new FluidSynthJobExecutorError(
        'FLUIDSYNTH_EXECUTOR_JOB_MISMATCH',
        `Cannot cancel ${jobId} while ${this.#activeJobId} is active.`,
      );
    }
  }

  async shutdown() {
    // GpuJobQueue aborts the active execution signal before calling shutdown.
  }
}

function validateParameters(value) {
  if (!isRecord(value)) {
    fail('FluidSynth parameters must be an object.');
  }

  if (
    value.providerVersion !== FLUIDSYNTH_PROVIDER_VERSION ||
    value.channels !== 2 ||
    !Number.isFinite(value.gainDb) ||
    value.gainDb < -60 ||
    value.gainDb > 12 ||
    !Number.isSafeInteger(value.sampleRate) ||
    value.sampleRate < 8_000 ||
    value.sampleRate > 192_000 ||
    !Number.isSafeInteger(value.sourceMidiRevision) ||
    value.sourceMidiRevision < 1 ||
    typeof value.sourceMidiContentHash !== 'string' ||
    !/^fnv1a64-[0-9a-f]{16}$/.test(value.sourceMidiContentHash)
  ) {
    fail('FluidSynth render parameters are invalid.');
  }

  if (
    !isRecord(value.preset) ||
    !Number.isInteger(value.preset.bank) ||
    value.preset.bank < 0 ||
    value.preset.bank > 16_383 ||
    !Number.isInteger(value.preset.program) ||
    value.preset.program < 0 ||
    value.preset.program > 127
  ) {
    fail('FluidSynth preset requires a valid Bank and Program.');
  }

  if (!isRecord(value.soundFont)) {
    fail('FluidSynth render requires one SoundFont.');
  }

  const soundFont = Object.freeze({
    format: value.soundFont.format,
    library: value.soundFont.library,
    relativePath: value.soundFont.relativePath,
    resourceId: value.soundFont.resourceId,
    revisionToken: value.soundFont.revisionToken,
  });

  if (
    (soundFont.library !== 'builtin' && soundFont.library !== 'project') ||
    (soundFont.format !== 'sf2' && soundFont.format !== 'sf3') ||
    typeof soundFont.relativePath !== 'string' ||
    !isNormalizedSoundFontPath(soundFont.relativePath, soundFont.format) ||
    typeof soundFont.resourceId !== 'string' ||
    !/^soundfont-[a-f0-9]{32}$/.test(soundFont.resourceId) ||
    typeof soundFont.revisionToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(soundFont.revisionToken)
  ) {
    fail('FluidSynth SoundFont identity is invalid.');
  }

  return Object.freeze({
    channels: 2,
    gainDb: value.gainDb,
    preset: Object.freeze({
      bank: value.preset.bank,
      program: value.preset.program,
    }),
    providerVersion: FLUIDSYNTH_PROVIDER_VERSION,
    sampleRate: value.sampleRate,
    soundFont,
    sourceMidiContentHash: value.sourceMidiContentHash,
    sourceMidiRevision: value.sourceMidiRevision,
  });
}

function validateLineage(value) {
  if (
    !isRecord(value) ||
    !Array.isArray(value.parentArtifactIds) ||
    value.parentArtifactIds.length !== 1 ||
    !Array.isArray(value.parentClipTakeIds) ||
    value.parentClipTakeIds.length !== 1
  ) {
    fail('FluidSynth render requires one parent Artifact and one parent Clip Take.');
  }

  const artifactId = requireText(value.parentArtifactIds[0], 'Parent Artifact ID');
  const clipTakeId = requireText(value.parentClipTakeIds[0], 'Parent Clip Take ID');
  return Object.freeze({
    parentArtifactIds: Object.freeze([artifactId]),
    parentClipTakeIds: Object.freeze([clipTakeId]),
  });
}

function validateInputs(value, lineage) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !isRecord(value[0]) ||
    value[0].kind !== 'midi' ||
    value[0].artifactId !== lineage.parentArtifactIds[0] ||
    Object.hasOwn(value[0], 'path')
  ) {
    fail('FluidSynth render requires one inline MIDI Artifact matching Lineage.');
  }

  const midi = validateMidi(value[0].midi);
  return Object.freeze([
    Object.freeze({
      artifactId: lineage.parentArtifactIds[0],
      kind: 'midi',
      midi,
    }),
  ]);
}

function validateMidi(value) {
  if (
    !isRecord(value) ||
    !Number.isFinite(value.bpm) ||
    value.bpm < 40 ||
    value.bpm > 240 ||
    value.ticksPerQuarter !== MIDI_TICKS_PER_QUARTER ||
    !Array.isArray(value.notes) ||
    value.notes.length < 1 ||
    value.notes.length > MAX_MIDI_NOTES
  ) {
    fail(`FluidSynth MIDI requires 1 to ${MAX_MIDI_NOTES} notes at 960 PPQ.`);
  }

  const ids = new Set();
  const notes = value.notes.map((note, index) => {
    if (!isRecord(note)) {
      fail(`MIDI note ${index + 1} is invalid.`);
    }

    const id = requireText(note.id, `MIDI note ${index + 1} ID`);

    if (
      ids.has(id) ||
      !Number.isInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isInteger(note.startTick) ||
      note.startTick < 0 ||
      !Number.isInteger(note.lengthTicks) ||
      note.lengthTicks < 1 ||
      !Number.isInteger(note.velocity) ||
      note.velocity < 1 ||
      note.velocity > 127 ||
      note.startTick + note.lengthTicks > 0x0fffffff
    ) {
      fail(`MIDI note "${id}" is invalid.`);
    }

    const confidence = note.confidence;

    if (
      confidence !== undefined &&
      (typeof confidence !== 'number' ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1)
    ) {
      fail(`MIDI note "${id}" confidence must be a finite number from 0 through 1.`);
    }

    ids.add(id);
    return Object.freeze({
      ...(confidence === undefined ? {} : { confidence }),
      id,
      lengthTicks: note.lengthTicks,
      pitch: note.pitch,
      startTick: note.startTick,
      velocity: note.velocity,
    });
  });
  const maximumEndTick = Math.max(
    ...notes.map((note) => note.startTick + note.lengthTicks),
  );
  const durationSeconds =
    (maximumEndTick / MIDI_TICKS_PER_QUARTER) * (60 / value.bpm);

  if (durationSeconds > MAX_MIDI_SECONDS) {
    fail(`FluidSynth MIDI exceeds the ${MAX_MIDI_SECONDS} second render limit.`);
  }

  return Object.freeze({
    bpm: value.bpm,
    notes: Object.freeze(notes),
    ticksPerQuarter: MIDI_TICKS_PER_QUARTER,
  });
}

function validateOutput(value) {
  if (
    !isRecord(value) ||
    value.artifactKind !== 'audio' ||
    value.destination !== 'instrument' ||
    value.extension !== '.wav'
  ) {
    fail('FluidSynth output must be one Instrument WAV Artifact.');
  }

  return Object.freeze({
    artifactKind: 'audio',
    destination: 'instrument',
    extension: '.wav',
  });
}

function validateRenderedWav(rendered, parameters) {
  const bytes = rendered?.bytes;

  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 44 ||
    bytes.length > MAX_WAV_BYTES ||
    rendered.contentLength !== bytes.length ||
    rendered.contentType !== 'audio/wav' ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WAVE' ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== parameters.channels ||
    bytes.readUInt32LE(24) !== parameters.sampleRate ||
    bytes.readUInt16LE(34) !== 16
  ) {
    throw new FluidSynthJobExecutorError(
      'FLUIDSYNTH_RENDER_WAV_INVALID',
      'FluidSynth returned an invalid PCM Instrument WAV.',
    );
  }
}

function createCompletedResult(request, rendered, finalizedArtifact, completedAt) {
  const dataBytes = rendered.bytes.readUInt32LE(40);
  const durationSeconds =
    dataBytes /
    (request.parameters.sampleRate * request.parameters.channels * 2);

  return Object.freeze({
    artifact: Object.freeze({
      artifactId: finalizedArtifact.artifactId,
      createdAt: finalizedArtifact.finalizedAt,
      destination: finalizedArtifact.destination,
      file: finalizedArtifact.file,
      kind: 'audio',
      lineage: request.lineage,
      provenance: Object.freeze({
        modelId: request.modelId,
        modelRevision: request.modelRevision,
        parameters: request.parameters,
        providerId: request.providerId,
        taskId: request.taskId,
      }),
    }),
    generation: Object.freeze({
      bytesWritten: rendered.contentLength,
      channels: request.parameters.channels,
      durationSeconds,
      mimeType: 'audio/wav',
      providerCompletedAt: completedAt,
    }),
  });
}

function validateExecutionContext(jobId, onPhase, signal) {
  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    typeof onPhase !== 'function' ||
    !signal ||
    typeof signal.aborted !== 'boolean'
  ) {
    throw new FluidSynthJobExecutorError(
      'FLUIDSYNTH_EXECUTION_CONTEXT_INVALID',
      'FluidSynth execution context is invalid.',
    );
  }
}

function isNormalizedSoundFontPath(value, format) {
  const segments = value.split('/');
  return (
    value.startsWith('soundfonts/') &&
    value.toLowerCase().endsWith(`.${format}`) &&
    !value.includes('\\') &&
    segments.length > 1 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':'),
    )
  );
}

function requireText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.length > 256
  ) {
    fail(`${label} must be a trimmed string within 256 characters.`);
  }

  return value;
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new FluidSynthJobExecutorError(
      'JOB_ABORTED',
      'FluidSynth Instrument Render was aborted.',
    );
  }
}

function combineErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 1) {
    return cleanupErrors[0];
  }

  if (!primaryError) {
    return Object.assign(
      new AggregateError(cleanupErrors, 'FluidSynth Job cleanup failed.'),
      { code: 'FLUIDSYNTH_JOB_CLEANUP_FAILED' },
    );
  }

  if (cleanupErrors.length === 0) {
    return primaryError;
  }

  return Object.assign(
    new AggregateError(
      [primaryError, ...cleanupErrors],
      `${primaryError instanceof Error ? primaryError.message : 'FluidSynth Job failed.'} Cleanup also failed.`,
      { cause: primaryError },
    ),
    {
      code:
        primaryError instanceof Error &&
        'code' in primaryError &&
        typeof primaryError.code === 'string'
          ? primaryError.code
          : 'FLUIDSYNTH_JOB_FAILED',
    },
  );
}

function fail(message) {
  throw new FluidSynthJobExecutorError(
    'FLUIDSYNTH_QUEUE_REQUEST_INVALID',
    message,
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
