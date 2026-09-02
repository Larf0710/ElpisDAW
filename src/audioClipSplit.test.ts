import { describe, expect, it, vi } from 'vitest';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import {
  createAudioClipSplitUpdate,
  createProjectAudioClipSplitUpdate,
} from './audioClipSplit';
import { secondsToTimelineTicks } from './audioClipTiming';
import { activateClipTake } from './clipTakeActivation';
import { createPrintMixAudioProject } from './printMixTestFixture';
import { normalizeClipTakeState } from './projectArtifactRegistration';
import { createNormalizedProjectLoad } from './projectLoadNormalization';
import { createProjectPlaybackPlan } from './projectPlaybackPlan';
import { createProjectPlaybackSchedule } from './projectPlaybackRuntime';
import { applyProjectRootProjectOpen, prepareProjectRootProjectOpen } from './projectRootProjectOpen';
import { applyProjectSourceRestoration, collectProjectSourceRestorationDescriptors } from './projectSourceRestoration';
import { encodeTimelineExportAudio, inspectPcm16Wave } from './timelineExportEncoding';
import { createTimelineExportPlan } from './timelineExportPlan';
import type { LocalEngineSourceDescriptor } from './localEngineClient';
import type { GeneratedAudioArtifact, GeneratedAudioClipTake, ProjectState } from './types';

