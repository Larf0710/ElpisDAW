import { describe, expect, it } from 'vitest';

import type { LocalEngineSourceRestoration } from './localEngineClient';
import {
  applyProjectSourceRestoration,
  collectProjectSourceRestorationDescriptors,
} from './projectSourceRestoration';
import { sampleProject } from './sampleProject';
import type {
  ClipSourceFile,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  GeneratedMidiArtifact,
  GeneratedMidiClipTake,
  ProjectState,
} from './types';

describe('Project source restoration', () => {
  it('collects unique generated and external descriptors from Project clips', () => {
    const project = createProject([
      {
        lastModified: 1_721_692_800_000,
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sizeBytes: 48_044,
        sourceId: 'source-generated',
        status: 'unresolved',
      },
      {
        lastModified: 1_721_692_800_000,
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sourceId: 'source-generated',
        status: 'unresolved',
      },
      {
        name: 'voice.wav',
        path: 'C:\\Audio\\voice.wav',
        sizeBytes: 24_022,
        sourceId: 'source-external',
        status: 'unresolved',
      },
      {
        name: 'session-only.wav',
        sourceId: 'source-session-only',
        status: 'unresolved',
      },
    ]);

    expect(collectProjectSourceRestorationDescriptors(project)).toEqual([
      {
        kind: 'generated',
        lastModified: 1_721_692_800_000,
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sizeBytes: 48_044,
        sourceId: 'source-generated',
      },
      {
        kind: 'external',
        name: 'voice.wav',
        path: 'C:\\Audio\\voice.wav',
        sizeBytes: 24_022,
        sourceId: 'source-external',
      },
    ]);
  });

  it('rejects conflicting descriptors that reuse one source id', () => {
    const project = createProject([
      {
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sourceId: 'source-shared',
        status: 'unresolved',
      },
      {
        name: 'take-b.wav',
        relativePath: 'recordings/take-b.wav',
        sourceId: 'source-shared',
        status: 'unresolved',
      },
    ]);

    expect(() => collectProjectSourceRestorationDescriptors(project)).toThrow(
      'Source source-shared has conflicting storage descriptors.',
    );
  });

  it('uses Active Take lineage instead of stale Clip source metadata', () => {
    const project = createProject([
      {
        name: 'legacy.wav',
        relativePath: 'recordings/legacy.wav',
        sourceId: 'legacy-stale-source',
        status: 'unresolved',
      },
    ]);
    const artifact = createGeneratedArtifact();
    const take: GeneratedAudioClipTake = {
      artifactId: artifact.artifactId,
      clipTakeId: 'clip-take-generated',
      createdAt: artifact.createdAt,
      label: 'Generated Take 01',
      mediaType: 'audio',
      sourceJobId: artifact.sourceJobId,
      sourceType: 'job',
    };
    const clip = project.tracks[0].clips[0];
    project.artifacts = [artifact];
    clip.activeClipTakeId = take.clipTakeId;
    clip.clipTakes = [take];
    clip.type = 'instrument-audio';
    const descriptors = collectProjectSourceRestorationDescriptors(project);
    const restoration: LocalEngineSourceRestoration = Object.freeze({
      availability: Object.freeze({
        [artifact.artifactId]: 'available',
      }),
      checkedAt: '2026-08-01T04:00:00.000Z',
      sources: Object.freeze([
        Object.freeze({
          actual: Object.freeze({
            lastModified: 1_722_484_800_000,
            name: artifact.file.name,
            sizeBytes: artifact.file.sizeBytes,
          }),
          kind: 'generated' as const,
          reason: 'available' as const,
          relativePath: artifact.file.relativePath,
          resolvedPath:
            'D:\\Music\\Project\\renders\\instruments\\artifact-generated.wav',
          sourceId: artifact.artifactId,
          state: 'available' as const,
        }),
      ]),
    });

    expect(descriptors).toEqual([
      {
        kind: 'generated',
        name: artifact.file.name,
        relativePath: artifact.file.relativePath,
        sizeBytes: artifact.file.sizeBytes,
        sourceId: artifact.artifactId,
      },
    ]);

    const restoredProject = applyProjectSourceRestoration(
      project,
      descriptors,
      restoration,
    );

    expect(restoredProject.tracks[0].clips[0].sourceFile).toMatchObject({
      name: artifact.file.name,
      relativePath: artifact.file.relativePath,
      sizeBytes: artifact.file.sizeBytes,
      sourceId: artifact.artifactId,
      status: 'available',
    });
    expect(project.tracks[0].clips[0].sourceFile?.sourceId).toBe(
      'legacy-stale-source',
    );
  });

  it('collects and applies only Audio descriptors when a valid Active MIDI Take is present', () => {
    const project = createProject([
      {
        name: 'legacy.wav',
        relativePath: 'recordings/legacy.wav',
        sourceId: 'legacy-stale-source',
        status: 'unresolved',
      },
      {
        name: 'inline-midi.mid',
        sourceId: 'inline-midi-source',
        status: 'unresolved',
      },
    ]);
    const audioArtifact = createGeneratedArtifact();
    const audioTake: GeneratedAudioClipTake = {
      artifactId: audioArtifact.artifactId,
      clipTakeId: 'clip-take-generated',
      createdAt: audioArtifact.createdAt,
      label: 'Generated Take 01',
      mediaType: 'audio',
      sourceJobId: audioArtifact.sourceJobId,
      sourceType: 'job',
    };
    const midiArtifact = createGeneratedMidiArtifact();
    const midiTake: GeneratedMidiClipTake = {
      artifactId: midiArtifact.artifactId,
      clipTakeId: 'clip-take-midi',
      createdAt: midiArtifact.createdAt,
      label: 'Basic Pitch MIDI',
      mediaType: 'midi',
      sourceJobId: midiArtifact.sourceJobId,
      sourceType: 'job',
    };
    const audioClip = project.tracks[0].clips[0];
    const midiClip = project.tracks[0].clips[1];
    audioClip.activeClipTakeId = audioTake.clipTakeId;
    audioClip.clipTakes = [audioTake];
    audioClip.type = 'instrument-audio';
    midiClip.activeClipTakeId = midiTake.clipTakeId;
    midiClip.clipTakes = [midiTake];
    midiClip.type = 'midi-notes';
    project.artifacts = [audioArtifact, midiArtifact];
    const midiClipSnapshot = structuredClone(midiClip);
    const descriptors = collectProjectSourceRestorationDescriptors(project);
    const restoration: LocalEngineSourceRestoration = Object.freeze({
      availability: Object.freeze({
        [audioArtifact.artifactId]: 'available',
      }),
      checkedAt: '2026-08-01T04:00:00.000Z',
      sources: Object.freeze([
        Object.freeze({
          actual: Object.freeze({
            lastModified: 1_722_484_800_000,
            name: audioArtifact.file.name,
            sizeBytes: audioArtifact.file.sizeBytes,
          }),
          kind: 'generated' as const,
          reason: 'available' as const,
          relativePath: audioArtifact.file.relativePath,
          resolvedPath:
            'D:\\Music\\Project\\renders\\instruments\\artifact-generated.wav',
          sourceId: audioArtifact.artifactId,
          state: 'available' as const,
        }),
      ]),
    });

    expect(descriptors).toEqual([
      {
        kind: 'generated',
        name: audioArtifact.file.name,
        relativePath: audioArtifact.file.relativePath,
        sizeBytes: audioArtifact.file.sizeBytes,
        sourceId: audioArtifact.artifactId,
      },
    ]);

    const restoredProject = applyProjectSourceRestoration(
      project,
      descriptors,
      restoration,
    );

    expect(restoredProject.tracks[0].clips[1]).toBe(midiClip);
    expect(restoredProject.tracks[0].clips[1]).toEqual(midiClipSnapshot);
    expect(project.tracks[0].clips[0].sourceFile?.sourceId).toBe(
      'legacy-stale-source',
    );
  });

  it('rejects malformed Active Audio Take metadata without falling back to Clip source metadata', () => {
    const project = createProject([
      {
        name: 'legacy.wav',
        relativePath: 'recordings/legacy.wav',
        sourceId: 'legacy-stale-source',
        status: 'unresolved',
      },
    ]);
    const clip = project.tracks[0].clips[0];
    clip.activeClipTakeId = 'missing-audio-take';
    clip.clipTakes = [];
    clip.type = 'instrument-audio';

    expect(() => collectProjectSourceRestorationDescriptors(project)).toThrow(
      'Active source metadata is invalid for clip-source-1: Source 1 Active Take does not resolve uniquely.',
    );
    expect(clip.sourceFile?.sourceId).toBe('legacy-stale-source');
  });

  it('applies available, missing, and unopenable results without mutating the loaded Project', () => {
    const project = createProject([
      {
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sourceId: 'source-available',
        status: 'unresolved',
      },
      {
        name: 'missing.wav',
        path: 'C:\\Audio\\missing.wav',
        sourceId: 'source-missing',
        status: 'unresolved',
      },
      {
        name: 'locked.wav',
        path: 'C:\\Audio\\locked.wav',
        sourceId: 'source-unopenable',
        status: 'unresolved',
      },
    ]);
    const descriptors = collectProjectSourceRestorationDescriptors(project);
    const restoration: LocalEngineSourceRestoration = Object.freeze({
      availability: Object.freeze({
        'source-available': 'available',
        'source-missing': 'missing',
        'source-unopenable': 'unopenable',
      }),
      checkedAt: '2026-08-01T04:00:00.000Z',
      sources: Object.freeze([
        Object.freeze({
          actual: Object.freeze({
            lastModified: 1_722_484_800_000,
            name: 'take-a.wav',
            sizeBytes: 48_044,
          }),
          kind: 'generated' as const,
          reason: 'available' as const,
          relativePath: 'recordings/take-a.wav',
          resolvedPath: 'D:\\Music\\Project\\recordings\\take-a.wav',
          sourceId: 'source-available',
          state: 'available' as const,
        }),
        Object.freeze({
          kind: 'external' as const,
          path: 'C:\\Audio\\missing.wav',
          reason: 'missing' as const,
          sourceId: 'source-missing',
          state: 'missing' as const,
        }),
        Object.freeze({
          kind: 'external' as const,
          path: 'C:\\Audio\\locked.wav',
          reason: 'unopenable' as const,
          sourceId: 'source-unopenable',
          state: 'unopenable' as const,
        }),
      ]),
    });

    const restoredProject = applyProjectSourceRestoration(
      project,
      descriptors,
      restoration,
    );
    const restoredSources = restoredProject.tracks[0].clips.map(
      (clip) => clip.sourceFile,
    );

    expect(restoredSources).toMatchObject([
      {
        checkedAt: restoration.checkedAt,
        lastModified: 1_722_484_800_000,
        name: 'take-a.wav',
        sizeBytes: 48_044,
        status: 'available',
      },
      {
        checkedAt: restoration.checkedAt,
        path: 'C:\\Audio\\missing.wav',
        status: 'missing',
      },
      {
        checkedAt: restoration.checkedAt,
        path: 'C:\\Audio\\locked.wav',
        status: 'unresolved',
      },
    ]);
    expect(project.tracks[0].clips.map((clip) => clip.sourceFile?.status)).toEqual([
      'unresolved',
      'unresolved',
      'unresolved',
    ]);
    expect(restoredProject).not.toBe(project);
  });

  it('rejects restoration responses that omit or substitute requested sources', () => {
    const project = createProject([
      {
        name: 'take-a.wav',
        relativePath: 'recordings/take-a.wav',
        sourceId: 'source-a',
        status: 'unresolved',
      },
    ]);
    const descriptors = collectProjectSourceRestorationDescriptors(project);
    const incompleteRestoration: LocalEngineSourceRestoration = Object.freeze({
      availability: Object.freeze({}),
      checkedAt: '2026-08-01T04:00:00.000Z',
      sources: Object.freeze([]),
    });
    const substitutedRestoration: LocalEngineSourceRestoration = Object.freeze({
      availability: Object.freeze({ 'source-a': 'missing' }),
      checkedAt: '2026-08-01T04:00:00.000Z',
      sources: Object.freeze([
        Object.freeze({
          kind: 'generated' as const,
          reason: 'missing' as const,
          relativePath: 'recordings/substitute.wav',
          sourceId: 'source-a',
          state: 'missing' as const,
        }),
      ]),
    });

    expect(() =>
      applyProjectSourceRestoration(project, descriptors, incompleteRestoration),
    ).toThrow('Source restoration did not return one result per descriptor.');
    expect(() =>
      applyProjectSourceRestoration(project, descriptors, substitutedRestoration),
    ).toThrow('Source restoration returned an unexpected result for source-a.');
  });
});

