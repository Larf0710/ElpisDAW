import { describe, expect, it } from 'vitest';

import { timelineTicksToSeconds } from './audioClipTiming';
import {
  resolveGroupPlaybackTrack,
  resolvePlaybackTarget,
  type PlaybackTarget,
  type PlaybackTargetResolution,
} from './playbackTarget';
import {
  createProjectPlaybackPlan,
  type ProjectPlaybackPlan,
  type ProjectPlaybackPlanAvailability,
  type ProjectPlaybackPlanInput,
  type SourceAvailabilitySnapshot,
} from './projectPlaybackPlan';
import {
  createDefaultMixerChannelInsertChain,
  createDefaultMixerMasterInsertChain,
  PROJECT_MIXER_MASTER_BUS_ID,
  PROJECT_MIXER_STATE_VERSION,
} from './projectMixerState';
import type {
  Clip,
  ClipSourceFileStatus,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectMixerStateV2,
  SelectionItem,
  SelectionState,
  Track,
} from './types';
import { TICKS_PER_BEAT } from './workflow';

const bpm = 120;
const projectEndTick = TICKS_PER_BEAT * 8;

describe('resolvePlaybackTarget', () => {
  it('targets ALL when the Project selection is empty', () => {
    expect(requireTarget(resolvePlaybackTarget([], selection()))).toEqual({ kind: 'all' });
  });

  it('targets one selected Clip', () => {
    const clip = audioClip('clip-a');
    const tracks = [audioTrack('track-a', [clip])];

    expect(requireTarget(resolvePlaybackTarget(tracks, selection({ type: 'clip', id: clip.id })))).toEqual({
      kind: 'clip',
      clipId: clip.id,
    });
  });

  it('targets one or multiple selected Tracks', () => {
    const tracks = [audioTrack('track-a'), audioTrack('track-b')];

    expect(requireTarget(resolvePlaybackTarget(tracks, selection({ type: 'track', id: 'track-a' })))).toEqual({
      kind: 'track',
      trackId: 'track-a',
    });
    expect(
      requireTarget(
        resolvePlaybackTarget(
          tracks,
          selection({ type: 'track', id: 'track-a' }, { type: 'track', id: 'track-b' }),
        ),
      ),
    ).toEqual({ kind: 'tracks', trackIds: ['track-a', 'track-b'] });
  });

  it('targets the deterministic bottom child for one or multiple Groups', () => {
    const bassMidi = audioTrack('bass-midi', [], { parentGroupId: 'group-bass' });
    const bassAudio = audioTrack('bass-audio', [], { parentGroupId: 'group-bass' });
    const vocalGuide = audioTrack('vocal-guide', [], { parentGroupId: 'group-vocal' });
    const vocalAudio = audioTrack('vocal-audio', [], { parentGroupId: 'group-vocal' });
    const bassGroup = groupTrack('group-bass', [bassMidi.id, bassAudio.id], bassAudio.id);
    const vocalGroup = groupTrack('group-vocal', [vocalGuide.id, vocalAudio.id], vocalAudio.id);
    const tracks = [bassMidi, bassAudio, bassGroup, vocalGuide, vocalAudio, vocalGroup];

    expect(requireTarget(resolvePlaybackTarget(tracks, selection({ type: 'track', id: bassGroup.id })))).toEqual({
      kind: 'group',
      activeTrackId: bassAudio.id,
      groupTrackId: bassGroup.id,
    });
    expect(
      requireTarget(
        resolvePlaybackTarget(
          tracks,
          selection({ type: 'track', id: bassGroup.id }, { type: 'track', id: vocalGroup.id }),
        ),
      ),
    ).toEqual({
      kind: 'groups',
      activeTrackIds: [bassAudio.id, vocalAudio.id],
      groupTrackIds: [bassGroup.id, vocalGroup.id],
    });
  });

  it('locks multiple Clip and mixed-type selections', () => {
    const clipA = audioClip('clip-a');
    const clipB = audioClip('clip-b');
    const child = audioTrack('child', [], { parentGroupId: 'group-a' });
    const group = groupTrack('group-a', [child.id], child.id);
    const track = audioTrack('track-a', [clipA, clipB]);
    const tracks = [track, child, group];
    const multipleClips = resolvePlaybackTarget(
      tracks,
      selection({ type: 'clip', id: clipA.id }, { type: 'clip', id: clipB.id }),
    );
    const mixedClipTrack = resolvePlaybackTarget(
      tracks,
      selection({ type: 'clip', id: clipA.id }, { type: 'track', id: track.id }),
    );
    const mixedTrackGroup = resolvePlaybackTarget(
      tracks,
      selection({ type: 'track', id: track.id }, { type: 'track', id: group.id }),
    );

    expect(requireTargetFailure(multipleClips).reason).toBe('multiple-clips');
    expect(requireTargetFailure(mixedClipTrack).reason).toBe('mixed-selection');
    expect(requireTargetFailure(mixedTrackGroup).reason).toBe('mixed-selection');
  });
});

