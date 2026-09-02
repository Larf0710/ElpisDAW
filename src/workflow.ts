import { getClipTypeColor } from './clipTypeColors';
import type { Clip, ExportManifest, PatchTab, ProjectState, TimelineGridResolution, Track } from './types';

export const TICKS_PER_QUARTER = 960;
export const TICKS_PER_BEAT = TICKS_PER_QUARTER;
export const DEFAULT_TIMELINE_GRID_RESOLUTION: TimelineGridResolution = '1/8';
export const timelineGridResolutions: TimelineGridResolution[] = ['1/8', '1/16', '1/32', '1/64'];

export type RecordingSession = {
  trackId: string;
  startTick: number;
  startedAt: string;
  maximumEndTick?: number;
  targetClipId?: string;
};

type WorkflowClipResult = {
  project: ProjectState;
  clip: Clip;
};

export type InstrumentRenderOutputOptions = Readonly<{
  clipId: string;
  createdAt: string;
}>;

export function isHumPrepPatchTab(patchTab: PatchTab | undefined): patchTab is PatchTab {
  return patchTab?.inputType === 'Hum Audio' && patchTab.outputType === 'Hum Audio';
}

export function isHumToMidiPatchTab(patchTab: PatchTab | undefined): patchTab is PatchTab {
  return patchTab?.inputType === 'Hum Audio' && patchTab.outputType === 'MIDI Notes';
}

export function isMidiEditPatchTab(patchTab: PatchTab | undefined): patchTab is PatchTab {
  return patchTab?.inputType === 'MIDI Notes' && patchTab.outputType === 'Edited MIDI';
}

export function isInstrumentPatchTab(patchTab: PatchTab | undefined): patchTab is PatchTab {
  return patchTab?.inputType === 'Edited MIDI' && patchTab.outputType === 'Instrument Audio';
}

export function isExportPatchTab(patchTab: PatchTab | undefined): patchTab is PatchTab {
  return patchTab?.inputType === 'Selected Clip' && patchTab.outputType === 'Export File';
}

export function createRecordingSession(
  project: ProjectState,
  startTick = project.playheadTick,
  targetClipId?: string,
  trackId = 'hum-audio',
): RecordingSession {
  return {
    trackId,
    startTick: clampTick(startTick, 0, Math.max(0, project.totalTicks - 1)),
    startedAt: new Date().toISOString(),
    ...(targetClipId ? { targetClipId } : {}),
  };
}

export function createDummyMidiConversion(
  project: ProjectState,
  sourceClip: Clip,
  converterPatchTab: PatchTab,
): WorkflowClipResult {
  const tracksWithMidiNotes = ensureMidiNotesTrack(project.tracks);
  const midiNotesTrack = tracksWithMidiNotes.find((track) => track.id === 'midi-notes') ?? tracksWithMidiNotes[0];
  const clip = createDummyMidiClip(sourceClip, converterPatchTab, midiNotesTrack);

  return addClipToTrack(project, tracksWithMidiNotes, midiNotesTrack.id, clip);
}

export function createDummyMidiEdit(
  project: ProjectState,
  sourceClip: Clip,
  editorPatchTab: PatchTab,
): WorkflowClipResult {
  const tracksWithEditedMidi = ensureEditedMidiTrack(project.tracks);
  const editedMidiTrack = tracksWithEditedMidi.find((track) => track.id === 'edited-midi') ?? tracksWithEditedMidi[0];
  const clip = createEditedMidiClip(sourceClip, editorPatchTab, editedMidiTrack);

  return addClipToTrack(project, tracksWithEditedMidi, editedMidiTrack.id, clip);
}

export function createDummyInstrumentRender(
  project: ProjectState,
  sourceClip: Clip,
  instrumentPatchTab: PatchTab,
): WorkflowClipResult {
  const tracksWithInstrumentAudio = ensureInstrumentAudioTrack(project.tracks);
  const instrumentAudioTrack =
    tracksWithInstrumentAudio.find((track) => track.id === 'instrument-audio') ?? tracksWithInstrumentAudio[0];
  const clip = createInstrumentAudioClip(sourceClip, instrumentPatchTab, instrumentAudioTrack);

  return addClipToTrack(project, tracksWithInstrumentAudio, instrumentAudioTrack.id, clip);
}

