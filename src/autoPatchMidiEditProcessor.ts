import {
  createAutoPatchMidiEditProcessorOutcome,
  type AutoPatchMidiEditProcessorOutcome,
  type AutoPatchMidiEditStagePlan,
} from './autoPatchMidiEditStage';
import {
  resolveAutoPatchMidiEditProductionCapability,
} from './autoPatchMidiEditProductionCapability';
import { snapMidiTick } from './midiNoteEditing';
import type { MidiNote, TimelineGridResolution } from './types';
import { getTimelineGridResolutionTickStep } from './workflow';

export type AutoPatchMidiEditProcessorResolution =
  | Readonly<{
      canProcess: true;
      gridResolution: TimelineGridResolution;
      gridStepTicks: number;
      outcome: AutoPatchMidiEditProcessorOutcome;
    }>
  | Readonly<{
      canProcess: false;
      cause: string;
      message: string;
      reason:
        | 'parameter-invalid'
        | 'parameter-unsupported'
        | 'processing-failed';
    }>;

export type AutoPatchMidiEditContentProcessingResolution =
  | Readonly<{
      canProcess: true;
      gridResolution: TimelineGridResolution;
      gridStepTicks: number;
      notes: readonly MidiNote[];
    }>
  | Extract<
      AutoPatchMidiEditProcessorResolution,
      { canProcess: false }
    >;

export function processAutoPatchMidiEditStage(
  plan: AutoPatchMidiEditStagePlan,
  input: Readonly<{ finishedAt: string }>,
): AutoPatchMidiEditProcessorResolution {
  const content = processAutoPatchMidiEditStageContent(plan);

  if (!content.canProcess) {
    return content;
  }

  return completeAutoPatchMidiEditProcessing(
    plan,
    content,
    input.finishedAt,
  );
}

export function processAutoPatchMidiEditStageContent(
  plan: AutoPatchMidiEditStagePlan,
): AutoPatchMidiEditContentProcessingResolution {
  const capabilityResolution =
    resolveAutoPatchMidiEditProductionCapability(
      plan.parameters,
    );

  if (!capabilityResolution.productionReady) {
    return failure(
      capabilityResolution.reason,
      capabilityResolution.cause,
      capabilityResolution.message,
    );
  }

  const gridResolution = capabilityResolution.gridResolution;
  const gridStepTicks = getTimelineGridResolutionTickStep(
    gridResolution,
  );

  try {
    return Object.freeze({
      canProcess: true as const,
      gridResolution,
      gridStepTicks,
      notes: Object.freeze(
        plan.source.midi.notes.map((note) =>
          Object.freeze({
            ...note,
            startTick: snapMidiTick(note.startTick, gridStepTicks),
          }),
        ),
      ),
    });
  } catch (error) {
    return failure(
      'processing-failed',
      'midi-edit-processing-failed',
      error instanceof Error
        ? `Automatic MIDI Edit failed: ${error.message}`
        : 'Automatic MIDI Edit failed for an unknown reason.',
    );
  }
}

export function completeAutoPatchMidiEditProcessing(
  plan: AutoPatchMidiEditStagePlan,
  content: Extract<
    AutoPatchMidiEditContentProcessingResolution,
    { canProcess: true }
  >,
  finishedAt: string,
): AutoPatchMidiEditProcessorResolution {
  try {
    const outcome = createAutoPatchMidiEditProcessorOutcome(plan, {
      finishedAt,
      notes: content.notes,
    });

    return Object.freeze({
      canProcess: true as const,
      gridResolution: content.gridResolution,
      gridStepTicks: content.gridStepTicks,
      outcome,
    });
  } catch (error) {
    return failure(
      'processing-failed',
      'midi-edit-processing-failed',
      error instanceof Error
        ? `Automatic MIDI Edit failed: ${error.message}`
        : 'Automatic MIDI Edit failed for an unknown reason.',
    );
  }
}

function failure(
  reason: Extract<
    AutoPatchMidiEditProcessorResolution,
    { canProcess: false }
  >['reason'],
  cause: string,
  message: string,
): Extract<
  AutoPatchMidiEditProcessorResolution,
  { canProcess: false }
> {
  return Object.freeze({ canProcess: false, cause, message, reason });
}
