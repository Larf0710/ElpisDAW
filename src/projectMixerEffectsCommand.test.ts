import { describe, expect, it } from 'vitest';

import {
  MIXER_COMPRESSOR_ALGORITHM_ID,
  MIXER_COMPRESSOR_ALGORITHM_VERSION,
  MIXER_COMPRESSOR_PARAMETER_SPECS,
  MIXER_ECHO_DELAY_ALGORITHM_ID,
  MIXER_ECHO_DELAY_ALGORITHM_VERSION,
  MIXER_ECHO_DELAY_PARAMETER_SPECS,
  MIXER_EQUALIZER_ALGORITHM_ID,
  MIXER_EQUALIZER_ALGORITHM_VERSION,
  MIXER_EQUALIZER_PARAMETER_SPECS,
  MIXER_LIMITER_ALGORITHM_ID,
  MIXER_LIMITER_ALGORITHM_VERSION,
  MIXER_LIMITER_PARAMETER_SPECS,
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
  type MixerEffectState,
} from '../shared/mixerEffectsContract.js';
import type { LocalEngineSourceDescriptor } from './localEngineClient';
import {
  executeProjectMixerEffectCommand,
  type ProjectMixerEffectCommand,
  type ProjectMixerEffectTarget,
} from './projectMixerEffectsCommand';
import {
  createProjectDirtyStateFingerprint,
  hasProjectDirtyStateDrift,
} from './projectDirtyStateFingerprint';
import {
  createProjectMixdownPlan,
  type ProjectMixdownPlan,
  type ProjectMixdownPlanAvailability,
  type ProjectMixdownPlanInput,
} from './projectMixdownPlan';
import { createCanonicalProjectMixdownPlanJson } from './projectMixdownPlanIdentity';
import {
  createDefaultMixerChannelInsertChain,
  createDefaultMixerMasterInsertChain,
  normalizeProjectMixerState,
  PROJECT_MIXER_MASTER_BUS_ID,
  PROJECT_MIXER_STATE_VERSION,
  reconcileProjectMixerState,
} from './projectMixerState';
import {
  createProjectPlaybackPlan,
  type ProjectPlaybackPlan,
  type ProjectPlaybackPlanAvailability,
} from './projectPlaybackPlan';
import { sampleProject } from './sampleProject';
import {
  createSessionEditHistory,
  redoSessionEdit,
  undoSessionEdit,
  type SessionEditHistory,
} from './sessionEditHistory';
import { tabFlowPresets } from './presets';
import type {
  Clip,
  ClipSourceFile,
  ProjectMixerStateV1,
  ProjectMixerStateV2,
  ProjectState,
  SelectionState,
  Track,
} from './types';
import { TICKS_PER_BEAT } from './workflow';

const CREATED_AT = '2026-08-11T00:00:00.000Z';
const HISTORY_LIMIT = 80;
const TRACK_ID = 'command-track';
const GROUP_ID = 'command-group';
const BPM = 120;
const PROJECT_END_TICK = TICKS_PER_BEAT * 8;

type TestWorkspace = Readonly<{
  project: ProjectState;
  selectedToken: string;
}>;

const SUPPORTED_TARGETS = [
  channelTarget('equalizer'),
  channelTarget('compressor'),
  channelTarget('echo-delay'),
  masterTarget('equalizer'),
  masterTarget('compressor'),
  masterTarget('limiter'),
] as const;

const RESET_CASES = [
  {
    defaultEffect: createDefaultMixerEqualizerEffect(),
    parameter: 'lowGainDb',
    target: channelTarget('equalizer'),
    value: 3,
  },
  {
    defaultEffect: createDefaultMixerCompressorEffect(),
    parameter: 'thresholdDb',
    target: channelTarget('compressor'),
    value: -30,
  },
  {
    defaultEffect: createDefaultMixerEchoDelayEffect(),
    parameter: 'wet',
    target: channelTarget('echo-delay'),
    value: 0.5,
  },
  {
    defaultEffect: createDefaultMixerEqualizerEffect(),
    parameter: 'midGainDb',
    target: masterTarget('equalizer'),
    value: -4,
  },
  {
    defaultEffect: createDefaultMixerCompressorEffect(),
    parameter: 'ratio',
    target: masterTarget('compressor'),
    value: 8,
  },
  {
    defaultEffect: createDefaultMixerLimiterEffect(),
    parameter: 'ceilingDb',
    target: masterTarget('limiter'),
    value: -6,
  },
] as const;

