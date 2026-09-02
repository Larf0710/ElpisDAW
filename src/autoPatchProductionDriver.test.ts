import { describe, expect, it, vi } from 'vitest';

import type {
  AutoPatchDriverIdentityKind,
  AutoPatchDriverIdentityServices,
} from './autoPatchDriverIdentity';
import {
  createValidatedPreflightWithStableAudio3,
  requireDefinition,
  soundFontResourceId,
  soundFontRevision,
  stageInstrumentId,
  stageMidiEditId,
  stageStableAudio3Id,
  stableAudio3ConnectionId,
  targetClipId,
} from './autoPatchExecutionFrontier.testFixture';
import { createAutoPatchMidiEditStageFixture } from './autoPatchMidiEditStage.testFixture';
import {
  createAutoPatchProductionDriverClient,
  runAutoPatchProductionDriver,
  type AutoPatchProductionDriverClient,
} from './autoPatchProductionDriver';
import { prepareAutoPatchProductionPersistence } from './autoPatchProductionPersistence';
import { prepareAutoPatchProductionRun } from './autoPatchProductionPreparation';
import {
  createRawMixdownStableAudio3ProductionProject,
  productionCreatedAt,
  rawMixdownArtifactId,
  rawMixdownClipId,
  rawMixdownClipTakeId,
} from './autoPatchProductionPreparation.testFixture';
import {
  createAutoPatchRuntimeCoordinator,
  type AutoPatchReadyRuntimeCoordinator,
  type AutoPatchRuntimeCoordinator,
} from './autoPatchRuntimeCoordinator';
import type {
  AutoPatchStageRunnerClient,
} from './autoPatchStageRunner';
import type { StableAudio3StageRunnerClient } from './stableAudio3StageRunner';
import type {
  LocalEngineInstrumentRenderJobRequest,
  LocalEngineSoundFontResource,
  LocalEngineStableAudio3JobRequest,
} from './localEngineClient';
import type {
  LocalEngineGpuJobRecord,
  LocalEngineJsonValue,
} from './localEngineJobs';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import type { ProjectState } from './types';

const midiArtifactId = 'artifact-driver-midi';
const midiSourceEditId = 'edit-driver-midi';
const midiResultId = 'result-driver-midi';
const instrumentOutputClipId = 'clip-driver-instrument';
const instrumentResultId = 'result-driver-instrument';
const engineArtifactId = 'artifact-engine-instrument';
const engineJobId = 'job-production-driver-instrument';
const stableAudio3ArtifactId = 'artifact-engine-stable-audio-3';
const stableAudio3JobId = 'job-production-driver-stable-audio-3';
const stableAudio3ResultId = 'result-driver-stable-audio-3';

const verifiedSoundFonts: readonly LocalEngineSoundFontResource[] =
  Object.freeze([
    Object.freeze({
      format: 'sf2' as const,
      lastModifiedAt: '2026-07-31T00:00:00.000Z',
      library: 'project' as const,
      name: 'Piano.sf2',
      relativePath: 'soundfonts/Piano.sf2',
      resourceId: soundFontResourceId,
      revisionToken: soundFontRevision,
      sizeBytes: 1_024,
      status: 'AVAILABLE' as const,
    }),
  ]);

