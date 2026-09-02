import { describe, expect, it } from 'vitest';
import demoProjectFile from './fixtures/PianoRollInteractionSpikeDemo.humstudio.json';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { resolveActiveMidiTake } from './activeMidiTake';
import { activateClipTake } from './clipTakeActivation';
import { planClipTakeRemoval } from './clipTakeRemoval';
import { createFinalFilerTestWav } from './finalFilerTestFixture';
import { savePianoRollTake } from './pianoRollTakeEditing';
import { createPrintMixAudioProject, createPrintMixMidiProject } from './printMixTestFixture';
import { normalizeClipTakeState } from './projectArtifactRegistration';
import { collectProjectSourceRestorationDescriptors } from './projectSourceRestoration';
import { encodeTimelineExportAudio } from './timelineExportEncoding';
import { createTimelineExportPlan } from './timelineExportPlan';
import { applyTrackGroupSubtreeCopyPlan, copyOrdinaryTimelineTrack, createCopiedTimelineClip, resolveTrackGroupSubtreeCopyPlan } from './timelineTrackCopy';
import type { Clip, ProjectState, Track } from './types';

const copiedAt = '2026-08-28T03:00:00.000Z';

describe('Timeline copy Take ownership', () => {
  it.each([false, true])('preserves unique Takes when copying an ordinary Track (selected Clips only: %s)', selectedOnly => {
    const project = createPrintMixAudioProject();
    const before = structuredClone(project);
    const result = copyAudioTrack(project, selectedOnly);
    expectUniqueTakes(result.project);
    expectCopiedTakes(result.track.clips[0], project.tracks[0].clips[0]);
    expect(result.project.artifacts).toBe(project.artifacts);
    for (const clip of [project.tracks[0].clips[0], result.track.clips[0]]) {
      expect(resolveActiveAudioTakeSource(result.project, clip.id).canResolve).toBe(true);
    }
    expect(project).toEqual(before);
  });

  it('reserves existing Take IDs across all Tracks and repeated clipboard clones', () => {
    const project = createPrintMixAudioProject();
    const source = project.tracks[0].clips[0];
    const usedClipIds = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.id)));
    const usedTakeIds = new Set(allTakeIds(project));
    const collision = `${source.clipTakes![0].clipTakeId}-copy-1`;
    usedTakeIds.add(collision);
    const first = createCopiedTimelineClip(source, usedClipIds, copiedAt, usedTakeIds);
    const second = createCopiedTimelineClip(source, usedClipIds, copiedAt, usedTakeIds);
    expectCopiedTakes(first, source);
    expectCopiedTakes(second, source);
    expect(first.activeClipTakeId).not.toBe(collision);
    expect(first.activeClipTakeId).not.toBe(second.activeClipTakeId);
    expect(usedTakeIds.has(first.activeClipTakeId!)).toBe(true);
    expect(usedTakeIds.has(second.activeClipTakeId!)).toBe(true);
    project.tracks[0].clips.push({ ...first, startTick: 3840 }, { ...second, startTick: 5760 });
    expectUniqueTakes(project);
  });

  it('ordinary copying respects a Take-ID collision on another Track', () => {
    const project = createPrintMixAudioProject();
    const source = project.tracks[0].clips[0];
    const reserved = project.tracks[1].clips[0];
    reserved.clipTakes![0].clipTakeId = `${source.activeClipTakeId}-copy-1`;
    reserved.activeClipTakeId = reserved.clipTakes![0].clipTakeId;
    const result = copyAudioTrack(project);
    expectUniqueTakes(result.project);
    expect(result.track.clips[0].activeClipTakeId).not.toBe(reserved.activeClipTakeId);
  });

  it('copies all inactive Takes and allows independent active-choice changes', () => {
    const project = createPrintMixAudioProject();
    const source = project.tracks[0].clips[0];
    const other = project.tracks[1].clips[0].clipTakes![0];
    source.clipTakes!.push({ ...other, clipTakeId: 'inactive-shared-audio' });
    source.activeClipTakeId = source.clipTakes![1].clipTakeId;
    const result = copyAudioTrack(project);
    const copied = result.track.clips[0];
    expectCopiedTakes(copied, source);
    expect(copied.activeClipTakeId).toBe(copied.clipTakes![1].clipTakeId);
    const activated = activateClipTake(result.project, copied.id, copied.clipTakes![0].clipTakeId);
    expect(activated.canActivate).toBe(true);
    if (!activated.canActivate) throw new Error(activated.message);
    expect(activated.project.tracks[0].clips[0].activeClipTakeId).toBe(source.activeClipTakeId);
    expect(activated.clip.activeClipTakeId).toBe(copied.clipTakes![0].clipTakeId);
    expect(activated.project.artifacts).toBe(project.artifacts);
  });

  it('copies nested mixed Audio/MIDI Groups repeatedly without duplicating Take owners', () => {
    const audio = createPrintMixAudioProject();
    const midi = createPrintMixMidiProject();
    const group = (id: string, children: string[], parentGroupId?: string): Track => ({
      id, name: id, type: 'group', level: 0, clips: [], parentGroupId,
      group: { childTrackIds: children, collapsed: false, playbackMode: 'bottom_child', activePlaybackTrackId: children[children.length - 1] },
    });
    const project: ProjectState = { ...audio, artifacts: [...audio.artifacts!, ...midi.artifacts!], tracks: [
      { ...audio.tracks[0], parentGroupId: 'inner' }, { ...midi.tracks[0], parentGroupId: 'inner' },
      group('inner', [audio.tracks[0].id, midi.tracks[0].id], 'outer'),
      { ...audio.tracks[1], parentGroupId: 'outer' }, group('outer', ['inner', audio.tracks[1].id]),
    ] };
    let current = project;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const planned = resolveTrackGroupSubtreeCopyPlan(current.tracks, 'outer');
      if (!planned.canCopy) throw new Error(planned.message);
      const copied = applyTrackGroupSubtreeCopyPlan(current, planned.plan, { createdAt: copiedAt });
      if (!copied.canCopy) throw new Error(copied.message);
      current = copied.project;
      expectUniqueTakes(current);
      for (const track of copied.clonedSubtreeTracks) {
        for (const clip of track.clips) {
          expect(clip.type === 'midi-notes'
            ? resolveActiveMidiTake(current, clip.id).canResolve
            : resolveActiveAudioTakeSource(current, clip.id).canResolve).toBe(true);
        }
      }
      expect(current.artifacts).toBe(project.artifacts);
    }
    expect(collectProjectSourceRestorationDescriptors(current)).toHaveLength(2);
  });

  it('keeps generated and edited MIDI parent lineage valid without rewriting shared Artifacts', () => {
    const project = structuredClone(demoProjectFile.workspace.project) as ProjectState;
    const source = resolveActiveMidiTake(project, 'piano-roll-demo-midi');
    if (!source.canResolve) throw new Error(source.message);
    const edited = savePianoRollTake(project, { clipId: source.plan.source.clipId,
      identity: { artifactId: 'copy-test-edited-midi', sourceEditId: 'copy-test-edit', createdAt: copiedAt },
      notes: source.plan.midi.notes.map((note, index) => index === 0 ? { ...note, pitch: note.pitch + 1 } : note),
    });
    if (!edited.canSave) throw new Error(edited.message);
    const track = edited.project.tracks.find(track => track.clips.some(clip => clip.id === source.plan.source.clipId))!;
    const copied = copyOrdinaryTimelineTrack(edited.project.tracks, track.id);
    if (!copied.canCopy) throw new Error(copied.message);
    const result = { ...edited.project, tracks: copied.tracks };
    expectUniqueTakes(result);
    expect(result.artifacts).toBe(edited.project.artifacts);
    for (const clip of [track.clips[0], copied.track.clips[0]]) {
      expect(resolveActiveMidiTake(result, clip.id).canResolve).toBe(true);
      for (const take of clip.clipTakes!) expect(activateClipTake(result, clip.id, take.clipTakeId).canActivate).toBe(true);
    }
    expectCopiedTakes(copied.track.clips[0], track.clips[0]);
  });

  it('exports the original and copied Clip/Track from the same exact WAV', async () => {
    const project = createPrintMixAudioProject();
    project.tracks[0].clips[0].startTick = 0;
    const artifact = project.artifacts![0];
    if (artifact.kind !== 'audio') throw new Error('Expected Audio Artifact');
    artifact.file.sizeBytes = 44 + 24_000 * 4;
    const result = copyAudioTrack(project);
    const bytes = new Uint8Array(await createFinalFilerTestWav(artifact.file.sizeBytes).arrayBuffer());
    const view = new DataView(bytes.buffer);
    // Timeline export is 48 kHz; use a source at that rate for byte-exact comparison.
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 192_000, true);
    for (let frame = 0; frame < (bytes.length - 44) / 4; frame += 1) {
      view.setInt16(44 + frame * 4, frame % 1000 - 500, true);
      view.setInt16(46 + frame * 4, 500 - frame % 1000, true);
    }
    for (const track of [project.tracks[0], result.track]) {
      for (const type of ['clip', 'track'] as const) {
        const planned = createTimelineExportPlan(result.project, { items: [{ type, id: type === 'clip' ? track.clips[0].id : track.id }] });
        if (!planned.canExport || planned.plan.mediaType !== 'audio') throw new Error('Missing copied audio export');
        const encoded = encodeTimelineExportAudio(planned.plan, new Map([[project.artifacts![0].artifactId, bytes]]));
        const exported = new Uint8Array(await encoded.blob.arrayBuffer());
        expect(exported.length).toBe(bytes.length);
        expect(exported.every((value, index) => value === bytes[index])).toBe(true);
      }
    }
  });

  it('restores serialized copied sources without duplicate descriptors', () => {
    const { project } = copyAudioTrack(createPrintMixAudioProject());
    const restored: ProjectState = JSON.parse(JSON.stringify(project));
    restored.tracks.forEach(track => track.clips.forEach(clip => Object.assign(clip, normalizeClipTakeState(clip.clipTakes, clip.activeClipTakeId))));
    expectUniqueTakes(restored);
    expect(collectProjectSourceRestorationDescriptors(restored)).toHaveLength(2);
    restored.tracks.flatMap(track => track.clips).forEach(clip => expect(resolveActiveAudioTakeSource(restored, clip.id).canResolve).toBe(true));
  });

  it('preserves shared Audio Artifacts on Take removal and blocks deleting their WAV', () => {
    const result = copyAudioTrack(createPrintMixAudioProject());
    const clip = result.track.clips[0];
    const request = { clipId: clip.id, clipTakeId: clip.activeClipTakeId!, confirmActiveTakeRemoval: true };
    expect(planClipTakeRemoval(result.project, { ...request, mode: 'project-and-audio-file' }))
      .toMatchObject({ canRemove: false, reason: 'artifact-still-referenced' });
    const removal = planClipTakeRemoval(result.project, { ...request, mode: 'project-only' });
    expect(removal).toMatchObject({ canRemove: true, artifactDisposition: 'preserved-shared', fileAction: { action: 'preserve' } });
    if (!removal.canRemove) throw new Error(removal.message);
    expect(removal.projectAfterRemoval.artifacts).toEqual(result.project.artifacts);
    expect(resolveActiveAudioTakeSource(removal.projectAfterRemoval, result.project.tracks[0].clips[0].id).canResolve).toBe(true);
  });

  it('does not invent Takes or an active choice for legacy and unselected Clips', () => {
    const project = createPrintMixAudioProject();
    const clip = project.tracks[0].clips[0];
    delete clip.activeClipTakeId;
    expect(copyAudioTrack(project).track.clips[0].activeClipTakeId).toBeUndefined();
    delete clip.clipTakes;
    const copied = copyAudioTrack(project).track.clips[0];
    expect(copied.clipTakes).toBeUndefined();
    expect(copied.activeClipTakeId).toBeUndefined();
  });

  it('does not repair an explicit stale active choice or weaken source validation', () => {
    const project = createPrintMixAudioProject();
    project.tracks[0].clips[0].activeClipTakeId = 'stale-take';
    const copied = copyAudioTrack(project);
    expect(copied.track.clips[0].activeClipTakeId).toBe('stale-take');
    expect(resolveActiveAudioTakeSource(copied.project, copied.track.clips[0].id).canResolve).toBe(false);
    expect(() => collectProjectSourceRestorationDescriptors(copied.project)).toThrow();
  });

  it('does not allocate a copied Take ID that accidentally validates a stale active choice', () => {
    const project = createPrintMixAudioProject();
    const clip = project.tracks[0].clips[0];
    clip.activeClipTakeId = `${clip.clipTakes![0].clipTakeId}-copy-1`;
    const copied = copyAudioTrack(project);
    expect(copied.track.clips[0].activeClipTakeId).toBe(clip.activeClipTakeId);
    expect(copied.track.clips[0].clipTakes![0].clipTakeId).not.toBe(clip.activeClipTakeId);
    expect(resolveActiveAudioTakeSource(copied.project, copied.track.clips[0].id).canResolve).toBe(false);
  });
});

