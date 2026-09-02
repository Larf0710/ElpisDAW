import { describe, expect, it } from 'vitest';

import {
  isLegacyTimelineMockPatchTab,
  migrateLegacyTimelinePatchTabs,
  migratePatchTabRoutingContracts,
} from './patchTabFlowMigration';
import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import { tabFlowPresets } from './presets';
import { sampleProject } from './sampleProject';
import type { PatchTab, ProjectState, TabFlowConnection } from './types';

describe('bundled PatchTab flows', () => {
  const bundledProjects: ProjectState[] = [
    sampleProject,
    ...tabFlowPresets.map((preset) => preset.project),
  ];

  it('keeps fresh bundled flows free of legacy Timeline and Clip Filer nodes', () => {
    bundledProjects.forEach((project) => {
      expect(project.patchTabs.some(isLegacyTimelineMockPatchTab)).toBe(false);
      expect(
        project.patchTabs.some(
          (patchTab) =>
            patchTab.inputType === 'Selected Clip' &&
            patchTab.outputType === 'Export File',
        ),
      ).toBe(false);

      const patchTabIds = new Set(project.patchTabs.map((patchTab) => patchTab.id));
      project.connections.forEach((connection) => {
        expect(patchTabIds.has(connection.fromPatchTabId)).toBe(true);
        expect(patchTabIds.has(connection.toPatchTabId)).toBe(true);
      });
    });
  });

  it('keeps Basic Quantize with MIDI editing instead of Timeline placement', () => {
    const midiEditPatchTabs = bundledProjects.flatMap((project) =>
      project.patchTabs.filter(
        (patchTab) =>
          patchTab.inputType === 'MIDI Notes' &&
          patchTab.outputType === 'Edited MIDI',
      ),
    );

    expect(midiEditPatchTabs.length).toBeGreaterThan(0);
    midiEditPatchTabs.forEach((patchTab) => {
      expect(patchTab.parameters).toEqual([
        {
          id: 'quantize',
          label: 'Quantize',
          kind: 'select',
          value: '1/16',
          options: ['1/8', '1/16', '1/32', '1/64'],
        },
      ]);
    });
  });
});