describe('resolveGroupPlaybackTrack', () => {
  it('rejects a missing child and stale stored active Track', () => {
    const first = audioTrack('first', [], { parentGroupId: 'group-a' });
    const second = audioTrack('second', [], { parentGroupId: 'group-a' });
    const group = groupTrack('group-a', [first.id, 'deleted-child', second.id], first.id);
    const result = resolveGroupPlaybackTrack(group, [first, second, group]);

    expect(result.canResolve).toBe(false);
    if (result.canResolve) throw new Error('Expected Group resolution to fail.');
    expect(result.reason).toBe('invalid-topology');
  });

  it('follows reordered child IDs deterministically', () => {
    const first = audioTrack('first', [], { parentGroupId: 'group-a' });
    const second = audioTrack('second', [], { parentGroupId: 'group-a' });
    const group = groupTrack('group-a', [second.id, first.id], first.id);
    const result = resolveGroupPlaybackTrack(group, [second, first, group]);

    expect(result.canResolve).toBe(true);
    if (!result.canResolve) {
      throw new Error(result.message);
    }
    expect(result.activeTrack.id).toBe(first.id);
  });

  it('fails when a Group has no valid child Track', () => {
    const group = groupTrack('group-a', ['missing-child'], 'missing-child');
    const result = resolveGroupPlaybackTrack(group, [group]);

    expect(result.canResolve).toBe(false);
    if (result.canResolve) {
      throw new Error('Expected Group resolution to fail.');
    }
    expect(result.reason).toBe('invalid-topology');
  });
});

