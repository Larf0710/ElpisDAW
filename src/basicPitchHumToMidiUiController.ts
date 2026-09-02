import {
  createBasicPitchHumToMidiGenerationPlan,
  createBasicPitchHumToMidiPlanKey,
  createCompletedBasicPitchHumToMidiRegistration,
  type BasicPitchHumToMidiGenerationPlan,
} from './humToMidiGeneration';
import {
  runLocalEngineBasicPitchHumToMidiGeneration,
  type LocalEngineBasicPitchHumToMidiClient,
  type LocalEngineBasicPitchHumToMidiProgress,
} from './localEngineHumToMidiGeneration';
import type { LocalEngineGpuJobRecord, LocalEngineGpuJobState } from './localEngineJobs';
import type {
  Clip,
  MidiArtifact,
  MidiClipTake,
  PatchTab,
  ProjectState,
  SoundFontAssignment,
} from './types';

export type BasicPitchHumToMidiUiStatus =
  | 'CANCELED'
  | 'ENQUEUEING'
  | 'ERROR'
  | 'IDLE'
  | 'PREPARING'
  | 'REGISTERED'
  | 'REGISTRATION_PENDING'
  | 'RETRYING'
  | LocalEngineGpuJobState;

export type BasicPitchHumToMidiUiState = Readonly<{
  jobId?: string;
  message?: string;
  patchTabId?: string;
  planKey?: string;
  retryable?: boolean;
  sourceClipId?: string;
  status: BasicPitchHumToMidiUiStatus;
}>;

export type BasicPitchHumToMidiUiPresentation = Readonly<{
  ariaBusy: boolean;
  buttonLabel: 'CANCEL' | 'CONVERT' | 'RECOVER' | 'RETRY' | 'WAIT';
  canAct: boolean;
  detail: string;
  disableParameters: boolean;
  eyebrow: string;
  title: string;
}>;

export type BasicPitchRuntimeUiState =
  | Readonly<{ status: 'CHECKING' }>
  | Readonly<{ status: 'READY' }>
  | Readonly<{ message: string; status: 'UNAVAILABLE' }>;

export type BasicPitchHumToMidiUiRequest = Readonly<{
  client?: LocalEngineBasicPitchHumToMidiClient;
  getProject: () => ProjectState;
  onState?: (state: BasicPitchHumToMidiUiState) => void;
  patchTabId: string;
  resolveDefaultSoundFontAssignment?: () => SoundFontAssignment | undefined;
}>;

export type BasicPitchHumToMidiUiResult =
  | Readonly<{
      kind:
        | 'blocked'
        | 'busy'
        | 'canceled'
        | 'failed'
        | 'recovery-required'
        | 'registration-pending'
        | 'retry-required';
      state: BasicPitchHumToMidiUiState;
    }>
  | Readonly<{
      artifact: MidiArtifact;
      baseProject: ProjectState;
      clipTake: MidiClipTake;
      jobId: string;
      kind: 'registered';
      project: ProjectState;
      sourceClipName: string;
      state: BasicPitchHumToMidiUiState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
      targetClip: Clip;
      targetCreated: boolean;
    }>;

type PendingBasicPitchHumToMidi = {
  completedJob?: LocalEngineGpuJobRecord;
  failedJob?: LocalEngineGpuJobRecord;
  plan: BasicPitchHumToMidiGenerationPlan;
  planKey: string;
};

type BasicPitchHumToMidiUiControllerOptions = Readonly<{
  clock?: () => Date;
  runGeneration?: typeof runLocalEngineBasicPitchHumToMidiGeneration;
}>;

const activeStatuses = new Set<BasicPitchHumToMidiUiStatus>([
  'ENQUEUEING',
  'LOADING_MODEL',
  'PREPARING',
  'PROCESSING',
  'QUEUED',
  'RETRYING',
  'SAVING',
  'CANCEL_REQUESTED',
]);

