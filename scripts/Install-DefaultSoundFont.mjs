import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installDefaultSoundFontAssets,
  loadDefaultSoundFontManifest,
} from '../engine/defaultSoundFontProvisioner.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');

const options = parseArguments(process.argv.slice(2));

try {
  const manifest = await loadDefaultSoundFontManifest();
  const runtimeRoot = resolve(
    options.runtimeRoot ?? resolve(projectRoot, manifest.runtimeRelativeDirectory),
  );
  const result = await installDefaultSoundFontAssets({
    destinationRoot: runtimeRoot,
    manifest,
    sourceRoot: options.sourceRoot ? resolve(options.sourceRoot) : undefined,
  });

  process.stdout.write(`${JSON.stringify({ ...result, runtimeRoot })}\n`);
} catch (error) {
  const message = `Default SoundFont installation failed: ${
    error instanceof Error ? error.message : String(error)
  }`;

  if (options.allowUnavailable) {
    process.stdout.write(`${JSON.stringify({ message, status: 'UNAVAILABLE' })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument === '--runtime-root' && value) {
      options.runtimeRoot = value;
      index += 1;
      continue;
    }
    if (argument === '--source-root' && value) {
      options.sourceRoot = value;
      index += 1;
      continue;
    }
    if (argument === '--allow-unavailable') {
      options.allowUnavailable = true;
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}.`);
  }

  return options;
}