describe('Auto Patch production Driver', () => {
  it('runs MIDI EDIT then MIDI TO AUDIO from each successful Project and Coordinator result', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const engine = createInstrumentClient('COMPLETED');
    const saveProjectFile = vi.fn();
    const productionClient = createAutoPatchProductionDriverClient({
      ...engine.client,
      saveProjectFile,
    });
    const onProgress = vi.fn();
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:50.000Z',
    ]);

    const result = await runAutoPatchProductionDriver(
      productionClient,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
        onProgress,
      },
    );

    if (!result.ok) {
      throw new Error(
        `${result.status} ${result.cause}: ${result.message}`,
      );
    }

    expect(result).toMatchObject({
      coordinator: { status: 'COMPLETED' },
      ok: true,
      status: 'COMPLETED',
    });
    expect(identity.kinds).toEqual([
      'attempt',
      'midi-artifact',
      'midi-source-edit',
      'stage-result',
      'attempt',
      'instrument-output-clip',
      'stage-result',
    ]);
    expect(identity.clock).toHaveBeenCalledTimes(3);
    expect(engine.client.enqueueInstrumentRenderJob).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.map(([coordinator]) => ({
      attemptCount: coordinator.attempts.length,
      stageId: coordinator.activeStage.scope.stageId,
      status: coordinator.status,
    }))).toEqual([
      { attemptCount: 0, stageId: stageMidiEditId, status: 'READY' },
      { attemptCount: 1, stageId: stageInstrumentId, status: 'READY' },
    ]);
    expect(productionClient).not.toHaveProperty('saveProjectFile');
    expect(saveProjectFile).not.toHaveBeenCalled();
    expect(Object.isFrozen(productionClient)).toBe(true);

    expect(result.ledger.attemptIds).toEqual([
      'attempt-driver-1',
      'attempt-driver-2',
    ]);
    expect(result.coordinator.attempts).toMatchObject([
      {
        attemptId: 'attempt-driver-1',
        finishedAt: '2026-07-31T00:00:20.000Z',
        state: 'COMPLETED',
      },
      {
        attemptId: 'attempt-driver-2',
        finishedAt: '2026-07-31T00:00:40.000Z',
        state: 'COMPLETED',
      },
    ]);
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(result.project.tabFlowStageResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputArtifactIds: [midiArtifactId],
          resultId: midiResultId,
        }),
        expect.objectContaining({
          outputArtifactIds: [engineArtifactId],
          resultId: instrumentResultId,
        }),
      ]),
    );
    expect(findClip(result.project, instrumentOutputClipId)).toBeDefined();
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === engineArtifactId,
      ),
    ).toBe(true);
    expect(identity.kinds).not.toContain('engine-job');
    expect(identity.kinds).not.toContain('engine-artifact');
    expect(engine.request?.lineage.parentArtifactIds).toEqual([
      midiArtifactId,
    ]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('runs the backend Stable Audio 3 Stage after Instrument and preserves exact lineage', async () => {
    const fixture = createStableAudio3DriverFixture();
    const engine = createInstrumentAndStableAudio3Client('COMPLETED');
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:50.000Z',
    ]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      fixture.project,
      fixture.coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
        stableAudio3Runner: { wait: async () => undefined },
      },
    );

    if (!result.ok) {
      throw new Error(
        `${result.status} ${result.cause}: ${result.message}`,
      );
    }

    expect(result.coordinator).toMatchObject({
      attempts: [
        { state: 'COMPLETED' },
        { state: 'COMPLETED' },
        { state: 'COMPLETED' },
      ],
      status: 'COMPLETED',
    });
    expect(identity.kinds).toEqual([
      'attempt',
      'midi-artifact',
      'midi-source-edit',
      'stage-result',
      'attempt',
      'instrument-output-clip',
      'stage-result',
      'attempt',
      'stage-result',
    ]);
    expect(identity.clock).toHaveBeenCalledTimes(4);
    expect(engine.enqueueStableAudio3Job).toHaveBeenCalledTimes(1);
    expect(engine.stableAudio3Request?.lineage).toEqual({
      parentArtifactIds: [engineArtifactId],
      parentClipTakeIds: [`clip-take-${engineArtifactId}`],
    });
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
    expect(result.project.tabFlowStageResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputArtifactIds: [stableAudio3ArtifactId],
          resultId: stableAudio3ResultId,
          scope: expect.objectContaining({
            stageId: stageStableAudio3Id,
          }),
        }),
      ]),
    );
    expect(findClip(result.project, instrumentOutputClipId)).toMatchObject({
      activeClipTakeId: `clip-take-${engineArtifactId}`,
      id: instrumentOutputClipId,
      type: 'instrument-audio',
    });
  });

  it('runs a selected Raw Mixdown through the standalone Stable Audio 3 Stage into one muted SA3 Master Track', async () => {
    const project = createRawMixdownStableAudio3ProductionProject();
    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt: productionCreatedAt,
      planId: 'plan-driver-sa3-master',
      runId: 'run-driver-sa3-master',
      standalonePatchTabId: 'stable-audio-3',
      verifiedAudioArtifactIds: [rawMixdownArtifactId],
      verifiedSoundFontResources: [],
    });

    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }

    const engine = createInstrumentAndStableAudio3Client(
      'COMPLETED',
      undefined,
      {
        createdAt: '2026-08-13T02:30:01.000Z',
        finishedAt: '2026-08-13T02:30:10.000Z',
      },
    );
    const identity = createIdentityServices([
      '2026-08-13T02:30:00.000Z',
      '2026-08-13T02:30:10.000Z',
    ]);
    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      preparation.coordinator,
      [],
      {
        identity: identity.services,
        stableAudio3Runner: { wait: async () => undefined },
      },
    );

    if (!result.ok) {
      throw new Error(`${result.status} ${result.cause}: ${result.message}`);
    }

    expect(result).toMatchObject({
      coordinator: {
        attempts: [{ state: 'COMPLETED' }],
        status: 'COMPLETED',
      },
      ok: true,
      status: 'COMPLETED',
    });
    expect(identity.kinds).toEqual(['attempt', 'stage-result']);
    expect(engine.enqueueStableAudio3Job).toHaveBeenCalledTimes(1);
    expect(engine.stableAudio3Request?.lineage).toEqual({
      parentArtifactIds: [rawMixdownArtifactId],
      parentClipTakeIds: [rawMixdownClipTakeId],
    });
    expect(
      result.project.tracks.find(
        (track) => track.id === 'sa3-master-track-attempt-driver-1',
      ),
    ).toMatchObject({
      clips: [
        {
          activeClipTakeId: `clip-take-${stableAudio3ArtifactId}`,
          id: 'sa3-master-clip-attempt-driver-1',
          sourceClipId: rawMixdownClipId,
          type: 'master',
        },
      ],
      level: 0,
      muted: true,
      name: 'SA3 Master',
      type: 'audio',
    });
    expect(findClip(result.project, rawMixdownClipId)).toEqual(
      findClip(project, rawMixdownClipId),
    );
    expect(result.project.tabFlowStageResults).toEqual(
      result.coordinator.stageResults,
    );
  });

  it('marks a verified standalone A2A Master source available before Project persistence completes', async () => {
    const project = createRawMixdownStableAudio3ProductionProject();
    const preparation = prepareAutoPatchProductionRun(project, {
      createdAt: productionCreatedAt,
      planId: 'plan-driver-sa3-master-availability',
      runId: 'run-driver-sa3-master-availability',
      standalonePatchTabId: 'stable-audio-3',
      verifiedAudioArtifactIds: [rawMixdownArtifactId],
      verifiedSoundFontResources: [],
    });

    if (!preparation.canRun) {
      throw new Error(preparation.message);
    }

    const engine = createInstrumentAndStableAudio3Client(
      'COMPLETED',
      undefined,
      {
        createdAt: '2026-08-29T04:00:01.000Z',
        finishedAt: '2026-08-29T04:00:10.000Z',
      },
    );
    const identity = createIdentityServices([
      '2026-08-29T04:00:00.000Z',
      '2026-08-29T04:00:10.000Z',
    ]);
    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      preparation.coordinator,
      [],
      {
        identity: identity.services,
        stableAudio3Runner: { wait: async () => undefined },
      },
    );

    if (!result.ok) {
      throw new Error(`${result.status} ${result.cause}: ${result.message}`);
    }

    const checkedAt = '2026-08-29T04:00:11.000Z';
    const persistence = prepareAutoPatchProductionPersistence(
      project,
      preparation.coordinator,
      result,
      {
        history: {
          entryId: 'history-driver-sa3-master-availability',
          name: 'Stable Audio 3 A2A Availability',
          recordedAt: checkedAt,
        },
        sourceAvailability: {
          availableArtifactIds: [
            rawMixdownArtifactId,
            stableAudio3ArtifactId,
          ],
          checkedAt,
        },
      },
    );

    if (!persistence.canCommit) {
      throw new Error(persistence.message);
    }

    const masterClip = findClip(
      persistence.project,
      'sa3-master-clip-attempt-driver-1',
    );

    if (!masterClip) {
      throw new Error('Expected the persisted SA3 Master Clip.');
    }

    expect(masterClip.sourceFile).toMatchObject({
      checkedAt,
      sourceId: stableAudio3ArtifactId,
      status: 'available',
    });
    expect(persistence.plan.project).toBe(persistence.project);
    expect(persistence.result.project).toBe(persistence.project);
  });

  it('registers three Stable Audio 3 Seed variants in one source Clip and one Stage Result', async () => {
    const fixture = createStableAudio3DriverFixture(3);
    const engine = createInstrumentAndStableAudio3Client('COMPLETED');
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:50.000Z',
    ]);
    const result = await runAutoPatchProductionDriver(
      engine.client,
      fixture.project,
      fixture.coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
        stableAudio3Runner: { wait: async () => undefined },
      },
    );

    if (!result.ok) {
      throw new Error(`${result.status} ${result.cause}: ${result.message}`);
    }

    const stableAudio3Artifacts = [
      stableAudio3ArtifactId,
      `${stableAudio3ArtifactId}-seed-8`,
      `${stableAudio3ArtifactId}-seed-9`,
    ];
    const outputClip = findClip(result.project, instrumentOutputClipId);

    expect(engine.enqueueStableAudio3Job).toHaveBeenCalledTimes(3);
    expect(
      result.project.tabFlowStageResults?.find(
        (stageResult) => stageResult.resultId === stableAudio3ResultId,
      ),
    ).toMatchObject({
      outputArtifactIds: stableAudio3Artifacts,
      outputClipTakeIds: stableAudio3Artifacts.map(
        (artifactId) => `clip-take-${artifactId}`,
      ),
    });
    expect(outputClip).toMatchObject({
      activeClipTakeId: `clip-take-${engineArtifactId}`,
      clipTakes: expect.arrayContaining(
        stableAudio3Artifacts.map((artifactId) =>
          expect.objectContaining({ artifactId }),
        ),
      ),
    });
    expect(
      result.project.artifacts
        ?.filter((artifact) => stableAudio3Artifacts.includes(artifact.artifactId))
        .map((artifact) =>
          artifact.kind === 'audio' && 'provenance' in artifact
            ? artifact.provenance.seed
            : undefined,
        ),
    ).toEqual([7, 8, 9]);
  });

  it('stops on Stable Audio 3 failure while preserving MIDI Edit and Instrument outputs', async () => {
    const fixture = createStableAudio3DriverFixture();
    const engine = createInstrumentAndStableAudio3Client('FAILED');
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:50.000Z',
      '2026-07-31T00:01:10.000Z',
    ]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      fixture.project,
      fixture.coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
        stableAudio3Runner: { wait: async () => undefined },
      },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-engine-job-failed',
      coordinator: {
        failure: { cause: 'stable-audio-3-engine-job-failed' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'stage-failed',
      status: 'FAILED',
    });

    if (result.ok || result.status !== 'FAILED') {
      throw new Error('Expected one failed Stable Audio 3 run.');
    }

    expect(result.project.tabFlowStageResults ?? []).toHaveLength(2);
    expect(
      (result.project.artifacts ?? []).map(
        (artifact) => artifact.artifactId,
      ),
    ).toEqual(expect.arrayContaining([midiArtifactId, engineArtifactId]));
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === stableAudio3ArtifactId,
      ),
    ).toBe(false);
    expect(findClip(result.project, instrumentOutputClipId)).toBeDefined();
  });

  it('removes a queued Stable Audio 3 Job on cancellation and preserves prior outputs', async () => {
    const fixture = createStableAudio3DriverFixture();
    const controller = new AbortController();
    const engine = createInstrumentAndStableAudio3Client(
      'COMPLETED',
      controller,
    );
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:50.000Z',
      '2026-07-31T00:01:10.000Z',
    ]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      fixture.project,
      fixture.coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
        signal: controller.signal,
        stableAudio3Runner: { wait: async () => undefined },
      },
    );

    expect(result).toMatchObject({
      cause: 'stable-audio-3-queued-job-removed',
      coordinator: {
        failure: { cause: 'stable-audio-3-queued-job-removed' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'run-canceled',
      status: 'CANCELED',
    });
    expect(engine.removeQueuedJob).toHaveBeenCalledWith(
      stableAudio3JobId,
    );
    expect(engine.cancelJob).not.toHaveBeenCalled();

    if (result.ok || result.status !== 'CANCELED') {
      throw new Error('Expected one canceled Stable Audio 3 run.');
    }

    expect(result.project.tabFlowStageResults ?? []).toHaveLength(2);
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === stableAudio3ArtifactId,
      ),
    ).toBe(false);
  });

  it('stops on Instrument failure while preserving the finalized MIDI Edit output', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const engine = createInstrumentClient('FAILED');
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:40.000Z',
    ]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
      },
    );

    expect(result).toMatchObject({
      cause: 'instrument-engine-job-failed',
      coordinator: {
        failure: {
          cause: 'instrument-engine-job-failed',
          failedAt: '2026-07-31T00:00:40.000Z',
        },
        status: 'FAILED',
      },
      ok: false,
      reason: 'stage-failed',
      status: 'FAILED',
    });

    if (result.ok || result.status !== 'FAILED') {
      throw new Error('Expected one failed production Driver result.');
    }

    expect(result.project.tabFlowStageResults ?? []).toHaveLength(1);
    expect((result.project.tabFlowStageResults ?? [])[0]).toMatchObject({
      outputArtifactIds: [midiArtifactId],
      resultId: midiResultId,
    });
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === midiArtifactId,
      ),
    ).toBe(true);
    expect(findClip(result.project, instrumentOutputClipId)).toBeUndefined();
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === engineArtifactId,
      ),
    ).toBe(false);
    expect(identity.clock).toHaveBeenCalledTimes(4);
  });

  it('cancels before the first Stage without allocating identity or creating an attempt', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const engine = createInstrumentClient('COMPLETED');
    const identity = createIdentityServices([]);
    const controller = new AbortController();
    controller.abort();

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      cause: 'abort-signal',
      coordinator,
      ledger: {
        attemptIds: [],
        outputReservations: [],
      },
      ok: false,
      project,
      reason: 'run-canceled',
      status: 'CANCELED',
    });
    expect(coordinator.attempts).toEqual([]);
    expect(identity.kinds).toEqual([]);
    expect(identity.clock).not.toHaveBeenCalled();
    expect(engine.client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
  });

  it('blocks before allocation when the progress observer fails', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const engine = createInstrumentClient('COMPLETED');
    const identity = createIdentityServices([]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        onProgress: () => {
          throw new Error('display unavailable');
        },
      },
    );

    expect(result).toMatchObject({
      cause: 'production-driver-progress-observer-failed',
      coordinator,
      ok: false,
      project,
      reason: 'driver-invariant',
      scope: { stageId: stageMidiEditId },
      status: 'BLOCKED',
    });
    expect(identity.kinds).toEqual([]);
    expect(identity.clock).not.toHaveBeenCalled();
    expect(engine.client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
  });

  it('cancels before dispatch without creating a failed attempt when allocation observes an abort', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const engine = createInstrumentClient('COMPLETED');
    const controller = new AbortController();
    const identity = createIdentityServices(
      ['2026-07-31T00:00:10.000Z'],
      {
        onAllocate: (kind) => {
          if (kind === 'stage-result') {
            controller.abort();
          }
        },
      },
    );

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      cause: 'abort-signal',
      coordinator: { attempts: [], status: 'READY' },
      ledger: { attemptIds: ['attempt-driver-1'] },
      ok: false,
      project,
      reason: 'run-canceled',
      status: 'CANCELED',
    });
    expect(identity.kinds).toEqual([
      'attempt',
      'midi-artifact',
      'midi-source-edit',
      'stage-result',
    ]);
    expect(engine.client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
  });

  it('finishes atomic MIDI Edit then cancels between Stages without a failed attempt', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const engine = createInstrumentClient('COMPLETED');
    const controller = new AbortController();
    const identity = createIdentityServices(
      [
        '2026-07-31T00:00:10.000Z',
        '2026-07-31T00:00:20.000Z',
      ],
      {
        onClock: (callIndex) => {
          if (callIndex === 1) {
            controller.abort();
          }
        },
      },
    );

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      cause: 'abort-signal',
      coordinator: {
        attempts: [
          {
            attemptId: 'attempt-driver-1',
            state: 'COMPLETED',
          },
        ],
        failure: null,
        status: 'READY',
      },
      ok: false,
      reason: 'run-canceled',
      status: 'CANCELED',
    });

    if (result.ok || result.status !== 'CANCELED') {
      throw new Error('Expected one canceled production Driver result.');
    }

    expect(result.project.tabFlowStageResults ?? []).toHaveLength(1);
    expect((result.project.tabFlowStageResults ?? [])[0]).toMatchObject({
      outputArtifactIds: [midiArtifactId],
      resultId: midiResultId,
    });
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === midiArtifactId,
      ),
    ).toBe(true);
    expect(result.ledger.attemptIds).toEqual(['attempt-driver-1']);
    expect(engine.client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
  });

  it('passes the run signal to the Engine and returns run-level cancellation', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = requireReady(fixture.coordinatorReady);
    const controller = new AbortController();
    const engine = createCancelingInstrumentClient(controller);
    const identity = createIdentityServices([
      '2026-07-31T00:00:10.000Z',
      '2026-07-31T00:00:20.000Z',
      '2026-07-31T00:00:30.000Z',
      '2026-07-31T00:00:40.000Z',
    ]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      {
        identity: identity.services,
        instrumentRunner: { wait: async () => undefined },
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      cause: 'stage-run-canceled',
      coordinator: {
        failure: { cause: 'stage-run-canceled' },
        status: 'FAILED',
      },
      ok: false,
      reason: 'run-canceled',
      status: 'CANCELED',
    });
    expect(engine.removeQueuedJob).toHaveBeenCalledWith(engineJobId);
    expect(engine.cancelJob).not.toHaveBeenCalled();

    if (result.ok || result.status !== 'CANCELED') {
      throw new Error('Expected one canceled Engine-backed run.');
    }

    expect(result.project.tabFlowStageResults ?? []).toHaveLength(1);
    expect(
      (result.project.artifacts ?? []).some(
        (artifact) => artifact.artifactId === midiArtifactId,
      ),
    ).toBe(true);
    expect(findClip(result.project, instrumentOutputClipId)).toBeUndefined();
  });

  it('blocks an unsupported Stage before allocating identity or calling the Engine', async () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const project = assignSoundFont(fixture.project);
    const coordinator = createUnsupportedCoordinator(
      requireReady(fixture.coordinatorReady),
    );
    const engine = createInstrumentClient('COMPLETED');
    const identity = createIdentityServices([]);

    const result = await runAutoPatchProductionDriver(
      engine.client,
      project,
      coordinator,
      verifiedSoundFonts,
      { identity: identity.services },
    );

    expect(result).toMatchObject({
      cause: 'production-stage-unsupported',
      coordinator,
      ok: false,
      project,
      reason: 'unsupported-stage',
      status: 'BLOCKED',
    });
    expect(identity.kinds).toEqual([]);
    expect(identity.clock).not.toHaveBeenCalled();
    expect(engine.client.enqueueInstrumentRenderJob).not.toHaveBeenCalled();
  });
});

