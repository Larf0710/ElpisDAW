import { describe, expect, it } from 'vitest';

import {
  BUILTIN_PATCH_TAB_TYPE_IDS,
  getBuiltinPatchTabDefinitions,
} from './patchTabPortContract';
import { synchronizePatchTabConnectionBindings } from './patchTabInputBindings';
import type { PatchTab, TabFlowConnection } from './types';

describe('PatchTab connection Input Binding synchronization', () => {
  it('replaces another source kind with stable ordered Connection IDs', () => {
    const source = createPatchTab('source', BUILTIN_PATCH_TAB_TYPE_IDS.instrument);
    const target = createPatchTab('target', BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3, [
      {
        portId: 'audio-in',
        kind: 'timeline-selection',
        selectionKind: 'clip',
      },
    ]);
    const connections = [
      createConnection('later', source.id, target.id, 2),
      createConnection('earlier', source.id, target.id, 1),
    ];

    const synchronized = synchronizePatchTabConnectionBindings(
      [source, target],
      connections,
    );

    expect(synchronized[1].inputBindings).toEqual([
      {
        portId: 'audio-in',
        kind: 'connection',
        connectionIds: ['earlier', 'later'],
      },
    ]);
  });

  it('removes stale Connection bindings without inventing a fallback source', () => {
    const target = createPatchTab('target', BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3, [
      {
        portId: 'audio-in',
        kind: 'connection',
        connectionIds: ['removed'],
      },
    ]);

    const [synchronized] = synchronizePatchTabConnectionBindings([target], []);

    expect(synchronized.inputBindings).toEqual([]);
  });

  it('does not let a draft route replace an existing non-Connection source', () => {
    const source = createPatchTab('source', BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit);
    const target = createPatchTab('target', BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3, [
      {
        portId: 'audio-in',
        kind: 'timeline-selection',
        selectionKind: 'clip',
      },
    ]);
    const draftConnection: TabFlowConnection = {
      ...createConnection('draft', source.id, target.id, 0),
      activation: 'draft',
      enabled: false,
      signalType: 'MIDI',
    };

    const withDraft = synchronizePatchTabConnectionBindings(
      [source, target],
      [draftConnection],
    );
    const afterRemoval = synchronizePatchTabConnectionBindings(withDraft, []);

    expect(withDraft[1]).toBe(target);
    expect(withDraft[1].inputBindings).toEqual([
      {
        portId: 'audio-in',
        kind: 'timeline-selection',
        selectionKind: 'clip',
      },
    ]);
    expect(afterRemoval[1]).toBe(target);
  });

  it('preserves non-Connection bindings on unaffected Ports and is idempotent', () => {
    const instrument = createPatchTab(
      'instrument',
      BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
      [
        {
          portId: 'soundfont-in',
          kind: 'project-context',
          selector: 'clip.soundFont',
        },
      ],
    );
    const source = createPatchTab('source', BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit);
    const connection: TabFlowConnection = {
      id: 'midi-instrument',
      fromPatchTabId: source.id,
      fromPortId: 'midi-out',
      toPatchTabId: instrument.id,
      toPortId: 'midi-in',
      signalType: 'MIDI',
      order: 0,
      latencyMs: 0,
      enabled: true,
    };

    const once = synchronizePatchTabConnectionBindings(
      [source, instrument],
      [connection],
    );
    const twice = synchronizePatchTabConnectionBindings(once, [connection]);

    expect(once[1].inputBindings).toEqual([
      {
        portId: 'soundfont-in',
        kind: 'project-context',
        selector: 'clip.soundFont',
      },
      {
        portId: 'midi-in',
        kind: 'connection',
        connectionIds: ['midi-instrument'],
      },
    ]);
    expect(twice[0]).toBe(once[0]);
    expect(twice[1]).toBe(once[1]);
  });
});

function createPatchTab(
  id: string,
  nodeTypeId: string,
  inputBindings: PatchTab['inputBindings'] = [],
): PatchTab {
  const definition = getBuiltinPatchTabDefinitions().find(
    (candidate) => candidate.nodeTypeId === nodeTypeId,
  );

  if (!definition) {
    throw new Error(`Missing definition ${nodeTypeId}.`);
  }

  return {
    id,
    name: definition.defaultName,
    nodeTypeId,
    nodeVersion: definition.nodeVersion,
    portContractSnapshot: definition,
    inputBindings,
    colorIndex: 0,
    inputType: definition.inputs[0]?.label ?? 'None',
    outputType: definition.outputs[0]?.label ?? 'None',
    status: 'ready',
    description: '',
    parameters: [],
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
    fromPortId: 'audio-out',
    toPatchTabId,
    toPortId: 'audio-in',
    signalType: 'Audio',
    order,
    createdOrder: order,
    latencyMs: 0,
    enabled: true,
  };
}
