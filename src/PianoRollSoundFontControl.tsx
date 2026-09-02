import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  LocalEngineSoundFontCatalog,
  LocalEngineSoundFontPresetCatalogResult,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import { getPreferredSoundFontResource } from './defaultSoundFontPreset';
import {
  createProjectSoundFontAssignment,
  SOUNDFONT_BANK_MAX,
  SOUNDFONT_BANK_MIN,
  SOUNDFONT_PROGRAM_MAX,
  SOUNDFONT_PROGRAM_MIN,
} from './soundFontAssignment';
import type { SoundFontAssignment } from './types';
import {
  createSoundFontPresetKey,
  parseSoundFontPresetKey,
  useSoundFontPresetCatalog,
} from './useSoundFontPresetCatalog';

export type PianoRollSoundFontCatalogState =
  | Readonly<{ status: 'UNAVAILABLE' }>
  | Readonly<{ status: 'LOADING' }>
  | Readonly<{ catalog: LocalEngineSoundFontCatalog; status: 'READY' }>
  | Readonly<{ message: string; status: 'ERROR' }>;

export type PianoRollSoundFontAuditionState =
  | Readonly<{ status: 'IDLE' }>
  | Readonly<{ message: string; status: 'RENDERING' | 'PLAYING' | 'ERROR' }>;

