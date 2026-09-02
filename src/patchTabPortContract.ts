import type {
  PatchInputPortContract,
  PatchOutputPortContract,
  PatchPortDataCategory,
  PatchPortDataTypeRef,
  PatchTab,
  PatchTabDefinition,
  TabFlowConnection,
} from './types';

export const PATCH_TAB_CONTRACT_SCHEMA_VERSION = 1 as const;

export const BUILTIN_PATCH_TAB_TYPE_IDS = {
  humPrep: 'humstudio.patch.hum-prep',
  humToMidi: 'humstudio.patch.hum-to-midi',
  midiEdit: 'humstudio.patch.midi-edit',
  soundFont: 'humstudio.patch.soundfont',
  instrument: 'humstudio.patch.instrument',
  stableAudio3: 'humstudio.patch.stable-audio-3',
  stableAudio3TextToAudio: 'humstudio.patch.stable-audio-3-text-to-audio',
  aceStepTextToMusic: 'humstudio.patch.ace-step-text-to-music',
  aceStepCover: 'humstudio.patch.ace-step-cover',
  aceStep: 'humstudio.patch.ace-step',
  clipFiler: 'humstudio.patch.clip-filer',
  printMix: 'humstudio.patch.print-mix',
} as const;

export const PATCH_DATA_TYPES = {
  audio: { id: 'humstudio.artifact.audio', major: 1 },
  midiNotes: { id: 'humstudio.artifact.midi-notes', major: 1 },
  lyrics: { id: 'humstudio.artifact.lyrics', major: 1 },
  soundFont: { id: 'humstudio.resource.soundfont', major: 1 },
  modelHandle: { id: 'humstudio.resource.model-handle', major: 1 },
  timelineRange: { id: 'humstudio.project.timeline-range', major: 1 },
  arrangement: { id: 'humstudio.project.arrangement', major: 1 },
  exportedFile: { id: 'humstudio.file.exported-media', major: 1 },
} as const satisfies Record<string, PatchPortDataTypeRef>;

export const PATCH_CAPABILITIES = {
  exportable: 'humstudio.exportable',
  timelinePlaceable: 'humstudio.timeline-placeable',
} as const;

export type PatchPortCompatibilityState = 'compatible' | 'mismatch' | 'unknown' | 'adapter-available';

export type PatchPortCompatibility = {
  state: PatchPortCompatibilityState;
  reason: string;
  outputPort?: PatchOutputPortContract;
  inputPort?: PatchInputPortContract;
};

export type PatchPortOption = {
  patchTabId: string;
  patchTabName: string;
  portId: string;
  portLabel: string;
  dataCategory: PatchPortDataCategory;
  label: string;
};

const artifactOutputCapabilities = [PATCH_CAPABILITIES.exportable, PATCH_CAPABILITIES.timelinePlaceable];