const PARAMETER_BOUNDARY_CASES = [
  ...parameterBoundaryCases(
    channelTarget('equalizer'),
    MIXER_EQUALIZER_PARAMETER_SPECS,
  ),
  ...parameterBoundaryCases(
    channelTarget('compressor'),
    MIXER_COMPRESSOR_PARAMETER_SPECS,
  ),
  ...parameterBoundaryCases(
    channelTarget('echo-delay'),
    MIXER_ECHO_DELAY_PARAMETER_SPECS,
  ),
  ...parameterBoundaryCases(
    masterTarget('limiter'),
    MIXER_LIMITER_PARAMETER_SPECS,
  ),
];

describe('Project Mixer Effects command', () => {
  it.each(SUPPORTED_TARGETS)(
    'edits bypass for $scope $effectType as one immutable history step',
    (target) => {
      const history = createHistory();
      const originalProject = history.present.value.project;
      const originalMixer = originalProject.mixer!;
      const originalEffect = getEffect(originalProject, target);
      const result = execute(history, {
        bypass: false,
        target,
        type: 'set-bypass',
      });

      expect(result.status).toBe('EXECUTED');
      expect(result.history.past).toHaveLength(1);
      expect(result.history.future).toHaveLength(0);
      expect(result.workspace.project).not.toBe(originalProject);
      expect(result.workspace.project.mixer).not.toBe(originalMixer);
      expect(getEffect(result.workspace.project, target).bypass).toBe(false);
      expect(getEffect(result.workspace.project, target)).not.toBe(originalEffect);
      expect(Object.isFrozen(getEffect(result.workspace.project, target))).toBe(true);
      expect(Object.isFrozen(getEffect(result.workspace.project, target).parameters)).toBe(true);
    },
  );

  it.each(PARAMETER_BOUNDARY_CASES)(
    'accepts $effectType $parameter at its $boundary boundary',
    ({ boundary, effectType, parameter, target, value }) => {
      let history = createHistory();

      if (
        effectType === 'equalizer' &&
        parameter === 'midFrequencyHz' &&
        boundary === 'maximum'
      ) {
        history = requireExecuted(execute(history, {
          parameter: 'highFrequencyHz',
          target: channelTarget('equalizer'),
          type: 'set-parameter',
          value: MIXER_EQUALIZER_PARAMETER_SPECS.highFrequencyHz.maximum,
        }, 'prepare-high-frequency')).history;
      }

      const result = execute(
        history,
        {
          parameter,
          target,
          type: 'set-parameter',
          value,
        } as ProjectMixerEffectCommand,
        `boundary-${effectType}-${parameter}-${boundary}`,
      );

      expect(result.status).not.toBe('BLOCKED');
      expect(
        (getEffect(result.workspace.project, target).parameters as unknown as Record<string, number>)[
          parameter
        ],
      ).toBe(value);
    },
  );

  it.each(RESET_CASES)(
    'resets $target.scope $target.effectType to its exact versioned default',
    ({ defaultEffect, parameter, target, value }) => {
      let history = createHistory();
      history = requireExecuted(execute(history, {
        bypass: false,
        target,
        type: 'set-bypass',
      }, `enable-${target.scope}-${target.effectType}`)).history;
      history = requireExecuted(execute(
        history,
        { parameter, target, type: 'set-parameter', value } as ProjectMixerEffectCommand,
        `parameter-${target.scope}-${target.effectType}`,
      )).history;

      const result = execute(
        history,
        { target, type: 'reset' },
        `reset-${target.scope}-${target.effectType}`,
      );

      expect(result.status).toBe('EXECUTED');
      expect(getEffect(result.workspace.project, target)).toEqual(defaultEffect);
      expect(getEffect(result.workspace.project, target).bypass).toBe(true);
    },
  );

  it('rejects missing, stale, and Group Channel targets without history', () => {
    const history = createHistory(true);
    const missing = execute(history, {
      bypass: false,
      target: channelTarget('equalizer', 'missing-track'),
      type: 'set-bypass',
    }, 'missing-target');
    const group = execute(history, {
      bypass: false,
      target: channelTarget('equalizer', GROUP_ID),
      type: 'set-bypass',
    }, 'group-target');

    expect(missing).toMatchObject({
      cause: 'effect-command-track-missing',
      reason: 'target-invalid',
      status: 'BLOCKED',
    });
    expect(group).toMatchObject({
      cause: 'effect-command-group-ineligible',
      reason: 'target-invalid',
      status: 'BLOCKED',
    });
    expect(missing.history).toBe(history);
    expect(group.history).toBe(history);
    expect(missing.workspace).toBe(history.present.value);
    expect(group.workspace).toBe(history.present.value);
  });

  it.each([
    {
      label: 'Limiter on a Channel',
      target: {
        ...masterTarget('limiter'),
        scope: 'channel',
        trackId: TRACK_ID,
      },
    },
    {
      label: 'Echo/Delay on Master',
      target: {
        ...channelTarget('echo-delay'),
        scope: 'master',
        trackId: undefined,
      },
    },
  ])('rejects wrong fixed-chain topology: $label', ({ target }) => {
    const history = createHistory();
    const normalizedTarget = { ...target } as Record<string, unknown>;
    if (normalizedTarget.scope === 'master') {
      delete normalizedTarget.trackId;
    }
    const result = execute(
      history,
      {
        bypass: false,
        target: normalizedTarget,
        type: 'set-bypass',
      } as unknown as ProjectMixerEffectCommand,
      `wrong-topology-${String(normalizedTarget.scope)}`,
    );

    expect(result).toMatchObject({
      cause: 'effect-command-target-topology-invalid',
      reason: 'target-invalid',
      status: 'BLOCKED',
    });
    expect(result.history).toBe(history);
  });

  it.each([
    {
      label: 'algorithm identity',
      target: { ...channelTarget('equalizer'), algorithmId: 'fake.equalizer' },
    },
    {
      label: 'algorithm version',
      target: { ...masterTarget('limiter'), algorithmVersion: 2 },
    },
    {
      label: 'effect type and algorithm confusion',
      target: {
        ...channelTarget('equalizer'),
        effectType: 'compressor',
      },
    },
  ])('rejects confused target $label', ({ target }) => {
    const history = createHistory();
    const result = execute(
      history,
      { bypass: false, target, type: 'set-bypass' } as unknown as ProjectMixerEffectCommand,
      `confused-${target.effectType}`,
    );

    expect(result).toMatchObject({
      cause: 'effect-command-target-identity-invalid',
      reason: 'target-invalid',
      status: 'BLOCKED',
    });
    expect(result.history).toBe(history);
  });

  it.each([
    'reordered Inserts',
    'wrong persisted algorithm version',
    'duplicate Channel',
    'missing Insert',
    'unknown Mixer version',
  ])('fails closed for malformed State v2: %s', (shape) => {
    const project = createProject();
    const mixer = project.mixer!;
    const channel = mixer.channels[0];
    let malformed: unknown;

    if (shape === 'reordered Inserts') {
      malformed = {
        ...mixer,
        channels: [{
          ...channel,
          inserts: [channel.inserts[1], channel.inserts[0], channel.inserts[2]],
        }],
      };
    } else if (shape === 'wrong persisted algorithm version') {
      malformed = {
        ...mixer,
        channels: [{
          ...channel,
          inserts: [
            { ...channel.inserts[0], algorithmVersion: 2 },
            channel.inserts[1],
            channel.inserts[2],
          ],
        }],
      };
    } else if (shape === 'duplicate Channel') {
      malformed = { ...mixer, channels: [channel, channel] };
    } else if (shape === 'missing Insert') {
      malformed = { ...mixer, channels: [{ ...channel, inserts: channel.inserts.slice(0, 2) }] };
    } else {
      malformed = { ...mixer, schemaVersion: 3 };
    }

    const history = createHistoryFromProject({
      ...project,
      mixer: malformed as ProjectMixerStateV2,
    });
    const result = execute(history, {
      bypass: false,
      target: channelTarget('equalizer'),
      type: 'set-bypass',
    }, `malformed-${shape}`);

    expect(result).toMatchObject({
      cause: 'effect-command-mixer-state-invalid',
      reason: 'mixer-state-invalid',
      status: 'BLOCKED',
    });
    expect(result.history).toBe(history);
  });

  it.each([
    {
      cause: 'effect-command-parameter-unknown',
      command: {
        parameter: 'unknown',
        target: channelTarget('equalizer'),
        type: 'set-parameter',
        value: 1,
      },
    },
    {
      cause: 'effect-command-bypass-invalid',
      command: {
        bypass: 'false',
        target: channelTarget('equalizer'),
        type: 'set-bypass',
      },
    },
    {
      cause: 'effect-command-value-invalid',
      command: {
        parameter: 'lowGainDb',
        target: channelTarget('equalizer'),
        type: 'set-parameter',
        value: '3',
      },
    },
    {
      cause: 'effect-command-value-invalid',
      command: {
        parameter: 'lowGainDb',
        target: channelTarget('equalizer'),
        type: 'set-parameter',
        value: Number.NaN,
      },
    },
    {
      cause: 'effect-command-value-invalid',
      command: {
        parameter: 'releaseMs',
        target: masterTarget('limiter'),
        type: 'set-parameter',
        value: Number.POSITIVE_INFINITY,
      },
    },
    {
      cause: 'effect-command-value-invalid',
      command: {
        parameter: 'feedback',
        target: channelTarget('echo-delay'),
        type: 'set-parameter',
        value: 0.950_001,
      },
    },
    {
      cause: 'effect-command-value-invalid',
      command: {
        parameter: 'midFrequencyHz',
        target: channelTarget('equalizer'),
        type: 'set-parameter',
        value: 120,
      },
    },
    {
      cause: 'effect-command-shape-invalid',
      command: {
        bypass: false,
        runtimeMeter: { leftPeak: 1 },
        target: channelTarget('equalizer'),
        type: 'set-bypass',
      },
    },
  ])('rejects invalid value/shape without clamp or partial history: $cause', ({ cause, command }) => {
    const history = createHistory();
    const baseline = JSON.stringify(history.present.value.project);
    const result = execute(
      history,
      command as unknown as ProjectMixerEffectCommand,
      `invalid-${cause}`,
    );

    expect(result).toMatchObject({ cause, status: 'BLOCKED' });
    expect(result.history).toBe(history);
    expect(result.workspace).toBe(history.present.value);
    expect(JSON.stringify(result.workspace.project)).toBe(baseline);
  });

  it.each([
    {
      command: {
        bypass: true,
        target: channelTarget('equalizer'),
        type: 'set-bypass',
      },
      label: 'existing bypass',
    },
    {
      command: {
        parameter: 'lowGainDb',
        target: channelTarget('equalizer'),
        type: 'set-parameter',
        value: 0,
      },
      label: 'existing parameter',
    },
    {
      command: {
        target: masterTarget('limiter'),
        type: 'reset',
      },
      label: 'already-default reset',
    },
  ])('preserves identity, history, and dirty state for no-op $label', ({ command, label }) => {
    const history = createHistory();
    const project = history.present.value.project;
    const fingerprint = createProjectDirtyStateFingerprint(project);
    const result = execute(
      history,
      command as ProjectMixerEffectCommand,
      `no-op-${label}`,
    );

    expect(result.status).toBe('NO_OP');
    expect(result.history).toBe(history);
    expect(result.workspace).toBe(history.present.value);
    expect(result.workspace.project).toBe(project);
    expect(createProjectDirtyStateFingerprint(result.workspace.project)).toBe(fingerprint);
  });

  it('creates exactly one Undo step and round-trips exact Undo/Redo dirty state', () => {
    const history = createHistory();
    const originalWorkspace = history.present.value;
    const baseline = createProjectDirtyStateFingerprint(originalWorkspace.project);
    const executed = requireExecuted(execute(history, {
      parameter: 'ratio',
      target: masterTarget('compressor'),
      type: 'set-parameter',
      value: 10,
    }));
    const editedFingerprint = createProjectDirtyStateFingerprint(executed.workspace.project);

    expect(executed.history.past).toHaveLength(1);
    expect(editedFingerprint).not.toBe(baseline);
    expect(hasProjectDirtyStateDrift(baseline, executed.workspace.project)).toBe(true);

    const undone = undoSessionEdit(executed.history);
    expect(undone.status).toBe('MOVED');
    expect(undone.history.present.value).toBe(originalWorkspace);
    expect(createProjectDirtyStateFingerprint(undone.history.present.value.project)).toBe(baseline);

    const redone = redoSessionEdit(undone.history, HISTORY_LIMIT);
    expect(redone.status).toBe('MOVED');
    expect(redone.history.present.value).toBe(executed.workspace);
    expect(createProjectDirtyStateFingerprint(redone.history.present.value.project)).toBe(
      editedFingerprint,
    );
  });

  it('serializes, reopens, and establishes an exact clean saved baseline', () => {
    const executed = requireExecuted(execute(createHistory(), {
      parameter: 'delayTimeMs',
      target: channelTarget('echo-delay'),
      type: 'set-parameter',
      value: 1_250,
    }));
    const savedFingerprint = createProjectDirtyStateFingerprint(executed.workspace.project);
    const serialized = JSON.stringify(executed.workspace.project);
    const reopened = JSON.parse(serialized) as ProjectState;
    const normalization = normalizeProjectMixerState(reopened.tracks, reopened.mixer);
    const normalizedReopen: ProjectState = {
      ...reopened,
      mixer: normalization.mixer,
      tracks: normalization.tracks,
    };

    expect(normalization.metadata).toEqual({ migrated: false, source: 'mixer-state-v2' });
    expect(normalizedReopen.mixer).toEqual(executed.workspace.project.mixer);
    expect(createProjectDirtyStateFingerprint(normalizedReopen)).toBe(savedFingerprint);
    expect(hasProjectDirtyStateDrift(savedFingerprint, normalizedReopen)).toBe(false);
    expect(serialized).not.toMatch(/processorState|runtimeMeter|meterSnapshot|messagePort|ringBuffer/);
  });

  it('preserves unrelated identities and never retains caller-owned target aliases', () => {
    const history = createHistory();
    const project = history.present.value.project;
    const mixer = project.mixer!;
    const channel = mixer.channels[0];
    const compressor = channel.inserts[1];
    const delay = channel.inserts[2];
    const master = mixer.master;
    const mutableTarget = { ...channelTarget('equalizer') };
    const result = requireExecuted(execute(history, {
      parameter: 'lowGainDb',
      target: mutableTarget,
      type: 'set-parameter',
      value: 6,
    }));

    mutableTarget.trackId = 'mutated-after-command';
    (mutableTarget as { algorithmId: string }).algorithmId = 'mutated-after-command';

    const nextMixer = result.workspace.project.mixer!;
    expect(nextMixer.channels[0].trackId).toBe(TRACK_ID);
    expect(nextMixer.channels[0].inserts[1]).toBe(compressor);
    expect(nextMixer.channels[0].inserts[2]).toBe(delay);
    expect(nextMixer.master).toBe(master);
    expect(Object.isFrozen(nextMixer.channels[0].inserts[0].parameters)).toBe(true);
    expect(nextMixer.channels[0].inserts[0].parameters.lowGainDb).toBe(6);
  });

  it('keeps an active Playback Snapshot frozen and adopts edits only in the next plan', () => {
    const project = createProject(false, true);
    const history = createHistoryFromProject(project);
    const activePlan = requirePlaybackPlan(createProjectPlaybackPlan(playbackInput(project)));
    const result = requireExecuted(execute(history, {
      bypass: false,
      target: channelTarget('equalizer'),
      type: 'set-bypass',
    }));
    const nextPlan = requirePlaybackPlan(
      createProjectPlaybackPlan(playbackInput(result.workspace.project)),
    );
    const activeEffect = activePlan.mixerSnapshot.channels[0]?.inserts[0];
    const nextEffect = nextPlan.mixerSnapshot.channels[0]?.inserts[0];

    if (!activeEffect || !nextEffect) {
      throw new Error('Expected Playback Equalizer snapshots.');
    }

    expect(activeEffect.bypass).toBe(true);
    expect(nextEffect.bypass).toBe(false);
    expect(activeEffect.bypass).toBe(true);
    expect(Object.isFrozen(activePlan.mixerSnapshot)).toBe(true);
    expect(Object.isFrozen(activeEffect.parameters)).toBe(true);
  });

  it('changes canonical Mixdown Plan identity only for accepted state changes', () => {
    const project = createProject(false, true);
    const history = createHistoryFromProject(project);
    const baseIdentity = mixdownIdentity(project);
    const executed = requireExecuted(execute(history, {
      parameter: 'ceilingDb',
      target: masterTarget('limiter'),
      type: 'set-parameter',
      value: -6,
    }));
    const editedIdentity = mixdownIdentity(executed.workspace.project);
    const noOp = execute(executed.history, {
      parameter: 'ceilingDb',
      target: masterTarget('limiter'),
      type: 'set-parameter',
      value: -6,
    }, 'identity-no-op');
    const rejected = execute(executed.history, {
      parameter: 'ceilingDb',
      target: masterTarget('limiter'),
      type: 'set-parameter',
      value: -12.001,
    }, 'identity-rejected');

    expect(editedIdentity).not.toBe(baseIdentity);
    expect(noOp.status).toBe('NO_OP');
    expect(rejected.status).toBe('BLOCKED');
    expect(mixdownIdentity(noOp.workspace.project)).toBe(editedIdentity);
    expect(mixdownIdentity(rejected.workspace.project)).toBe(editedIdentity);
    expect(noOp.history).toBe(executed.history);
    expect(rejected.history).toBe(executed.history);
  });

  it('keeps runtime meter/worklet state outside Project, history, and canonical identity', () => {
    const executed = requireExecuted(execute(createHistoryFromProject(createProject(false, true)), {
      bypass: false,
      target: masterTarget('limiter'),
      type: 'set-bypass',
    }));
    const serializedHistory = JSON.stringify(executed.history);
    const canonicalPlan = mixdownIdentity(executed.workspace.project);

    expect(serializedHistory).not.toMatch(
      /processorState|runtimeMeter|meterSnapshot|messagePort|ringBuffer|AudioWorklet/,
    );
    expect(canonicalPlan).not.toMatch(
      /processorState|runtimeMeter|meterSnapshot|messagePort|ringBuffer|AudioWorklet/,
    );
  });

  it('does not use commands as a migration or malformed-state repair path', () => {
    const noMixerProject = { ...createProject(), mixer: undefined };
    const v1Project = {
      ...createProject(),
      mixer: createMixerV1(TRACK_ID),
    } as unknown as ProjectState;

    for (const [label, project] of [
      ['no-mixer', noMixerProject],
      ['v1', v1Project],
    ] as const) {
      const history = createHistoryFromProject(project);
      const result = execute(history, {
        bypass: false,
        target: channelTarget('equalizer'),
        type: 'set-bypass',
      }, `legacy-${label}`);

      expect(result).toMatchObject({
        cause: 'effect-command-mixer-state-invalid',
        status: 'BLOCKED',
      });
      expect(result.history).toBe(history);
      expect(result.workspace.project).toBe(project);
    }

    const migratedNoMixer = normalizeProjectMixerState(noMixerProject.tracks, undefined);
    const migratedV1 = normalizeProjectMixerState(v1Project.tracks, v1Project.mixer);
    expect(migratedNoMixer.metadata).toEqual({ migrated: true, source: 'legacy-no-mixer' });
    expect(migratedV1.metadata).toEqual({ migrated: true, source: 'mixer-state-v1' });
    expect(allEffects(migratedNoMixer.mixer).every((effect) => effect.bypass)).toBe(true);
    expect(allEffects(migratedV1.mixer).every((effect) => effect.bypass)).toBe(true);
  });

  it('preserves sample, preset, demo, and new Project bypass defaults', () => {
    const projects = [sampleProject, ...tabFlowPresets.map((preset) => preset.project)];

    for (const project of projects) {
      const normalization = normalizeProjectMixerState(project.tracks, project.mixer);
      expect(allEffects(normalization.mixer).every((effect) => effect.bypass)).toBe(true);
    }

    const created = normalizeProjectMixerState([audioTrack(TRACK_ID, [])], undefined);
    expect(created.metadata).toEqual({ migrated: true, source: 'legacy-no-mixer' });
    expect(allEffects(created.mixer).every((effect) => effect.bypass)).toBe(true);
  });

  it.each([
    {
      cause: 'effect-command-timestamp-invalid',
      request: { createdAt: 'invalid', editId: 'request-time', historyLimit: HISTORY_LIMIT },
    },
    {
      cause: 'effect-command-edit-id-invalid',
      request: { createdAt: CREATED_AT, editId: ' ', historyLimit: HISTORY_LIMIT },
    },
    {
      cause: 'effect-command-history-limit-invalid',
      request: { createdAt: CREATED_AT, editId: 'request-limit', historyLimit: 0 },
    },
  ])('rejects malformed command metadata: $cause', ({ cause, request }) => {
    const history = createHistory();
    const result = executeProjectMixerEffectCommand(
      history,
      { bypass: false, target: channelTarget('equalizer'), type: 'set-bypass' },
      request,
    );

    expect(result).toMatchObject({ cause, reason: 'command-invalid', status: 'BLOCKED' });
    expect(result.history).toBe(history);
  });

  it('rejects duplicate Edit identity without changing history', () => {
    const first = requireExecuted(execute(createHistory(), {
      bypass: false,
      target: channelTarget('equalizer'),
      type: 'set-bypass',
    }, 'duplicate-edit'));
    const result = executeProjectMixerEffectCommand(
      first.history,
      { bypass: false, target: masterTarget('limiter'), type: 'set-bypass' },
      { createdAt: CREATED_AT, editId: 'duplicate-edit', historyLimit: HISTORY_LIMIT },
    );

    expect(result).toMatchObject({
      cause: 'effect-command-edit-id-conflict',
      reason: 'command-invalid',
      status: 'BLOCKED',
    });
    expect(result.history).toBe(first.history);
  });
});

