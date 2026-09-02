import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { GeneratedArtifactFinalizer } from '../engine/generatedArtifactFinalizer.mjs';
import { AceStepJobExecutor } from '../engine/jobs/aceStepJobExecutor.mjs';
import { GpuJobQueue } from '../engine/jobs/gpuJobQueue.mjs';
import { ProjectRootAuthority, resolveProjectPath } from '../engine/projectRootAuthority.mjs';
import {
  ACE_STEP_MODEL_ID,
  ACE_STEP_PROVIDER_ID,
  ACE_STEP_TASK_ID,
} from '../engine/providers/aceStepProviderDefinition.mjs';
import {
  ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
  ACE_STEP_PROVIDER_CODE_REVISION,
  ACE_STEP_PROVIDER_REPOSITORY,
  ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
  ACE_STEP_SUPPORT_MODEL_REVISION,
} from '../engine/providers/aceStepRuntimeProfile.mjs';
import { AceStepPythonHostClient } from '../engine/providers/aceStepPythonHostClient.mjs';
import {
  ACE_STEP_CHANNELS,
  ACE_STEP_MODEL_REVISION,
  ACE_STEP_OUTPUT_DESTINATION,
  ACE_STEP_RUNTIME_PROFILE_ID,
  ACE_STEP_SAMPLE_RATE,
} from '../shared/aceStepProtocol.js';
import {
  ACE_STEP_LEGO_PROBE_DURATION_SECONDS,
  writeAceStepLegoProbeFixture,
} from './Generate-AceStepLegoProbeFixture.mjs';

export const ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS =
  'ACE_STEP_CANCELLATION_RECOVERY_VERIFIED';
export const ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS =
  'ACE_STEP_CANCELLATION_RECOVERY_FAILED';
export const ACE_STEP_CANCELLATION_ACCEPTANCE_REPORT_NAME =
  'ace-step-cancellation-acceptance.json';
export const ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_REPORT_NAME =
  'ace-step-cancellation-acceptance-failure.json';

const GUIDE_ARTIFACT_ID = 'artifact-ace-cancellation-guide';
const LYRICS_ARTIFACT_ID = 'artifact-ace-cancellation-lyrics';
const MIDI_CLIP_TAKE_ID = 'clip-take-ace-cancellation-midi';
const GUIDE_RELATIVE_PATH =
  'renders/instruments/ace-cancellation-guide.wav';
const LYRICS_RELATIVE_PATH =
  'renders/ace-step/lyrics/ace-cancellation-lyrics.txt';
const UNRELATED_RELATIVE_PATH = 'recordings/ace-cancellation-unrelated.keep';
const UNRELATED_BYTES = Buffer.from('HumStudio ACE cancellation sentinel\n', 'utf8');
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_ACTIVE_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_CANCELLATION_TIMEOUT_MS = 2 * 60 * 1_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const REPORT_VERSION = 1;

export class AceStepCancellationAcceptanceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = 'AceStepCancellationAcceptanceError';
  }
}

