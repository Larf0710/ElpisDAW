import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  probeAceStepModelSnapshot,
} from '../engine/providers/aceStepModelSnapshotProbe.mjs';

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;
const MAX_PATH_LENGTH = 32_767;

export async function runAceStepModelSnapshotCli(
  args,
  {
    probeModelSnapshot = probeAceStepModelSnapshot,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  let exitCode;
  let output;

  try {
    const modelRootPath = validateCliArguments(args);
    const assessment = await probeModelSnapshot(modelRootPath);

    if (!isValidAssessment(assessment)) {
      throw cliError(
        'ACE_STEP_MODEL_PROBE_RESPONSE_INVALID',
        'ACE-Step Model Snapshot Probe returned an invalid assessment.',
      );
    }

    output = assessment;
    exitCode =
      assessment.status === 'READY_FOR_REAL_GENERATION_PROBE' ? 0 : 2;
  } catch (error) {
    output = {
      error: {
        code: errorCode(error),
        message: 'ACE-Step Model Snapshot could not be verified.',
      },
      status: 'VERIFICATION_FAILED',
    };
    exitCode = 1;
  }

  writeOutput(`${JSON.stringify(output, null, 2)}\n`);
  return exitCode;
}

function validateCliArguments(args) {
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    typeof args[0] !== 'string' ||
    args[0].length === 0 ||
    args[0].length > MAX_PATH_LENGTH ||
    args[0].trim() !== args[0] ||
    !isAbsolute(args[0])
  ) {
    throw cliError(
      'ACE_STEP_MODEL_PROBE_CLI_USAGE_INVALID',
      'Pass exactly one absolute ACE-Step Model root path.',
    );
  }

  return args[0];
}

function isValidAssessment(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.blockers) &&
    isRecord(value.manifest) &&
    isRecord(value.snapshot) &&
    (value.status === 'READY_FOR_REAL_GENERATION_PROBE' ||
      value.status === 'UNVERIFIED')
  );
}

function cliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorCode(error) {
  const code =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'ACE_STEP_MODEL_PROBE_FAILED';

  return ERROR_CODE_PATTERN.test(code)
    ? code
    : 'ACE_STEP_MODEL_PROBE_FAILED';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainModule() {
  return (
    typeof process.argv[1] === 'string' &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  process.exitCode = await runAceStepModelSnapshotCli(process.argv.slice(2));
}
