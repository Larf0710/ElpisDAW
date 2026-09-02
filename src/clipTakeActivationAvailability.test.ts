import { describe, expect, it, vi } from 'vitest';

import { resolveClipTakeAudioPreview } from './clipTakeAudioPreview';
import { activateClipTake } from './clipTakeActivation';
import { verifyClipTakeActivationAvailability } from './clipTakeActivationAvailability';
import type { LocalEngineGeneratedAudioDescriptor } from './localEngineClient';
import { sampleProject } from './sampleProject';
import type {
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectState,
  RecordingAudioArtifact,
} from './types';

describe('Clip Take activation availability', () => {
  it('returns exact availability evidence for one authenticated Project WAV', async () => {
    const artifact = createArtifact('artifact-a');
    const checkGeneratedAudioAvailability = vi.fn(async (
      descriptors: readonly LocalEngineGeneratedAudioDescriptor[],
    ) => ({
      availableSourceIds: descriptors.map((descriptor) => descriptor.sourceId),
      ok: true as const,
    }));

    await expect(
      verifyClipTakeActivationAvailability(
        { checkGeneratedAudioAvailability },
        artifact,
        () => new Date('2026-08-30T09:00:00.000Z'),
      ),
    ).resolves.toEqual({
      evidence: {
        availableArtifactIds: ['artifact-a'],
        checkedAt: '2026-08-30T09:00:00.000Z',
      },
      ok: true,
    });
    expect(checkGeneratedAudioAvailability).toHaveBeenCalledWith([
      {
        kind: 'generated',
        name: 'artifact-a.wav',
        relativePath: 'renders/instruments/artifact-a.wav',
        sizeBytes: 192_044,
        sourceId: 'artifact-a',
      },
    ]);
  });

  it('fails closed when the selected Take WAV is unavailable', async () => {
    await expect(
      verifyClipTakeActivationAvailability(
        {
          checkGeneratedAudioAvailability: async () => ({
            availableSourceIds: [],
            ok: true,
          }),
        },
        createArtifact('artifact-a'),
      ),
    ).resolves.toMatchObject({
      message: expect.stringContaining('current Active Take was preserved'),
      ok: false,
      reason: 'artifact-unavailable',
    });
  });

  it('uses the same authenticated availability boundary for Recording Takes', async () => {
    const artifact = createRecordingArtifact('artifact-recording');
    const checkGeneratedAudioAvailability = vi.fn(async () => ({
      availableSourceIds: [artifact.artifactId],
      ok: true as const,
    }));

    await expect(
      verifyClipTakeActivationAvailability(
        { checkGeneratedAudioAvailability },
        artifact,
        () => new Date('2026-08-30T09:05:00.000Z'),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(checkGeneratedAudioAvailability).toHaveBeenCalledWith([
      expect.objectContaining({
        relativePath: 'recordings/artifact-recording.wav',
        sourceId: 'artifact-recording',
      }),
    ]);
  });

  it('keeps a finalized inactive Take previewable immediately after verified activation', async () => {
    const project = structuredClone(sampleProject) as ProjectState;
    const clip = project.tracks
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === 'clip-inst-1');

    if (!clip) {
      throw new Error('Instrument Clip fixture is missing.');
    }

    const currentArtifact = createArtifact('artifact-current');
    const nextArtifact = createArtifact('artifact-next');
    const currentTake = createTake(currentArtifact, 'SoundFont Render 01');
    const nextTake = createTake(nextArtifact, 'SoundFont Render 02');
    project.artifacts = [currentArtifact, nextArtifact];
    clip.activeClipTakeId = currentTake.clipTakeId;
    clip.clipTakes = [currentTake, nextTake];
    clip.sourceFile = {
      checkedAt: '2026-08-30T09:00:00.000Z',
      durationSeconds: currentArtifact.audio.durationSeconds,
      mimeType: currentArtifact.audio.mimeType,
      name: currentArtifact.file.name,
      relativePath: currentArtifact.file.relativePath,
      sizeBytes: currentArtifact.file.sizeBytes,
      sourceId: currentArtifact.artifactId,
      status: 'available',
    };
    const availability = await verifyClipTakeActivationAvailability(
      {
        checkGeneratedAudioAvailability: async () => ({
          availableSourceIds: [nextArtifact.artifactId],
          ok: true,
        }),
      },
      nextArtifact,
      () => new Date('2026-08-30T09:10:00.000Z'),
    );

    if (!availability.ok) {
      throw new Error(availability.message);
    }

    const activation = activateClipTake(
      project,
      clip.id,
      nextTake.clipTakeId,
      { sourceAvailability: availability.evidence },
    );

    expect(activation).toMatchObject({
      canActivate: true,
      clip: {
        activeClipTakeId: nextTake.clipTakeId,
        sourceFile: {
          sourceId: nextArtifact.artifactId,
          status: 'available',
        },
      },
    });

    if (!activation.canActivate) {
      throw new Error(activation.message);
    }

    expect(
      resolveClipTakeAudioPreview(
        activation.project,
        clip.id,
        nextTake.clipTakeId,
      ),
    ).toMatchObject({ canPreview: true });
  });

  it('rejects invalid descriptors, Engine failures, transport failures, and invalid time', async () => {
    const artifact = createArtifact('artifact-a');

    await expect(
      verifyClipTakeActivationAvailability(
        { checkGeneratedAudioAvailability: vi.fn() },
        {
          ...artifact,
          file: { ...artifact.file, relativePath: '../artifact-a.wav' },
        },
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'artifact-invalid' });

    await expect(
      verifyClipTakeActivationAvailability(
        {
          checkGeneratedAudioAvailability: async () => ({
            message: 'Local Engine is offline.',
            ok: false,
            reason: 'offline',
          }),
        },
        artifact,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'offline' });

    await expect(
      verifyClipTakeActivationAvailability(
        {
          checkGeneratedAudioAvailability: async () => {
            throw new Error('connection lost');
          },
        },
        artifact,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'transport-failed' });

    await expect(
      verifyClipTakeActivationAvailability(
        {
          checkGeneratedAudioAvailability: async () => ({
            availableSourceIds: [artifact.artifactId],
            ok: true,
          }),
        },
        artifact,
        () => new Date(Number.NaN),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-response' });
  });
});

function createArtifact(artifactId: string): GeneratedAudioArtifact {
  return {
    artifactId,
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-30T09:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `renders/instruments/${artifactId}.wav`,
      sizeBytes: 192_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'mock-audio-v1',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'mock-audio-generation',
    },
    sourceJobId: `job-${artifactId}`,
  };
}

function createRecordingArtifact(
  artifactId: string,
): RecordingAudioArtifact {
  return {
    artifactId,
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 1,
      mimeType: 'audio/wav',
      sampleRate: 48_000,
    },
    capture: { source: 'microphone' },
    createdAt: '2026-08-30T09:05:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: `${artifactId}.wav`,
      relativePath: `recordings/${artifactId}.wav`,
      sizeBytes: 96_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
  };
}

function createTake(
  artifact: GeneratedAudioArtifact,
  label: string,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: `clip-take-${artifact.artifactId}`,
    createdAt: artifact.createdAt,
    label,
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}
