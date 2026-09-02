import { describe, expect, it } from 'vitest';

import {
  STABLE_AUDIO_3_MODEL_ID,
  STABLE_AUDIO_3_MODEL_REVISION,
  STABLE_AUDIO_3_PROVIDER_ID,
  STABLE_AUDIO_3_TASK_ID,
} from '../shared/stableAudio3Protocol.js';
import { resolveClipFilerFinalExportTarget } from './clipFilerFinalExportTarget';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint';
import { resolveProjectMixdownDownload } from './projectMixdownPreparation';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity';
import { createTestProjectMixdownPlanV3 } from './projectMixdownTestFixtures';
import { sampleProject } from './sampleProject';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  PatchTab,
  ProjectMixdownAudioArtifact,
  ProjectMixdownAudioClipTake,
  ProjectState,
} from './types';

const operationId =
  'mixdown-operation-11111111-1111-4111-8111-111111111111';
const rawArtifactId = 'artifact-raw-mix';
const rawClipId = 'clip-raw-mix';
const rawTakeId = 'clip-take-raw-mix';
const masterArtifactId = 'artifact-sa3-master';
const masterClipId = 'clip-sa3-master';
const masterTakeId = 'clip-take-sa3-master';
const masterJobId = 'job-sa3-master';

describe('resolveClipFilerFinalExportTarget', () => {
  it('preserves the registered Raw Mixdown read and download descriptor', () => {
    const project = createProject();
    const before = structuredClone(project);
    const legacy = resolveProjectMixdownDownload(
      project,
      createClipFiler(),
      rawClipId,
    );
    const resolution = resolveClipFilerFinalExportTarget(
      project,
      createClipFiler(),
      rawClipId,
    );

    expect(legacy).toMatchObject({ canDownload: true });
    if (!legacy.canDownload) {
      throw new Error(legacy.message);
    }

    expect(resolution).toEqual({
      canExport: true,
      exportTarget: {
        descriptor: legacy.descriptor,
        fileName: legacy.fileName,
        format: 'WAV',
        projectFingerprint: createProjectDirtyStateFingerprint(project),
        target: {
          artifactId: rawArtifactId,
          clipId: rawClipId,
          clipTakeId: rawTakeId,
          kind: 'raw-mixdown',
          rawMixdown: {
            artifactId: rawArtifactId,
            clipId: rawClipId,
            clipTakeId: rawTakeId,
            operationId,
          },
        },
      },
    });

    if (!resolution.canExport) {
      throw new Error(resolution.message);
    }

    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.exportTarget)).toBe(true);
    expect(Object.isFrozen(resolution.exportTarget.descriptor)).toBe(true);
    expect(Object.isFrozen(resolution.exportTarget.target)).toBe(true);
    expect(Object.isFrozen(resolution.exportTarget.target.rawMixdown)).toBe(
      true,
    );
    expect(project).toEqual(before);
  });

  it('resolves one registered Stable Audio 3 Master through its exact Raw Mixdown parent', () => {
    const project = createProject();
    const before = structuredClone(project);
    const resolution = resolveClipFilerFinalExportTarget(
      project,
      createClipFiler(),
      masterClipId,
    );

    expect(resolution).toEqual({
      canExport: true,
      exportTarget: {
        descriptor: {
          kind: 'generated',
          name: `${masterArtifactId}.wav`,
          relativePath: `renders/stable-audio-3/${masterArtifactId}.wav`,
          sizeBytes: 176_444,
          sourceId: masterArtifactId,
        },
        fileName: 'HumStudio-Final Master.wav',
        format: 'WAV',
        projectFingerprint: createProjectDirtyStateFingerprint(project),
        target: {
          artifactId: masterArtifactId,
          clipId: masterClipId,
          clipTakeId: masterTakeId,
          jobId: masterJobId,
          kind: 'stable-audio-3-master',
          rawMixdown: {
            artifactId: rawArtifactId,
            clipId: rawClipId,
            clipTakeId: rawTakeId,
            operationId,
          },
        },
      },
    });

    if (!resolution.canExport) {
      throw new Error(resolution.message);
    }

    expect(Object.isFrozen(resolution.exportTarget.target.rawMixdown)).toBe(
      true,
    );
    expect(project).toEqual(before);
  });

  it.each([
    ['missing Clip Filer', undefined],
    ['unsupported format', createClipFiler({ format: 'MP3' })],
    ['unsupported normalization', createClipFiler({ normalize: 'On' })],
  ])('rejects %s settings', (_label, patchTab) => {
    expect(
      resolveClipFilerFinalExportTarget(
        createProject(),
        patchTab,
        rawClipId,
      ),
    ).toMatchObject({
      canExport: false,
      cause: 'clip-filer-settings-invalid',
    });
  });

  it('rejects non-final, generic Master, and mock-ready export Clips', () => {
    const instrument = createProject();
    findClip(instrument, rawClipId).type = 'instrument-audio';
    expectFailure(instrument, rawClipId, 'target-invalid');

    const genericMaster = createProject();
    findArtifact(genericMaster, masterArtifactId).destination = 'export';
    findArtifact(genericMaster, masterArtifactId).file.relativePath =
      `exports/${masterArtifactId}.wav`;
    syncSourceFile(genericMaster, masterClipId, masterArtifactId);
    expectFailure(genericMaster, masterClipId, 'source-artifact-invalid');

    const mockExport = createProject();
    findClip(mockExport, rawClipId).exportManifest = {
      createdAt: '2026-08-14T00:00:00.000Z',
      durationTicks: 960,
      estimatedFileName: 'mock.wav',
      format: 'WAV',
      id: 'mock-export',
      normalize: 'Off',
      sourceClipId: rawClipId,
      status: 'mock-ready',
      targetClipId: rawClipId,
      version: 1,
    };
    expectFailure(mockExport, rawClipId, 'target-invalid');
  });

  it('rejects missing, stale, or unavailable registration state', () => {
    const unregistered = createProject();
    unregistered.artifacts = unregistered.artifacts?.filter(
      (artifact) => artifact.artifactId !== masterArtifactId,
    );
    expectFailure(unregistered, masterClipId, 'active-take-unavailable');

    const missingTake = createProject();
    findClip(missingTake, masterClipId).activeClipTakeId = 'missing-take';
    expectFailure(missingTake, masterClipId, 'active-take-unavailable');

    const staleParent = createProject();
    findClip(staleParent, rawClipId).activeClipTakeId = 'stale-parent-take';
    expectFailure(staleParent, masterClipId, 'lineage-invalid');

    const unavailable = createProject();
    findClip(unavailable, masterClipId).sourceFile!.status = 'missing';
    expectFailure(unavailable, masterClipId, 'source-artifact-invalid');
  });

  it.each([
    [
      'wrong destination',
      (project: ProjectState) => {
        findArtifact(project, masterArtifactId).destination = 'export';
      },
      'source-artifact-invalid',
    ],
    [
      'wrong path',
      (project: ProjectState) => {
        findArtifact(project, masterArtifactId).file.relativePath =
          `renders/instruments/${masterArtifactId}.wav`;
      },
      'source-artifact-invalid',
    ],
    [
      'partial extension',
      (project: ProjectState) => {
        findArtifact(project, masterArtifactId).file.extension = '.partial';
      },
      'active-take-unavailable',
    ],
    [
      'missing size',
      (project: ProjectState) => {
        findArtifact(project, masterArtifactId).file.sizeBytes = 0;
      },
      'active-take-unavailable',
    ],
  ] as const)('rejects a Master WAV with %s', (_label, mutate, cause) => {
    const project = createProject();
    mutate(project);
    expectFailure(project, masterClipId, cause);
  });

  it('rejects mismatched and colliding Take, Artifact, Job, and operation identities', () => {
    const wrongOperation = createProject();
    findRawTake(wrongOperation).sourceOperationId =
      'mixdown-operation-22222222-2222-4222-8222-222222222222';
    expectFailure(wrongOperation, rawClipId, 'active-take-unavailable');

    const wrongJob = createProject();
    findMasterTake(wrongJob).sourceJobId = 'job-wrong';
    expectFailure(wrongJob, masterClipId, 'active-take-unavailable');

    const collidingOperation = createProject();
    const duplicateRaw = structuredClone(findRawArtifact(collidingOperation));
    duplicateRaw.artifactId = 'artifact-raw-collision';
    duplicateRaw.file.name = `${duplicateRaw.artifactId}.wav`;
    duplicateRaw.file.relativePath = `mixdowns/${duplicateRaw.file.name}`;
    collidingOperation.artifacts!.push(duplicateRaw);
    expectFailure(collidingOperation, rawClipId, 'identity-conflict');

    const collidingJob = createProject();
    const duplicateMaster = structuredClone(
      findMasterArtifact(collidingJob),
    );
    duplicateMaster.artifactId = 'artifact-master-collision';
    duplicateMaster.file.name = `${duplicateMaster.artifactId}.wav`;
    duplicateMaster.file.relativePath =
      `renders/stable-audio-3/${duplicateMaster.file.name}`;
    collidingJob.artifacts!.push(duplicateMaster);
    expectFailure(collidingJob, masterClipId, 'identity-conflict');
  });

  it.each([
    [
      'missing parent Artifact',
      (artifact: GeneratedAudioArtifact) => {
        artifact.lineage.parentArtifactIds = [];
      },
    ],
    [
      'ambiguous parent Artifact',
      (artifact: GeneratedAudioArtifact) => {
        artifact.lineage.parentArtifactIds.push('artifact-other');
      },
    ],
    [
      'wrong parent Take',
      (artifact: GeneratedAudioArtifact) => {
        artifact.lineage.parentClipTakeIds = ['clip-take-wrong'];
      },
    ],
  ])('rejects %s lineage', (_label, mutate) => {
    const project = createProject();
    mutate(findMasterArtifact(project));
    expectFailure(project, masterClipId, 'lineage-invalid');
  });

  it('rejects a wrong source Clip and source timing outside the Raw Mixdown', () => {
    const wrongSourceClip = createProject();
    findClip(wrongSourceClip, masterClipId).sourceClipId = 'clip-input';
    expectFailure(wrongSourceClip, masterClipId, 'lineage-invalid');

    const wrongTiming = createProject();
    findMasterArtifact(wrongTiming).provenance.parameters.sourceEndSeconds = 2;
    expectFailure(wrongTiming, masterClipId, 'lineage-invalid');
  });

  it('rejects non-canonical Stable Audio 3 Job parameters', () => {
    const extraParameter = createProject();
    findMasterArtifact(extraParameter).provenance.parameters.untrusted = true;
    expectFailure(extraParameter, masterClipId, 'lineage-invalid');

    const wrongSeed = createProject();
    findMasterArtifact(wrongSeed).provenance.seed = 99;
    expectFailure(wrongSeed, masterClipId, 'source-artifact-invalid');

    const invalidPrompt = createProject();
    findMasterArtifact(invalidPrompt).provenance.parameters.prompt = '  ';
    expectFailure(invalidPrompt, masterClipId, 'lineage-invalid');
  });

  it.each([
    ['provider', 'providerId', 'wrong-provider'],
    ['model', 'modelId', 'wrong-model'],
    ['model revision', 'modelRevision', 'wrong-revision'],
    ['task', 'taskId', 'wrong-task'],
  ] as const)(
    'rejects a Stable Audio 3 %s identity mismatch',
    (_label, field, value) => {
      const project = createProject();
      findMasterArtifact(project).provenance[field] = value;
      expectFailure(project, masterClipId, 'source-artifact-invalid');
    },
  );

  it('creates one path-safe WAV filename without trusting Project or Clip text', () => {
    const project = createProject();
    project.name = 'CON';
    findClip(project, masterClipId).name = '../Final: Mix?   ';
    const resolution = resolveClipFilerFinalExportTarget(
      project,
      createClipFiler(),
      masterClipId,
    );

    expect(resolution).toMatchObject({
      canExport: true,
      exportTarget: { fileName: 'CON-file-..-Final- Mix-.wav' },
    });
    if (resolution.canExport) {
      expect(resolution.exportTarget.fileName).not.toMatch(/[\\/:*?"<>|]/);
      expect(resolution.exportTarget.fileName.endsWith('.wav')).toBe(true);
    }
  });
});