describe('createProjectPlaybackPlan', () => {
  it('uses Group bottom Tracks and playable ungrouped Tracks for ALL Playback', () => {
    const upstreamClip = audioClip('upstream-clip', 0, TICKS_PER_BEAT, 'source-upstream');
    const activeClip = audioClip('active-clip', 0, TICKS_PER_BEAT, 'source-active');
    const looseClip = audioClip('loose-clip', TICKS_PER_BEAT, TICKS_PER_BEAT, 'source-loose');
    const upstream = audioTrack('upstream', [upstreamClip], { parentGroupId: 'group-a' });
    const active = audioTrack('active', [activeClip], { parentGroupId: 'group-a' });
    const group = groupTrack('group-a', [upstream.id, active.id], active.id);
    const loose = audioTrack('loose', [looseClip]);
    const plan = requirePlan(
      createPlan({
        sourceAvailability: openSources('source-upstream', 'source-active', 'source-loose'),
        tracks: [upstream, active, group, loose],
      }),
    );

    expect(plan.tracks.map((track) => track.trackId)).toEqual(['active', 'loose']);
    expect(plan.tracks[0].groupTrackId).toBe(group.id);
    expect(plan.tracks.flatMap((track) => track.clips.map((clip) => clip.clipId))).not.toContain(upstreamClip.id);
  });

  it('plays only top-level roots for ALL while inner and outer Group selection resolve one leaf', () => {
    const leaf = audioTrack(
      'nested-leaf',
      [audioClip('nested-clip', 0, TICKS_PER_BEAT, 'nested-source')],
      { parentGroupId: 'inner-group' },
    );
    const inner = {
      ...groupTrack('inner-group', [leaf.id], leaf.id),
      parentGroupId: 'outer-group',
    };
    const outer = groupTrack('outer-group', [inner.id], inner.id);
    const tracks = [leaf, inner, outer];
    const sourceAvailability = openSources('nested-source');
    const allPlan = requirePlan(createPlan({ sourceAvailability, tracks }));
    const innerPlan = requirePlan(createPlan({
      purpose: 'selection-playback',
      selection: selection({ type: 'track', id: inner.id }),
      sourceAvailability,
      tracks,
    }));
    const outerPlan = requirePlan(createPlan({
      purpose: 'selection-playback',
      selection: selection({ type: 'track', id: outer.id }),
      sourceAvailability,
      tracks,
    }));

    expect(allPlan.tracks).toHaveLength(1);
    expect(allPlan.tracks[0]).toMatchObject({
      groupTrackId: outer.id,
      trackId: leaf.id,
    });
    expect(innerPlan.tracks[0]).toMatchObject({
      groupTrackId: inner.id,
      trackId: leaf.id,
    });
    expect(outerPlan.tracks[0]).toMatchObject({
      groupTrackId: outer.id,
      trackId: leaf.id,
    });
  });

  it('respects Mute for ALL Playback and Mixdown', () => {
    const muted = audioTrack('muted', [audioClip('muted-clip', 0, TICKS_PER_BEAT, 'source-muted')], {
      muted: true,
    });
    const audible = audioTrack('audible', [audioClip('audible-clip', 0, TICKS_PER_BEAT, 'source-audible')]);
    const sourceAvailability = openSources('source-muted', 'source-audible');
    const allPlan = requirePlan(createPlan({ sourceAvailability, tracks: [muted, audible] }));
    const mixdownPlan = requirePlan(
      createPlan({ purpose: 'mixdown', sourceAvailability, tracks: [muted, audible] }),
    );

    expect(allPlan.tracks.map((track) => track.trackId)).toEqual(['audible']);
    expect(mixdownPlan.tracks.map((track) => track.trackId)).toEqual(['audible']);
  });

  it('shares one immutable Mixer snapshot and evaluates Solo from Mixer authority', () => {
    const vocal = audioTrack(
      'vocal',
      [audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'source-vocal')],
      { level: 12, muted: true },
    );
    const drums = audioTrack(
      'drums',
      [audioClip('drums-clip', 0, TICKS_PER_BEAT, 'source-drums')],
    );
    const mixer = createMixer([
      {
        ...createMixerChannel(vocal.id),
        faderDb: -4,
        muted: false,
        pan: -0.5,
        solo: true,
      },
      {
        ...createMixerChannel(drums.id),
        faderDb: 3,
        pan: 0.75,
      },
    ], -2);
    const plan = requirePlan(
      createPlan({
        mixer,
        sourceAvailability: openSources('source-vocal', 'source-drums'),
        tracks: [vocal, drums],
      }),
    );

    expect(plan.tracks.map(({ gainDb, pan, trackId }) => ({ gainDb, pan, trackId }))).toEqual([
      { gainDb: -4, pan: -0.5, trackId: vocal.id },
    ]);
    expect(plan.mixerSnapshot).toEqual(mixer);
    expect(Object.isFrozen(plan.mixerSnapshot)).toBe(true);
    expect(Object.isFrozen(plan.mixerSnapshot.channels[0])).toBe(true);
    expect(Object.isFrozen(plan.mixerSnapshot.master)).toBe(true);
  });

  it('fails closed before source planning when Mixer state is incomplete', () => {
    const track = audioTrack(
      'vocal',
      [audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'source-vocal')],
    );
    const failure = requirePlanFailure(
      createPlan({
        mixer: createMixer([]),
        sourceAvailability: openSources('source-vocal'),
        tracks: [track],
      }),
    );

    expect(failure.reason).toBe('mixer-state-invalid');
    expect(failure.sourceIssues).toEqual([]);
  });

  it.each(['all-playback', 'selection-playback'] as const)(
    'freezes validated enabled effects for the next %s operation',
    (purpose) => {
      const track = audioTrack(
        'vocal',
        [audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'source-vocal')],
      );
      const mixer = createMixer([createMixerChannel(track.id)]);
      const channel = mixer.channels[0];
      const enabledMixer: ProjectMixerStateV2 = {
        ...mixer,
        channels: [{
          ...channel,
          inserts: [
            { ...channel.inserts[0], bypass: false },
            channel.inserts[1],
            channel.inserts[2],
          ],
        }],
      };
      const plan = requirePlan(
        createPlan({
          mixer: enabledMixer,
          purpose,
          selection: purpose === 'selection-playback'
            ? selection({ type: 'track', id: track.id })
            : selection(),
          sourceAvailability: openSources('source-vocal'),
          tracks: [track],
        }),
      );

      expect(plan.mixerSnapshot.schemaVersion).toBe(2);
      expect(plan.mixerSnapshot.channels[0]?.inserts[0]?.bypass).toBe(false);
      expect(Object.isFrozen(plan.mixerSnapshot.channels[0]?.inserts[0])).toBe(true);
    },
  );

  it('uses the same enabled Snapshot v2 contract for Mixdown planning', () => {
    const track = audioTrack(
      'vocal',
      [audioClip('vocal-clip', 0, TICKS_PER_BEAT, 'source-vocal')],
    );
    const mixer = createMixer([createMixerChannel(track.id)]);
    const channel = mixer.channels[0];
    const enabledMixer: ProjectMixerStateV2 = {
      ...mixer,
      channels: [{
        ...channel,
        inserts: [
          { ...channel.inserts[0], bypass: false },
          channel.inserts[1],
          channel.inserts[2],
        ],
      }],
    };

    const plan = requirePlan(createPlan({
      mixer: enabledMixer,
      purpose: 'mixdown',
      sourceAvailability: openSources('source-vocal'),
      tracks: [track],
    }));

    expect(plan.mixerSnapshot.schemaVersion).toBe(2);
    expect(plan.mixerSnapshot.channels[0]?.inserts[0]?.bypass).toBe(false);
  });

  it('ignores Mute but preserves Fader, Pan, and Master balance for Selection Playback', () => {
    const track = audioTrack('track-a', [audioClip('clip-a', 0, TICKS_PER_BEAT, 'source-a')], {
      level: -12,
      muted: true,
    });
    const plan = requirePlan(
      createPlan({
        mixer: createMixer([
          {
            ...createMixerChannel(track.id),
            faderDb: -12,
            muted: true,
            pan: 0.25,
          },
        ], -1),
        purpose: 'selection-playback',
        selection: selection({ type: 'track', id: track.id }),
        sourceAvailability: openSources('source-a'),
        tracks: [track],
      }),
    );

    expect(plan.tracks[0]).toMatchObject({
      gainDb: -12,
      pan: 0.25,
      trackId: track.id,
      trackMuted: true,
    });
    expect(plan.mixerSnapshot.master.faderDb).toBe(-1);
  });

  it('uses the active child Mute as the Group proxy policy', () => {
    const upstream = audioTrack(
      'upstream',
      [audioClip('upstream-clip', 0, TICKS_PER_BEAT, 'source-upstream')],
      { parentGroupId: 'group-a' },
    );
    const active = audioTrack(
      'active',
      [audioClip('active-clip', 0, TICKS_PER_BEAT, 'source-active')],
      { muted: true, parentGroupId: 'group-a' },
    );
    const group = groupTrack('group-a', [upstream.id, active.id], active.id);
    const loose = audioTrack('loose', [audioClip('loose-clip', 0, TICKS_PER_BEAT, 'source-loose')]);
    const sourceAvailability = openSources('source-upstream', 'source-active', 'source-loose');
    const allPlan = requirePlan(
      createPlan({ sourceAvailability, tracks: [upstream, active, group, loose] }),
    );
    const groupSelectionPlan = requirePlan(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'track', id: group.id }),
        sourceAvailability,
        tracks: [upstream, active, group, loose],
      }),
    );

    expect(allPlan.tracks.map((track) => track.trackId)).toEqual([loose.id]);
    expect(groupSelectionPlan.tracks[0]).toMatchObject({
      groupTrackId: group.id,
      trackId: active.id,
      trackMuted: true,
    });
  });

  it('locks selected Clips and Tracks without playable source-backed audio', () => {
    const midiClip = nonAudioClip('midi-clip');
    const midiTrack = audioTrack('midi-track', [midiClip], { type: 'midi' });
    const clipFailure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: midiClip.id }),
        tracks: [midiTrack],
      }),
    );
    const trackFailure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'track', id: midiTrack.id }),
        tracks: [midiTrack],
      }),
    );

    expect(clipFailure.reason).toBe('target-unplayable');
    expect(trackFailure.reason).toBe('target-unplayable');
  });

  it('plans an assigned MIDI Clip from a ready session playback cache', () => {
    const midiClip = nonAudioClip('midi-clip');
    const midiTrack = audioTrack('midi-track', [midiClip], { type: 'midi' });
    const plan = requirePlan(
      createPlan({
        midiPlaybackSources: {
          [midiClip.id]: {
            durationSeconds: 1,
            lengthTicks: TICKS_PER_BEAT,
            name: 'MIDI Clip / Piano.wav',
            sourceId: 'midi-cache:clip-a',
            status: 'READY',
          },
        },
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: midiClip.id }),
        sourceAvailability: { 'midi-cache:clip-a': 'openable' },
        tracks: [midiTrack],
      }),
    );

    expect(plan.tracks[0].clips[0]).toMatchObject({
      clipId: midiClip.id,
      sourceEndSeconds: 0.5,
      sourceId: 'midi-cache:clip-a',
      sourceStartSeconds: 0,
      timelineEndTick: TICKS_PER_BEAT,
    });
  });

  it('reports an assigned MIDI Clip cache failure as an unavailable source', () => {
    const midiClip = nonAudioClip('midi-clip');
    const midiTrack = audioTrack('midi-track', [midiClip], { type: 'midi' });
    const failure = requirePlanFailure(
      createPlan({
        midiPlaybackSources: {
          [midiClip.id]: {
            message: 'SoundFont is offline.',
            status: 'UNAVAILABLE',
          },
        },
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: midiClip.id }),
        tracks: [midiTrack],
      }),
    );

    expect(failure.reason).toBe('source-unavailable');
    expect(failure.sourceIssues[0]).toMatchObject({
      clipIds: [midiClip.id],
      reason: 'midi-playback-unavailable',
    });
  });

  it('locks a multi-Track selection when one explicit Track is not playable', () => {
    const audio = audioTrack('audio', [audioClip('audio-clip', 0, TICKS_PER_BEAT, 'source-a')]);
    const empty = audioTrack('empty');
    const failure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'track', id: audio.id }, { type: 'track', id: empty.id }),
        sourceAvailability: openSources('source-a'),
        tracks: [audio, empty],
      }),
    );

    expect(failure.reason).toBe('target-unplayable');
    expect(failure.message).toContain('1 selected target has no playable material');
  });

  it('skips unresolved sources during ALL Playback and counts shared sources once', () => {
    const missingA = audioClip('missing-a', 0, TICKS_PER_BEAT, 'shared-source');
    const missingB = audioClip('missing-b', TICKS_PER_BEAT, TICKS_PER_BEAT, 'shared-source');
    const available = audioClip('available', 0, TICKS_PER_BEAT, 'available-source');
    const plan = requirePlan(
      createPlan({
        sourceAvailability: { 'available-source': 'openable', 'shared-source': 'unopenable' },
        tracks: [audioTrack('missing-track', [missingA, missingB]), audioTrack('available-track', [available])],
      }),
    );

    expect(plan.isIncomplete).toBe(true);
    expect(plan.missingSourceCount).toBe(1);
    expect(plan.sourceIssues[0].clipIds).toEqual([missingA.id, missingB.id]);
    expect(plan.tracks.map((track) => track.trackId)).toEqual(['available-track']);
  });

  it('blocks Selection Playback and Mixdown when a required source is unavailable', () => {
    const missing = audioClip('missing', 0, TICKS_PER_BEAT, 'missing-source');
    const available = audioClip('available', 0, TICKS_PER_BEAT, 'available-source');
    const tracks = [audioTrack('missing-track', [missing]), audioTrack('available-track', [available])];
    const sourceAvailability: SourceAvailabilitySnapshot = {
      'available-source': 'openable',
      'missing-source': 'unopenable',
    };
    const selectionFailure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'track', id: 'missing-track' }),
        sourceAvailability,
        tracks,
      }),
    );
    const mixdownFailure = requirePlanFailure(
      createPlan({ purpose: 'mixdown', sourceAvailability, tracks }),
    );

    expect(selectionFailure.reason).toBe('source-unavailable');
    expect(mixdownFailure.reason).toBe('source-unavailable');
  });

  it('does not require sources belonging only to muted Mixdown Tracks', () => {
    const mutedMissing = audioTrack(
      'muted-missing',
      [audioClip('missing', 0, TICKS_PER_BEAT, 'missing-source')],
      { muted: true },
    );
    const available = audioTrack('available', [audioClip('available', 0, TICKS_PER_BEAT, 'available-source')]);
    const plan = requirePlan(
      createPlan({
        purpose: 'mixdown',
        sourceAvailability: { 'available-source': 'openable', 'missing-source': 'unopenable' },
        tracks: [mutedMissing, available],
      }),
    );

    expect(plan.missingSourceCount).toBe(0);
    expect(plan.tracks.map((track) => track.trackId)).toEqual([available.id]);
  });

  it('ignores temporary UI selection when building a Project Mixdown Plan', () => {
    const first = audioTrack('first', [audioClip('first-clip', 0, TICKS_PER_BEAT, 'source-first')]);
    const second = audioTrack('second', [audioClip('second-clip', 0, TICKS_PER_BEAT, 'source-second')]);
    const plan = requirePlan(
      createPlan({
        purpose: 'mixdown',
        selection: selection({ type: 'track', id: first.id }),
        sourceAvailability: openSources('source-first', 'source-second'),
        tracks: [first, second],
      }),
    );

    expect(plan.target).toEqual({ kind: 'all' });
    expect(plan.tracks.map((track) => track.trackId)).toEqual([first.id, second.id]);
  });

  it('treats moved metadata and absent runtime snapshots as unavailable', () => {
    const moved = audioClip('moved', 0, TICKS_PER_BEAT, 'moved-source', 'moved');
    const unknown = audioClip('unknown', 0, TICKS_PER_BEAT, 'unknown-source');
    const movedFailure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: moved.id }),
        sourceAvailability: openSources('moved-source'),
        tracks: [audioTrack('moved-track', [moved])],
      }),
    );
    const unknownFailure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: unknown.id }),
        tracks: [audioTrack('unknown-track', [unknown])],
      }),
    );

    expect(movedFailure.sourceIssues[0].reason).toBe('metadata-moved');
    expect(unknownFailure.sourceIssues[0].reason).toBe('runtime-unknown');
  });

  it('reports a missing source identity without consulting the runtime snapshot', () => {
    const clip = audioClip('missing-id');
    if (!clip.sourceFile) {
      throw new Error('Expected source metadata.');
    }
    delete clip.sourceFile.sourceId;
    const failure = requirePlanFailure(
      createPlan({
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: clip.id }),
        tracks: [audioTrack('track-a', [clip])],
      }),
    );

    expect(failure.reason).toBe('source-unavailable');
    expect(failure.sourceIssues[0]).toMatchObject({ key: `clip:${clip.id}`, reason: 'source-id-missing' });
  });

  it('applies selected-target Playhead rules and trimmed source offsets', () => {
    const clip = audioClip('clip-a', TICKS_PER_BEAT, TICKS_PER_BEAT * 2, 'source-a', 'available', 2);
    const track = audioTrack('track-a', [clip]);
    const baseInput: Partial<ProjectPlaybackPlanInput> = {
      purpose: 'selection-playback',
      selection: selection({ type: 'clip', id: clip.id }),
      sourceAvailability: openSources('source-a'),
      tracks: [track],
    };
    const before = requirePlan(createPlan({ ...baseInput, playheadTick: 0 }));
    const inside = requirePlan(createPlan({ ...baseInput, playheadTick: TICKS_PER_BEAT * 2 }));
    const after = requirePlan(createPlan({ ...baseInput, playheadTick: TICKS_PER_BEAT * 3 }));

    expect(before.startTick).toBe(TICKS_PER_BEAT);
    expect(inside.startTick).toBe(TICKS_PER_BEAT * 2);
    expect(inside.tracks[0].clips[0].sourceStartSeconds).toBeCloseTo(2.5, 6);
    expect(after.startTick).toBe(TICKS_PER_BEAT);
  });

  it('preserves gaps, stops ALL Playback at Project end, and restarts from the end', () => {
    const first = audioClip('first', TICKS_PER_BEAT, TICKS_PER_BEAT, 'source-first');
    const second = audioClip('second', TICKS_PER_BEAT * 4, TICKS_PER_BEAT, 'source-second');
    const track = audioTrack('track-a', [first, second]);
    const sourceAvailability = openSources('source-first', 'source-second');
    const gapPlan = requirePlan(
      createPlan({ playheadTick: TICKS_PER_BEAT * 3, sourceAvailability, tracks: [track] }),
    );
    const restartPlan = requirePlan(
      createPlan({ playheadTick: projectEndTick, sourceAvailability, tracks: [track] }),
    );

    expect(gapPlan.startTick).toBe(TICKS_PER_BEAT * 3);
    expect(gapPlan.endTick).toBe(projectEndTick);
    expect(gapPlan.tracks[0].clips.map((clip) => clip.clipId)).toEqual([second.id]);
    expect(restartPlan.startTick).toBe(0);
  });

  it('resolves an Active Audio Take into the immutable Playback Plan', () => {
    const fixture = activeAudioTakeFixture();
    const plan = requirePlan(
      createPlan({
        artifacts: [fixture.artifact],
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: fixture.clip.id }),
        sourceAvailability: openSources(fixture.artifact.artifactId),
        tracks: [fixture.track],
      }),
    );

    expect(plan.generatedSources).toEqual([
      {
        kind: 'generated',
        name: fixture.artifact.file.name,
        relativePath: fixture.artifact.file.relativePath,
        sizeBytes: fixture.artifact.file.sizeBytes,
        sourceId: fixture.artifact.artifactId,
      },
    ]);
    expect(plan.tracks[0].clips[0]).toMatchObject({
      clipId: fixture.clip.id,
      sourceEndSeconds: 1,
      sourceId: fixture.artifact.artifactId,
      sourceStartSeconds: 0,
    });
    expect(fixture.clip.sourceFile?.sourceId).toBe('stale-legacy-source');
  });

  it('does not fall back to legacy sourceFile when the Active Take is unresolved', () => {
    const fixture = activeAudioTakeFixture();
    const failure = requirePlanFailure(
      createPlan({
        artifacts: [],
        purpose: 'selection-playback',
        selection: selection({ type: 'clip', id: fixture.clip.id }),
        sourceAvailability: openSources(
          fixture.artifact.artifactId,
          'stale-legacy-source',
        ),
        tracks: [fixture.track],
      }),
    );

    expect(failure).toMatchObject({
      reason: 'source-unavailable',
      sourceIssues: [
        {
          clipIds: [fixture.clip.id],
          key: `active-take:${fixture.clip.id}`,
          reason: 'active-take-unresolved',
        },
      ],
    });
  });

  it('snapshots selection, Gain, Mute, and Clip timing by value', () => {
    const clip = audioClip('clip-a', 0, TICKS_PER_BEAT, 'source-a');
    const track = audioTrack('track-a', [clip], { level: -9, muted: true });
    const projectSelection = selection({ type: 'track', id: track.id });
    const plan = requirePlan(
      createPlan({
        purpose: 'selection-playback',
        selection: projectSelection,
        sourceAvailability: openSources('source-a'),
        tracks: [track],
      }),
    );

    track.level = 3;
    track.muted = false;
    clip.startTick = TICKS_PER_BEAT * 4;
    projectSelection.items = [];

    expect(plan.target).toEqual({ kind: 'track', trackId: track.id });
    expect(plan.tracks[0]).toMatchObject({ gainDb: -9, trackMuted: true });
    expect(plan.tracks[0].clips[0].originalClipStartTick).toBe(0);
  });
});

