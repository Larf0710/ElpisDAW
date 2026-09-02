import { describe, expect, it } from 'vitest';

import {
  ACE_STEP_PATCH_TAB_TEMPLATE_ID,
  createAceStepTextToAudioVocalTarget,
  createAceStepPatchTabModelSummary,
  createAceStepPatchTabTemplate,
  isAceStepPatchTab,
  prepareAceStepPatchTabRun,
  resolveAceStepPatchTabSettings,
} from './aceStepPatchTab';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { sampleProject } from './sampleProject';
import type {
  Clip,
  GeneratedAudioArtifact,
  GeneratedAudioClipTake,
  MidiArtifact,
  MidiClipTake,
  PatchTab,
  ProjectState,
} from './types';

describe('ACE-Step PatchTab', () => {
  it('publishes the minimum Lego vocals template and fixed port contract', () => {
    const patchTab = createAceStepPatchTabTemplate(7);

    expect(patchTab).toMatchObject({
      colorIndex: 7,
      id: ACE_STEP_PATCH_TAB_TEMPLATE_ID,
      inputType: 'Guide Audio',
      name: 'ACE Vocals',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
      nodeVersion: '1.0.0',
      outputType: 'Vocal Audio',
    });
    expect(patchTab.portContractSnapshot).toMatchObject({
      inputs: [{ id: 'guide-audio-in', cardinality: { min: 1, max: 1 } }],
      outputs: [{ id: 'vocal-audio-out', role: 'vocal-render' }],
    });
    expect(patchTab.parameters.map(({ id }) => id)).toEqual([
      'lyrics',
      'caption',
      'vocalLanguage',
      'seed',
    ]);
    expect(isAceStepPatchTab(patchTab)).toBe(true);
    expect(createAceStepPatchTabModelSummary()).toContain('LEGO');
  });

  it('resolves trimmed Lyrics, Caption, language, and Seed', () => {
    const patchTab = createAceStepPatchTabTemplate();
    patchTab.parameters = patchTab.parameters.map((parameter) =>
      parameter.id === 'lyrics' && parameter.kind === 'text'
        ? { ...parameter, value: 'Stay with me\nThrough the night' }
        : parameter.id === 'vocalLanguage' && parameter.kind === 'select'
          ? { ...parameter, value: 'Japanese (ja)' }
          : parameter.id === 'seed' && parameter.kind === 'number'
            ? { ...parameter, value: 17 }
            : parameter,
    );

    expect(resolveAceStepPatchTabSettings(patchTab)).toEqual({
      canResolve: true,
      settings: {
        caption:
          'Solo vocal, a cappella, warm intimate lead vocal following the guide melody',
        lyrics: 'Stay with me\nThrough the night',
        seed: 17,
        vocalLanguage: 'ja',
        vocalLanguageLabel: 'Japanese (ja)',
      },
    });
  });

  it('fails closed for empty or unsafe Lyrics and invalid language or Seed', () => {
    const template = createAceStepPatchTabTemplate();
    const cases: Array<Readonly<{ id: string; kind: string; value: string | number }>> = [
      { id: 'lyrics', kind: 'text', value: '' },
      { id: 'lyrics', kind: 'text', value: ' padded ' },
      { id: 'vocalLanguage', kind: 'select', value: 'French (fr)' },
      { id: 'seed', kind: 'number', value: -1 },
    ];

    for (const invalid of cases) {
      const patchTab: PatchTab = {
        ...template,
        parameters: template.parameters.map((parameter) =>
          parameter.id === invalid.id && parameter.kind === invalid.kind
            ? { ...parameter, value: invalid.value } as typeof parameter
            : parameter.id === 'lyrics' && parameter.kind === 'text'
              ? { ...parameter, value: 'Valid lyrics' }
              : parameter,
        ),
      };

      expect(resolveAceStepPatchTabSettings(patchTab)).toMatchObject({
        canResolve: false,
      });
    }
  });

  it('prepares one selected Vocal -> Guide -> MIDI role chain', () => {
    const project = createProject();
    const patchTab = createAceStepPatchTabTemplate();
    patchTab.parameters = patchTab.parameters.map((parameter) =>
      parameter.id === 'lyrics' && parameter.kind === 'text'
        ? { ...parameter, value: 'Stay with me' }
        : parameter,
    );

    expect(prepareAceStepPatchTabRun(project, patchTab, 'clip-vocal-a')).toMatchObject({
      canPrepare: true,
      mode: 'existing-vocal',
      settings: { lyrics: 'Stay with me' },
      target: {
        guideClipId: 'clip-guide-a',
        midiClipId: 'clip-midi-a',
        targetClipId: 'clip-vocal-a',
      },
    });
    expect(prepareAceStepPatchTabRun(project, patchTab, undefined)).toMatchObject({
      canPrepare: false,
      cause: 'ace-step-target-missing',
    });
    expect(
      prepareAceStepPatchTabRun(project, patchTab, 'clip-midi-a'),
    ).toMatchObject({
      canPrepare: false,
      cause: 'ace-step-target-invalid',
      message: 'Select one finalized SA3 T2A Guide or existing Vocal Audio Clip before generation.',
    });

    const vocalClip = project.tracks[0]?.clips.find(
      (clip) => clip.id === 'clip-vocal-a',
    );
    if (!vocalClip) {
      throw new Error('Fixture requires the Vocal Audio Clip.');
    }
    vocalClip.activeClipTakeId = undefined;

    expect(
      prepareAceStepPatchTabRun(project, patchTab, 'clip-vocal-a'),
    ).toMatchObject({
      canPrepare: false,
      cause: 'ace-step-target-invalid',
      message:
        'Selected Vocal Clip requires Active Vocal, Guide Audio, and corrected MIDI Takes.',
    });
  });

  it('prepares one strict finalized SA3 T2A Guide and collision-safe new Vocal target ids', () => {
    const project = createTextToAudioProject();
    const patchTab = createAceStepPatchTabTemplate();
    patchTab.parameters = patchTab.parameters.map((parameter) =>
      parameter.id === 'lyrics' && parameter.kind === 'text'
        ? { ...parameter, value: 'Stay with me' }
        : parameter,
    );

    expect(
      prepareAceStepPatchTabRun(project, patchTab, 'clip-sa3-t2a-a'),
    ).toMatchObject({
      canPrepare: true,
      guide: {
        guideArtifactId: 'artifact-sa3-t2a-a',
        guideClipId: 'clip-sa3-t2a-a',
        guideClipName: 'Generated Backing',
        guideClipTakeId: 'clip-take-sa3-t2a-a',
        guideDurationSeconds: 10,
        guideLengthTicks: 7_680,
        guideStartTick: 960,
      },
      mode: 'stable-audio-3-text-to-audio',
      settings: { lyrics: 'Stay with me' },
    });

    project.tracks.push({
      clips: [],
      id: 'ace-vocals-request-01-track',
      level: 0,
      name: 'Existing collision',
      type: 'vocal',
    });
    const target = createAceStepTextToAudioVocalTarget(
      project,
      'Request 01',
      '2026-08-17T07:00:00.000Z',
    );

    expect(target).toEqual({
      canCreate: true,
      target: {
        clipId: 'ace-vocals-request-01-clip',
        clipName: 'ACE Vocal',
        createdAt: '2026-08-17T07:00:00.000Z',
        trackId: 'ace-vocals-request-01-track-2',
        trackName: 'ACE Vocals',
      },
    });
  });

  it('keeps non-SA3 generated Audio blocked from the standalone Guide mode', () => {
    const project = createTextToAudioProject();
    const patchTab = createAceStepPatchTabTemplate();
    const artifact = project.artifacts?.[0];

    patchTab.parameters = patchTab.parameters.map((parameter) =>
      parameter.id === 'lyrics' && parameter.kind === 'text'
        ? { ...parameter, value: 'Stay with me' }
        : parameter,
    );
    if (!artifact || artifact.kind !== 'audio' || !('provenance' in artifact)) {
      throw new Error('T2A fixture requires one generated Audio Artifact.');
    }
    artifact.provenance = {
      ...artifact.provenance,
      taskId: 'audio-to-audio',
    };

    expect(
      prepareAceStepPatchTabRun(project, patchTab, 'clip-sa3-t2a-a'),
    ).toMatchObject({
      canPrepare: false,
      cause: 'ace-step-guide-invalid',
    });
  });
});

