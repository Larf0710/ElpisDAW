import { describe, expect, it } from 'vitest';

import { createEmptyProject } from './emptyProject';
import { normalizeProjectArtifacts } from './projectArtifactRegistration';
import { inspectPcm16Wave } from './timelineExportEncoding';
import {
  materializePunchAudio,
} from './punchAudioMaterialization';
import {
  addPunchAttempt,
  createPunchSession,
  MAX_PUNCH_ATTEMPTS_PER_SESSION,
  resolvePunchTarget,
  selectPunchAttempt,
  togglePunchMarker,
  type PunchAttempt,
} from './punchSession';
import { createPunchTakeRegistration } from './punchTakeRegistration';
import {
  commitSessionEdit,
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
} from './sessionEditHistory';
import type { LocalEngineRecordingArtifact } from './localEngineClient';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
} from './types';

describe('Punch Session', () => {
  it('toggles individual Punch markers and only permits an armed ordered range', () => {
    const withIn = togglePunchMarker({}, 'in', 240);
    expect(withIn).toMatchObject({ state: { inTick: 240 }, status: 'set' });

    const rejectedOut = togglePunchMarker(withIn.state, 'out', 120);
    expect(rejectedOut).toMatchObject({ state: { inTick: 240 }, status: 'rejected' });

    const armed = togglePunchMarker(withIn.state, 'out', 720);
    expect(armed).toMatchObject({
      state: { inTick: 240, outTick: 720 },
      status: 'set',
    });

    const withoutIn = togglePunchMarker(armed.state, 'in', 360);
    expect(withoutIn).toMatchObject({ state: { outTick: 720 }, status: 'cleared' });
    expect(withoutIn.state.inTick).toBeUndefined();

    const rejectedIn = togglePunchMarker(withoutIn.state, 'in', 720);
    expect(rejectedIn).toMatchObject({ state: { outTick: 720 }, status: 'rejected' });

    const cleared = togglePunchMarker(withoutIn.state, 'out', 900);
    expect(cleared).toMatchObject({ state: {}, status: 'cleared' });
  });

  it('freezes one active Audio Take and keeps attempts outside Project state', () => {
    const project = createPunchProject();
    const target = resolvePunchTarget(project, 'clip-a', 240, 720);

    expect(target.canStart).toBe(true);
    if (!target.canStart) {
      return;
    }

    const session = createPunchSession(
      target,
      createWaveBlob({ channels: 2, frames: 8_000, sampleRate: 8_000 }),
      { createdAt: '2026-08-30T12:00:00.000Z', punchSessionId: 'punch-session-a' },
    );
    const attempt = createAttempt();
    const withAttempt = addPunchAttempt(session, attempt);

    expect(withAttempt.attempts).toHaveLength(1);
    expect(withAttempt.selectedAttemptId).toBe(attempt.punchAttemptId);
    expect(project.artifacts).toHaveLength(1);
    expect(project.tracks[0].clips[0].clipTakes).toHaveLength(1);
    expect(selectPunchAttempt(withAttempt, attempt.punchAttemptId)).toBe(withAttempt);
  });

  it('rejects a Punch range outside the selected Clip', () => {
    const result = resolvePunchTarget(createPunchProject(), 'clip-a', -1, 720);

    expect(result).toMatchObject({ canStart: false, reason: 'range-invalid' });
  });

  it('bounds temporary Attempt count before Project or browser memory grows without limit', () => {
    const target = resolvePunchTarget(createPunchProject(), 'clip-a', 240, 720);
    expect(target.canStart).toBe(true);
    if (!target.canStart) {
      return;
    }

    let session = createPunchSession(
      target,
      createWaveBlob({ channels: 2, frames: 8_000, sampleRate: 8_000 }),
      { createdAt: '2026-08-30T12:00:00.000Z', punchSessionId: 'punch-session-limit' },
    );

    for (let index = 0; index < MAX_PUNCH_ATTEMPTS_PER_SESSION; index += 1) {
      session = addPunchAttempt(session, {
        ...createAttempt(),
        punchAttemptId: `punch-attempt-${index}`,
      });
    }

    expect(() =>
      addPunchAttempt(session, {
        ...createAttempt(),
        punchAttemptId: 'punch-attempt-over-limit',
      }),
    ).toThrow(`limited to ${MAX_PUNCH_ATTEMPTS_PER_SESSION}`);
  });
});

describe('Punch Audio materialization', () => {
  it('creates one full stereo WAV while replacing only the captured range', async () => {
    const project = createPunchProject();
    const target = resolvePunchTarget(project, 'clip-a', 240, 720);
    expect(target.canStart).toBe(true);
    if (!target.canStart) {
      return;
    }

    const base = createWaveBlob({
      channels: 2,
      frames: 8_000,
      sampleRate: 8_000,
      sample: () => 0.25,
    });
    const session = addPunchAttempt(
      createPunchSession(target, base, {
        createdAt: '2026-08-30T12:00:00.000Z',
        punchSessionId: 'punch-session-a',
      }),
      createAttempt(),
    );
    const result = await materializePunchAudio(session, session.attempts[0], 120);
    const inspected = inspectPcm16Wave(
      new Uint8Array(await result.blob.arrayBuffer()),
      'punch-result',
    );
    expect(result).toMatchObject({ channels: 2, frameCount: 8_000, sampleRate: 8_000 });
    expect(readPcm16(inspected.bytes, inspected.dataOffset, 800, 0, 2)).toBeCloseTo(0.25, 2);
    expect(readPcm16(inspected.bytes, inspected.dataOffset, 2_000, 0, 2)).toBeCloseTo(-0.5, 2);
    expect(readPcm16(inspected.bytes, inspected.dataOffset, 7_200, 1, 2)).toBeCloseTo(0.25, 2);
  });
});

