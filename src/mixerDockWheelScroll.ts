export type VerticalWheelScrollOwner = {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
};

export type VerticalWheelInput = Readonly<{
  defaultPrevented: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  targetIsInteractive: boolean;
  preventDefault: () => void;
}>;

const wheelDeltaPixel = 0;
const wheelDeltaLine = 1;
const wheelDeltaPage = 2;
const wheelLineHeight = 16;
const verticalScrollOverflowValues = new Set(['auto', 'overlay', 'scroll']);

export function routeVerticalWheelPriority(
  event: VerticalWheelInput,
  owners: readonly VerticalWheelScrollOwner[],
): boolean {
  if (
    event.defaultPrevented ||
    event.shiftKey ||
    event.targetIsInteractive ||
    !Number.isFinite(event.deltaMode) ||
    !Number.isFinite(event.deltaX) ||
    !Number.isFinite(event.deltaY) ||
    event.deltaY === 0 ||
    Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
    !isSupportedDeltaMode(event.deltaMode)
  ) {
    return false;
  }

  const visitedOwners = new Set<VerticalWheelScrollOwner>();

  for (const owner of owners) {
    if (visitedOwners.has(owner)) {
      continue;
    }
    visitedOwners.add(owner);

    if (
      !Number.isFinite(owner.clientHeight) ||
      !Number.isFinite(owner.scrollHeight) ||
      !Number.isFinite(owner.scrollTop)
    ) {
      continue;
    }

    const maximumScrollTop = Math.max(0, owner.scrollHeight - owner.clientHeight);
    if (maximumScrollTop === 0) {
      continue;
    }

    const currentScrollTop = clamp(owner.scrollTop, 0, maximumScrollTop);
    const scrollDelta = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      owner.clientHeight,
    );
    const nextScrollTop = clamp(
      currentScrollTop + scrollDelta,
      0,
      maximumScrollTop,
    );

    if (nextScrollTop === currentScrollTop) {
      continue;
    }

    const previousScrollTop = owner.scrollTop;
    owner.scrollTop = nextScrollTop;
    if (owner.scrollTop === previousScrollTop) {
      continue;
    }

    event.preventDefault();
    return true;
  }

  return false;
}

export function findNestedVerticalScrollOwners(
  target: EventTarget | null,
  boundary: HTMLElement,
): HTMLElement[] {
  const owners: HTMLElement[] = [];
  let element = target instanceof Element ? target : null;

  while (element) {
    if (
      element instanceof HTMLElement &&
      verticalScrollOverflowValues.has(getComputedStyle(element).overflowY)
    ) {
      owners.push(element);
    }

    if (element === boundary) {
      break;
    }

    element = element.parentElement;
  }

  return owners;
}

function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
): number {
  if (deltaMode === wheelDeltaLine) {
    return deltaY * wheelLineHeight;
  }

  if (deltaMode === wheelDeltaPage) {
    return deltaY * Math.max(1, viewportHeight);
  }

  return deltaY;
}

function isSupportedDeltaMode(deltaMode: number): boolean {
  return deltaMode === wheelDeltaPixel ||
    deltaMode === wheelDeltaLine ||
    deltaMode === wheelDeltaPage;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
