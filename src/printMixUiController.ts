import type { GeneratedAudioCommitAvailabilityEvidence } from './generatedAudioCommitAvailability';
import type {
  LocalEngineGeneratedAudioAvailabilityResult,
  LocalEngineGeneratedAudioDescriptor,
  LocalEnginePrintMixResult,
} from './localEngineClient';
import {
  createCompletedPrintMixMidiOperation,
  createPrintMixOperationId,
  createPrintMixRequest,
  type PrintMixOperation,
  type PrintMixRequest,
} from './printMixOperation';
import {
  createPrintMixPlan,
  getPrintMixClipMediaType,
  type PrintMixPlan,
} from './printMixPlan';
import {
  isPrintMixPatchTab,
  resolvePrintMixNormalize,
} from './printMixPatchTab';
import {
  createPrintMixRegistrationIntent,
  createPrintMixTrackRegistration,
  type PrintMixOutputIdentity,
  type PrintMixRegistrationIntent,
} from './printMixRegistration';
import type { PatchTab, ProjectState } from './types';

const PRINT_MIX_PRESENTATION_OPERATION_ID =
  'print-mix-operation-00000000-0000-4000-8000-000000000000';

export type PrintMixUiStatus =
  | 'CANCELED'
  | 'CANCEL_REQUESTED'
  | 'ERROR'
  | 'IDLE'
  | 'OUTCOME_UNKNOWN'
  | 'PREPARING'
  | 'RECOVERING'
  | 'REGISTERED'
  | 'REGISTRATION_PENDING'
  | 'RUNNING';

export type PrintMixUiState = Readonly<{
  clippingWarning?: boolean;
  mediaType?: PrintMixPlan['mediaType'];
  message?: string;
  operationId?: string;
  patchTabId?: string;
  status: PrintMixUiStatus;
}>;

export type PrintMixUiPresentation = Readonly<{
  ariaBusy: boolean;
  buttonLabel: 'CANCEL' | 'PRINT MIX' | 'RECOVER';
  canAct: boolean;
  detail: string;
  eyebrow: string;
  mediaType?: PrintMixPlan['mediaType'];
  showNormalize: boolean;
  title: string;
}>;

export type PrintMixUiAudioClient = Readonly<{
  checkGeneratedAudioAvailability: (
    sources: readonly LocalEngineGeneratedAudioDescriptor[],
  ) => Promise<LocalEngineGeneratedAudioAvailabilityResult>;
  recoverPrintMix: (
    request: PrintMixRequest,
    unknownOutcome: Extract<LocalEnginePrintMixResult, { outcome: 'unknown' }>,
    signal?: AbortSignal,
  ) => Promise<LocalEnginePrintMixResult>;
  runPrintMix: (
    request: PrintMixRequest,
    signal?: AbortSignal,
  ) => Promise<LocalEnginePrintMixResult>;
}>;

export type PrintMixUiRequest = Readonly<{
  client?: PrintMixUiAudioClient;
  getProject: () => ProjectState;
  onState?: (state: PrintMixUiState) => void;
  patchTabId: string;
}>;

export type PrintMixUiResult =
  | Readonly<{
      kind:
        | 'blocked'
        | 'busy'
        | 'canceled'
        | 'failed'
        | 'outcome-unknown'
        | 'recovery-required'
        | 'registration-pending';
      state: PrintMixUiState;
    }>
  | Readonly<{
      baseProject: ProjectState;
      clippingWarning: boolean;
      kind: 'registered';
      operationId: string;
      output: PrintMixOutputIdentity;
      project: ProjectState;
      state: PrintMixUiState;
      status: 'ALREADY_REGISTERED' | 'REGISTERED';
    }>;

type PendingPrintMix = {
  intent: PrintMixRegistrationIntent;
  operation?: PrintMixOperation;
  patchTabId: string;
  request: PrintMixRequest;
  unknownOutcome?: Extract<LocalEnginePrintMixResult, { outcome: 'unknown' }>;
};

type PrintMixUiControllerOptions = Readonly<{
  clock?: () => Date;
  createOperationId?: () => string;
}>;

