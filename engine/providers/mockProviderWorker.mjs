import { lstat, open } from 'node:fs/promises';

import { PROVIDER_WORKER_PROTOCOL_VERSION } from './providerContract.mjs';
import {
  MOCK_HUM_TO_MIDI_TASK_ID,
  MOCK_INSTRUMENT_RENDER_TASK_ID,
  MOCK_PROVIDER_DESCRIPTOR,
  validateMockProviderJob,
} from './mockProviderDefinition.mjs';

let activeRequestId;
let loadedModel;

process.on('message', (message) => {
  void handleMessage(message);
});

process.on('disconnect', () => {
  process.exit(0);
});

async function handleMessage(message) {
  const requestId = readRequestId(message);

  if (!requestId) {
    return;
  }

  if (activeRequestId) {
    sendFailure(requestId, 'WORKER_BUSY', `Mock Provider Worker is busy with ${activeRequestId}.`);
    return;
  }

  activeRequestId = requestId;

  try {
    const operation = readOperation(message);

    if (operation === 'inspect') {
      sendSuccess(requestId, MOCK_PROVIDER_DESCRIPTOR);
    } else if (operation === 'load-model') {
      sendSuccess(requestId, loadModel(message.payload));
    } else if (operation === 'unload-model') {
      sendSuccess(requestId, unloadModel());
    } else if (operation === 'execute') {
      const result = await executeJob(message.payload);
      sendProgress(requestId, {
        accuracy: 'MEASURED',
        currentStep: 1,
        percent: 100,
        totalSteps: 1,
      });
      sendSuccess(requestId, result);
    } else if (operation === 'shutdown') {
      loadedModel = undefined;
      sendSuccess(requestId, Object.freeze({ status: 'SHUTDOWN' }), () => {
        process.disconnect();
      });
    } else {
      sendFailure(requestId, 'WORKER_OPERATION_UNSUPPORTED', 'Worker operation is not supported.');
    }
  } catch (error) {
    sendFailure(
      requestId,
      readErrorCode(error),
      error instanceof Error ? error.message : 'Mock Provider Worker operation failed.',
    );
  } finally {
    activeRequestId = undefined;
  }
}

function loadModel(payload) {
  const model = isRecord(payload)
    ? MOCK_PROVIDER_DESCRIPTOR.models.find(
        (candidate) =>
          candidate.modelId === payload.modelId &&
          candidate.revision === payload.revision &&
          candidate.compatibility !== 'INCOMPATIBLE',
      )
    : undefined;

  if (!model) {
    throw createWorkerError(
      'MODEL_INCOMPATIBLE',
      'Mock Provider cannot load the requested Model or revision.',
    );
  }

  loadedModel = Object.freeze({
    loadedAt: new Date().toISOString(),
    modelId: model.modelId,
    revision: model.revision,
    status: 'LOADED',
  });
  return loadedModel;
}

function unloadModel() {
  const previousModel = loadedModel;
  loadedModel = undefined;

  return Object.freeze({
    ...(previousModel
      ? { modelId: previousModel.modelId, revision: previousModel.revision }
      : {}),
    status: 'UNLOADED',
    unloadedAt: new Date().toISOString(),
  });
}

async function executeJob(payload) {
  const job = validateMockProviderJob(payload);

  if (
    !loadedModel ||
    loadedModel.modelId !== job.modelId ||
    loadedModel.revision !== job.modelRevision
  ) {
    throw createWorkerError('MODEL_NOT_LOADED', 'Load the requested Mock Model before execution.');
  }

  if (job.taskId === MOCK_HUM_TO_MIDI_TASK_ID) {
    return executeHumToMidiJob(job);
  }

  return job.taskId === MOCK_INSTRUMENT_RENDER_TASK_ID
    ? executeInstrumentRenderJob(job)
    : executeAudioJob(job);
}

async function executeAudioJob(job) {
  const outputBytes = createMockWave(job.parameters);
  await writeStagingOutput(job.output.stagingPath, outputBytes);

  const frameCount = (outputBytes.length - 44) / 2;

  return createCompletedResult(job, {
    artifact: Object.freeze({
      bytesWritten: outputBytes.length,
      channels: 1,
      durationSeconds: frameCount / job.parameters.sampleRate,
      mimeType: 'audio/wav',
      stagingPath: job.output.stagingPath,
    }),
  });
}

