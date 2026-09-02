import { describe, expect, it } from 'vitest';

import {
  resolveAutoPatchStableAudio3ProductionCapability,
  type AutoPatchStableAudio3ProductionParameter,
} from './autoPatchStableAudio3ProductionCapability';

describe('Auto Patch Stable Audio 3 production capability', () => {
  it('resolves the exact production parameter set', () => {
    const resolution =
      resolveAutoPatchStableAudio3ProductionCapability(
        createParameters(),
      );

    expect(resolution).toEqual({
      parameters: {
        durationSeconds: 12,
        prompt: 'Warm electric bass with a tight pocket',
        seed: 7,
        strength: 0.4,
        takes: 1,
      },
      productionReady: true,
    });
    expect(Object.isFrozen(resolution)).toBe(true);

    if (resolution.productionReady) {
      expect(Object.isFrozen(resolution.parameters)).toBe(true);
    }
  });

  it('keeps legacy declared Prompt selections compatible', () => {
    const parameters = replaceParameter(createParameters(), 'prompt', {
      id: 'prompt',
      kind: 'select',
      options: ['Warm electric bass with a tight pocket'],
      value: 'Warm electric bass with a tight pocket',
    });

    expect(
      resolveAutoPatchStableAudio3ProductionCapability(parameters),
    ).toMatchObject({
      parameters: { prompt: 'Warm electric bass with a tight pocket' },
      productionReady: true,
    });
  });

  it('rejects missing, duplicate, and additional parameters', () => {
    const parameters = createParameters();

    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        parameters.slice(1),
      ),
    ).toMatchObject({
      cause: 'stable-audio-3-parameter-set-invalid',
      productionReady: false,
      reason: 'parameter-invalid',
    });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability([
        ...parameters,
        parameters[0],
      ]),
    ).toMatchObject({
      cause: 'stable-audio-3-parameter-set-invalid',
      productionReady: false,
      reason: 'parameter-invalid',
    });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability([
        ...parameters,
        {
          id: 'guidanceScale',
          kind: 'slider',
          value: 7,
        },
      ]),
    ).toMatchObject({
      cause: 'stable-audio-3-parameter-unsupported',
      productionReady: false,
      reason: 'parameter-unsupported',
    });
  });

  it('rejects unsafe prompt, duration, seed, and strength values', () => {
    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        replaceParameter(createParameters(), 'prompt', {
          id: 'prompt',
          kind: 'text',
          value: ' Prompt with outside whitespace',
        }),
      ),
    ).toMatchObject({ cause: 'stable-audio-3-prompt-invalid' });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        replaceParameter(createParameters(), 'prompt', {
          id: 'prompt',
          kind: 'text',
          value: '',
        }),
      ),
    ).toMatchObject({ cause: 'stable-audio-3-prompt-invalid' });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        replaceParameter(createParameters(), 'prompt', {
          id: 'prompt',
          kind: 'text',
          value: 'x'.repeat(2_001),
        }),
      ),
    ).toMatchObject({ cause: 'stable-audio-3-prompt-invalid' });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        replaceParameter(createParameters(), 'durationSeconds', {
          id: 'durationSeconds',
          kind: 'slider',
          value: 381,
        }),
      ),
    ).toMatchObject({ cause: 'stable-audio-3-duration-invalid' });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        replaceParameter(createParameters(), 'seed', {
          id: 'seed',
          kind: 'slider',
          value: 1.5,
        }),
      ),
    ).toMatchObject({ cause: 'stable-audio-3-seed-invalid' });
    expect(
      resolveAutoPatchStableAudio3ProductionCapability(
        replaceParameter(createParameters(), 'strength', {
          id: 'strength',
          kind: 'slider',
          value: -0.1,
        }),
      ),
    ).toMatchObject({ cause: 'stable-audio-3-strength-invalid' });
  });
});

function createParameters(): AutoPatchStableAudio3ProductionParameter[] {
  return [
    {
      id: 'prompt',
      kind: 'text',
      value: 'Warm electric bass with a tight pocket',
    },
    {
      id: 'durationSeconds',
      kind: 'slider',
      value: 12,
    },
    {
      id: 'seed',
      kind: 'number',
      value: 7,
    },
    {
      id: 'takes',
      kind: 'number',
      value: 1,
    },
    {
      id: 'strength',
      kind: 'slider',
      value: 0.4,
    },
  ];
}

function replaceParameter(
  parameters: AutoPatchStableAudio3ProductionParameter[],
  id: string,
  replacement: AutoPatchStableAudio3ProductionParameter,
): AutoPatchStableAudio3ProductionParameter[] {
  return parameters.map((parameter) =>
    parameter.id === id ? replacement : parameter,
  );
}