function createStableAudio3DriverFixture(takes?: number): Readonly<{
  coordinator: AutoPatchReadyRuntimeCoordinator;
  project: ProjectState;
}> {
  const fixture = createAutoPatchMidiEditStageFixture();
  const validatedPreflight =
    createValidatedPreflightWithStableAudio3(
      fixture.coordinatorReady.validatedPreflight,
      takes,
    );
  const resolution = createAutoPatchRuntimeCoordinator({
    createdAt: fixture.coordinatorReady.createdAt,
    runId: 'run-production-driver-stable-audio-3',
    runtimeTargets: fixture.coordinatorReady.runtimeTargets,
    stageResults: fixture.coordinatorReady.stageResults,
    validatedPreflight,
  });

  if (!resolution.ok || resolution.coordinator.status !== 'READY') {
    throw new Error(
      resolution.ok
        ? 'Expected a READY Stable Audio 3 Coordinator.'
        : resolution.message,
    );
  }

  return Object.freeze({
    coordinator: resolution.coordinator,
    project: assignStableAudio3(assignSoundFont(fixture.project), takes),
  });
}

function createInstrumentAndStableAudio3Client(
  stableAudio3State: 'COMPLETED' | 'FAILED',
  cancelController?: AbortController,
  stableAudio3Times?: Readonly<{
    createdAt: string;
    finishedAt: string;
  }>,
): Readonly<{
  cancelJob: ReturnType<typeof vi.fn>;
  client: AutoPatchProductionDriverClient;
  enqueueStableAudio3Job: ReturnType<typeof vi.fn>;
  removeQueuedJob: ReturnType<typeof vi.fn>;
  readonly stableAudio3Request?: LocalEngineStableAudio3JobRequest;
}> {
  let activeJob: 'instrument' | 'stable-audio-3' | undefined;
  let instrumentRequest: LocalEngineInstrumentRenderJobRequest | undefined;
  let stableAudio3Request: LocalEngineStableAudio3JobRequest | undefined;
  const cancelJob = vi.fn();
  const enqueueStableAudio3Job = vi.fn(
    async (request: LocalEngineStableAudio3JobRequest) => {
      activeJob = 'stable-audio-3';
      stableAudio3Request = request;
      const job = createStableAudio3Job(
        request,
        'QUEUED',
        stableAudio3Times,
      );
      cancelController?.abort();
      return { job, ok: true as const };
    },
  );
  const removeQueuedJob = vi.fn(async (jobId: string) => {
    if (
      !stableAudio3Request ||
      jobId !== stableAudio3JobId ||
      activeJob !== 'stable-audio-3'
    ) {
      throw new Error('Queued Stable Audio 3 Job identity changed.');
    }

    return {
      ok: true as const,
      removedJob: createStableAudio3Job(
        stableAudio3Request,
        'QUEUED',
        stableAudio3Times,
      ),
    };
  });
  const client: AutoPatchProductionDriverClient = {
    cancelJob,
    enqueueInstrumentRenderJob: vi.fn(
      async (request: LocalEngineInstrumentRenderJobRequest) => {
        activeJob = 'instrument';
        instrumentRequest = request;
        return {
          job: createInstrumentJob(request, 'QUEUED'),
          ok: true as const,
        };
      },
    ),
    enqueueStableAudio3Job,
    getJobs: vi.fn(async () => {
      if (activeJob === 'instrument' && instrumentRequest) {
        return {
          ok: true as const,
          snapshot: {
            acceptingJobs: true,
            jobs: [createInstrumentJob(instrumentRequest, 'COMPLETED')],
          },
        };
      }

      if (activeJob === 'stable-audio-3' && stableAudio3Request) {
        return {
          ok: true as const,
          snapshot: {
            acceptingJobs: true,
            jobs: [
              createStableAudio3Job(
                stableAudio3Request,
                stableAudio3State,
                stableAudio3Times,
              ),
            ],
          },
        };
      }

      throw new Error('No production Driver Job was enqueued.');
    }),
    removeQueuedJob,
  };

  return {
    cancelJob,
    client,
    enqueueStableAudio3Job,
    removeQueuedJob,
    get stableAudio3Request() {
      return stableAudio3Request;
    },
  };
}

