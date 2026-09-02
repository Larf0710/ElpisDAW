import { describe, expect, it } from 'vitest';

import {
  createPrintMixArtifactId,
  PRINT_MIX_PROTOCOL_VERSION,
} from '../shared/printMixProtocol.js';
import { resolveActiveMidiTake } from './activeMidiTake';
import { resolveActiveAudioTakeSource } from './activeAudioTakeSource';
import { resolveClipFilerFinalExportTarget } from './clipFilerFinalExportTarget';
import {
  normalizeClipTakeState,
  normalizeProjectArtifacts,
} from './projectArtifactRegistration';
import { createProjectDirtyStateFingerprint } from './projectDirtyStateFingerprint';
import {
  createCompletedPrintMixMidiOperation,
  createPrintMixPlanSha256,
  createPrintMixRequest,
  type PrintMixOperation,
  type PrintMixRequest,
} from './printMixOperation';
import { createPrintMixPlan } from './printMixPlan';
import {
  createPrintMixRegistrationIntent,
  createPrintMixTrackRegistration,
} from './printMixRegistration';
import {
  PRINT_MIX_TEST_CREATED_AT,
  PRINT_MIX_TEST_OPERATION_ID,
  createPrintMixAudioProject,
  createPrintMixMidiProject,
} from './printMixTestFixture';

