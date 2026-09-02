import { describe, expect, it } from 'vitest';
import { resolveActiveMidiTake } from './activeMidiTake';
import { activateClipTake } from './clipTakeActivation';
import { normalizeMidiNotes } from './humToMidiContract';
import { createNewPianoRollTake, savePianoRollTake } from './pianoRollTakeEditing';
import { createPrintMixMidiProject } from './printMixTestFixture';
import { normalizeClipTakeState } from './projectArtifactRegistration';
import { encodeTimelineExportMidi } from './timelineExportEncoding';
import { createTimelineExportPlan } from './timelineExportPlan';
import { applyTrackGroupSubtreeCopyPlan, copyOrdinaryTimelineTrack, createCopiedTimelineClip, resolveTrackGroupSubtreeCopyPlan } from './timelineTrackCopy';
import type { MidiNote, ProjectState, Track } from './types';

type SourceKind = 'manual' | 'edit';
type CopyKind = 'track' | 'selected' | 'clipboard' | 'group';
const createdAt = '2026-08-28T04:00:00.000Z';

describe.each<SourceKind>(['manual', 'edit'])('Shared %s MIDI Take editing', sourceKind => {
  it.each<CopyKind>(['track', 'selected', 'clipboard', 'group'])('isolates a changed %s copy and preserves the source', copyKind => {
    const { project, originalId, copiedId } = createCopiedProject(sourceKind, copyKind);
    const before = structuredClone(project);
    const original = resolve(project, originalId);
    const copied = resolve(project, copiedId);
    const notes = changedNotes(copied.midi.notes);
    const result = save(project, copiedId, notes, 1);

    expect(result.status).toBe('CREATED');
    expect(result.clipTake.sourceType).toBe('edit');
    expect(result.clipTake.artifactId).not.toBe(copied.source.artifactId);
    expect(result.clipTake.clipTakeId).not.toBe(copied.source.clipTakeId);
    expect(findClip(result.project, copiedId).clipTakes).toHaveLength(findClip(project, copiedId).clipTakes!.length + 1);
    expect(resolve(result.project, originalId)).toEqual(original);
    expect(resolve(result.project, copiedId).midi.notes).toEqual(normalizeMidiNotes(notes));
    for (const artifact of project.artifacts!) {
      expect(result.project.artifacts!.find(candidate => candidate.artifactId === artifact.artifactId)).toEqual(artifact);
    }
    expect(result.project.artifacts!.find(artifact => artifact.artifactId === result.clipTake.artifactId)?.lineage).toEqual({
      parentArtifactIds: [copied.source.artifactId], parentClipTakeIds: [copied.source.clipTakeId],
    });
    expectAllTakesActivate(result.project);
    expect(project).toEqual(before);
  });

  it('also protects the copy when editing the original Clip', () => {
    const { project, originalId, copiedId } = createCopiedProject(sourceKind);
    const copied = resolve(project, copiedId);
    const result = save(project, originalId, changedNotes(copied.midi.notes), 1);
    expect(result.status).toBe('CREATED');
    expect(resolve(result.project, copiedId)).toEqual(copied);
    expect(resolve(result.project, originalId).source.artifactId).not.toBe(copied.source.artifactId);
    expectAllTakesActivate(result.project);
  });

  it('keeps later private edits on the same Take and Artifact', () => {
    const { project, originalId, copiedId } = createCopiedProject(sourceKind);
    const original = resolve(project, originalId);
    const first = save(project, copiedId, changedNotes(original.midi.notes), 1);
    const nextNotes = changedNotes(resolve(first.project, copiedId).midi.notes);
    const second = savePianoRollTake(first.project, { clipId: copiedId, notes: nextNotes });
    if (!second.canSave) throw new Error(second.message);
    expect(second.status).toBe('SAVED');
    expect(second.clipTake.clipTakeId).toBe(first.clipTake.clipTakeId);
    expect(second.clipTake.artifactId).toBe(first.clipTake.artifactId);
    expect(second.clipTake.revision).toBe(2);
    expect(second.project.artifacts).toHaveLength(first.project.artifacts!.length);
    expect(findClip(second.project, copiedId).clipTakes).toHaveLength(findClip(first.project, copiedId).clipTakes!.length);
    expect(resolve(second.project, originalId)).toEqual(original);
    expectAllTakesActivate(second.project);
  });

  it('does not fork an unchanged shared Take or require an identity for it', () => {
    const { project, copiedId } = createCopiedProject(sourceKind);
    const result = savePianoRollTake(project, { clipId: copiedId, notes: resolve(project, copiedId).midi.notes });
    expect(result).toMatchObject({ canSave: true, status: 'UNCHANGED' });
    if (result.canSave) expect(result.project).toBe(project);
  });
});

