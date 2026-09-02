import {
  PROVIDER_WORKER_PROTOCOL_VERSION,
  ProviderContractValidationError,
  providerSupportsJob,
  validateProviderDescriptor,
  validateProviderJob,
} from './providerContract.mjs';

export const MOCK_PROVIDER_ID = 'mock-provider';
export const MOCK_PROVIDER_TASK_ID = 'mock-audio-generation';
export const MOCK_PROVIDER_MODEL_ID = 'mock-audio-v1';
export const MOCK_PROVIDER_MODEL_REVISION = '1';
export const MOCK_HUM_TO_MIDI_TASK_ID = 'hum-to-midi';
export const MOCK_HUM_TO_MIDI_MODEL_ID = 'mock-hum-to-midi-v1';
export const MOCK_HUM_TO_MIDI_MODEL_REVISION = '1';
export const MOCK_HUM_TO_MIDI_TICKS_PER_QUARTER = 960;
export const MOCK_INSTRUMENT_RENDER_TASK_ID = 'midi-to-audio';
export const MOCK_INSTRUMENT_RENDER_MODEL_ID = 'mock-soundfont-v1';
export const MOCK_INSTRUMENT_RENDER_MODEL_REVISION = '1';
export const MOCK_INSTRUMENT_RENDER_PROVIDER_VERSION = '1';
export const MOCK_INSTRUMENT_RENDER_MAX_DURATION_SECONDS = 30;
export const MOCK_INSTRUMENT_RENDER_MAX_NOTE_SECONDS = 120;

export const MOCK_PROVIDER_DESCRIPTOR = validateProviderDescriptor({
  capabilities: [
    {
      inputArtifactKinds: [],
      outputArtifactKind: 'audio',
      supportsCancellation: false,
      taskId: MOCK_PROVIDER_TASK_ID,
    },
    {
      inputArtifactKinds: ['audio'],
      outputArtifactKind: 'midi',
      supportsCancellation: false,
      taskId: MOCK_HUM_TO_MIDI_TASK_ID,
    },
    {
      inputArtifactKinds: ['midi'],
      outputArtifactKind: 'audio',
      supportsCancellation: false,
      taskId: MOCK_INSTRUMENT_RENDER_TASK_ID,
    },
  ],
  displayName: 'ElpisDAW Mock Provider',
  models: [
    {
      compatibility: 'COMPATIBLE',
      modelId: MOCK_PROVIDER_MODEL_ID,
      revision: MOCK_PROVIDER_MODEL_REVISION,
      taskIds: [MOCK_PROVIDER_TASK_ID],
    },
    {
      compatibility: 'COMPATIBLE',
      modelId: MOCK_HUM_TO_MIDI_MODEL_ID,
      revision: MOCK_HUM_TO_MIDI_MODEL_REVISION,
      taskIds: [MOCK_HUM_TO_MIDI_TASK_ID],
    },
    {
      compatibility: 'COMPATIBLE',
      modelId: MOCK_INSTRUMENT_RENDER_MODEL_ID,
      revision: MOCK_INSTRUMENT_RENDER_MODEL_REVISION,
      taskIds: [MOCK_INSTRUMENT_RENDER_TASK_ID],
    },
  ],
  providerId: MOCK_PROVIDER_ID,
  protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
  runtime: {
    compatibility: 'COMPATIBLE',
    profile: 'mock-cpu',
    version: '1',
  },
});

