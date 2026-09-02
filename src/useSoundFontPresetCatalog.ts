import { useEffect, useState } from 'react';

import type {
  LocalEngineSoundFontPresetCatalogResult,
  LocalEngineSoundFontResource,
} from './localEngineClient';

export type SoundFontPresetCatalogUiState =
  | Readonly<{ status: 'UNAVAILABLE' }>
  | Readonly<{ status: 'LOADING' }>
  | Readonly<{
      catalog: Extract<
        LocalEngineSoundFontPresetCatalogResult,
        { ok: true }
      >['catalog'];
      status: 'READY';
    }>
  | Readonly<{ message: string; status: 'ERROR' }>;

export type ListSoundFontPresets = (
  resource: LocalEngineSoundFontResource,
) => Promise<LocalEngineSoundFontPresetCatalogResult>;

export function useSoundFontPresetCatalog(
  resource: LocalEngineSoundFontResource | undefined,
  onListSoundFontPresets: ListSoundFontPresets,
): SoundFontPresetCatalogUiState {
  const [state, setState] = useState<SoundFontPresetCatalogUiState>({
    status: 'UNAVAILABLE',
  });
  const resourceKey = resource
    ? `${resource.resourceId}:${resource.revisionToken}`
    : '';

  useEffect(() => {
    let isCurrent = true;

    if (!resource) {
      setState({ status: 'UNAVAILABLE' });
      return () => {
        isCurrent = false;
      };
    }

    setState({ status: 'LOADING' });
    void onListSoundFontPresets(resource).then((result) => {
      if (!isCurrent) {
        return;
      }

      if (!result.ok) {
        setState({ message: result.message, status: 'ERROR' });
        return;
      }

      if (
        result.catalog.resourceId !== resource.resourceId ||
        result.catalog.revisionToken !== resource.revisionToken
      ) {
        setState({
          message: 'SoundFont voice catalog identity changed during loading.',
          status: 'ERROR',
        });
        return;
      }

      setState({ catalog: result.catalog, status: 'READY' });
    });

    return () => {
      isCurrent = false;
    };
  }, [onListSoundFontPresets, resourceKey]);

  return state;
}

export function createSoundFontPresetKey(bank: number, program: number): string {
  return `${bank}:${program}`;
}

export function parseSoundFontPresetKey(
  value: string,
): Readonly<{ bank: number; program: number }> | undefined {
  const match = /^(\d{1,5}):(\d{1,3})$/u.exec(value);

  if (!match) {
    return undefined;
  }

  const bank = Number(match[1]);
  const program = Number(match[2]);

  return Number.isSafeInteger(bank) &&
    bank >= 0 &&
    bank <= 16_383 &&
    Number.isSafeInteger(program) &&
    program >= 0 &&
    program <= 127
    ? Object.freeze({ bank, program })
    : undefined;
}