export class BasicPitchHumToMidiUiController {
  readonly #clock: () => Date;
  readonly #runGeneration: typeof runLocalEngineBasicPitchHumToMidiGeneration;
  #abortController?: AbortController;
  #isExecuting = false;
  #onState?: (state: BasicPitchHumToMidiUiState) => void;
  #pending?: PendingBasicPitchHumToMidi;
  #state: BasicPitchHumToMidiUiState = createInitialBasicPitchHumToMidiUiState();

  constructor(options: BasicPitchHumToMidiUiControllerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#runGeneration =
      options.runGeneration ?? runLocalEngineBasicPitchHumToMidiGeneration;
  }

  get isExecuting(): boolean {
    return this.#isExecuting;
  }

  get state(): BasicPitchHumToMidiUiState {
    return this.#state;
  }

  hasOwnedOperation(patchTabId: string): boolean {
    return Boolean(
      this.#pending?.plan.converterPatchTabId === patchTabId ||
        (this.#isExecuting && this.#state.patchTabId === patchTabId),
    );
  }

  async run(
    request: BasicPitchHumToMidiUiRequest,
  ): Promise<BasicPitchHumToMidiUiResult> {
    if (this.#isExecuting) {
      return uiResult({ kind: 'busy', state: this.#state });
    }

    if (this.#pending?.completedJob) {
      return uiResult({ kind: 'recovery-required', state: this.#state });
    }

    this.#onState = request.onState;
    this.#emit({
      message: 'Preparing one exact Local Basic Pitch request.',
      patchTabId: request.patchTabId,
      status: 'PREPARING',
    });

    const planning = createBasicPitchHumToMidiGenerationPlan(
      request.getProject(),
      { converterPatchTabId: request.patchTabId },
    );

    if (!planning.canPlan) {
      return this.#terminalFailure(request.patchTabId, planning.message, 'blocked');
    }

    const planKey = createBasicPitchHumToMidiPlanKey(planning.plan);

    if (this.#pending?.planKey === planKey) {
      if (this.#pending.completedJob) {
        return uiResult({ kind: 'recovery-required', state: this.#state });
      }

      if (this.#pending.failedJob) {
        return uiResult({ kind: 'retry-required', state: this.#state });
      }
    }

    if (!request.client) {
      return this.#terminalFailure(
        request.patchTabId,
        'Hum to MIDI requires the ready Local Engine.',
        'blocked',
      );
    }

    this.#pending = { plan: planning.plan, planKey };
    return this.#execute(request, request.client);
  }

  async retry(
    request: BasicPitchHumToMidiUiRequest,
  ): Promise<BasicPitchHumToMidiUiResult> {
    if (this.#isExecuting) {
      return uiResult({ kind: 'busy', state: this.#state });
    }

    const pending = this.#pending;

    if (
      !pending?.failedJob ||
      pending.failedJob.state !== 'FAILED' ||
      pending.plan.converterPatchTabId !== request.patchTabId
    ) {
      return this.#terminalFailure(
        request.patchTabId,
        'No exact failed Basic Pitch Job is available to retry.',
        'blocked',
      );
    }

    const planning = createBasicPitchHumToMidiGenerationPlan(
      request.getProject(),
      { converterPatchTabId: request.patchTabId },
    );

    if (
      !planning.canPlan ||
      createBasicPitchHumToMidiPlanKey(planning.plan) !== pending.planKey
    ) {
      return this.#terminalFailure(
        request.patchTabId,
        'The source recording, Project BPM, selection, or PatchTab settings changed. The failed Job cannot be retried.',
        'blocked',
        false,
      );
    }

    if (!request.client) {
      return this.#terminalFailure(
        request.patchTabId,
        'Retry requires the ready Local Engine.',
        'blocked',
        true,
      );
    }

    this.#onState = request.onState;
    pending.plan = planning.plan;
    return this.#execute(request, request.client, pending.failedJob.jobId);
  }

  async recover(
    request: BasicPitchHumToMidiUiRequest,
  ): Promise<BasicPitchHumToMidiUiResult> {
    if (this.#isExecuting) {
      return uiResult({ kind: 'busy', state: this.#state });
    }

    const pending = this.#pending;

    if (
      !pending?.completedJob ||
      pending.plan.converterPatchTabId !== request.patchTabId
    ) {
      return this.#terminalFailure(
        request.patchTabId,
        'No exact completed Basic Pitch Job is available to recover.',
        'blocked',
      );
    }

    this.#onState = request.onState;
    return this.#settleRegistration(request, pending);
  }

  cancel(): boolean {
    if (
      !this.#isExecuting ||
      !this.#abortController ||
      this.#state.status !== 'QUEUED'
    ) {
      return false;
    }

    this.#abortController.abort();
    this.#emit({
      ...this.#state,
      message: 'Removing the exact queued Basic Pitch Job.',
      status: 'CANCEL_REQUESTED',
    });
    return true;
  }

  acknowledgeRegistration(jobId: string): boolean {
    if (
      this.#pending?.completedJob?.jobId !== jobId ||
      this.#state.status !== 'REGISTERED'
    ) {
      return false;
    }

    this.#pending = undefined;
    return true;
  }

  markRegistrationPending(jobId: string, message: string): boolean {
    if (this.#pending?.completedJob?.jobId !== jobId) {
      return false;
    }

    this.#emit({
      jobId,
      message,
      patchTabId: this.#pending.plan.converterPatchTabId,
      planKey: this.#pending.planKey,
      sourceClipId: this.#pending.plan.source.clipId,
      status: 'REGISTRATION_PENDING',
    });
    return true;
  }

  discard(patchTabId: string): boolean {
    if (
      this.#isExecuting ||
      (this.#pending !== undefined &&
        this.#pending.plan.converterPatchTabId !== patchTabId) ||
      (this.#pending === undefined && this.#state.patchTabId !== patchTabId)
    ) {
      return false;
    }

    this.#pending = undefined;
    this.#state = createInitialBasicPitchHumToMidiUiState();
    return true;
  }

  async #execute(
    request: BasicPitchHumToMidiUiRequest,
    client: LocalEngineBasicPitchHumToMidiClient,
    retryJobId?: string,
  ): Promise<BasicPitchHumToMidiUiResult> {
    const pending = this.#pending;

    if (!pending) {
      return this.#terminalFailure(
        request.patchTabId,
        'The Basic Pitch request snapshot is unavailable.',
        'failed',
      );
    }

    this.#isExecuting = true;
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    try {
      const generation = await this.#runGeneration(client, pending.plan.request, {
        onProgress: (progress) => this.#handleProgress(pending, progress, signal),
        ...(retryJobId ? { retryJobId } : {}),
        signal,
      });

      if (!generation.ok) {
        if (generation.reason === 'canceled') {
          this.#pending = undefined;
          return uiResult({
            kind: 'canceled',
            state: this.#emit({
              ...(generation.jobId ? { jobId: generation.jobId } : {}),
              message: 'Queued Basic Pitch conversion was canceled. Project data was unchanged.',
              patchTabId: pending.plan.converterPatchTabId,
              planKey: pending.planKey,
              sourceClipId: pending.plan.source.clipId,
              status: 'CANCELED',
            }),
          });
        }

        if (generation.retryable && generation.job?.state === 'FAILED') {
          pending.failedJob = generation.job;
          pending.completedJob = undefined;
          return uiResult({
            kind: 'retry-required',
            state: this.#emit({
              jobId: generation.job.jobId,
              message: 'The exact Basic Pitch Job failed. RETRY is available while its source and settings remain unchanged.',
              patchTabId: pending.plan.converterPatchTabId,
              planKey: pending.planKey,
              retryable: true,
              sourceClipId: pending.plan.source.clipId,
              status: 'ERROR',
            }),
          });
        }

        this.#pending = undefined;
        return uiResult({
          kind: 'failed',
          state: this.#emit({
            ...(generation.jobId ? { jobId: generation.jobId } : {}),
            message: 'Basic Pitch conversion did not complete safely. Project data was unchanged.',
            patchTabId: pending.plan.converterPatchTabId,
            planKey: pending.planKey,
            sourceClipId: pending.plan.source.clipId,
            status: 'ERROR',
          }),
        });
      }

      pending.completedJob = generation.job;
      pending.failedJob = undefined;
      return this.#settleRegistration(request, pending);
    } catch {
      this.#pending = undefined;
      return uiResult({
        kind: 'failed',
        state: this.#emit({
          message: 'Basic Pitch conversion failed unexpectedly. Project data was unchanged.',
          patchTabId: pending.plan.converterPatchTabId,
          planKey: pending.planKey,
          sourceClipId: pending.plan.source.clipId,
          status: 'ERROR',
        }),
      });
    } finally {
      this.#abortController = undefined;
      this.#isExecuting = false;
    }
  }

  #settleRegistration(
    request: BasicPitchHumToMidiUiRequest,
    pending: PendingBasicPitchHumToMidi,
  ): BasicPitchHumToMidiUiResult {
    const completedJob = pending.completedJob;

    if (!completedJob) {
      return this.#terminalFailure(
        request.patchTabId,
        'Completed Basic Pitch Job identity is unavailable.',
        'failed',
      );
    }

    const baseProject = request.getProject();
    const registration = createCompletedBasicPitchHumToMidiRegistration(
      baseProject,
      {
        createdAt: toIsoTimestamp(this.#clock),
        defaultSoundFontAssignment:
          request.resolveDefaultSoundFontAssignment?.(),
        job: completedJob,
        plan: pending.plan,
      },
    );

    if (!registration.canRegister) {
      return uiResult({
        kind: 'registration-pending',
        state: this.#emit({
          jobId: completedJob.jobId,
          message: `Basic Pitch completed, but MIDI registration is blocked: ${registration.message}`,
          patchTabId: pending.plan.converterPatchTabId,
          planKey: pending.planKey,
          sourceClipId: pending.plan.source.clipId,
          status: 'REGISTRATION_PENDING',
        }),
      });
    }

    const state = this.#emit({
      jobId: completedJob.jobId,
      message: `${registration.targetClip.name} is ready as the Active Basic Pitch MIDI Take.`,
      patchTabId: pending.plan.converterPatchTabId,
      planKey: pending.planKey,
      sourceClipId: pending.plan.source.clipId,
      status: 'REGISTERED',
    });

    return uiResult({
      artifact: registration.artifact,
      baseProject,
      clipTake: registration.clipTake,
      jobId: completedJob.jobId,
      kind: 'registered',
      project: registration.project,
      sourceClipName: pending.plan.source.clipName,
      state,
      status: registration.status,
      targetClip: registration.targetClip,
      targetCreated: registration.targetCreated,
    });
  }

  #handleProgress(
    pending: PendingBasicPitchHumToMidi,
    progress: LocalEngineBasicPitchHumToMidiProgress,
    signal: AbortSignal,
  ): void {
    const message = createProgressMessage(progress, signal.aborted);
    this.#emit({
      ...(progress.jobId ? { jobId: progress.jobId } : {}),
      message,
      patchTabId: pending.plan.converterPatchTabId,
      planKey: pending.planKey,
      sourceClipId: pending.plan.source.clipId,
      status: progress.state,
    });
  }

  #terminalFailure(
    patchTabId: string,
    message: string,
    kind: 'blocked' | 'failed',
    clearPending = true,
  ): BasicPitchHumToMidiUiResult {
    if (clearPending) {
      this.#pending = undefined;
    }

    return uiResult({
      kind,
      state: this.#emit({ message, patchTabId, status: 'ERROR' }),
    });
  }

  #emit(state: BasicPitchHumToMidiUiState): BasicPitchHumToMidiUiState {
    this.#state = Object.freeze({ ...state });
    this.#onState?.(this.#state);
    return this.#state;
  }
}

