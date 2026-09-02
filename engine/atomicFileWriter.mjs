import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const defaultFileOperations = Object.freeze({ mkdir, open, rename, rm });

export async function writeTextAtomically(
  targetPath,
  contents,
  { fileOperations = defaultFileOperations } = {},
) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new TypeError('Atomic write targetPath must be a non-empty string.');
  }

  if (typeof contents !== 'string') {
    throw new TypeError('Atomic write contents must be a string.');
  }

  const targetDirectory = dirname(targetPath);
  const temporaryPath = join(
    targetDirectory,
    `.${basename(targetPath)}.${process.pid}-${randomUUID()}.tmp`,
  );
  let temporaryHandle;

  await fileOperations.mkdir(targetDirectory, { recursive: true });

  try {
    temporaryHandle = await fileOperations.open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.writeFile(contents, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await fileOperations.rename(temporaryPath, targetPath);
  } catch (error) {
    if (temporaryHandle) {
      await temporaryHandle.close().catch(() => undefined);
    }

    await fileOperations.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    bytesWritten: Buffer.byteLength(contents, 'utf8'),
    targetPath,
  });
}

export function serializeJsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