export function createInstrumentRenderOutput(
  project: ProjectState,
  sourceClip: Clip,
  instrumentPatchTab: PatchTab,
  options: InstrumentRenderOutputOptions,
): WorkflowClipResult {
  if (
    options.clipId.length === 0 ||
    options.clipId.trim() !== options.clipId ||
    Number.isNaN(Date.parse(options.createdAt))
  ) {
    throw new Error(
      'Instrument Render output requires one trimmed Clip ID and valid creation timestamp.',
    );
  }

  if (
    project.tracks.some((track) =>
      track.clips.some((clip) => clip.id === options.clipId),
    )
  ) {
    throw new Error(
      `Instrument Render output Clip ID already exists: ${options.clipId}.`,
    );
  }

  const existingTargetTracks = project.tracks.filter(
    (track) => track.id === 'instrument-audio',
  );

  if (
    existingTargetTracks.length > 1 ||
    (existingTargetTracks.length === 1 &&
      existingTargetTracks[0].type !== 'audio')
  ) {
    throw new Error(
      'Instrument Render output requires one valid Instrument Audio Track identity.',
    );
  }

  const tracksWithInstrumentAudio = ensureInstrumentAudioTrack(project.tracks);
  const instrumentAudioTrack =
    tracksWithInstrumentAudio.find((track) => track.id === 'instrument-audio') ??
    tracksWithInstrumentAudio[0];
  const clip = createInstrumentAudioClip(
    sourceClip,
    instrumentPatchTab,
    instrumentAudioTrack,
    options,
  );

  return addClipToTrack(
    project,
    tracksWithInstrumentAudio,
    instrumentAudioTrack.id,
    clip,
  );
}

export function createDummyClipExport(
  project: ProjectState,
  sourceClip: Clip,
  exportPatchTab: PatchTab,
): WorkflowClipResult {
  const tracksWithMaster = ensureMasterTrack(project.tracks);
  const masterTrack = tracksWithMaster.find((track) => track.id === 'master') ?? tracksWithMaster[0];
  const clip = createMixdownClip(project, sourceClip, exportPatchTab, masterTrack);

  return addClipToTrack(project, tracksWithMaster, masterTrack.id, clip);
}

export function formatParameterSnapshotBadge(label: string, value: string | number): string {
  return `${label}: ${value}`;
}

export function beatsToTicks(beats: number): number {
  return Math.round(beats * TICKS_PER_BEAT);
}

export function ticksToBeats(ticks: number): number {
  return ticks / TICKS_PER_BEAT;
}