function execute(
  history: SessionEditHistory<TestWorkspace>,
  command: ProjectMixerEffectCommand,
  editId = 'effect-edit',
) {
  return executeProjectMixerEffectCommand(history, command, {
    createdAt: CREATED_AT,
    editId,
    historyLimit: HISTORY_LIMIT,
  });
}

function requireExecuted(
  result: ReturnType<typeof execute>,
): Extract<ReturnType<typeof execute>, { status: 'EXECUTED' }> {
  if (result.status !== 'EXECUTED') {
    throw new Error(`Expected executed command, received ${result.status}.`);
  }
  return result;
}

function createHistory(includeGroup = false): SessionEditHistory<TestWorkspace> {
  return createHistoryFromProject(createProject(includeGroup));
}

function createHistoryFromProject(project: ProjectState): SessionEditHistory<TestWorkspace> {
  return createSessionEditHistory(
    Object.freeze({ project, selectedToken: 'preserved-selection' }),
    Object.freeze({
      category: 'system' as const,
      createdAt: CREATED_AT,
      id: 'initial-project',
      label: 'Open Project',
    }),
  );
}

function createProject(includeGroup = false, withClip = false): ProjectState {
  const track = audioTrack(
    TRACK_ID,
    withClip
      ? [audioClip('command-clip', 0, TICKS_PER_BEAT * 2, generatedSource('command-source'))]
      : [],
  );
  const tracks: Track[] = includeGroup
    ? [
        {
          clips: [],
          group: {
            activePlaybackTrackId: TRACK_ID,
            childTrackIds: [TRACK_ID],
            collapsed: false,
            playbackMode: 'bottom_child',
          },
          id: GROUP_ID,
          level: 0,
          muted: false,
          name: 'Command Group',
          type: 'group',
        },
        { ...track, parentGroupId: GROUP_ID },
      ]
    : [track];

  return reconcileProjectMixerState({
    ...sampleProject,
    artifacts: [],
    connections: [],
    mixer: undefined,
    patchTabs: [],
    playheadTick: 0,
    selection: { items: [] },
    tabFlowLines: [],
    tabFlowStageResults: [],
    takes: [],
    totalTicks: PROJECT_END_TICK,
    tracks,
  });
}