function createPlan(overrides: Partial<ProjectPlaybackPlanInput>): ProjectPlaybackPlanAvailability {
  return createProjectPlaybackPlan({
    bpm,
    playheadTick: 0,
    projectEndTick,
    purpose: 'all-playback',
    selection: selection(),
    sourceAvailability: {},
    tracks: [],
    ...overrides,
  });
}

function requireTarget(result: PlaybackTargetResolution): PlaybackTarget {
  if (!result.canTarget) {
    throw new Error(result.message);
  }

  return result.target;
}

function requireTargetFailure(
  result: PlaybackTargetResolution,
): Extract<PlaybackTargetResolution, { canTarget: false }> {
  if (result.canTarget) {
    throw new Error(`Expected target resolution to fail, received ${result.target.kind}.`);
  }

  return result;
}

function requirePlan(result: ProjectPlaybackPlanAvailability): ProjectPlaybackPlan {
  if (!result.canPlay) {
    throw new Error(result.message);
  }

  return result.plan;
}

function requirePlanFailure(
  result: ProjectPlaybackPlanAvailability,
): Extract<ProjectPlaybackPlanAvailability, { canPlay: false }> {
  if (result.canPlay) {
    throw new Error(`Expected Playback Plan to fail, received ${result.plan.target.kind}.`);
  }

  return result;
}