export function clampTick(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isTimelineGridResolution(value: unknown): value is TimelineGridResolution {
  return timelineGridResolutions.includes(value as TimelineGridResolution);
}

export function getTimelineGridResolutionTickStep(gridResolution: TimelineGridResolution): number {
  const denominator = Number(gridResolution.slice(2));
  const wholeNoteTicks = TICKS_PER_QUARTER * 4;

  return Math.max(1, Math.round(wholeNoteTicks / denominator));
}

export function resolveTimelineTick(
  rawTick: number,
  gridResolution: TimelineGridResolution,
  totalTicks: number,
): number {
  const safeTotalTicks = Math.max(0, Math.round(totalTicks));
  const clampedTick = clampTick(Math.round(rawTick), 0, safeTotalTicks);
  const gridStepTicks = getTimelineGridResolutionTickStep(gridResolution);

  return clampTick(Math.round(clampedTick / gridStepTicks) * gridStepTicks, 0, safeTotalTicks);
}

function addClipToTrack(
  project: ProjectState,
  tracks: Track[],
  targetTrackId: string,
  clip: Clip,
): WorkflowClipResult {
  return {
    project: {
      ...project,
      tracks: tracks.map((track) =>
        track.id === targetTrackId
          ? {
              ...track,
              clips: [...track.clips, clip],
            }
          : track,
      ),
    },
    clip,
  };
}

function ensureMidiNotesTrack(tracks: Track[]): Track[] {
  if (tracks.some((track) => track.id === 'midi-notes')) {
    return tracks;
  }

  const midiNotesTrack: Track = {
    id: 'midi-notes',
    name: 'MIDI Notes',
    type: 'midi',
    level: -6,
    clips: [],
  };
  const humAudioTrackIndex = tracks.findIndex((track) => track.id === 'hum-audio');

  if (humAudioTrackIndex < 0) {
    return [midiNotesTrack, ...tracks];
  }

  return [
    ...tracks.slice(0, humAudioTrackIndex + 1),
    midiNotesTrack,
    ...tracks.slice(humAudioTrackIndex + 1),
  ];
}

function createDummyMidiClip(sourceClip: Clip, converterPatchTab: PatchTab, track: Track): Clip {
  const takeNumber = getNextDummyMidiTakeNumber(track);

  return {
    id: `clip-midi-${sanitizeClipIdPart(sourceClip.id)}-${takeNumber}`,
    type: 'midi-notes',
    name: `MIDI Take ${String(takeNumber).padStart(2, '0')}`,
    startTick: sourceClip.startTick,
    lengthTicks: sourceClip.lengthTicks,
    color: getClipTypeColor('midi-notes'),
    sourceClipId: sourceClip.id,
    generatedBy: converterPatchTab.name,
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

function getNextDummyMidiTakeNumber(track: Track): number {
  return track.clips.filter((clip) => clip.type === 'midi-notes').length + 1;
}

function ensureEditedMidiTrack(tracks: Track[]): Track[] {
  if (tracks.some((track) => track.id === 'edited-midi')) {
    return tracks;
  }

  const editedMidiTrack: Track = {
    id: 'edited-midi',
    name: 'Edited MIDI',
    type: 'midi',
    level: -6,
    clips: [],
  };
  const midiNotesTrackIndex = tracks.findIndex((track) => track.id === 'midi-notes');

  if (midiNotesTrackIndex < 0) {
    return [editedMidiTrack, ...tracks];
  }

  return [
    ...tracks.slice(0, midiNotesTrackIndex + 1),
    editedMidiTrack,
    ...tracks.slice(midiNotesTrackIndex + 1),
  ];
}

function createEditedMidiClip(sourceClip: Clip, editorPatchTab: PatchTab, track: Track): Clip {
  const takeNumber = getNextEditedMidiTakeNumber(track);

  return {
    id: `clip-edited-midi-${sanitizeClipIdPart(sourceClip.id)}-${takeNumber}`,
    type: 'edited-midi',
    name: `Edited MIDI ${String(takeNumber).padStart(2, '0')}`,
    startTick: sourceClip.startTick,
    lengthTicks: sourceClip.lengthTicks,
    color: getClipTypeColor('edited-midi'),
    sourceClipId: sourceClip.id,
    generatedBy: editorPatchTab.name,
    parameterSnapshot: createParameterSnapshot(editorPatchTab),
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

function getNextEditedMidiTakeNumber(track: Track): number {
  return track.clips.filter((clip) => clip.type === 'edited-midi').length + 1;
}

function createParameterSnapshot(patchTab: PatchTab): Record<string, string | number> {
  return Object.fromEntries(patchTab.parameters.map((parameter) => [parameter.label, parameter.value]));
}

function ensureInstrumentAudioTrack(tracks: Track[]): Track[] {
  if (tracks.some((track) => track.id === 'instrument-audio')) {
    return tracks;
  }

  const instrumentAudioTrack: Track = {
    id: 'instrument-audio',
    name: 'Instrument Audio',
    type: 'audio',
    level: -5,
    clips: [],
  };
  const editedMidiTrackIndex = tracks.findIndex((track) => track.id === 'edited-midi');

  if (editedMidiTrackIndex >= 0) {
    return [
      ...tracks.slice(0, editedMidiTrackIndex + 1),
      instrumentAudioTrack,
      ...tracks.slice(editedMidiTrackIndex + 1),
    ];
  }

  const midiNotesTrackIndex = tracks.findIndex((track) => track.id === 'midi-notes');

  if (midiNotesTrackIndex >= 0) {
    return [
      ...tracks.slice(0, midiNotesTrackIndex + 1),
      instrumentAudioTrack,
      ...tracks.slice(midiNotesTrackIndex + 1),
    ];
  }

  return [instrumentAudioTrack, ...tracks];
}

function createInstrumentAudioClip(
  sourceClip: Clip,
  instrumentPatchTab: PatchTab,
  track: Track,
  identity?: InstrumentRenderOutputOptions,
): Clip {
  const takeNumber = getNextInstrumentAudioTakeNumber(track);
  const instrumentPatchName = getPatchTabParameterValue(instrumentPatchTab, 'Patch');
  const soundFontFileName = sourceClip.soundFont?.resource.relativePath
    .split('/')
    .pop()
    ?.replace(/\.(?:sf2|sf3)$/i, '');
  const clipNamePrefix =
    soundFontFileName ||
    (typeof instrumentPatchName === 'string'
      ? instrumentPatchName
      : 'Instrument Print');
  const parameterSnapshot = sourceClip.soundFont
    ? {
        Bank: sourceClip.soundFont.bank,
        Program: sourceClip.soundFont.program,
        SoundFont: sourceClip.soundFont.resource.relativePath,
      }
    : createParameterSnapshot(instrumentPatchTab);

  return {
    id:
      identity?.clipId ??
      `clip-instrument-${sanitizeClipIdPart(sourceClip.id)}-${takeNumber}`,
    type: 'instrument-audio',
    name: `${clipNamePrefix} ${String(takeNumber).padStart(2, '0')}`,
    startTick: sourceClip.startTick,
    lengthTicks: sourceClip.lengthTicks,
    color: getClipTypeColor('instrument-audio'),
    sourceClipId: sourceClip.id,
    generatedBy: instrumentPatchTab.name,
    parameterSnapshot,
    createdAt: identity?.createdAt ?? new Date().toISOString(),
    version: 1,
  };
}

function getNextInstrumentAudioTakeNumber(track: Track): number {
  return track.clips.filter((clip) => clip.type === 'instrument-audio').length + 1;
}

function getPatchTabParameterValue(patchTab: PatchTab, label: string): string | number | undefined {
  return patchTab.parameters.find((parameter) => parameter.label === label)?.value;
}

function ensureMasterTrack(tracks: Track[]): Track[] {
  if (tracks.some((track) => track.id === 'master')) {
    return tracks;
  }

  const masterTrack: Track = {
    id: 'master',
    name: 'Master',
    type: 'master',
    level: -2,
    clips: [],
  };
  const arrangementTrackIndex = tracks.findIndex((track) => track.id === 'arrangement');

  if (arrangementTrackIndex >= 0) {
    return [
      ...tracks.slice(0, arrangementTrackIndex + 1),
      masterTrack,
      ...tracks.slice(arrangementTrackIndex + 1),
    ];
  }

  return [...tracks, masterTrack];
}

function createMixdownClip(
  project: ProjectState,
  sourceClip: Clip,
  exportPatchTab: PatchTab,
  track: Track,
): Clip {
  const takeNumber = getNextMixdownTakeNumber(track);
  const format = getPatchTabParameterValue(exportPatchTab, 'Format');
  const formatPrefix = typeof format === 'string' ? format : 'Mixdown';
  const normalize = getPatchTabParameterValue(exportPatchTab, 'Normalize');
  const clipId = `clip-mixdown-${sanitizeClipIdPart(sourceClip.id)}-${takeNumber}`;
  const createdAt = new Date().toISOString();
  const durationTicks = Math.max(1, Math.min(project.totalTicks, sourceClip.lengthTicks));

  return {
    id: clipId,
    type: 'mixdown',
    name: `${formatPrefix} Clip Export ${String(takeNumber).padStart(2, '0')}`,
    startTick: 0,
    lengthTicks: durationTicks,
    color: getClipTypeColor('mixdown'),
    sourceClipId: sourceClip.id,
    generatedBy: exportPatchTab.name,
    parameterSnapshot: createParameterSnapshot(exportPatchTab),
    exportManifest: createExportManifest({
      clipId,
      project,
      sourceClip,
      format: typeof format === 'string' ? format : 'WAV',
      normalize: typeof normalize === 'string' ? normalize : 'Off',
      durationTicks,
      takeNumber,
      createdAt,
    }),
    createdAt,
    version: 1,
  };
}

function getNextMixdownTakeNumber(track: Track): number {
  return track.clips.filter((clip) => clip.type === 'mixdown').length + 1;
}

type ExportManifestInput = {
  clipId: string;
  project: ProjectState;
  sourceClip: Clip;
  format: string;
  normalize: string;
  durationTicks: number;
  takeNumber: number;
  createdAt: string;
};

function createExportManifest({
  clipId,
  project,
  sourceClip,
  format,
  normalize,
  durationTicks,
  takeNumber,
  createdAt,
}: ExportManifestInput): ExportManifest {
  return {
    id: `manifest-${sanitizeClipIdPart(clipId)}`,
    targetClipId: clipId,
    sourceClipId: sourceClip.id,
    format,
    normalize,
    durationTicks,
    estimatedFileName: createEstimatedExportFileName(project, sourceClip, format, takeNumber),
    status: 'mock-ready',
    createdAt,
    version: 1,
  };
}

function createEstimatedExportFileName(
  project: ProjectState,
  sourceClip: Clip,
  format: string,
  takeNumber: number,
): string {
  const projectName = sanitizeFileNamePart(project.name) || 'elpisdaw';
  const sourceName = sanitizeFileNamePart(sourceClip.name) || 'clip';
  const extension = getExportExtension(format);

  return `${projectName}-${sourceName}-export-${String(takeNumber).padStart(2, '0')}.${extension}`;
}

function getExportExtension(format: string): string {
  const normalizedFormat = format.trim().toLowerCase();

  if (normalizedFormat === 'midi') {
    return 'mid';
  }

  if (normalizedFormat === 'mp3') {
    return 'mp3';
  }

  return 'wav';
}

function sanitizeFileNamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function sanitizeClipIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48);
}