function channelTarget(
  effectType: 'equalizer',
  trackId?: string,
): Extract<ProjectMixerEffectTarget, { effectType: 'equalizer'; scope: 'channel' }>;
function channelTarget(
  effectType: 'compressor',
  trackId?: string,
): Extract<ProjectMixerEffectTarget, { effectType: 'compressor'; scope: 'channel' }>;
function channelTarget(
  effectType: 'echo-delay',
  trackId?: string,
): Extract<ProjectMixerEffectTarget, { effectType: 'echo-delay'; scope: 'channel' }>;
function channelTarget(
  effectType: 'equalizer' | 'compressor' | 'echo-delay',
  trackId = TRACK_ID,
): ProjectMixerEffectTarget {
  const identity = effectIdentity(effectType);
  return Object.freeze({ ...identity, scope: 'channel' as const, trackId }) as ProjectMixerEffectTarget;
}

function masterTarget(
  effectType: 'equalizer',
): Extract<ProjectMixerEffectTarget, { effectType: 'equalizer'; scope: 'master' }>;
function masterTarget(
  effectType: 'compressor',
): Extract<ProjectMixerEffectTarget, { effectType: 'compressor'; scope: 'master' }>;
function masterTarget(
  effectType: 'limiter',
): Extract<ProjectMixerEffectTarget, { effectType: 'limiter'; scope: 'master' }>;
function masterTarget(
  effectType: 'equalizer' | 'compressor' | 'limiter',
): ProjectMixerEffectTarget {
  return Object.freeze({ ...effectIdentity(effectType), scope: 'master' as const }) as ProjectMixerEffectTarget;
}