describe('PRINT MIX registration', () => {
  it('registers one finalized Audio Artifact, Take, Clip, and muted Track atomically while preserving originals', async () => {
    const project = createPrintMixAudioProject();
    const originalTracks = [...project.tracks];
    const request = createRequest(project);
    const intentResult = createPrintMixRegistrationIntent(project, request);
    const operation = await createAudioOperation(request);

    expect(intentResult.canCreate).toBe(true);
    if (!intentResult.canCreate) {
      throw new Error(intentResult.message);
    }

    const beforeFingerprint = createProjectDirtyStateFingerprint(project);
    const artifactId = createPrintMixArtifactId(request.operationId) as string;
    const result = await createPrintMixTrackRegistration(
      project,
      request,
      operation,
      {
        intent: intentResult.intent,
        sourceAvailability: {
          availableArtifactIds: [artifactId],
          checkedAt: PRINT_MIX_TEST_CREATED_AT,
        },
      },
    );

    expect(result).toMatchObject({
      canRegister: true,
      status: 'REGISTERED',
      artifact: {
        destination: 'print-mix',
        kind: 'audio',
        sourceOperationId: PRINT_MIX_TEST_OPERATION_ID,
      },
      clipTake: {
        mediaType: 'audio',
        sourceType: 'print-mix',
      },
    });
    if (!result.canRegister) {
      throw new Error(result.message);
    }

    expect(result.project.tracks).toHaveLength(3);
    expect(result.project.tracks[0]).toEqual(originalTracks[0]);
    expect(result.project.tracks[1]).toEqual(originalTracks[1]);
    expect(result.project.tracks[2]).toMatchObject({
      clips: [
        {
          lengthTicks: 2_880,
          sourceFile: { sourceId: artifactId, status: 'available' },
          startTick: 960,
          type: 'mixdown',
        },
      ],
      muted: true,
      type: 'audio',
    });
    expect(result.artifact.lineage).toEqual({
      parentArtifactIds: [
        'artifact-audio-source-1',
        'artifact-audio-source-2',
      ],
      parentClipTakeIds: [
        'clip-take-audio-source-1',
        'clip-take-audio-source-2',
      ],
    });
    expect(createProjectDirtyStateFingerprint(result.project)).not.toBe(
      beforeFingerprint,
    );

    const outputClip = result.project.tracks[2].clips[0];
    const reopened = structuredClone(result.project);
    reopened.artifacts = normalizeProjectArtifacts(
      JSON.parse(JSON.stringify(result.project.artifacts)),
    );
    reopened.tracks[2].clips[0] = {
      ...reopened.tracks[2].clips[0],
      ...normalizeClipTakeState(
        JSON.parse(JSON.stringify(outputClip.clipTakes)),
        outputClip.activeClipTakeId,
      ),
    };
    expect(
      resolveActiveAudioTakeSource(reopened, outputClip.id),
    ).toMatchObject({ canResolve: true });
    expect(
      resolveClipFilerFinalExportTarget(
        reopened,
        {
          colorIndex: 4,
          description: 'Production output settings.',
          id: 'legacy-clip-filer',
          inputType: 'Selected Clip',
          name: 'Clip Filer',
          outputType: 'Export File',
          parameters: [
            {
              id: 'format',
              kind: 'select',
              label: 'Format',
              options: ['WAV', 'MP3', 'MIDI'],
              value: 'WAV',
            },
            {
              id: 'normalize',
              kind: 'select',
              label: 'Normalize',
              options: ['On', 'Off'],
              value: 'Off',
            },
          ],
          status: 'ready',
        },
        outputClip.id,
      ),
    ).toMatchObject({
      canExport: false,
      cause: 'source-artifact-invalid',
    });

    const recovered = await createPrintMixTrackRegistration(
      result.project,
      request,
      operation,
      { intent: intentResult.intent },
    );
    expect(recovered).toMatchObject({
      canRegister: true,
      status: 'ALREADY_REGISTERED',
    });
    if (recovered.canRegister) {
      expect(recovered.project).toBe(result.project);
    }
  });

  it('keeps Audio Project state invariant on unavailable, stale, ambiguous, or partial completion evidence', async () => {
    const unavailableProject = createPrintMixAudioProject();
    const unavailableRequest = createRequest(unavailableProject);
    const unavailableIntent = createPrintMixRegistrationIntent(
      unavailableProject,
      unavailableRequest,
    );
    const unavailableOperation = await createAudioOperation(unavailableRequest);
    if (!unavailableIntent.canCreate) {
      throw new Error(unavailableIntent.message);
    }
    const unavailableBefore = JSON.stringify(unavailableProject);
    expect(
      await createPrintMixTrackRegistration(
        unavailableProject,
        unavailableRequest,
        unavailableOperation,
        { intent: unavailableIntent.intent },
      ),
    ).toMatchObject({
      canRegister: false,
      reason: 'artifact-unavailable',
    });
    expect(JSON.stringify(unavailableProject)).toBe(unavailableBefore);

    const staleProject = createPrintMixAudioProject();
    const staleRequest = createRequest(staleProject);
    const staleIntent = createPrintMixRegistrationIntent(staleProject, staleRequest);
    if (!staleIntent.canCreate) {
      throw new Error(staleIntent.message);
    }
    const staleArtifact = staleProject.artifacts?.[0];
    if (!staleArtifact || staleArtifact.kind !== 'audio') {
      throw new Error('Missing stale Artifact fixture.');
    }
    staleArtifact.file.sizeBytes += 4;
    const staleBefore = JSON.stringify(staleProject);
    expect(
      await createPrintMixTrackRegistration(
        staleProject,
        staleRequest,
        await createAudioOperation(staleRequest),
        {
          intent: staleIntent.intent,
          sourceAvailability: {
            availableArtifactIds: [staleIntent.intent.output.artifactId],
            checkedAt: PRINT_MIX_TEST_CREATED_AT,
          },
        },
      ),
    ).toMatchObject({ canRegister: false });
    expect(JSON.stringify(staleProject)).toBe(staleBefore);

    const collisionProject = createPrintMixAudioProject();
    const collisionRequest = createRequest(collisionProject);
    const collisionIntent = createPrintMixRegistrationIntent(
      collisionProject,
      collisionRequest,
    );
    if (!collisionIntent.canCreate) {
      throw new Error(collisionIntent.message);
    }
    collisionProject.tracks.push({
      clips: [],
      id: collisionIntent.intent.output.trackId,
      level: 0,
      name: 'Partial Collision',
      type: 'audio',
    });
    const collisionBefore = JSON.stringify(collisionProject);
    expect(
      await createPrintMixTrackRegistration(
        collisionProject,
        collisionRequest,
        await createAudioOperation(collisionRequest),
        {
          intent: collisionIntent.intent,
          sourceAvailability: {
            availableArtifactIds: [collisionIntent.intent.output.artifactId],
            checkedAt: PRINT_MIX_TEST_CREATED_AT,
          },
        },
      ),
    ).toMatchObject({ canRegister: false, reason: 'identity-conflict' });
    expect(JSON.stringify(collisionProject)).toBe(collisionBefore);

    const malformed = structuredClone(
      await createAudioOperation(unavailableRequest),
    ) as unknown as {
      result: { artifact: { file: { relativePath: string } } };
    };
    malformed.result.artifact.file.relativePath = 'mixdowns/wrong.wav';
    expect(
      await createPrintMixTrackRegistration(
        unavailableProject,
        unavailableRequest,
        malformed,
        { intent: unavailableIntent.intent },
      ),
    ).toMatchObject({ canRegister: false, reason: 'operation-invalid' });
  });

  it('registers merged MIDI without timbre data, survives normalization/reopen, and marks persistence dirty', async () => {
    const project = createPrintMixMidiProject();
    const request = createRequest(project);
    if (request.plan.mediaType !== 'midi') {
      throw new Error('Missing MIDI Request fixture.');
    }
    const intent = createPrintMixRegistrationIntent(project, request);
    if (!intent.canCreate) {
      throw new Error(intent.message);
    }
    const operation = await createCompletedPrintMixMidiOperation(
      request as PrintMixRequest & { plan: typeof request.plan },
      () => new Date(PRINT_MIX_TEST_CREATED_AT),
    );
    const beforeFingerprint = createProjectDirtyStateFingerprint(project);
    const originalTracks = [...project.tracks];
    const result = await createPrintMixTrackRegistration(
      project,
      request,
      operation,
      { intent: intent.intent },
    );

    expect(result).toMatchObject({
      canRegister: true,
      status: 'REGISTERED',
      artifact: { kind: 'midi' },
      clipTake: { mediaType: 'midi', sourceType: 'print-mix' },
    });
    if (!result.canRegister || result.artifact.kind !== 'midi') {
      throw new Error('MIDI PRINT MIX registration failed.');
    }

    const outputTrack = result.project.tracks[2];
    expect(result.project.tracks[0]).toEqual(originalTracks[0]);
    expect(result.project.tracks[1]).toEqual(originalTracks[1]);
    expect(outputTrack).toMatchObject({ muted: true, type: 'midi' });
    expect(outputTrack.clips[0]).not.toHaveProperty('soundFont');
    expect(result.artifact.midi.notes.map(({ pitch, startTick, lengthTicks, velocity }) => ({
      pitch,
      startTick,
      lengthTicks,
      velocity,
    }))).toEqual([
      { lengthTicks: 480, pitch: 60, startTick: 0, velocity: 91 },
      { lengthTicks: 480, pitch: 60, startTick: 0, velocity: 91 },
      { lengthTicks: 960, pitch: 67, startTick: 1_920, velocity: 73 },
    ]);
    expect(createProjectDirtyStateFingerprint(result.project)).not.toBe(
      beforeFingerprint,
    );

    const normalizedArtifacts = normalizeProjectArtifacts(
      JSON.parse(JSON.stringify(result.project.artifacts)),
    );
    const outputClip = outputTrack.clips[0];
    const normalizedTakeState = normalizeClipTakeState(
      JSON.parse(JSON.stringify(outputClip.clipTakes)),
      outputClip.activeClipTakeId,
    );
    const reopened = structuredClone(result.project);
    reopened.artifacts = normalizedArtifacts;
    reopened.tracks[2].clips[0] = {
      ...reopened.tracks[2].clips[0],
      ...normalizedTakeState,
    };

    expect(normalizedArtifacts).toContainEqual(result.artifact);
    expect(normalizedTakeState.clipTakes).toContainEqual(result.clipTake);
    expect(
      resolveActiveMidiTake(reopened, outputClip.id),
    ).toMatchObject({ canResolve: true });
  });

  it('drops tampered persisted PRINT MIX Artifact and Take identity fail-closed', async () => {
    const project = createPrintMixMidiProject();
    const request = createRequest(project);
    if (request.plan.mediaType !== 'midi') {
      throw new Error('Missing MIDI Request fixture.');
    }
    const intent = createPrintMixRegistrationIntent(project, request);
    if (!intent.canCreate) {
      throw new Error(intent.message);
    }
    const operation = await createCompletedPrintMixMidiOperation(
      request as PrintMixRequest & { plan: typeof request.plan },
      () => new Date(PRINT_MIX_TEST_CREATED_AT),
    );
    const registered = await createPrintMixTrackRegistration(
      project,
      request,
      operation,
      { intent: intent.intent },
    );
    if (!registered.canRegister || registered.artifact.kind !== 'midi') {
      throw new Error('Missing registered MIDI PRINT MIX fixture.');
    }

    const tamperedArtifact = structuredClone(registered.artifact);
    tamperedArtifact.midi.notes[0].velocity -= 1;
    const tamperedTake = structuredClone(registered.clipTake);
    tamperedTake.sourceOperationId =
      'print-mix-operation-22222222-2222-4222-8222-222222222222';

    expect(normalizeProjectArtifacts([tamperedArtifact])).toEqual([]);
    expect(
      normalizeClipTakeState([tamperedTake], tamperedTake.clipTakeId),
    ).toEqual({});
  });
});

