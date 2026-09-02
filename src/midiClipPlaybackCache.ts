import { resolveActiveMidiTake } from './activeMidiTake';
import { secondsToTimelineTickOffset } from './audioClipTiming';
import type {
  LocalEngineClient,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import {
  isGroupTrack,
  resolveGroupPlaybackTrack,
  resolvePlaybackTarget,
  type PlaybackTarget,
} from './playbackTarget';
import type { ProjectPlaybackAudioSource } from './projectPlaybackRuntime';
import { inspectUncompressedWave } from './timelineExportEncoding';
import type { Clip, ProjectState, Track } from './types';

export type MidiClipPlaybackSourceSnapshot = Readonly<Record<
  string,
  | Readonly<{
      durationSeconds: number;
      lengthTicks: number;
      name: string;
      sourceId: string;
      status: 'READY';
    }>
  | Readonly<{
      message: string;
      status: 'UNAVAILABLE';
    }>
>>;

export type MidiClipPlaybackCachePreparation = Readonly<{
  renderedCount: number;
  reusedCount: number;
  snapshot: MidiClipPlaybackSourceSnapshot;
  sources: ReadonlyMap<string, ProjectPlaybackAudioSource>;
}>;

type SoundFontAuditionRenderer = Pick<LocalEngineClient, 'renderSoundFontAudition'>;

type MidiClipPlaybackCacheEntry = Readonly<{
  blob: Blob;
  durationSeconds: number;
  key: string;
  lengthTicks: number;
  name: string;
  sourceId: string;
}>;

export class MidiClipPlaybackCache {
  readonly #entries = new Map<string, MidiClipPlaybackCacheEntry>();
  readonly #entryKeyByClipId = new Map<string, string>();

  clear(): void {
    this.#entries.clear();
    this.#entryKeyByClipId.clear();
  }

  prune(project: ProjectState): void {
    const retainedClipIds = new Set(
      project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
    );

    for (const [clipId, key] of this.#entryKeyByClipId) {
      if (!retainedClipIds.has(clipId)) {
        this.#entries.delete(key);
        this.#entryKeyByClipId.delete(clipId);
      }
    }
  }

  async prepare(
    project: ProjectState,
    resources: readonly LocalEngineSoundFontResource[],
    renderer: SoundFontAuditionRenderer | undefined,
    signal?: AbortSignal,
  ): Promise<MidiClipPlaybackCachePreparation> {
    throwIfAborted(signal);

    const snapshot: Record<
      string,
      MidiClipPlaybackSourceSnapshot[string]
    > = {};
    const sources = new Map<string, ProjectPlaybackAudioSource>();
    this.prune(project);
    const clips = collectRequestedMidiClips(project);
    let renderedCount = 0;
    let reusedCount = 0;

    for (const clip of clips) {
      throwIfAborted(signal);

      if (!clip.soundFont) {
        continue;
      }

      const activeMidi = resolveActiveMidiTake(project, clip.id);

      if (!activeMidi.canResolve) {
        snapshot[clip.id] = Object.freeze({
          message: activeMidi.message,
          status: 'UNAVAILABLE',
        });
        continue;
      }

      if (activeMidi.plan.midi.notes.length === 0) {
        snapshot[clip.id] = Object.freeze({
          message: `${clip.name} has no MIDI notes to play.`,
          status: 'UNAVAILABLE',
        });
        continue;
      }

      const resource = resolveAssignedResource(clip, resources);

      if (!resource) {
        snapshot[clip.id] = Object.freeze({
          message: `${clip.name} SoundFont is offline. Restore the assigned resource first.`,
          status: 'UNAVAILABLE',
        });
        continue;
      }

      if (!renderer) {
        snapshot[clip.id] = Object.freeze({
          message: `${clip.name} requires Local Engine and Project Root access to prepare its SoundFont playback cache.`,
          status: 'UNAVAILABLE',
        });
        continue;
      }

      const key = createCacheKey(project, clip, resource, activeMidi.plan.source);
      let entry = this.#entries.get(key);

      if (entry) {
        reusedCount += 1;
      } else {
        const result = await renderer.renderSoundFontAudition(
          {
            bank: clip.soundFont.bank,
            midi: {
              bpm: project.bpm,
              notes: activeMidi.plan.midi.notes,
              ticksPerQuarter: activeMidi.plan.midi.ticksPerQuarter,
            },
            program: clip.soundFont.program,
            soundFont: {
              format: resource.format,
              library: resource.library,
              relativePath: resource.relativePath,
              resourceId: resource.resourceId,
              revisionToken: resource.revisionToken,
            },
          },
          signal,
        );

        throwIfAborted(signal);

        if (!result.ok) {
          snapshot[clip.id] = Object.freeze({
            message: result.message,
            status: 'UNAVAILABLE',
          });
          continue;
        }

        try {
          entry = await createCacheEntry(
            project,
            clip,
            resource,
            activeMidi.plan.midi.notes,
            key,
            result.wav,
          );
        } catch (error) {
          snapshot[clip.id] = Object.freeze({
            message:
              error instanceof Error
                ? error.message
                : `${clip.name} SoundFont playback cache is invalid.`,
            status: 'UNAVAILABLE',
          });
          continue;
        }

        const previousKey = this.#entryKeyByClipId.get(clip.id);

        if (previousKey && previousKey !== key) {
          this.#entries.delete(previousKey);
        }

        this.#entries.set(key, entry);
        this.#entryKeyByClipId.set(clip.id, key);
        renderedCount += 1;
      }

      snapshot[clip.id] = Object.freeze({
        durationSeconds: entry.durationSeconds,
        lengthTicks: entry.lengthTicks,
        name: entry.name,
        sourceId: entry.sourceId,
        status: 'READY',
      });
      sources.set(entry.sourceId, Object.freeze({
        data: entry.blob,
        kind: 'midi-cache',
        name: entry.name,
      }));
    }

    return Object.freeze({
      renderedCount,
      reusedCount,
      snapshot: Object.freeze(snapshot),
      sources,
    });
  }
}

export function hasRequestedSoundFontMidiClips(project: ProjectState): boolean {
  return collectRequestedMidiClips(project).some(
    (clip) => clip.soundFont !== undefined,
  );
}

async function createCacheEntry(
  project: ProjectState,
  clip: Clip,
  resource: LocalEngineSoundFontResource,
  notes: readonly Readonly<{ lengthTicks: number; startTick: number }>[],
  key: string,
  blob: Blob,
): Promise<MidiClipPlaybackCacheEntry> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sourceId = `midi-cache:${key}`;
  const inspected = inspectUncompressedWave(bytes, sourceId);
  const lastNoteEndTick = Math.max(
    ...notes.map((note) => note.startTick + note.lengthTicks),
  );
  const availableLengthTicks = secondsToTimelineTickOffset(
    inspected.durationSeconds,
    project.bpm,
  );
  const lengthTicks = Math.min(
    Math.round(clip.lengthTicks),
    lastNoteEndTick,
    availableLengthTicks,
  );

  if (lengthTicks < 1) {
    throw new Error(`${clip.name} SoundFont playback cache contains no playable audio.`);
  }

  return Object.freeze({
    blob,
    durationSeconds: inspected.durationSeconds,
    key,
    lengthTicks,
    name: `${clip.name} / ${resource.name} / B${clip.soundFont?.bank ?? 0} P${
      clip.soundFont?.program ?? 0
    }.wav`,
    sourceId,
  });
}

