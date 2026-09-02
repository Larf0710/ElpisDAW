import type {
  AudioArtifact,
  AudioClipTake,
  Clip,
  ProjectState,
  Track,
} from './types';

export const MAX_PUNCH_ATTEMPTS_PER_SESSION = 24;
export const MAX_PUNCH_TEMPORARY_BYTES = 128 * 1024 * 1024;

export type PunchRange = Readonly<{
  inTick: number;
  outTick: number;
}>;

export type PunchMarkerState = Readonly<{
  inTick?: number;
  outTick?: number;
}>;

export type PunchMarkerToggle = Readonly<{
  marker: 'in' | 'out';
  state: PunchMarkerState;
  status: 'cleared' | 'rejected' | 'set';
}>;

export type PunchAttempt = Readonly<{
  blob: Blob;
  capturedStartTick: number;
  createdAt: string;
  durationSeconds: number;
  inputDeviceId?: string;
  inputDeviceLabel?: string;
  punchAttemptId: string;
  sampleRate: number;
}>;

export type PunchSession = Readonly<{
  attempts: readonly PunchAttempt[];
  baseArtifact: AudioArtifact;
  baseClipTake: AudioClipTake;
  baseWav: Blob;
  clip: Clip;
  createdAt: string;
  punchSessionId: string;
  range: PunchRange;
  selectedAttemptId?: string;
  track: Track;
}>;

export type PunchTargetResolution =
  | Readonly<{
      canStart: true;
      baseArtifact: AudioArtifact;
      baseClipTake: AudioClipTake;
      clip: Clip;
      range: PunchRange;
      track: Track;
    }>
  | Readonly<{
      canStart: false;
      message: string;
      reason:
        | 'artifact-invalid'
        | 'clip-not-found'
        | 'range-invalid'
        | 'source-unavailable'
        | 'take-invalid';
    }>;

export function togglePunchMarker(
  current: PunchMarkerState,
  marker: 'in' | 'out',
  playheadTick: number,
): PunchMarkerToggle {
  if (!Number.isSafeInteger(playheadTick) || playheadTick < 0) {
    throw new RangeError('Punch marker requires one non-negative Timeline tick.');
  }

  if (marker === 'in') {
    if (current.inTick !== undefined) {
      return Object.freeze({
        marker,
        state: Object.freeze({
          ...(current.outTick !== undefined ? { outTick: current.outTick } : {}),
        }),
        status: 'cleared' as const,
      });
    }

    if (current.outTick !== undefined && playheadTick >= current.outTick) {
      return Object.freeze({ marker, state: current, status: 'rejected' as const });
    }

    return Object.freeze({
      marker,
      state: Object.freeze({
        inTick: playheadTick,
        ...(current.outTick !== undefined ? { outTick: current.outTick } : {}),
      }),
      status: 'set' as const,
    });
  }

  if (current.outTick !== undefined) {
    return Object.freeze({
      marker,
      state: Object.freeze({
        ...(current.inTick !== undefined ? { inTick: current.inTick } : {}),
      }),
      status: 'cleared' as const,
    });
  }

  if (current.inTick !== undefined && playheadTick <= current.inTick) {
    return Object.freeze({ marker, state: current, status: 'rejected' as const });
  }

  return Object.freeze({
    marker,
    state: Object.freeze({
      ...(current.inTick !== undefined ? { inTick: current.inTick } : {}),
      outTick: playheadTick,
    }),
    status: 'set' as const,
  });
}

export function resolvePunchTarget(
  project: ProjectState,
  selectedClipId: string,
  inTick: number | undefined,
  outTick: number | undefined,
): PunchTargetResolution {
  const locations = project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id === selectedClipId)
      .map((clip) => ({ clip, track })),
  );

  if (locations.length !== 1) {
    return fail(
      'clip-not-found',
      'Select exactly one Audio Clip before starting Punch In / Punch Out.',
    );
  }

  const { clip, track } = locations[0];
  const clipEndTick = clip.startTick + clip.lengthTicks;

  if (
    !Number.isSafeInteger(inTick) ||
    !Number.isSafeInteger(outTick) ||
    (inTick as number) >= (outTick as number) ||
    (inTick as number) < clip.startTick ||
    (outTick as number) > clipEndTick
  ) {
    return fail(
      'range-invalid',
      `Set a valid Punch range inside ${clip.name} before recording.`,
    );
  }

  if (
    clip.type !== 'hum-audio' ||
    !clip.audioTiming ||
    !clip.sourceFile ||
    clip.sourceFile.status !== 'available'
  ) {
    return fail(
      'source-unavailable',
      `${clip.name} must be one available source-backed Audio Clip.`,
    );
  }

  const baseClipTake = (clip.clipTakes ?? []).find(
    (take): take is AudioClipTake =>
      take.clipTakeId === clip.activeClipTakeId && take.mediaType === 'audio',
  );

  if (!baseClipTake) {
    return fail(
      'take-invalid',
      `${clip.name} needs one active Audio Take before Punch recording.`,
    );
  }

  const artifactMatches = (project.artifacts ?? []).filter(
    (artifact): artifact is AudioArtifact =>
      artifact.kind === 'audio' && artifact.artifactId === baseClipTake.artifactId,
  );
  const baseArtifact = artifactMatches.length === 1
    ? artifactMatches[0]
    : undefined;

  if (
    !baseArtifact ||
    baseArtifact.audio.mimeType !== 'audio/wav' ||
    baseArtifact.file.extension.toLowerCase() !== '.wav' ||
    clip.sourceFile.sourceId !== baseArtifact.artifactId
  ) {
    return fail(
      'artifact-invalid',
      `${baseClipTake.label} does not resolve to the active WAV source for ${clip.name}.`,
    );
  }

  return Object.freeze({
    baseArtifact,
    baseClipTake,
    canStart: true as const,
    clip,
    range: Object.freeze({ inTick: inTick as number, outTick: outTick as number }),
    track,
  });
}

