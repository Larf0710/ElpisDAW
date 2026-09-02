import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { createEmptyProject } from './emptyProject';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
} from './types';

export const FINAL_FILER_TEST_OPERATION_ID =
  'mixdown-operation-11111111-1111-4111-8111-111111111111';
export const FINAL_FILER_TEST_RAW_ARTIFACT_ID = 'artifact-raw-mix';
export const FINAL_FILER_TEST_RAW_CLIP_ID = 'clip-raw-mix';
export const FINAL_FILER_TEST_RAW_TAKE_ID = 'clip-take-raw-mix';
export const FINAL_FILER_TEST_MASTER_ARTIFACT_ID = 'artifact-sa3-master';
export const FINAL_FILER_TEST_MASTER_CLIP_ID = 'clip-sa3-master';
export const FINAL_FILER_TEST_MASTER_TAKE_ID = 'clip-take-sa3-master';
export const FINAL_FILER_TEST_MASTER_JOB_ID = 'job-sa3-master';
export const FINAL_FILER_TEST_WAV_SIZE = 176_444;

export function createFinalFilerTestProject(
  selected: 'master' | 'raw' = 'raw',
): ProjectState {
  const project = createEmptyProject();
  const rawArtifact = createRawMixdownArtifact();
  const rawTake = createRawMixdownTake(rawArtifact);
  const masterArtifact = createMasterArtifact();
  const masterTake = createMasterTake(masterArtifact);

  project.name = 'HumStudio';
  project.bpm = 120;
  project.totalTicks = 960;
  project.artifacts = [rawArtifact, masterArtifact];
  project.tracks = [
    {
      clips: [
        createAudioClip(
          rawArtifact,
          rawTake,
          'Raw Mix 01',
          FINAL_FILER_TEST_RAW_CLIP_ID,
        ),
      ],
      id: 'track-raw-mix',
      level: 0,
      muted: true,
      name: 'Raw Mix 01',
      type: 'audio',
    },
    {
      clips: [
        {
          ...createAudioClip(
            masterArtifact,
            masterTake,
            'Final Master',
            FINAL_FILER_TEST_MASTER_CLIP_ID,
          ),
          sourceClipId: FINAL_FILER_TEST_RAW_CLIP_ID,
          type: 'master',
        },
      ],
      id: 'track-master',
      level: 0,
      name: 'Final Master',
      type: 'master',
    },
  ];
  project.selection = {
    items: [
      {
        id:
          selected === 'raw'
            ? FINAL_FILER_TEST_RAW_CLIP_ID
            : FINAL_FILER_TEST_MASTER_CLIP_ID,
        type: 'clip',
      },
    ],
  };

  return project;
}

export function createFinalFilerTestWav(
  sizeBytes = FINAL_FILER_TEST_WAV_SIZE,
): Blob {
  const bytes = new Uint8Array(sizeBytes);
  const view = new DataView(bytes.buffer);
  const dataBytes = sizeBytes - 44;

  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, sizeBytes - 8, true);
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
  view.setUint32(40, dataBytes, true);

  return new Blob([bytes], { type: 'audio/wav' });
}

