import {
  MIXER_COMPRESSOR_ALGORITHM_ID,
  MIXER_COMPRESSOR_ALGORITHM_VERSION,
  MIXER_EFFECT_TYPE_COMPRESSOR,
  MIXER_EFFECT_TYPE_ECHO_DELAY,
  MIXER_EFFECT_TYPE_EQUALIZER,
  MIXER_EFFECT_TYPE_LIMITER,
  MIXER_ECHO_DELAY_ALGORITHM_ID,
  MIXER_ECHO_DELAY_ALGORITHM_VERSION,
  MIXER_EQUALIZER_ALGORITHM_ID,
  MIXER_EQUALIZER_ALGORITHM_VERSION,
  MIXER_LIMITER_ALGORITHM_ID,
  MIXER_LIMITER_ALGORITHM_VERSION,
  createDefaultMixerCompressorEffect,
  createDefaultMixerEchoDelayEffect,
  createDefaultMixerEqualizerEffect,
  createDefaultMixerLimiterEffect,
  createMixerCompressorEffect,
  createMixerEchoDelayEffect,
  createMixerEqualizerEffect,
  createMixerLimiterEffect,
  type MixerCompressorEffect,
  type MixerCompressorParameterName,
  type MixerEchoDelayEffect,
  type MixerEchoDelayParameterName,
  type MixerEffectState,
  type MixerEqualizerEffect,
  type MixerEqualizerParameterName,
  type MixerLimiterEffect,
  type MixerLimiterParameterName,
} from '../shared/mixerEffectsContract.js';
import {
  isMixerEligibleTrack,
  normalizeProjectMixerState,
  PROJECT_MIXER_STATE_VERSION,
} from './projectMixerState';
import {
  commitSessionEdit,
  getSessionEditFrames,
  type SessionEditEntry,
  type SessionEditHistory,
} from './sessionEditHistory';
import type {
  MixerChannelInsertChainV2,
  MixerMasterInsertChainV2,
  ProjectMixerStateV2,
  ProjectState,
} from './types';

const MAX_EDIT_ID_LENGTH = 200;

type ChannelEffectTarget<Effect extends MixerEffectState> = Readonly<{
  algorithmId: Effect['algorithmId'];
  algorithmVersion: Effect['algorithmVersion'];
  effectType: Effect['effectType'];
  scope: 'channel';
  trackId: string;
}>;

type MasterEffectTarget<Effect extends MixerEffectState> = Readonly<{
  algorithmId: Effect['algorithmId'];
  algorithmVersion: Effect['algorithmVersion'];
  effectType: Effect['effectType'];
  scope: 'master';
}>;

export type ProjectMixerEqualizerTarget =
  | ChannelEffectTarget<MixerEqualizerEffect>
  | MasterEffectTarget<MixerEqualizerEffect>;

export type ProjectMixerCompressorTarget =
  | ChannelEffectTarget<MixerCompressorEffect>
  | MasterEffectTarget<MixerCompressorEffect>;

export type ProjectMixerEchoDelayTarget =
  ChannelEffectTarget<MixerEchoDelayEffect>;

export type ProjectMixerLimiterTarget = MasterEffectTarget<MixerLimiterEffect>;

export type ProjectMixerChannelEffectTarget =
  | ChannelEffectTarget<MixerEqualizerEffect>
  | ChannelEffectTarget<MixerCompressorEffect>
  | ChannelEffectTarget<MixerEchoDelayEffect>;

export type ProjectMixerMasterEffectTarget =
  | MasterEffectTarget<MixerEqualizerEffect>
  | MasterEffectTarget<MixerCompressorEffect>
  | MasterEffectTarget<MixerLimiterEffect>;

export type ProjectMixerEffectTarget =
  | ProjectMixerChannelEffectTarget
  | ProjectMixerMasterEffectTarget;