function copyAudioTrack(project: ProjectState, selectedOnly = false) {
  const result = copyOrdinaryTimelineTrack(project.tracks, project.tracks[0].id, selectedOnly ? [project.tracks[0].clips[0].id] : undefined, copiedAt);
  if (!result.canCopy) throw new Error(result.message);
  return { ...result, project: { ...project, tracks: result.tracks } };
}

function allTakeIds(project: ProjectState) {
  return project.tracks.flatMap(track => track.clips.flatMap(clip => clip.clipTakes?.map(take => take.clipTakeId) ?? []));
}

function expectUniqueTakes(project: ProjectState) {
  const ids = allTakeIds(project);
  expect(new Set(ids).size).toBe(ids.length);
}

function expectCopiedTakes(copied: Clip, source: Clip) {
  expect(copied.clipTakes).not.toBe(source.clipTakes);
  expect(copied.clipTakes).toHaveLength(source.clipTakes!.length);
  copied.clipTakes!.forEach((take, index) => {
    expect(take).not.toBe(source.clipTakes![index]);
    expect(take.clipTakeId).not.toBe(source.clipTakes![index].clipTakeId);
    expect({ ...take, clipTakeId: source.clipTakes![index].clipTakeId }).toEqual(source.clipTakes![index]);
  });
  const activeIndex = source.clipTakes!.findIndex(take => take.clipTakeId === source.activeClipTakeId);
  if (activeIndex >= 0) expect(copied.activeClipTakeId).toBe(copied.clipTakes![activeIndex].clipTakeId);
}