export class PrintMixUiController {
  readonly #clock: () => Date;
  readonly #createOperationId: () => string;
  #abortController?: AbortController;
  #isExecuting = false;
  #onState?: (state: PrintMixUiState) => void;
  #pending?: PendingPrintMix;
  #state: PrintMixUiState = createInitialPrintMixUiState();

  constructor(options: PrintMixUiControllerOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#createOperationId = options.createOperationId ?? createPrintMixOperationId;
  }

  get isExecuting(): boolean {
    return this.#isExecuting;
  }

  get state(): PrintMixUiState {
    return this.#state;
  }

  async run(request: PrintMixUiRequest): Promise<PrintMixUiResult> {
    if (this.#isExecuting) {
      return result({ kind: 'busy', state: this.#state });
    }

    if (this.#pending) {
      return result({ kind: 'recovery-required', state: this.#state });
    }

    this.#onState = request.onState;
    this.#emit({
      message: 'Preparing one immutable PRINT MIX operation.',
      patchTabId: request.patchTabId,
      status: 'PREPARING',
    });

    const project = request.getProject();
    let operationId: string;

    try {
      operationId = this.#createOperationId();
    } catch {
      return this.#terminalFailure(
        request.patchTabId,
        'PRINT MIX operation identity could not be created.',
        'blocked',
      );
    }

    const planning = createPrintMixPlan(
      project,
      request.patchTabId,
      project.selection,
      operationId,
    );

    if (!planning.canCreate) {
      return this.#terminalFailure(
        request.patchTabId,
        planning.message,
        'blocked',
      );
    }

    let immutableRequest: PrintMixRequest;

    try {
      immutableRequest = createPrintMixRequest(planning.plan);
    } catch {
      return this.#terminalFailure(
        request.patchTabId,
        'PRINT MIX could not create one immutable Request.',
        'blocked',
      );
    }

    const intentResolution = createPrintMixRegistrationIntent(
      project,
      immutableRequest,
    );