const builtinDefinitions: Record<string, PatchTabDefinition> = {
  [BUILTIN_PATCH_TAB_TYPE_IDS.humPrep]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humPrep,
    nodeVersion: '1.0.0',
    defaultName: 'Hum Prep',
    nodeCategory: 'process',
    inputs: [
      {
        id: 'audio-in',
        label: 'HUM AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        accepts: [PATCH_DATA_TYPES.audio],
        preferredRoles: ['hum', 'prepared-hum'],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'audio-out',
        label: 'PREPARED HUM',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'prepared-hum',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.humToMidi,
    nodeVersion: '1.0.0',
    defaultName: 'Hum to MIDI',
    nodeCategory: 'convert',
    inputs: [
      {
        id: 'audio-in',
        label: 'HUM AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        accepts: [PATCH_DATA_TYPES.audio],
        preferredRoles: ['hum', 'prepared-hum'],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'midi-out',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        produces: PATCH_DATA_TYPES.midiNotes,
        role: 'detected-midi',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.midiEdit,
    nodeVersion: '1.0.0',
    defaultName: 'MIDI Edit',
    nodeCategory: 'edit',
    inputs: [
      {
        id: 'midi-in',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        accepts: [PATCH_DATA_TYPES.midiNotes],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'midi-out',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        produces: PATCH_DATA_TYPES.midiNotes,
        role: 'edited-midi',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.soundFont]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.soundFont,
    nodeVersion: '1.0.0',
    defaultName: 'SoundFont',
    nodeCategory: 'loader',
    inputs: [],
    outputs: [
      {
        id: 'soundfont-out',
        label: 'SOUNDFONT',
        domain: 'resource',
        dataCategory: 'model',
        produces: PATCH_DATA_TYPES.soundFont,
        role: 'soundfont-resource',
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.instrument]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
    nodeVersion: '1.0.0',
    defaultName: 'MIDI TO AUDIO',
    nodeCategory: 'instrument',
    inputs: [
      {
        id: 'midi-in',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        accepts: [PATCH_DATA_TYPES.midiNotes],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
      {
        id: 'soundfont-in',
        label: 'SOUNDFONT',
        domain: 'resource',
        dataCategory: 'model',
        accepts: [PATCH_DATA_TYPES.soundFont],
        allowedBindings: ['connection', 'project-context'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'audio-out',
        label: 'AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'instrument-render',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
    nodeVersion: '1.0.0',
    defaultName: 'SA3 A2A',
    nodeCategory: 'generate',
    inputs: [
      {
        id: 'audio-in',
        label: 'AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        accepts: [PATCH_DATA_TYPES.audio],
        preferredRoles: ['instrument-render', 'stable-audio-3'],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'audio-out',
        label: 'AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'stable-audio-3',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3TextToAudio,
    nodeVersion: '1.0.0',
    defaultName: 'SA3 T2A',
    nodeCategory: 'generate',
    inputs: [],
    outputs: [
      {
        id: 'audio-out',
        label: 'AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'stable-audio-3-text-to-audio',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStepTextToMusic,
    nodeVersion: '1.0.0',
    defaultName: 'ACE T2M',
    nodeCategory: 'generate',
    inputs: [],
    outputs: [
      {
        id: 'audio-out',
        label: 'AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'ace-step-text-to-music',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStepCover,
    nodeVersion: '1.0.0',
    defaultName: 'ACE COVER',
    nodeCategory: 'generate',
    inputs: [
      {
        id: 'audio-in',
        label: 'SOURCE AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        accepts: [PATCH_DATA_TYPES.audio],
        preferredRoles: [
          'instrument-render',
          'stable-audio-3',
          'stable-audio-3-text-to-audio',
          'ace-step-text-to-music',
        ],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'audio-out',
        label: 'COVER AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'ace-step-cover',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.aceStep]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.aceStep,
    nodeVersion: '1.0.0',
    defaultName: 'ACE Vocals',
    nodeCategory: 'generate',
    inputs: [
      {
        id: 'guide-audio-in',
        label: 'GUIDE AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        accepts: [PATCH_DATA_TYPES.audio],
        preferredRoles: ['instrument-render', 'stable-audio-3-text-to-audio'],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [
      {
        id: 'vocal-audio-out',
        label: 'VOCAL AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'vocal-render',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
    nodeVersion: '1.0.0',
    defaultName: 'Clip Filer',
    nodeCategory: 'utility',
    inputs: [
      {
        id: 'media-in',
        label: 'MEDIA',
        domain: 'artifact',
        dataCategory: 'file',
        accepts: [PATCH_DATA_TYPES.audio, PATCH_DATA_TYPES.midiNotes],
        requiredCapabilities: [PATCH_CAPABILITIES.exportable],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 1, max: 1 },
      },
    ],
    outputs: [],
  },
  [BUILTIN_PATCH_TAB_TYPE_IDS.printMix]: {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
    nodeVersion: '1.0.0',
    defaultName: 'PRINT MIX',
    nodeCategory: 'mix',
    inputs: [
      {
        id: 'media-in',
        label: 'MEDIA',
        domain: 'artifact',
        dataCategory: 'file',
        accepts: [PATCH_DATA_TYPES.audio, PATCH_DATA_TYPES.midiNotes],
        allowedBindings: ['timeline-selection', 'connection'],
        cardinality: { min: 2, max: 'many' },
      },
    ],
    outputs: [
      {
        id: 'audio-out',
        label: 'AUDIO',
        domain: 'artifact',
        dataCategory: 'audio',
        produces: PATCH_DATA_TYPES.audio,
        role: 'print-mix',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
      {
        id: 'midi-out',
        label: 'MIDI',
        domain: 'artifact',
        dataCategory: 'midi',
        produces: PATCH_DATA_TYPES.midiNotes,
        role: 'print-mix',
        capabilities: artifactOutputCapabilities,
        fanOut: 'many',
      },
    ],
  },
};

const builtinTypeIdByNormalizedName = new Map(
  [
    ...Object.values(builtinDefinitions)
      .filter(
        (definition) =>
          definition.nodeTypeId !== BUILTIN_PATCH_TAB_TYPE_IDS.printMix,
      )
      .map(
        (definition) =>
          [
            normalizeName(definition.defaultName),
            definition.nodeTypeId,
          ] as const,
      ),
    [
      normalizeName('Instrument'),
      BUILTIN_PATCH_TAB_TYPE_IDS.instrument,
    ] as const,
    [
      normalizeName('Stable Audio 3'),
      BUILTIN_PATCH_TAB_TYPE_IDS.stableAudio3,
    ] as const,
  ],
);

const legacySignalContracts = new Map<
  string,
  {
    type: PatchPortDataTypeRef;
    dataCategory: PatchPortDataCategory;
    role?: string;
    capabilities?: string[];
    domain?: PatchInputPortContract['domain'];
  }
>([
  [
    'Hum Audio',
    {
      type: PATCH_DATA_TYPES.audio,
      dataCategory: 'audio',
      role: 'hum',
      capabilities: artifactOutputCapabilities,
    },
  ],
  [
    'MIDI Notes',
    {
      type: PATCH_DATA_TYPES.midiNotes,
      dataCategory: 'midi',
      role: 'detected-midi',
      capabilities: artifactOutputCapabilities,
    },
  ],
  [
    'Edited MIDI',
    {
      type: PATCH_DATA_TYPES.midiNotes,
      dataCategory: 'midi',
      role: 'edited-midi',
      capabilities: artifactOutputCapabilities,
    },
  ],
  [
    'Instrument Audio',
    {
      type: PATCH_DATA_TYPES.audio,
      dataCategory: 'audio',
      role: 'instrument-render',
      capabilities: artifactOutputCapabilities,
    },
  ],
  [
    'Vocal Audio',
    {
      type: PATCH_DATA_TYPES.audio,
      dataCategory: 'audio',
      role: 'vocal-render',
      capabilities: artifactOutputCapabilities,
    },
  ],
  [
    'Mixdown',
    {
      type: PATCH_DATA_TYPES.audio,
      dataCategory: 'audio',
      role: 'mixdown',
      capabilities: artifactOutputCapabilities,
    },
  ],
  [
    'Timeline Range',
    {
      type: PATCH_DATA_TYPES.timelineRange,
      dataCategory: 'range',
      domain: 'project-source',
    },
  ],
  [
    'Arrangement',
    {
      type: PATCH_DATA_TYPES.arrangement,
      dataCategory: 'metadata',
      domain: 'project-source',
    },
  ],
  [
    'Export File',
    {
      type: PATCH_DATA_TYPES.exportedFile,
      dataCategory: 'file',
      role: 'exported-file',
    },
  ],
]);

export function getBuiltinPatchTabDefinitions(): PatchTabDefinition[] {
  return Object.values(builtinDefinitions);
}

export function getPatchTabDefinition(patchTab: PatchTab | undefined): PatchTabDefinition | undefined {
  if (!patchTab) {
    return undefined;
  }

  if (patchTab.portContractSnapshot?.schemaVersion === PATCH_TAB_CONTRACT_SCHEMA_VERSION) {
    return patchTab.portContractSnapshot;
  }

  const nodeTypeId = patchTab.nodeTypeId ?? inferBuiltinPatchTabTypeId(patchTab);
  const builtinDefinition = nodeTypeId ? builtinDefinitions[nodeTypeId] : undefined;

  if (builtinDefinition) {
    return builtinDefinition;
  }

  return createKnownLegacyPatchTabDefinition(patchTab);
}

export function inferBuiltinPatchTabTypeId(patchTab: Pick<PatchTab, 'name'>): string | undefined {
  return builtinTypeIdByNormalizedName.get(normalizeName(patchTab.name));
}

export function migratePatchTabContract(patchTab: PatchTab): PatchTab {
  if (patchTab.nodeTypeId && patchTab.nodeVersion) {
    return patchTab;
  }

  const nodeTypeId = inferBuiltinPatchTabTypeId(patchTab);
  const definition = nodeTypeId ? builtinDefinitions[nodeTypeId] : undefined;

  if (!definition) {
    return patchTab;
  }

  return {
    ...patchTab,
    nodeTypeId: definition.nodeTypeId,
    nodeVersion: definition.nodeVersion,
  };
}

export function migrateTabFlowConnectionPorts(
  connection: TabFlowConnection,
  patchTabs: PatchTab[],
): TabFlowConnection {
  const patchTabMap = new Map(patchTabs.map((patchTab) => [patchTab.id, patchTab]));
  const sourceDefinition = getPatchTabDefinition(patchTabMap.get(connection.fromPatchTabId));
  const targetDefinition = getPatchTabDefinition(patchTabMap.get(connection.toPatchTabId));
  const fromPortId = connection.fromPortId ?? sourceDefinition?.outputs[0]?.id;
  const toPortId = connection.toPortId ?? targetDefinition?.inputs[0]?.id;
  const compatibility = getPatchTabConnectionCompatibility(
    patchTabMap.get(connection.fromPatchTabId),
    patchTabMap.get(connection.toPatchTabId),
    fromPortId,
    toPortId,
  );
  const activation =
    connection.activation ??
    (compatibility.state === 'compatible' && connection.enabled ? 'on' : compatibility.state === 'compatible' ? 'off' : 'draft');

  if (
    connection.fromPortId === fromPortId &&
    connection.toPortId === toPortId &&
    connection.activation === activation &&
    connection.createdOrder !== undefined
  ) {
    return connection;
  }

  return {
    ...connection,
    ...(fromPortId ? { fromPortId } : {}),
    ...(toPortId ? { toPortId } : {}),
    activation,
    createdOrder: connection.createdOrder ?? connection.order,
  };
}

export function getPatchTabConnectionCompatibility(
  sourcePatchTab: PatchTab | undefined,
  targetPatchTab: PatchTab | undefined,
  fromPortId?: string,
  toPortId?: string,
): PatchPortCompatibility {
  const sourceDefinition = getPatchTabDefinition(sourcePatchTab);
  const targetDefinition = getPatchTabDefinition(targetPatchTab);

  if (!sourceDefinition || !targetDefinition) {
    return {
      state: 'unknown',
      reason: !sourceDefinition && !targetDefinition ? 'source and target contracts unavailable' : 'endpoint contract unavailable',
    };
  }

  const outputPort = fromPortId
    ? sourceDefinition.outputs.find((port) => port.id === fromPortId)
    : sourceDefinition.outputs[0];
  const inputPort = toPortId ? targetDefinition.inputs.find((port) => port.id === toPortId) : targetDefinition.inputs[0];

  if (!outputPort || !inputPort) {
    return {
      state: 'unknown',
      reason: !outputPort && !inputPort ? 'source and target ports unavailable' : 'endpoint port unavailable',
      outputPort,
      inputPort,
    };
  }

  const acceptsType = inputPort.accepts.some((acceptedType) => areDataTypesCompatible(outputPort.produces, acceptedType));

  if (!acceptsType) {
    return {
      state: 'mismatch',
      reason: `${formatDataType(outputPort.produces)} is not accepted by ${inputPort.label}`,
      outputPort,
      inputPort,
    };
  }

  const outputCapabilities = new Set(outputPort.capabilities ?? []);
  const missingCapability = inputPort.requiredCapabilities?.find((capability) => !outputCapabilities.has(capability));

  if (missingCapability) {
    return {
      state: 'mismatch',
      reason: `missing capability ${missingCapability}`,
      outputPort,
      inputPort,
    };
  }

  return {
    state: 'compatible',
    reason: 'type and capability contracts match',
    outputPort,
    inputPort,
  };
}

export function getConnectionCompatibility(
  connection: TabFlowConnection,
  patchTabMap: Map<string, PatchTab>,
): PatchPortCompatibility {
  return getPatchTabConnectionCompatibility(
    patchTabMap.get(connection.fromPatchTabId),
    patchTabMap.get(connection.toPatchTabId),
    connection.fromPortId,
    connection.toPortId,
  );
}

export function getPatchTabInputOptions(patchTab: PatchTab): PatchPortOption[] {
  const ports = getPatchTabDefinition(patchTab)?.inputs ?? [];

  return ports.map((port) =>
    createPortOption(patchTab, port.id, port.label, port.dataCategory, ports.length),
  );
}

export function getPatchTabOutputOptions(patchTab: PatchTab): PatchPortOption[] {
  const ports = getPatchTabDefinition(patchTab)?.outputs ?? [];

  return ports.map((port) =>
    createPortOption(patchTab, port.id, port.label, port.dataCategory, ports.length),
  );
}

export function getDefaultInputPort(patchTab: PatchTab | undefined): PatchInputPortContract | undefined {
  return getPatchTabDefinition(patchTab)?.inputs[0];
}

export function getDefaultOutputPort(patchTab: PatchTab | undefined): PatchOutputPortContract | undefined {
  return getPatchTabDefinition(patchTab)?.outputs[0];
}

export function areDataTypesCompatible(produced: PatchPortDataTypeRef, accepted: PatchPortDataTypeRef): boolean {
  return produced.id === accepted.id && produced.major === accepted.major;
}

function createKnownLegacyPatchTabDefinition(patchTab: PatchTab): PatchTabDefinition | undefined {
  const inputContract = createLegacyInputContract(patchTab.inputType);
  const outputContract = createLegacyOutputContract(patchTab.outputType);

  if (!inputContract || !outputContract) {
    return undefined;
  }

  return {
    schemaVersion: PATCH_TAB_CONTRACT_SCHEMA_VERSION,
    nodeTypeId: `humstudio.legacy.${slugify(patchTab.name)}`,
    nodeVersion: '1.0.0',
    defaultName: patchTab.name,
    nodeCategory: patchTab.outputType === 'Export File' ? 'utility' : 'process',
    inputs: [inputContract],
    outputs: patchTab.outputType === 'Export File' ? [] : [outputContract],
  };
}

function createLegacyInputContract(signalType: string): PatchInputPortContract | undefined {
  if (signalType === 'Selected Clip') {
    return {
      id: 'media-in',
      label: 'MEDIA',
      domain: 'artifact',
      dataCategory: 'file',
      accepts: [PATCH_DATA_TYPES.audio, PATCH_DATA_TYPES.midiNotes],
      requiredCapabilities: [PATCH_CAPABILITIES.exportable],
      allowedBindings: ['timeline-selection', 'connection'],
      cardinality: { min: 1, max: 1 },
    };
  }

  if (signalType === 'Audio + MIDI') {
    return {
      id: 'media-in',
      label: 'MEDIA',
      domain: 'artifact',
      dataCategory: 'file',
      accepts: [PATCH_DATA_TYPES.audio, PATCH_DATA_TYPES.midiNotes],
      allowedBindings: ['timeline-selection', 'connection'],
      cardinality: { min: 1, max: 1 },
    };
  }

  const legacyContract = legacySignalContracts.get(signalType);

  if (!legacyContract) {
    return undefined;
  }

  return {
    id: `${slugify(signalType)}-in`,
    label: signalType.toUpperCase(),
    domain: legacyContract.domain ?? 'artifact',
    dataCategory: legacyContract.dataCategory,
    accepts: [legacyContract.type],
    allowedBindings: ['timeline-selection', 'connection'],
    cardinality: { min: 1, max: 1 },
  };
}

function createLegacyOutputContract(signalType: string): PatchOutputPortContract | undefined {
  const legacyContract = legacySignalContracts.get(signalType);

  if (!legacyContract) {
    return undefined;
  }

  return {
    id: `${slugify(signalType)}-out`,
    label: signalType.toUpperCase(),
    domain: legacyContract.domain ?? 'artifact',
    dataCategory: legacyContract.dataCategory,
    produces: legacyContract.type,
    role: legacyContract.role,
    capabilities: legacyContract.capabilities,
    fanOut: 'many',
  };
}

function createPortOption(
  patchTab: PatchTab,
  portId: string,
  portLabel: string,
  dataCategory: PatchPortDataCategory,
  portCount: number,
): PatchPortOption {
  const label =
    portCount > 1
      ? `${patchTab.name} / ${portLabel} [${dataCategory.toUpperCase()}]`
      : `${patchTab.name} [${dataCategory.toUpperCase()}]`;

  return {
    patchTabId: patchTab.id,
    patchTabName: patchTab.name,
    portId,
    portLabel,
    dataCategory,
    label,
  };
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'unknown';
}

function formatDataType(dataType: PatchPortDataTypeRef): string {
  return `${dataType.id}@${dataType.major}`;
}