function selection(...items: SelectionItem[]): SelectionState {
  return { items };
}

function audioClip(
  id: string,
  startTick = 0,
  lengthTicks = TICKS_PER_BEAT * 2,
  sourceId = `source-${id}`,
  status: ClipSourceFileStatus = 'available',
  sourceStartSeconds = 0,
): Clip {
  const sourceLengthSeconds = timelineTicksToSeconds(lengthTicks, bpm);
  const sourceEndSeconds = sourceStartSeconds + sourceLengthSeconds;

  return {
    id,
    type: 'hum-audio',
    name: id,
    startTick,
    lengthTicks,
    color: '#5e8fb8',
    sourceFile: {
      durationSeconds: sourceEndSeconds + 5,
      name: `${sourceId}.wav`,
      sourceId,
      status,
    },
    audioTiming: {
      timeBase: 'absolute-seconds',
      sourceStartSeconds,
      sourceEndSeconds,
    },
    createdAt: '2026-07-22T00:00:00.000Z',
    version: 1,
  };
}

function nonAudioClip(id: string): Clip {
  return {
    id,
    type: 'midi-notes',
    name: id,
    startTick: 0,
    lengthTicks: TICKS_PER_BEAT,
    color: '#999999',
    createdAt: '2026-07-22T00:00:00.000Z',
    version: 1,
  };
}