export function PianoRollSoundFontControl({
  assignment,
  catalogState,
  clipName,
  onAssign,
  onListSoundFontPresets,
  onRefresh,
}: {
  assignment?: SoundFontAssignment;
  catalogState: PianoRollSoundFontCatalogState;
  clipName: string;
  onAssign: (assignment: SoundFontAssignment | undefined) => void;
  onListSoundFontPresets: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onRefresh: () => void;
}) {
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draftResourceId, setDraftResourceId] = useState('');
  const [draftBank, setDraftBank] = useState('0');
  const [draftProgram, setDraftProgram] = useState('0');
  const [localMessage, setLocalMessage] = useState<string>();
  const resources =
    catalogState.status === 'READY'
      ? catalogState.catalog.resources
      : [];
  const assignmentResource = useMemo(
    () =>
      assignment
        ? resources.find(
            (resource) =>
              resource.resourceId === assignment.resource.resourceId,
          )
        : undefined,
    [assignment, resources],
  );
  const isAssignmentOffline =
    assignment !== undefined &&
    catalogState.status === 'READY' &&
    assignmentResource === undefined;
  const draftResource = resources.find(
    (resource) => resource.resourceId === draftResourceId,
  );
  const bank = Number(draftBank);
  const program = Number(draftProgram);
  const isBankValid = isIntegerInRange(
    bank,
    SOUNDFONT_BANK_MIN,
    SOUNDFONT_BANK_MAX,
  );
  const isProgramValid = isIntegerInRange(
    program,
    SOUNDFONT_PROGRAM_MIN,
    SOUNDFONT_PROGRAM_MAX,
  );
  const triggerStatus = isAssignmentOffline
    ? 'OFFLINE'
    : assignment
      ? `B${assignment.bank} P${assignment.program}`
      : resources.some((resource) => resource.library === 'builtin')
        ? 'BUILT-IN'
        : 'SELECT';
  const voiceCatalogResource = draftResource ?? assignmentResource;
  const presetCatalogState = useSoundFontPresetCatalog(
    voiceCatalogResource,
    onListSoundFontPresets,
  );
  const displayedBank = isBankValid ? bank : assignment?.bank ?? 0;
  const displayedProgram = isProgramValid
    ? program
    : assignment?.program ?? 0;
  const displayedPreset =
    presetCatalogState.status === 'READY'
      ? presetCatalogState.catalog.presets.find(
          (preset) =>
            preset.bank === displayedBank &&
            preset.program === displayedProgram,
        )
      : undefined;
  const displayedPresetKey = displayedPreset
    ? createSoundFontPresetKey(displayedPreset.bank, displayedPreset.program)
    : '';
  const displayedVoiceName = displayedPreset?.name ??
    (presetCatalogState.status === 'LOADING'
      ? 'READING VOICES'
      : presetCatalogState.status === 'ERROR'
        ? 'VOICE CATALOG ERROR'
        : 'NAME UNAVAILABLE');
  const isDisplayedVoiceApplied = Boolean(
    assignment &&
      voiceCatalogResource &&
      assignment.resource.resourceId === voiceCatalogResource.resourceId &&
      assignment.bank === displayedBank &&
      assignment.program === displayedProgram,
  );

  useEffect(() => {
    if (!isOpen || draftResourceId || resources.length === 0) {
      return;
    }

    setDraftResourceId(
      getPreferredSoundFontResource(resources, assignment?.resource.resourceId)
        ?.resourceId ?? '',
    );
  }, [assignment, draftResourceId, isOpen, resources]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !controlRef.current?.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      selectRef.current?.focus();
    }
  }, [isOpen]);

  const openPanel = () => {
    if (isOpen) {
      setIsOpen(false);
      return;
    }

    setDraftResourceId(
      getPreferredSoundFontResource(resources, assignment?.resource.resourceId)
        ?.resourceId ?? '',
    );
    setDraftBank(String(assignment?.bank ?? 0));
    setDraftProgram(String(assignment?.program ?? 0));
    setLocalMessage(undefined);
    setIsOpen(true);

    if (
      catalogState.status === 'UNAVAILABLE' ||
      catalogState.status === 'ERROR'
    ) {
      onRefresh();
    }
  };

  const assignVoice = (
    resource: LocalEngineSoundFontResource | undefined,
    nextBank: number,
    nextProgram: number,
  ) => {
    if (
      !resource ||
      !isIntegerInRange(nextBank, SOUNDFONT_BANK_MIN, SOUNDFONT_BANK_MAX) ||
      !isIntegerInRange(
        nextProgram,
        SOUNDFONT_PROGRAM_MIN,
        SOUNDFONT_PROGRAM_MAX,
      )
    ) {
      setLocalMessage('Select one valid SoundFont, Bank, and Program.');
      return;
    }

    onAssign(
      createProjectSoundFontAssignment(
        {
          format: resource.format,
          library: resource.library,
          relativePath: resource.relativePath,
          resourceId: resource.resourceId,
        },
        { bank: nextBank, program: nextProgram },
      ),
    );
    setLocalMessage('Applied immediately to this MIDI Clip. Use Undo to restore it.');
  };

  return (
    <div
      ref={controlRef}
      className={`piano-roll-soundfont-control ${
        isAssignmentOffline ? 'offline' : assignment ? 'assigned' : ''
      }`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="piano-roll-soundfont-trigger"
        aria-controls="piano-roll-soundfont-panel"
        aria-expanded={isOpen}
        onClick={openPanel}
        title="Use the built-in voice or select a custom SoundFont, Bank, and Program for this MIDI Clip"
      >
        <span>SOUNDFONT</span>
        <small>{triggerStatus}</small>
      </button>
      {isOpen && (
        <section
          id="piano-roll-soundfont-panel"
          className="piano-roll-soundfont-panel"
          role="dialog"
          aria-label={`SoundFont assignment for ${clipName}`}
        >
          <header>
            <div>
              <span>CLIP VOICE</span>
              <strong>SOUNDFONT</strong>
            </div>
            <button
              type="button"
              className="piano-roll-soundfont-close"
              aria-label="Close SoundFont selector"
              onClick={() => {
                setIsOpen(false);
                triggerRef.current?.focus();
              }}
            >
              ×
            </button>
          </header>

          <label>
            <span>SET</span>
            <select
              ref={selectRef}
              value={draftResourceId}
              disabled={catalogState.status !== 'READY' || resources.length === 0}
              onChange={(event) => {
                const nextResourceId = event.target.value;
                const nextResource = resources.find(
                  (resource) => resource.resourceId === nextResourceId,
                );
                setDraftResourceId(nextResourceId);
                setDraftBank('0');
                setDraftProgram('0');
                assignVoice(nextResource, 0, 0);
              }}
            >
              {resources.length === 0 && (
                <option value="">NO SOUNDFONTS</option>
              )}
              {isAssignmentOffline && (
                <option value={assignment.resource.resourceId} disabled>
                  OFFLINE / {getFileName(assignment.resource.relativePath)}
                </option>
              )}
              {resources.map((resource) => (
                <option key={resource.resourceId} value={resource.resourceId}>
                  {resource.library === 'builtin' ? 'BUILT-IN' : 'CUSTOM'} /{' '}
                  {resource.name} / {resource.format.toUpperCase()}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>SOUND</span>
            <select
              aria-label="Piano Roll SoundFont Sound"
              disabled={presetCatalogState.status !== 'READY'}
              value={displayedPresetKey}
              onChange={(event) => {
                const selection = parseSoundFontPresetKey(event.target.value);
                if (!selection) {
                  return;
                }

                setDraftBank(String(selection.bank));
                setDraftProgram(String(selection.program));
                assignVoice(draftResource, selection.bank, selection.program);
              }}
            >
              {!displayedPreset && (
                <option value="">
                  B{displayedBank} P{displayedProgram} / NAME UNAVAILABLE
                </option>
              )}
              {presetCatalogState.status === 'READY' &&
                presetCatalogState.catalog.presets.map((preset) => (
                  <option
                    key={createSoundFontPresetKey(preset.bank, preset.program)}
                    value={createSoundFontPresetKey(preset.bank, preset.program)}
                  >
                    {preset.name} / B{preset.bank} P{preset.program}
                  </option>
                ))}
            </select>
          </label>

          <div className="piano-roll-soundfont-number-grid">
            <label>
              <span>BANK</span>
              <input
                type="number"
                inputMode="numeric"
                min={SOUNDFONT_BANK_MIN}
                max={SOUNDFONT_BANK_MAX}
                step={1}
                value={draftBank}
                onChange={(event) => {
                  const nextDraft = event.target.value;
                  const nextBank = Number(nextDraft);
                  setDraftBank(nextDraft);
                  if (
                    isIntegerInRange(
                      nextBank,
                      SOUNDFONT_BANK_MIN,
                      SOUNDFONT_BANK_MAX,
                    ) &&
                    isProgramValid
                  ) {
                    assignVoice(draftResource, nextBank, program);
                  }
                }}
              />
            </label>
            <label>
              <span>PROGRAM</span>
              <input
                type="number"
                inputMode="numeric"
                min={SOUNDFONT_PROGRAM_MIN}
                max={SOUNDFONT_PROGRAM_MAX}
                step={1}
                value={draftProgram}
                onChange={(event) => {
                  const nextDraft = event.target.value;
                  const nextProgram = Number(nextDraft);
                  setDraftProgram(nextDraft);
                  if (
                    isBankValid &&
                    isIntegerInRange(
                      nextProgram,
                      SOUNDFONT_PROGRAM_MIN,
                      SOUNDFONT_PROGRAM_MAX,
                    )
                  ) {
                    assignVoice(draftResource, bank, nextProgram);
                  }
                }}
              />
            </label>
          </div>

          <output
            className={`piano-roll-soundfont-voice-indicator ${
              isAssignmentOffline || !displayedPreset ? 'warning' : ''
            }`}
            aria-label="Piano Roll SoundFont voice indicator"
            aria-live="polite"
          >
            <span>
              {isAssignmentOffline
                ? 'OFFLINE'
                : isDisplayedVoiceApplied
                  ? 'APPLIED'
                  : 'PREVIEW'}
            </span>
            <strong>{displayedVoiceName}</strong>
            <small>
              {voiceCatalogResource
                ? `${voiceCatalogResource.name} / B${displayedBank} P${displayedProgram}`
                : 'Select one SoundFont to read its voice name.'}
            </small>
          </output>

          <SoundFontCatalogReadout
            assignment={assignment}
            assignmentResource={assignmentResource}
            catalogState={catalogState}
            draftResource={draftResource}
            isAssignmentOffline={isAssignmentOffline}
            localMessage={localMessage}
          />
        </section>
      )}
    </div>
  );
}

function SoundFontCatalogReadout({
  assignment,
  assignmentResource,
  catalogState,
  draftResource,
  isAssignmentOffline,
  localMessage,
}: {
  assignment?: SoundFontAssignment;
  assignmentResource?: LocalEngineSoundFontResource;
  catalogState: PianoRollSoundFontCatalogState;
  draftResource?: LocalEngineSoundFontResource;
  isAssignmentOffline: boolean;
  localMessage?: string;
}) {
  const status = getCatalogStatus(catalogState, isAssignmentOffline);
  const detail =
    localMessage ??
        (isAssignmentOffline
          ? `Expected ${assignment?.resource.relativePath ?? 'SoundFont resource'}.`
          : draftResource
            ? `${draftResource.relativePath} / CHANGES APPLY IMMEDIATELY`
            : assignmentResource
              ? `${assignmentResource.relativePath} / APPLIED TO MIDI CLIP`
              : getCatalogHelp(catalogState));

  return (
    <output
      className={`piano-roll-soundfont-help ${
        isAssignmentOffline ||
        catalogState.status === 'ERROR'
          ? 'warning'
          : ''
      }`}
      aria-live="polite"
    >
      <strong>{status}</strong>
      <span>{detail}</span>
    </output>
  );
}

function getCatalogStatus(
  state: PianoRollSoundFontCatalogState,
  isAssignmentOffline: boolean,
): string {
  if (isAssignmentOffline) {
    return 'SOUNDFONT OFFLINE';
  }

  if (state.status === 'UNAVAILABLE') {
    return 'CATALOG UNAVAILABLE';
  }

  if (state.status === 'LOADING') {
    return 'SCANNING SOUNDFONTS';
  }

  if (state.status === 'ERROR') {
    return 'CATALOG ERROR';
  }

  return state.catalog.resources.length > 0
    ? `${state.catalog.resources.length} SET${
        state.catalog.resources.length === 1 ? '' : 'S'
      } READY`
    : 'NO SOUNDFONTS FOUND';
}

function getCatalogHelp(state: PianoRollSoundFontCatalogState): string {
  if (state.status === 'ERROR') {
    return state.message;
  }

  if (state.status === 'UNAVAILABLE') {
    return 'Start Local Engine and select Project Root.';
  }

  if (state.status === 'LOADING') {
    return 'Reading built-in and custom SoundFonts.';
  }

  if (state.catalog.issues.length > 0) {
    return `${state.catalog.issues.length} catalog issue${
      state.catalog.issues.length === 1 ? '' : 's'
    } skipped.`;
  }

  return 'MuseScore General is built in. Place licensed custom .sf2 or .sf3 files in the Project soundfonts directory.';
}

function getFileName(relativePath: string): string {
  const segments = relativePath.split('/');
  return segments[segments.length - 1] ?? relativePath;
}

function isIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}
