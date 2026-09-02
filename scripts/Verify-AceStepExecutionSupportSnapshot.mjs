import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST,
} from '../engine/providers/aceStepExecutionSupportSnapshotManifest.mjs';
import {
  probeAceStepModelSnapshot,
} from '../engine/providers/aceStepModelSnapshotProbe.mjs';
import {
  runAceStepModelSnapshotCli,
} from './Verify-AceStepModelSnapshot.mjs';

export function probeAceStepExecutionSupportSnapshot(
  checkpointsRootPath,
  options = {},
) {
  return probeAceStepModelSnapshot(checkpointsRootPath, {
    ...options,
    manifest: ACE_STEP_PINNED_EXECUTION_SUPPORT_SNAPSHOT_MANIFEST,
  });
}

export function runAceStepExecutionSupportSnapshotCli(
  args,
  {
    probeExecutionSupportSnapshot = probeAceStepExecutionSupportSnapshot,
    writeOutput,
  } = {},
) {
  return runAceStepModelSnapshotCli(args, {
    probeModelSnapshot: probeExecutionSupportSnapshot,
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
  process.exitCode = await runAceStepExecutionSupportSnapshotCli(
    process.argv.slice(2),
  );
}