function createProject(): ProjectState {
  const project = structuredClone(sampleProject);
  const track = project.tracks[0];
  const baseClip = track?.clips[0];

  if (!track || !baseClip) {
    throw new Error('Sample Project requires one Track and Clip.');
  }

  const midiArtifact = createMidiArtifact();
  const guideArtifact = createGuideArtifact();
  const vocalArtifact = createVocalArtifact();
  const midiTake = createMidiTake();
  const guideTake = createAudioTake(
    guideArtifact,
    'clip-take-guide-a',
    'Instrument Guide',
  );
  const vocalTake = createAudioTake(
    vocalArtifact,
    'clip-take-vocal-a',
    'Existing Vocal',
  );

  return {
    ...project,
    artifacts: [midiArtifact, guideArtifact, vocalArtifact],
    tracks: [
      {
        ...track,
        clips: [
          createClip(baseClip, {
            activeClipTakeId: midiTake.clipTakeId,
            clipTakes: [midiTake],
            id: 'clip-midi-a',
            name: 'Corrected MIDI',
            type: 'edited-midi',
          }),
          createClip(baseClip, {
            activeClipTakeId: guideTake.clipTakeId,
            clipTakes: [guideTake],
            id: 'clip-guide-a',
            name: 'Instrument Guide',
            sourceClipId: 'clip-midi-a',
            type: 'instrument-audio',
          }),
          createClip(baseClip, {
            activeClipTakeId: vocalTake.clipTakeId,
            clipTakes: [vocalTake],
            id: 'clip-vocal-a',
            name: 'Vocal',
            sourceClipId: 'clip-guide-a',
            type: 'vocal-audio',
          }),
        ],
      },
    ],
  };
}

