import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const copySource = readFileSync(
  new URL('./timelineTrackCopy.ts', import.meta.url),
  'utf8',
);

describe('visible recursive Group Track contract', () => {
  it('keeps the existing Timeline COPY action and delegates recursive Group topology', () => {
    expect(appSource).toContain('handleCopyTimelineSelection');
    expect(appSource).toContain('resolveTimelineCopyAvailability');
    expect(appSource).toContain('applyFlatGroupTrackCopyPlan');
    expect(appSource).toContain('copyOrdinaryTimelineTrack');
    expect(appSource).toContain('GROUP COPIED');
    expect(appSource).toContain('Copied Group');
    expect(copySource).toContain("mode: 'group'");
    expect(copySource).toContain('resolveFlatGroupTrackCopyPlan');
    expect(copySource).toContain('resolveTrackGroupSubtreeCopyPlan');
    expect(copySource).toContain('clonedSubtreeTracks');
  });

  it('records one normal Track edit and selects only the copied Group', () => {
    expect(appSource).toContain("label: `Copy Group: ${availability.sourceTrack?.name ?? 'Group Track'}`");
    expect(copySource).toContain("type: 'track'");
    expect(copySource).toContain('items: [selectionItem]');
  });

  it('renders bounded recursive depth and truthful direct-child/playback-leaf labels', () => {
    expect(appSource).toContain('resolveTrackGroupVisibleRows');
    expect(appSource).toContain('data-track-depth={depth}');
    expect(appSource).toContain("'--track-group-depth': Math.min(depth, 4)");
    expect(appSource).toContain('direct child');
    expect(appSource).toContain('Playback leaf:');
    expect(appSource).not.toContain('Nested track groups are not supported yet.');
    expect(copySource).not.toContain('ACE Vocals');
  });

  it('delegates recursive GROUP, UNGROUP, collapse, and DELETE mutations outside App', () => {
    expect(appSource).toContain('resolveTrackGroupingPlan');
    expect(appSource).toContain('applyTrackGroupingPlan');
    expect(appSource).toContain('resolveTrackUngroupPlan');
    expect(appSource).toContain('applyTrackUngroupPlan');
    expect(appSource).toContain('applyTrackGroupCollapsedState');
    expect(appSource).toContain('resolveTimelineTreeDeletion');
    expect(appSource).toContain('applyTimelineTreeDeletionPlan');
    expect(appSource).not.toContain('function groupTracks(');
    expect(appSource).not.toContain('function ungroupTracks(');
  });

  it('preserves saved parent and Group fields without flattening during Project load', () => {
    expect(appSource).toContain('group: normalizeTrackGroupData(track.group)');
    expect(appSource).toContain("parentGroupId: typeof track.parentGroupId === 'string'");
    expect(appSource).toContain('childTrackIds: group.childTrackIds.filter');
    expect(appSource).toContain('activePlaybackTrackId: group.activePlaybackTrackId');
  });
});
