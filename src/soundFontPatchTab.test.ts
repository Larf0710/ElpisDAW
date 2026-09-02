import { describe, expect, it } from 'vitest';

import type { LocalEngineSoundFontResource } from './localEngineClient';
import {
  createSoundFontPatchTab,
  resolveInstrumentSoundFont,
} from './soundFontPatchTab';
import type { SoundFontAssignment, TabFlowConnection } from './types';

const defaultResource: LocalEngineSoundFontResource = {
  format: 'sf3',
  lastModifiedAt: '2026-08-22T00:00:00.000Z',
  library: 'builtin',
  name: 'MuseScore_General.sf3',
  relativePath: 'soundfonts/HumStudio Default/MuseScore_General.sf3',
  resourceId: 'soundfont:musescore-general',
  revisionToken: 'revision-1',
  sizeBytes: 1_024,
  status: 'AVAILABLE',
};

const alternateResource: LocalEngineSoundFontResource = {
  ...defaultResource,
  format: 'sf2',
  library: 'project',
  name: 'Custom.sf2',
  relativePath: 'soundfonts/Custom.sf2',
  resourceId: 'soundfont:custom',
  revisionToken: 'revision-2',
};

const connection: TabFlowConnection = {
  activation: 'on',
  createdOrder: 0,
  enabled: true,
  fromPatchTabId: 'soundfont',
  fromPortId: 'soundfont-out',
  id: 'soundfont-to-instrument',
  latencyMs: 0,
  order: 0,
  signalType: 'SOUNDFONT',
  toPatchTabId: 'instrument',
  toPortId: 'soundfont-in',
};

const clipAssignment: SoundFontAssignment = {
  bank: 2,
  program: 40,
  resource: {
    format: alternateResource.format,
    library: 'project',
    relativePath: alternateResource.relativePath,
    resourceId: alternateResource.resourceId,
  },
};

describe('SoundFont PatchTab', () => {
  it('defaults to MuseScore General Bank 0 Program 0', () => {
    const patchTab = createSoundFontPatchTab();

    expect(patchTab.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'soundfont-resource',
          value: defaultResource.relativePath,
        }),
        expect.objectContaining({ id: 'bank', value: 0 }),
        expect.objectContaining({ id: 'program', value: 0 }),
      ]),
    );
  });

  it('treats the legacy built-in PatchTab value as the MIDI TO AUDIO default', () => {
    const resolution = resolveInstrumentSoundFont(
      [createSoundFontPatchTab()],
      [connection],
      'instrument',
      clipAssignment,
      [defaultResource, alternateResource],
    );

    expect(resolution).toEqual({
      canResolve: true,
      selection: {
        bank: 2,
        program: 40,
        resource: alternateResource,
        source: 'clip',
      },
    });
  });

  it('prefers one MIDI Clip voice over a connected custom SoundFont', () => {
    const customPatchTab = createSoundFontPatchTab();
    customPatchTab.parameters = customPatchTab.parameters.map((parameter) => {
      if (parameter.id === 'soundfont-resource' && parameter.kind === 'select') {
        return { ...parameter, value: alternateResource.relativePath };
      }

      if (parameter.id === 'bank' && parameter.kind === 'number') {
        return { ...parameter, value: 8 };
      }

      if (parameter.id === 'program' && parameter.kind === 'number') {
        return { ...parameter, value: 24 };
      }

      return parameter;
    });

    expect(
      resolveInstrumentSoundFont(
        [customPatchTab],
        [connection],
        'instrument',
        clipAssignment,
        [defaultResource, alternateResource],
      ),
    ).toEqual({
      canResolve: true,
      selection: {
        bank: 2,
        program: 40,
        resource: alternateResource,
        source: 'clip',
      },
    });
  });

  it('uses the Piano Roll assignment only when no SoundFont is connected', () => {
    const resolution = resolveInstrumentSoundFont(
      [createSoundFontPatchTab()],
      [],
      'instrument',
      clipAssignment,
      [defaultResource, alternateResource],
    );

    expect(resolution).toEqual({
      canResolve: true,
      selection: {
        bank: 2,
        program: 40,
        resource: alternateResource,
        source: 'clip',
      },
    });
  });

  it('uses a connected custom SoundFont when the MIDI Clip has no voice', () => {
    const customPatchTab = createSoundFontPatchTab();
    customPatchTab.parameters = customPatchTab.parameters.map((parameter) => {
      if (parameter.id === 'soundfont-resource' && parameter.kind === 'select') {
        return { ...parameter, value: alternateResource.relativePath };
      }
      return parameter;
    });

    expect(
      resolveInstrumentSoundFont(
        [customPatchTab],
        [connection],
        'instrument',
        undefined,
        [defaultResource, alternateResource],
      ),
    ).toMatchObject({
      canResolve: true,
      selection: { resource: alternateResource, source: 'connection' },
    });
  });

  it('fails closed when a connected SoundFont is offline and no Clip voice exists', () => {
    const resolution = resolveInstrumentSoundFont(
      [createSoundFontPatchTab()],
      [connection],
      'instrument',
      undefined,
      [alternateResource],
    );

    expect(resolution).toMatchObject({
      canResolve: false,
      reason: 'soundfont-offline',
    });
  });
});
