import { describe, expect, it } from 'vitest';
import {
  createFullSourceAudioClipTiming,
  secondsToTimelineTicks,
  timelineTicksToSeconds,
} from './audioClipTiming';
import { createAudioClipRightTrimUpdate } from './audioClipTrim';
import { createPrintMixAudioProject } from './printMixTestFixture';
import { createProjectPlaybackPlan } from './projectPlaybackPlan';
import { createProjectPlaybackSchedule } from './projectPlaybackRuntime';
import { createTimelineExportPlan } from './timelineExportPlan';
import { encodeTimelineExportAudio, inspectPcm16Wave } from './timelineExportEncoding';

describe('absolute audio endpoints between Timeline ticks', () => {
  it.each([72_001, 72_013])('keeps all %i frames when the display length rounds down or up', async (frames) => {
    const project = createPrintMixAudioProject();
    const clip = project.tracks[0].clips[0];
    const artifact = project.artifacts![0];
    if (artifact.kind !== 'audio') {
      throw new Error('Expected Audio Artifact');
    }
    const duration = frames / 48_000;
    clip.audioTiming = createFullSourceAudioClipTiming(duration);
    clip.lengthTicks = secondsToTimelineTicks(duration, project.bpm);
    artifact.audio.durationSeconds = duration;
    artifact.file.sizeBytes = 44 + frames * 4;
    clip.sourceFile = {
      ...artifact.file,
      durationSeconds: duration,
      mimeType: 'audio/wav',
      sourceId: artifact.artifactId,
      status: 'available',
    };
    const bytes = createWave(frames);
    for (const type of ['clip', 'track'] as const) {
      project.selection = {
        items: [{ type, id: type === 'clip' ? clip.id : project.tracks[0].id }],
      };
      const planned = createTimelineExportPlan(project);
      if (!planned.canExport || planned.plan.mediaType !== 'audio') {
        throw new Error('Missing Audio export plan');
      }
      expect(planned.plan.events[0].durationSeconds).toBe(duration);
      const encoded = encodeTimelineExportAudio(planned.plan, new Map([[artifact.artifactId, bytes]]));
      const leadingFrames = type === 'clip' ? 0 : 24_000;
      expect(encoded.frameCount).toBe(leadingFrames + frames);
      const exported = inspectPcm16Wave(new Uint8Array(await encoded.blob.arrayBuffer()), 'export');
      expect(exported.view.getInt16(exported.dataOffset + (exported.frameCount - 1) * 4, true)).toBe(1000);

      for (const playheadTick of [0, clip.startTick + 480]) {
        const playback = createProjectPlaybackPlan({
          artifacts: project.artifacts,
          bpm: project.bpm,
          playheadTick,
          projectEndTick: project.totalTicks,
          purpose: 'selection-playback',
          selection: project.selection,
          sourceAvailability: { [artifact.artifactId]: 'openable' },
          tracks: project.tracks,
        });
        if (!playback.canPlay) throw new Error(playback.message);
        const result = createProjectPlaybackSchedule(playback.plan, project.bpm);
        if (!result.canSchedule) throw new Error(result.message);
        const event = result.schedule.tracks[0].events[0];
        expect(event.sourceStartSeconds + event.durationSeconds).toBeCloseTo(duration, 12);
        expect(result.schedule.durationSeconds).toBeCloseTo(duration - event.sourceStartSeconds, 12);

        const rangeEndTick = clip.startTick + 960;
        const bounded = createProjectPlaybackSchedule(playback.plan, project.bpm, {
          endTick: rangeEndTick,
        });
        if (!bounded.canSchedule) throw new Error(bounded.message);
        const boundedEvent = bounded.schedule.tracks[0].events[0];
        expect(boundedEvent.sourceStartSeconds + boundedEvent.durationSeconds).toBe(
          timelineTicksToSeconds(rangeEndTick - clip.startTick, project.bpm),
        );
      }
    }
    const trimmed = createAudioClipRightTrimUpdate(project.tracks, clip.id, clip.startTick + 480, project.totalTicks, project.bpm);
    if (!trimmed.canTrim) throw new Error(trimmed.message);
    const restored = createAudioClipRightTrimUpdate(trimmed.tracks, clip.id, clip.startTick + clip.lengthTicks, project.totalTicks, project.bpm);
    if (!restored.canTrim) throw new Error(restored.message);
    expect(restored.clip.audioTiming.sourceEndSeconds).toBe(duration);
  });

  it('retains a shorter legacy Clip range and rejects an oversized stale range', () => {
    const project = createPrintMixAudioProject();
    const clip = project.tracks[0].clips[0];
    const artifact = project.artifacts![0];
    if (artifact.kind !== 'audio') throw new Error('Expected Audio Artifact');
    project.selection = { items: [{ type: 'clip', id: clip.id }] };
    delete clip.audioTiming;
    artifact.audio.durationSeconds = 1.5;
    const shorter = createTimelineExportPlan(project);
    expect(shorter).toMatchObject({ canExport: true, plan: { durationSeconds: 0.5 } });

    clip.lengthTicks = 10_000;
    expect(createTimelineExportPlan(project)).toMatchObject({
      canExport: false,
      reason: 'target-stale',
    });
  });
});

function createWave(frames: number): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    [...text].forEach((character, index) => {
      bytes[offset + index] = character.charCodeAt(0);
    });
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 192_000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 4, true);
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(44 + frame * 4, 1000, true);
    view.setInt16(46 + frame * 4, -1000, true);
  }
  return bytes;
}
