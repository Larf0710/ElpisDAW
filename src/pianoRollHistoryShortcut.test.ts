import { describe, expect, it, vi } from 'vitest';

import { resolvePianoRollHistoryShortcut } from './PianoRollInteractionSpike';

describe('Piano Roll history shortcuts', () => {
  it('routes command-Z to local Undo', () => {
    expect(resolvePianoRollHistoryShortcut(createHistoryEvent())).toBe('undo');
  });

  it('routes command-Shift-Z and command-Y to local Redo', () => {
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ shiftKey: true })),
    ).toBe('redo');
    expect(
      resolvePianoRollHistoryShortcut(
        createHistoryEvent({ ctrlKey: false, key: 'Y', metaKey: true }),
      ),
    ).toBe('redo');
  });

  it('does not claim unrelated, modified, or repeated keys', () => {
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ ctrlKey: false })),
    ).toBeUndefined();
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ altKey: true })),
    ).toBeUndefined();
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ repeat: true })),
    ).toBeUndefined();
  });

  it.each([
    ['SoundFont number input', 'input'],
    ['text area', 'textarea'],
    ['Piano Roll grid selector', 'select'],
    ['editable content descendant', '[contenteditable]:not([contenteditable="false"])'],
  ])('leaves Undo and Redo unclaimed for %s', (_label, ownerSelector) => {
    const owner = {};
    const closest = vi.fn((selector: string) =>
      selector.split(', ').includes(ownerSelector) ? owner : null,
    );
    const target = { closest } as unknown as EventTarget;

    for (const modifiers of [
      { ctrlKey: true, metaKey: false },
      { ctrlKey: false, metaKey: true },
    ]) {
      for (const shortcut of [
        { key: 'z', shiftKey: false },
        { key: 'z', shiftKey: true },
        { key: 'y', shiftKey: false },
      ]) {
        expect(
          resolvePianoRollHistoryShortcut(
            createHistoryEvent({ ...modifiers, ...shortcut, target }),
          ),
        ).toBeUndefined();
      }
    }

    expect(closest).toHaveBeenCalled();
  });

  it('keeps all local history commands on ordinary note surfaces', () => {
    const target = { closest: () => null } as unknown as EventTarget;

    expect(resolvePianoRollHistoryShortcut(createHistoryEvent({ target }))).toBe('undo');
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ shiftKey: true, target })),
    ).toBe('redo');
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ key: 'y', target })),
    ).toBe('redo');
  });

  it('does not consume an already prevented event', () => {
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ defaultPrevented: true })),
    ).toBeUndefined();
  });

  it('accepts a null or non-element target without assuming a browser global', () => {
    expect(resolvePianoRollHistoryShortcut(createHistoryEvent())).toBe('undo');
    expect(
      resolvePianoRollHistoryShortcut(createHistoryEvent({ target: new EventTarget() })),
    ).toBe('undo');
  });
});

function createHistoryEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    ctrlKey: true,
    defaultPrevented: false,
    key: 'z',
    metaKey: false,
    repeat: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}