async function executeHumToMidiJob(job) {
  await assertReadableWaveInput(job.inputArtifacts[0].path);

  return createCompletedResult(job, {
    artifact: Object.freeze({
      bpm: job.parameters.projectBpm,
      kind: 'midi',
      notes: createMockMidiNotes(job.jobId, job.parameters),
      ticksPerQuarter: job.parameters.ticksPerQuarter,
    }),
  });
}

async function executeInstrumentRenderJob(job) {
  const outputBytes = createMockInstrumentWave(
    job.inputArtifacts[0].midi,
    job.parameters,
  );
  await writeStagingOutput(job.output.stagingPath, outputBytes);

  const frameCount = (outputBytes.length - 44) / (job.parameters.channels * 2);

  return createCompletedResult(job, {
    artifact: Object.freeze({
      bytesWritten: outputBytes.length,
      channels: job.parameters.channels,
      durationSeconds: frameCount / job.parameters.sampleRate,
      mimeType: 'audio/wav',
      stagingPath: job.output.stagingPath,
    }),
  });
}

function createCompletedResult(job, { artifact }) {
  const hasSeed = Object.prototype.hasOwnProperty.call(job.parameters, 'seed');

  return Object.freeze({
    artifact,
    completedAt: new Date().toISOString(),
    jobId: job.jobId,
    metadata: Object.freeze({
      modelId: job.modelId,
      modelRevision: job.modelRevision,
      parameters: job.parameters,
      providerId: MOCK_PROVIDER_DESCRIPTOR.providerId,
      ...(hasSeed ? { seed: job.parameters.seed } : {}),
      taskId: job.taskId,
    }),
    status: 'COMPLETED',
  });
}

async function assertReadableWaveInput(inputPath) {
  const inputStat = await lstat(inputPath);

  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size <= 44) {
    throw createWorkerError(
      'MOCK_HUM_TO_MIDI_INPUT_INVALID',
      'Mock Hum-to-MIDI input must be a non-empty regular WAV file.',
    );
  }

  const inputHandle = await open(inputPath, 'r');
  const header = Buffer.alloc(12);

  try {
    const { bytesRead } = await inputHandle.read(header, 0, header.length, 0);

    if (
      bytesRead !== header.length ||
      header.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      header.subarray(8, 12).toString('ascii') !== 'WAVE'
    ) {
      throw createWorkerError(
        'MOCK_HUM_TO_MIDI_INPUT_INVALID',
        'Mock Hum-to-MIDI input must contain a RIFF/WAVE header.',
      );
    }
  } finally {
    await inputHandle.close();
  }
}

function createMockMidiNotes(jobId, parameters) {
  const sourceDurationSeconds =
    parameters.sourceEndSeconds - parameters.sourceStartSeconds;
  const sourceLengthTicks = Math.max(
    1,
    Math.round(
      sourceDurationSeconds *
        (parameters.projectBpm / 60) *
        parameters.ticksPerQuarter,
    ),
  );
  const noteStepTicks = parameters.ticksPerQuarter;
  const noteCount = Math.min(8, Math.max(1, Math.ceil(sourceLengthTicks / noteStepTicks)));
  const pitchPattern = [60, 62, 64, 67];
  const pitchOffset = parameters.seed % 12;
  const notes = [];

  for (let index = 0; index < noteCount; index += 1) {
    const startTick = index * noteStepTicks;
    const remainingTicks = sourceLengthTicks - startTick;

    if (remainingTicks <= 0) {
      break;
    }

    notes.push(
      Object.freeze({
        confidence: Math.max(0.7, 0.96 - index * 0.03),
        id: `note-${jobId}-${index + 1}`,
        lengthTicks: Math.max(1, Math.min(noteStepTicks, remainingTicks)),
        pitch: pitchPattern[index % pitchPattern.length] + pitchOffset,
        startTick,
        velocity: 80 + ((parameters.seed + index * 7) % 32),
      }),
    );
  }

  return Object.freeze(notes);
}

async function writeStagingOutput(stagingPath, outputBytes) {
  const stagingStat = await lstat(stagingPath);

  if (!stagingStat.isFile() || stagingStat.isSymbolicLink() || stagingStat.size !== 0) {
    throw createWorkerError(
      'STAGING_OUTPUT_INVALID',
      'Mock Provider output must be an empty regular staging file.',
    );
  }

  const stagingHandle = await open(stagingPath, 'r+');

  try {
    await stagingHandle.writeFile(outputBytes);
    await stagingHandle.sync();
  } catch (error) {
    await stagingHandle.truncate(0).catch(() => undefined);
    throw error;
  } finally {
    await stagingHandle.close();
  }
}

