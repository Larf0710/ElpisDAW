import { describe, expect, it } from 'vitest';

import {
  PROJECT_STEM_PRINT_PLAN_VERSION,
  PROJECT_STEM_PRINT_PURPOSE,
} from '../shared/projectStemPrintProtocol.js';
import { createTestProjectMixdownPlanV3 } from '../src/projectMixdownTestFixtures.ts';
import {
  ProjectStemPrintPlanProtocolError,
  parseProjectStemPrintPlan,
} from './projectStemPrintPlanProtocol.mjs';

describe('Project Stem Print Plan runtime protocol', () => {
  it('accepts and snapshots the exact Foundation A Channel Plan', () => {
    const input = createValidPlan();
    const parsed = parseProjectStemPrintPlan(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.selectedTargets[0]).not.toBe(input.selectedTargets[0]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.audibleRange)).toBe(true);
    expect(Object.isFrozen(parsed.selectedTargets)).toBe(true);
    expect(Object.isFrozen(parsed.sources[0])).toBe(true);
    expect(Object.isFrozen(parsed.tracks[0].events[0])).toBe(true);
    expect(Object.isFrozen(
      parsed.mixerSnapshot.channels[0].inserts[0].parameters,
    )).toBe(true);
  });

  it('accepts exact Group lineage', () => {
    const parsed = parseProjectStemPrintPlan(createValidPlan({
      groupTrackId: 'group-a',
    }));

    expect(parsed.selectedTargets).toEqual([
      {
        groupTrackId: 'group-a',
        kind: 'group',
        resolvedTrackId: 'track-a',
      },
    ]);
    expect(parsed.tracks[0].groupTrackId).toBe('group-a');
  });

  it('isolates the parsed snapshot from later caller mutation', () => {
    const input = createValidPlan();
    const parsed = parseProjectStemPrintPlan(input);

    input.selectedTargets[0].trackId = 'changed';
    input.sources[0].sizeBytes = 96_044;
    input.tracks[0].events[0].clipName = 'changed';
    input.mixerSnapshot.channels[0].faderDb = 6;

    expect(parsed.selectedTargets[0].trackId).toBe('track-a');
    expect(parsed.sources[0].sizeBytes).toBe(48_044);
    expect(parsed.tracks[0].events[0].clipName).toBe('clip-a');
    expect(parsed.mixerSnapshot.channels[0].faderDb).toBe(-3);
  });

  it.each([
    ['an extra top-level key', (plan) => { plan.extra = true; }],
    ['a missing top-level key', (plan) => { delete plan.audibleRange; }],
    ['the wrong purpose', (plan) => { plan.purpose = 'mixdown'; }],
    ['the wrong Plan version', (plan) => { plan.version = 2; }],
    ['the wrong Mixer Snapshot version', (plan) => {
      plan.mixerSnapshotVersion = 1;
    }],
    ['the wrong effects version', (plan) => { plan.effectsContractVersion = 2; }],
    ['the wrong DSP version', (plan) => { plan.mixerDspVersion = 1; }],
    ['the wrong meter version', (plan) => { plan.meterTapVersion = 1; }],
    ['a non-canonical output format', (plan) => { plan.format.sampleRate = 48_000; }],
    ['a non-finite timing value', (plan) => { plan.bpm = Number.NaN; }],
  ])('rejects %s', (_label, corrupt) => {
    const plan = createValidPlan();
    corrupt(plan);

    expectInvalid(plan);
  });

  it.each([
    ['a Channel target whose identities differ', (plan) => {
      plan.selectedTargets[0].resolvedTrackId = 'track-b';
    }],
    ['duplicate resolved target identities', (plan) => {
      plan.selectedTargets.push({
        kind: 'channel',
        resolvedTrackId: 'track-a',
        trackId: 'track-a',
      });
    }],
    ['a selected target without a Mixer Channel', (plan) => {
      plan.selectedTargets[0].resolvedTrackId = 'missing';
      plan.selectedTargets[0].trackId = 'missing';
    }],
  ])('rejects %s', (_label, corrupt) => {
    const plan = createValidPlan();
    corrupt(plan);

    expectInvalid(plan);
  });

  it.each([
    ['a Group target with a missing schedule lineage', (plan) => {
      delete plan.tracks[0].groupTrackId;
    }],
    ['a Group target with a conflicting schedule lineage', (plan) => {
      plan.tracks[0].groupTrackId = 'group-b';
    }],
    ['a Group container resolving to itself', (plan) => {
      plan.selectedTargets[0].resolvedTrackId = 'group-a';
    }],
    ['a Group container that incorrectly owns a Mixer Channel', (plan) => {
      plan.mixerSnapshot.channels.push({
        ...structuredClone(plan.mixerSnapshot.channels[0]),
        trackId: 'group-a',
      });
    }],
  ])('rejects %s', (_label, corrupt) => {
    const plan = createValidPlan({ groupTrackId: 'group-a' });
    corrupt(plan);

    expectInvalid(plan);
  });

  it.each([
    ['an unused source descriptor', (plan) => {
      plan.sources.push({
        kind: 'generated',
        name: 'source-b.wav',
        relativePath: 'renders/instruments/source-b.wav',
        sizeBytes: 48_044,
        sourceId: 'source-b',
      });
    }],
    ['a missing scheduled source descriptor', (plan) => {
      plan.sources.splice(0, 1);
    }],
    ['a source descriptor order mismatch', (plan) => {
      plan.sources[0].sourceId = 'source-b';
      plan.sources[0].name = 'source-b.wav';
      plan.sources[0].relativePath = 'renders/instruments/source-b.wav';
    }],
    ['an event referencing an unavailable source', (plan) => {
      plan.tracks[0].events[0].sourceId = 'source-b';
    }],
    ['a generated source path outside the Project audio boundary', (plan) => {
      plan.sources[0].relativePath = 'other/source-a.wav';
    }],
    ['a generated source path whose filename does not match', (plan) => {
      plan.sources[0].relativePath = 'renders/instruments/other.wav';
    }],
  ])('rejects %s', (_label, corrupt) => {
    const plan = createValidPlan();
    corrupt(plan);

    expectInvalid(plan);
  });

  it.each([
    ['an audible range that contradicts its events', (plan) => {
      plan.audibleRange.endTick = 1_920;
    }],
    ['a scheduled Track outside the target set', (plan) => {
      plan.tracks[0].trackId = 'track-b';
    }],
    ['an event outside the Plan range', (plan) => {
      plan.tracks[0].events[0].timelineEndTick = plan.endTick + 1;
    }],
    ['non-canonical equal-time event ordering', (plan) => {
      const first = plan.tracks[0].events[0];
      plan.tracks[0].events = [
        { ...first, clipId: 'clip-z' },
        { ...first, clipId: 'clip-a' },
      ];
    }],
  ])('rejects %s', (_label, corrupt) => {
    const plan = createValidPlan();
    corrupt(plan);

    expectInvalid(plan);
  });
});

