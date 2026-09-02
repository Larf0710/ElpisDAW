import { describe, expect, it, vi } from 'vitest';

import {
  downloadTimelineExportInBrowser,
  TimelineExportUiController,
  type TimelineExportBrowserAnchor,
  type TimelineExportBrowserEnvironment,
} from './timelineExportUiController';
import { createTimelineExportDownload } from './timelineExportDownload';
import { createTimelineExportPlan } from './timelineExportPlan';
import {
  PRINT_MIX_TEST_SOURCE_FRAMES,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint';
import type { ProjectState } from './types';

describe('TimelineExportUiController', () => {
  it.each([
    ['Audio Clip', createAudioClipProject, 'audio', 'clip', 'WAV'],
    ['Audio Track', createAudioTrackProject, 'audio', 'track', 'WAV'],
    ['MIDI Clip', createMidiClipProject, 'midi', 'clip', 'MIDI'],
    ['MIDI Track', createMidiTrackProject, 'midi', 'track', 'MIDI'],
  ] as const)(
    'downloads exactly one selected %s through the committed Timeline EXPORT core',
    async (_label, createProject, mediaType, targetKind, format) => {
      const project = createProject();
      const before = structuredClone(project);
      const beforeDirtyState = createProjectDirtyStateFingerprint(project);
      const downloadToBrowser = vi.fn();
      const controller = new TimelineExportUiController(downloadToBrowser);
      const result = await controller.run({
        getProject: () => project,
        readGeneratedAudio:
          mediaType === 'audio'
            ? async (descriptor) => ({
                ok: true,
                wav: createWaveBlob(descriptor.sizeBytes),
              })
            : undefined,
      });

      expect(result).toMatchObject({
        download: {
          format,
          kind: 'timeline-export',
          mediaType,
          target: { kind: targetKind },
        },
        reason: 'downloaded',
        tone: 'success',
      });
      expect(downloadToBrowser).toHaveBeenCalledOnce();
      expect(project).toEqual(before);
      expect(createProjectDirtyStateFingerprint(project)).toBe(beforeDirtyState);
      expect(controller.isPreparing).toBe(false);
    },
  );

  it.each([
    ['missing selection', () => withSelection(createPrintMixAudioProject(), [])],
    [
      'multiple Clips',
      () =>
        withSelection(createPrintMixAudioProject(), [
          { id: 'audio-clip-1', type: 'clip' },
          { id: 'audio-clip-2', type: 'clip' },
        ]),
    ],
    [
      'mixed targets',
      () =>
        withSelection(createPrintMixAudioProject(), [
          { id: 'audio-track-1', type: 'track' },
          { id: 'audio-clip-1', type: 'clip' },
        ]),
    ],
    [
      'stale target',
      () =>
        withSelection(createPrintMixAudioProject(), [
          { id: 'missing-clip', type: 'clip' },
        ]),
    ],
    [
      'unsupported target',
      () => {
        const project = createPrintMixAudioProject();
        project.tracks[0].type = 'master';
        return withSelection(project, [{ id: 'audio-track-1', type: 'track' }]);
      },
    ],
    [
      'empty Track',
      () => {
        const project = createPrintMixAudioProject();
        project.tracks[0].clips = [];
        return withSelection(project, [{ id: 'audio-track-1', type: 'track' }]);
      },
    ],
  ] as const)('blocks %s without download or mutation', async (_label, createProject) => {
    const project = createProject();
    const before = structuredClone(project);
    const downloadToBrowser = vi.fn();
    const controller = new TimelineExportUiController(downloadToBrowser);
    const result = await controller.run({ getProject: () => project });

    expect(result).toMatchObject({
      message: 'EXPORT BLOCKED',
      reason: 'selection-blocked',
      tone: 'warning',
    });
    expect(downloadToBrowser).not.toHaveBeenCalled();
    expect(project).toEqual(before);

    if (_label === 'multiple Clips' || _label === 'mixed targets') {
      expect(result.helpText).toContain('PRINT MIX');
    }
  });

  it('prevents duplicate preparation and releases the busy lock after completion', async () => {
    const project = createAudioClipProject();
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const downloadToBrowser = vi.fn();
    const controller = new TimelineExportUiController(downloadToBrowser);
    const first = controller.run({
      getProject: () => project,
      readGeneratedAudio: async (descriptor) => {
        await readGate;
        return { ok: true, wav: createWaveBlob(descriptor.sizeBytes) };
      },
    });

    expect(controller.isPreparing).toBe(true);
    await expect(controller.run({ getProject: () => project })).resolves.toMatchObject({
      message: 'EXPORT BUSY',
      reason: 'busy',
    });
    expect(downloadToBrowser).not.toHaveBeenCalled();

    releaseRead?.();
    await expect(first).resolves.toMatchObject({ reason: 'downloaded' });
    expect(downloadToBrowser).toHaveBeenCalledOnce();
    expect(controller.isPreparing).toBe(false);
  });

  it('interrupts safely when selection changes during preparation', async () => {
    const project = createAudioClipProject();
    const downloadToBrowser = vi.fn();
    const controller = new TimelineExportUiController(downloadToBrowser);
    const result = await controller.run({
      getProject: () => project,
      readGeneratedAudio: async (descriptor) => {
        project.selection = { items: [{ id: 'audio-clip-2', type: 'clip' }] };
        return { ok: true, wav: createWaveBlob(descriptor.sizeBytes) };
      },
    });

    expect(result).toMatchObject({
      message: 'EXPORT FAILED',
      reason: 'preparation-failed',
    });
    expect(downloadToBrowser).not.toHaveBeenCalled();
  });

  it('interrupts before browser download when the live Project changes after encoding', async () => {
    const project = createMidiClipProject();
    const changedProject = structuredClone(project);
    changedProject.selection = { items: [{ id: 'midi-clip-2', type: 'clip' }] };
    const downloadToBrowser = vi.fn();
    const controller = new TimelineExportUiController(downloadToBrowser);
    let projectReadCount = 0;
    const result = await controller.run({
      getProject: () => (projectReadCount++ === 0 ? project : changedProject),
    });

    expect(result).toMatchObject({
      message: 'EXPORT INTERRUPTED',
      reason: 'interrupted',
      tone: 'warning',
    });
    expect(downloadToBrowser).not.toHaveBeenCalled();
  });

  it('reports browser failure explicitly and preserves Project state', async () => {
    const project = createMidiClipProject();
    const before = structuredClone(project);
    const controller = new TimelineExportUiController(() => {
      throw new Error('Download canceled.');
    });
    const result = await controller.run({ getProject: () => project });

    expect(result).toMatchObject({
      message: 'EXPORT FAILED',
      reason: 'browser-failed',
      tone: 'error',
    });
    expect(project).toEqual(before);
  });

  it('presents clipping evidence without normalization or limiting claims', async () => {
    const project = createAudioTrackProject();
    const controller = new TimelineExportUiController(vi.fn());
    const result = await controller.run({
      getProject: () => project,
      readGeneratedAudio: async (descriptor) => ({
        ok: true,
        wav: createWaveBlob(descriptor.sizeBytes, 0.75),
      }),
    });

    expect(result).toMatchObject({
      download: { warning: { clipping: true } },
      message: 'CLIPPING WARNING',
      reason: 'downloaded',
      tone: 'warning',
    });
    expect(result.helpText).toMatch(/clipping risk; no normalization or limiting was applied/i);
  });
});

describe('downloadTimelineExportInBrowser', () => {
  it('uses the immutable descriptor filename and cleans up its temporary anchor and object URL', async () => {
    const descriptor = await createMidiDescriptor();
    const anchor = createAnchor();
    const cleanup: Array<() => void> = [];
    const environment = createEnvironment(anchor, cleanup);

    downloadTimelineExportInBrowser(descriptor, environment);

    expect(environment.createObjectUrl).toHaveBeenCalledWith(descriptor.blob);
    expect(environment.appendAnchor).toHaveBeenCalledWith(anchor);
    expect(anchor.href).toBe('blob:timeline-export');
    expect(anchor.download).toBe(descriptor.fileName);
    expect(anchor.hidden).toBe(true);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(environment.revokeObjectUrl).not.toHaveBeenCalled();

    cleanup[0]();
    expect(environment.revokeObjectUrl).toHaveBeenCalledWith('blob:timeline-export');
  });

  it('removes and revokes temporary browser resources when clicking fails', async () => {
    const descriptor = await createMidiDescriptor();
    const anchor = createAnchor();
    const cleanup: Array<() => void> = [];
    const environment = createEnvironment(anchor, cleanup);
    vi.mocked(anchor.click).mockImplementation(() => {
      throw new Error('Blocked.');
    });

    expect(() => downloadTimelineExportInBrowser(descriptor, environment)).toThrow('Blocked.');
    expect(anchor.remove).toHaveBeenCalledOnce();
    cleanup[0]();
    expect(environment.revokeObjectUrl).toHaveBeenCalledWith('blob:timeline-export');
  });
});

function createAudioClipProject(): ProjectState {
  return withSelection(createPrintMixAudioProject(), [
    { id: 'audio-clip-1', type: 'clip' },
  ]);
}

function createAudioTrackProject(): ProjectState {
  const project = createPrintMixAudioProject();
  const secondClip = project.tracks[1].clips[0];
  project.tracks[0].clips[0].startTick = 960;
  secondClip.startTick = 960;
  project.tracks[0].clips.push(secondClip);
  project.tracks[1].clips = [];
  return withSelection(project, [{ id: 'audio-track-1', type: 'track' }]);
}

function createMidiClipProject(): ProjectState {
  return withSelection(createPrintMixMidiProject(), [
    { id: 'midi-clip-1', type: 'clip' },
  ]);
}

function createMidiTrackProject(): ProjectState {
  const project = createPrintMixMidiProject();
  const secondClip = project.tracks[1].clips[0];
  secondClip.startTick = 1_440;
  project.tracks[0].clips.push(secondClip);
  project.tracks[1].clips = [];
  return withSelection(project, [{ id: 'midi-track-1', type: 'track' }]);
}

function withSelection(
  project: ProjectState,
  items: ProjectState['selection']['items'],
): ProjectState {
  project.selection = { items };
  return project;
}

function createWaveBlob(sizeBytes: number, sample = 0.25): Blob {
  const dataByteLength = sizeBytes - 44;
  const frameCount = dataByteLength / 4;

  if (!Number.isInteger(frameCount) || frameCount !== PRINT_MIX_TEST_SOURCE_FRAMES) {
    throw new Error('Unexpected Timeline Export fixture WAV size.');
  }

  const bytes = new Uint8Array(sizeBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44_100, true);
  view.setUint32(28, 176_400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataByteLength, true);
  const pcm = Math.round(sample * 32_767);

  for (let frame = 0; frame < frameCount; frame += 1) {
    view.setInt16(44 + frame * 4, pcm, true);
    view.setInt16(46 + frame * 4, pcm, true);
  }

  return new Blob([bytes.buffer], { type: 'audio/wav' });
}

async function createMidiDescriptor() {
  const project = createMidiClipProject();
  const plan = createTimelineExportPlan(project);

  if (!plan.canExport) {
    throw new Error(plan.message);
  }

  const resolution = await createTimelineExportDownload(project, plan.plan);

  if (!resolution.canDownload) {
    throw new Error(resolution.message);
  }

  return resolution.download;
}

function createAnchor(): TimelineExportBrowserAnchor {
  return {
    click: vi.fn(),
    download: '',
    hidden: false,
    href: '',
    remove: vi.fn(),
  };
}

function createEnvironment(
  anchor: TimelineExportBrowserAnchor,
  cleanup: Array<() => void>,
): TimelineExportBrowserEnvironment {
  return {
    appendAnchor: vi.fn(),
    createAnchor: vi.fn(() => anchor),
    createObjectUrl: vi.fn(() => 'blob:timeline-export'),
    revokeObjectUrl: vi.fn(),
    scheduleCleanup: vi.fn((callback) => {
      cleanup.push(callback);
    }),
  };
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
