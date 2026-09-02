import { isAbsolute } from 'node:path';

import {
  probeStableAudio3Runtime,
} from '../engine/providers/stableAudio3RuntimeProbe.mjs';

const pythonPath = process.argv[2];

if (typeof pythonPath !== 'string' || !isAbsolute(pythonPath)) {
  throw new Error(
    'Pass the absolute Python executable path for the isolated Stable Audio 3 environment.',
  );
}

try {
  const assessment = await probeStableAudio3Runtime(pythonPath);

  process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);

  if (assessment.status !== 'READY_FOR_MODEL_PROBE') {
    process.exitCode = 2;
  }
} catch (error) {
  const code =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : 'STABLE_AUDIO_3_PROBE_FAILED';

  process.stdout.write(
    `${JSON.stringify(
      {
        error: {
          code,
          message: 'Stable Audio 3 Runtime Probe could not inspect the selected environment.',
        },
        status: 'PROBE_FAILED',
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