function audioTrack(
  id: string,
  clips: Clip[] = [],
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    name: id,
    type: 'audio',
    level: -6,
    clips,
    parentGroupId: null,
    ...overrides,
  };
}

function groupTrack(
  id: string,
  childTrackIds: string[],
  activePlaybackTrackId: string,
): Track {
  return {
    id,
    name: id,
    type: 'group',
    level: 0,
    clips: [],
    parentGroupId: null,
    group: {
      activePlaybackTrackId,
      childTrackIds,
      collapsed: true,
      playbackMode: 'bottom_child',
    },
  };
}

function createMixerChannel(
  trackId: string,
): ProjectMixerStateV2['channels'][number] {
  return {
    faderDb: 0,
    inserts: createDefaultMixerChannelInsertChain(),
    muted: false,
    outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
    pan: 0,
    solo: false,
    trackId,
  };
}

function createMixer(
  channels: ProjectMixerStateV2['channels'],
  masterFaderDb = 0,
): ProjectMixerStateV2 {
  return {
    channels,
    master: {
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: masterFaderDb,
      inserts: createDefaultMixerMasterInsertChain(),
    },
    schemaVersion: PROJECT_MIXER_STATE_VERSION,
  };
}

function openSources(...sourceIds: string[]): SourceAvailabilitySnapshot {
  return Object.fromEntries(sourceIds.map((sourceId) => [sourceId, 'openable']));
}

function activeAudioTakeFixture(): {
  artifact: GeneratedAudioArtifact;
  clip: Clip;
  track: Track;
} {
  const artifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-active-audio',
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-26T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-active-audio.wav',
      relativePath: 'renders/instruments/artifact-active-audio.wav',
      sizeBytes: 48_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi'],
      parentClipTakeIds: ['clip-take-midi'],
    },
    provenance: {
      modelId: 'mock-model',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-active-audio',
  };
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-active-audio',
    createdAt: artifact.createdAt,
    label: 'Active Audio Take',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  const clip: Clip = {
    activeClipTakeId: take.clipTakeId,
    clipTakes: [take],
    color: '#8dff6b',
    createdAt: artifact.createdAt,
    id: 'clip-active-audio',
    lengthTicks: TICKS_PER_BEAT * 2,
    name: 'Active Audio',
    sourceFile: {
      durationSeconds: 1,
      name: 'stale.wav',
      sourceId: 'stale-legacy-source',
      status: 'available',
    },
    startTick: 0,
    type: 'instrument-audio',
    version: 1,
  };

  return {
    artifact,
    clip,
    track: audioTrack('track-active-audio', [clip]),
  };
}