    if (!intentResolution.canCreate) {
      return this.#terminalFailure(
        request.patchTabId,
        intentResolution.message,
        'blocked',
        planning.plan.mediaType,
        operationId,
      );
    }

    this.#pending = {
      intent: intentResolution.intent,
      patchTabId: request.patchTabId,
      request: immutableRequest,
    };

    return this.#executePending(request, false);
  }

  async recover(request: PrintMixUiRequest): Promise<PrintMixUiResult> {
    if (this.#isExecuting) {
      return result({ kind: 'busy', state: this.#state });
    }

    if (!this.#pending || this.#pending.patchTabId !== request.patchTabId) {
      return result({
        kind: 'blocked',
        state: this.#emit({
          message: 'No exact PRINT MIX operation is available to recover.',
          patchTabId: request.patchTabId,
          status: 'ERROR',
        }),
      });
    }

    this.#onState = request.onState;
    return this.#executePending(request, true);
  }

  cancel(): boolean {
    if (!this.#isExecuting || !this.#abortController || !this.#pending) {
      return false;
    }

    this.#abortController.abort();
    this.#emit({
      mediaType: this.#pending.request.plan.mediaType,
      message:
        'Cancel requested. A dispatched Audio operation may require exact recovery.',
      operationId: this.#pending.request.operationId,
      patchTabId: this.#pending.patchTabId,
      status: 'CANCEL_REQUESTED',
    });
    return true;
  }

  acknowledgeRegistration(operationId: string): boolean {
    if (
      !this.#pending ||
      this.#pending.request.operationId !== operationId ||
      this.#state.status !== 'REGISTERED'
    ) {
      return false;
    }

    this.#pending = undefined;
    return true;
  }

  async #executePending(
    request: PrintMixUiRequest,
    isRecovery: boolean,
  ): Promise<PrintMixUiResult> {
    const pending = this.#pending;

    if (!pending) {
      return result({ kind: 'failed', state: this.#state });
    }

    this.#isExecuting = true;
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;
    this.#emit({
      mediaType: pending.request.plan.mediaType,
      message: isRecovery
        ? `Recovering exact operation ${pending.request.operationId}.`
        : pending.request.plan.mediaType === 'audio'
          ? 'Rendering selected Audio Clips through the PRINT MIX Engine path.'
          : 'Merging selected MIDI Clip notes without Audio conversion.',
      operationId: pending.request.operationId,
      patchTabId: pending.patchTabId,
      status: isRecovery ? 'RECOVERING' : 'RUNNING',
    });

    try {
      if (pending.operation) {
        return await this.#settleRegistration(request, pending);
      }

      if (pending.request.plan.mediaType === 'midi') {
        const midiOperation = await createCompletedPrintMixMidiOperation(
          pending.request as PrintMixRequest & {
            plan: Extract<PrintMixPlan, { mediaType: 'midi' }>;
          },
          this.#clock,
        );

        if (signal.aborted) {
          this.#pending = undefined;
          return result({
            kind: 'canceled',
            state: this.#emit({
              mediaType: 'midi',
              message: 'MIDI PRINT MIX was canceled before registration.',
              operationId: pending.request.operationId,
              patchTabId: pending.patchTabId,
              status: 'CANCELED',
            }),
          });
        }

        pending.operation = midiOperation;
        return await this.#settleRegistration(request, pending);
      }

      if (!request.client) {
        if (isRecovery && pending.unknownOutcome) {
          return result({
            kind: 'outcome-unknown',
            state: this.#emit({
              mediaType: 'audio',
              message:
                'Audio PRINT MIX outcome remains unknown. Reconnect the Local Engine, then recover this exact operation.',
              operationId: pending.request.operationId,
              patchTabId: pending.patchTabId,
              status: 'OUTCOME_UNKNOWN',
            }),
          });
        }

        this.#pending = undefined;
        return result({
          kind: 'blocked',
          state: this.#emit({
            mediaType: 'audio',
            message: 'Audio PRINT MIX requires the ready Local Engine.',
            operationId: pending.request.operationId,
            patchTabId: pending.patchTabId,
            status: 'ERROR',
          }),
        });
      }

      const engineResult = isRecovery && pending.unknownOutcome
        ? await request.client.recoverPrintMix(
            pending.request,
            pending.unknownOutcome,
            signal,
          )
        : await request.client.runPrintMix(pending.request, signal);

      return await this.#handleAudioEngineResult(request, pending, engineResult);
    } catch {
      if (pending.request.plan.mediaType === 'audio') {
        return result({
          kind: 'outcome-unknown',
          state: this.#emit({
            mediaType: 'audio',
            message:
              'Audio PRINT MIX outcome is unknown. Recover this exact operation; do not start another.',
            operationId: pending.request.operationId,
            patchTabId: pending.patchTabId,
            status: 'OUTCOME_UNKNOWN',
          }),
        });
      }

      this.#pending = undefined;
      return result({
        kind: 'failed',
        state: this.#emit({
          mediaType: 'midi',
          message: 'MIDI PRINT MIX failed before Project registration.',
          operationId: pending.request.operationId,
          patchTabId: pending.patchTabId,
          status: 'ERROR',
        }),
      });
    } finally {
      this.#abortController = undefined;
      this.#isExecuting = false;
    }
  }

  async #handleAudioEngineResult(
    request: PrintMixUiRequest,
    pending: PendingPrintMix,
    engineResult: LocalEnginePrintMixResult,
  ): Promise<PrintMixUiResult> {
    if (!engineResult.ok) {
      if (engineResult.outcome === 'not-dispatched') {
        this.#pending = undefined;
        return result({
          kind: 'canceled',
          state: this.#emit({
            mediaType: 'audio',
            message: 'Audio PRINT MIX was canceled before dispatch.',
            operationId: pending.request.operationId,
            patchTabId: pending.patchTabId,
            status: 'CANCELED',
          }),
        });
      }

      if (engineResult.outcome === 'unknown') {
        pending.unknownOutcome = engineResult;
        return result({
          kind: 'outcome-unknown',
          state: this.#emit({
            mediaType: 'audio',
            message:
              'Audio PRINT MIX outcome is unknown. Recover this exact operation; do not start another.',
            operationId: pending.request.operationId,
            patchTabId: pending.patchTabId,
            status: 'OUTCOME_UNKNOWN',
          }),
        });
      }

      this.#pending = undefined;
      return result({
        kind: 'failed',
        state: this.#emit({
          mediaType: 'audio',
          message: 'Audio PRINT MIX was rejected. Project data was unchanged.',
          operationId: pending.request.operationId,
          patchTabId: pending.patchTabId,
          status: 'ERROR',
        }),
      });
    }

    pending.unknownOutcome = undefined;
    pending.operation = engineResult.operation;
    return this.#settleRegistration(request, pending);
  }

  async #settleRegistration(
    request: PrintMixUiRequest,
    pending: PendingPrintMix,
  ): Promise<PrintMixUiResult> {
    const operation = pending.operation;

    if (!operation) {
      return result({ kind: 'failed', state: this.#state });
    }

    if (this.#abortController?.signal.aborted) {
      return this.#registrationPending(
        pending,
        'PRINT MIX finalized, but Project registration was canceled.',
      );
    }

    let sourceAvailability: GeneratedAudioCommitAvailabilityEvidence | undefined;

    if (operation.result.artifact.kind === 'audio') {
      if (!request.client) {
        return this.#registrationPending(
          pending,
          'Audio PRINT MIX finalized, but the Local Engine is unavailable for final Artifact verification.',
        );
      }

      const descriptor: LocalEngineGeneratedAudioDescriptor = Object.freeze({
        kind: 'generated',
        name: operation.result.artifact.file.name,
        relativePath: operation.result.artifact.file.relativePath,
        sizeBytes: operation.result.artifact.file.sizeBytes,
        sourceId: operation.result.artifact.artifactId,
      });
      let availability: LocalEngineGeneratedAudioAvailabilityResult;

      try {
        availability = await request.client.checkGeneratedAudioAvailability([
          descriptor,
        ]);
      } catch {
        return this.#registrationPending(
          pending,
          'Audio PRINT MIX finalized, but final Artifact verification did not complete.',
        );
      }

      if (
        !availability.ok ||
        availability.availableSourceIds.length !== 1 ||
        availability.availableSourceIds[0] !== descriptor.sourceId
      ) {
        return this.#registrationPending(
          pending,
          'Audio PRINT MIX finalized, but its exact generated Artifact is unavailable.',
        );
      }

      sourceAvailability = Object.freeze({
        availableArtifactIds: Object.freeze([descriptor.sourceId]),
        checkedAt: toIsoTimestamp(this.#clock),
      });
    }

    if (this.#abortController?.signal.aborted) {
      return this.#registrationPending(
        pending,
        'PRINT MIX finalized, but Project registration was canceled.',
      );
    }

    const baseProject = request.getProject();
    const registration = await createPrintMixTrackRegistration(
      baseProject,
      pending.request,
      operation,
      {
        intent: pending.intent,
        ...(sourceAvailability ? { sourceAvailability } : {}),
      },
    );

    if (!registration.canRegister) {
      return this.#registrationPending(
        pending,
        `PRINT MIX finalized, but Project registration is blocked: ${registration.message}`,
      );
    }

    if (this.#abortController?.signal.aborted) {
      return this.#registrationPending(
        pending,
        'PRINT MIX finalized, but Project registration was canceled.',
      );
    }

    const clippingWarning =
      operation.result.printMix.mediaType === 'audio' &&
      operation.result.printMix.clippingWarning;
    const state = this.#emit({
      clippingWarning,
      mediaType: pending.request.plan.mediaType,
      message: clippingWarning
        ? `${pending.intent.output.clipName} registered on muted Track ${pending.intent.output.trackName}. Clipping risk is present; no normalization or limiting was applied.`
        : `${pending.intent.output.clipName} registered on muted Track ${pending.intent.output.trackName}.`,
      operationId: pending.request.operationId,
      patchTabId: pending.patchTabId,
      status: 'REGISTERED',
    });

    return result({
      baseProject,
      clippingWarning,
      kind: 'registered',
      operationId: pending.request.operationId,
      output: pending.intent.output,
      project: registration.project,
      state,
      status: registration.status,
    });
  }

  #registrationPending(
    pending: PendingPrintMix,
    message: string,
  ): PrintMixUiResult {
    return result({
      kind: 'registration-pending',
      state: this.#emit({
        mediaType: pending.request.plan.mediaType,
        message: `${message} Recover this exact operation without creating a replacement.`,
        operationId: pending.request.operationId,
        patchTabId: pending.patchTabId,
        status: 'REGISTRATION_PENDING',
      }),
    });
  }

  #terminalFailure(
    patchTabId: string,
    message: string,
    kind: 'blocked' | 'failed',
    mediaType?: PrintMixPlan['mediaType'],
    operationId?: string,
  ): PrintMixUiResult {
    this.#pending = undefined;
    return result({
      kind,
      state: this.#emit({
        ...(mediaType ? { mediaType } : {}),
        message,
        ...(operationId ? { operationId } : {}),
        patchTabId,
        status: 'ERROR',
      }),
    });
  }

  #emit(state: PrintMixUiState): PrintMixUiState {
    this.#state = Object.freeze({ ...state });
    this.#onState?.(this.#state);
    return this.#state;
  }
}

