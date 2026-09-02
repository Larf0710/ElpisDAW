export type SessionEditCategory =
  | 'auto-patch'
  | 'clip'
  | 'piano-roll'
  | 'project'
  | 'routing'
  | 'system'
  | 'take'
  | 'track';

export type SessionEditEntry = Readonly<{
  category: SessionEditCategory;
  createdAt: string;
  id: string;
  irreversible?: boolean;
  label: string;
}>;

export type SessionEditFrame<T> = Readonly<{
  edit: SessionEditEntry;
  value: T;
}>;

export type SessionEditHistory<T> = Readonly<{
  future: readonly SessionEditFrame<T>[];
  past: readonly SessionEditFrame<T>[];
  present: SessionEditFrame<T>;
}>;

export type SessionEditNavigationResult<T> =
  | Readonly<{
      history: SessionEditHistory<T>;
      status: 'MOVED';
    }>
  | Readonly<{
      history: SessionEditHistory<T>;
      status: 'AT_BOUNDARY' | 'IRREVERSIBLE_BOUNDARY';
    }>;

export function createSessionEditHistory<T>(
  value: T,
  edit: SessionEditEntry,
): SessionEditHistory<T> {
  return Object.freeze({
    future: Object.freeze([]),
    past: Object.freeze([]),
    present: Object.freeze({ edit, value }),
  });
}

export function commitSessionEdit<T>(
  history: SessionEditHistory<T>,
  value: T,
  edit: SessionEditEntry,
  historyLimit: number,
): SessionEditHistory<T> {
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
    throw new TypeError('Session Edit History limit must be a positive integer.');
  }

  return Object.freeze({
    future: Object.freeze([]),
    past: Object.freeze(
      [...history.past, history.present].slice(-historyLimit),
    ),
    present: Object.freeze({ edit, value }),
  });
}

export function updateSessionEditPresent<T>(
  history: SessionEditHistory<T>,
  updater: (value: T) => T,
): SessionEditHistory<T> {
  const value = updater(history.present.value);

  if (value === history.present.value) {
    return history;
  }

  return Object.freeze({
    ...history,
    present: Object.freeze({
      edit: history.present.edit,
      value,
    }),
  });
}

export function undoSessionEdit<T>(
  history: SessionEditHistory<T>,
): SessionEditNavigationResult<T> {
  const previous = history.past[history.past.length - 1];

  if (!previous) {
    return Object.freeze({ history, status: 'AT_BOUNDARY' });
  }

  if (history.present.edit.irreversible === true) {
    return Object.freeze({
      history,
      status: 'IRREVERSIBLE_BOUNDARY',
    });
  }

  return Object.freeze({
    history: Object.freeze({
      future: Object.freeze([history.present, ...history.future]),
      past: Object.freeze(history.past.slice(0, -1)),
      present: previous,
    }),
    status: 'MOVED',
  });
}

export function redoSessionEdit<T>(
  history: SessionEditHistory<T>,
  historyLimit: number,
): SessionEditNavigationResult<T> {
  const next = history.future[0];

  if (!next) {
    return Object.freeze({ history, status: 'AT_BOUNDARY' });
  }

  if (next.edit.irreversible === true) {
    return Object.freeze({
      history,
      status: 'IRREVERSIBLE_BOUNDARY',
    });
  }

  return Object.freeze({
    history: Object.freeze({
      future: Object.freeze(history.future.slice(1)),
      past: Object.freeze(
        [...history.past, history.present].slice(-historyLimit),
      ),
      present: next,
    }),
    status: 'MOVED',
  });
}

export function jumpSessionEdit<T>(
  history: SessionEditHistory<T>,
  targetIndex: number,
): SessionEditNavigationResult<T> {
  const frames = getSessionEditFrames(history);
  const currentIndex = history.past.length;

  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= frames.length ||
    targetIndex === currentIndex
  ) {
    return Object.freeze({ history, status: 'AT_BOUNDARY' });
  }

  if (!canJumpToSessionEdit(history, targetIndex)) {
    return Object.freeze({
      history,
      status: 'IRREVERSIBLE_BOUNDARY',
    });
  }

  return Object.freeze({
    history: Object.freeze({
      future: Object.freeze(frames.slice(targetIndex + 1)),
      past: Object.freeze(frames.slice(0, targetIndex)),
      present: frames[targetIndex],
    }),
    status: 'MOVED',
  });
}

export function canJumpToSessionEdit<T>(
  history: SessionEditHistory<T>,
  targetIndex: number,
): boolean {
  const frames = getSessionEditFrames(history);
  const currentIndex = history.past.length;

  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= frames.length
  ) {
    return false;
  }

  if (targetIndex < currentIndex) {
    return !frames
      .slice(targetIndex + 1, currentIndex + 1)
      .some((frame) => frame.edit.irreversible === true);
  }

  if (targetIndex > currentIndex) {
    return !frames
      .slice(currentIndex + 1, targetIndex + 1)
      .some((frame) => frame.edit.irreversible === true);
  }

  return true;
}

export function getSessionEditFrames<T>(
  history: SessionEditHistory<T>,
): readonly SessionEditFrame<T>[] {
  return Object.freeze([
    ...history.past,
    history.present,
    ...history.future,
  ]);
}