export type ProjectMixerEffectCommand =
  | Readonly<{
      bypass: boolean;
      target: ProjectMixerEffectTarget;
      type: 'set-bypass';
    }>
  | Readonly<{
      parameter: MixerEqualizerParameterName;
      target: ProjectMixerEqualizerTarget;
      type: 'set-parameter';
      value: number;
    }>
  | Readonly<{
      parameter: MixerCompressorParameterName;
      target: ProjectMixerCompressorTarget;
      type: 'set-parameter';
      value: number;
    }>
  | Readonly<{
      parameter: MixerEchoDelayParameterName;
      target: ProjectMixerEchoDelayTarget;
      type: 'set-parameter';
      value: number;
    }>
  | Readonly<{
      parameter: MixerLimiterParameterName;
      target: ProjectMixerLimiterTarget;
      type: 'set-parameter';
      value: number;
    }>
  | Readonly<{
      target: ProjectMixerEffectTarget;
      type: 'reset';
    }>;

export type ProjectMixerEffectWorkspace = Readonly<{
  project: ProjectState;
}>;

export type ProjectMixerEffectCommandRequest = Readonly<{
  createdAt: string;
  editId: string;
  historyLimit: number;
}>;

export type ProjectMixerEffectCommandBlockedReason =
  | 'command-invalid'
  | 'mixer-state-invalid'
  | 'target-invalid'
  | 'value-invalid';

export type ProjectMixerEffectCommandBlockedCause =
  | 'effect-command-edit-id-conflict'
  | 'effect-command-edit-id-invalid'
  | 'effect-command-history-limit-invalid'
  | 'effect-command-shape-invalid'
  | 'effect-command-timestamp-invalid'
  | 'effect-command-bypass-invalid'
  | 'effect-command-value-invalid'
  | 'effect-command-parameter-unknown'
  | 'effect-command-target-shape-invalid'
  | 'effect-command-target-identity-invalid'
  | 'effect-command-target-topology-invalid'
  | 'effect-command-track-missing'
  | 'effect-command-group-ineligible'
  | 'effect-command-channel-ambiguous'
  | 'effect-command-mixer-state-invalid';

export type ProjectMixerEffectCommandResult<
  Workspace extends ProjectMixerEffectWorkspace,
> =
  | Readonly<{
      changed: true;
      edit: SessionEditEntry;
      executed: true;
      history: SessionEditHistory<Workspace>;
      status: 'EXECUTED';
      workspace: Workspace;
    }>
  | Readonly<{
      changed: false;
      executed: false;
      history: SessionEditHistory<Workspace>;
      reason: 'unchanged';
      status: 'NO_OP';
      workspace: Workspace;
    }>
  | Readonly<{
      cause: ProjectMixerEffectCommandBlockedCause;
      changed: false;
      executed: false;
      history: SessionEditHistory<Workspace>;
      message: string;
      reason: ProjectMixerEffectCommandBlockedReason;
      status: 'BLOCKED';
      workspace: Workspace;
    }>;

type RuntimeTarget = Readonly<{
  algorithmId: string;
  algorithmVersion: number;
  effectType: string;
  scope: 'channel' | 'master';
  trackId?: string;
}>;

type ParsedCommand =
  | Readonly<{
      bypass: boolean;
      target: RuntimeTarget;
      type: 'set-bypass';
    }>
  | Readonly<{
      parameter: string;
      target: RuntimeTarget;
      type: 'set-parameter';
      value: number;
    }>
  | Readonly<{
      target: RuntimeTarget;
      type: 'reset';
    }>;

type CommandFailure = Readonly<{
  cause: ProjectMixerEffectCommandBlockedCause;
  message: string;
  reason: ProjectMixerEffectCommandBlockedReason;
}>;

type ResolvedEffect = Readonly<{
  channelIndex?: number;
  effect: MixerEffectState;
  insertIndex: number;
  scope: 'channel' | 'master';
}>;

type EffectMutation =
  | Readonly<{ effect: MixerEffectState; status: 'CHANGED' }>
  | Readonly<{ status: 'NO_OP' }>
  | Readonly<{ failure: CommandFailure; status: 'BLOCKED' }>;

export function executeProjectMixerEffectCommand<
  Workspace extends ProjectMixerEffectWorkspace,