export function createInitialPrintMixUiState(): PrintMixUiState {
  return Object.freeze({ status: 'IDLE' as const });
}

export function createPrintMixUiPresentation(input: Readonly<{
  engineAcceptsNewJobs: boolean;
  engineAvailabilityMessage: string;
  isProjectRootReady: boolean;
  patchTab: PatchTab;
  project: ProjectState;
  state: PrintMixUiState;
}>): PrintMixUiPresentation {
  if (!isPrintMixPatchTab(input.patchTab)) {
    return presentation({
      ariaBusy: false,
      buttonLabel: 'PRINT MIX',
      canAct: false,
      detail: 'PRINT MIX requires one exact versioned PatchTab contract.',
      eyebrow: 'CONTRACT BLOCKED',
      showNormalize: false,
      title: 'Print selected Clips',
    });
  }

  const selectedMediaType = resolveSelectedMediaType(input.project);
  const isStateOwner = input.state.patchTabId === input.patchTab.id;
  const isActive = [
    'CANCEL_REQUESTED',
    'PREPARING',
    'RECOVERING',
    'RUNNING',
  ].includes(input.state.status);
  const hasRecovery = [
    'OUTCOME_UNKNOWN',
    'REGISTRATION_PENDING',
  ].includes(input.state.status);
  const mediaType =
    isStateOwner && (isActive || hasRecovery)
      ? input.state.mediaType
      : selectedMediaType;
  const showNormalize = mediaType === 'audio';
  const normalize = showNormalize
    ? resolvePrintMixNormalize(input.patchTab)
    : undefined;

  if (isActive) {
    return presentation({
      ariaBusy: isStateOwner,
      buttonLabel: isStateOwner ? 'CANCEL' : 'PRINT MIX',
      canAct: isStateOwner && input.state.status !== 'CANCEL_REQUESTED',
      detail: isStateOwner
        ? input.state.message ?? 'PRINT MIX is active.'
        : 'Another PRINT MIX node owns the active operation.',
      eyebrow: isStateOwner ? input.state.status : 'PRINT MIX BUSY',
      mediaType,
      showNormalize,
      title: mediaTitle(mediaType),
    });
  }

  if (hasRecovery) {
    const canRecover =
      isStateOwner &&
      (mediaType === 'midi' ||
        (input.engineAcceptsNewJobs && input.isProjectRootReady));
    return presentation({
      ariaBusy: false,
      buttonLabel: isStateOwner ? 'RECOVER' : 'PRINT MIX',
      canAct: canRecover,
      detail: isStateOwner
        ? input.state.message ?? 'Recover the exact PRINT MIX operation.'
        : 'Another PRINT MIX node owns an unresolved operation.',
      eyebrow: isStateOwner ? input.state.status : 'PRINT MIX BLOCKED',
      mediaType,
      showNormalize,
      title: mediaTitle(mediaType),
    });
  }

  const planning = createPrintMixPlan(
    input.project,
    input.patchTab.id,
    input.project.selection,
    PRINT_MIX_PRESENTATION_OPERATION_ID,
  );
  const clippingDetail =
    mediaType === 'audio' && normalize === false
      ? 'CLIPPING RISK / NORMALIZE OFF / NO LIMITER'
      : undefined;

  if (!planning.canCreate) {
    return presentation({
      ariaBusy: false,
      buttonLabel: 'PRINT MIX',
      canAct: false,
      detail: clippingDetail
        ? `${clippingDetail} / ${planning.message}`
        : planning.message,
      eyebrow: mediaType ? `${mediaType.toUpperCase()} BLOCKED` : 'SELECTION BLOCKED',
      mediaType,
      showNormalize,
      title: mediaTitle(mediaType),
    });
  }

  if (
    planning.plan.mediaType === 'audio' &&
    (!input.engineAcceptsNewJobs || !input.isProjectRootReady)
  ) {
    return presentation({
      ariaBusy: false,
      buttonLabel: 'PRINT MIX',
      canAct: false,
      detail: !input.engineAcceptsNewJobs
        ? input.engineAvailabilityMessage
        : 'Audio PRINT MIX requires one ready Project Root.',
      eyebrow: 'AUDIO ENGINE BLOCKED',
      mediaType: 'audio',
      showNormalize: true,
      title: mediaTitle('audio'),
    });
  }

  return presentation({
    ariaBusy: false,
    buttonLabel: 'PRINT MIX',
    canAct: true,
    detail:
      clippingDetail ??
      (planning.plan.mediaType === 'audio'
        ? `${planning.plan.selectedClipIds.length} AUDIO CLIPS / NORMALIZE ON / -1.0 dBFS`
        : `${planning.plan.selectedClipIds.length} MIDI CLIPS / NOTES ONLY / TIMBRE IGNORED`),
    eyebrow: `${planning.plan.mediaType.toUpperCase()} READY`,
    mediaType: planning.plan.mediaType,
    showNormalize: planning.plan.mediaType === 'audio',
    title: mediaTitle(planning.plan.mediaType),
  });
}