describe('Shared MIDI edit boundaries', () => {
  it('preserves another Clip inactive reference and its dependent Edited Take', () => {
    const { project, originalId, copiedId } = createCopiedProject('manual');
    const source = resolve(project, originalId);
    const copiedNewTake = createNewPianoRollTake(project, { clipId: copiedId, notes: source.midi.notes, identity: identity(1) });
    if (!copiedNewTake.canSave) throw new Error(copiedNewTake.message);
    const copiedBefore = resolve(copiedNewTake.project, copiedId);
    const result = save(copiedNewTake.project, originalId, changedNotes(source.midi.notes), 2);
    expect(resolve(result.project, copiedId)).toEqual(copiedBefore);
    expectAllTakesActivate(result.project);
  });

  it('protects a second Take in the same Clip that shares the Artifact', () => {
    const project = createPrintMixMidiProject();
    const clip = project.tracks[0].clips[0];
    clip.lengthTicks = 3840;
    clip.clipTakes!.push({ ...clip.clipTakes![0], clipTakeId: 'same-clip-shared-take' });
    const source = resolve(project, clip.id);
    const result = save(project, clip.id, changedNotes(source.midi.notes), 1);
    expect(result.status).toBe('CREATED');
    const activated = activateClipTake(result.project, clip.id, 'same-clip-shared-take');
    if (!activated.canActivate) throw new Error(activated.message);
    expect(resolve(activated.project, clip.id).midi).toEqual(source.midi);
  });

  it('keeps both independently edited copies valid after serialization and Take normalization', async () => {
    const { project, originalId, copiedId } = createCopiedProject('edit');
    const originalMidi = await exportMidi(project, originalId);
    const first = save(project, copiedId, changedNotes(resolve(project, copiedId).midi.notes), 1);
    expect(await exportMidi(first.project, originalId)).toEqual(originalMidi);
    const copiedMidi = await exportMidi(first.project, copiedId);
    expect(copiedMidi).not.toEqual(originalMidi);
    const second = save(first.project, originalId, changedNotes(resolve(first.project, originalId).midi.notes, 2), 2);
    const restored: ProjectState = JSON.parse(JSON.stringify(second.project));
    restored.tracks.forEach(track => track.clips.forEach(clip => Object.assign(clip, normalizeClipTakeState(clip.clipTakes, clip.activeClipTakeId))));
    expect(await exportMidi(restored, copiedId)).toEqual(copiedMidi);
    expect(await exportMidi(restored, originalId)).not.toEqual(copiedMidi);
    expectAllTakesActivate(restored);
  });

  it('allows clearing a copied Take without clearing the original notes', () => {
    const { project, originalId, copiedId } = createCopiedProject('manual');
    const original = resolve(project, originalId);
    const result = save(project, copiedId, [], 1);
    expect(resolve(result.project, copiedId).midi.notes).toEqual([]);
    expect(resolve(result.project, originalId)).toEqual(original);
  });

  it('extends only the edited Clip when a new note crosses its end', () => {
    const { project, originalId, copiedId } = createCopiedProject('manual');
    const original = structuredClone(findClip(project, originalId));
    const source = resolve(project, copiedId);
    const result = save(project, copiedId, [...source.midi.notes, { id: 'late-note', startTick: 4000, lengthTicks: 960, pitch: 72, velocity: 90 }], 1);
    expect(findClip(result.project, originalId)).toEqual(original);
    expect(findClip(result.project, copiedId).lengthTicks).toBe(7680);
    expect(result.project.totalTicks).toBeGreaterThanOrEqual(findClip(result.project, copiedId).startTick + 7680);
    expectAllTakesActivate(result.project);
  });

  it('rejects a changed shared Take without a new identity, without mutating input', () => {
    const { project, copiedId } = createCopiedProject('manual');
    const before = structuredClone(project);
    const result = savePianoRollTake(project, { clipId: copiedId, notes: changedNotes(resolve(project, copiedId).midi.notes) });
    expect(result).toMatchObject({ canSave: false, message: expect.stringMatching(/shared.*identity/i) });
    expect(project).toEqual(before);
  });

  it.each(['invalid', 'collision'])('rejects an %s new identity atomically', mode => {
    const { project, copiedId } = createCopiedProject('manual');
    const before = structuredClone(project);
    const source = resolve(project, copiedId);
    const result = savePianoRollTake(project, { clipId: copiedId, notes: changedNotes(source.midi.notes),
      identity: { ...identity(1), artifactId: mode === 'invalid' ? 'invalid id' : source.source.artifactId } });
    expect(result.canSave).toBe(false);
    expect(project).toEqual(before);
    expectAllTakesActivate(project);
  });
});