export function createInitialBasicPitchHumToMidiUiState(): BasicPitchHumToMidiUiState {
  return Object.freeze({ status: 'IDLE' as const });
}

export function createBasicPitchHumToMidiUiPresentation(input: Readonly<{
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  runtime: BasicPitchRuntimeUiState;
  state: BasicPitchHumToMidiUiState;
}>): BasicPitchHumToMidiUiPresentation {
  const planning = createBasicPitchHumToMidiGenerationPlan(input.project, {
    converterPatchTabId: input.patchTab.id,
  });
  const planKey = planning.canPlan
    ? createBasicPitchHumToMidiPlanKey(planning.plan)
    : undefined;
  const isOwner = input.state.patchTabId === input.patchTab.id;

  if (activeStatuses.has(input.state.status)) {
    if (!isOwner) {
      return presentation({
        ariaBusy: false,
        buttonLabel: 'WAIT',
        canAct: false,
        detail: 'Another Hum to MIDI PatchTab owns the active Basic Pitch Job.',
        disableParameters: false,
        eyebrow: 'BASIC PITCH BUSY',
        title: 'Transcribe Hum Audio',
      });
    }

    const canCancel = input.state.status === 'QUEUED';
    return presentation({
      ariaBusy: true,
      buttonLabel: canCancel ? 'CANCEL' : 'WAIT',
      canAct: canCancel,
      detail: input.state.message ?? 'Basic Pitch conversion is active.',
      disableParameters: true,
      eyebrow: formatStatus(input.state.status),
      title: 'Transcribe Hum Audio',
    });
  }

  if (isOwner && input.state.status === 'REGISTRATION_PENDING') {
    const canRecover = Boolean(planKey && planKey === input.state.planKey);
    return presentation({
      ariaBusy: false,
      buttonLabel: 'RECOVER',
      canAct: canRecover,
      detail: canRecover
        ? input.state.message ?? 'Recover the exact completed Basic Pitch Job.'
        : 'Source, selection, BPM, or PatchTab settings changed. Exact recovery is blocked.',
      disableParameters: false,
      eyebrow: 'MIDI REGISTRATION PENDING',
      title: 'Transcribe Hum Audio',
    });
  }

  if (!isOwner && input.state.status === 'REGISTRATION_PENDING') {
    return presentation({
      ariaBusy: false,
      buttonLabel: 'WAIT',
      canAct: false,
      detail: 'Another Hum to MIDI PatchTab owns a completed Job awaiting exact registration recovery.',
      disableParameters: false,
      eyebrow: 'MIDI REGISTRATION PENDING',
      title: 'Transcribe Hum Audio',
    });
  }

  if (isOwner && input.state.retryable) {
    const exactPlanMatches = Boolean(planKey && planKey === input.state.planKey);
    const canRetry =
      exactPlanMatches &&
      input.engineAcceptsNewJobs &&
      input.isProjectRootReady &&
      input.runtime.status === 'READY';
    return presentation({
      ariaBusy: false,
      buttonLabel: 'RETRY',
      canAct: canRetry,
      detail: canRetry
        ? input.state.message ?? 'Retry the exact failed Basic Pitch Job.'
        : !exactPlanMatches || !input.engineAcceptsNewJobs || !input.isProjectRootReady
          ? 'The exact failed Job cannot be retried until Engine, Project Root, source, selection, and settings match.'
          : input.runtime.status === 'CHECKING'
            ? 'Checking the pinned Basic Pitch Runtime before retry.'
            : input.runtime.status === 'UNAVAILABLE'
              ? input.runtime.message
              : 'The exact failed Job cannot be retried safely.',
      disableParameters: false,
      eyebrow: 'BASIC PITCH FAILED',
      title: 'Transcribe Hum Audio',
    });
  }

  if (!planning.canPlan) {
    return presentation({
      ariaBusy: false,
      buttonLabel: 'CONVERT',
      canAct: false,
      detail: planning.message,
      disableParameters: false,
      eyebrow: 'SOURCE UNAVAILABLE',
      title: 'Transcribe Hum Audio',
    });
  }

  if (!input.isProjectRootReady || !input.engineAcceptsNewJobs) {
    return presentation({
      ariaBusy: false,
      buttonLabel: 'CONVERT',
      canAct: false,
      detail: !input.isProjectRootReady
        ? 'Hum to MIDI requires one ready Project Root.'
        : input.engineAvailabilityMessage,
      disableParameters: false,
      eyebrow: 'ENGINE UNAVAILABLE',
      title: 'Transcribe Hum Audio',
    });
  }

  if (input.runtime.status !== 'READY') {
    return presentation({
      ariaBusy: input.runtime.status === 'CHECKING',
      buttonLabel: 'CONVERT',
      canAct: false,
      detail:
        input.runtime.status === 'CHECKING'
          ? 'Checking the pinned Basic Pitch Runtime and ONNX model.'
          : input.runtime.message,
      disableParameters: false,
      eyebrow:
        input.runtime.status === 'CHECKING'
          ? 'BASIC PITCH RUNTIME CHECK'
          : 'BASIC PITCH RUNTIME UNAVAILABLE',
      title: 'Transcribe Hum Audio',
    });
  }

  const completedDetail =
    isOwner && ['CANCELED', 'ERROR', 'REGISTERED'].includes(input.state.status)
      ? input.state.message
      : undefined;

  return presentation({
    ariaBusy: false,
    buttonLabel: 'CONVERT',
    canAct: true,
    detail:
      completedDetail ??
      `${planning.plan.source.clipName} / ${planning.plan.parameterSnapshot.noteRange.toUpperCase()} / SENS ${planning.plan.parameterSnapshot.sensitivity}%`,
    disableParameters: false,
    eyebrow:
      isOwner && input.state.status === 'REGISTERED'
        ? 'MIDI READY'
        : isOwner && input.state.status === 'CANCELED'
          ? 'CANCELED'
          : isOwner && input.state.status === 'ERROR'
            ? 'ERROR'
            : 'BASIC PITCH READY',
    title: 'Transcribe Hum Audio',
  });
}