export function validateMockProviderJob(value) {
  const job = validateProviderJob(value);

  if (!providerSupportsJob(MOCK_PROVIDER_DESCRIPTOR, job)) {
    throw createMockProviderValidationError(
      'MOCK_JOB_UNSUPPORTED',
      'Mock Provider does not support the requested Provider, Model, revision, or Task.',
    );
  }

  if (job.taskId === MOCK_PROVIDER_TASK_ID) {
    if (job.inputArtifacts.length !== 0 || job.output.kind !== 'audio') {
      throw createMockProviderValidationError(
        'MOCK_JOB_ARTIFACTS_INVALID',
        'Mock audio generation accepts no input artifacts and requires an audio output.',
      );
    }

    validateMockProviderParameters(job.parameters);
    return job;
  }

  if (job.taskId === MOCK_INSTRUMENT_RENDER_TASK_ID) {
    if (
      job.inputArtifacts.length !== 1 ||
      job.inputArtifacts[0]?.kind !== 'midi' ||
      !isRecord(job.inputArtifacts[0]?.midi) ||
      job.inputArtifacts[0]?.path !== undefined ||
      job.output.kind !== 'audio'
    ) {
      throw createMockProviderValidationError(
        'MOCK_INSTRUMENT_RENDER_ARTIFACTS_INVALID',
        'Mock Instrument Render requires one inline MIDI input and one staged audio output.',
      );
    }

    validateMockInstrumentRenderMidi(job.inputArtifacts[0].midi);
    validateMockInstrumentRenderParameters(job.parameters);
    return job;
  }

  if (
    job.taskId !== MOCK_HUM_TO_MIDI_TASK_ID ||
    job.inputArtifacts.length !== 1 ||
    job.inputArtifacts[0]?.kind !== 'audio' ||
    typeof job.inputArtifacts[0]?.path !== 'string' ||
    job.output.kind !== 'midi'
  ) {
    throw createMockProviderValidationError(
      'MOCK_JOB_ARTIFACTS_INVALID',
      'Mock Hum-to-MIDI requires one path-backed audio input and one inline MIDI output.',
    );
  }

  validateMockHumToMidiParameters(job.parameters);

  return job;
}

export function validateMockProviderParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createMockProviderValidationError(
      'MOCK_JOB_PARAMETERS_INVALID',
      'Mock audio parameters must be an object.',
    );
  }

  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== 4 ||
    parameterKeys[0] !== 'durationSeconds' ||
    parameterKeys[1] !== 'frequencyHz' ||
    parameterKeys[2] !== 'sampleRate' ||
    parameterKeys[3] !== 'seed'
  ) {
    throw createMockProviderValidationError(
      'MOCK_JOB_PARAMETERS_INVALID',
      'Mock audio parameters must contain durationSeconds, frequencyHz, sampleRate, and seed.',
    );
  }

  const { durationSeconds, frequencyHz, sampleRate, seed } = parameters;

  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < 0.05 ||
    durationSeconds > 5
  ) {
    throw createMockProviderValidationError(
      'MOCK_JOB_PARAMETERS_INVALID',
      'Mock audio durationSeconds must be from 0.05 through 5.',
    );
  }

  if (
    typeof sampleRate !== 'number' ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 48_000
  ) {
    throw createMockProviderValidationError(
      'MOCK_JOB_PARAMETERS_INVALID',
      'Mock audio sampleRate must be an integer from 8000 through 48000.',
    );
  }

  if (
    typeof frequencyHz !== 'number' ||
    !Number.isFinite(frequencyHz) ||
    frequencyHz < 20 ||
    frequencyHz >= sampleRate / 2
  ) {
    throw createMockProviderValidationError(
      'MOCK_JOB_PARAMETERS_INVALID',
      'Mock audio frequencyHz must be at least 20 and below the Nyquist frequency.',
    );
  }

  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw createMockProviderValidationError(
      'MOCK_JOB_PARAMETERS_INVALID',
      'Mock audio seed must be a non-negative integer.',
    );
  }

  return Object.freeze({ durationSeconds, frequencyHz, sampleRate, seed });
}