>(
  history: SessionEditHistory<Workspace>,
  command: ProjectMixerEffectCommand,
  request: ProjectMixerEffectCommandRequest,
): ProjectMixerEffectCommandResult<Workspace> {
  const workspace = history.present.value;
  const requestFailure = validateRequest(history, request);

  if (requestFailure) {
    return blocked(history, workspace, requestFailure);
  }

  const parsed = parseCommand(command);

  if ('failure' in parsed) {
    return blocked(history, workspace, parsed.failure);
  }

  const mixerValidation = validateMixerStateV2(workspace.project);

  if ('failure' in mixerValidation) {
    return blocked(history, workspace, mixerValidation.failure);
  }

  const resolution = resolveEffectTarget(
    workspace.project,
    mixerValidation.mixer,
    parsed.command.target,
  );

  if ('failure' in resolution) {
    return blocked(history, workspace, resolution.failure);
  }

  const mutation = mutateEffect(resolution.resolved.effect, parsed.command);

  if (mutation.status === 'BLOCKED') {
    return blocked(history, workspace, mutation.failure);
  }

  if (mutation.status === 'NO_OP') {
    return Object.freeze({
      changed: false as const,
      executed: false as const,
      history,
      reason: 'unchanged' as const,
      status: 'NO_OP' as const,
      workspace,
    });
  }

  const project = replaceResolvedEffect(
    workspace.project,
    mixerValidation.mixer,
    resolution.resolved,
    mutation.effect,
  );
  const nextWorkspace = {
    ...workspace,
    project,
  } as Workspace;
  const edit = Object.freeze({
    category: 'project' as const,
    createdAt: request.createdAt,
    id: request.editId,
    label: createEditLabel(parsed.command),
  });
  const nextHistory = commitSessionEdit(
    history,
    nextWorkspace,
    edit,
    request.historyLimit,
  );

  return Object.freeze({
    changed: true as const,
    edit,
    executed: true as const,
    history: nextHistory,
    status: 'EXECUTED' as const,
    workspace: nextWorkspace,
  });
}

function validateRequest<Workspace extends ProjectMixerEffectWorkspace>(
  history: SessionEditHistory<Workspace>,
  request: ProjectMixerEffectCommandRequest,
): CommandFailure | undefined {
  if (
    typeof request.createdAt !== 'string' ||
    request.createdAt.trim() !== request.createdAt ||
    !request.createdAt ||
    !Number.isFinite(Date.parse(request.createdAt))
  ) {
    return commandFailure(
      'command-invalid',
      'effect-command-timestamp-invalid',
      'Mixer Effect command requires a valid timestamp.',
    );
  }

  if (
    typeof request.editId !== 'string' ||
    request.editId.trim() !== request.editId ||
    !request.editId ||
    request.editId.length > MAX_EDIT_ID_LENGTH
  ) {
    return commandFailure(
      'command-invalid',
      'effect-command-edit-id-invalid',
      'Mixer Effect command requires one valid Edit identity.',
    );
  }

  if (
    getSessionEditFrames(history).some(
      (frame) => frame.edit.id === request.editId,
    )
  ) {
    return commandFailure(
      'command-invalid',
      'effect-command-edit-id-conflict',
      'Mixer Effect Edit identity already exists.',
    );
  }

  if (!Number.isSafeInteger(request.historyLimit) || request.historyLimit < 1) {
    return commandFailure(
      'command-invalid',
      'effect-command-history-limit-invalid',
      'Mixer Effect command requires a positive Edit History limit.',
    );
  }

  return undefined;
}