function createStableAudio3Job(
  request: LocalEngineStableAudio3JobRequest,
  state: 'COMPLETED' | 'FAILED' | 'QUEUED',
  times: Readonly<{
    createdAt: string;
    finishedAt: string;
  }> = {
    createdAt: '2026-07-31T00:00:51.000Z',
    finishedAt: '2026-07-31T00:01:00.000Z',
  },
): LocalEngineGpuJobRecord {
  const { createdAt, finishedAt } = times;
  const requestJson = request as Readonly<{
    [key: string]: LocalEngineJsonValue;
  }>;
  const seedSuffix =
    request.parameters.seed === 7 ? '' : `-seed-${request.parameters.seed}`;
  const jobId = `${stableAudio3JobId}${seedSuffix}`;
  const artifactId = `${stableAudio3ArtifactId}${seedSuffix}`;
  const base = {
    attempt: 1,
    createdAt,
    jobId,
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request: requestJson,
    startedAt: createdAt,
    taskId: request.taskId,
  };

  if (state === 'QUEUED') {
    return {
      ...base,
      history: [{ attempt: 1, at: createdAt, state }],
      state,
      updatedAt: createdAt,
    };
  }

  if (state === 'FAILED') {
    return {
      ...base,
      error: {
        code: 'PROVIDER_EXITED',
        message: 'Stable Audio 3 Provider exited unexpectedly.',
      },
      finishedAt,
      history: [
        { attempt: 1, at: createdAt, state: 'QUEUED' },
        { attempt: 1, at: finishedAt, state },
      ],
      state,
      updatedAt: finishedAt,
    };
  }

  return {
    ...base,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: createdAt, state: 'LOADING_MODEL' },
      { attempt: 1, at: createdAt, state: 'PROCESSING' },
      { attempt: 1, at: finishedAt, state: 'SAVING' },
      { attempt: 1, at: finishedAt, state },
    ],
    result: {
      artifact: {
        artifactId,
        createdAt: finishedAt,
        destination: 'stable-audio-3',
        file: {
          extension: '.wav',
          name: `${artifactId}.wav`,
          relativePath:
            `renders/stable-audio-3/${artifactId}.wav`,
          sizeBytes: 192_044,
        },
        kind: 'audio',
        lineage: request.lineage,
        provenance: {
          modelId: request.modelId,
          modelRevision: request.modelRevision,
          parameters: request.parameters,
          providerId: request.providerId,
          seed: request.parameters.seed,
          taskId: request.taskId,
        },
      },
      generation: {
        bytesWritten: 192_044,
        channels: 2,
        durationSeconds: request.parameters.durationSeconds,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    state,
    updatedAt: finishedAt,
  };
}