export async function runAceStepCancellationAcceptance(
  args,
  options = {},
) {
  const dependencies = createDependencies(options);
  const paths = await validateAcceptanceArguments(args);
  const startedAtUtc = dependencies.nowIso();
  const startedAtMs = dependencies.monotonicNow();
  const cancellationTimeline = [];
  const recoveryTimeline = [];
  const reportPath = join(
    paths.evidenceDirectory,
    ACE_STEP_CANCELLATION_ACCEPTANCE_REPORT_NAME,
  );
  const failureReportPath = join(
    paths.evidenceDirectory,
    ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_REPORT_NAME,
  );
  const previousPythonPath =
    process.env[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE];
  const previousCheckpointsRoot =
    process.env[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE];
  let evidenceCreated = false;
  let runtime;
  let runtimeShutdown = false;
  let preflight;
  let execution;
  let primaryError;

  process.env[ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE] = paths.pythonPath;
  process.env[ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE] =
    paths.checkpointsRootPath;

  try {
    preflight = await dependencies.preflightRuntime(paths);
    validatePreflight(preflight);
    await mkdir(paths.evidenceDirectory, { recursive: false });
    evidenceCreated = true;

    const projectRootPath = join(paths.evidenceDirectory, 'project');
    await mkdir(projectRootPath, { recursive: false });
    const projectRootAuthority = new ProjectRootAuthority();
    await projectRootAuthority.configure(projectRootPath);
    const fixture = await dependencies.writeFixture(
      join(paths.evidenceDirectory, 'fixture'),
    );
    await installFixture(projectRootPath, fixture);
    await writeFile(
      resolveProjectPath(projectRootPath, UNRELATED_RELATIVE_PATH),
      UNRELATED_BYTES,
      { flag: 'wx' },
    );

    const finalizer = new GeneratedArtifactFinalizer({
      projectRootAuthority,
    });
    runtime = await dependencies.createRuntime({
      finalizer,
      projectRootAuthority,
      projectRootPath,
    });
    validateRuntime(runtime);

    execution = await executeCancellationAndRecovery({
      cancellationTimeline,
      dependencies,
      finalizer,
      fixture,
      projectRootPath,
      queue: runtime.queue,
      recoveryTimeline,
      startedAtMs,
    });
  } catch (error) {
    primaryError = error;
  }

  let shutdownError;

  if (runtime) {
    try {
      await withTimeout(
        runtime.queue.shutdown(),
        dependencies.shutdownTimeoutMs,
        'ACE_STEP_ACCEPTANCE_SHUTDOWN_TIMEOUT',
        'ACE-Step acceptance runtime did not terminate in time.',
      );
      runtimeShutdown = true;
    } catch (error) {
      shutdownError = error;
    }
  }

  try {
    const elapsedMilliseconds = roundedElapsed(
      dependencies.monotonicNow() - startedAtMs,
    );
    const completedAtUtc = dependencies.nowIso();

    if (primaryError || shutdownError || !execution) {
      const failure = combineFailure(primaryError, shutdownError);

      if (evidenceCreated) {
        await writeJsonEvidence(failureReportPath, {
          cancellation: { stateTimeline: cancellationTimeline },
          elapsedMilliseconds,
          error: publicError(failure),
          failedAtUtc: completedAtUtc,
          formatVersion: REPORT_VERSION,
          recovery: { stateTimeline: recoveryTimeline },
          runtime: createRuntimeIdentity(paths, preflight),
          startedAtUtc,
          status: ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
          termination: { completed: runtimeShutdown },
        });
      }

      throw failure;
    }

    if (!runtimeShutdown) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_TERMINATION_UNVERIFIED',
        'ACE-Step acceptance runtime termination was not verified.',
      );
    }

    const report = Object.freeze({
      cancellation: execution.cancellation,
      cleanup: execution.cleanup,
      completedAtUtc,
      elapsedMilliseconds,
      fixture: execution.fixture,
      formatVersion: REPORT_VERSION,
      recovery: execution.recovery,
      runtime: createRuntimeIdentity(paths, preflight),
      startedAtUtc,
      status: ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS,
      termination: Object.freeze({ completed: true }),
    });

    await writeJsonEvidence(reportPath, report);
    await verifyUtf8JsonReport(reportPath, ACE_STEP_CANCELLATION_ACCEPTANCE_STATUS);
    return Object.freeze({ report, reportPath });
  } finally {
    restoreEnvironmentVariable(
      ACE_STEP_PYTHON_ENVIRONMENT_VARIABLE,
      previousPythonPath,
    );
    restoreEnvironmentVariable(
      ACE_STEP_CHECKPOINTS_ROOT_ENVIRONMENT_VARIABLE,
      previousCheckpointsRoot,
    );
  }
}