function parseCommand(
  value: ProjectMixerEffectCommand,
): Readonly<{ command: ParsedCommand }> | Readonly<{ failure: CommandFailure }> {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return parseFailure('effect-command-shape-invalid');
  }

  const target = parseTarget(value.target);

  if ('failure' in target) {
    return target;
  }

  if (value.type === 'set-bypass') {
    if (!hasExactKeys(value, ['type', 'target', 'bypass'])) {
      return parseFailure('effect-command-shape-invalid');
    }
    if (typeof value.bypass !== 'boolean') {
      return {
        failure: commandFailure(
          'value-invalid',
          'effect-command-bypass-invalid',
          'Mixer Effect bypass must be a boolean.',
        ),
      };
    }
    return {
      command: Object.freeze({
        bypass: value.bypass,
        target: target.target,
        type: 'set-bypass' as const,
      }),
    };
  }

  if (value.type === 'set-parameter') {
    if (!hasExactKeys(value, ['type', 'target', 'parameter', 'value'])) {
      return parseFailure('effect-command-shape-invalid');
    }
    if (typeof value.parameter !== 'string' || !value.parameter) {
      return {
        failure: commandFailure(
          'value-invalid',
          'effect-command-parameter-unknown',
          'Mixer Effect parameter name is unsupported.',
        ),
      };
    }
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
      return {
        failure: commandFailure(
          'value-invalid',
          'effect-command-value-invalid',
          'Mixer Effect parameter value must be finite.',
        ),
      };
    }
    return {
      command: Object.freeze({
        parameter: value.parameter,
        target: target.target,
        type: 'set-parameter' as const,
        value: value.value,
      }),
    };
  }

  if (value.type === 'reset') {
    return hasExactKeys(value, ['type', 'target'])
      ? {
          command: Object.freeze({
            target: target.target,
            type: 'reset' as const,
          }),
        }
      : parseFailure('effect-command-shape-invalid');
  }

  return parseFailure('effect-command-shape-invalid');
}

function parseTarget(
  value: unknown,
): Readonly<{ target: RuntimeTarget }> | Readonly<{ failure: CommandFailure }> {
  if (!isRecord(value) || (value.scope !== 'channel' && value.scope !== 'master')) {
    return parseFailure('effect-command-target-shape-invalid', 'target-invalid');
  }

  const keys = value.scope === 'channel'
    ? ['scope', 'trackId', 'effectType', 'algorithmId', 'algorithmVersion']
    : ['scope', 'effectType', 'algorithmId', 'algorithmVersion'];

  if (
    !hasExactKeys(value, keys) ||
    typeof value.effectType !== 'string' ||
    typeof value.algorithmId !== 'string' ||
    !Number.isSafeInteger(value.algorithmVersion) ||
    (value.scope === 'channel' &&
      (typeof value.trackId !== 'string' ||
        !value.trackId ||
        value.trackId.trim() !== value.trackId))
  ) {
    return parseFailure('effect-command-target-shape-invalid', 'target-invalid');
  }

  return {
    target: Object.freeze({
      algorithmId: value.algorithmId,
      algorithmVersion: value.algorithmVersion as number,
      effectType: value.effectType,
      scope: value.scope,
      ...(value.scope === 'channel' ? { trackId: value.trackId as string } : {}),
    }),
  };
}

function validateMixerStateV2(
  project: ProjectState,
): Readonly<{ mixer: ProjectMixerStateV2 }> | Readonly<{ failure: CommandFailure }> {
  if (
    project.mixer === undefined ||
    (project.mixer as { schemaVersion?: unknown }).schemaVersion !==
      PROJECT_MIXER_STATE_VERSION
  ) {
    return { failure: mixerStateFailure() };
  }

  try {
    const normalization = normalizeProjectMixerState(project.tracks, project.mixer);

    if (normalization.metadata.migrated) {
      return { failure: mixerStateFailure() };
    }
  } catch {
    return { failure: mixerStateFailure() };
  }

  return { mixer: project.mixer };
}