export function validateMockHumToMidiParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createMockProviderValidationError(
      'MOCK_HUM_TO_MIDI_PARAMETERS_INVALID',
      'Mock Hum-to-MIDI parameters must be an object.',
    );
  }

  const parameterKeys = Object.keys(parameters).sort();

  if (
    parameterKeys.length !== 5 ||
    parameterKeys[0] !== 'projectBpm' ||
    parameterKeys[1] !== 'seed' ||
    parameterKeys[2] !== 'sourceEndSeconds' ||
    parameterKeys[3] !== 'sourceStartSeconds' ||
    parameterKeys[4] !== 'ticksPerQuarter'
  ) {
    throw createMockProviderValidationError(
      'MOCK_HUM_TO_MIDI_PARAMETERS_INVALID',
      'Mock Hum-to-MIDI parameters must contain projectBpm, seed, sourceEndSeconds, sourceStartSeconds, and ticksPerQuarter.',
    );
  }

  const {
    projectBpm,
    seed,
    sourceEndSeconds,
    sourceStartSeconds,
    ticksPerQuarter,
  } = parameters;

  if (
    typeof projectBpm !== 'number' ||
    !Number.isFinite(projectBpm) ||
    projectBpm < 40 ||
    projectBpm > 240
  ) {
    throw createMockProviderValidationError(
      'MOCK_HUM_TO_MIDI_PARAMETERS_INVALID',
      'Mock Hum-to-MIDI projectBpm must be from 40 through 240.',
    );
  }

  if (
    typeof sourceStartSeconds !== 'number' ||
    !Number.isFinite(sourceStartSeconds) ||
    sourceStartSeconds < 0 ||
    typeof sourceEndSeconds !== 'number' ||
    !Number.isFinite(sourceEndSeconds) ||
    sourceEndSeconds <= sourceStartSeconds
  ) {
    throw createMockProviderValidationError(
      'MOCK_HUM_TO_MIDI_PARAMETERS_INVALID',
      'Mock Hum-to-MIDI source range must be finite, non-negative, and increasing.',
    );
  }

  if (ticksPerQuarter !== MOCK_HUM_TO_MIDI_TICKS_PER_QUARTER) {
    throw createMockProviderValidationError(
      'MOCK_HUM_TO_MIDI_PARAMETERS_INVALID',
      `Mock Hum-to-MIDI ticksPerQuarter must be ${MOCK_HUM_TO_MIDI_TICKS_PER_QUARTER}.`,
    );
  }

  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw createMockProviderValidationError(
      'MOCK_HUM_TO_MIDI_PARAMETERS_INVALID',
      'Mock Hum-to-MIDI seed must be a non-negative integer.',
    );
  }

  return Object.freeze({
    projectBpm,
    seed,
    sourceEndSeconds,
    sourceStartSeconds,
    ticksPerQuarter,
  });
}

export function validateMockInstrumentRenderParameters(parameters) {
  if (!isRecord(parameters)) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render parameters must be an object.',
    );
  }

  const parameterKeys = Object.keys(parameters).sort();
  const isLegacyParameterSet =
    parameterKeys.length === 5 &&
    parameterKeys[0] === 'channels' &&
    parameterKeys[1] === 'gainDb' &&
    parameterKeys[2] === 'preset' &&
    parameterKeys[3] === 'providerVersion' &&
    parameterKeys[4] === 'sampleRate';
  const isCurrentParameterSet =
    parameterKeys.length === 7 &&
    parameterKeys[0] === 'channels' &&
    parameterKeys[1] === 'gainDb' &&
    parameterKeys[2] === 'preset' &&
    parameterKeys[3] === 'providerVersion' &&
    parameterKeys[4] === 'sampleRate' &&
    parameterKeys[5] === 'sourceMidiContentHash' &&
    parameterKeys[6] === 'sourceMidiRevision';

  if (!isLegacyParameterSet && !isCurrentParameterSet) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render parameters must contain channels, gainDb, preset, providerVersion, sampleRate, sourceMidiContentHash, and sourceMidiRevision.',
    );
  }

  const {
    channels,
    gainDb,
    preset,
    providerVersion,
    sampleRate,
    sourceMidiContentHash,
    sourceMidiRevision,
  } = parameters;

  if (channels !== 2) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render channels must be 2.',
    );
  }

  if (
    typeof gainDb !== 'number' ||
    !Number.isFinite(gainDb) ||
    gainDb < -60 ||
    gainDb > 12
  ) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render gainDb must be from -60 through 12.',
    );
  }

  if (
    !isRecord(preset) ||
    Object.keys(preset).sort().join(',') !== 'bank,program' ||
    !Number.isSafeInteger(preset.bank) ||
    preset.bank < 0 ||
    preset.bank > 16_383 ||
    !Number.isSafeInteger(preset.program) ||
    preset.program < 0 ||
    preset.program > 127
  ) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render preset requires bank 0-16383 and program 0-127.',
    );
  }

  if (providerVersion !== MOCK_INSTRUMENT_RENDER_PROVIDER_VERSION) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      `Mock Instrument Render Provider version must be ${MOCK_INSTRUMENT_RENDER_PROVIDER_VERSION}.`,
    );
  }

  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 48_000
  ) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render sampleRate must be an integer from 8000 through 48000.',
    );
  }

  if (
    isCurrentParameterSet &&
    (
      typeof sourceMidiContentHash !== 'string' ||
      !/^fnv1a64-[0-9a-f]{16}$/.test(sourceMidiContentHash) ||
      !Number.isSafeInteger(sourceMidiRevision) ||
      sourceMidiRevision < 1
    )
  ) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_PARAMETERS_INVALID',
      'Mock Instrument Render source MIDI identity is invalid.',
    );
  }

  const normalized = {
    channels: 2,
    gainDb,
    preset: Object.freeze({
      bank: preset.bank,
      program: preset.program,
    }),
    providerVersion,
    sampleRate,
  };

  return Object.freeze(
    isCurrentParameterSet
      ? {
          ...normalized,
          sourceMidiContentHash,
          sourceMidiRevision,
        }
      : normalized,
  );
}