function createIdentityServices(
  timestamps: readonly string[],
  callbacks: Readonly<{
    onAllocate?: (kind: AutoPatchDriverIdentityKind) => void;
    onClock?: (callIndex: number) => void;
  }> = {},
): Readonly<{
  clock: ReturnType<typeof vi.fn>;
  kinds: AutoPatchDriverIdentityKind[];
  services: AutoPatchDriverIdentityServices;
}> {
  const kinds: AutoPatchDriverIdentityKind[] = [];
  const indexes = new Map<AutoPatchDriverIdentityKind, number>();
  const values: Record<
    AutoPatchDriverIdentityKind,
    readonly string[]
  > = {
    attempt: [
      'attempt-driver-1',
      'attempt-driver-2',
      'attempt-driver-3',
    ],
    'instrument-output-clip': [instrumentOutputClipId],
    'midi-artifact': [midiArtifactId],
    'midi-source-edit': [midiSourceEditId],
    'stage-result': [
      midiResultId,
      instrumentResultId,
      stableAudio3ResultId,
    ],
  };
  const clock = vi.fn(() => {
    const callIndex = clock.mock.calls.length - 1;
    callbacks.onClock?.(callIndex);
    const timestamp = timestamps[callIndex];

    if (!timestamp) {
      throw new Error('No test clock value remains.');
    }

    return timestamp;
  });
  const allocateId = (kind: AutoPatchDriverIdentityKind) => {
    kinds.push(kind);
    callbacks.onAllocate?.(kind);
    const index = indexes.get(kind) ?? 0;
    const value = values[kind][index];

    if (!value) {
      throw new Error(`No test identity remains for ${kind}.`);
    }

    indexes.set(kind, index + 1);
    return value;
  };

  return {
    clock,
    kinds,
    services: Object.freeze({ allocateId, clock }),
  };
}