function effectIdentity(effectType: MixerEffectState['effectType']) {
  switch (effectType) {
    case 'equalizer':
      return {
        algorithmId: MIXER_EQUALIZER_ALGORITHM_ID,
        algorithmVersion: MIXER_EQUALIZER_ALGORITHM_VERSION,
        effectType,
      } as const;
    case 'compressor':
      return {
        algorithmId: MIXER_COMPRESSOR_ALGORITHM_ID,
        algorithmVersion: MIXER_COMPRESSOR_ALGORITHM_VERSION,
        effectType,
      } as const;
    case 'echo-delay':
      return {
        algorithmId: MIXER_ECHO_DELAY_ALGORITHM_ID,
        algorithmVersion: MIXER_ECHO_DELAY_ALGORITHM_VERSION,
        effectType,
      } as const;
    case 'limiter':
      return {
        algorithmId: MIXER_LIMITER_ALGORITHM_ID,
        algorithmVersion: MIXER_LIMITER_ALGORITHM_VERSION,
        effectType,
      } as const;
  }
}

function getEffect(project: ProjectState, target: ProjectMixerEffectTarget): MixerEffectState {
  const inserts = target.scope === 'master'
    ? project.mixer!.master.inserts
    : project.mixer!.channels.find((channel) => channel.trackId === target.trackId)!.inserts;
  const index = target.effectType === 'equalizer'
    ? 0
    : target.effectType === 'compressor'
      ? 1
      : 2;
  const effect = inserts[index];
  if (!effect) {
    throw new Error('Expected Mixer Effect Insert.');
  }
  return effect;
}

