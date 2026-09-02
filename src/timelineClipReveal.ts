export type NearestScrollOffsetInput = Readonly<{
  currentOffset: number;
  maxOffset: number;
  targetEnd: number;
  targetStart: number;
  viewportEnd: number;
  viewportStart: number;
}>;

export function getNearestScrollOffset({
  currentOffset,
  maxOffset,
  targetEnd,
  targetStart,
  viewportEnd,
  viewportStart,
}: NearestScrollOffsetInput): number {
  const values = [
    currentOffset,
    maxOffset,
    targetEnd,
    targetStart,
    viewportEnd,
    viewportStart,
  ];

  if (
    values.some((value) => !Number.isFinite(value)) ||
    maxOffset < 0 ||
    targetEnd < targetStart ||
    viewportEnd < viewportStart
  ) {
    throw new RangeError('Timeline reveal geometry must be finite and ordered.');
  }

  const boundedCurrentOffset = clampOffset(currentOffset, maxOffset);
  const startsBeforeViewport = targetStart < viewportStart;
  const endsAfterViewport = targetEnd > viewportEnd;

  if (!startsBeforeViewport && !endsAfterViewport) {
    return boundedCurrentOffset;
  }

  if (startsBeforeViewport && endsAfterViewport) {
    return boundedCurrentOffset;
  }

  const targetSize = targetEnd - targetStart;
  const viewportSize = viewportEnd - viewportStart;
  const delta = startsBeforeViewport
    ? targetSize <= viewportSize
      ? targetStart - viewportStart
      : targetEnd - viewportEnd
    : targetSize <= viewportSize
      ? targetEnd - viewportEnd
      : targetStart - viewportStart;

  return clampOffset(boundedCurrentOffset + delta, maxOffset);
}

function clampOffset(offset: number, maxOffset: number): number {
  return Math.min(Math.max(offset, 0), maxOffset);
}