function resolveEffectTarget(
  project: ProjectState,
  mixer: ProjectMixerStateV2,
  target: RuntimeTarget,
): Readonly<{ resolved: ResolvedEffect }> | Readonly<{ failure: CommandFailure }> {
  const insertIndex = getInsertIndex(target.scope, target.effectType);

  if (insertIndex === undefined) {
    return {
      failure: commandFailure(
        'target-invalid',
        'effect-command-target-topology-invalid',
        'Mixer Effect target is not valid for this fixed Insert chain.',
      ),
    };
  }

  if (!hasExactEffectIdentity(target)) {
    return {
      failure: commandFailure(
        'target-invalid',
        'effect-command-target-identity-invalid',
        'Mixer Effect target identity or version is unsupported.',
      ),
    };
  }

  if (target.scope === 'master') {
    const effect = mixer.master.inserts[insertIndex];
    return hasMatchingEffectIdentity(effect, target)
      ? { resolved: Object.freeze({ effect, insertIndex, scope: 'master' as const }) }
      : { failure: mixerStateFailure() };
  }

  const track = project.tracks.find((candidate) => candidate.id === target.trackId);

  if (!track) {
    return {
      failure: commandFailure(
        'target-invalid',
        'effect-command-track-missing',
        'Mixer Effect target Track is missing or stale.',
      ),
    };
  }

  if (!isMixerEligibleTrack(track)) {
    return {
      failure: commandFailure(
        'target-invalid',
        'effect-command-group-ineligible',
        'Group Tracks do not own Mixer Effect Inserts.',
      ),
    };
  }

  const channelIndexes = mixer.channels.flatMap((channel, index) =>
    channel.trackId === target.trackId ? [index] : [],
  );

  if (channelIndexes.length !== 1) {
    return {
      failure: commandFailure(
        'target-invalid',
        'effect-command-channel-ambiguous',
        'Mixer Effect target Channel is missing or ambiguous.',
      ),
    };
  }

  const channelIndex = channelIndexes[0];
  const effect = mixer.channels[channelIndex].inserts[insertIndex];

  return hasMatchingEffectIdentity(effect, target)
    ? {
        resolved: Object.freeze({
          channelIndex,
          effect,
          insertIndex,
          scope: 'channel' as const,
        }),
      }
    : { failure: mixerStateFailure() };
}

function mutateEffect(
  effect: MixerEffectState,
  command: ParsedCommand,
): EffectMutation {
  if (command.type === 'set-bypass') {
    if (effect.bypass === command.bypass) {
      return Object.freeze({ status: 'NO_OP' as const });
    }

    return Object.freeze({
      effect: createEffect(effect, effect.parameters, command.bypass),
      status: 'CHANGED' as const,
    });
  }

  if (command.type === 'reset') {
    const defaultEffect = createDefaultEffect(effect.effectType);
    return areEffectsEqual(effect, defaultEffect)
      ? Object.freeze({ status: 'NO_OP' as const })
      : Object.freeze({ effect: defaultEffect, status: 'CHANGED' as const });
  }

  if (!hasOwn(effect.parameters, command.parameter)) {
    return Object.freeze({
      failure: commandFailure(
        'value-invalid',
        'effect-command-parameter-unknown',
        'Mixer Effect parameter name is unsupported for the target Insert.',
      ),
      status: 'BLOCKED' as const,
    });
  }

  const currentValue = effect.parameters[
    command.parameter as keyof typeof effect.parameters
  ];

  if (currentValue === command.value) {
    return Object.freeze({ status: 'NO_OP' as const });
  }

  try {
    const parameters = { ...effect.parameters, [command.parameter]: command.value };
    return Object.freeze({
      effect: createEffect(effect, parameters, effect.bypass),
      status: 'CHANGED' as const,
    });
  } catch {
    return Object.freeze({
      failure: commandFailure(
        'value-invalid',
        'effect-command-value-invalid',
        'Mixer Effect parameter value violates the committed Effects Contract.',
      ),
      status: 'BLOCKED' as const,
    });
  }
}

function createEffect(
  effect: MixerEffectState,
  parameters: object,
  bypass: boolean,
): MixerEffectState {
  switch (effect.effectType) {
    case MIXER_EFFECT_TYPE_EQUALIZER:
      return createMixerEqualizerEffect(
        parameters as MixerEqualizerEffect['parameters'],
        bypass,
      );
    case MIXER_EFFECT_TYPE_COMPRESSOR:
      return createMixerCompressorEffect(
        parameters as MixerCompressorEffect['parameters'],
        bypass,
      );
    case MIXER_EFFECT_TYPE_ECHO_DELAY:
      return createMixerEchoDelayEffect(
        parameters as MixerEchoDelayEffect['parameters'],
        bypass,
      );
    case MIXER_EFFECT_TYPE_LIMITER:
      return createMixerLimiterEffect(
        parameters as MixerLimiterEffect['parameters'],
        bypass,
      );
  }
}

