import { describe, expect, it } from 'vitest';

import {
  createCanonicalTimelineExportPlanJson,
  createTimelineExportPlan,
} from './timelineExportPlan';
import {
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';
import type { ProjectState } from './types';

describe('createTimelineExportPlan', () => {
  it('plans one trimmed Audio Clip from its effective source segment with a safe relative filename', () => {
    const project = createPrintMixAudioProject();
    const clip = project.tracks[0].clips[0];
    project.name = '..\\CON';
    clip.name = 'Lead/Take:*?';
    clip.audioTiming = {
      sourceEndSeconds: 0.4,
      sourceStartSeconds: 0.1,
      timeBase: 'absolute-seconds',
    };
    clip.lengthTicks = 480;
    project.selection = { items: [{ id: clip.id, type: 'clip' }] };
    const before = structuredClone(project);
    const result = createTimelineExportPlan(project);

    expect(result).toMatchObject({
      canExport: true,
      plan: {
        durationSeconds: 0.25,
        durationTicks: 480,
        endTick: 1_440,
        fileName: '..-CON-Lead-Take---.wav',
        mediaType: 'audio',
        originTick: 960,
        purpose: 'timeline-export',
        target: { id: clip.id, kind: 'clip' },
      },
    });
    if (!result.canExport || result.plan.mediaType !== 'audio') {
      throw new Error('Missing Audio Clip Timeline Export Plan.');
    }

    expect(result.plan.events).toEqual([
      expect.objectContaining({
        clipId: clip.id,
        durationSeconds: 0.25,
        sourceStartSeconds: 0.1,
        startOffsetSeconds: 0,
      }),
    ]);
    expect(result.plan).not.toHaveProperty('normalize');
    expect(result.plan).not.toHaveProperty('mixer');
    expect(result.plan).not.toHaveProperty('artifactId');
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.events)).toBe(true);
    expect(project).toEqual(before);
  });

  it('plans one Audio Track from tick 0 through its last Clip end with leading silence and overlap', () => {
    const project = createAudioTrackProject();
    const result = createTimelineExportPlan(project);

    expect(result).toMatchObject({
      canExport: true,
      plan: {
        durationSeconds: 1.125,
        durationTicks: 2_160,
        endTick: 2_160,
        mediaType: 'audio',
        originTick: 0,
        target: { id: 'audio-track-1', kind: 'track' },
      },
    });
    if (!result.canExport || result.plan.mediaType !== 'audio') {
      throw new Error('Missing Audio Track Timeline Export Plan.');
    }
    expect(result.plan.events.map(({ clipId, startOffsetSeconds }) => ({
      clipId,
      startOffsetSeconds,
    }))).toEqual([
      { clipId: 'audio-clip-1', startOffsetSeconds: 0.5 },
      { clipId: 'audio-clip-2', startOffsetSeconds: 0.625 },
    ]);
    expect(result.plan.sources).toHaveLength(2);
  });

  it('plans a MIDI Clip relative to its own start while preserving duplicate Notes and excluding timbre', () => {
    const project = createPrintMixMidiProject();
    project.selection = {
      items: [{ id: 'midi-clip-1', type: 'clip' }],
    };
    const result = createTimelineExportPlan(project);

    expect(result).toMatchObject({
      canExport: true,
      plan: {
        durationTicks: 960,
        endTick: 1_920,
        mediaType: 'midi',
        originTick: 960,
      },
    });
    if (!result.canExport || result.plan.mediaType !== 'midi') {
      throw new Error('Missing MIDI Clip Timeline Export Plan.');
    }
    expect(result.plan.notes).toEqual([
      {
        lengthTicks: 480,
        pitch: 60,
        sourceClipId: 'midi-clip-1',
        sourceNoteId: 'source-note-1a',
        startTick: 0,
        velocity: 91,
      },
      {
        lengthTicks: 480,
        pitch: 60,
        sourceClipId: 'midi-clip-1',
        sourceNoteId: 'source-note-1b',
        startTick: 0,
        velocity: 91,
      },
    ]);
    expect(JSON.stringify(result.plan)).not.toMatch(/soundfont|bank|program/i);
  });

  it('plans a MIDI Track at Project tick 0 with gaps, overlaps, and last Clip extent', () => {
    const project = createMidiTrackProject();
    const result = createTimelineExportPlan(project);

    expect(result).toMatchObject({
      canExport: true,
      plan: {
        durationTicks: 2_400,
        endTick: 2_400,
        mediaType: 'midi',
        originTick: 0,
        target: { id: 'midi-track-1', kind: 'track' },
      },
    });
    if (!result.canExport || result.plan.mediaType !== 'midi') {
      throw new Error('Missing MIDI Track Timeline Export Plan.');
    }
    expect(result.plan.notes.map(({ pitch, startTick, lengthTicks, velocity }) => ({
      lengthTicks,
      pitch,
      startTick,
      velocity,
    }))).toEqual([
      { lengthTicks: 480, pitch: 60, startTick: 960, velocity: 91 },
      { lengthTicks: 480, pitch: 60, startTick: 960, velocity: 91 },
      { lengthTicks: 960, pitch: 67, startTick: 1_440, velocity: 73 },
    ]);
    expect(result.plan.sources).toHaveLength(2);
  });

  it('rejects empty, multiple, stale-anchor, ambiguous, mixed-media, empty Track, and unsupported targets', () => {
    const project = createPrintMixAudioProject();

    for (const selection of [
      { items: [] },
      {
        items: [
          { id: 'audio-clip-1', type: 'clip' as const },
          { id: 'audio-clip-2', type: 'clip' as const },
        ],
      },
      {
        anchorItem: { id: 'audio-clip-2', type: 'clip' as const },
        items: [{ id: 'audio-clip-1', type: 'clip' as const }],
      },
      {
        items: [
          { id: 'audio-track-1', type: 'track' as const },
          { id: 'audio-clip-1', type: 'clip' as const },
        ],
      },
    ]) {
      expect(createTimelineExportPlan(project, selection)).toMatchObject({
        canExport: false,
        reason: 'selection-invalid',
      });
    }

    const ambiguous = createPrintMixAudioProject();
    ambiguous.tracks[1].clips[0].id = 'audio-clip-1';
    ambiguous.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    expect(createTimelineExportPlan(ambiguous)).toMatchObject({
      canExport: false,
      reason: 'target-ambiguous',
    });

    const mixed = createAudioTrackProject();
    mixed.tracks[0].clips[1].type = 'midi-notes';
    expect(createTimelineExportPlan(mixed)).toMatchObject({
      canExport: false,
      reason: 'target-mixed-media',
    });

    const empty = createPrintMixAudioProject();
    empty.tracks[0].clips = [];
    empty.selection = { items: [{ id: 'audio-track-1', type: 'track' }] };
    expect(createTimelineExportPlan(empty)).toMatchObject({
      canExport: false,
      reason: 'target-empty',
    });

    const unsupported = createPrintMixAudioProject();
    unsupported.tracks[0].type = 'master';
    unsupported.selection = { items: [{ id: 'audio-track-1', type: 'track' }] };
    expect(createTimelineExportPlan(unsupported)).toMatchObject({
      canExport: false,
      reason: 'target-unsupported',
    });
  });

  it('fails closed on missing, forged, partial, or out-of-span Active Take evidence without mutation', () => {
    const audio = createPrintMixAudioProject();
    audio.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    audio.tracks[0].clips[0].activeClipTakeId = undefined;
    const audioBefore = structuredClone(audio);
    expect(createTimelineExportPlan(audio)).toMatchObject({
      canExport: false,
      reason: 'target-stale',
    });
    expect(audio).toEqual(audioBefore);

    const forged = createPrintMixAudioProject();
    forged.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    const forgedArtifact = forged.artifacts?.[0];
    if (!forgedArtifact || forgedArtifact.kind !== 'audio') {
      throw new Error('Missing forged Audio Artifact fixture.');
    }
    forgedArtifact.file.relativePath = '../escape.wav';
    expect(createTimelineExportPlan(forged)).toMatchObject({
      canExport: false,
      reason: 'target-stale',
    });

    const midi = createPrintMixMidiProject();
    midi.selection = { items: [{ id: 'midi-clip-1', type: 'clip' }] };
    const midiArtifact = midi.artifacts?.[0];
    if (!midiArtifact || midiArtifact.kind !== 'midi') {
      throw new Error('Missing MIDI Artifact fixture.');
    }
    midiArtifact.midi.notes[0].lengthTicks = 1_200;
    expect(createTimelineExportPlan(midi)).toMatchObject({
      canExport: false,
      reason: 'target-stale',
    });
  });

  it('creates deterministic canonical identity without Project mutation', () => {
    const project = createMidiTrackProject();
    const before = structuredClone(project);
    const first = createTimelineExportPlan(project);
    const second = createTimelineExportPlan(project);
    if (!first.canExport || !second.canExport) {
      throw new Error('Missing deterministic Timeline Export Plans.');
    }

    expect(createCanonicalTimelineExportPlanJson(first.plan)).toBe(
      createCanonicalTimelineExportPlanJson(second.plan),
    );
    expect(project).toEqual(before);
  });

  it('does not depend on Mixer state, Track faders/mutes, or MIDI timbre metadata', () => {
    const audio = createAudioTrackProject();
    const firstAudio = createTimelineExportPlan(audio);
    audio.tracks[0].level = 12;
    audio.tracks[0].muted = true;
    audio.tracks[0].parentGroupId = 'group-a';
    if (audio.mixer) {
      audio.mixer = {
        ...audio.mixer,
        channels: audio.mixer.channels.map((channel) =>
          channel.trackId === 'audio-track-1'
            ? { ...channel, faderDb: -48, muted: true, pan: 1 }
            : channel,
        ),
      };
    }
    const secondAudio = createTimelineExportPlan(audio);
    if (!firstAudio.canExport || !secondAudio.canExport) {
      throw new Error('Missing Mixer-independent Audio Plans.');
    }
    expect(createCanonicalTimelineExportPlanJson(secondAudio.plan)).toBe(
      createCanonicalTimelineExportPlanJson(firstAudio.plan),
    );

    const midi = createMidiTrackProject();
    const firstMidi = createTimelineExportPlan(midi);
    const assignment = midi.tracks[0].clips[0].soundFont;
    if (!assignment) {
      throw new Error('Missing MIDI timbre fixture.');
    }
    assignment.bank = 127;
    assignment.program = 99;
    const secondMidi = createTimelineExportPlan(midi);
    if (!firstMidi.canExport || !secondMidi.canExport) {
      throw new Error('Missing timbre-independent MIDI Plans.');
    }
    expect(createCanonicalTimelineExportPlanJson(secondMidi.plan)).toBe(
      createCanonicalTimelineExportPlanJson(firstMidi.plan),
    );
  });
});

function createAudioTrackProject(): ProjectState {
  const project = createPrintMixAudioProject();
  const secondClip = project.tracks[1].clips[0];
  secondClip.startTick = 1_200;
  project.tracks[0].clips.push(secondClip);
  project.tracks[1].clips = [];
  project.selection = { items: [{ id: 'audio-track-1', type: 'track' }] };
  return project;
}

function createMidiTrackProject(): ProjectState {
  const project = createPrintMixMidiProject();
  const secondClip = project.tracks[1].clips[0];
  secondClip.startTick = 1_440;
  project.tracks[0].clips.push(secondClip);
  project.tracks[1].clips = [];
  project.selection = { items: [{ id: 'midi-track-1', type: 'track' }] };
  return project;
}