function createTextToAudioProject(): ProjectState {
  const project = structuredClone(sampleProject);
  const baseTrack = project.tracks[0];
  const baseClip = baseTrack?.clips[0];

  if (!baseTrack || !baseClip) {
    throw new Error('Sample Project requires one Track and Clip.');
  }

  const artifact: GeneratedAudioArtifact = {
    artifactId: 'artifact-sa3-t2a-a',
    audio: { channels: 2, durationSeconds: 10, mimeType: 'audio/wav' },
    createdAt: '2026-08-12T12:30:00.000Z',
    destination: 'stable-audio-3',
    file: {
      extension: '.wav',
      name: 'artifact-sa3-t2a-a.wav',
      relativePath: 'renders/stable-audio-3/artifact-sa3-t2a-a.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: { parentArtifactIds: [], parentClipTakeIds: [] },
    provenance: {
      modelId: 'stable-audio-3-medium',
      modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      parameters: {
        channels: 2,
        durationSeconds: 10,
        prompt: 'Focused instrumental backing',
        sampleRate: 44_100,
        seed: 7,
      },
      providerId: 'local-stable-audio-3',
      seed: 7,
      taskId: 'text-to-audio',
    },
    sourceJobId: 'job-sa3-t2a-a',
  };
  const clipTake: GeneratedAudioClipTake = {
    artifactId: artifact.artifactId,
    clipTakeId: 'clip-take-sa3-t2a-a',
    createdAt: artifact.createdAt,
    label: 'SA3 T2A Take 01',
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };

  return {
    ...project,
    artifacts: [artifact],
    tracks: [
      {
        ...baseTrack,
        clips: [
          createClip(baseClip, {
            activeClipTakeId: clipTake.clipTakeId,
            clipTakes: [clipTake],
            id: 'clip-sa3-t2a-a',
            lengthTicks: 7_680,
            name: 'Generated Backing',
            sourceFile: {
              durationSeconds: 10,
              mimeType: 'audio/wav',
              name: artifact.file.name,
              relativePath: artifact.file.relativePath,
              sizeBytes: artifact.file.sizeBytes,
              sourceId: artifact.artifactId,
              status: 'available',
            },
            startTick: 960,
            type: 'ai-fill-audio',
          }),
        ],
        id: 'track-sa3-t2a-a',
        name: 'Generated Backing',
        type: 'generated_audio',
      },
    ],
  };
}

function createClip(base: Clip, overrides: Partial<Clip>): Clip {
  return {
    ...base,
    activeClipTakeId: undefined,
    clipTakes: undefined,
    sourceClipId: undefined,
    ...overrides,
  };
}

function createMidiArtifact(): MidiArtifact {
  return {
    artifactId: 'artifact-midi-a',
    contentHash: 'midi-content-hash-a',
    createdAt: '2026-08-12T12:00:00.000Z',
    editProvenance: {
      editorId: 'humstudio-midi-editor',
      editorVersion: '1',
      taskId: 'midi-edit',
    },
    kind: 'midi',
    lineage: {
      parentArtifactIds: ['artifact-midi-source'],
      parentClipTakeIds: ['clip-take-midi-source'],
    },
    midi: {
      bpm: 120,
      notes: [{ id: 'note-a', lengthTicks: 960, pitch: 60, startTick: 0, velocity: 100 }],
      ticksPerQuarter: 960,
    },
    revision: 1,
    sourceEditId: 'midi-edit-a',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}

function createMidiTake(): MidiClipTake {
  return {
    artifactId: 'artifact-midi-a',
    clipTakeId: 'clip-take-midi-a',
    contentHash: 'midi-content-hash-a',
    createdAt: '2026-08-12T12:00:00.000Z',
    label: 'Corrected MIDI',
    mediaType: 'midi',
    revision: 1,
    sourceEditId: 'midi-edit-a',
    sourceType: 'edit',
    updatedAt: '2026-08-12T12:00:00.000Z',
  };
}

function createGuideArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-guide-a',
    audio: { channels: 2, durationSeconds: 10, mimeType: 'audio/wav' },
    createdAt: '2026-08-12T12:30:00.000Z',
    destination: 'instrument',
    file: {
      extension: '.wav',
      name: 'artifact-guide-a.wav',
      relativePath: 'renders/instruments/artifact-guide-a.wav',
      sizeBytes: 1_920_044,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-midi-a'],
      parentClipTakeIds: ['clip-take-midi-a'],
    },
    provenance: {
      modelId: 'soundfont-renderer',
      modelRevision: '1',
      parameters: {},
      providerId: 'local-fluidsynth',
      taskId: 'midi-to-audio',
    },
    sourceJobId: 'job-guide-a',
  };
}