function createProject(sourceFiles: readonly ClipSourceFile[]): ProjectState {
  const project = structuredClone(sampleProject);
  const baseTrack = project.tracks[0];
  const baseClip = baseTrack.clips[0];

  return {
    ...project,
    tracks: [
      {
        ...baseTrack,
        clips: sourceFiles.map((sourceFile, index) => ({
          ...baseClip,
          id: `clip-source-${index + 1}`,
          name: `Source ${index + 1}`,
          sourceFile: { ...sourceFile },
        })),
      },
    ],
  };
}

function createGeneratedArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-generated',
    audio: {
      channels: 2,
      durationSeconds: 1.25,
      mimeType: 'audio/wav',
    },
    createdAt: '2026-07-26T00:00:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-generated.wav',
      relativePath: 'renders/instruments/artifact-generated.wav',
      sizeBytes: 48_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    provenance: {
      modelId: 'mock-model',
      modelRevision: '1',
      parameters: {},
      providerId: 'mock-provider',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-generated',
  };
}

function createGeneratedMidiArtifact(): GeneratedMidiArtifact {
  return {
    artifactId: 'artifact-midi',
    createdAt: '2026-07-26T00:00:01.000Z',
    kind: 'midi',
    lineage: {
      parentArtifactIds: [],
      parentClipTakeIds: [],
    },
    midi: {
      bpm: 120,
      notes: [
        {
          id: 'note-1',
          lengthTicks: 480,
          pitch: 60,
          startTick: 0,
          velocity: 100,
        },
      ],
      ticksPerQuarter: 960,
    },
    provenance: {
      modelId: 'basic-pitch-icassp-2022',
      modelRevision: '0.4.0-onnx',
      parameters: {},
      providerId: 'local-basic-pitch',
      taskId: 'hum-to-midi',
    },
    sourceJobId: 'job-midi',
  };
}