function createDefaultEffect(effectType: MixerEffectState['effectType']): MixerEffectState {
  switch (effectType) {
    case MIXER_EFFECT_TYPE_EQUALIZER:
      return createDefaultMixerEqualizerEffect();
    case MIXER_EFFECT_TYPE_COMPRESSOR:
      return createDefaultMixerCompressorEffect();
    case MIXER_EFFECT_TYPE_ECHO_DELAY:
      return createDefaultMixerEchoDelayEffect();
    case MIXER_EFFECT_TYPE_LIMITER:
      return createDefaultMixerLimiterEffect();
  }
}

function replaceResolvedEffect(
  project: ProjectState,
  mixer: ProjectMixerStateV2,
  resolved: ResolvedEffect,
  effect: MixerEffectState,
): ProjectState {
  if (resolved.scope === 'master') {
    const inserts = replaceMasterInsert(
      mixer.master.inserts,
      resolved.insertIndex,
      effect,
    );
    return {
      ...project,
      mixer: Object.freeze({
        ...mixer,
        master: Object.freeze({ ...mixer.master, inserts }),
      }),
    };
  }

  const channelIndex = resolved.channelIndex!;
  const channel = mixer.channels[channelIndex];
  const inserts = replaceChannelInsert(channel.inserts, resolved.insertIndex, effect);
  const nextChannel = Object.freeze({ ...channel, inserts });
  const channels = Object.freeze(
    mixer.channels.map((candidate, index) =>
      index === channelIndex ? nextChannel : candidate,
    ),
  );

  return {
    ...project,
    mixer: Object.freeze({ ...mixer, channels }),
  };
}

function replaceChannelInsert(
  inserts: MixerChannelInsertChainV2,
  index: number,
  effect: MixerEffectState,
): MixerChannelInsertChainV2 {
  if (index === 0 && effect.effectType === MIXER_EFFECT_TYPE_EQUALIZER) {
    return Object.freeze([effect, inserts[1], inserts[2]]);
  }
  if (index === 1 && effect.effectType === MIXER_EFFECT_TYPE_COMPRESSOR) {
    return Object.freeze([inserts[0], effect, inserts[2]]);
  }
  if (index === 2 && effect.effectType === MIXER_EFFECT_TYPE_ECHO_DELAY) {
    return Object.freeze([inserts[0], inserts[1], effect]);
  }

  throw new TypeError('Mixer Channel Insert replacement violates fixed topology.');
}

function replaceMasterInsert(
  inserts: MixerMasterInsertChainV2,
  index: number,
  effect: MixerEffectState,
): MixerMasterInsertChainV2 {
  if (index === 0 && effect.effectType === MIXER_EFFECT_TYPE_EQUALIZER) {
    return Object.freeze([effect, inserts[1], inserts[2]]);
  }
  if (index === 1 && effect.effectType === MIXER_EFFECT_TYPE_COMPRESSOR) {
    return Object.freeze([inserts[0], effect, inserts[2]]);
  }
  if (index === 2 && effect.effectType === MIXER_EFFECT_TYPE_LIMITER) {
    return Object.freeze([inserts[0], inserts[1], effect]);
  }

  throw new TypeError('Mixer Master Insert replacement violates fixed topology.');
}

function getInsertIndex(
  scope: RuntimeTarget['scope'],
  effectType: string,
): number | undefined {
  if (effectType === MIXER_EFFECT_TYPE_EQUALIZER) {
    return 0;
  }
  if (effectType === MIXER_EFFECT_TYPE_COMPRESSOR) {
    return 1;
  }
  if (scope === 'channel' && effectType === MIXER_EFFECT_TYPE_ECHO_DELAY) {
    return 2;
  }
  if (scope === 'master' && effectType === MIXER_EFFECT_TYPE_LIMITER) {
    return 2;
  }
  return undefined;
}