function createProject(): ProjectState {
  const project = structuredClone(sampleProject);
  const rawArtifact = createRawMixdownArtifact();
  const rawTake = createRawMixdownTake(rawArtifact);
  const masterArtifact = createMasterArtifact();
  const masterTake = createMasterTake(masterArtifact);

  project.name = 'HumStudio';
  project.bpm = 120;
  project.mixer = undefined;
  project.totalTicks = 960;
  project.artifacts = [rawArtifact, masterArtifact];
  project.patchTabs = [createClipFiler()];
  project.tracks = [
    {
      clips: [createAudioClip(rawArtifact, rawTake, 'Raw Mix 01', rawClipId)],
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
            masterClipId,
          ),
          sourceClipId: rawClipId,
          type: 'master',
        },
      ],
      id: 'track-master',
      level: 0,
      name: 'Final Master',
      type: 'master',
    },
  ];

  return project;
}

function createRawMixdownArtifact(): ProjectMixdownAudioArtifact {
  const sourceId = 'artifact-input';
  const sourceClipId = 'clip-input';
  const sourceTrackId = 'track-input';
  const source = {
    kind: 'generated' as const,
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: 176_444,
    sourceId,
  };
  const track = {
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
  };
  const plan = createTestProjectMixdownPlanV3({
    bpm: 120,
    durationSeconds: 1,
    endTick: 960,
    sources: [source],
    tracks: [track],
  });
  const canonicalPlanJson = createCanonicalProjectMixdownPlanJson(plan);

  if (!canonicalPlanJson) {
    throw new Error('Failed to create the canonical test Mixdown Plan.');
  }

  return {
    artifactId: rawArtifactId,
    audio: {
      bitsPerSample: 16,
      channels: 2,
      durationSeconds: 1,
      frameCount: 44_100,
      mimeType: 'audio/wav',
      sampleRate: 44_100,
    },
    createdAt: '2026-08-14T00:00:00.000Z',
    destination: 'mixdown',
    file: {
      extension: '.wav',
      name: `${rawArtifactId}.wav`,
      relativePath: `mixdowns/${rawArtifactId}.wav`,
      sizeBytes: 176_444,
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
    sourceOperationId: operationId,
  };
}

function createMasterArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: masterArtifactId,
    audio: {
      channels: 2,
      durationSeconds: 1,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-08-14T00:01:00.000Z',
    destination: 'stable-audio-3',
    file: {
      extension: '.wav',
      name: `${masterArtifactId}.wav`,
      relativePath: `renders/stable-audio-3/${masterArtifactId}.wav`,
      sizeBytes: 176_444,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [rawArtifactId],
      parentClipTakeIds: [rawTakeId],
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
    sourceJobId: masterJobId,
  };
}

function createRawMixdownTake(
  artifact: ProjectMixdownAudioArtifact,
): ProjectMixdownAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId: rawTakeId,
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
    clipTakeId: masterTakeId,
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

function createClipFiler(
  settings: Readonly<{ format?: string; normalize?: string }> = {},
): PatchTab {
  return {
    colorIndex: 4,
    description: 'Production output settings.',
    id: 'export',
    inputType: 'Selected Clip',
    name: 'Clip Filer',
    outputType: 'Export File',
    parameters: [
      {
        id: 'format',
        kind: 'select',
        label: 'Format',
        options: ['WAV', 'MP3', 'MIDI'],
        value: settings.format ?? 'WAV',
      },
      {
        id: 'normalize',
        kind: 'select',
        label: 'Normalize',
        options: ['On', 'Off'],
        value: settings.normalize ?? 'Off',
      },
    ],
    status: 'ready',
  };
}

function expectFailure(
  project: ProjectState,
  clipId: string,
  cause: Extract<
    ReturnType<typeof resolveClipFilerFinalExportTarget>,
    { canExport: false }
  >['cause'],
): void {
  expect(
    resolveClipFilerFinalExportTarget(project, createClipFiler(), clipId),
  ).toMatchObject({ canExport: false, cause });
}

function findClip(project: ProjectState, clipId: string): Clip {
  const clip = project.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === clipId);

  if (!clip) {
    throw new Error(`Missing test Clip: ${clipId}`);
  }

  return clip;
}

