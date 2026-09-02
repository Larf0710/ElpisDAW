import { describe, expect, it } from 'vitest';

import {
  createStudioDockScrollMemory,
  getStudioPageNavigationDestination,
  getStudioPageNavigationScrollTop,
  type StudioPageNavigationEvent,
} from './studioWorkspaceNavigation';

function createPageNavigationEvent(
  overrides: Partial<StudioPageNavigationEvent> = {},
): StudioPageNavigationEvent {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    key: 'PageDown',
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

function createTargetMatching(ownerSelectorFragment: string): EventTarget {
  return {
    closest: (selector: string) =>
      selector.includes(ownerSelectorFragment) ? { ownsPageNavigation: true } : null,
  } as unknown as EventTarget;
}

describe('Studio workspace PageUp and PageDown navigation', () => {
  it('selects exact Timeline and page-top destinations in normal mode', () => {
    expect(getStudioPageNavigationDestination(createPageNavigationEvent(), false)).toBe('timeline');
    expect(
      getStudioPageNavigationDestination(createPageNavigationEvent({ key: 'PageUp' }), false),
    ).toBe('page-top');
    expect(
      getStudioPageNavigationDestination(createPageNavigationEvent({ key: 'ArrowDown' }), false),
    ).toBeUndefined();
  });

  it('does not intercept expanded mode, prevented events, or modified shortcuts', () => {
    expect(getStudioPageNavigationDestination(createPageNavigationEvent(), true)).toBeUndefined();
    expect(
      getStudioPageNavigationDestination(
        createPageNavigationEvent({ defaultPrevented: true }),
        false,
      ),
    ).toBeUndefined();

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      expect(
        getStudioPageNavigationDestination(
          createPageNavigationEvent({ [modifier]: true }),
          false,
        ),
      ).toBeUndefined();
    }
  });

  it('leaves editable, menu, dialog, popover, slider, and explicit owner targets alone', () => {
    for (const selectorFragment of [
      'input',
      'textarea',
      'select',
      '[contenteditable]',
      '[popover]',
      '[role="menu"]',
      '[role="listbox"]',
      '[role="dialog"]',
      '[role="slider"]',
      '[data-studio-page-navigation-owner]',
    ]) {
      expect(
        getStudioPageNavigationDestination(
          createPageNavigationEvent({ target: createTargetMatching(selectorFragment) }),
          false,
        ),
      ).toBeUndefined();
    }
  });

  it('allows ordinary non-owning targets and aligns anchors to the viewport inset', () => {
    const ordinaryTarget = { closest: () => null } as unknown as EventTarget;

    expect(
      getStudioPageNavigationDestination(
        createPageNavigationEvent({ target: ordinaryTarget }),
        false,
      ),
    ).toBe('timeline');
    expect(getStudioPageNavigationScrollTop(640, 120)).toBe(751);
    expect(getStudioPageNavigationScrollTop(4, 0)).toBe(0);
  });

  it('keeps independent bounded scroll positions for each Dock', () => {
    const memory = createStudioDockScrollMemory<'main' | 'piano-roll' | 'mixer'>();

    expect(memory.recall('main')).toBe(0);
    memory.remember('main', 34.5);
    memory.remember('mixer', 351);

    expect(memory.recall('main')).toBe(34.5);
    expect(memory.recall('piano-roll')).toBe(0);
    expect(memory.recall('mixer')).toBe(351);
    expect(() => memory.remember('main', Number.NaN)).toThrow(RangeError);
    expect(() => memory.remember('main', -1)).toThrow(RangeError);
  });
});