function parameterBoundaryCases(
  target: ProjectMixerEffectTarget,
  specs: Readonly<Record<string, Readonly<{ minimum: number; maximum: number }>>>,
) {
  return Object.entries(specs).flatMap(([parameter, spec]) => [
    {
      boundary: 'minimum' as const,
      effectType: target.effectType,
      parameter,
      target,
      value: spec.minimum,
    },
    {
      boundary: 'maximum' as const,
      effectType: target.effectType,
      parameter,
      target,
      value: spec.maximum,
    },
  ]);
}

function allEffects(mixer: ProjectMixerStateV2): readonly MixerEffectState[] {
  return [
    ...mixer.channels.flatMap((channel) => channel.inserts),
    ...mixer.master.inserts,
  ];
}

function createMixerV1(trackId: string): ProjectMixerStateV1 {
  return {
    channels: [{
      faderDb: 0,
      inserts: [],
      muted: false,
      outputBusId: PROJECT_MIXER_MASTER_BUS_ID,
      pan: 0,
      solo: false,
      trackId,
    }],
    master: {
      busId: PROJECT_MIXER_MASTER_BUS_ID,
      faderDb: 0,
      inserts: [],
    },
    schemaVersion: 1,
  };
}

function playbackInput(project: ProjectState) {
  return {
    artifacts: project.artifacts,
    bpm: project.bpm,
    mixer: project.mixer,
    playheadTick: 0,
    projectEndTick: project.totalTicks,
    purpose: 'all-playback' as const,
    selection: project.selection,
    sourceAvailability: { 'command-source': 'openable' as const },
    tracks: project.tracks,
  };
}