function findArtifact(
  project: ProjectState,
  artifactId: string,
): GeneratedAudioArtifact {
  const artifact = project.artifacts?.find(
    (candidate) => candidate.artifactId === artifactId,
  );

  if (!artifact || artifact.kind !== 'audio' || !('provenance' in artifact)) {
    throw new Error(`Missing test Artifact: ${artifactId}`);
  }

  return artifact;
}

function findMasterArtifact(project: ProjectState): GeneratedAudioArtifact {
  return findArtifact(project, masterArtifactId);
}

function findRawArtifact(
  project: ProjectState,
): ProjectMixdownAudioArtifact {
  const artifact = project.artifacts?.find(
    (candidate) => candidate.artifactId === rawArtifactId,
  );

  if (
    !artifact ||
    artifact.kind !== 'audio' ||
    !('mixdownProvenance' in artifact)
  ) {
    throw new Error('Missing test Raw Mixdown Artifact.');
  }

  return artifact;
}

function findRawTake(project: ProjectState): ProjectMixdownAudioClipTake {
  const take = findClip(project, rawClipId).clipTakes?.[0];

  if (!take || take.sourceType !== 'mixdown') {
    throw new Error('Missing test Raw Mixdown Take.');
  }

  return take;
}

function findMasterTake(project: ProjectState): GeneratedAudioClipTake {
  const take = findClip(project, masterClipId).clipTakes?.[0];

  if (!take || take.sourceType !== 'job' || take.mediaType !== 'audio') {
    throw new Error('Missing test Master Take.');
  }

  return take;
}

function syncSourceFile(
  project: ProjectState,
  clipId: string,
  artifactId: string,
): void {
  const clip = findClip(project, clipId);
  const artifact = findArtifact(project, artifactId);

  clip.sourceFile = {
    ...clip.sourceFile,
    mimeType: artifact.audio.mimeType,
    name: artifact.file.name,
    relativePath: artifact.file.relativePath,
    sizeBytes: artifact.file.sizeBytes,
    sourceId: artifact.artifactId,
    status: 'available',
  };
}
