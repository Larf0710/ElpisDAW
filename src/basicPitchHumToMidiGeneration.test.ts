import { describe, expect, it } from 'vitest';

import {
  createBasicPitchHumToMidiGenerationPlan,
  createCompletedBasicPitchHumToMidiRegistration,
  resolveBasicPitchHumToMidiParameters,
} from './humToMidiGeneration';
import {
  cloneBasicPitchTestValue,
  createBasicPitchHumToMidiTestProject,
  createCompletedBasicPitchHumToMidiTestJob,
  findBasicPitchTestClip,
  requireBasicPitchHumToMidiTestPlan,
} from './basicPitchHumToMidiTestFixture';
import type { PatchTab, ProjectState, SoundFontAssignment } from './types';

const defaultSoundFontAssignment: SoundFontAssignment = {
  bank: 0,
  program: 0,
  resource: {
    format: 'sf3',
    library: 'builtin',
    relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
    resourceId: `soundfont-${'d'.repeat(32)}`,
  },
};

describe('Basic Pitch Hum to MIDI planning', () => {
  it('creates one immutable production Basic Pitch request with exact provider identity', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const result = createBasicPitchHumToMidiGenerationPlan(project, {
      converterPatchTabId: 'hum-to-midi',
    });

    expect(result).toMatchObject({
      canPlan: true,
      plan: {
        converterPatchTabId: 'hum-to-midi',
        request: {
          inputArtifacts: [
            {
              artifactId: 'artifact-recording-1',
              kind: 'audio',
              relativePath: 'recordings/artifact-recording-1.wav',
            },
          ],
          lineage: {
            parentArtifactIds: ['artifact-recording-1'],
            parentClipTakeIds: ['clip-take-recording-1'],
          },
          modelId: 'basic-pitch-icassp-2022',
          modelRevision: '0.4.0-onnx',
          output: { artifactKind: 'midi' },
          parameters: {
            frameThreshold: 0.3,
            melodiaTrick: true,
            minimumNoteLengthMs: 127.7,
            multiplePitchBends: false,
            projectBpm: 120,
            sourceEndSeconds: 2,
            sourceStartSeconds: 0,
            ticksPerQuarter: 960,
          },
          providerId: 'local-basic-pitch',
          taskId: 'hum-to-midi',
        },
        source: {
          artifactId: 'artifact-recording-1',
          clipId: 'clip-hum-1',
          clipTakeId: 'clip-take-recording-1',
        },
      },
    });

    if (!result.canPlan) {
      throw new Error(result.message);
    }

    expect(Object.isFrozen(result.plan.request)).toBe(true);
    expect(Object.isFrozen(result.plan.request.parameters)).toBe(true);
    expect(JSON.stringify(result.plan.request)).not.toContain('mock-provider');
  });

  it.each([
    [0, 0.8],
    [50, 0.5],
    [72, 0.368],
    [100, 0.2],
  ])('maps Pitch Sensitivity %s to onset threshold %s', (value, threshold) => {
    const patchTab = getHumToMidiPatchTab(createBasicPitchHumToMidiTestProject());
    setSliderValue(patchTab, 'sensitivity', value);

    expect(resolveBasicPitchHumToMidiParameters(patchTab)).toMatchObject({
      canResolve: true,
      parameters: { onsetThreshold: threshold },
      snapshot: { sensitivity: value },
    });
  });

  it.each([
    ['Bass', 40, 392],
    ['Vocal', 80, 1_100],
    ['Lead', 150, 2_000],
  ] as const)(
    'maps %s to one explicit finite frequency range',
    (range, minimumFrequencyHz, maximumFrequencyHz) => {
      const patchTab = getHumToMidiPatchTab(
        createBasicPitchHumToMidiTestProject(),
      );
      setSelectValue(patchTab, 'note-range', range);

      expect(resolveBasicPitchHumToMidiParameters(patchTab)).toMatchObject({
        canResolve: true,
        parameters: { maximumFrequencyHz, minimumFrequencyHz },
        snapshot: { noteRange: range },
      });
    },
  );

  it('rejects missing, duplicated, malformed, or silently coercible saved parameters', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const baseline = getHumToMidiPatchTab(project);
    const cases: PatchTab[] = [
      { ...baseline, parameters: baseline.parameters.slice(0, 1) },
      { ...baseline, parameters: [...baseline.parameters, baseline.parameters[0]] },
      {
        ...baseline,
        parameters: baseline.parameters.map((parameter) =>
          parameter.id === 'sensitivity' && parameter.kind === 'slider'
            ? { ...parameter, step: 0.5 }
            : parameter,
        ),
      },
      {
        ...baseline,
        parameters: baseline.parameters.map((parameter) =>
          parameter.id === 'sensitivity' && parameter.kind === 'slider'
            ? { ...parameter, value: 72.5 }
            : parameter,
        ),
      },
      {
        ...baseline,
        parameters: baseline.parameters.map((parameter) =>
          parameter.id === 'note-range' && parameter.kind === 'select'
            ? { ...parameter, options: ['Bass', 'Lead'], value: 'Lead' }
            : parameter,
        ),
      },
    ];

    for (const patchTab of cases) {
      expect(resolveBasicPitchHumToMidiParameters(patchTab)).toMatchObject({
        canResolve: false,
      });
    }
  });

  it('requires one exact Hum Audio selection and the built-in converter identity', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const emptySelection = cloneBasicPitchTestValue(project);
    emptySelection.selection.items = [];
    const multipleSelection = cloneBasicPitchTestValue(project);
    multipleSelection.selection.items.push({ id: 'clip-midi-1', type: 'clip' });
    const wrongType = cloneBasicPitchTestValue(project);
    wrongType.selection.items = [{ id: 'clip-midi-1', type: 'clip' }];
    const wrongConverter = cloneBasicPitchTestValue(project);
    getHumToMidiPatchTab(wrongConverter).nodeTypeId =
      'humstudio.patch.midi-edit';

    for (const [candidate, reason] of [
      [emptySelection, 'selection-invalid'],
      [multipleSelection, 'selection-invalid'],
      [wrongType, 'source-invalid'],
      [wrongConverter, 'converter-invalid'],
    ] as const) {
      expect(
        createBasicPitchHumToMidiGenerationPlan(candidate, {
          converterPatchTabId: 'hum-to-midi',
        }),
      ).toMatchObject({ canPlan: false, reason });
    }
  });

  it('rejects generated, stale, duplicate, forged, and non-recording source identity', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const generated = cloneBasicPitchTestValue(project);
    (generated.artifacts?.[0] as { destination: string }).destination =
      'instrument-audio';
    const staleTake = cloneBasicPitchTestValue(project);
    findBasicPitchTestClip(staleTake, 'clip-hum-1').activeClipTakeId = 'stale';
    const duplicateArtifact = cloneBasicPitchTestValue(project);
    duplicateArtifact.artifacts?.push(
      cloneBasicPitchTestValue(duplicateArtifact.artifacts[0]),
    );
    const wrongPath = cloneBasicPitchTestValue(project);
    (wrongPath.artifacts?.[0] as { file: { relativePath: string } }).file.relativePath =
      'print-mixes/artifact-recording-1.wav';
    const duplicateTake = cloneBasicPitchTestValue(project);
    const sourceClip = findBasicPitchTestClip(duplicateTake, 'clip-hum-1');
    sourceClip.clipTakes?.push(cloneBasicPitchTestValue(sourceClip.clipTakes[0]));
    const duplicateClip = cloneBasicPitchTestValue(project);
    duplicateClip.tracks[0].clips.push({
      ...cloneBasicPitchTestValue(
        findBasicPitchTestClip(duplicateClip, 'clip-hum-1'),
      ),
    });

    for (const candidate of [
      generated,
      staleTake,
      duplicateArtifact,
      wrongPath,
      duplicateTake,
      duplicateClip,
    ]) {
      expect(
        createBasicPitchHumToMidiGenerationPlan(candidate, {
          converterPatchTabId: 'hum-to-midi',
        }),
      ).toMatchObject({ canPlan: false, reason: 'source-invalid' });
    }
  });
});

