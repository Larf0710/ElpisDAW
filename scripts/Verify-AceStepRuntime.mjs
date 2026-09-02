import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { probeAceStepRuntime } from '../engine/providers/aceStepRuntimeProbe.mjs';

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,128}$/;

export async function runAceStepRuntimeCli(
  args,
  {
    probeRuntime = probeAceStepRuntime,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  let exitCode;
  let output;

  try {
    const pythonPath = validateCliArguments(args);
    const assessment = await probeRuntime(pythonPath);

    if (
      !isRecord(assessment) ||
      !Array.isArray(assessment.blockers) ||
      !isRecord(assessment.environment) ||
      typeof assessment.profileId !== 'string' ||
      (assessment.status !== 'READY_FOR_MODEL_PROBE' &&
        assessment.status !== 'UNVERIFIED')
    ) {
      throw cliError(
        'ACE_STEP_PROBE_RESPONSE_INVALID',
        'ACE-Step Runtime Probe returned an invalid assessment.',
      );
    }

    output = assessment;
    exitCode = assessment.status === 'READY_FOR_MODEL_PROBE' ? 0 : 2;
  } catch (error) {
    output = {
      error: {
        code: errorCode(error),
        message: 'ACE-Step Runtime could not be verified.',
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
    args[0].trim() !== args[0] ||
    !isAbsolute(args[0])
  ) {
    throw cliError(
      'ACE_STEP_PROBE_CLI_USAGE_INVALID',
      'Pass one absolute path to the pinned Python executable.',
    );
  }

  return args[0];
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
      : 'ACE_STEP_PROBE_FAILED';

  return ERROR_CODE_PATTERN.test(code) ? code : 'ACE_STEP_PROBE_FAILED';
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
  process.exitCode = await runAceStepRuntimeCli(process.argv.slice(2));
}
