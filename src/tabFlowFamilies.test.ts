import { describe, expect, it } from 'vitest';
import {
  createTabFlowFamiliesFromConnections,
  createTabFlowChildLine,
  detachTabFlowChildLine,
  getEnabledTabFlowFamilyCount,
  getTabFlowFamilyPreflight,
  getTabFlowLaneViews,
  getTabFlowStructureState,
  mergeTabFlowFamilies,
  normalizeTabFlowFamilies,
  placeConnectionInTabFlowFamily,
  setTabFlowFamilyEnabled,
  wouldCreateTabFlowCycle,
} from './tabFlowFamilies';
import type { PatchTab, TabFlowConnection, TabFlowLine } from './types';

function createLine(id: string, order: number, connectionIds: string[], enabled = true): TabFlowLine {
  return {
    id,
    name: `TabFlow Line ${order + 1}`,
    order,
    enabled,
    revision: 1,
    connectionIds,
  };
}

function createConnection(
  id: string,
  fromPatchTabId: string,
  toPatchTabId: string,
  order: number,
): TabFlowConnection {
  return {
    id,
    fromPatchTabId,
    toPatchTabId,
    fromPortId: 'audio-out',
    toPortId: 'audio-in',
    activation: 'on',
    createdOrder: order,
    signalType: 'Audio',
    order,
    latencyMs: 0,
    enabled: true,
  };
}

const patchTabs: PatchTab[] = ['red', 'blue', 'yellow', 'green', 'orange', 'pink', 'white'].map(
  (id, colorIndex) => ({
    id,
    name: id,
    colorIndex,
    inputType: 'Hum Audio',
    outputType: 'Hum Audio',
    status: 'ready',
    description: '',
    parameters: [],
  }),
);

const trunkConnections = [
  createConnection('red-blue', 'red', 'blue', 0),
  createConnection('blue-yellow', 'blue', 'yellow', 1),
  createConnection('yellow-green', 'yellow', 'green', 2),
];