function createInstrumentClient(
  finalState: 'COMPLETED' | 'FAILED',
): Readonly<{
  client: AutoPatchStageRunnerClient & Readonly<{
    enqueueInstrumentRenderJob: ReturnType<typeof vi.fn>;
  }> & StableAudio3StageRunnerClient;
  request?: LocalEngineInstrumentRenderJobRequest;
}> {
  let request: LocalEngineInstrumentRenderJobRequest | undefined;
  const client = {
    cancelJob: vi.fn(),
    enqueueInstrumentRenderJob: vi.fn(
      async (nextRequest: LocalEngineInstrumentRenderJobRequest) => {
        request = nextRequest;
        return {
          job: createInstrumentJob(nextRequest, 'QUEUED'),
          ok: true as const,
        };
      },
    ),
    enqueueStableAudio3Job: vi.fn(async () => {
      throw new Error('Stable Audio 3 was not expected in this test.');
    }),
    getJobs: vi.fn(async () => {
      if (!request) {
        throw new Error('Instrument request was not enqueued.');
      }

      return {
        ok: true as const,
        snapshot: {
          acceptingJobs: true,
          jobs: [createInstrumentJob(request, finalState)],
        },
      };
    }),
    removeQueuedJob: vi.fn(),
  };

  return {
    client,
    get request() {
      return request;
    },
  };
}