function identity(index: number) {
  return { artifactId: `shared-edit-artifact-${index}`, sourceEditId: `shared-edit-${index}`, createdAt };
}

function resolve(project: ProjectState, clipId: string) {
  const result = resolveActiveMidiTake(project, clipId);
  if (!result.canResolve) throw new Error(result.message);
  return result.plan;
}

function findClip(project: ProjectState, clipId: string) {
  return project.tracks.flatMap(track => track.clips).find(clip => clip.id === clipId)!;
}

function changedNotes(notes: readonly MidiNote[], delta = 1) {
  return notes.map((note, index) => index === 0 ? { ...note, pitch: note.pitch + delta } : note);
}

function save(project: ProjectState, clipId: string, notes: readonly MidiNote[], index: number) {
  const result = savePianoRollTake(project, { clipId, notes, identity: identity(index) });
  if (!result.canSave) throw new Error(result.message);
  return result;
}

function createCopiedProject(kind: SourceKind, copyKind: CopyKind = 'track') {
  let project = createPrintMixMidiProject();
  project.tracks[0].clips[0].lengthTicks = 3840;
  const originalId = project.tracks[0].clips[0].id;
  if (kind === 'edit') {
    const result = createNewPianoRollTake(project, { clipId: originalId, notes: resolve(project, originalId).midi.notes, identity: identity(0) });
    if (!result.canSave) throw new Error(result.message);
    project = result.project;
  }
  const sourceTrack = project.tracks[0];
  if (copyKind === 'clipboard') {
    const copied = createCopiedTimelineClip(sourceTrack.clips[0], new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.id))), createdAt,
      new Set(project.tracks.flatMap(track => track.clips.flatMap(clip => clip.clipTakes?.map(take => take.clipTakeId) ?? []))));
    copied.startTick = 4800;
    return { originalId, copiedId: copied.id, project: { ...project, totalTicks: 15360,
      tracks: project.tracks.map(track => track.id === sourceTrack.id ? { ...track, clips: [...track.clips, copied] } : track) } };
  }
  if (copyKind === 'group') {
    const group: Track = { id: 'shared-midi-group', name: 'Shared MIDI Group', type: 'group', level: 0, clips: [],
      group: { childTrackIds: [sourceTrack.id], activePlaybackTrackId: sourceTrack.id, collapsed: false, playbackMode: 'bottom_child' } };
    const grouped = { ...project, tracks: [{ ...sourceTrack, parentGroupId: group.id }, group, ...project.tracks.slice(1)] };
    const plan = resolveTrackGroupSubtreeCopyPlan(grouped.tracks, group.id);
    if (!plan.canCopy) throw new Error(plan.message);
    const copied = applyTrackGroupSubtreeCopyPlan(grouped, plan.plan);
    if (!copied.canCopy) throw new Error(copied.message);
    return { project: copied.project, originalId, copiedId: copied.clonedChildTracks[0].clips[0].id };
  }
  const copied = copyOrdinaryTimelineTrack(project.tracks, sourceTrack.id, copyKind === 'selected' ? [originalId] : undefined, createdAt);
  if (!copied.canCopy) throw new Error(copied.message);
  return { project: { ...project, tracks: copied.tracks }, originalId, copiedId: copied.track.clips[0].id };
}

function expectAllTakesActivate(project: ProjectState) {
  const ids = project.tracks.flatMap(track => track.clips.flatMap(clip => clip.clipTakes?.map(take => take.clipTakeId) ?? []));
  expect(new Set(ids).size).toBe(ids.length);
  project.tracks.forEach(track => track.clips.forEach(clip => {
    resolve(project, clip.id);
    clip.clipTakes?.forEach(take => {
      const activated = activateClipTake(project, clip.id, take.clipTakeId);
      if (!activated.canActivate) throw new Error(activated.message);
      resolve(activated.project, clip.id);
    });
  }));
}

async function exportMidi(project: ProjectState, clipId: string) {
  const planned = createTimelineExportPlan(project, { items: [{ type: 'clip', id: clipId }] });
  if (!planned.canExport || planned.plan.mediaType !== 'midi') throw new Error('MIDI export failed');
  return new Uint8Array(await encodeTimelineExportMidi(planned.plan).blob.arrayBuffer());
}