describe('Audio Clip split Take ownership', () => {
  it.each([
    ['SA3 T2A', 'stable-audio-3', 'text-to-audio'],
    ['SA3 A2A', 'stable-audio-3', 'audio-to-audio'],
    ['ACE T2M', 'ace-step', 'text-to-music'],
    ['ACE Cover', 'ace-step', 'audio-cover'],
    ['ACE Vocal', 'ace-step', 'guide-audio-to-vocals'],
  ] as const)('splits %s output by resolving its Active Take when persisted timing is absent', (
    _label,
    destination,
    taskId,
  ) => {
    const { project, artifact, clip } = createFixture();
    artifact.destination = destination;
    artifact.provenance.taskId = taskId;
    delete clip.audioTiming;

    const result = createProjectAudioClipSplitUpdate(project, clip.id, 960);

    expect(result.canSplit).toBe(true);
    if (!result.canSplit) throw new Error(result.message);
    expect(result.leftClip.audioTiming).toEqual({
      sourceEndSeconds: 0.5,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    });
    expect(result.rightClip.audioTiming).toEqual({
      sourceEndSeconds: artifact.audio.durationSeconds,
      sourceStartSeconds: 0.5,
      timeBase: 'absolute-seconds',
    });
    expect(result.leftClip.sourceFile?.sourceId).toBe(artifact.artifactId);
    expect(result.rightClip.sourceFile?.sourceId).toBe(artifact.artifactId);
    expectUniqueTakes({ ...project, tracks: result.tracks });
  });

  it('keeps Clips without a selected Active Take blocked', () => {
    const { project, clip } = createFixture();
    delete clip.audioTiming;
    delete clip.activeClipTakeId;

    expect(createProjectAudioClipSplitUpdate(project, clip.id, 960)).toMatchObject({
      canSplit: false,
      reason: 'not-source-backed',
    });
  });

  it('gives every right-side Take a new identity while retaining its active choice and Artifact', () => {
    const { project, artifact, clip } = createFixture();
    const firstTake = clip.clipTakes![0] as GeneratedAudioClipTake;
    const secondArtifact: GeneratedAudioArtifact = {
      ...artifact, artifactId: 'artifact-second-take', sourceJobId: 'job-second-take',
      file: { ...artifact.file, name: 'artifact-second-take.wav', relativePath: 'renders/instruments/artifact-second-take.wav' },
    };
    const secondTake: GeneratedAudioClipTake = {
      ...firstTake, artifactId: secondArtifact.artifactId, clipTakeId: 'take-second', sourceJobId: secondArtifact.sourceJobId,
    };
    project.artifacts!.push(secondArtifact);
    clip.clipTakes!.push(secondTake);
    clip.activeClipTakeId = secondTake.clipTakeId;
    const before = structuredClone(project);
    const result = splitProject(project, clip.id, 960);

    expect(project).toEqual(before);
    expect(result.leftClip.clipTakes).toBe(clip.clipTakes);
    expect(result.leftClip.activeClipTakeId).toBe(secondTake.clipTakeId);
    expect(result.rightClip.clipTakes).toHaveLength(2);
    result.rightClip.clipTakes!.forEach((take, index) => {
      expect(take).not.toBe(clip.clipTakes![index]);
      expect(take.clipTakeId).not.toBe(clip.clipTakes![index].clipTakeId);
      expect({ ...take, clipTakeId: clip.clipTakes![index].clipTakeId }).toEqual(clip.clipTakes![index]);
    });
    expect(result.rightClip.activeClipTakeId).toBe(result.rightClip.clipTakes![1].clipTakeId);
    expectUniqueTakes(result.project);
    for (const piece of [result.leftClip, result.rightClip]) {
      expect(resolveActiveAudioTakeSource(result.project, piece.id)).toMatchObject({
        canResolve: true, plan: { source: { artifactId: secondArtifact.artifactId } },
      });
    }
    const switched = activateClipTake(result.project, result.rightClip.id, result.rightClip.clipTakes![0].clipTakeId);
    expect(switched.canActivate).toBe(true);
    if (!switched.canActivate) throw new Error(switched.message);
    expect(switched.project.tracks[0].clips[0].activeClipTakeId).toBe(secondTake.clipTakeId);
    expect(switched.clip.activeClipTakeId).toBe(result.rightClip.clipTakes![0].clipTakeId);
    expect(switched.project.artifacts).toBe(project.artifacts);
  });

  it('avoids Take ID collisions anywhere in the Project and stays deterministic', () => {
    const { project, clip } = createFixture();
    const take = clip.clipTakes![0];
    project.tracks.push({
      ...project.tracks[0], id: 'other-track',
      clips: [{
        ...clip, id: 'other-clip', activeClipTakeId: `${take.clipTakeId}-split-1`,
        clipTakes: [{ ...take, clipTakeId: `${take.clipTakeId}-split-1` }],
      }],
    });
    const first = splitProject(project, clip.id, 960);
    const second = splitProject(project, clip.id, 960);
    expectUniqueTakes(first.project);
    expect(second).toEqual(first);
    expect(first.rightClip.activeClipTakeId).not.toBe(`${take.clipTakeId}-split-1`);
  });

  it.each([72_001, 72_013])('preserves all %i source frames through repeated splits and Clip/Track exports', async (frames) => {
    const { project, artifact, clip, bytes } = createFixture(frames);
    const initial = splitProject(project, clip.id, 960);
    const rightSplit = splitProject(initial.project, initial.rightClip.id, 1920);
    const leftSplit = splitProject(rightSplit.project, clip.id, 480);
    const result = leftSplit.project;
    expectUniqueTakes(result);
    expect(new Set(result.tracks[0].clips.map(piece => piece.id)).size).toBe(4);
    expect(result.tracks[0].clips.reduce((sum, piece) => sum + piece.lengthTicks, 0)).toBe(clip.lengthTicks);

    const trackPlan = createTimelineExportPlan(result, { items: [{ type: 'track', id: project.tracks[0].id }] });
    if (!trackPlan.canExport) throw new Error(trackPlan.message);
    if (trackPlan.plan.mediaType !== 'audio') throw new Error('Expected audio');
    expect(trackPlan.plan.sources).toHaveLength(1);
    expect(trackPlan.plan.sourceLineage).toHaveLength(4);
    const encoded = encodeTimelineExportAudio(trackPlan.plan, new Map([[artifact.artifactId, bytes]]));
    expect(encoded.frameCount).toBe(frames);
    expect(new Uint8Array(await encoded.blob.arrayBuffer())).toEqual(bytes);

    const exportedPieces: number[] = [];
    for (const piece of result.tracks[0].clips) {
      const planned = createTimelineExportPlan(result, { items: [{ type: 'clip', id: piece.id }] });
      if (!planned.canExport) throw new Error(planned.message);
      if (planned.plan.mediaType !== 'audio') throw new Error('Expected audio');
      const part = encodeTimelineExportAudio(planned.plan, new Map([[artifact.artifactId, bytes]]));
      const partBytes = new Uint8Array(await part.blob.arrayBuffer());
      const wave = inspectPcm16Wave(partBytes, 'split-piece');
      exportedPieces.push(...partBytes.subarray(wave.dataOffset));
    }
    expect(new Uint8Array(exportedPieces)).toEqual(bytes.subarray(44));

    const playback = createProjectPlaybackPlan({
      artifacts: result.artifacts, bpm: result.bpm, playheadTick: 0, projectEndTick: result.totalTicks,
      purpose: 'selection-playback', selection: { items: [{ type: 'track', id: result.tracks[0].id }] },
      sourceAvailability: { [artifact.artifactId]: 'openable' }, tracks: result.tracks,
    });
    if (!playback.canPlay) throw new Error(playback.message);
    const scheduled = createProjectPlaybackSchedule(playback.plan, result.bpm);
    if (!scheduled.canSchedule) throw new Error(scheduled.message);
    expect(scheduled.schedule.tracks[0].events).toHaveLength(4);
    expect(scheduled.schedule.durationSeconds).toBe(frames / 48_000);
  });

  it('reopens serialized split Takes through source restoration without duplicating the source', async () => {
    const { project, clip, artifact } = createFixture();
    const split = splitProject(project, clip.id, 960);
    const projectFile = JSON.parse(JSON.stringify({ workspace: { project: split.project } }));
    const savedProject: ProjectState = projectFile.workspace.project;
    savedProject.tracks[0].clips.forEach(piece => Object.assign(piece, normalizeClipTakeState(piece.clipTakes, piece.activeClipTakeId)));
    expectUniqueTakes(savedProject);
    const currentWorkspace = { project };
    const restoreSources = vi.fn(async (descriptors: readonly LocalEngineSourceDescriptor[]) => ({
      ok: true as const,
      restoration: {
        availability: Object.fromEntries(descriptors.map(descriptor => [descriptor.sourceId, 'available' as const])),
        checkedAt: '2026-08-28T00:00:00.000Z',
        sources: descriptors.map(descriptor => {
          if (descriptor.kind !== 'generated') throw new Error('Expected a managed source');
          return {
            actual: { lastModified: 1_721_692_802_000, name: artifact.file.name, sizeBytes: artifact.file.sizeBytes },
            kind: 'generated' as const, reason: 'available' as const, relativePath: descriptor.relativePath,
            resolvedPath: `D:/CodeX/HumStudio/.cache/split-test/${descriptor.relativePath}`,
            sourceId: descriptor.sourceId, state: 'available' as const,
          };
        }),
      },
    }));
    const prepared = await prepareProjectRootProjectOpen(
      {
        loadProjectFile: async () => ({ ok: true as const, loadedProject: {
          bytesRead: JSON.stringify(projectFile).length, lastModifiedAt: '2026-08-28T00:00:00.000Z',
          projectFile, projectFileName: 'split.humstudio.json',
          projectFilePath: 'D:/CodeX/HumStudio/.cache/split-test/split.humstudio.json',
          savedAt: '2026-08-28T00:00:00.000Z', status: 'LOADED' as const,
        } }),
        restoreSources,
      },
      currentWorkspace,
      () => createNormalizedProjectLoad({ project: savedProject }, { migrated: false, source: 'mixer-state-v2' }),
      {
        collectDescriptors: workspace => collectProjectSourceRestorationDescriptors(workspace.project),
        applyRestoration: (workspace, descriptors, restoration) => ({
          ...workspace, project: applyProjectSourceRestoration(workspace.project, descriptors, restoration),
        }),
      },
    );
    if (!prepared.canOpen) throw new Error(prepared.message);
    expect(restoreSources).toHaveBeenCalledTimes(1);
    expect(restoreSources.mock.calls[0][0]).toHaveLength(1);
    const reopened = applyProjectRootProjectOpen(prepared.plan, currentWorkspace);
    expect(reopened.opened).toBe(true);
    expect(reopened.workspace.project.artifacts).toEqual(project.artifacts);
    reopened.workspace.project.tracks[0].clips.forEach(piece => {
      expect(resolveActiveAudioTakeSource(reopened.workspace.project, piece.id).canResolve).toBe(true);
      expect(piece.audioTiming).toEqual(savedProject.tracks[0].clips.find(saved => saved.id === piece.id)!.audioTiming);
    });
    expect(currentWorkspace.project).toBe(project);
  });

  it('preserves legacy source-backed Clips without inventing Takes', () => {
    const { project, clip } = createFixture();
    delete clip.clipTakes;
    delete clip.activeClipTakeId;
    const result = splitProject(project, clip.id, 960);
    expect(result.rightClip.clipTakes).toBeUndefined();
    expect(result.rightClip.activeClipTakeId).toBeUndefined();
    expect(result.rightClip.sourceFile).toEqual(clip.sourceFile);
  });

  it('retains strict rejection of duplicated Take ownership in malformed saved Projects', () => {
    const { project, clip } = createFixture();
    const result = splitProject(project, clip.id, 960);
    result.rightClip.clipTakes = result.leftClip.clipTakes;
    result.rightClip.activeClipTakeId = result.leftClip.activeClipTakeId;
    expect(() => collectProjectSourceRestorationDescriptors(result.project)).toThrow('Active Take does not resolve uniquely');
  });
});

