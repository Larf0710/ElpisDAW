import {
  createBasicPitchHumToMidiGenerationPlan,
  type BasicPitchHumToMidiGenerationPlan,
} from './humToMidiGeneration';
import { createDefaultPatchTabs } from './emptyProject';
import type { LocalEngineGpuJobRecord } from './localEngineJobs';
import { sampleProject } from './sampleProject';
import type {
  Clip,
  ProjectState,
  RecordingAudioArtifact,
  RecordingAudioClipTake,
} from './types';

export function createBasicPitchHumToMidiTestProject(): ProjectState {
  const project = cloneBasicPitchTestValue(sampleProject);
  const productionHumToMidi = createDefaultPatchTabs().find(
    (patchTab) => patchTab.id === 'hum-to-midi',
  );

  if (!productionHumToMidi) {
    throw new Error('Production Hum to MIDI PatchTab fixture missing.');
  }

  project.patchTabs = project.patchTabs.map((patchTab) =>
    patchTab.id === 'hum-to-midi'
      ? cloneBasicPitchTestValue(productionHumToMidi)
      : patchTab,
  );
  const sourceClip = findBasicPitchTestClip(project, 'clip-hum-1');
  const artifact = createBasicPitchRecordingArtifact();
  const clipTake = createBasicPitchRecordingTake();

  project.artifacts = [artifact];
  sourceClip.activeClipTakeId = clipTake.clipTakeId;
  sourceClip.clipTakes = [clipTake];
  project.selection = {
    anchorItem: { id: sourceClip.id, type: 'clip' },
    items: [{ id: sourceClip.id, type: 'clip' }],
    lastSelectedItem: { id: sourceClip.id, type: 'clip' },
  };
  project.selectedPatchTabId = 'hum-to-midi';

  return project;
}

export function requireBasicPitchHumToMidiTestPlan(
  project: ProjectState,
): BasicPitchHumToMidiGenerationPlan {
  const result = createBasicPitchHumToMidiGenerationPlan(project, {
    converterPatchTabId: 'hum-to-midi',
  });

  if (!result.canPlan) {
    throw new Error(result.message);
  }

  return result.plan;
}

export function createCompletedBasicPitchHumToMidiTestJob(
  plan: BasicPitchHumToMidiGenerationPlan,
  jobId = 'job-basic-pitch-1',
): LocalEngineGpuJobRecord {
  const createdAt = '2026-08-16T13:00:00.000Z';
  const finishedAt = '2026-08-16T13:00:01.000Z';

  return {
    attempt: 1,
    createdAt,
    finishedAt,
    history: [{ attempt: 1, at: finishedAt, state: 'COMPLETED' }],
    jobId,
    modelId: plan.request.modelId,
    modelRevision: plan.request.modelRevision,
    providerId: plan.request.providerId,
    request: plan.request,
    result: {
      artifact: {
        artifactId: `artifact-${jobId}`,
        createdAt: finishedAt,
        kind: 'midi',
        lineage: plan.request.lineage,
        midi: {
          bpm: plan.request.parameters.projectBpm,
          notes: [
            {
              confidence: 0.93,
              id: `note-${jobId}`,
              lengthTicks: 480,
              pitch: 69,
              startTick: 120,
              velocity: 96,
            },
          ],
          ticksPerQuarter: plan.request.parameters.ticksPerQuarter,
        },
        provenance: {
          modelId: plan.request.modelId,
          modelRevision: plan.request.modelRevision,
          parameters: plan.request.parameters,
          providerId: plan.request.providerId,
          taskId: plan.request.taskId,
        },
        sourceJobId: jobId,
      },
      transcription: {
        noteCount: 1,
        providerCompletedAt: finishedAt,
      },
    },
    startedAt: createdAt,
    state: 'COMPLETED',
    taskId: plan.request.taskId,
    updatedAt: finishedAt,
  };
}

export function createBasicPitchRecordingArtifact(): RecordingAudioArtifact {
  return {
    artifactId: 'artifact-recording-1',
    audio: {
      bitsPerSample: 16,
      channels: 1,
      durationSeconds: 2,
      mimeType: 'audio/wav',
      sampleRate: 8_000,
    },
    capture: { source: 'microphone' },
    createdAt: '2026-08-16T12:00:00.000Z',
    destination: 'recording',
    file: {
      extension: '.wav',
      name: 'artifact-recording-1.wav',
      relativePath: 'recordings/artifact-recording-1.wav',
      sizeBytes: 32_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
  };
}

export function createBasicPitchRecordingTake(): RecordingAudioClipTake {
  return {
    artifactId: 'artifact-recording-1',
    clipTakeId: 'clip-take-recording-1',
    createdAt: '2026-08-16T12:00:00.000Z',
    label: 'Recording Take 01',
    mediaType: 'audio',
    sourceType: 'recording',
  };
}

export function findBasicPitchTestClip(
  project: ProjectState,
  clipId: string,
): Clip {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Clip fixture missing: ${clipId}`);
  }

  return clip;
}

export function cloneBasicPitchTestValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
