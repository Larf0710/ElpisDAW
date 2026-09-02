export const STUDIO_VIEWPORT_INSET_PX = 9;

export interface StudioDockScrollMemory<DockId extends string> {
  recall(dockId: DockId): number;
  remember(dockId: DockId, scrollTop: number): void;
}

export type StudioPageNavigationDestination = 'timeline' | 'page-top';

export type StudioPageNavigationEvent = Readonly<
  Pick<
    KeyboardEvent,
    'altKey' | 'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey' | 'shiftKey' | 'target'
  >
>;

const studioPageNavigationOwnerSelector = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[popover]',
  '[role="application"]',
  '[role="combobox"]',
  '[role="dialog"]',
  '[role="grid"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="tree"]',
  '[data-studio-page-navigation-owner]',
].join(', ');

export function getStudioPageNavigationDestination(
  event: StudioPageNavigationEvent,
  isTimelineExpanded: boolean,
): StudioPageNavigationDestination | undefined {
  if (
    isTimelineExpanded ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isStudioPageNavigationOwnedTarget(event.target)
  ) {
    return undefined;
  }

  if (event.key === 'PageDown') {
    return 'timeline';
  }

  return event.key === 'PageUp' ? 'page-top' : undefined;
}

export function getStudioPageNavigationScrollTop(
  anchorViewportTop: number,
  currentScrollY: number,
  viewportInset = STUDIO_VIEWPORT_INSET_PX,
): number {
  return Math.max(0, currentScrollY + anchorViewportTop - viewportInset);
}

export function createStudioDockScrollMemory<
  DockId extends string,
>(): StudioDockScrollMemory<DockId> {
  const positions = new Map<DockId, number>();

  return Object.freeze({
    recall(dockId: DockId): number {
      return positions.get(dockId) ?? 0;
    },
    remember(dockId: DockId, scrollTop: number): void {
      if (!Number.isFinite(scrollTop) || scrollTop < 0) {
        throw new RangeError('Dock scroll position must be a finite non-negative number.');
      }

      positions.set(dockId, scrollTop);
    },
  });
}

function isStudioPageNavigationOwnedTarget(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest;

  return typeof closest === 'function' && Boolean(closest.call(target, studioPageNavigationOwnerSelector));
}
