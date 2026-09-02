import type {
  LocalEngineClient,
  LocalEngineSoundFontResource,
} from './localEngineClient';

export const PIANO_ROLL_LIVE_NOTE_DURATION_MS = 320;
export const PIANO_ROLL_LIVE_NOTE_PREPARE_RETRY_DELAYS_MS = [
  500,
  1_000,
] as const;

export type PianoRollLiveNotePreviewSelection = Readonly<{
  bank: number;
  program: number;
  resource: LocalEngineSoundFontResource;
}>;

export type PianoRollLiveNotePreviewState =
  | Readonly<{ status: 'IDLE' }>
  | Readonly<{ message: string; status: 'PREPARING' | 'ERROR' }>
  | Readonly<{
      bank: number;
      program: number;
      resourceId: string;
      sessionId: string;
      status: 'READY';
    }>;

export class PianoRollLiveNotePreviewRuntime {
  #client?: LocalEngineClient;
  #identity?: string;
  #operationId = 0;
  #preparation?: Promise<boolean>;
  #sessionId?: string;
  #stopping?: Promise<void>;

  prepare(
    client: LocalEngineClient,
    selection: PianoRollLiveNotePreviewSelection,
    onStateChange: (state: PianoRollLiveNotePreviewState) => void,
  ): Promise<boolean> {
    const identity = createIdentity(selection);

    if (
      this.#client === client &&
      this.#identity === identity &&
      this.#sessionId
    ) {
      return Promise.resolve(true);
    }

    if (
      this.#client === client &&
      this.#identity === identity &&
      this.#preparation
    ) {
      return this.#preparation;
    }

    const operationId = ++this.#operationId;
    const previousClient = this.#client;
    const previousSessionId = this.#sessionId;
    this.#client = client;
    this.#identity = identity;
    this.#sessionId = undefined;
    onStateChange({
      message: `Loading ${selection.resource.name} for Note Preview.`,
      status: 'PREPARING',
    });

    const preparation = (async () => {
      if (previousClient && previousSessionId) {
        await stopLiveNotePreviewSession(previousClient, previousSessionId);
      }

      for (
        let attempt = 0;
        attempt <= PIANO_ROLL_LIVE_NOTE_PREPARE_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        const result = await client.controlSoundFontLivePreview({
          action: 'prepare',
          bank: selection.bank,
          program: selection.program,
          sampleRate: 48_000,
          soundFont: {
            format: selection.resource.format,
            library: selection.resource.library,
            relativePath: selection.resource.relativePath,
            resourceId: selection.resource.resourceId,
            revisionToken: selection.resource.revisionToken,
          },
        });

        if (this.#operationId !== operationId) {
          const isAdoptedByCurrentPreparation =
            this.#client === client && this.#identity === identity;

          if (
            result.ok &&
            result.snapshot.status === 'READY' &&
            !isAdoptedByCurrentPreparation
          ) {
            await stopLiveNotePreviewSession(client, result.snapshot.sessionId);
          }
          return false;
        }

        if (result.ok && result.snapshot.status === 'READY') {
          this.#sessionId = result.snapshot.sessionId;
          onStateChange({
            bank: result.snapshot.bank,
            program: result.snapshot.program,
            resourceId: result.snapshot.resourceId,
            sessionId: result.snapshot.sessionId,
            status: 'READY',
          });
          return true;
        }

        const message = result.ok
          ? 'Local Engine returned an invalid Note Preview state.'
          : result.message;
        const retryDelay = result.ok
          ? undefined
          : PIANO_ROLL_LIVE_NOTE_PREPARE_RETRY_DELAYS_MS[attempt];

        if (retryDelay === undefined || !isRetryablePrepareFailure(result)) {
          onStateChange({ message, status: 'ERROR' });
          return false;
        }

        onStateChange({
          message: `${message} Retrying Note Preview automatically.`,
          status: 'PREPARING',
        });
        await waitForRetry(retryDelay);

        if (this.#operationId !== operationId) {
          return false;
        }
      }

      return false;
    })().finally(() => {
      if (this.#operationId === operationId) {
        this.#preparation = undefined;
      }
    });

    this.#preparation = preparation;
    return preparation;
  }

  async trigger(
    pitch: number,
    velocity: number,
    onStateChange: (state: PianoRollLiveNotePreviewState) => void,
  ): Promise<boolean> {
    const preparation = this.#preparation;

    if (preparation && !(await preparation)) {
      return false;
    }

    const client = this.#client;
    const sessionId = this.#sessionId;

    if (!client || !sessionId) {
      return false;
    }

    const result = await client.controlSoundFontLivePreview({
      action: 'trigger',
      durationMs: PIANO_ROLL_LIVE_NOTE_DURATION_MS,
      pitch,
      sessionId,
      velocity,
    });

    if (!result.ok || result.snapshot.status !== 'TRIGGERED') {
      onStateChange({
        message: result.ok
          ? 'Local Engine returned an invalid Note Preview trigger state.'
          : result.message,
        status: 'ERROR',
      });
      return false;
    }

    return true;
  }

  stop(
    onStateChange?: (state: PianoRollLiveNotePreviewState) => void,
  ): Promise<void> {
    if (this.#stopping) {
      return this.#stopping;
    }

    const operationId = ++this.#operationId;
    const client = this.#client;
    const identity = this.#identity;
    const preparation = this.#preparation;
    const sessionId = this.#sessionId;
    this.#client = undefined;
    this.#identity = undefined;
    this.#preparation = undefined;
    this.#sessionId = undefined;

    const stopping = (async () => {
      try {
        if (client && sessionId) {
          await stopLiveNotePreviewSession(client, sessionId);
        }

        if (preparation) {
          await preparation;
        }

        if (this.#operationId === operationId) {
          onStateChange?.({ status: 'IDLE' });
        }
      } catch (error) {
        if (
          this.#operationId === operationId &&
          client &&
          identity &&
          sessionId &&
          !this.#client &&
          !this.#identity &&
          !this.#preparation &&
          !this.#sessionId
        ) {
          this.#client = client;
          this.#identity = identity;
          this.#sessionId = sessionId;
        }

        throw error;
      }
    })();
    const trackedStopping = stopping.finally(() => {
      if (this.#stopping === trackedStopping) {
        this.#stopping = undefined;
      }
    });
    this.#stopping = trackedStopping;
    return trackedStopping;
  }
}

async function stopLiveNotePreviewSession(
  client: LocalEngineClient,
  sessionId: string,
): Promise<void> {
  const result = await client.controlSoundFontLivePreview({
    action: 'stop',
    sessionId,
  });

  if (!result.ok) {
    throw new Error(result.message);
  }

  if (result.snapshot.status !== 'STOPPED') {
    throw new Error('Local Engine returned an invalid Note Preview stop state.');
  }
}

function createIdentity(selection: PianoRollLiveNotePreviewSelection): string {
  return [
    selection.resource.library,
    selection.resource.resourceId,
    selection.resource.revisionToken,
    selection.bank,
    selection.program,
  ].join('\0');
}

function isRetryablePrepareFailure(
  result: Awaited<
    ReturnType<LocalEngineClient['controlSoundFontLivePreview']>
  >,
): boolean {
  return (
    !result.ok &&
    (result.reason === 'http-error' ||
      result.reason === 'offline' ||
      result.reason === 'timeout')
  );
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