function createCancelingInstrumentClient(
  controller: AbortController,
): Readonly<{
  cancelJob: ReturnType<typeof vi.fn>;
  client: AutoPatchStageRunnerClient & Readonly<{
    enqueueInstrumentRenderJob: ReturnType<typeof vi.fn>;
  }> & StableAudio3StageRunnerClient;
  removeQueuedJob: ReturnType<typeof vi.fn>;
}> {
  let queuedJob: LocalEngineGpuJobRecord | undefined;
  const cancelJob = vi.fn();
  const removeQueuedJob = vi.fn(async (jobId: string) => {
    if (!queuedJob || queuedJob.jobId !== jobId) {
      throw new Error('Queued Instrument Job identity changed.');
    }

    return { ok: true as const, removedJob: queuedJob };
  });
  const client = {
    cancelJob,
    enqueueInstrumentRenderJob: vi.fn(
      async (request: LocalEngineInstrumentRenderJobRequest) => {
        queuedJob = createInstrumentJob(request, 'QUEUED');
        controller.abort();
        return { job: queuedJob, ok: true as const };
      },
    ),
    enqueueStableAudio3Job: vi.fn(async () => {
      throw new Error('Stable Audio 3 was not expected in this test.');
    }),
    getJobs: vi.fn(async () => {
      if (!queuedJob) {
        throw new Error('Instrument request was not enqueued.');
      }

      return {
        ok: true as const,
        snapshot: { acceptingJobs: true, jobs: [queuedJob] },
      };
    }),
    removeQueuedJob,
  };

  return { cancelJob, client, removeQueuedJob };
}

function createInstrumentJob(
  request: LocalEngineInstrumentRenderJobRequest,
  state: 'COMPLETED' | 'FAILED' | 'QUEUED',
): LocalEngineGpuJobRecord {
  const createdAt = '2026-07-31T00:00:31.000Z';
  const finishedAt = '2026-07-31T00:00:40.000Z';
  const requestJson = request as Readonly<{
    [key: string]: LocalEngineJsonValue;
  }>;
  const base = {
    attempt: 1,
    createdAt,
    jobId: engineJobId,
    modelId: request.modelId,
    modelRevision: request.modelRevision,
    providerId: request.providerId,
    request: requestJson,
    taskId: request.taskId,
  };

  if (state === 'QUEUED') {
    return {
      ...base,
      history: [{ attempt: 1, at: createdAt, state }],
      state,
      updatedAt: createdAt,
    };
  }

  if (state === 'FAILED') {
    return {
      ...base,
      error: {
        code: 'SOUNDFONT_OFFLINE',
        message: 'SoundFont is offline.',
      },
      finishedAt,
      history: [
        { attempt: 1, at: createdAt, state: 'QUEUED' },
        { attempt: 1, at: finishedAt, state },
      ],
      state,
      updatedAt: finishedAt,
    };
  }

  return {
    ...base,
    finishedAt,
    history: [
      { attempt: 1, at: createdAt, state: 'QUEUED' },
      { attempt: 1, at: createdAt, state: 'PROCESSING' },
      { attempt: 1, at: finishedAt, state: 'SAVING' },
      { attempt: 1, at: finishedAt, state },
    ],
    result: {
      artifact: {
        artifactId: engineArtifactId,
        createdAt: finishedAt,
        destination: 'instrument',
        file: {
          extension: '.wav',
          name: `${engineArtifactId}.wav`,
          relativePath: `renders/instruments/${engineArtifactId}.wav`,
          sizeBytes: 192_044,
        },
        kind: 'audio',
        lineage: request.lineage,
        provenance: {
          modelId: request.modelId,
          modelRevision: request.modelRevision,
          parameters: request.parameters,
          providerId: request.providerId,
          taskId: request.taskId,
        },
      },
      generation: {
        bytesWritten: 192_044,
        channels: 2,
        durationSeconds: 1,
        mimeType: 'audio/wav',
        providerCompletedAt: finishedAt,
      },
    },
    state,
    updatedAt: finishedAt,
  };
}