export function validateMockInstrumentRenderMidi(midi) {
  if (
    !isRecord(midi) ||
    Object.keys(midi).sort().join(',') !== 'bpm,notes,ticksPerQuarter' ||
    typeof midi.bpm !== 'number' ||
    !Number.isFinite(midi.bpm) ||
    midi.bpm < 40 ||
    midi.bpm > 240 ||
    midi.ticksPerQuarter !== MOCK_HUM_TO_MIDI_TICKS_PER_QUARTER ||
    !Array.isArray(midi.notes) ||
    midi.notes.length === 0 ||
    midi.notes.length > 256
  ) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_MIDI_INVALID',
      'Mock Instrument Render MIDI must contain BPM 40-240, TPQ 960, and 1-256 notes.',
    );
  }

  const noteIds = new Set();
  const notes = [];
  let maximumEndTick = 0;
  let totalNoteTicks = 0;
  let previousSortKey;

  for (const [index, note] of midi.notes.entries()) {
    if (
      !isRecord(note) ||
      typeof note.id !== 'string' ||
      note.id.length === 0 ||
      note.id.trim() !== note.id ||
      noteIds.has(note.id) ||
      !Number.isInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isSafeInteger(note.startTick) ||
      note.startTick < 0 ||
      !Number.isSafeInteger(note.lengthTicks) ||
      note.lengthTicks <= 0 ||
      !Number.isSafeInteger(note.startTick + note.lengthTicks) ||
      !Number.isInteger(note.velocity) ||
      note.velocity < 1 ||
      note.velocity > 127 ||
      (note.confidence !== undefined &&
        (typeof note.confidence !== 'number' ||
          !Number.isFinite(note.confidence) ||
          note.confidence < 0 ||
          note.confidence > 1))
    ) {
      throw createMockProviderValidationError(
        'MOCK_INSTRUMENT_RENDER_MIDI_INVALID',
        `Mock Instrument Render MIDI note at index ${index} is invalid.`,
      );
    }

    const sortKey = `${String(note.startTick).padStart(16, '0')}:${String(note.pitch).padStart(
      3,
      '0',
    )}:${note.id}`;

    if (previousSortKey !== undefined && sortKey.localeCompare(previousSortKey) < 0) {
      throw createMockProviderValidationError(
        'MOCK_INSTRUMENT_RENDER_MIDI_INVALID',
        'Mock Instrument Render MIDI notes must use deterministic order.',
      );
    }

    const endTick = note.startTick + note.lengthTicks;
    noteIds.add(note.id);
    notes.push(
      Object.freeze({
        ...(note.confidence === undefined ? {} : { confidence: note.confidence }),
        id: note.id,
        lengthTicks: note.lengthTicks,
        pitch: note.pitch,
        startTick: note.startTick,
        velocity: note.velocity,
      }),
    );
    maximumEndTick = Math.max(maximumEndTick, endTick);
    totalNoteTicks += note.lengthTicks;
    previousSortKey = sortKey;
  }

  const secondsPerTick = 60 / (midi.bpm * midi.ticksPerQuarter);
  const durationSeconds = maximumEndTick * secondsPerTick;
  const totalNoteSeconds = totalNoteTicks * secondsPerTick;

  if (
    durationSeconds > MOCK_INSTRUMENT_RENDER_MAX_DURATION_SECONDS ||
    totalNoteSeconds > MOCK_INSTRUMENT_RENDER_MAX_NOTE_SECONDS
  ) {
    throw createMockProviderValidationError(
      'MOCK_INSTRUMENT_RENDER_MIDI_INVALID',
      `Mock Instrument Render MIDI exceeds ${MOCK_INSTRUMENT_RENDER_MAX_DURATION_SECONDS} seconds or the supported polyphony budget.`,
    );
  }

  return Object.freeze({
    bpm: midi.bpm,
    notes: Object.freeze(notes),
    ticksPerQuarter: midi.ticksPerQuarter,
  });
}

function createMockProviderValidationError(code, message) {
  const error = new ProviderContractValidationError(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