function createRequest(project: ReturnType<typeof createPrintMixAudioProject>): PrintMixRequest;
function createRequest(project: ReturnType<typeof createPrintMixMidiProject>): PrintMixRequest;
function createRequest(project: ReturnType<typeof createPrintMixAudioProject>): PrintMixRequest {
  const plan = createPrintMixPlan(
    project,
    'print-mix',
    project.selection,
    PRINT_MIX_TEST_OPERATION_ID,
  );
  if (!plan.canCreate) {
    throw new Error(plan.message);
  }
  return createPrintMixRequest(plan.plan);
}

async function createAudioOperation(
  request: PrintMixRequest,
): Promise<PrintMixOperation> {
  if (request.plan.mediaType !== 'audio') {
    throw new Error('Audio PRINT MIX Request required.');
  }
  const artifactId = createPrintMixArtifactId(request.operationId) as string;
  const frameCount = Math.round(request.plan.durationSeconds * 44_100);
  const planSha256 = await createPrintMixPlanSha256(request.plan);
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
          sizeBytes: 44 + frameCount * 4,
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
        appliedGain: 1,
        bitsPerSample: 16,
        bytesWritten: 44 + frameCount * 4,
        channels: 2,
        clippingWarning: false,
        durationSeconds: frameCount / 44_100,
        frameCount,
        mediaType: 'audio',
        mimeType: 'audio/wav',
        normalize: request.plan.normalize,
        outputPeak: 0,
        preNormalizationPeak: 0,
        sampleRate: 44_100,
        sourceCount: request.plan.sources.length,
        targetPeakDbfs: -1,
      },
      status: 'COMPLETED',
    },
  };
}
