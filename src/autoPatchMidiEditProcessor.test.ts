import { describe, expect, it } from 'vitest';

import {
  processAutoPatchMidiEditStage,
} from './autoPatchMidiEditProcessor';
import {
  resolveAutoPatchMidiEditProductionCapability,
} from './autoPatchMidiEditProductionCapability';
import {
  createAutoPatchMidiEditStageFixture,
} from './autoPatchMidiEditStage.testFixture';
import { tabFlowPresets } from './presets';
import { sampleProject } from './sampleProject';
import type {
  MidiNote,
  PatchTabParameter,
  TimelineGridResolution,
} from './types';

describe('Auto Patch MIDI Edit processor', () => {
  it('declares the contract-correct Basic Quantize fixture production-ready', () => {
    const fixture = createAutoPatchMidiEditStageFixture();

    expect(
      resolveAutoPatchMidiEditProductionCapability(
        fixture.plan.parameters,
      ),
    ).toEqual({
      productionReady: true,
      gridResolution: '1/16',
    });
  });

  it('keeps current visible MIDI Edit contracts aligned with Basic Quantize production', () => {
    const visibleMidiEditPatchTabs = [
      ...sampleProject.patchTabs.filter(
        (patchTab) => patchTab.outputType === 'Edited MIDI',
      ),
      ...tabFlowPresets.flatMap((preset) =>
        preset.project.patchTabs.filter(
          (patchTab) => patchTab.outputType === 'Edited MIDI',
        ),
      ),
    ];

    expect(visibleMidiEditPatchTabs).toHaveLength(3);
    visibleMidiEditPatchTabs.forEach((patchTab) => {
      expect(patchTab.parameters).toEqual([
        {
          id: 'quantize',
          label: 'Quantize',
          kind: 'select',
          value: '1/16',
          options: ['1/8', '1/16', '1/32', '1/64'],
        },
      ]);
      expect(
        resolveAutoPatchMidiEditProductionCapability(
          patchTab.parameters,
        ),
      ).toEqual({
        productionReady: true,
        gridResolution: '1/16',
      });
    });
  });

  it('quantizes note starts to the nearest 1/16 grid without changing note content', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const sourceNote = fixture.plan.source.midi.notes[0];
    const result = processAutoPatchMidiEditStage(fixture.plan, {
      finishedAt: '2026-07-31T00:00:30.000Z',
    });

    expect(result).toMatchObject({
      canProcess: true,
      gridResolution: '1/16',
      gridStepTicks: 240,
      outcome: {
        notes: [
          {
            ...sourceNote,
            startTick: 240,
          },
        ],
        status: 'MIDI_EDIT_COMPLETED',
      },
    });
    expect(fixture.plan.source.midi.notes[0].startTick).toBe(121);
  });

  it.each([
    ['1/8', 480, 480],
    ['1/16', 240, 240],
    ['1/32', 120, 360],
    ['1/64', 60, 300],
  ] as const)(
    'uses the canonical %s grid step',
    (gridResolution, gridStepTicks, expectedStartTick) => {
      const result = processAutoPatchMidiEditStage(
        createPlanWithNotes(
          [createNote({ startTick: 301 })],
          gridResolution,
        ),
        { finishedAt: '2026-07-31T00:00:30.000Z' },
      );

      expect(result.canProcess).toBe(true);
      if (!result.canProcess) {
        throw new Error(result.message);
      }

      expect(result.gridStepTicks).toBe(gridStepTicks);
      expect(result.outcome.notes[0].startTick).toBe(
        expectedStartTick,
      );
    },
  );

  it('rounds an exact midpoint forward deterministically', () => {
    const plan = createPlanWithNotes([
      createNote({ id: 'midpoint', startTick: 120 }),
    ]);
    const result = processAutoPatchMidiEditStage(plan, {
      finishedAt: '2026-07-31T00:00:30.000Z',
    });

    expect(result.canProcess).toBe(true);
    if (!result.canProcess) {
      throw new Error(result.message);
    }

    expect(result.outcome.notes[0].startTick).toBe(240);
  });

  it('supports the canonical 1/64 grid and preserves lengths and confidence', () => {
    const notes = [
      createNote({ id: 'before-midpoint', startTick: 29 }),
      createNote({
        confidence: 0.75,
        id: 'at-midpoint',
        lengthTicks: 73,
        pitch: 64,
        startTick: 30,
        velocity: 83,
      }),
      createNote({ id: 'after-grid', startTick: 91 }),
    ];
    const plan = createPlanWithNotes(notes, '1/64');
    const result = processAutoPatchMidiEditStage(plan, {
      finishedAt: '2026-07-31T00:00:30.000Z',
    });

    expect(result.canProcess).toBe(true);
    if (!result.canProcess) {
      throw new Error(result.message);
    }

    expect(result.gridStepTicks).toBe(60);
    expect(result.outcome.notes.map((note) => note.startTick)).toEqual([
      0,
      60,
      120,
    ]);
    expect(result.outcome.notes[1]).toMatchObject({
      confidence: 0.75,
      lengthTicks: 73,
      pitch: 64,
      velocity: 83,
    });
  });

  it('accepts an empty MIDI source without inventing notes', () => {
    const result = processAutoPatchMidiEditStage(
      createPlanWithNotes([]),
      { finishedAt: '2026-07-31T00:00:30.000Z' },
    );

    expect(result).toMatchObject({
      canProcess: true,
      outcome: { notes: [] },
    });
  });

  it('rejects missing and duplicate Quantize parameters', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const parameter = createQuantizeParameter('1/16');

    expect(
      processAutoPatchMidiEditStage(
        { ...fixture.plan, parameters: [] },
        { finishedAt: '2026-07-31T00:00:30.000Z' },
      ),
    ).toMatchObject({
      canProcess: false,
      cause: 'midi-edit-quantize-parameter-invalid',
      reason: 'parameter-invalid',
    });
    expect(
      processAutoPatchMidiEditStage(
        { ...fixture.plan, parameters: [parameter, parameter] },
        { finishedAt: '2026-07-31T00:00:30.000Z' },
      ),
    ).toMatchObject({
      canProcess: false,
      cause: 'midi-edit-quantize-parameter-invalid',
      reason: 'parameter-invalid',
    });
  });

  it('rejects slider and undeclared grid values', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const invalidParameters: readonly PatchTabParameter[][] = [
      [
        {
          id: 'quantize',
          kind: 'slider',
          label: 'Quantize',
          max: 1,
          min: 0,
          step: 0.1,
          value: 1,
        },
      ],
      [
        {
          id: 'quantize',
          kind: 'select',
          label: 'Quantize',
          options: ['Off'],
          value: 'Off',
        },
      ],
      [
        {
          id: 'quantize',
          kind: 'select',
          label: 'Quantize',
          options: ['1/8'],
          value: '1/16',
        },
      ],
    ];

    invalidParameters.forEach((parameters) => {
      expect(
        processAutoPatchMidiEditStage(
          { ...fixture.plan, parameters },
          { finishedAt: '2026-07-31T00:00:30.000Z' },
        ),
      ).toMatchObject({
        canProcess: false,
        cause: 'midi-edit-quantize-parameter-invalid',
        reason: 'parameter-invalid',
      });
    });
  });

  it('rejects advanced parameters instead of silently ignoring them', () => {
    const fixture = createAutoPatchMidiEditStageFixture();
    const result = processAutoPatchMidiEditStage(
      {
        ...fixture.plan,
        parameters: [
          createQuantizeParameter('1/16'),
          {
            id: 'swing',
            kind: 'slider',
            label: 'Swing',
            max: 100,
            min: 0,
            step: 1,
            unit: '%',
            value: 50,
          },
        ],
      },
      { finishedAt: '2026-07-31T00:00:30.000Z' },
    );

    expect(result).toMatchObject({
      canProcess: false,
      cause: 'midi-edit-parameter-unsupported',
      reason: 'parameter-unsupported',
    });
  });

  it('returns a processing failure for an invalid completion timestamp', () => {
    const fixture = createAutoPatchMidiEditStageFixture();

    expect(
      processAutoPatchMidiEditStage(fixture.plan, {
        finishedAt: '2026-07-30T23:59:59.000Z',
      }),
    ).toMatchObject({
      canProcess: false,
      cause: 'midi-edit-processing-failed',
      reason: 'processing-failed',
    });
  });
});

function createPlanWithNotes(
  notes: readonly MidiNote[],
  gridResolution: TimelineGridResolution = '1/16',
) {
  const fixture = createAutoPatchMidiEditStageFixture();

  return {
    ...fixture.plan,
    parameters: [createQuantizeParameter(gridResolution)],
    source: {
      ...fixture.plan.source,
      midi: {
        ...fixture.plan.source.midi,
        notes,
      },
    },
  };
}

function createQuantizeParameter(
  value: TimelineGridResolution,
): PatchTabParameter {
  return {
    id: 'quantize',
    kind: 'select',
    label: 'Quantize',
    options: ['1/8', '1/16', '1/32', '1/64'],
    value,
  };
}

function createNote(overrides: Partial<MidiNote>): MidiNote {
  return {
    id: 'note',
    lengthTicks: 240,
    pitch: 60,
    startTick: 0,
    velocity: 100,
    ...overrides,
  };
}