export function findFinalFilerTestClip(
  project: ProjectState,
  clipId: string,
): Clip {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Missing FINAL FILER test Clip: ${clipId}`);
  }

  return clip;
}

function createRawMixdownArtifact(): ProjectMixdownAudioArtifact {
  const sourceId = 'artifact-input';
  const sourceClipId = 'clip-input';
  const sourceTrackId = 'track-input';
  const source = {
    kind: 'generated' as const,
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: FINAL_FILER_TEST_WAV_SIZE,
    sourceId,
  };
  const plan = createTestProjectMixdownPlanV3({
    bpm: 120,
    durationSeconds: 1,
    endTick: 960,
    sources: [source],
    tracks: [
      {
        events: [
          {
            clipId: sourceClipId,
            clipName: 'Instrument Input',
            durationSeconds: 1,
            sourceId,
            sourceStartSeconds: 0,
            startOffsetSeconds: 0,
            timelineEndTick: 960,
            timelineStartTick: 0,
          },
        ],
        gainDb: 0,
        pan: 0,
        trackId: sourceTrackId,
      },
    ],
  });
  const canonicalPlanJson = createCanonicalProjectMixdownPlanJson(plan);

  if (!canonicalPlanJson) {
    throw new Error('Failed to create FINAL FILER test Mixdown Plan.');
  }

  return {
    artifactId: FINAL_FILER_TEST_RAW_ARTIFACT_ID,
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 1,
      frameCount: 44_100,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: '2026-08-16T00:00:00.000Z',
    destination: 'mixdown',
    file: {
      extension: '.wav',
      name: `${FINAL_FILER_TEST_RAW_ARTIFACT_ID}.wav`,
      relativePath: `mixdowns/${FINAL_FILER_TEST_RAW_ARTIFACT_ID}.wav`,
      sizeBytes: FINAL_FILER_TEST_WAV_SIZE,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [sourceId], parentClipTakeIds: ['take-input'] },
    mixdownProvenance: {
      canonicalPlanJson,
      inputClipIds: [sourceClipId],
      inputSourceIds: [sourceId],
      inputTrackIds: [sourceTrackId],
      operationProtocolVersion: '2',
      planVersion: 3,
      rendererId: 'humstudio-pcm-mixdown',
      rendererVersion: '0.2.0',
      schemaVersion: 2,
    },
    sourceOperationId: FINAL_FILER_TEST_OPERATION_ID,
  };
}

function createMasterArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: FINAL_FILER_TEST_MASTER_ARTIFACT_ID,
    audio: { channels: 2, durationSeconds: 1, mimeType: 'audio/wav' },
    createdAt: '2026-08-16T00:01:00.000Z',
    destination: 'stable-audio-3',
    file: {
      extension: '.wav',
      name: `${FINAL_FILER_TEST_MASTER_ARTIFACT_ID}.wav`,
      relativePath: `renders/stable-audio-3/${FINAL_FILER_TEST_MASTER_ARTIFACT_ID}.wav`,
      sizeBytes: FINAL_FILER_TEST_WAV_SIZE,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [FINAL_FILER_TEST_RAW_ARTIFACT_ID],
      parentClipTakeIds: [FINAL_FILER_TEST_RAW_TAKE_ID],
    },
    provenance: {
      modelId: STABLE_AUDIO_3_MODEL_ID,
      modelRevision: STABLE_AUDIO_3_MODEL_REVISION,
      parameters: {
        channels: 2,
        durationSeconds: 1,
        prompt: 'Master polish',
        sampleRate: 44_100,
        seed: 42,
        sourceEndSeconds: 1,
        sourceStartSeconds: 0,
        strength: 0.5,
      },
      providerId: STABLE_AUDIO_3_PROVIDER_ID,
      seed: 42,
      taskId: STABLE_AUDIO_3_TASK_ID,
    },
    sourceJobId: FINAL_FILER_TEST_MASTER_JOB_ID,
  };
}

function createRawMixdownTake(
  artifact: ProjectMixdownAudioArtifact,
): ProjectMixdownAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: FINAL_FILER_TEST_RAW_TAKE_ID,
    createdAt: artifact.createdAt,
    label: 'Raw Mix 01',
    mediaType: 'audio',
    sourceOperationId: artifact.sourceOperationId,
    sourceType: 'mixdown',
  };
}

function createMasterTake(
  artifact: GeneratedAudioArtifact,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: FINAL_FILER_TEST_MASTER_TAKE_ID,
    createdAt: artifact.createdAt,
    label: 'Final Master',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}

function createAudioClip(
  artifact: GeneratedAudioArtifact | ProjectMixdownAudioArtifact,
  take: GeneratedAudioClipTake | ProjectMixdownAudioClipTake,
  name: string,
  clipId: string,
): Clip {
  return {
    activeClipTakeId: take.clipTakeId,
    audioTiming: {
      sourceEndSeconds: artifact.audio.durationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    clipTakes: [take],
    color: '#d8b25c',
    createdAt: artifact.createdAt,
    id: clipId,
    lengthTicks: 960,
    name,
    sourceFile: {
      durationSeconds: artifact.audio.durationSeconds,
      mimeType: artifact.audio.mimeType,
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'available',
    },
    startTick: 0,
    type: 'mixdown',
    version: 1,
  };
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}