describe('TabFlow Families and child lanes', () => {
  it('keeps a single Root Flow label until it gains a child', () => {
    const line = createLine('line-1', 0, trunkConnections.map((connection) => connection.id));

    expect(getTabFlowLaneViews([line], trunkConnections, patchTabs).map((view) => view.displayLabel)).toEqual(['1']);
  });

  it('creates 1a and 1b labels for the first branch', () => {
    const root = createLine('line-1', 0, trunkConnections.map((connection) => connection.id));
    const branchConnections = [
      createConnection('blue-orange', 'blue', 'orange', 3),
      createConnection('orange-pink', 'orange', 'pink', 4),
    ];
    const child = createTabFlowChildLine(
      root,
      'line-branch-blue',
      branchConnections.map((connection) => connection.id),
      { kind: 'branch-from', patchTabId: 'blue', portId: 'audio-out' },
      0,
    );
    const views = getTabFlowLaneViews([root, child], [...trunkConnections, ...branchConnections], patchTabs);

    expect(views.map((view) => view.displayLabel)).toEqual(['1a', '1b']);
    expect(views[1]).toEqual(
      expect.objectContaining({
        familyId: root.id,
        isChild: true,
        junctionIndex: 1,
        startIndex: 1,
      }),
    );
  });

  it('places a later parent junction on the lower 1c lane', () => {
    const root = createLine('line-1', 0, trunkConnections.map((connection) => connection.id));
    const yellowBranchConnection = createConnection('yellow-white', 'yellow', 'white', 5);
    const blueBranchConnections = [
      createConnection('blue-orange', 'blue', 'orange', 3),
      createConnection('orange-pink', 'orange', 'pink', 4),
    ];
    const yellowChild = createTabFlowChildLine(
      root,
      'line-branch-yellow',
      [yellowBranchConnection.id],
      { kind: 'branch-from', patchTabId: 'yellow', portId: 'audio-out' },
      0,
    );
    const blueChild = createTabFlowChildLine(
      root,
      'line-branch-blue',
      blueBranchConnections.map((connection) => connection.id),
      { kind: 'branch-from', patchTabId: 'blue', portId: 'audio-out' },
      1,
    );
    const views = getTabFlowLaneViews(
      [root, yellowChild, blueChild],
      [...trunkConnections, yellowBranchConnection, ...blueBranchConnections],
      patchTabs,
    );

    expect(views.map((view) => [view.line.id, view.displayLabel])).toEqual([
      ['line-1', '1a'],
      ['line-branch-blue', '1b'],
      ['line-branch-yellow', '1c'],
    ]);
  });

  it('places a connection from the middle of a Root Flow onto a child lane', () => {
    const root = createLine('line-1', 0, trunkConnections.map((connection) => connection.id));
    const branchConnection = createConnection('blue-orange', 'blue', 'orange', 3);
    const placed = placeConnectionInTabFlowFamily(
      [root],
      root.id,
      branchConnection,
      [...trunkConnections, branchConnection],
    );
    const views = getTabFlowLaneViews(placed, [...trunkConnections, branchConnection], patchTabs);

    expect(views.map((view) => view.displayLabel)).toEqual(['1a', '1b']);
    expect(views[1].line).toEqual(
      expect.objectContaining({
        connectionIds: ['blue-orange'],
        attachment: expect.objectContaining({
          parentLineId: root.id,
          patchTabId: 'blue',
          kind: 'branch-from',
        }),
      }),
    );
  });

  it('turns a cross-Root connection into a merge child lane', () => {
    const targetRoot = createLine('line-1', 0, trunkConnections.map((connection) => connection.id));
    const sourceConnection = createConnection('white-orange', 'white', 'orange', 3);
    const sourceRoot = createLine('line-2', 1, [sourceConnection.id]);
    const mergeConnection = createConnection('orange-green', 'orange', 'green', 4);
    const connections = [...trunkConnections, sourceConnection, mergeConnection];
    const placed = placeConnectionInTabFlowFamily(
      [targetRoot, sourceRoot],
      sourceRoot.id,
      mergeConnection,
      connections,
    );
    const views = getTabFlowLaneViews(placed, connections, patchTabs);

    expect(views.map((view) => view.displayLabel)).toEqual(['1a', '1b']);
    expect(views[1].line).toEqual(
      expect.objectContaining({
        id: sourceRoot.id,
        connectionIds: [sourceConnection.id, mergeConnection.id],
        attachment: expect.objectContaining({
          parentLineId: targetRoot.id,
          patchTabId: 'green',
          kind: 'merge-into',
        }),
      }),
    );
  });

  it('merges the source Root under the target Root and shares the safe OFF state', () => {
    const targetRoot = createLine('line-1', 0, trunkConnections.map((connection) => connection.id), true);
    const sourceConnections = [createConnection('white-orange', 'white', 'orange', 3)];
    const sourceRoot = createLine('line-2', 1, sourceConnections.map((connection) => connection.id), false);
    const merged = mergeTabFlowFamilies(
      [targetRoot, sourceRoot],
      sourceRoot.id,
      targetRoot.id,
      { kind: 'merge-into', patchTabId: 'green', portId: 'audio-in' },
    );
    const views = getTabFlowLaneViews(merged, [...trunkConnections, ...sourceConnections], patchTabs);

    expect(views.map((view) => [view.line.id, view.displayLabel, view.line.enabled])).toEqual([
      ['line-1', '1a', false],
      ['line-2', '1b', false],
    ]);
    expect(views[1].line.attachment).toEqual({
      parentLineId: 'line-1',
      patchTabId: 'green',
      portId: 'audio-in',
      kind: 'merge-into',
    });
  });

  it('counts a parent with multiple children as one enabled Root Family', () => {
    const root = createLine('line-1', 0, ['red-blue']);
    const child = createTabFlowChildLine(
      root,
      'line-1-child',
      ['blue-orange'],
      { kind: 'branch-from', patchTabId: 'blue' },
      0,
    );
    const secondRoot = createLine('line-2', 1, ['white-orange'], false);

    expect(getEnabledTabFlowFamilyCount([root, child, secondRoot])).toBe(1);
    expect(getEnabledTabFlowFamilyCount([root, child, { ...secondRoot, enabled: true }])).toBe(2);
  });

  it('blocks the whole ON family when one child lane has a draft mismatch', () => {
    const rootConnection = createConnection('red-blue', 'red', 'blue', 0);
    const root = createLine('line-1', 0, [rootConnection.id]);
    const draftConnection = {
      ...createConnection('blue-orange', 'blue', 'orange', 1),
      activation: 'draft' as const,
      enabled: false,
    };
    const child = createTabFlowChildLine(
      root,
      'line-1-child',
      [draftConnection.id],
      { kind: 'branch-from', patchTabId: 'blue' },
      0,
    );
    const preflight = getTabFlowFamilyPreflight(
      [root, child],
      [rootConnection, draftConnection],
      patchTabs,
    );

    expect(preflight).toEqual([
      expect.objectContaining({
        rootLine: expect.objectContaining({ id: root.id }),
        status: 'blocked',
      }),
    ]);
  });

  it('orders independent ON families by Root display order during preflight', () => {
    const firstConnection = {
      ...createConnection('red-blue', 'red', 'blue', 0),
      fromPortId: undefined,
      toPortId: undefined,
    };
    const secondConnection = {
      ...createConnection('white-orange', 'white', 'orange', 1),
      fromPortId: undefined,
      toPortId: undefined,
    };
    const preflight = getTabFlowFamilyPreflight(
      [
        createLine('line-2', 8, [secondConnection.id]),
        createLine('line-1', 3, [firstConnection.id]),
      ],
      [firstConnection, secondConnection],
      patchTabs,
    );

    expect(preflight.map((result) => result.rootLine.id)).toEqual(['line-1', 'line-2']);
    expect(preflight.every((result) => result.status === 'ready')).toBe(true);
  });

  it('toggles the entire Family from a child lane', () => {
    const root = createLine('line-1', 0, ['red-blue']);
    const child = createTabFlowChildLine(
      root,
      'line-1-child',
      ['blue-orange'],
      { kind: 'branch-from', patchTabId: 'blue' },
      0,
    );

    expect(setTabFlowFamilyEnabled([root, child], child.id, false).map((line) => line.enabled)).toEqual([
      false,
      false,
    ]);
  });

  it('detaches a child as an independent OFF Root without changing its stable ID', () => {
    const root = createLine('line-1', 0, ['red-blue']);
    const child = createTabFlowChildLine(
      root,
      'line-stable-child',
      ['blue-orange'],
      { kind: 'branch-from', patchTabId: 'blue' },
      0,
    );
    const restored = detachTabFlowChildLine([root, child], child.id).find((line) => line.id === child.id);

    expect(restored).toEqual(
      expect.objectContaining({
        id: 'line-stable-child',
        enabled: false,
        familyId: 'line-stable-child',
      }),
    );
    expect(restored?.attachment).toBeUndefined();
  });

  it('rejects self links, cycles, and a second connection to a single Input', () => {
    const connections = [
      createConnection('red-blue', 'red', 'blue', 0),
      createConnection('blue-yellow', 'blue', 'yellow', 1),
    ];

    expect(getTabFlowStructureState(connections, 'blue', 'blue')).toBe('self-link');
    expect(wouldCreateTabFlowCycle(connections, 'yellow', 'red')).toBe(true);
    expect(getTabFlowStructureState(connections, 'yellow', 'red')).toBe('loop-blocked');
    expect(getTabFlowStructureState(connections, 'orange', 'yellow', 'audio-in', 1)).toBe('input-full');
  });

  it('builds a resource merge as one child lane in the executable Flow Family', () => {
    const midiSource = createConnection('hum-midi', 'hum', 'midi-edit', 0);
    const instrument = createConnection(
      'midi-instrument',
      'midi-edit',
      'instrument',
      1,
    );
    const soundFont: TabFlowConnection = {
      ...createConnection('soundfont-instrument', 'soundfont', 'instrument', 2),
      fromPortId: 'soundfont-out',
      signalType: 'SOUNDFONT',
      toPortId: 'soundfont-in',
    };
    const lines = createTabFlowFamiliesFromConnections([
      midiSource,
      instrument,
      soundFont,
    ]);
    const views = getTabFlowLaneViews(lines, [midiSource, instrument, soundFont], []);

    expect(getEnabledTabFlowFamilyCount(lines)).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      attachment: undefined,
      connectionIds: ['hum-midi', 'midi-instrument'],
    });
    expect(lines[1]).toMatchObject({
      attachment: {
        kind: 'merge-into',
        parentLineId: lines[0].id,
        patchTabId: 'instrument',
        portId: 'soundfont-in',
      },
      connectionIds: ['soundfont-instrument'],
    });
    expect(views[1]).toMatchObject({
      junctionIndex: 2,
      startIndex: 1,
    });
  });

  it('downgrades an invalid orphan attachment to a safe Root Flow', () => {
    const orphan: TabFlowLine = {
      ...createLine('line-orphan', 5, ['white-orange']),
      attachment: {
        parentLineId: 'missing-parent',
        patchTabId: 'orange',
        kind: 'merge-into',
      },
    };
    const normalized = normalizeTabFlowFamilies([orphan]);

    expect(normalized).toEqual([
      expect.objectContaining({
        id: 'line-orphan',
        order: 0,
        familyId: 'line-orphan',
      }),
    ]);
    expect(normalized[0].attachment).toBeUndefined();
  });
});