function mixdownIdentity(project: ProjectState): string {
  const plan = requireMixdownPlan(createProjectMixdownPlan(mixdownInput(project)));
  const identity = createCanonicalProjectMixdownPlanJson(plan);
  if (!identity) {
    throw new Error('Expected canonical Mixdown Plan identity.');
  }
  return identity;
}

function mixdownInput(project: ProjectState): ProjectMixdownPlanInput {
  return {
    ...playbackInput(project),
    sourceDescriptors: [generatedDescriptor('command-source')],
  };
}

function requirePlaybackPlan(
  result: ProjectPlaybackPlanAvailability,
): ProjectPlaybackPlan {
  if (!result.canPlay) {
    throw new Error(result.message);
  }
  return result.plan;
}

function requireMixdownPlan(
  result: ProjectMixdownPlanAvailability,
): ProjectMixdownPlan {
  if (!result.canCreate) {
    throw new Error(result.message);
  }
  return result.plan;
}

function audioClip(
  id: string,
  startTick: number,
  lengthTicks: number,
  sourceFile: ClipSourceFile,
): Clip {
  const sourceDurationSeconds = (lengthTicks / TICKS_PER_BEAT) * (60 / BPM);
  return {
    audioTiming: {
      sourceEndSeconds: sourceDurationSeconds,
      sourceStartSeconds: 0,
      timeBase: 'absolute-seconds',
    },
    color: '#5e8fb8',
    createdAt: CREATED_AT,
    id,
    lengthTicks,
    name: id,
    sourceFile: { ...sourceFile, durationSeconds: sourceDurationSeconds },
    startTick,
    type: 'instrument-audio',
    version: 1,
  };
}

function audioTrack(id: string, clips: Clip[]): Track {
  return {
    clips,
    id,
    level: 0,
    muted: false,
    name: id,
    parentGroupId: null,
    type: 'audio',
  };
}

function generatedSource(sourceId: string): ClipSourceFile {
  return {
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: 48_044,
    sourceId,
    status: 'available',
  };
}

function generatedDescriptor(sourceId: string): LocalEngineSourceDescriptor {
  return {
    kind: 'generated',
    name: `${sourceId}.wav`,
    relativePath: `renders/instruments/${sourceId}.wav`,
    sizeBytes: 48_044,
    sourceId,
  };
}