function createFixture(frames = 72_013) {
  const project = createPrintMixAudioProject();
  const artifact = project.artifacts![0] as GeneratedAudioArtifact;
  project.artifacts = [artifact];
  project.tracks = [project.tracks[0]];
  project.bpm = 120;
  const clip = project.tracks[0].clips[0];
  const bytes = createWave(frames);
  artifact.audio.durationSeconds = frames / 48_000;
  artifact.file.sizeBytes = bytes.length;
  clip.startTick = 0;
  clip.lengthTicks = secondsToTimelineTicks(artifact.audio.durationSeconds, project.bpm);
  clip.audioTiming = { timeBase: 'absolute-seconds', sourceStartSeconds: 0, sourceEndSeconds: artifact.audio.durationSeconds };
  clip.sourceFile = {
    ...artifact.file, durationSeconds: artifact.audio.durationSeconds,
    mimeType: 'audio/wav', sourceId: artifact.artifactId, status: 'available',
  };
  project.selection = { items: [{ type: 'track', id: project.tracks[0].id }] };
  return { project, artifact, clip, bytes };
}

function splitProject(project: ProjectState, clipId: string, tick: number) {
  const result = createAudioClipSplitUpdate(project.tracks, clipId, tick, project.totalTicks, project.bpm);
  if (!result.canSplit) throw new Error(result.message);
  return { ...result, project: { ...project, tracks: result.tracks } };
}

function expectUniqueTakes(project: ProjectState) {
  const ids = project.tracks.flatMap(track => track.clips.flatMap(clip => clip.clipTakes?.map(take => take.clipTakeId) ?? []));
  expect(new Set(ids).size).toBe(ids.length);
}

function createWave(frames: number): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((character, index) => { bytes[offset + index] = character.charCodeAt(0); });
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
    view.setInt16(44 + frame * 4, frame % 1000 - 500, true);
    view.setInt16(46 + frame * 4, 500 - frame % 1000, true);
  }
  return bytes;
}