function createMockWave({ durationSeconds, frequencyHz, sampleRate, seed }) {
  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataSize = frameCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  const phaseOffset = (seed % 360) * (Math.PI / 180);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.sin((2 * Math.PI * frequencyHz * frame) / sampleRate + phaseOffset);
    buffer.writeInt16LE(Math.round(sample * 0.2 * 32_767), 44 + frame * 2);
  }

  return buffer;
}

function createMockInstrumentWave(midi, parameters) {
  const secondsPerTick = 60 / (midi.bpm * midi.ticksPerQuarter);
  const maximumEndTick = midi.notes.reduce(
    (maximum, note) => Math.max(maximum, note.startTick + note.lengthTicks),
    0,
  );
  const releaseTailSeconds = 0.1;
  const durationSeconds = maximumEndTick * secondsPerTick + releaseTailSeconds;
  const frameCount = Math.max(1, Math.ceil(durationSeconds * parameters.sampleRate));
  const samples = new Float32Array(frameCount);
  const presetPhase =
    ((parameters.preset.bank * 128 + parameters.preset.program) % 360) *
    (Math.PI / 180);

  for (const note of midi.notes) {
    const startFrame = Math.max(
      0,
      Math.floor(note.startTick * secondsPerTick * parameters.sampleRate),
    );
    const endFrame = Math.min(
      frameCount,
      Math.ceil(
        (note.startTick + note.lengthTicks) *
          secondsPerTick *
          parameters.sampleRate,
      ),
    );
    const noteFrameCount = Math.max(1, endFrame - startFrame);
    const envelopeFrames = Math.max(
      1,
      Math.min(
        Math.floor(parameters.sampleRate * 0.005),
        Math.floor(noteFrameCount / 4),
      ),
    );
    const frequencyHz = 440 * 2 ** ((note.pitch - 69) / 12);
    const amplitude = 0.12 * (note.velocity / 127);

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const noteFrame = frame - startFrame;
      const attack = Math.min(1, noteFrame / envelopeFrames);
      const release = Math.min(1, (endFrame - frame - 1) / envelopeFrames);
      const envelope = Math.max(0, Math.min(attack, release));
      samples[frame] +=
        Math.sin(
          (2 * Math.PI * frequencyHz * noteFrame) / parameters.sampleRate +
            presetPhase,
        ) *
        amplitude *
        envelope;
    }
  }

  const bytesPerFrame = parameters.channels * 2;
  const dataSize = frameCount * bytesPerFrame;
  const buffer = Buffer.alloc(44 + dataSize);
  const gain = 10 ** (parameters.gainDb / 20);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(parameters.channels, 22);
  buffer.writeUInt32LE(parameters.sampleRate, 24);
  buffer.writeUInt32LE(parameters.sampleRate * bytesPerFrame, 28);
  buffer.writeUInt16LE(bytesPerFrame, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const normalizedSample = Math.max(-1, Math.min(1, samples[frame] * gain));
    const pcmSample = Math.round(normalizedSample * 32_767);
    const frameOffset = 44 + frame * bytesPerFrame;

    for (let channel = 0; channel < parameters.channels; channel += 1) {
      buffer.writeInt16LE(pcmSample, frameOffset + channel * 2);
    }
  }

  return buffer;
}

function readRequestId(message) {
  if (
    !isRecord(message) ||
    message.protocolVersion !== PROVIDER_WORKER_PROTOCOL_VERSION ||
    typeof message.requestId !== 'string' ||
    message.requestId.length === 0
  ) {
    return undefined;
  }

  return message.requestId;
}

function readOperation(message) {
  return isRecord(message) && typeof message.operation === 'string' ? message.operation : undefined;
}

function sendSuccess(requestId, result, callback) {
  if (!process.connected) {
    callback?.();
    return;
  }

  process.send?.(
    {
      ok: true,
      protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
      requestId,
      result,
    },
    callback,
  );
}

function sendFailure(requestId, code, message) {
  if (!process.connected) {
    return;
  }

  process.send?.({
    error: { code, message },
    ok: false,
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    requestId,
  });
}

function sendProgress(requestId, progress) {
  if (!process.connected) {
    return;
  }

  process.send?.({
    event: 'progress',
    progress,
    protocolVersion: PROVIDER_WORKER_PROTOCOL_VERSION,
    requestId,
  });
}

function createWorkerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readErrorCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'WORKER_OPERATION_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