function collectRequestedMidiClips(project: ProjectState): Clip[] {
  const targetResolution = resolvePlaybackTarget(project.tracks, project.selection);

  if (!targetResolution.canTarget) {
    return [];
  }

  const target = targetResolution.target;

  if (target.kind === 'clip') {
    const clip = project.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === target.clipId);
    return clip && isMidiClip(clip) ? [clip] : [];
  }

  const trackIds = resolveTargetTrackIds(target, project.tracks);
  return project.tracks
    .filter((track) => trackIds.has(track.id))
    .flatMap((track) => track.clips.filter(isMidiClip));
}

function resolveTargetTrackIds(
  target: Exclude<PlaybackTarget, { kind: 'clip' }>,
  tracks: readonly Track[],
): ReadonlySet<string> {
  if (target.kind === 'track') {
    return new Set([target.trackId]);
  }

  if (target.kind === 'tracks') {
    return new Set(target.trackIds);
  }

  if (target.kind === 'group') {
    return new Set([target.activeTrackId]);
  }

  if (target.kind === 'groups') {
    return new Set(target.activeTrackIds);
  }

  const trackIds = new Set<string>();

  for (const track of tracks) {
    if (!track.parentGroupId && !isGroupTrack(track)) {
      trackIds.add(track.id);
    }

    if (!track.parentGroupId && isGroupTrack(track)) {
      const resolution = resolveGroupPlaybackTrack(track, tracks);
      if (resolution.canResolve) {
        trackIds.add(resolution.activeTrack.id);
      }
    }
  }

  return trackIds;
}

function resolveAssignedResource(
  clip: Clip,
  resources: readonly LocalEngineSoundFontResource[],
): LocalEngineSoundFontResource | undefined {
  const assignment = clip.soundFont;

  if (!assignment) {
    return undefined;
  }

  return resources.find(
    (resource) =>
      resource.format === assignment.resource.format &&
      resource.library === assignment.resource.library &&
      resource.relativePath === assignment.resource.relativePath &&
      resource.resourceId === assignment.resource.resourceId,
  );
}

function createCacheKey(
  project: ProjectState,
  clip: Clip,
  resource: LocalEngineSoundFontResource,
  source: Readonly<{
    clipTakeId: string;
    contentHash: string;
    revision: number;
  }>,
): string {
  return [
    encodeURIComponent(clip.id),
    encodeURIComponent(source.clipTakeId),
    source.contentHash,
    source.revision,
    project.bpm,
    resource.revisionToken,
    clip.soundFont?.bank ?? 0,
    clip.soundFont?.program ?? 0,
  ].join(':');
}

function isMidiClip(clip: Clip): boolean {
  return clip.type === 'edited-midi' || clip.type === 'midi-notes';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const error = new Error('MIDI Clip playback preparation was canceled.');
  error.name = 'AbortError';
  throw error;
}
