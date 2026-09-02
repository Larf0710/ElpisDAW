import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACE_STEP_PINNED_EFFECTIVE_MODEL_SNAPSHOT_MANIFEST,
} from '../engine/providers/aceStepEffectiveModelSnapshotManifest.mjs';
import {
  probeAceStepModelSnapshot,
} from '../engine/providers/aceStepModelSnapshotProbe.mjs';
import {
  runAceStepModelSnapshotCli,
} from './Verify-AceStepModelSnapshot.mjs';

export function probeAceStepEffectiveModelSnapshot(modelRootPath, options = {}) {
  return probeAceStepModelSnapshot(modelRootPath, {
    ...options,
    manifest: ACE_STEP_PINNED_EFFECTIVE_MODEL_SNAPSHOT_MANIFEST,
  });
}

export function runAceStepEffectiveModelSnapshotCli(
  args,
  {
    probeEffectiveModelSnapshot = probeAceStepEffectiveModelSnapshot,
    writeOutput,
  } = {},
) {
  return runAceStepModelSnapshotCli(args, {
    probeModelSnapshot: probeEffectiveModelSnapshot,
    ...(writeOutput === undefined ? {} : { writeOutput }),
  });
}

function isMainModule() {
  return (
    typeof process.argv[1] === 'string' &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  process.exitCode = await runAceStepEffectiveModelSnapshotCli(
    process.argv.slice(2),
  );
}