function assignSoundFont(project: ProjectState): ProjectState {
  const instrumentDefinition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
  );

  return {
    ...project,
    patchTabs: [
      ...project.patchTabs,
      {
        colorIndex: 3,
        description: 'Render MIDI through the assigned SoundFont.',
        id: stageInstrumentId,
        inputType: 'Edited MIDI',
        name: 'MIDI TO AUDIO',
        nodeTypeId: instrumentDefinition.nodeTypeId,
        nodeVersion: instrumentDefinition.nodeVersion,
        outputType: 'Instrument Audio',
        parameters: [],
        status: 'ready',
      },
    ],
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === targetClipId
          ? {
              ...clip,
              soundFont: {
                bank: 0,
                program: 0,
                resource: {
                  format: 'sf2' as const,
                  library: 'project' as const,
                  relativePath: 'soundfonts/Piano.sf2',
                  resourceId: soundFontResourceId,
                },
              },
            }
          : clip,
      ),
    })),
  };
}

function assignStableAudio3(project: ProjectState, takes?: number): ProjectState {
  const definition = requireDefinition(
    BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
  );

  return {
    ...project,
    connections: [
      ...project.connections,
      {
        activation: 'on',
        createdOrder: 2,
        enabled: true,
        fromPatchTabId: stageInstrumentId,
        fromPortId: 'audio-out',
        id: stableAudio3ConnectionId,
        latencyMs: 0,
        order: 2,
        signalType: 'Instrument Audio',
        toPatchTabId: stageStableAudio3Id,
        toPortId: 'audio-in',
      },
    ],
    patchTabs: [
      ...project.patchTabs,
      {
        colorIndex: 4,
        description: 'Transform the Active Instrument Audio Take.',
        id: stageStableAudio3Id,
        inputBindings: [
          {
            connectionIds: [stableAudio3ConnectionId],
            kind: 'connection',
            portId: 'audio-in',
          },
        ],
        inputType: 'Instrument Audio',
        name: 'Stable Audio 3',
        nodeTypeId: definition.nodeTypeId,
        nodeVersion: definition.nodeVersion,
        outputType: 'Instrument Audio',
        parameters: [
          {
            id: 'prompt',
            kind: 'text',
            label: 'Prompt',
            value: 'Continue as a polished instrumental arrangement',
          },
          {
            id: 'durationSeconds',
            kind: 'slider',
            label: 'Duration',
            max: 380,
            min: 1,
            step: 1,
            unit: 's',
            value: 1,
          },
          {
            id: 'seed',
            kind: 'slider',
            label: 'Seed',
            max: 0xffff_ffff,
            min: 0,
            step: 1,
            value: 7,
          },
          ...(takes === undefined
            ? []
            : [
                {
                  id: 'takes',
                  kind: 'number' as const,
                  label: 'Takes',
                  max: 3,
                  min: 1,
                  step: 1,
                  value: takes,
                },
              ]),
          {
            id: 'strength',
            kind: 'slider',
            label: 'Strength',
            max: 1,
            min: 0,
            step: 0.05,
            value: 0.4,
          },
        ],
        status: 'ready',
      },
    ],
  };
}

function createUnsupportedCoordinator(
  coordinator: AutoPatchReadyRuntimeCoordinator,
): AutoPatchReadyRuntimeCoordinator {
  return Object.freeze({
    ...coordinator,
    validatedPreflight: Object.freeze({
      ...coordinator.validatedPreflight,
      plan: Object.freeze({
        ...coordinator.validatedPreflight.plan,
        graphSnapshot: Object.freeze({
          ...coordinator.validatedPreflight.plan.graphSnapshot,
          families:
            coordinator.validatedPreflight.plan.graphSnapshot.families.map(
              (family, familyIndex) =>
                familyIndex === 0
                  ? Object.freeze({
                      ...family,
                      patchTabs: family.patchTabs.map(
                        (patchTab, patchTabIndex) =>
                          patchTabIndex === 0
                            ? Object.freeze({
                                ...patchTab,
                                nodeTypeId: 'humstudio.custom.unsupported',
                              })
                            : patchTab,
                      ),
                    })
                  : family,
            ),
        }),
      }),
    }),
  });
}

function requireReady(
  coordinator: AutoPatchRuntimeCoordinator,
): AutoPatchReadyRuntimeCoordinator {
  if (coordinator.status !== 'READY') {
    throw new Error('Expected one READY Auto Patch Coordinator.');
  }

  return coordinator;
}

function findClip(project: ProjectState, clipId: string) {
  return project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId);
}
