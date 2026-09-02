import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workerHostSource = readFileSync(
  new URL('./stableAudio3WorkerHost.py', import.meta.url),
  'utf8',
);

describe('Stable Audio 3 Python Worker host staging durability', () => {
  it('opens the staged WAV with a Windows-valid writable descriptor for fsync', () => {
    const functionStart = workerHostSource.indexOf('def fsync_file(path: Path) -> None:');
    const functionEnd = workerHostSource.indexOf(
      '\ndef require_model_identity(payload: Any) -> None:',
      functionStart,
    );

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const fsyncFunction = workerHostSource.slice(functionStart, functionEnd);

    expect(fsyncFunction).toContain('with path.open("r+b") as output_file:');
    expect(fsyncFunction).toContain('os.fsync(output_file.fileno())');
    expect(fsyncFunction).not.toContain('with path.open("rb") as output_file:');
    expect(fsyncFunction).toContain('"STABLE_AUDIO_3_STAGING_INVALID"');
    expect(fsyncFunction).toContain(
      '"Stable Audio 3 could not synchronize staged output."',
    );
  });

  it('finishes and closes fsync before atomically replacing the staging file', () => {
    const saveIndex = workerHostSource.indexOf('self._torchaudio.save(');
    const fsyncIndex = workerHostSource.indexOf('fsync_file(partial_wav_path)', saveIndex);
    const replaceIndex = workerHostSource.indexOf(
      'os.replace(partial_wav_path, staging_path)',
      fsyncIndex,
    );

    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(fsyncIndex).toBeGreaterThan(saveIndex);
    expect(replaceIndex).toBeGreaterThan(fsyncIndex);
  });

  it('reports measured sampler steps through the streaming host protocol', () => {
    expect(workerHostSource).toContain('"accuracy": "MEASURED"');
    expect(workerHostSource).toContain('"currentStep": current_step');
    expect(workerHostSource).toContain('"totalSteps": INFERENCE_STEPS');
    expect(workerHostSource).toContain('"callback": report_progress');
    expect(workerHostSource).toContain('"event": "progress"');
    expect(workerHostSource).toContain('PROTOCOL_OUTPUT = sys.stdout');
    expect(workerHostSource).toContain('PROTOCOL_OUTPUT.write(line)');
  });
});