export function createPunchSession(
  target: Extract<PunchTargetResolution, { canStart: true }>,
  baseWav: Blob,
  identity: Readonly<{ createdAt: string; punchSessionId: string }>,
): PunchSession {
  if (!(baseWav instanceof Blob) || baseWav.type !== 'audio/wav' || baseWav.size <= 44) {
    throw new TypeError('Punch Session requires one complete base WAV Blob.');
  }

  if (!identity.punchSessionId.trim() || Number.isNaN(Date.parse(identity.createdAt))) {
    throw new TypeError('Punch Session identity is invalid.');
  }

  return Object.freeze({
    attempts: Object.freeze([]),
    baseArtifact: target.baseArtifact,
    baseClipTake: target.baseClipTake,
    baseWav,
    clip: target.clip,
    createdAt: identity.createdAt,
    punchSessionId: identity.punchSessionId,
    range: target.range,
    track: target.track,
  });
}

export function addPunchAttempt(
  session: PunchSession,
  attempt: PunchAttempt,
): PunchSession {
  if (session.attempts.length >= MAX_PUNCH_ATTEMPTS_PER_SESSION) {
    throw new RangeError(
      `Punch Session is limited to ${MAX_PUNCH_ATTEMPTS_PER_SESSION} temporary Attempts. KEEP or DISCARD before recording more.`,
    );
  }

  const temporaryBytes = session.attempts.reduce(
    (total, candidate) => total + candidate.blob.size,
    attempt.blob.size,
  );

  if (temporaryBytes > MAX_PUNCH_TEMPORARY_BYTES) {
    throw new RangeError(
      `Punch Session temporary audio exceeds the ${MAX_PUNCH_TEMPORARY_BYTES} byte safety limit. KEEP or DISCARD before recording more.`,
    );
  }

  if (
    session.attempts.some(
      (candidate) => candidate.punchAttemptId === attempt.punchAttemptId,
    ) ||
    !(attempt.blob instanceof Blob) ||
    attempt.blob.type !== 'audio/wav' ||
    !Number.isFinite(attempt.durationSeconds) ||
    attempt.durationSeconds <= 0 ||
    !Number.isSafeInteger(attempt.capturedStartTick) ||
    attempt.capturedStartTick < session.range.inTick ||
    attempt.capturedStartTick >= session.range.outTick
  ) {
    throw new TypeError('Punch Attempt is invalid for this frozen Punch Session.');
  }

  return Object.freeze({
    ...session,
    attempts: Object.freeze([...session.attempts, Object.freeze(attempt)]),
    selectedAttemptId: attempt.punchAttemptId,
  });
}

export function selectPunchAttempt(
  session: PunchSession,
  punchAttemptId: string,
): PunchSession {
  if (!session.attempts.some((attempt) => attempt.punchAttemptId === punchAttemptId)) {
    throw new RangeError('Selected Punch Attempt does not belong to this session.');
  }

  return session.selectedAttemptId === punchAttemptId
    ? session
    : Object.freeze({ ...session, selectedAttemptId: punchAttemptId });
}

export function getSelectedPunchAttempt(
  session: PunchSession,
): PunchAttempt | undefined {
  return session.attempts.find(
    (attempt) => attempt.punchAttemptId === session.selectedAttemptId,
  );
}

function fail(
  reason: Extract<PunchTargetResolution, { canStart: false }>['reason'],
  message: string,
): PunchTargetResolution {
  return Object.freeze({ canStart: false as const, message, reason });
}