function hasExactEffectIdentity(target: RuntimeTarget): boolean {
  return (
    (target.effectType === MIXER_EFFECT_TYPE_EQUALIZER &&
      target.algorithmId === MIXER_EQUALIZER_ALGORITHM_ID &&
      target.algorithmVersion === MIXER_EQUALIZER_ALGORITHM_VERSION) ||
    (target.effectType === MIXER_EFFECT_TYPE_COMPRESSOR &&
      target.algorithmId === MIXER_COMPRESSOR_ALGORITHM_ID &&
      target.algorithmVersion === MIXER_COMPRESSOR_ALGORITHM_VERSION) ||
    (target.effectType === MIXER_EFFECT_TYPE_ECHO_DELAY &&
      target.algorithmId === MIXER_ECHO_DELAY_ALGORITHM_ID &&
      target.algorithmVersion === MIXER_ECHO_DELAY_ALGORITHM_VERSION) ||
    (target.effectType === MIXER_EFFECT_TYPE_LIMITER &&
      target.algorithmId === MIXER_LIMITER_ALGORITHM_ID &&
      target.algorithmVersion === MIXER_LIMITER_ALGORITHM_VERSION)
  );
}

function hasMatchingEffectIdentity(
  effect: MixerEffectState,
  target: RuntimeTarget,
): boolean {
  return (
    effect.effectType === target.effectType &&
    effect.algorithmId === target.algorithmId &&
    effect.algorithmVersion === target.algorithmVersion
  );
}

function areEffectsEqual(left: MixerEffectState, right: MixerEffectState): boolean {
  if (
    left.effectType !== right.effectType ||
    left.algorithmId !== right.algorithmId ||
    left.algorithmVersion !== right.algorithmVersion ||
    left.bypass !== right.bypass
  ) {
    return false;
  }

  const leftParameters = left.parameters as unknown as Record<string, number>;
  const rightParameters = right.parameters as unknown as Record<string, number>;
  const keys = Object.keys(leftParameters);
  return (
    keys.length === Object.keys(rightParameters).length &&
    keys.every((key) => leftParameters[key] === rightParameters[key])
  );
}

function createEditLabel(command: ParsedCommand): string {
  const target = command.target.scope === 'master'
    ? 'Master'
    : `Channel ${command.target.trackId}`;
  const effect = formatEffectType(command.target.effectType);

  if (command.type === 'set-bypass') {
    return `${command.bypass ? 'Bypass' : 'Enable'} ${target} ${effect}`;
  }
  if (command.type === 'set-parameter') {
    return `Set ${target} ${effect} ${command.parameter}`;
  }
  return `Reset ${target} ${effect}`;
}

function formatEffectType(effectType: string): string {
  switch (effectType) {
    case MIXER_EFFECT_TYPE_EQUALIZER:
      return 'Equalizer';
    case MIXER_EFFECT_TYPE_COMPRESSOR:
      return 'Compressor';
    case MIXER_EFFECT_TYPE_ECHO_DELAY:
      return 'Echo/Delay';
    case MIXER_EFFECT_TYPE_LIMITER:
      return 'Limiter';
    default:
      return effectType;
  }
}

function parseFailure(
  cause: ProjectMixerEffectCommandBlockedCause,
  reason: ProjectMixerEffectCommandBlockedReason = 'command-invalid',
): Readonly<{ failure: CommandFailure }> {
  return {
    failure: commandFailure(
      reason,
      cause,
      reason === 'target-invalid'
        ? 'Mixer Effect target is malformed.'
        : 'Mixer Effect command shape is malformed.',
    ),
  };
}

function mixerStateFailure(): CommandFailure {
  return commandFailure(
    'mixer-state-invalid',
    'effect-command-mixer-state-invalid',
    'Mixer Effect command requires one exact normalized Mixer State v2.',
  );
}

function commandFailure(
  reason: ProjectMixerEffectCommandBlockedReason,
  cause: ProjectMixerEffectCommandBlockedCause,
  message: string,
): CommandFailure {
  return Object.freeze({ cause, message, reason });
}

function blocked<Workspace extends ProjectMixerEffectWorkspace>(
  history: SessionEditHistory<Workspace>,
  workspace: Workspace,
  failure: CommandFailure,
): Extract<ProjectMixerEffectCommandResult<Workspace>, { status: 'BLOCKED' }> {
  return Object.freeze({
    cause: failure.cause,
    changed: false as const,
    executed: false as const,
    history,
    message: failure.message,
    reason: failure.reason,
    status: 'BLOCKED' as const,
    workspace,
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  const expectedKeys = new Set(keys);
  return actualKeys.length === keys.length && actualKeys.every((key) => expectedKeys.has(key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