function createProgressMessage(
  progress: LocalEngineBasicPitchHumToMidiProgress,
  cancellationRequested: boolean,
): string {
  if (
    cancellationRequested &&
    ['LOADING_MODEL', 'PROCESSING', 'SAVING'].includes(progress.state)
  ) {
    return 'Cancellation was too late for this Basic Pitch provider. Waiting for the exact Job to settle.';
  }

  switch (progress.state) {
    case 'ENQUEUEING':
      return 'Enqueueing one exact Local Basic Pitch Job.';
    case 'RETRYING':
      return 'Retrying the exact failed Local Basic Pitch Job.';
    case 'QUEUED':
      return 'Basic Pitch Job is queued. It can still be canceled safely.';
    case 'LOADING_MODEL':
      return 'Loading the Local Basic Pitch model.';
    case 'PROCESSING':
      return 'Converting the selected Hum Audio recording to MIDI notes.';
    case 'SAVING':
      return 'Saving and validating the canonical MIDI result.';
    case 'CANCEL_REQUESTED':
      return 'Cancellation is settling for the exact Basic Pitch Job.';
    default:
      return `Basic Pitch Job state: ${progress.state}.`;
  }
}

function formatStatus(status: BasicPitchHumToMidiUiStatus): string {
  return status.replace(/_/g, ' ');
}

function presentation(
  value: BasicPitchHumToMidiUiPresentation,
): BasicPitchHumToMidiUiPresentation {
  return Object.freeze(value);
}

function uiResult<T extends BasicPitchHumToMidiUiResult>(value: T): T {
  return Object.freeze(value);
}

function toIsoTimestamp(clock: () => Date): string {
  return clock().toISOString();
}
