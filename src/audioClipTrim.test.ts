import { describe, expect, it } from 'vitest';
import { createAudioClipLeftTrimUpdate } from './audioClipTrim';
import { secondsToTimelineTicks, timelineTicksToSeconds } from './audioClipTiming';
import { createPrintMixAudioProject } from './printMixTestFixture';
import type { ProjectState } from './types';

describe('Audio Clip left-trim source precision', () => {
  it.each([
    [120, 470_528], [120, 470_538], [137, 470_528], [137, 470_538],
  ])('preserves a full source through no-op and round-trip trims at BPM %i with %i frames', (bpm, frames) => {
    const project = createFixture(bpm, frames);
    const clip = project.tracks[0].clips[0];
    const before = structuredClone(project);
    const noop = trim(project, clip.startTick);
    expect(noop.clip.audioTiming).toEqual(clip.audioTiming);
    const shortened = trim(project, clip.startTick + 480);
    expect(shortened.clip.audioTiming.sourceStartSeconds).toBe(timelineTicksToSeconds(480, bpm));
    expect(shortened.clip.audioTiming.sourceEndSeconds).toBe(frames / 48_000);
    expect(shortened.clip.startTick + shortened.clip.lengthTicks).toBe(clip.startTick + clip.lengthTicks);
    const restored = trim({ ...project, tracks: shortened.tracks }, clip.startTick);
    expect(restored.clip.audioTiming).toEqual(clip.audioTiming);
    expect(restored.clip.lengthTicks).toBe(clip.lengthTicks);
    expect(restored.clip.clipTakes).toBe(clip.clipTakes);
    expect(restored.clip.activeClipTakeId).toBe(clip.activeClipTakeId);
    expect(project).toEqual(before);
  });

  it.each([120, 137])('moves an already-trimmed source edge by only the requested delta at BPM %i', bpm => {
    const project = createFixture(bpm, 470_528, 12_347 / 48_000);
    const clip = project.tracks[0].clips[0];
    const originalStart = clip.audioTiming!.sourceStartSeconds;
    expect(trim(project, clip.startTick).clip.audioTiming).toEqual(clip.audioTiming);
    const shortened = trim(project, clip.startTick + 480);
    expect(shortened.clip.audioTiming.sourceStartSeconds).toBe(originalStart + timelineTicksToSeconds(480, bpm));
    const restored = trim({ ...project, tracks: shortened.tracks }, clip.startTick);
    expect(restored.clip.audioTiming.sourceStartSeconds).toBeCloseTo(originalStart, 14);
    expect(Math.round(restored.clip.audioTiming.sourceStartSeconds * 48_000)).toBe(12_347);
    expect(restored.clip.audioTiming.sourceEndSeconds).toBe(clip.audioTiming!.sourceEndSeconds);
  });

  it('keeps an explicit shorter legacy Timeline span unchanged on a no-op', () => {
    const project = createFixture(120, 470_528);
    const clip = project.tracks[0].clips[0];
    clip.lengthTicks = 9600;
    expect(trim(project, clip.startTick).clip).toEqual(clip);
    expect(createAudioClipLeftTrimUpdate(project.tracks, clip.id, clip.startTick - 1, project.totalTicks, project.bpm))
      .toMatchObject({ canTrim: false, reason: 'source-bounds' });
    const shortened = trim(project, clip.startTick + 480);
    expect(shortened.clip.audioTiming.sourceStartSeconds).toBe(0.25);
    expect(shortened.clip.audioTiming.sourceEndSeconds).toBe(clip.audioTiming!.sourceEndSeconds);
  });

  it('does not accumulate a sample offset after repeated edits', () => {
    let project = createFixture(137, 470_528, 12_347 / 48_000);
    const clip = project.tracks[0].clips[0];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      project = { ...project, tracks: trim(project, clip.startTick + 480).tracks };
      project = { ...project, tracks: trim(project, clip.startTick).tracks };
    }
    const result = project.tracks[0].clips[0];
    expect(Math.round(result.audioTiming!.sourceStartSeconds * 48_000)).toBe(12_347);
    expect(result.audioTiming!.sourceEndSeconds).toBe(clip.audioTiming!.sourceEndSeconds);
  });

  it('still rejects source, Timeline, minimum-length, and overlap violations', () => {
    const project = createFixture(120, 470_528);
    const clip = project.tracks[0].clips[0];
    const request = (tick: number, state = project) => createAudioClipLeftTrimUpdate(state.tracks, clip.id, tick, state.totalTicks, state.bpm);
    expect(request(clip.startTick - 1)).toMatchObject({ canTrim: false, reason: 'source-bounds' });
    expect(request(-1)).toMatchObject({ canTrim: false, reason: 'timeline-bounds' });
    expect(request(clip.startTick + clip.lengthTicks)).toMatchObject({ canTrim: false, reason: 'minimum-length' });
    expect(request(Number.NaN)).toMatchObject({ canTrim: false, reason: 'invalid-position' });
    const overlapping = structuredClone(project);
    overlapping.tracks[0].clips.push({ ...clip, id: 'blocking-clip', startTick: clip.startTick + 480, lengthTicks: 960 });
    expect(request(clip.startTick + 480, overlapping)).toMatchObject({ canTrim: false, reason: 'clip-overlap' });
  });
});

function createFixture(bpm: number, frames: number, sourceStartSeconds = 0): ProjectState {
  const project = createPrintMixAudioProject();
  project.bpm = bpm;
  project.totalTicks = 100_000;
  project.tracks = [project.tracks[0]];
  const clip = project.tracks[0].clips[0];
  clip.startTick = 1920;
  clip.lengthTicks = secondsToTimelineTicks(frames / 48_000 - sourceStartSeconds, bpm);
  clip.audioTiming = { timeBase: 'absolute-seconds', sourceStartSeconds, sourceEndSeconds: frames / 48_000 };
  clip.sourceFile = { ...clip.sourceFile!, durationSeconds: frames / 48_000 };
  return project;
}

function trim(project: ProjectState, tick: number) {
  const result = createAudioClipLeftTrimUpdate(project.tracks, project.tracks[0].clips[0].id, tick, project.totalTicks, project.bpm);
  if (!result.canTrim) throw new Error(result.message);
  return result;
}