export async function runAceStepCancellationAcceptanceCli(
  args,
  {
    runAcceptance = runAceStepCancellationAcceptance,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  try {
    const result = await runAcceptance(args);
    writeOutput(`${JSON.stringify(result.report, null, 2)}\n`);
    return 0;
  } catch (error) {
    writeOutput(
      `${JSON.stringify(
        {
          error: publicError(error),
          status: ACE_STEP_CANCELLATION_ACCEPTANCE_FAILURE_STATUS,
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

export async function validateAcceptanceArguments(args) {
  if (!Array.isArray(args) || args.length !== 3) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_CLI_USAGE_INVALID',
      'Pass exactly three absolute paths: Python, Checkpoints Root, and a new evidence directory.',
    );
  }

  for (const value of args) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value ||
      !isAbsolute(value)
    ) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_CLI_USAGE_INVALID',
        'Pass exactly three absolute paths: Python, Checkpoints Root, and a new evidence directory.',
      );
    }
  }

  const [pythonValue, checkpointsValue, evidenceValue] = args;
  const pythonPath = await requireRegularFile(
    pythonValue,
    'ACE_STEP_ACCEPTANCE_PYTHON_UNAVAILABLE',
    'Pinned ACE-Step Python is unavailable.',
  );
  const checkpointsRootPath = await requireDirectory(
    checkpointsValue,
    'ACE_STEP_ACCEPTANCE_CHECKPOINTS_UNAVAILABLE',
    'Pinned ACE-Step Checkpoints Root is unavailable.',
  );

  if (
    basename(pythonPath).toLowerCase() !== 'python.exe' ||
    basename(dirname(dirname(pythonPath))) !== ACE_STEP_PROVIDER_CODE_REVISION ||
    basename(checkpointsRootPath) !== ACE_STEP_SUPPORT_MODEL_REVISION
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_IDENTITY_MISMATCH',
      'ACE-Step Runtime or Model path does not match the pinned identity.',
    );
  }

  await requirePathMissing(evidenceValue);
  const evidenceParent = await requireDirectory(
    dirname(evidenceValue),
    'ACE_STEP_ACCEPTANCE_EVIDENCE_PARENT_UNAVAILABLE',
    'ACE-Step evidence parent directory is unavailable.',
  );
  const evidenceDirectory = join(evidenceParent, basename(resolve(evidenceValue)));

  if (
    isPathWithin(dirname(dirname(pythonPath)), evidenceDirectory) ||
    isPathWithin(checkpointsRootPath, evidenceDirectory)
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_EVIDENCE_PATH_INVALID',
      'ACE-Step evidence must not be created inside Runtime or Model directories.',
    );
  }

  return Object.freeze({
    checkpointsRootPath,
    evidenceDirectory,
    pythonPath,
  });
}

async function executeCancellationAndRecovery({
  cancellationTimeline,
  dependencies,
  finalizer,
  fixture,
  projectRootPath,
  queue,
  recoveryTimeline,
  startedAtMs,
}) {
  const request = createAcceptanceRequest(fixture.manifest.guideSizeBytes);
  const canceledJob = queue.enqueue(request);
  assertExactJob(canceledJob, canceledJob.jobId, 'QUEUED');
  recordJobState(cancellationTimeline, canceledJob, dependencies, startedAtMs);

  const activeJob = await waitForExactJob(
    queue,
    canceledJob.jobId,
    (job) => job.state === 'PROCESSING',
    {
      dependencies,
      label: 'ACE-Step cancellation target',
      timeline: cancellationTimeline,
      timeoutMs: dependencies.activeTimeoutMs,
      startedAtMs,
    },
  );
  assertExactJob(activeJob, canceledJob.jobId, 'PROCESSING');
  const requestedFromState = activeJob.state;

  const cancellationSettlement = Promise.resolve(
    queue.requestCancel(canceledJob.jobId),
  ).then(
    (value) => Object.freeze({ ok: true, value }),
    (error) => Object.freeze({ error, ok: false }),
  );
  const cancellationPending = queue.getJob(canceledJob.jobId);
  assertExactJob(
    cancellationPending,
    canceledJob.jobId,
    'CANCEL_REQUESTED',
  );
  recordJobState(
    cancellationTimeline,
    cancellationPending,
    dependencies,
    startedAtMs,
  );
  const repeatedCancellation = await queue.requestCancel(canceledJob.jobId);
  assertExactJob(
    repeatedCancellation,
    canceledJob.jobId,
    'CANCEL_REQUESTED',
  );
  const cancellation = await withTimeout(
    cancellationSettlement,
    dependencies.cancellationTimeoutMs,
    'ACE_STEP_ACCEPTANCE_CANCELLATION_TIMEOUT',
    'ACE-Step cancellation did not settle in time.',
  );

  if (!cancellation.ok) throw cancellation.error;

  const terminalCanceledJob = await waitForExactJob(
    queue,
    canceledJob.jobId,
    (job) => isTerminalJobState(job.state),
    {
      dependencies,
      label: 'ACE-Step canceled Job',
      timeline: cancellationTimeline,
      timeoutMs: dependencies.cancellationTimeoutMs,
      startedAtMs,
    },
  );
  assertExactJob(terminalCanceledJob, canceledJob.jobId, 'CANCELED');
  await withTimeout(
    queue.waitForIdle(),
    dependencies.cancellationTimeoutMs,
    'ACE_STEP_ACCEPTANCE_QUEUE_IDLE_TIMEOUT',
    'ACE-Step Queue did not become idle after cancellation.',
  );

  const cleanup = await inspectCancellationCleanup({
    finalizer,
    projectRootPath,
    queue,
  });

  const recoveryJob = queue.enqueue(request);

  if (recoveryJob.jobId === canceledJob.jobId) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_JOB_ID_REUSED',
      'ACE-Step recovery Job reused the canceled Job identity.',
    );
  }

  recordJobState(recoveryTimeline, recoveryJob, dependencies, startedAtMs);
  const terminalRecoveryJob = await waitForExactJob(
    queue,
    recoveryJob.jobId,
    (job) => isTerminalJobState(job.state),
    {
      dependencies,
      label: 'ACE-Step recovery Job',
      timeline: recoveryTimeline,
      timeoutMs: dependencies.recoveryTimeoutMs,
      startedAtMs,
    },
  );
  assertExactJob(terminalRecoveryJob, recoveryJob.jobId, 'COMPLETED');
  await withTimeout(
    queue.waitForIdle(),
    dependencies.recoveryTimeoutMs,
    'ACE_STEP_ACCEPTANCE_RECOVERY_IDLE_TIMEOUT',
    'ACE-Step Queue did not become idle after recovery generation.',
  );

  const recovery = await inspectRecoveryOutput({
    job: terminalRecoveryJob,
    projectRootPath,
  });

  if (finalizer.getActiveReservationCount() !== 0) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_RESERVATION_RETAINED',
      'ACE-Step recovery retained an Artifact reservation.',
    );
  }

  return Object.freeze({
    cancellation: Object.freeze({
      idempotentRepeatedCancellation: true,
      jobId: canceledJob.jobId,
      requestedFromState,
      stateTimeline: Object.freeze([...cancellationTimeline]),
      terminalState: terminalCanceledJob.state,
    }),
    cleanup,
    fixture: fixture.manifest,
    recovery: Object.freeze({
      ...recovery,
      jobId: recoveryJob.jobId,
      stateTimeline: Object.freeze([...recoveryTimeline]),
      terminalState: terminalRecoveryJob.state,
    }),
  });
}

async function inspectCancellationCleanup({
  finalizer,
  projectRootPath,
  queue,
}) {
  const files = await listRelativeFiles(projectRootPath);
  const outputFiles = files.filter(isFinalAceWave);
  const partialFiles = files.filter((path) =>
    path.toLowerCase().includes('.partial'),
  );
  const sentinel = await readFile(
    resolveProjectPath(projectRootPath, UNRELATED_RELATIVE_PATH),
  );
  const snapshot = queue.getSnapshot();
  const queueIdle =
    snapshot.activeJobId === undefined &&
    !snapshot.jobs.some((job) => job.state === 'QUEUED');

  if (
    outputFiles.length !== 0 ||
    partialFiles.length !== 0 ||
    finalizer.getActiveReservationCount() !== 0 ||
    !queueIdle ||
    !sentinel.equals(UNRELATED_BYTES)
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_CLEANUP_INVALID',
      'ACE-Step cancellation cleanup evidence is invalid.',
    );
  }

  return Object.freeze({
    finalizedVocalArtifactCount: 0,
    partialOrStagingFileCount: 0,
    queueIdle: true,
    reservationCount: 0,
    unrelatedFilePreserved: true,
  });
}

async function inspectRecoveryOutput({ job, projectRootPath }) {
  const result = job.result;

  if (
    !isRecord(result) ||
    !isRecord(result.artifact) ||
    result.artifact.kind !== 'audio' ||
    result.artifact.destination !== ACE_STEP_OUTPUT_DESTINATION ||
    !isRecord(result.artifact.file) ||
    result.artifact.file.extension !== '.wav' ||
    !isRecord(result.generation) ||
    !isRecord(result.generation.evidence)
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_RECOVERY_RESULT_INVALID',
      'ACE-Step recovery returned invalid finalized metadata.',
    );
  }

  const relativePath = result.artifact.file.relativePath;
  const outputPath = resolveProjectPath(projectRootPath, relativePath);
  const outputBytes = await readFile(outputPath);
  const outputStat = await stat(outputPath);
  const sha256 = createHash('sha256').update(outputBytes).digest('hex');
  const wave = inspectRecoveryWave(outputBytes);
  const outputFiles = (await listRelativeFiles(projectRootPath)).filter(
    isFinalAceWave,
  );

  if (
    outputFiles.length !== 1 ||
    outputFiles[0] !== relativePath.replaceAll('\\', '/') ||
    outputStat.size !== outputBytes.byteLength ||
    result.artifact.file.sizeBytes !== outputBytes.byteLength ||
    result.generation.bytesWritten !== outputBytes.byteLength ||
    result.generation.channels !== ACE_STEP_CHANNELS ||
    result.generation.evidence.sampleRate !== ACE_STEP_SAMPLE_RATE ||
    result.generation.evidence.outputSha256 !== sha256 ||
    result.generation.mimeType !== 'audio/wav'
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_RECOVERY_METADATA_MISMATCH',
      'ACE-Step recovery WAV does not match finalized metadata.',
    );
  }

  return Object.freeze({
    artifactId: result.artifact.artifactId,
    destination: result.artifact.destination,
    file: Object.freeze({
      name: result.artifact.file.name,
      relativePath,
      sizeBytes: outputBytes.byteLength,
    }),
    outputEncoding: result.generation.evidence.outputEncoding,
    sha256,
    wave,
  });
}

export function inspectRecoveryWave(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_WAV_INVALID',
      'ACE-Step recovery output is not a valid WAVE file.',
    );
  }

  let format;
  let dataOffset;
  let dataSize;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > bytes.length) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_WAV_INVALID',
        'ACE-Step recovery WAVE contains an invalid chunk.',
      );
    }

    if (chunkId === 'fmt ' && chunkSize >= 16 && !format) {
      format = Object.freeze({
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
        blockAlign: bytes.readUInt16LE(chunkStart + 12),
        byteRate: bytes.readUInt32LE(chunkStart + 8),
        channels: bytes.readUInt16LE(chunkStart + 2),
        formatTag: bytes.readUInt16LE(chunkStart),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
      });
    } else if (chunkId === 'data' && dataSize === undefined) {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  const supportedEncoding =
    format &&
    ((format.formatTag === 1 && format.bitsPerSample === 16) ||
      (format.formatTag === 3 && format.bitsPerSample === 32));
  const expectedBlockAlign = format
    ? (format.channels * format.bitsPerSample) / 8
    : 0;

  if (
    !format ||
    dataOffset === undefined ||
    dataSize === undefined ||
    !supportedEncoding ||
    format.channels !== ACE_STEP_CHANNELS ||
    format.sampleRate !== ACE_STEP_SAMPLE_RATE ||
    format.blockAlign !== expectedBlockAlign ||
    format.byteRate !== format.sampleRate * format.blockAlign ||
    dataSize === 0 ||
    dataSize % format.blockAlign !== 0
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_WAV_INVALID',
      'ACE-Step recovery WAVE format is invalid.',
    );
  }

  const bytesPerSample = format.bitsPerSample / 8;
  const sampleCount = dataSize / bytesPerSample;
  let nonSilentSamples = 0;
  let peakAbsolute = 0;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sampleOffset = dataOffset + sampleIndex * bytesPerSample;
    const sample =
      format.formatTag === 3
        ? bytes.readFloatLE(sampleOffset)
        : bytes.readInt16LE(sampleOffset) / 32_768;

    if (!Number.isFinite(sample)) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_WAV_NONFINITE',
        'ACE-Step recovery WAVE contains a non-finite sample.',
      );
    }

    const absolute = Math.abs(sample);
    if (absolute > 0) nonSilentSamples += 1;
    if (absolute > peakAbsolute) peakAbsolute = absolute;
  }

  const durationSeconds = dataSize / format.byteRate;

  if (
    nonSilentSamples === 0 ||
    Math.abs(durationSeconds - ACE_STEP_LEGO_PROBE_DURATION_SECONDS) >
      1 / ACE_STEP_SAMPLE_RATE
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_WAV_SILENT_OR_DURATION_INVALID',
      'ACE-Step recovery WAVE must be finite, non-silent, and exactly the requested duration.',
    );
  }

  return Object.freeze({
    bitsPerSample: format.bitsPerSample,
    channels: format.channels,
    durationSeconds,
    formatTag: format.formatTag,
    nonSilentSamples,
    peakAbsolute,
    sampleRate: format.sampleRate,
  });
}

async function preflightProductionRuntime(paths) {
  const client = new AceStepPythonHostClient({
    checkpointsRootPath: paths.checkpointsRootPath,
    pythonPath: paths.pythonPath,
  });

  try {
    return await client.start();
  } finally {
    await client.terminate();
  }
}

function createProductionRuntime({ finalizer, projectRootAuthority }) {
  const executor = new AceStepJobExecutor({
    generatedArtifactFinalizer: finalizer,
    projectRootAuthority,
  });

  return Object.freeze({ queue: new GpuJobQueue({ executor }) });
}

function createAcceptanceRequest(guideSizeBytes) {
  if (!Number.isSafeInteger(guideSizeBytes) || guideSizeBytes <= 44) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_FIXTURE_INVALID',
      'ACE-Step acceptance Guide fixture size evidence is invalid.',
    );
  }

  return Object.freeze({
    guideSource: Object.freeze({
      artifactId: GUIDE_ARTIFACT_ID,
      clipTakeId: MIDI_CLIP_TAKE_ID,
      kind: 'midi-instrument-guide',
    }),
    inputArtifacts: Object.freeze([
      Object.freeze({
        artifactId: GUIDE_ARTIFACT_ID,
        kind: 'audio',
        relativePath: GUIDE_RELATIVE_PATH,
        sizeBytes: guideSizeBytes,
      }),
      Object.freeze({
        artifactId: LYRICS_ARTIFACT_ID,
        kind: 'lyrics',
        relativePath: LYRICS_RELATIVE_PATH,
      }),
    ]),
    lineage: Object.freeze({
      parentArtifactIds: Object.freeze([
        GUIDE_ARTIFACT_ID,
        LYRICS_ARTIFACT_ID,
      ]),
      parentClipTakeIds: Object.freeze([MIDI_CLIP_TAKE_ID]),
    }),
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    output: Object.freeze({
      artifactKind: 'audio',
      destination: ACE_STEP_OUTPUT_DESTINATION,
      extension: '.wav',
    }),
    parameters: Object.freeze({
      audioFormat: 'wav',
      batchSize: 1,
      caption:
        'Solo female lead vocal, clear dry a cappella, no instruments',
      channels: ACE_STEP_CHANNELS,
      durationSeconds: ACE_STEP_LEGO_PROBE_DURATION_SECONDS,
      sampleRate: ACE_STEP_SAMPLE_RATE,
      seed: 1_370_421,
      targetTrack: 'vocals',
      taskType: 'lego',
      thinking: false,
      vocalLanguage: 'en',
    }),
    providerId: ACE_STEP_PROVIDER_ID,
    taskId: ACE_STEP_TASK_ID,
  });
}

async function installFixture(projectRootPath, fixture) {
  await copyFile(
    fixture.guidePath,
    resolveProjectPath(projectRootPath, GUIDE_RELATIVE_PATH),
    fsConstants.COPYFILE_EXCL,
  );
  await copyFile(
    fixture.lyricsPath,
    resolveProjectPath(projectRootPath, LYRICS_RELATIVE_PATH),
    fsConstants.COPYFILE_EXCL,
  );
}

async function waitForExactJob(
  queue,
  jobId,
  predicate,
  { dependencies, label, timeline, timeoutMs, startedAtMs },
) {
  const deadline = dependencies.monotonicNow() + timeoutMs;

  while (true) {
    const job = queue.getJob(jobId);

    if (!job || job.jobId !== jobId) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_JOB_IDENTITY_INVALID',
        `${label} identity changed or disappeared.`,
      );
    }

    recordJobState(timeline, job, dependencies, startedAtMs);

    if (predicate(job)) return job;

    if (isTerminalJobState(job.state)) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_JOB_SETTLED_UNEXPECTEDLY',
        `${label} settled as ${job.state} before the expected state.`,
      );
    }

    if (dependencies.monotonicNow() >= deadline) {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_POLL_TIMEOUT',
        `${label} did not reach the expected state in time.`,
      );
    }

    await dependencies.wait(dependencies.pollIntervalMs);
  }
}

function recordJobState(timeline, job, dependencies, startedAtMs) {
  const last = timeline.at(-1);

  if (last?.state === job.state) return;

  timeline.push(
    Object.freeze({
      elapsedMilliseconds: roundedElapsed(
        dependencies.monotonicNow() - startedAtMs,
      ),
      state: job.state,
    }),
  );
}

function assertExactJob(job, jobId, expectedState) {
  if (
    job?.jobId === jobId &&
    job.state === 'FAILED' &&
    isRecord(job.error)
  ) {
    const failure = publicError(
      Object.assign(new Error(job.error.message), { code: job.error.code }),
    );
    throw acceptanceError(failure.code, failure.message);
  }

  if (!job || job.jobId !== jobId || job.state !== expectedState) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_JOB_STATE_INVALID',
      `ACE-Step Job must be exact ${jobId} in ${expectedState}.`,
    );
  }
}

function isTerminalJobState(state) {
  return ['CANCELED', 'COMPLETED', 'FAILED', 'INTERRUPTED'].includes(state);
}

function validateRuntime(runtime) {
  const queue = runtime?.queue;

  for (const method of [
    'enqueue',
    'getJob',
    'getSnapshot',
    'requestCancel',
    'waitForIdle',
    'shutdown',
  ]) {
    if (typeof queue?.[method] !== 'function') {
      throw acceptanceError(
        'ACE_STEP_ACCEPTANCE_RUNTIME_INVALID',
        'ACE-Step acceptance runtime is invalid.',
      );
    }
  }
}

function validatePreflight(preflight) {
  if (
    preflight?.status !== 'READY' ||
    preflight?.modelId !== ACE_STEP_MODEL_ID ||
    preflight?.modelRevision !== ACE_STEP_MODEL_REVISION ||
    preflight?.profileId !== ACE_STEP_RUNTIME_PROFILE_ID ||
    preflight?.providerCodeRevision !== ACE_STEP_PROVIDER_CODE_REVISION ||
    preflight?.supportModelRevision !== ACE_STEP_SUPPORT_MODEL_REVISION ||
    preflight?.offline !== true
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_PREFLIGHT_MISMATCH',
      'ACE-Step production Provider preflight does not match the pinned identity.',
    );
  }
}

function createRuntimeIdentity(paths, preflight) {
  return Object.freeze({
    checkpointsRootPath: paths.checkpointsRootPath,
    modelId: ACE_STEP_MODEL_ID,
    modelRevision: ACE_STEP_MODEL_REVISION,
    providerCodeRevision: ACE_STEP_PROVIDER_CODE_REVISION,
    providerId: ACE_STEP_PROVIDER_ID,
    providerRepository: ACE_STEP_PROVIDER_REPOSITORY,
    providerRuntimeProfile: preflight?.profileId ?? 'Unavailable',
    pythonPath: paths.pythonPath,
    supportModelRevision: ACE_STEP_SUPPORT_MODEL_REVISION,
    taskId: ACE_STEP_TASK_ID,
  });
}

function createDependencies(options) {
  return Object.freeze({
    activeTimeoutMs:
      options.activeTimeoutMs ?? DEFAULT_ACTIVE_TIMEOUT_MS,
    cancellationTimeoutMs:
      options.cancellationTimeoutMs ?? DEFAULT_CANCELLATION_TIMEOUT_MS,
    createRuntime: options.createRuntime ?? createProductionRuntime,
    monotonicNow: options.monotonicNow ?? (() => performance.now()),
    nowIso: options.nowIso ?? (() => new Date().toISOString()),
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    preflightRuntime:
      options.preflightRuntime ?? preflightProductionRuntime,
    recoveryTimeoutMs:
      options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS,
    shutdownTimeoutMs:
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    wait:
      options.wait ??
      ((delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs))),
    writeFixture: options.writeFixture ?? writeAceStepLegoProbeFixture,
  });
}

async function requireRegularFile(pathValue, code, message) {
  let pathStat;

  try {
    pathStat = await lstat(pathValue);
  } catch (error) {
    throw new AceStepCancellationAcceptanceError(code, message, {
      cause: error,
    });
  }

  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw acceptanceError(code, message);
  }

  return realpath(pathValue);
}

async function requireDirectory(pathValue, code, message) {
  let pathStat;

  try {
    pathStat = await lstat(pathValue);
  } catch (error) {
    throw new AceStepCancellationAcceptanceError(code, message, {
      cause: error,
    });
  }

  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw acceptanceError(code, message);
  }

  return realpath(pathValue);
}

async function requirePathMissing(pathValue) {
  try {
    await lstat(pathValue);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;

    throw new AceStepCancellationAcceptanceError(
      'ACE_STEP_ACCEPTANCE_EVIDENCE_UNAVAILABLE',
      'ACE-Step evidence path could not be inspected.',
      { cause: error },
    );
  }

  throw acceptanceError(
    'ACE_STEP_ACCEPTANCE_EVIDENCE_EXISTS',
    'ACE-Step evidence directory already exists and will not be overwritten.',
  );
}

function isPathWithin(parentPath, candidatePath) {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

async function listRelativeFiles(rootPath, directoryPath = rootPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      paths.push(...(await listRelativeFiles(rootPath, entryPath)));
    } else {
      paths.push(relative(rootPath, entryPath).replaceAll('\\', '/'));
    }
  }

  return paths.sort();
}

function isFinalAceWave(pathValue) {
  return (
    pathValue.startsWith('renders/ace-step/') &&
    !pathValue.startsWith('renders/ace-step/lyrics/') &&
    pathValue.toLowerCase().endsWith('.wav') &&
    !pathValue.toLowerCase().includes('.partial')
  );
}

async function writeJsonEvidence(pathValue, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;

  if (text.includes('\uFFFD')) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_REPORT_INVALID',
      'ACE-Step acceptance report contains a replacement character.',
    );
  }

  await writeFile(pathValue, text, { encoding: 'utf8', flag: 'wx' });
}

async function verifyUtf8JsonReport(pathValue, expectedStatus) {
  const bytes = await readFile(pathValue);

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_REPORT_INVALID',
      'ACE-Step acceptance report must not contain a UTF-8 BOM.',
    );
  }

  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AceStepCancellationAcceptanceError(
      'ACE_STEP_ACCEPTANCE_REPORT_INVALID',
      'ACE-Step acceptance report is not strict UTF-8.',
      { cause: error },
    );
  }

  if (text.includes('\uFFFD') || JSON.parse(text).status !== expectedStatus) {
    throw acceptanceError(
      'ACE_STEP_ACCEPTANCE_REPORT_INVALID',
      'ACE-Step acceptance report status or encoding is invalid.',
    );
  }
}

function withTimeout(promise, timeoutMs, code, message) {
  let timeout;

  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rejectTimeout) => {
      timeout = setTimeout(
        () => rejectTimeout(acceptanceError(code, message)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

function combineFailure(primaryError, shutdownError) {
  if (primaryError && shutdownError) {
    return new AceStepCancellationAcceptanceError(
      'ACE_STEP_ACCEPTANCE_CLEANUP_FAILED',
      'ACE-Step acceptance failed and runtime termination also failed.',
      { cause: new AggregateError([primaryError, shutdownError]) },
    );
  }

  return (
    primaryError ??
    shutdownError ??
    acceptanceError(
      'ACE_STEP_ACCEPTANCE_FAILED',
      'ACE-Step acceptance did not produce a result.',
    )
  );
}

function publicError(error) {
  return Object.freeze({
    code:
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z0-9_]{1,128}$/.test(error.code)
        ? error.code
        : 'ACE_STEP_ACCEPTANCE_FAILED',
    message:
      error instanceof Error && error.message.length <= 512
        ? error.message
        : 'ACE-Step cancellation acceptance failed.',
  });
}

function acceptanceError(code, message) {
  return new AceStepCancellationAcceptanceError(code, message);
}

function roundedElapsed(value) {
  return Number(Math.max(0, value).toFixed(3));
}

function restoreEnvironmentVariable(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value) {
  return value instanceof Error && 'code' in value;
}

function isMainModule() {
  return (
    typeof process.argv[1] === 'string' &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  process.exitCode = await runAceStepCancellationAcceptanceCli(
    process.argv.slice(2),
  );
}