function createVocalArtifact(): GeneratedAudioArtifact {
  return {
    artifactId: 'artifact-vocal-a',
    audio: { channels: 2, durationSeconds: 10, mimeType: 'audio/wav' },
    createdAt: '2026-08-12T12:40:00.000Z',
    destination: 'ace-step',
    file: {
      extension: '.wav',
      name: 'artifact-vocal-a.wav',
      relativePath: 'renders/ace-step/artifact-vocal-a.wav',
      sizeBytes: 3_840_088,
    },
    kind: 'audio',
    lineage: {
      parentArtifactIds: ['artifact-guide-old', 'artifact-lyrics-old'],
      parentClipTakeIds: ['clip-take-midi-old'],
    },
    provenance: {
      modelId: 'acestep-v15-base',
      modelRevision: 'e432212fec32b8965a14ffa57ae653438d6abd14',
      parameters: { seed: 7 },
      providerId: 'local-ace-step',
      seed: 7,
      taskId: 'guide-audio-to-vocals',
    },
    sourceJobId: 'job-vocal-a',
  };
}

function createAudioTake(
  artifact: GeneratedAudioArtifact,
  clipTakeId: string,
  label: string,
): GeneratedAudioClipTake {
  return {
    artifactId: artifact.artifactId,
    clipTakeId,
    createdAt: artifact.createdAt,
    label,
    mediaType: 'audio',
    sourceJobId: artifact.sourceJobId,
    sourceType: 'job',
  };
}
