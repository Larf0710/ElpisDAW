import { describe, expect, it } from 'vitest';

import {
  canJumpToSessionEdit,
  commitSessionEdit,
  createSessionEditHistory,
  getSessionEditFrames,
  jumpSessionEdit,
  redoSessionEdit,
  undoSessionEdit,
  updateSessionEditPresent,
  type SessionEditEntry,
} from './sessionEditHistory';

describe('Session Edit History', () => {
  it('commits labeled frames and discards a future branch', () => {
    const initial = createSessionEditHistory(
      { project: 0, selection: 'a' },
      createEntry('open', 'Open Project'),
    );
    const first = commitSessionEdit(
      initial,
      { project: 1, selection: 'a' },
      createEntry('move', 'Move Clip'),
      80,
    );
    const second = commitSessionEdit(
      first,
      { project: 2, selection: 'a' },
      createEntry('trim', 'Trim Clip End'),
      80,
    );
    const undone = undoSessionEdit(second);

    expect(undone.status).toBe('MOVED');

    if (undone.status !== 'MOVED') {
      throw new Error(undone.status);
    }

    const branched = commitSessionEdit(
      undone.history,
      { project: 3, selection: 'a' },
      createEntry('split', 'Split Clip'),
      80,
    );

    expect(branched.future).toEqual([]);
    expect(getSessionEditFrames(branched).map((frame) => frame.edit.label)).toEqual([
      'Open Project',
      'Move Clip',
      'Split Clip',
    ]);
  });

  it('updates view state without creating another Edit History frame', () => {
    const history = createSessionEditHistory(
      { project: 1, selection: 'a' },
      createEntry('open', 'Open Project'),
    );
    const updated = updateSessionEditPresent(history, (value) => ({
      ...value,
      selection: 'b',
    }));

    expect(getSessionEditFrames(updated)).toHaveLength(1);
    expect(updated.present.value).toEqual({ project: 1, selection: 'b' });
    expect(updated.present.edit).toBe(history.present.edit);
  });

  it('supports Undo, Redo, and direct Photoshop-style history jumps', () => {
    const history = createHistory();
    const jumped = jumpSessionEdit(history, 1);

    expect(jumped.status).toBe('MOVED');

    if (jumped.status !== 'MOVED') {
      throw new Error(jumped.status);
    }

    expect(jumped.history.present.edit.label).toBe('Move Clip');
    expect(jumped.history.future.map((frame) => frame.edit.label)).toEqual([
      'Trim Clip End',
      'Activate Take 03',
    ]);

    const redone = redoSessionEdit(jumped.history, 80);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.edit.label).toBe('Trim Clip End');
  });

  it('blocks Undo, Redo, and jumps across irreversible file deletion', () => {
    const beforeDelete = createHistory();
    const deleted = commitSessionEdit(
      beforeDelete,
      { value: 4 },
      createEntry('delete-file', 'Delete Take 03 + Audio File', true),
      80,
    );
    const afterDelete = commitSessionEdit(
      deleted,
      { value: 5 },
      createEntry('move-after', 'Move Clip'),
      80,
    );
    const undoAfterEdit = undoSessionEdit(afterDelete);

    expect(undoAfterEdit.status).toBe('MOVED');

    if (undoAfterEdit.status !== 'MOVED') {
      throw new Error(undoAfterEdit.status);
    }

    expect(undoSessionEdit(undoAfterEdit.history).status).toBe(
      'IRREVERSIBLE_BOUNDARY',
    );
    expect(canJumpToSessionEdit(afterDelete, 2)).toBe(false);
    expect(jumpSessionEdit(afterDelete, 2).status).toBe(
      'IRREVERSIBLE_BOUNDARY',
    );

    const beforeBarrier = createHistory();
    const barrierFrame = commitSessionEdit(
      beforeBarrier,
      { value: 4 },
      createEntry('delete-file', 'Delete Take 03 + Audio File', true),
      80,
    ).present;
    expect(
      redoSessionEdit(
        {
          ...beforeBarrier,
          future: [barrierFrame],
        },
        80,
      ).status,
    ).toBe('IRREVERSIBLE_BOUNDARY');
  });

  it('enforces the configured past-frame limit', () => {
    let history = createSessionEditHistory(
      { value: 0 },
      createEntry('open', 'Open Project'),
    );

    for (let index = 1; index <= 5; index += 1) {
      history = commitSessionEdit(
        history,
        { value: index },
        createEntry(`edit-${index}`, `Edit ${index}`),
        3,
      );
    }

    expect(history.past).toHaveLength(3);
    expect(getSessionEditFrames(history).map((frame) => frame.value.value)).toEqual([
      2,
      3,
      4,
      5,
    ]);
  });
});

function createHistory() {
  let history = createSessionEditHistory(
    { value: 0 },
    createEntry('open', 'Open Project'),
  );

  history = commitSessionEdit(
    history,
    { value: 1 },
    createEntry('move', 'Move Clip'),
    80,
  );
  history = commitSessionEdit(
    history,
    { value: 2 },
    createEntry('trim', 'Trim Clip End'),
    80,
  );

  return commitSessionEdit(
    history,
    { value: 3 },
    createEntry('take', 'Activate Take 03'),
    80,
  );
}

function createEntry(
  id: string,
  label: string,
  irreversible = false,
): SessionEditEntry {
  return {
    category: 'clip',
    createdAt: '2026-07-27T04:00:00.000Z',
    id,
    irreversible,
    label,
  };
}
