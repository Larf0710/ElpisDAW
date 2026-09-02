import type { LocalEngineRecordingArtifact } from './localEngineClient';
import type { PunchAudioMaterialization } from './punchAudioMaterialization';
import type { PunchAttempt, PunchSession } from './punchSession';
import type {
  Clip,
  ProjectState,
  PunchAudioArtifact,
  RecordingAudioClipTake,
} from './types';

export type PunchTakeRegistration =
  | Readonly<{
      artifact: PunchAudioArtifact;
      canRegister: true;
      clip: Clip;
      clipTake: RecordingAudioClipTake;
      project: ProjectState;
      status: 'REGISTERED';
    }>
  | Readonly<{
      canRegister: false;
      message: string;
      reason:
        | 'artifact-invalid'
        | 'project-drift'
        | 'target-missing';
      status: 'BLOCKED';
    }>;

export function createPunchTakeRegistration(
  project: ProjectState,
  session: PunchSession,
  attempt: PunchAttempt,
  saved: LocalEngineRecordingArtifact,
  materialization: PunchAudioMaterialization,
): PunchTakeRegistration {
  if (
    saved.audio.bitsPerSample !== materialization.bitsPerSample ||
    saved.audio.channels !== materialization.channels ||
    saved.audio.mimeType !== materialization.mimeType ||
    saved.audio.sampleRate !== materialization.sampleRate ||
    saved.file.sizeBytes !== materialization.byteLength ||
    Math.abs(saved.audio.durationSeconds - materialization.durationSeconds) >
      1 / materialization.sampleRate
  ) {
    return fail(
      'artifact-invalid',
      'Saved Punch WAV metadata does not match the materialized candidate.',
    );
  }

  let target:
    | Readonly<{ clip: Clip; clipIndex: number; trackIndex: number }>
    | undefined;

  project.tracks.forEach((track, trackIndex) => {
    track.clips.forEach((clip, clipIndex) => {
      if (clip.id === session.clip.id) {
        target = { clip, clipIndex, trackIndex };
      }
    });
  });

  if (!target) {
    return fail('target-missing', 'Punch target Clip no longer exists.');
  }

  const targetClip: Clip = target.clip;
  const baseTakeStillExists = (targetClip.clipTakes ?? []).some(
    (take) =>
      take.clipTakeId === session.baseClipTake.clipTakeId &&
      take.artifactId === session.baseArtifact.artifactId,
  );

  if (
    !baseTakeStillExists ||
    targetClip.activeClipTakeId !== session.baseClipTake.clipTakeId ||
    targetClip.version !== session.clip.version ||
    targetClip.startTick !== session.clip.startTick ||
    targetClip.lengthTicks !== session.clip.lengthTicks ||
    JSON.stringify(targetClip.audioTiming) !== JSON.stringify(session.clip.audioTiming)
  ) {
    return fail(
      'project-drift',
      'Punch target changed after the session was frozen. Keep is blocked to protect the Base Take.',
    );
  }

  const artifact: PunchAudioArtifact = {
    artifactId: saved.artifactId,
    audio: {
      bitsPerSample: 16,
      channels: materialization.channels,
      durationSeconds: materialization.durationSeconds,
      mimeType: 'audio/wav',
      sampleRate: materialization.sampleRate,
    },
    capture: {
      ...(attempt.inputDeviceId ? { inputDeviceId: attempt.inputDeviceId } : {}),
      ...(attempt.inputDeviceLabel ? { inputDeviceLabel: attempt.inputDeviceLabel } : {}),
      source: 'punch',
    },
    createdAt: saved.createdAt,
    destination: 'recording',
    file: { ...saved.file },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [session.baseArtifact.artifactId],
      parentClipTakeIds: [session.baseClipTake.clipTakeId],
    },
    punch: {
      baseArtifactId: session.baseArtifact.artifactId,
      baseClipTakeId: session.baseClipTake.clipTakeId,
      clipId: session.clip.id,
      punchInTick: session.range.inTick,
      punchOutTick: session.range.outTick,
      rendererId: 'humstudio.pipo.pcm16',
      rendererVersion: '1.0.0',
      schemaVersion: 1,
    },
  };
  const takeNumber = (targetClip.clipTakes?.length ?? 0) + 1;
  const clipTake: RecordingAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label: `Punch Take ${String(takeNumber).padStart(2, '0')}`,
    mediaType: 'audio',
    sourceType: 'recording',
  };
  const nextClip: Clip = {
    ...targetClip,
    activeClipTakeId: clipTake.clipTakeId,
    audioTiming: targetClip.audioTiming
      ? { ...targetClip.audioTiming }
      : undefined,
    clipTakes: [...(targetClip.clipTakes ?? []), clipTake],
    sourceFile: {
      checkedAt: artifact.createdAt,
      durationSeconds: artifact.audio.durationSeconds,
      mimeType: artifact.audio.mimeType,
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'available',
    },
    version: targetClip.version + 1,
  };
  const nextProject: ProjectState = {
    ...project,
    artifacts: [...(project.artifacts ?? []), artifact],
    tracks: project.tracks.map((track, trackIndex) =>
      trackIndex === target!.trackIndex
        ? {
            ...track,
            clips: track.clips.map((clip, clipIndex) =>
              clipIndex === target!.clipIndex ? nextClip : clip,
            ),
          }
        : track,
    ),
  };

  return Object.freeze({
    artifact,
    canRegister: true as const,
    clip: nextClip,
    clipTake,
    project: nextProject,
    status: 'REGISTERED' as const,
  });
}

function fail(
  reason: Extract<PunchTakeRegistration, { canRegister: false }>['reason'],
  message: string,
): PunchTakeRegistration {
  return Object.freeze({
    canRegister: false as const,
    message,
    reason,
    status: 'BLOCKED' as const,
  });
}