function resolveSelectedMediaType(
  project: ProjectState,
): PrintMixPlan['mediaType'] | undefined {
  const items = project.selection.items;

  if (
    items.length === 0 ||
    items.some((item) => item.type !== 'clip') ||
    new Set(items.map((item) => item.id)).size !== items.length
  ) {
    return undefined;
  }

  const mediaTypes = new Set<PrintMixPlan['mediaType']>();

  for (const item of items) {
    const matches = project.tracks.flatMap((track) =>
      track.clips.filter((clip) => clip.id === item.id),
    );

    if (matches.length !== 1) {
      return undefined;
    }

    const mediaType = getPrintMixClipMediaType(matches[0]);

    if (!mediaType) {
      return undefined;
    }

    mediaTypes.add(mediaType);
  }

  return mediaTypes.size === 1 ? [...mediaTypes][0] : undefined;
}

function mediaTitle(mediaType: PrintMixPlan['mediaType'] | undefined): string {
  return mediaType === 'audio'
    ? 'Print selected Audio Clips'
    : mediaType === 'midi'
      ? 'Merge selected MIDI Clips'
      : 'Print selected Clips';
}

function presentation(
  value: PrintMixUiPresentation,
): PrintMixUiPresentation {
  return Object.freeze(value);
}

function result<T extends PrintMixUiResult>(value: T): T {
  return Object.freeze(value);
}

function toIsoTimestamp(clock: () => Date): string {
  try {
    return clock().toISOString();
  } catch {
    throw new Error('PRINT MIX availability clock is invalid.');
  }
}