describe('completed Basic Pitch Hum to MIDI registration', () => {
  it('atomically registers canonical MIDI lineage and reuses one source target', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const before = JSON.stringify(project);
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const job = createCompletedBasicPitchHumToMidiTestJob(plan);
    const first = createCompletedBasicPitchHumToMidiRegistration(project, {
      createdAt: '2026-08-16T13:00:02.000Z',
      job,
      plan,
    });

    expect(JSON.stringify(project)).toBe(before);
    expect(first).toMatchObject({
      canRegister: true,
      status: 'REGISTERED',
      targetClip: { id: 'clip-midi-1', sourceClipId: 'clip-hum-1' },
      targetCreated: false,
    });

    if (!first.canRegister) {
      throw new Error(first.message);
    }

    expect(first.artifact).toMatchObject({
      lineage: {
        parentArtifactIds: ['artifact-recording-1'],
        parentClipTakeIds: ['clip-take-recording-1'],
      },
      provenance: {
        modelId: 'basic-pitch-icassp-2022',
        modelRevision: '0.4.0-onnx',
        providerId: 'local-basic-pitch',
        taskId: 'hum-to-midi',
      },
      sourceJobId: job.jobId,
    });
    expect(first.project.selection.items).toEqual([
      { id: 'clip-midi-1', type: 'clip' },
    ]);

    const second = createCompletedBasicPitchHumToMidiRegistration(
      first.project,
      {
        createdAt: '2026-08-16T13:00:03.000Z',
        job,
        plan,
      },
    );
    expect(second).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
      targetCreated: false,
    });
  });

  it('creates exactly one MIDI Track and Clip only after valid completion', () => {
    const project = createBasicPitchHumToMidiTestProject();
    project.tracks = project.tracks.filter((track) => track.id !== 'midi-notes');
    const before = JSON.stringify(project);
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const job = createCompletedBasicPitchHumToMidiTestJob(plan);
    const result = createCompletedBasicPitchHumToMidiRegistration(project, {
      createdAt: '2026-08-16T13:00:02.000Z',
      defaultSoundFontAssignment,
      job,
      plan,
    });

    expect(JSON.stringify(project)).toBe(before);
    expect(result).toMatchObject({
      canRegister: true,
      status: 'REGISTERED',
      targetCreated: true,
      targetClip: {
        generatedBy: 'Hum to MIDI',
        soundFont: defaultSoundFontAssignment,
        sourceClipId: 'clip-hum-1',
        type: 'midi-notes',
      },
    });
    if (!result.canRegister) throw new Error(result.message);
    const targetTracks = result.project.tracks.filter(
      (track) => track.id === 'midi-notes' && track.type === 'midi',
    );
    expect(targetTracks).toHaveLength(1);
    expect(targetTracks[0].muted).toBe(true);
    expect(targetTracks[0].clips).toHaveLength(1);
  });

  it.each([
    'selection',
    'take',
    'descriptor',
    'timing',
    'bpm',
    'settings',
  ] as const)('rejects changed %s with zero mutation', (change) => {
    const project = createBasicPitchHumToMidiTestProject();
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const job = createCompletedBasicPitchHumToMidiTestJob(plan);
    const changed = cloneBasicPitchTestValue(project);

    if (change === 'selection') {
      changed.selection.items = [];
    } else if (change === 'take') {
      findBasicPitchTestClip(changed, 'clip-hum-1').activeClipTakeId = 'stale';
    } else if (change === 'descriptor') {
      (changed.artifacts?.[0] as { file: { sizeBytes: number } }).file.sizeBytes += 1;
    } else if (change === 'timing') {
      const clip = findBasicPitchTestClip(changed, 'clip-hum-1');
      clip.audioTiming = {
        sourceEndSeconds: 1.75,
        sourceStartSeconds: 0,
        timeBase: 'absolute-seconds',
      };
    } else if (change === 'bpm') {
      changed.bpm += 1;
    } else {
      setSliderValue(getHumToMidiPatchTab(changed), 'sensitivity', 71);
    }

    const before = JSON.stringify(changed);
    expect(
      createCompletedBasicPitchHumToMidiRegistration(changed, {
        createdAt: '2026-08-16T13:00:02.000Z',
        job,
        plan,
      }),
    ).toMatchObject({ canRegister: false, reason: 'source-stale' });
    expect(JSON.stringify(changed)).toBe(before);
  });

  it('rejects conflicting targets and mismatched completed Job identity without mutation', () => {
    const project = createBasicPitchHumToMidiTestProject();
    const plan = requireBasicPitchHumToMidiTestPlan(project);
    const job = createCompletedBasicPitchHumToMidiTestJob(plan);
    const duplicate = cloneBasicPitchTestValue(project);
    const midiTrack = duplicate.tracks.find((track) => track.id === 'midi-notes');

    if (!midiTrack) throw new Error('MIDI Track fixture missing.');
    midiTrack.clips.push({
      ...cloneBasicPitchTestValue(findBasicPitchTestClip(duplicate, 'clip-midi-1')),
      id: 'clip-midi-duplicate',
    });
    const duplicateBefore = JSON.stringify(duplicate);

    expect(
      createCompletedBasicPitchHumToMidiRegistration(duplicate, {
        createdAt: '2026-08-16T13:00:02.000Z',
        job,
        plan,
      }),
    ).toMatchObject({ canRegister: false, reason: 'target-conflict' });
    expect(JSON.stringify(duplicate)).toBe(duplicateBefore);

    const mismatched = { ...cloneBasicPitchTestValue(job), providerId: 'mock-provider' };
    expect(
      createCompletedBasicPitchHumToMidiRegistration(project, {
        createdAt: '2026-08-16T13:00:02.000Z',
        job: mismatched,
        plan,
      }),
    ).toMatchObject({ canRegister: false, reason: 'job-invalid' });

    const mismatchedResult = cloneBasicPitchTestValue(job);
    const artifact = (
      mismatchedResult.result as {
        artifact: { provenance: { modelRevision: string } };
      }
    ).artifact;
    artifact.provenance.modelRevision = 'forged-revision';
    expect(
      createCompletedBasicPitchHumToMidiRegistration(project, {
        createdAt: '2026-08-16T13:00:02.000Z',
        job: mismatchedResult,
        plan,
      }),
    ).toMatchObject({ canRegister: false, reason: 'job-invalid' });
  });
});

function getHumToMidiPatchTab(project: ProjectState): PatchTab {
  const patchTab = project.patchTabs.find((candidate) => candidate.id === 'hum-to-midi');
  if (!patchTab) throw new Error('Hum to MIDI fixture missing.');
  return patchTab;
}

function setSliderValue(patchTab: PatchTab, parameterId: string, value: number): void {
  patchTab.parameters = patchTab.parameters.map((parameter) =>
    parameter.id === parameterId && parameter.kind === 'slider'
      ? { ...parameter, value }
      : parameter,
  );
}

function setSelectValue(patchTab: PatchTab, parameterId: string, value: string): void {
  patchTab.parameters = patchTab.parameters.map((parameter) =>
    parameter.id === parameterId && parameter.kind === 'select'
      ? { ...parameter, value }
      : parameter,
  );
}
