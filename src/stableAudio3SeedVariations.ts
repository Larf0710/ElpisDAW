export const STABLE_AUDIO_3_MIN_TAKES = 1 as const;
export const STABLE_AUDIO_3_MAX_TAKES = 3 as const;
export const STABLE_AUDIO_3_MAX_SEED = 0xffff_ffff as const;

const STABLE_AUDIO_3_SEED_SPACE = STABLE_AUDIO_3_MAX_SEED + 1;

export type StableAudio3RandomValues = (
  values: Uint32Array,
) => Uint32Array;

export function createStableAudio3SeedSequence(
  baseSeed: number,
  takeCount: number,
): readonly number[] {
  requireStableAudio3Seed(baseSeed);
  requireStableAudio3TakeCount(takeCount);

  return Object.freeze(
    Array.from(
      { length: takeCount },
      (_, index) => (baseSeed + index) % STABLE_AUDIO_3_SEED_SPACE,
    ),
  );
}

export function createRandomStableAudio3Seed(
  randomValues: StableAudio3RandomValues,
): number {
  if (typeof randomValues !== 'function') {
    throw new TypeError('Stable Audio 3 random Seed requires a random-value source.');
  }

  const values = randomValues(new Uint32Array(1));
  const seed = values[0];

  requireStableAudio3Seed(seed);

  return seed;
}

export function isStableAudio3TakeCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= STABLE_AUDIO_3_MIN_TAKES &&
    (value as number) <= STABLE_AUDIO_3_MAX_TAKES
  );
}

export function isStableAudio3Seed(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= STABLE_AUDIO_3_MAX_SEED
  );
}

function requireStableAudio3TakeCount(value: unknown): asserts value is number {
  if (!isStableAudio3TakeCount(value)) {
    throw new RangeError(
      `Stable Audio 3 Takes must be an integer between ${STABLE_AUDIO_3_MIN_TAKES} and ${STABLE_AUDIO_3_MAX_TAKES}.`,
    );
  }
}

function requireStableAudio3Seed(value: unknown): asserts value is number {
  if (!isStableAudio3Seed(value)) {
    throw new RangeError(
      `Stable Audio 3 Seed must be an integer between 0 and ${STABLE_AUDIO_3_MAX_SEED}.`,
    );
  }
}