describe('Punch Take registration', () => {
  it('adds one active child Take without changing Clip geometry or timing', async () => {
    const project = createPunchProject();
    const target = resolvePunchTarget(project, 'clip-a', 240, 720);
    expect(target.canStart).toBe(true);
    if (!target.canStart) {
      return;
    }

    const session = addPunchAttempt(
      createPunchSession(
        target,
        createWaveBlob({ channels: 2, frames: 8_000, sampleRate: 8_000 }),
        { createdAt: '2026-08-30T12:00:00.000Z', punchSessionId: 'punch-session-a' },
      ),
      createAttempt(),
    );
    const materialization = await materializePunchAudio(
      session,
      session.attempts[0],
      120,
    );
    const saved = createSavedArtifact(materialization.byteLength);
    const result = createPunchTakeRegistration(
      project,
      session,
      session.attempts[0],
      saved,
      materialization,
    );

    expect(result.canRegister).toBe(true);
    if (!result.canRegister) {
      return;
    }

    expect(result.clip).toMatchObject({
      activeClipTakeId: 'clip-take-artifact-punch-a',
      audioTiming: { sourceEndSeconds: 1, sourceStartSeconds: 0 },
      lengthTicks: 960,
      startTick: 0,
    });
    expect(result.clip.clipTakes).toHaveLength(2);
    expect(result.artifact.lineage).toEqual({
      parentArtifactIds: ['artifact-base-a'],
      parentClipTakeIds: ['clip-take-base-a'],
    });
    expect(result.project.artifacts).toHaveLength(2);
    expect(normalizeProjectArtifacts(result.project.artifacts)).toContainEqual(
      result.artifact,
    );

    const opened = createSessionEditHistory(project, {
      category: 'system',
      createdAt: '2026-08-30T12:00:00.000Z',
      id: 'open',
      label: 'Open Project',
    });
    const kept = commitSessionEdit(
      opened,
      result.project,
      {
        category: 'take',
        createdAt: '2026-08-30T12:02:00.000Z',
        id: 'keep-punch',
        label: 'Keep Punch Take',
      },
      80,
    );
    const undone = undoSessionEdit(kept);
    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value).toBe(project);
    const redone = redoSessionEdit(undone.history, 80);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value).toBe(result.project);
  });
});

function createPunchProject(): ProjectState {
  const project = createEmptyProject();
  const artifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-base-a',
    audio: { channels: 2, durationSeconds: 1, mimeType: 'audio/wav' },
    createdAt: '2026-08-30T11:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-base-a.wav',
      relativePath: 'renders/instruments/artifact-base-a.wav',
      sizeBytes: 32_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'test',
      modelRevision: '1',
      parameters: {},
      providerId: 'test',
      taskId: 'test',
    },
    sourceJobId: 'job-base-a',
  };
  const take: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-base-a',
    createdAt: artifact.createdAt,
    label: 'Base Take',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
  const clip: Clip = {
    activeClipTakeId: take.clipTakeId,
    audioTiming: {
      sourceEndSeconds: 1,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    clipTakes: [take],
    color: '#55aacc',
    createdAt: artifact.createdAt,
    id: 'clip-a',
    lengthTicks: 960,
    name: 'Vocal',
    sourceFile: {
      durationSeconds: 1,
      mimeType: 'audio/wav',
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'available',
    },
    startTick: 0,
    type: 'hum-audio',
    version: 0,
  };

  return {
    ...project,
    artifacts: [artifact],
    bpm: 120,
    tracks: [{ clips: [clip], id: 'audio-a', level: 0, name: 'Audio', type: 'audio' }],
  };
}

function createAttempt(): PunchAttempt {
  return {
    blob: createWaveBlob({
      channels: 1,
      frames: 4_000,
      sampleRate: 8_000,
      sample: () => -0.5,
    }),
    capturedStartTick: 240,
    createdAt: '2026-08-30T12:01:00.000Z',
    durationSeconds: 0.5,
    punchAttemptId: 'punch-attempt-a',
    sampleRate: 8_000,
  };
}

function createSavedArtifact(sizeBytes: number): LocalEngineRecordingArtifact {
  return {
    artifactId: 'artifact-punch-a',
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
      sampleRate: 8_000,
    },
    createdAt: '2026-08-30T12:02:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-punch-a.wav',
      relativePath: 'recordings/artifact-punch-a.wav',
      sizeBytes,
    },
    kind: 'audio',
    status: 'FINALIZED',
  };
}

function createWaveBlob({
  channels,
  frames,
  sample = () => 0,
  sampleRate,
}: {
  channels: 1 | 2;
  frames: number;
  sample?: (frame: number, channel: number) => number;
  sampleRate: number;
}): Blob {
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, frames * channels * 2, true);

  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      view.setInt16(
        44 + (frame * channels + channel) * 2,
        Math.round(sample(frame, channel) * 32_767),
        true,
      );
    }
  }

  return new Blob([bytes], { type: 'audio/wav' });
}

function readPcm16(
  bytes: Uint8Array,
  dataOffset: number,
  frame: number,
  channel: number,
  channels: number,
): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(
    dataOffset + (frame * channels + channel) * 2,
    true,
  ) / 32_768;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
