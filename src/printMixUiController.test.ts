import { describe, expect, it, vi } from 'vitest';

import {
  PRINT_MIX_NORMALIZE_TARGET_PEAK,
  PRINT_MIX_PROTOCOL_VERSION,
  createPrintMixArtifactId,
} from '../shared/printMixProtocol.js';
import type {
  LocalEngineGeneratedAudioAvailabilityResult,
  LocalEnginePrintMixResult,
} from './localEngineClient';
import {
  createPrintMixPlanSha256,
  type PrintMixOperation,
  type PrintMixRequest,
} from './printMixOperation';
import {
  PrintMixUiController,
  createInitialPrintMixUiState,
  createPrintMixUiPresentation,
  type PrintMixUiAudioClient,
  type PrintMixUiState,
} from './printMixUiController';
import {
  PRINT_MIX_TEST_CREATED_AT,
  PRINT_MIX_TEST_OPERATION_ID,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';
import type { ProjectState } from './types';

describe('PrintMixUiController', () => {
  it('runs one default-normalized Audio Plan and returns one atomic muted registration', async () => {
    const project = createPrintMixAudioProject();
    const before = structuredClone(project);
    const client = createAudioClient();
    const states: PrintMixUiState[] = [];
    const controller = createController();
    const result = await controller.run({
      client,
      getProject: () => project,
      onState: (state) => states.push(state),
      patchTabId: 'print-mix',
    });

    expect(result.kind).toBe('registered');
    if (result.kind !== 'registered') {
      throw new Error(result.state.message);
    }

    expect(client.runPrintMix).toHaveBeenCalledOnce();
    const request = vi.mocked(client.runPrintMix).mock.calls[0][0];
    expect(request.plan).toMatchObject({
      mediaType: 'audio',
      normalize: true,
      operationId: PRINT_MIX_TEST_OPERATION_ID,
      selectedClipIds: ['audio-clip-1', 'audio-clip-2'],
      targetPeakDbfs: -1,
    });
    expect(result.project.tracks).toHaveLength(project.tracks.length + 1);
    expect(result.project.tracks[result.project.tracks.length - 1]).toMatchObject({
      clips: [{ activeClipTakeId: expect.any(String), type: 'mixdown' }],
      muted: true,
      type: 'audio',
    });
    expect(result.project.artifacts).toHaveLength(
      (project.artifacts?.length ?? 0) + 1,
    );
    expect(project).toEqual(before);
    expect(states.map(({ status }) => status)).toEqual([
      'PREPARING',
      'RUNNING',
      'REGISTERED',
    ]);
    expect(controller.acknowledgeRegistration(result.operationId)).toBe(true);
  });

  it('preserves Normalize Off in the exact Audio Plan and presents deterministic clipping evidence', async () => {
    const project = setNormalize(createPrintMixAudioProject(), 'Off');
    const client = createAudioClient({ clippingWarning: true });
    const controller = createController();
    const result = await controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    expect(result).toMatchObject({
      clippingWarning: true,
      kind: 'registered',
      state: {
        clippingWarning: true,
        status: 'REGISTERED',
      },
    });
    expect(vi.mocked(client.runPrintMix).mock.calls[0][0].plan).toMatchObject({
      mediaType: 'audio',
      normalize: false,
    });
    expect(result.state.message).toMatch(/clipping risk/i);
    expect(result.state.message).toMatch(/no normalization or limiting/i);
  });

  it('merges MIDI notes locally without an Engine client or timbre data', async () => {
    const project = createPrintMixMidiProject();
    const before = structuredClone(project);
    const controller = createController();
    const result = await controller.run({
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    expect(result.kind).toBe('registered');
    if (result.kind !== 'registered') {
      throw new Error(result.state.message);
    }

    const outputTrack = result.project.tracks[result.project.tracks.length - 1];
    const outputClip = outputTrack?.clips[0];
    const outputArtifact = result.project.artifacts?.[
      result.project.artifacts.length - 1
    ];
    expect(outputTrack).toMatchObject({ muted: true, type: 'midi' });
    expect(outputClip).toMatchObject({
      activeClipTakeId: expect.any(String),
      type: 'midi-notes',
    });
    expect(outputArtifact).toMatchObject({
      kind: 'midi',
      midi: {
        notes: [
          expect.objectContaining({ lengthTicks: 480, pitch: 60, startTick: 0, velocity: 91 }),
          expect.objectContaining({ lengthTicks: 480, pitch: 60, startTick: 0, velocity: 91 }),
          expect.objectContaining({ lengthTicks: 960, pitch: 67, startTick: 1_920, velocity: 73 }),
        ],
      },
    });
    expect(JSON.stringify(outputArtifact)).not.toMatch(
      /soundfont|soundFont|bank|program|renderer|instrument/i,
    );
    expect(project).toEqual(before);
  });

  it.each([
    ['fewer than two Clips', (project: ProjectState) => {
      project.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    }],
    ['mixed media', (project: ProjectState) => {
      const midiProject = createPrintMixMidiProject();
      project.tracks.push(midiProject.tracks[0]);
      project.artifacts?.push(midiProject.artifacts?.[0] as never);
      project.selection = {
        items: [
          { id: 'audio-clip-1', type: 'clip' },
          { id: 'midi-clip-1', type: 'clip' },
        ],
      };
    }],
    ['duplicate identity', (project: ProjectState) => {
      project.selection = {
        items: [
          { id: 'audio-clip-1', type: 'clip' },
          { id: 'audio-clip-1', type: 'clip' },
        ],
      };
    }],
    ['stale identity', (project: ProjectState) => {
      project.selection = {
        items: [
          { id: 'audio-clip-1', type: 'clip' },
          { id: 'missing-clip', type: 'clip' },
        ],
      };
    }],
  ] as const)('blocks %s before Engine execution and preserves Project state', async (_label, mutate) => {
    const project = createPrintMixAudioProject();
    mutate(project);
    const before = structuredClone(project);
    const client = createAudioClient();
    const result = await createController().run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    expect(result.kind).toBe('blocked');
    expect(client.runPrintMix).not.toHaveBeenCalled();
    expect(client.checkGeneratedAudioAvailability).not.toHaveBeenCalled();
    expect(project).toEqual(before);
  });

  it('does not reinterpret a historical Clip Filer as PRINT MIX', async () => {
    const project = createPrintMixMidiProject();
    project.patchTabs = [
      {
        colorIndex: 4,
        description: 'Historical export node.',
        id: 'historical-clip-filer',
        inputType: 'Selected Clip',
        name: 'Clip Filer',
        outputType: 'Export File',
        parameters: [],
        status: 'ready',
      },
    ];
    const before = structuredClone(project);
    const result = await createController().run({
      getProject: () => project,
      patchTabId: 'historical-clip-filer',
    });

    expect(result).toMatchObject({ kind: 'blocked' });
    expect(project).toEqual(before);
  });

  it('keeps the exact operation and Plan for unknown-outcome recovery', async () => {
    const project = createPrintMixAudioProject();
    const completed = vi.fn(async (request: PrintMixRequest) => ({
      ok: true as const,
      operation: await createAudioOperation(request),
    }));
    const unknown = {
      cause: 'timeout' as const,
      message: 'Sensitive C:\\Users\\name\\file.wav',
      ok: false as const,
      operationId: PRINT_MIX_TEST_OPERATION_ID,
      outcome: 'unknown' as const,
      reason: 'unknown-outcome' as const,
    };
    const client = createAudioClient();
    vi.mocked(client.runPrintMix).mockResolvedValueOnce(unknown);
    vi.mocked(client.recoverPrintMix).mockImplementation(completed as never);
    const controller = createController();
    const first = await controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    expect(first).toMatchObject({
      kind: 'outcome-unknown',
      state: { operationId: PRINT_MIX_TEST_OPERATION_ID },
    });
    expect(first.state.message).not.toContain('C:\\Users');

    const recovered = await controller.recover({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });
    const originalRequest = vi.mocked(client.runPrintMix).mock.calls[0][0];
    const recoveryCall = vi.mocked(client.recoverPrintMix).mock.calls[0];

    expect(recoveryCall[0]).toBe(originalRequest);
    expect(recoveryCall[1]).toBe(unknown);
    expect(recovered.kind).toBe('registered');
    expect(client.runPrintMix).toHaveBeenCalledOnce();
    expect(client.recoverPrintMix).toHaveBeenCalledOnce();
  });

  it('retains an unknown Audio operation while recovery is temporarily offline', async () => {
    const project = createPrintMixAudioProject();
    const client = createAudioClient();
    vi.mocked(client.runPrintMix).mockResolvedValueOnce({
      cause: 'offline',
      message: 'Local Engine unavailable.',
      ok: false,
      operationId: PRINT_MIX_TEST_OPERATION_ID,
      outcome: 'unknown',
      reason: 'unknown-outcome',
    });
    const controller = createController();
    await controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    await expect(controller.recover({
      getProject: () => project,
      patchTabId: 'print-mix',
    })).resolves.toMatchObject({
      kind: 'outcome-unknown',
      state: {
        operationId: PRINT_MIX_TEST_OPERATION_ID,
        status: 'OUTCOME_UNKNOWN',
      },
    });

    const recovered = await controller.recover({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });
    expect(recovered.kind).toBe('registered');
    expect(client.recoverPrintMix).toHaveBeenCalledOnce();
  });

  it('prevents duplicate execution and releases busy state after a canceled pre-dispatch run', async () => {
    const project = createPrintMixAudioProject();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createAudioClient();
    vi.mocked(client.runPrintMix).mockImplementation(async (_request, signal) => {
      await gate;
      return signal?.aborted
        ? {
            message: 'Audio PRINT MIX was canceled before dispatch.',
            ok: false,
            outcome: 'not-dispatched',
            reason: 'canceled',
          }
        : { ok: true, operation: await createAudioOperation(_request) };
    });
    const controller = createController();
    const first = controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    await Promise.resolve();
    expect(controller.isExecuting).toBe(true);
    await expect(controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    })).resolves.toMatchObject({ kind: 'busy' });
    expect(controller.cancel()).toBe(true);
    release?.();
    await expect(first).resolves.toMatchObject({
      kind: 'canceled',
      state: { status: 'CANCELED' },
    });
    expect(controller.isExecuting).toBe(false);
    expect(project.tracks).toHaveLength(2);
  });

  it('retains a completed operation for exact registration recovery after availability failure', async () => {
    const project = createPrintMixAudioProject();
    const client = createAudioClient();
    vi.mocked(client.checkGeneratedAudioAvailability)
      .mockResolvedValueOnce({
        availableSourceIds: [],
        ok: true,
      })
      .mockImplementation(async (descriptors) => ({
        availableSourceIds: [descriptors[0].sourceId],
        ok: true,
      }));
    const controller = createController();
    const first = await controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    expect(first).toMatchObject({
      kind: 'registration-pending',
      state: { status: 'REGISTRATION_PENDING' },
    });
    const recovered = await controller.recover({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    expect(recovered.kind).toBe('registered');
    expect(client.runPrintMix).toHaveBeenCalledOnce();
    expect(client.recoverPrintMix).not.toHaveBeenCalled();
    expect(client.checkGeneratedAudioAvailability).toHaveBeenCalledTimes(2);
  });

  it('keeps a finalized Audio operation pending when cancellation arrives during availability verification', async () => {
    const project = createPrintMixAudioProject();
    const before = structuredClone(project);
    let releaseAvailability: (() => void) | undefined;
    let markAvailabilityStarted: (() => void) | undefined;
    const availabilityGate = new Promise<void>((resolve) => {
      releaseAvailability = resolve;
    });
    const availabilityStarted = new Promise<void>((resolve) => {
      markAvailabilityStarted = resolve;
    });
    const client = createAudioClient();
    vi.mocked(client.checkGeneratedAudioAvailability).mockImplementationOnce(
      async (descriptors) => {
        markAvailabilityStarted?.();
        await availabilityGate;
        return {
          availableSourceIds: [descriptors[0].sourceId],
          ok: true,
        };
      },
    );
    const controller = createController();
    const pending = controller.run({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });

    await availabilityStarted;
    expect(controller.cancel()).toBe(true);
    releaseAvailability?.();
    await expect(pending).resolves.toMatchObject({
      kind: 'registration-pending',
      state: { status: 'REGISTRATION_PENDING' },
    });
    expect(project).toEqual(before);

    const recovered = await controller.recover({
      client,
      getProject: () => project,
      patchTabId: 'print-mix',
    });
    expect(recovered.kind).toBe('registered');
    expect(client.runPrintMix).toHaveBeenCalledOnce();
    expect(client.recoverPrintMix).not.toHaveBeenCalled();
  });

  it('fails closed when the Project changes before registration', async () => {
    const project = createPrintMixMidiProject();
    const stale = structuredClone(project);
    stale.tracks[0].clips = [];
    let reads = 0;
    const controller = createController();
    const result = await controller.run({
      getProject: () => (reads++ === 0 ? project : stale),
      patchTabId: 'print-mix',
    });

    expect(result).toMatchObject({
      kind: 'registration-pending',
      state: { status: 'REGISTRATION_PENDING' },
    });
    expect(stale.tracks).toHaveLength(2);
  });
});

describe('createPrintMixUiPresentation', () => {
  it('shows Audio Normalize On by default and a clear Off clipping-risk state', () => {
    const onProject = createPrintMixAudioProject();
    const on = createPresentation(onProject);
    const off = createPresentation(setNormalize(createPrintMixAudioProject(), 'Off'));

    expect(on).toMatchObject({
      buttonLabel: 'PRINT MIX',
      mediaType: 'audio',
      showNormalize: true,
    });
    expect(on.detail).toContain('NORMALIZE ON');
    expect(off.showNormalize).toBe(true);
    expect(off.detail).toContain('CLIPPING RISK');
    expect(off.detail).toContain('NO LIMITER');
  });

  it('shows MIDI mode without Normalize or timbre controls', () => {
    const presentation = createPresentation(createPrintMixMidiProject());

    expect(presentation).toMatchObject({
      mediaType: 'midi',
      showNormalize: false,
    });
    expect(presentation.detail).toContain('NOTES ONLY');
    expect(Object.keys(presentation)).not.toContain('soundFont');
    expect(Object.keys(presentation)).not.toContain('program');
  });

  it('presents mixed or insufficient selection as blocked', () => {
    const insufficient = createPrintMixAudioProject();
    insufficient.selection = { items: [{ id: 'audio-clip-1', type: 'clip' }] };
    expect(createPresentation(insufficient)).toMatchObject({ canAct: false });
    expect(createPresentation(insufficient).detail).toContain('at least two');

    const mixed = createPrintMixAudioProject();
    const midi = createPrintMixMidiProject();
    mixed.tracks.push(midi.tracks[0]);
    mixed.artifacts?.push(midi.artifacts?.[0] as never);
    mixed.selection = {
      items: [
        { id: 'audio-clip-1', type: 'clip' },
        { id: 'midi-clip-1', type: 'clip' },
      ],
    };
    expect(createPresentation(mixed)).toMatchObject({ canAct: false });
    expect(createPresentation(mixed).detail).toContain('same media type');
  });
});

function createController(): PrintMixUiController {
  return new PrintMixUiController({
    clock: () => new Date(PRINT_MIX_TEST_CREATED_AT),
    createOperationId: () => PRINT_MIX_TEST_OPERATION_ID,
  });
}

function createPresentation(project: ProjectState) {
  return createPrintMixUiPresentation({
    engineAcceptsNewJobs: true,
    engineAvailabilityMessage: 'Local Engine is ready.',
    isProjectRootReady: true,
    patchTab: project.patchTabs[0],
    project,
    state: createInitialPrintMixUiState(),
  });
}

function setNormalize(project: ProjectState, value: 'Off' | 'On'): ProjectState {
  const patchTab = project.patchTabs[0];
  project.patchTabs[0] = {
    ...patchTab,
    parameters: patchTab.parameters.map((parameter) =>
      parameter.id === 'normalize' && parameter.kind === 'select'
        ? { ...parameter, value }
        : parameter,
    ),
  };
  return project;
}

function createAudioClient(options: Readonly<{
  clippingWarning?: boolean;
}> = {}): PrintMixUiAudioClient & {
  checkGeneratedAudioAvailability: ReturnType<typeof vi.fn>;
  recoverPrintMix: ReturnType<typeof vi.fn>;
  runPrintMix: ReturnType<typeof vi.fn>;
} {
  const checkGeneratedAudioAvailability = vi.fn(
    async (descriptors): Promise<LocalEngineGeneratedAudioAvailabilityResult> => ({
      availableSourceIds: [descriptors[0].sourceId],
      ok: true,
    }),
  );
  const runPrintMix = vi.fn(
    async (request: PrintMixRequest): Promise<LocalEnginePrintMixResult> => ({
      ok: true,
      operation: await createAudioOperation(request, options.clippingWarning),
    }),
  );
  const recoverPrintMix = vi.fn(
    async (request: PrintMixRequest): Promise<LocalEnginePrintMixResult> => ({
      ok: true,
      operation: await createAudioOperation(request, options.clippingWarning),
    }),
  );
  return {
    checkGeneratedAudioAvailability,
    recoverPrintMix,
    runPrintMix,
  } as never;
}

async function createAudioOperation(
  request: PrintMixRequest,
  clippingWarning = false,
): Promise<PrintMixOperation> {
  if (request.plan.mediaType !== 'audio') {
    throw new Error('Audio PRINT MIX Request required.');
  }

  const artifactId = createPrintMixArtifactId(request.operationId) as string;
  const frameCount = Math.round(request.plan.durationSeconds * 44_100);
  const bytesWritten = 44 + frameCount * 4;
  const planSha256 = await createPrintMixPlanSha256(request.plan);
  const preNormalizationPeak = clippingWarning
    ? 1.25
    : request.plan.normalize
      ? 0.5
      : 0;
  const appliedGain = request.plan.normalize
    ? PRINT_MIX_NORMALIZE_TARGET_PEAK / preNormalizationPeak
    : 1;
  const outputPeak = request.plan.normalize
    ? PRINT_MIX_NORMALIZE_TARGET_PEAK
    : preNormalizationPeak;

  return {
    operationId: request.operationId,
    protocolVersion: PRINT_MIX_PROTOCOL_VERSION,
    result: {
      artifact: {
        artifactId,
        createdAt: PRINT_MIX_TEST_CREATED_AT,
        destination: 'print-mix',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath: `print-mixes/${artifactId}.wav`,
          sizeBytes: bytesWritten,
        },
        kind: 'audio',
        provenance: {
          planSha256,
          planVersion: 1,
          rendererId: 'humstudio.print-mix.pcm16',
          rendererVersion: '1.0.0',
        },
      },
      printMix: {
        appliedGain,
        bitsPerSample: 16,
        bytesWritten,
        channels: 2,
        clippingWarning,
        durationSeconds: frameCount / 44_100,
        frameCount,
        mediaType: 'audio',
        mimeType: 'audio/wav',
        normalize: request.plan.normalize,
        outputPeak,
        preNormalizationPeak,
        sampleRate: 44_100,
        sourceCount: request.plan.sources.length,
        targetPeakDbfs: -1,
      },
      status: 'COMPLETED',
    },
  };
}