describe('legacy Timeline PatchTab migration', () => {
  it('moves Swing upstream, removes Timeline, and bridges Routing to Clip Filer', () => {
    const patchTabs: PatchTab[] = [
      {
        id: 'midi-edit',
        name: 'MIDI Edit',
        colorIndex: 0,
        inputType: 'MIDI Notes',
        outputType: 'Edited MIDI',
        status: 'ready',
        description: 'Legacy MIDI edit.',
        parameters: [
          {
            id: 'quantize',
            label: 'Quantize Strength',
            kind: 'slider',
            min: 0,
            max: 100,
            step: 1,
            value: 80,
            unit: '%',
          },
        ],
      },
      {
        id: 'instrument',
        name: 'Instrument',
        colorIndex: 1,
        inputType: 'Edited MIDI',
        outputType: 'Instrument Audio',
        status: 'ready',
        description: 'Legacy instrument.',
        parameters: [],
      },
      {
        id: 'timeline',
        name: 'Timeline',
        colorIndex: 2,
        inputType: 'Instrument Audio',
        outputType: 'Arrangement',
        status: 'idle',
        description: 'Legacy Timeline mock.',
        parameters: [
          {
            id: 'snap',
            label: 'Grid Snap',
            kind: 'select',
            value: '1/8',
            options: ['1/4', '1/8', '1/16'],
          },
          {
            id: 'swing',
            label: 'Swing',
            kind: 'slider',
            min: 0,
            max: 75,
            step: 1,
            value: 18,
            unit: '%',
          },
        ],
      },
      {
        id: 'export',
        name: 'Export',
        colorIndex: 3,
        inputType: 'Arrangement',
        outputType: 'Mixdown',
        status: 'bypassed',
        description: 'Legacy export.',
        parameters: [],
      },
    ];
    const connections: TabFlowConnection[] = [
      createConnection('c1', 'midi-edit', 'instrument', 'Edited MIDI', 0),
      createConnection('c2', 'instrument', 'timeline', 'Instrument Audio', 1),
      createConnection('c3', 'timeline', 'export', 'Arrangement', 2),
    ];

    const migrated = migrateLegacyTimelinePatchTabs(patchTabs, connections);

    expect(migrated.patchTabs.map((patchTab) => patchTab.id)).toEqual([
      'midi-edit',
      'instrument',
      'export',
    ]);
    expect(migrated.patchTabs.find((patchTab) => patchTab.id === 'midi-edit')?.parameters).toContainEqual(
      expect.objectContaining({ id: 'swing', value: 18 }),
    );
    expect(migrated.patchTabs.find((patchTab) => patchTab.id === 'export')).toEqual(
      expect.objectContaining({
        name: 'Clip Filer',
        inputType: 'Selected Clip',
        outputType: 'Export File',
      }),
    );
    expect(migrated.connections).toContainEqual(
      expect.objectContaining({
        id: 'c3',
        fromPatchTabId: 'instrument',
        toPatchTabId: 'export',
        signalType: 'Instrument Audio',
      }),
    );
    expect(
      migrated.connections.some(
        (connection) =>
          connection.fromPatchTabId === 'timeline' ||
          connection.toPatchTabId === 'timeline',
      ),
    ).toBe(false);
  });

  it('renames an existing Export Profile without changing its file contract', () => {
    const patchTabs: PatchTab[] = [
      {
        id: 'export',
        name: 'Export Profile',
        colorIndex: 3,
        inputType: 'Selected Clip',
        outputType: 'Export File',
        status: 'bypassed',
        description: 'Existing selected Clip export settings.',
        parameters: [],
      },
    ];

    const migrated = migrateLegacyTimelinePatchTabs(patchTabs, []);

    expect(migrated.patchTabs).toEqual([
      expect.objectContaining({
        id: 'export',
        name: 'Clip Filer',
        inputType: 'Selected Clip',
        outputType: 'Export File',
      }),
    ]);
  });
});

describe('PatchTab routing contract migration', () => {
  it('adds stable built-in contracts, endpoint ports, and root family identities', () => {
    const legacyProject = sampleProject;
    const migrated = migratePatchTabRoutingContracts(
      legacyProject.patchTabs,
      legacyProject.connections,
      legacyProject.tabFlowLines ?? [],
    );

    expect(migrated.patchTabs.find((patchTab) => patchTab.name === 'Hum to MIDI')).toEqual(
      expect.objectContaining({
        nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
        nodeVersion: '1.0.0',
      }),
    );
    expect(migrated.connections.every((connection) => connection.fromPortId && connection.toPortId)).toBe(true);
    expect(migrated.connections.every((connection) => connection.activation)).toBe(true);
    expect(migrated.tabFlowLines.every((line) => line.familyId === line.id)).toBe(true);
  });

  it('is idempotent and leaves unknown custom PatchTabs unclaimed', () => {
    const customPatchTab: PatchTab = {
      id: 'custom-node',
      name: 'Master Custom',
      colorIndex: 0,
      inputType: 'Mystery In',
      outputType: 'Mystery Out',
      status: 'idle',
      description: 'Unknown custom contract.',
      parameters: [],
    };
    const first = migratePatchTabRoutingContracts(
      [customPatchTab],
      [],
      [
        {
          id: 'custom-line',
          name: 'Custom Line',
          order: 0,
          enabled: false,
          revision: 1,
          connectionIds: [],
        },
      ],
    );
    const second = migratePatchTabRoutingContracts(
      first.patchTabs,
      first.connections,
      first.tabFlowLines,
    );

    expect(first.patchTabs[0].nodeTypeId).toBeUndefined();
    expect(second).toEqual(first);
  });
});

function createConnection(
  id: string,
  fromPatchTabId: string,
  toPatchTabId: string,
  signalType: string,
  order: number,
): TabFlowConnection {
  return {
    id,
    fromPatchTabId,
    toPatchTabId,
    signalType,
    order,
    latencyMs: 1,
    enabled: true,
  };
}