function createValidPlan(options = {}) {
  const groupTrackId = options.groupTrackId;
  const track = {
    events: [
      {
        clipId: 'clip-a',
        clipName: 'clip-a',
        durationSeconds: 0.5,
        sourceId: 'source-a',
        sourceStartSeconds: 0,
        startOffsetSeconds: 0,
        timelineEndTick: 960,
        timelineStartTick: 0,
      },
    ],
    gainDb: -3,
    ...(groupTrackId ? { groupTrackId } : {}),
    pan: 0.25,
    trackId: 'track-a',
  };
  const mixdownPlan = createTestProjectMixdownPlanV3({
    bpm: 120,
    durationSeconds: 4,
    endTick: 7_680,
    sources: [
      {
        kind: 'generated',
        name: 'source-a.wav',
        relativePath: 'renders/instruments/source-a.wav',
        sizeBytes: 48_044,
        sourceId: 'source-a',
      },
    ],
    tracks: [track],
  });

  return structuredClone({
    ...mixdownPlan,
    audibleRange: { endTick: 960, startTick: 0 },
    purpose: PROJECT_STEM_PRINT_PURPOSE,
    selectedTargets: groupTrackId
      ? [
          {
            groupTrackId,
            kind: 'group',
            resolvedTrackId: 'track-a',
          },
        ]
      : [
          {
            kind: 'channel',
            resolvedTrackId: 'track-a',
            trackId: 'track-a',
          },
        ],
    version: PROJECT_STEM_PRINT_PLAN_VERSION,
  });
}

function expectInvalid(plan) {
  expect(() => parseProjectStemPrintPlan(plan)).toThrow(
    ProjectStemPrintPlanProtocolError,
  );

  try {
    parseProjectStemPrintPlan(plan);
  } catch (error) {
    expect(error).toMatchObject({ code: 'STEM_PRINT_PLAN_INVALID' });
  }
}
