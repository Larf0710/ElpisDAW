import { useMemo } from 'react';

import { getPreferredSoundFontResource } from './defaultSoundFontPreset';
import type {
  LocalEngineSoundFontPresetCatalogResult,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import { resolveMixerSoundFontTarget } from './mixerSoundFont';
import type { PianoRollSoundFontCatalogState } from './PianoRollSoundFontControl';
import { createProjectSoundFontAssignment } from './soundFontAssignment';
import type { ProjectState, SoundFontAssignment } from './types';
import {
  createSoundFontPresetKey,
  parseSoundFontPresetKey,
  useSoundFontPresetCatalog,
} from './useSoundFontPresetCatalog';

export function MixerSoundFontMenu({
  catalogState,
  disabled,
  project,
  onAssignSoundFont,
  onListSoundFontPresets,
}: Readonly<{
  catalogState: PianoRollSoundFontCatalogState;
  disabled: boolean;
  project: ProjectState;
  onAssignSoundFont: (
    clipId: string,
    assignment: SoundFontAssignment | undefined,
  ) => void;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
}>) {
  const target = useMemo(() => resolveMixerSoundFontTarget(project), [project]);

  if (target.status !== 'READY') {
    return (
      <section className="mixer-soundfont-menu unavailable" aria-label="Mixer SoundFont menu">
        <div className="mixer-soundfont-menu-title">
          <span>MIDI VOICE</span>
          <strong>SOUNDFONT</strong>
        </div>
        <output className="mixer-soundfont-indicator warning" aria-live="polite">
          <span>{target.status === 'MULTIPLE' ? 'MULTIPLE VOICES' : 'NO MIDI VOICE'}</span>
          <strong>{target.status === 'MULTIPLE' ? target.track.name : 'SELECT MIDI'}</strong>
          <small>{target.message}</small>
        </output>
      </section>
    );
  }

  return (
    <MixerSoundFontReadyMenu
      catalogState={catalogState}
      disabled={disabled}
      target={target}
      onAssignSoundFont={onAssignSoundFont}
      onListSoundFontPresets={onListSoundFontPresets}
    />
  );
}

function MixerSoundFontReadyMenu({
  catalogState,
  disabled,
  target,
  onAssignSoundFont,
  onListSoundFontPresets,
}: Readonly<{
  catalogState: PianoRollSoundFontCatalogState;
  disabled: boolean;
  target: Extract<ReturnType<typeof resolveMixerSoundFontTarget>, { status: 'READY' }>;
  onAssignSoundFont: (
    clipId: string,
    assignment: SoundFontAssignment | undefined,
  ) => void;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
}>) {
  const resources =
    catalogState.status === 'READY' ? catalogState.catalog.resources : [];
  const assignedResource = target.clip.soundFont
    ? resources.find(
        (resource) =>
          resource.resourceId === target.clip.soundFont?.resource.resourceId,
      )
    : undefined;
  const resource = target.clip.soundFont
    ? assignedResource
    : getPreferredSoundFontResource(resources);
  const selectedResourceId =
    target.clip.soundFont?.resource.resourceId ?? resource?.resourceId ?? '';
  const bank = target.clip.soundFont?.bank ?? 0;
  const program = target.clip.soundFont?.program ?? 0;
  const presetCatalogState = useSoundFontPresetCatalog(
    resource,
    onListSoundFontPresets,
  );
  const presets =
    presetCatalogState.status === 'READY'
      ? presetCatalogState.catalog.presets
      : [];
  const selectedPreset = presets.find(
    (preset) => preset.bank === bank && preset.program === program,
  );
  const selectedPresetKey = selectedPreset
    ? createSoundFontPresetKey(selectedPreset.bank, selectedPreset.program)
    : '';
  const banks = [...new Set(presets.map((preset) => preset.bank))].sort(
    (left, right) => left - right,
  );
  const programs = presets
    .filter((preset) => preset.bank === bank)
    .sort((left, right) => left.program - right.program);
  const isAssignmentOffline =
    target.clip.soundFont !== undefined &&
    catalogState.status === 'READY' &&
    assignedResource === undefined;
  const voiceName = selectedPreset?.name ??
    (presetCatalogState.status === 'LOADING'
      ? 'READING VOICES'
      : presetCatalogState.status === 'ERROR'
        ? 'VOICE CATALOG ERROR'
        : 'NAME UNAVAILABLE');
  const indicatorState = isAssignmentOffline
    ? 'OFFLINE'
    : target.clip.soundFont
      ? 'APPLIED'
      : 'DEFAULT';
  const canEdit =
    !disabled && catalogState.status === 'READY' && resources.length > 0;

  const assign = (
    nextResource: LocalEngineSoundFontResource | undefined,
    nextBank: number,
    nextProgram: number,
  ) => {
    if (!canEdit || !nextResource) {
      return;
    }

    onAssignSoundFont(
      target.clip.id,
      createProjectSoundFontAssignment(
        {
          format: nextResource.format,
          library: nextResource.library,
          relativePath: nextResource.relativePath,
          resourceId: nextResource.resourceId,
        },
        { bank: nextBank, program: nextProgram },
      ),
    );
  };

  return (
    <section className="mixer-soundfont-menu" aria-label="Mixer SoundFont menu">
      <div className="mixer-soundfont-menu-title">
        <span>MIDI VOICE</span>
        <strong>{target.clip.name}</strong>
        <small>{target.track.name}</small>
      </div>

      <div className="mixer-soundfont-controls">
        <label>
          <span>SoundFont</span>
          <select
            aria-label="Mixer SoundFont"
            disabled={!canEdit}
            value={selectedResourceId}
            onChange={(event) => {
              const nextResource = resources.find(
                (candidate) => candidate.resourceId === event.target.value,
              );
              assign(nextResource, 0, 0);
            }}
          >
            {resources.length === 0 && <option value="">NO SOUNDFONTS</option>}
            {isAssignmentOffline && target.clip.soundFont && (
              <option value={target.clip.soundFont.resource.resourceId} disabled>
                OFFLINE / {target.clip.soundFont.resource.relativePath}
              </option>
            )}
            {resources.map((candidate) => (
              <option key={candidate.resourceId} value={candidate.resourceId}>
                {candidate.library === 'builtin' ? 'BUILT-IN' : 'CUSTOM'} /{' '}
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mixer-soundfont-sound-control">
          <span>Sound</span>
          <select
            aria-label="Mixer Sound"
            disabled={!canEdit || presetCatalogState.status !== 'READY'}
            value={selectedPresetKey}
            onChange={(event) => {
              const selection = parseSoundFontPresetKey(event.target.value);
              if (selection) {
                assign(resource, selection.bank, selection.program);
              }
            }}
          >
            {!selectedPreset && (
              <option value="">B{bank} P{program} / NAME UNAVAILABLE</option>
            )}
            {presets.map((preset) => (
              <option
                key={createSoundFontPresetKey(preset.bank, preset.program)}
                value={createSoundFontPresetKey(preset.bank, preset.program)}
              >
                {preset.name} / B{preset.bank} P{preset.program}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Bank</span>
          <select
            aria-label="Mixer SoundFont Bank"
            disabled={!canEdit || presetCatalogState.status !== 'READY'}
            value={String(bank)}
            onChange={(event) => {
              const nextBank = Number(event.target.value);
              const nextPreset =
                presets.find(
                  (preset) =>
                    preset.bank === nextBank && preset.program === program,
                ) ?? presets.find((preset) => preset.bank === nextBank);
              if (nextPreset) {
                assign(resource, nextPreset.bank, nextPreset.program);
              }
            }}
          >
            {!banks.includes(bank) && <option value={bank}>{bank}</option>}
            {banks.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Program</span>
          <select
            aria-label="Mixer SoundFont Program"
            disabled={!canEdit || presetCatalogState.status !== 'READY'}
            value={String(program)}
            onChange={(event) => {
              const nextProgram = Number(event.target.value);
              const nextPreset = programs.find(
                (preset) => preset.program === nextProgram,
              );
              if (nextPreset) {
                assign(resource, nextPreset.bank, nextPreset.program);
              }
            }}
          >
            {!programs.some((preset) => preset.program === program) && (
              <option value={program}>{program}</option>
            )}
            {programs.map((preset) => (
              <option key={preset.program} value={preset.program}>
                {preset.program}
              </option>
            ))}
          </select>
        </label>
      </div>

      <output
        className={`mixer-soundfont-indicator ${
          isAssignmentOffline || !selectedPreset ? 'warning' : ''
        }`}
        aria-label="Mixer SoundFont voice indicator"
        aria-live="polite"
      >
        <span>{indicatorState}</span>
        <strong>{voiceName}</strong>
        <small>
          {resource
            ? `${resource.name} / B${bank} P${program} / AUTO APPLY`
            : 'Select or restore one SoundFont.'}
        </small>
      </output>
    </section>
  );
}
