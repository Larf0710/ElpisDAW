import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';

import type { MixerEffectState } from '../shared/mixerEffectsContract.js';
import type { ProjectMixerEffectCommand } from './projectMixerEffectsCommand';
import type {
  LocalEngineSoundFontPresetCatalogResult,
  LocalEngineSoundFontResource,
} from './localEngineClient';
import { MixerSoundFontMenu } from './MixerSoundFontMenu';
import type { PianoRollSoundFontCatalogState } from './PianoRollSoundFontControl';
import type {
  ProjectPlaybackMeterScope,
  ProjectPlaybackMeterStore,
} from './projectPlaybackMeterStore';
import type { ProjectState, SoundFontAssignment } from './types';
import type { MixerProjectMixdownControlModel } from './projectMixdownUiState';
import type { ProjectStemPrintTargetOption } from './projectStemPrintSelection';
import type { ProjectStemPrintTarget } from './projectStemPrintPlan';
import type { MixerProjectStemPrintControlModel } from './projectStemPrintUiState';
import {
  createMixerMasterPeakHoldPresentation,
  createMixerMasterPeakHoldState,
  reduceMixerMasterPeakHoldState,
} from './mixerMasterPeakHold';
import {
  findNestedVerticalScrollOwners,
  routeVerticalWheelPriority,
} from './mixerDockWheelScroll';
import {
  createMixerEffectBypassUiCommand,
  createMixerEffectParameterUiCommand,
  createMixerEffectResetUiCommand,
  createMixerMeterBarPresentation,
  formatMixerConsoleFaderValue,
  formatMixerConsolePanValue,
  formatMixerEffectParameterValue,
  getMixerEffectUiPresentation,
  parseMixerEffectParameterDraft,
  resolveMixerEffectsConsole,
  resolveMixerEffectsUiStrip,
  stepMixerEffectParameterValue,
  type MixerEffectsConsoleChannelStrip,
  type MixerEffectsConsoleMasterStrip,
  type MixerEffectUiParameterPresentation,
  type MixerEffectsUiReadyStrip,
} from './mixerEffectsUiModel';

export type MixerEffectsEditorCommandOutcome = Readonly<{
  message: string;
  status: 'BLOCKED' | 'EXECUTED' | 'NO_OP';
}>;

type MixerEffectsEditorProps = Readonly<{
  activeTransport: 'EXPORT' | 'LOOP' | 'PLAY' | 'REC' | 'STOP';
  isActive: boolean;
  isEditingLocked: boolean;
  meterStore: ProjectPlaybackMeterStore;
  projectMixdownControl: MixerProjectMixdownControlModel;
  projectStemPrintControl?: MixerProjectStemPrintControlModel;
  projectStemPrintOptions?: readonly ProjectStemPrintTargetOption[];
  selectedProjectStemPrintTargetKeys?: readonly string[];
  onCancelProjectMixdown: () => void;
  onCommand: (
    command: ProjectMixerEffectCommand,
  ) => MixerEffectsEditorCommandOutcome;
  onRequestReset: (
    command: ProjectMixerEffectCommand,
    description: string,
  ) => void;
  onRecoverProjectMixdown: () => void;
  onAssignSoundFont?: (
    clipId: string,
    assignment: SoundFontAssignment | undefined,
  ) => void;
  onListSoundFontPresets?: (
    resource: LocalEngineSoundFontResource,
  ) => Promise<LocalEngineSoundFontPresetCatalogResult>;
  onSelectTrack: (trackId: string) => void;
  onRunProjectMixdown: () => void;
  onCancelProjectStemPrint?: () => void;
  onRecoverProjectStemPrint?: () => void;
  onRunProjectStemPrint?: () => void;
  onToggleProjectStemPrintTarget?: (target: ProjectStemPrintTarget) => void;
  onToggleTrackMute: (trackId: string) => void;
  project: ProjectState;
  soundFontCatalogState?: PianoRollSoundFontCatalogState;
}>;

const keyboardCommitKeys = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
]);

const mixerWheelInteractiveTargetSelector = [
  'input',
  'select',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
].join(',');

const defaultProjectStemPrintControl: MixerProjectStemPrintControlModel =
  Object.freeze({
    canCancel: false,
    canRecover: false,
    canRun: false,
    label: 'SELECT TARGETS',
    message: 'Select one or more Mixer Channels or Groups.',
    showCancel: false,
    showRecover: false,
    tone: 'warning',
  });

function noOp(): void {}

async function listUnavailableSoundFontPresets(): Promise<LocalEngineSoundFontPresetCatalogResult> {
  return {
    message: 'SoundFont voice catalog is unavailable.',
    ok: false,
    reason: 'offline',
  };
}

export function MixerEffectsEditor({
  activeTransport,
  isActive,
  isEditingLocked,
  meterStore,
  projectMixdownControl,
  projectStemPrintControl = defaultProjectStemPrintControl,
  projectStemPrintOptions = [],
  selectedProjectStemPrintTargetKeys = [],
  onCancelProjectMixdown,
  onAssignSoundFont = noOp,
  onCommand,
  onListSoundFontPresets = listUnavailableSoundFontPresets,
  onRecoverProjectMixdown,
  onRequestReset,
  onSelectTrack,
  onRunProjectMixdown,
  onCancelProjectStemPrint = noOp,
  onRecoverProjectStemPrint = noOp,
  onRunProjectStemPrint = noOp,
  onToggleProjectStemPrintTarget = noOp,
  onToggleTrackMute,
  project,
  soundFontCatalogState = { status: 'UNAVAILABLE' },
}: MixerEffectsEditorProps) {
  const strip = useMemo(() => resolveMixerEffectsUiStrip(project), [project]);
  const consoleResolution = useMemo(
    () => resolveMixerEffectsConsole(project),
    [project],
  );
  const metersActive = isActive && activeTransport === 'PLAY';
  const [selectedEffectType, setSelectedEffectType] = useState<
    MixerEffectState['effectType']
  >('equalizer');
  const [statusMessage, setStatusMessage] = useState(
    'Select an Insert, then edit one parameter at a time.',
  );

  useEffect(() => {
    if (strip.status === 'READY') {
      setSelectedEffectType(strip.effects[0].effectType);
      setStatusMessage('Select an Insert, then edit one parameter at a time.');
    } else {
      setStatusMessage(strip.message);
    }
  }, [strip.key]);

  const handleMixerDockWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget.closest<HTMLElement>('.top-dock-viewport');
    const targetIsInteractive = event.target instanceof Element &&
      event.target.closest(mixerWheelInteractiveTargetSelector) !== null;

    if (!viewport) {
      return;
    }

    const nestedOwners = findNestedVerticalScrollOwners(
      event.target,
      event.currentTarget,
    );

    routeVerticalWheelPriority(
      {
        defaultPrevented: event.defaultPrevented,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        shiftKey: event.shiftKey,
        targetIsInteractive,
        preventDefault: () => event.preventDefault(),
      },
      [...nestedOwners, viewport],
    );
  };

  if (strip.status === 'EMPTY') {
    return (
      <div
        className={`top-dock-pane ${isActive ? 'active' : ''}`}
        hidden={!isActive}
        onWheel={handleMixerDockWheel}
      >
        <section
          className="mixer-effects-panel mixer-effects-empty panel"
          aria-label="Mixer Effects, no editable Channel selected"
        >
          <MixerConsoleOverview
            consoleResolution={consoleResolution}
            meterStore={meterStore}
            metersActive={metersActive}
            onSelectTrack={onSelectTrack}
            onToggleTrackMute={onToggleTrackMute}
          />
          <MixerSoundFontMenu
            catalogState={soundFontCatalogState}
            disabled={isEditingLocked}
            project={project}
            onAssignSoundFont={onAssignSoundFont}
            onListSoundFontPresets={onListSoundFontPresets}
          />
          <div className="mixer-effects-empty-display" role="status">
            <span>SELECTED STRIP</span>
            <strong>No editable Channel</strong>
            <p>{strip.message}</p>
          </div>
        </section>
      </div>
    );
  }

  const selectedEffect =
    strip.effects.find((effect) => effect.effectType === selectedEffectType) ??
    strip.effects[0];
  const selectedPresentation = getMixerEffectUiPresentation(
    selectedEffect.effectType,
  );
  const enabledEffectCount = strip.effects.filter((effect) => !effect.bypass).length;
  const selectedConsoleChannel = consoleResolution.status === 'READY' && strip.scope === 'channel'
    ? consoleResolution.channels.find((channel) => channel.trackId === strip.trackId)
    : undefined;
  const runCommand = (command: ProjectMixerEffectCommand) => {
    const outcome = onCommand(command);
    setStatusMessage(outcome.message);
    return outcome;
  };

  return (
    <div
      className={`top-dock-pane ${isActive ? 'active' : ''}`}
      hidden={!isActive}
      onWheel={handleMixerDockWheel}
    >
      <section
        className={`mixer-effects-panel panel has-editable-strip scope-${strip.scope}`}
        aria-label={strip.proxy
          ? `Group proxy Mixer Effects for ${strip.proxy.groupName}, active Channel ${strip.proxy.targetName}`
          : strip.scope === 'master'
            ? `Master bus Mixer Effects for ${strip.name}`
            : `Channel Mixer Effects for ${strip.name}`}
      >
        <MixerConsoleOverview
          consoleResolution={consoleResolution}
          meterStore={meterStore}
          metersActive={metersActive}
          onSelectTrack={onSelectTrack}
          onToggleTrackMute={onToggleTrackMute}
        />

        <div className="mixer-effects-workspace">
          <MixerSoundFontMenu
            catalogState={soundFontCatalogState}
            disabled={isEditingLocked}
            project={project}
            onAssignSoundFont={onAssignSoundFont}
            onListSoundFontPresets={onListSoundFontPresets}
          />

          <div className="mixer-insert-rack" aria-label={`${strip.name} fixed Insert chain`}>
            <span className="mixer-section-label">FIXED INSERTS</span>
            <div className="mixer-insert-list" role="list">
              {strip.effects.map((effect, index) => {
                const presentation = getMixerEffectUiPresentation(effect.effectType);
                const isSelected = effect.effectType === selectedEffect.effectType;

                return (
                  <button
                    type="button"
                    key={effect.effectType}
                    className={`mixer-insert-button ${isSelected ? 'selected' : ''} ${
                      effect.bypass ? 'bypassed' : 'enabled'
                    }`}
                    aria-label={`${strip.name} ${presentation.label} Insert, ${
                      effect.bypass ? 'bypassed' : 'enabled'
                    }`}
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedEffectType(effect.effectType);
                      setStatusMessage(`${presentation.label} selected.`);
                    }}
                  >
                    <span className="mixer-insert-order">{String(index + 1).padStart(2, '0')}</span>
                    <strong>{presentation.shortLabel}</strong>
                    <span className="mixer-insert-state">
                      {effect.bypass ? 'BYPASS' : 'ON'}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mixer-chain-note">
              {strip.scope === 'master'
                ? 'EQ → COMP → LIMITER · LIMITER LAST'
                : 'EQ → COMP → DELAY'}
            </p>
          </div>

          <div className="mixer-effect-center-column">
            <div className="mixer-effect-editor" key={`${strip.key}:${selectedEffect.effectType}`}>
              <div className="mixer-effect-toolbar">
                <div>
                  <span className="mixer-section-label">EDITING</span>
                  <strong>{selectedPresentation.label}</strong>
                </div>
                <div className="mixer-effect-actions">
                  <button
                    type="button"
                    className={`mixer-effect-bypass ${selectedEffect.bypass ? 'active' : ''}`}
                    aria-label={`${strip.name} ${selectedPresentation.label} Bypass`}
                    aria-pressed={selectedEffect.bypass}
                    disabled={isEditingLocked}
                    onClick={() =>
                      runCommand(
                        createMixerEffectBypassUiCommand(
                          strip,
                          selectedEffect,
                          !selectedEffect.bypass,
                        ),
                      )
                    }
                  >
                    BYPASS
                  </button>
                  <button
                    type="button"
                    className="mixer-effect-reset"
                    aria-label={`Reset ${strip.name} ${selectedPresentation.label}`}
                    disabled={isEditingLocked}
                    onClick={() =>
                      onRequestReset(
                        createMixerEffectResetUiCommand(strip, selectedEffect),
                        `${strip.name} ${selectedPresentation.label}`,
                      )
                    }
                  >
                    RESET
                  </button>
                </div>
              </div>

              <div className="mixer-parameter-bank">
                {selectedPresentation.parameters.map((parameterPresentation) => (
                  <MixerEffectParameterControl
                    disabled={isEditingLocked}
                    effect={selectedEffect}
                    key={parameterPresentation.name}
                    onCommand={runCommand}
                    onStatus={setStatusMessage}
                    parameter={parameterPresentation}
                    strip={strip}
                  />
                ))}
              </div>
            </div>

            <div className="mixer-effects-status-line" role="status" aria-live="polite">
              <span>{activeTransport === 'PLAY' ? 'FROZEN PLAYBACK' : 'EDIT READY'}</span>
              <p>
                {activeTransport === 'PLAY'
                  ? `${statusMessage} Changes apply on the next playback operation.`
                  : statusMessage}
              </p>
            </div>
          </div>

          <MixerEffectsMeterBlock
            effectsState={enabledEffectCount > 0 ? `${enabledEffectCount} ACTIVE` : 'ALL BYPASSED'}
            inactiveReason={selectedConsoleChannel
              ? getMixerConsoleMeterInactiveReason(selectedConsoleChannel)
              : undefined}
            meterStore={meterStore}
            metersActive={metersActive}
            projectMixdownControl={projectMixdownControl}
            projectStemPrintControl={projectStemPrintControl}
            projectStemPrintOptions={projectStemPrintOptions}
            selectedProjectStemPrintTargetKeys={selectedProjectStemPrintTargetKeys}
            onCancelProjectMixdown={onCancelProjectMixdown}
            onCancelProjectStemPrint={onCancelProjectStemPrint}
            onRecoverProjectMixdown={onRecoverProjectMixdown}
            onRecoverProjectStemPrint={onRecoverProjectStemPrint}
            onRunProjectMixdown={onRunProjectMixdown}
            onRunProjectStemPrint={onRunProjectStemPrint}
            onToggleProjectStemPrintTarget={onToggleProjectStemPrintTarget}
            strip={strip}
          />
        </div>
      </section>
    </div>
  );
}

function MixerConsoleOverview({
  consoleResolution,
  meterStore,
  metersActive,
  onSelectTrack,
  onToggleTrackMute,
}: Readonly<{
  consoleResolution: ReturnType<typeof resolveMixerEffectsConsole>;
  meterStore: ProjectPlaybackMeterStore;
  metersActive: boolean;
  onSelectTrack: (trackId: string) => void;
  onToggleTrackMute: (trackId: string) => void;
}>) {
  return (
    <section className="mixer-console-overview" aria-label="Mixer Console overview">
      {consoleResolution.status === 'UNAVAILABLE' ? (
        <div className="mixer-console-unavailable" role="status">
          {consoleResolution.message}
        </div>
      ) : (
        <div className={`mixer-console-ready ${consoleResolution.selectedGroupProxy ? 'has-proxy' : ''}`}>
          {consoleResolution.selectedGroupProxy && (
            <div className="mixer-console-group-proxy" role="status">
              <span>GROUP PROXY</span>
              <strong>{consoleResolution.selectedGroupProxy.groupName}</strong>
              <b aria-hidden="true">&gt;</b>
              <strong>{consoleResolution.selectedGroupProxy.targetName}</strong>
            </div>
          )}
          <div className="mixer-console-layout">
            <div
              className="mixer-console-channel-scroll"
              aria-label="Project Channel strips in Timeline order"
              tabIndex={0}
            >
              <div className="mixer-console-channel-bank">
                {consoleResolution.channels.map((channel, index) => (
                  <MixerConsoleStrip
                    key={channel.trackId}
                    meterStore={meterStore}
                    metersActive={metersActive}
                    onSelectTrack={onSelectTrack}
                    onToggleTrackMute={onToggleTrackMute}
                    order={index + 1}
                    strip={channel}
                  />
                ))}
                {consoleResolution.channels.length === 0 && (
                  <div className="mixer-console-no-channels" role="status">
                    No eligible Channel tracks.
                  </div>
                )}
              </div>
            </div>
            <div className="mixer-console-master-dock" aria-label="Fixed Master strip">
              <MixerConsoleStrip
                meterStore={meterStore}
                metersActive={metersActive}
                onSelectTrack={onSelectTrack}
                onToggleTrackMute={onToggleTrackMute}
                order="M"
                strip={consoleResolution.master}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function MixerConsoleStrip({
  meterStore,
  metersActive,
  onSelectTrack,
  onToggleTrackMute,
  order,
  strip,
}: Readonly<{
  meterStore: ProjectPlaybackMeterStore;
  metersActive: boolean;
  onSelectTrack: (trackId: string) => void;
  onToggleTrackMute: (trackId: string) => void;
  order: number | 'M';
  strip: MixerEffectsConsoleChannelStrip | MixerEffectsConsoleMasterStrip;
}>) {
  const enabledEffects = strip.effects.filter((effect) => !effect.bypass).length;
  const trackId = strip.trackId;
  const inactiveMeterReason = strip.scope === 'channel'
    ? getMixerConsoleMeterInactiveReason(strip)
    : undefined;
  const isDeemphasized = strip.scope === 'channel' && strip.audibility === 'SOLO_EXCLUDED';
  const accessibilityState = strip.scope === 'channel'
    ? [
        strip.audibility === 'MUTED'
          ? 'MUTED'
          : strip.audibility === 'SOLO_EXCLUDED'
            ? 'excluded by Solo'
            : 'audible',
        strip.sourceStatus === 'SOURCE_OFFLINE' ? 'SOURCE OFFLINE' : undefined,
      ].filter(Boolean).join(', ')
    : 'stereo Master bus';

  return (
    <div
      className={`mixer-console-strip mixer-console-${strip.scope} ${
        strip.selected ? 'selected' : ''
      } ${isDeemphasized ? 'solo-excluded' : ''} ${
        strip.scope === 'channel' && strip.muted ? 'muted' : ''
      } ${strip.scope === 'channel' && strip.sourceStatus === 'SOURCE_OFFLINE' ? 'source-offline' : ''} ${
        strip.scope === 'channel' && strip.groupPath.length > 0 ? 'has-group-path' : ''
      }`}
    >
      {strip.scope === 'channel' ? (
        <div className="mixer-console-channel-mute-row">
          <button
            type="button"
            aria-label={`${strip.muted ? 'Unmute' : 'Mute'} ${strip.name} Track`}
            aria-pressed={strip.muted}
            onClick={() => runMixerTrackMuteAction(onToggleTrackMute, strip.trackId)}
          >
            {strip.muted ? 'UNMUTE' : 'MUTE'}
          </button>
          <span
            className={strip.muted ? 'muted' : 'on'}
            role="status"
            aria-label={`${strip.name} Track ${strip.muted ? 'muted' : 'on'}`}
          >
            {strip.muted ? 'MUTED' : 'ON'}
          </span>
        </div>
      ) : (
        <MixerMasterPeakHoldControls
          meterStore={meterStore}
          metersActive={metersActive}
        />
      )}
      <button
        type="button"
        className="mixer-console-strip-select"
        aria-label={`Open ${strip.name} ${
          strip.scope === 'master' ? 'Master' : 'Channel'
        } details, ${accessibilityState}`}
        aria-pressed={strip.selected}
        data-mixer-selection-target="true"
        disabled={!trackId}
        onClick={() => trackId && onSelectTrack(trackId)}
      >
        <span className="mixer-console-strip-order">
          {typeof order === 'number' ? String(order).padStart(2, '0') : order}
        </span>
        {strip.scope === 'channel' && strip.groupPath.length > 0 && (
          <span
            className="mixer-console-group-path"
            aria-label={`${strip.name} Group path ${strip.groupPath.map((group) => group.name).join(', ')}`}
          >
            {strip.groupPath.map((group) => group.name).join(' / ')}
          </span>
        )}
        <strong className="mixer-console-strip-name">{strip.name}</strong>
        {strip.scope === 'channel' && (
          <span className="mixer-console-routing-state" aria-live="off">
            {[
              strip.muted
                ? 'MUTED'
                : strip.audibility === 'SOLO_EXCLUDED'
                  ? 'SOLO EXCLUDED'
                  : 'ROUTED',
              strip.sourceStatus === 'SOURCE_OFFLINE' ? 'SOURCE OFFLINE' : undefined,
            ].filter(Boolean).join(' / ')}
          </span>
        )}
        <span className="mixer-console-level-section">
          <MixerConsoleVerticalMeter
            inactiveReason={inactiveMeterReason}
            meterStore={meterStore}
            metersActive={metersActive}
            name={strip.name}
            scope={strip.scope}
            trackId={trackId}
          />
          <span
            className="mixer-console-fader-slot"
            aria-label={`${strip.name} vertical Volume fader slot, current value ${formatMixerConsoleFaderValue(
              strip.faderDb,
            )}; control available in the next console slice`}
          >
            <span>VOL</span>
            <i aria-hidden="true" />
            <b>{formatMixerConsoleFaderValue(strip.faderDb)}</b>
          </span>
        </span>
        {strip.scope === 'channel' ? (
          <span className="mixer-console-channel-controls">
            <span aria-label={`${strip.name} Pan ${formatMixerConsolePanValue(strip.pan)}`}>
              PAN <b>{formatMixerConsolePanValue(strip.pan)}</b>
            </span>
            <span
              className={strip.muted ? 'active' : ''}
              aria-label={`${strip.name} Mute ${strip.muted ? 'on' : 'off'}`}
            >
              M
            </span>
            <span
              className={strip.solo ? 'active' : ''}
              aria-label={`${strip.name} Solo ${strip.solo ? 'on' : 'off'}`}
            >
              S
            </span>
          </span>
        ) : (
          <span className="mixer-console-master-label">STEREO BUS</span>
        )}
        <span
          className="mixer-console-insert-status"
          aria-label={`${strip.name} Inserts, ${enabledEffects} enabled`}
        >
          {strip.effects.map((effect) => (
            <span
              className={effect.bypass ? 'bypassed' : 'enabled'}
              key={effect.effectType}
            >
              {getMixerEffectUiPresentation(effect.effectType).shortLabel}
            </span>
          ))}
        </span>
      </button>
    </div>
  );
}

export function runMixerTrackMuteAction(
  onToggleTrackMute: (trackId: string) => void,
  trackId: string,
): void {
  onToggleTrackMute(trackId);
}

function MixerMasterPeakHoldControls({
  meterStore,
  metersActive,
}: Readonly<{
  meterStore: ProjectPlaybackMeterStore;
  metersActive: boolean;
}>) {
  const meter = useProjectPlaybackMeter(
    meterStore,
    'master',
    undefined,
    metersActive,
  );
  const [heldPeak, dispatch] = useReducer(
    reduceMixerMasterPeakHoldState,
    undefined,
    createMixerMasterPeakHoldState,
  );

  useEffect(() => {
    if (meter) {
      dispatch({ meter, type: 'OBSERVE' });
    }
  }, [meter]);

  const presentation = createMixerMasterPeakHoldPresentation(
    heldPeak,
    meter,
  );

  return (
    <div
      className={`mixer-master-peak-hold ${presentation.tone}`}
      aria-label="Master Peak Hold controls"
    >
      <div className="mixer-master-peak-hold-status" role="status" aria-live="polite">
        <span>PEAK HOLD</span>
        <strong title={presentation.message}>{presentation.label}</strong>
      </div>
      <button
        type="button"
        aria-label="Reset Master Peak Hold"
        onClick={() => dispatch({ type: 'RESET' })}
      >
        RESET PEAK
      </button>
    </div>
  );
}

function MixerConsoleVerticalMeter({
  inactiveReason,
  meterStore,
  metersActive,
  name,
  scope,
  trackId,
}: Readonly<{
  inactiveReason?: string;
  meterStore: ProjectPlaybackMeterStore;
  metersActive: boolean;
  name: string;
  scope: ProjectPlaybackMeterScope;
  trackId?: string;
}>) {
  const meter = useProjectPlaybackMeter(
    meterStore,
    scope,
    trackId,
    metersActive && !inactiveReason,
  );

  if (!meter || inactiveReason) {
    const meterState = inactiveReason ?? 'OFF';
    return (
      <span
        className="mixer-console-meter-slot unavailable"
        aria-label={`${name} exact meter ${inactiveReason ? `inactive, ${inactiveReason}` : 'unavailable'}`}
      >
        <span>L</span>
        <i aria-hidden="true" />
        <span>R</span>
        <i aria-hidden="true" />
        <b>{meterState}</b>
      </span>
    );
  }

  const left = createMixerMeterBarPresentation(
    meter.left.peak,
    meter.left.clipped,
  );
  const right = createMixerMeterBarPresentation(
    meter.right.peak,
    meter.right.clipped,
  );

  return (
    <span
      className="mixer-console-meter-slot available"
      aria-label={`${name} exact L peak ${left.measurementPeak}${
        left.clipped ? ', clipped' : ''
      }; R peak ${right.measurementPeak}${right.clipped ? ', clipped' : ''}`}
    >
      <span>L</span>
      <i
        className={left.clipped ? 'clipped' : ''}
        aria-hidden="true"
        style={{ '--mixer-console-meter-fill': `${left.fillRatio * 100}%` } as CSSProperties}
      />
      <span>R</span>
      <i
        className={right.clipped ? 'clipped' : ''}
        aria-hidden="true"
        style={{ '--mixer-console-meter-fill': `${right.fillRatio * 100}%` } as CSSProperties}
      />
      <b>{left.clipped || right.clipped ? 'CLIP' : 'LIVE'}</b>
    </span>
  );
}

function useProjectPlaybackMeter(
  meterStore: ProjectPlaybackMeterStore,
  scope: ProjectPlaybackMeterScope,
  trackId: string | undefined,
  active: boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      active
        ? meterStore.subscribe(scope, trackId, listener)
        : () => undefined,
    [active, meterStore, scope, trackId],
  );
  const getSnapshot = useCallback(
    () => active ? meterStore.getMeter(scope, trackId) : undefined,
    [active, meterStore, scope, trackId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function MixerEffectParameterControl({
  disabled,
  effect,
  onCommand,
  onStatus,
  parameter,
  strip,
}: Readonly<{
  disabled: boolean;
  effect: MixerEffectState;
  onCommand: (
    command: ProjectMixerEffectCommand,
  ) => MixerEffectsEditorCommandOutcome;
  onStatus: (message: string) => void;
  parameter: MixerEffectUiParameterPresentation;
  strip: MixerEffectsUiReadyStrip;
}>) {
  const effectPresentation = getMixerEffectUiPresentation(effect.effectType);
  const currentValue = getEffectParameterValue(effect, parameter.name);
  const [draftText, setDraftText] = useState(() =>
    formatMixerEffectParameterValue(currentValue, parameter),
  );
  const draftValueRef = useRef(currentValue);
  const interactionActiveRef = useRef(false);
  const ignoreNextNumberBlurRef = useRef(false);
  const pendingNumberBlurCommitRef = useRef<number>();
  const [isInvalid, setIsInvalid] = useState(false);
  const inputId = `mixer-${strip.scope}-${strip.trackId ?? 'master'}-${effect.effectType}-${parameter.name}`;

  useEffect(() => {
    draftValueRef.current = currentValue;
    setDraftText(formatMixerEffectParameterValue(currentValue, parameter));
    setIsInvalid(false);
    interactionActiveRef.current = false;
  }, [currentValue, effect.effectType, parameter]);

  useEffect(() => {
    return () => {
      if (pendingNumberBlurCommitRef.current !== undefined) {
        window.clearTimeout(pendingNumberBlurCommitRef.current);
      }
    };
  }, []);

  const cancelDraft = () => {
    interactionActiveRef.current = false;
    draftValueRef.current = currentValue;
    setDraftText(formatMixerEffectParameterValue(currentValue, parameter));
    setIsInvalid(false);
    onStatus(`${parameter.label} edit canceled.`);
  };

  const commitDraft = (text = draftText) => {
    interactionActiveRef.current = false;
    const result = parseMixerEffectParameterDraft(effect, parameter, text);

    if (result.status === 'INVALID') {
      setIsInvalid(true);
      onStatus(result.message);
      return;
    }

    setIsInvalid(false);
    draftValueRef.current = result.value;
    setDraftText(formatMixerEffectParameterValue(result.value, parameter));

    if (result.status === 'NO_OP') {
      onStatus(`${parameter.label} is unchanged.`);
      return;
    }

    const outcome = onCommand(
      createMixerEffectParameterUiCommand(
        strip,
        effect,
        parameter.name,
        result.value,
      ),
    );

    if (outcome.status === 'BLOCKED') {
      draftValueRef.current = currentValue;
      setDraftText(formatMixerEffectParameterValue(currentValue, parameter));
      setIsInvalid(true);
    }
  };

  const handleRangeKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelDraft();
      return;
    }

    if (keyboardCommitKeys.has(event.key)) {
      event.preventDefault();
      interactionActiveRef.current = true;
      const nextValue = stepMixerEffectParameterValue(
        draftValueRef.current,
        parameter,
        event.key,
        event.shiftKey,
      );
      draftValueRef.current = nextValue;
      setDraftText(formatMixerEffectParameterValue(nextValue, parameter));
      setIsInvalid(false);
    }
  };

  const handleRangeKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    if (keyboardCommitKeys.has(event.key) && interactionActiveRef.current) {
      commitDraft(String(draftValueRef.current));
    }
  };

  const handleRangePointerUp = (event: PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (interactionActiveRef.current) {
      commitDraft(String(draftValueRef.current));
    }
  };

  return (
    <div className={`mixer-parameter-control ${isInvalid ? 'invalid' : ''}`}>
      <div className="mixer-parameter-heading">
        <label htmlFor={`${inputId}-number`}>{parameter.label}</label>
        <span>{parameter.group}</span>
      </div>
      <input
        id={`${inputId}-range`}
        className="mixer-parameter-range"
        type="range"
        aria-label={`${strip.name} ${effectPresentation.label} ${parameter.label} slider`}
        disabled={disabled}
        min={parameter.spec.minimum}
        max={parameter.spec.maximum}
        step={parameter.step}
        value={draftValueRef.current}
        onBlur={() => {
          if (interactionActiveRef.current) {
            commitDraft(String(draftValueRef.current));
          }
        }}
        onChange={(event) => {
          const nextValue = Number(event.currentTarget.value);
          draftValueRef.current = nextValue;
          setDraftText(formatMixerEffectParameterValue(nextValue, parameter));
          setIsInvalid(false);
        }}
        onKeyDown={handleRangeKeyDown}
        onKeyUp={handleRangeKeyUp}
        onPointerCancel={cancelDraft}
        onPointerDown={(event) => {
          interactionActiveRef.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={handleRangePointerUp}
      />
      <div className="mixer-parameter-readout">
        <input
          id={`${inputId}-number`}
          type="text"
          inputMode="decimal"
          aria-invalid={isInvalid}
          aria-label={`${strip.name} ${effectPresentation.label} ${parameter.label} value`}
          disabled={disabled}
          value={draftText}
          onBlur={(event) => {
            if (ignoreNextNumberBlurRef.current) {
              ignoreNextNumberBlurRef.current = false;
              return;
            }
            const nextFocus = event.relatedTarget;
            if (
              nextFocus instanceof Element &&
              nextFocus.closest(
                '.timeline-workspace, [data-mixer-selection-target="true"]',
              )
            ) {
              cancelDraft();
              return;
            }
            if (interactionActiveRef.current) {
              pendingNumberBlurCommitRef.current = window.setTimeout(() => {
                pendingNumberBlurCommitRef.current = undefined;
                if (interactionActiveRef.current) {
                  commitDraft();
                }
              }, 0);
            }
          }}
          onChange={(event) => {
            setDraftText(event.currentTarget.value);
            setIsInvalid(false);
          }}
          onFocus={() => {
            interactionActiveRef.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelDraft();
              ignoreNextNumberBlurRef.current = true;
              event.currentTarget.blur();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              commitDraft();
              ignoreNextNumberBlurRef.current = true;
              event.currentTarget.blur();
            }
          }}
          onKeyUp={(event) => {
            if (keyboardCommitKeys.has(event.key)) {
              commitDraft(event.currentTarget.value);
            }
          }}
        />
        <span>{parameter.unit || 'VALUE'}</span>
      </div>
    </div>
  );
}

function MixerEffectsMeterBlock({
  effectsState,
  inactiveReason,
  meterStore,
  metersActive,
  projectMixdownControl,
  projectStemPrintControl,
  projectStemPrintOptions,
  selectedProjectStemPrintTargetKeys,
  onCancelProjectMixdown,
  onCancelProjectStemPrint,
  onRecoverProjectMixdown,
  onRecoverProjectStemPrint,
  onRunProjectMixdown,
  onRunProjectStemPrint,
  onToggleProjectStemPrintTarget,
  strip,
}: Readonly<{
  effectsState: string;
  inactiveReason?: string;
  meterStore: ProjectPlaybackMeterStore;
  metersActive: boolean;
  projectMixdownControl: MixerProjectMixdownControlModel;
  projectStemPrintControl: MixerProjectStemPrintControlModel;
  projectStemPrintOptions: readonly ProjectStemPrintTargetOption[];
  selectedProjectStemPrintTargetKeys: readonly string[];
  onCancelProjectMixdown: () => void;
  onCancelProjectStemPrint: () => void;
  onRecoverProjectMixdown: () => void;
  onRecoverProjectStemPrint: () => void;
  onRunProjectMixdown: () => void;
  onRunProjectStemPrint: () => void;
  onToggleProjectStemPrintTarget: (target: ProjectStemPrintTarget) => void;
  strip: MixerEffectsUiReadyStrip;
}>) {
  return (
    <aside className="mixer-meter-block" aria-label="Exact Playback meters">
      <MixerProjectMixdownBand
        control={projectMixdownControl}
        onCancel={onCancelProjectMixdown}
        onRecover={onRecoverProjectMixdown}
        onRun={onRunProjectMixdown}
      />
      <MixerProjectStemPrintControls
        control={projectStemPrintControl}
        onCancel={onCancelProjectStemPrint}
        onRecover={onRecoverProjectStemPrint}
        onRun={onRunProjectStemPrint}
        onToggleTarget={onToggleProjectStemPrintTarget}
        options={projectStemPrintOptions}
        selectedTargetKeys={selectedProjectStemPrintTargetKeys}
      />
      <div className="mixer-meter-block-header">
        <span className="mixer-section-label">EXACT PEAK</span>
        <span
          className="mixer-meter-effects-status"
          aria-label={`Mixer Effects state ${effectsState}`}
        >
          <span>HUM MIX FX</span>
          <strong>{effectsState}</strong>
        </span>
      </div>
      <div className="mixer-meter-groups">
        {strip.scope === 'channel' && (
          <SubscribedMixerMeterGroup
            inactiveReason={inactiveReason}
            label="Channel"
            meterStore={meterStore}
            metersActive={metersActive}
            scope="channel"
            trackId={strip.trackId}
          />
        )}
        <SubscribedMixerMeterGroup
          label="Master"
          meterStore={meterStore}
          metersActive={metersActive}
          scope="master"
        />
      </div>
    </aside>
  );
}

function MixerProjectStemPrintControls({
  control,
  onCancel,
  onRecover,
  onRun,
  onToggleTarget,
  options,
  selectedTargetKeys,
}: Readonly<{
  control: MixerProjectStemPrintControlModel;
  onCancel: () => void;
  onRecover: () => void;
  onRun: () => void;
  onToggleTarget: (target: ProjectStemPrintTarget) => void;
  options: readonly ProjectStemPrintTargetOption[];
  selectedTargetKeys: readonly string[];
}>) {
  const selected = new Set(selectedTargetKeys);
  const action = control.showRecover
    ? { disabled: !control.canRecover, label: 'RECOVER', onClick: onRecover }
    : control.showCancel
      ? {
          disabled: !control.canCancel,
          label: control.canCancel ? 'CANCEL' : 'WAIT',
          onClick: onCancel,
        }
      : { disabled: !control.canRun, label: 'STEM PRINT', onClick: onRun };

  return (
    <section
      className={`mixer-project-stem-print ${control.tone}`}
      aria-label="Mixer Stem Print controls"
    >
      <div className="mixer-project-stem-print-band">
        <button
          type="button"
          aria-label={`${action.label} from Mixer`}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </button>
        <div
          className="mixer-project-stem-print-status"
          role="status"
          aria-label={`Mixer Stem Print status ${control.label}. ${control.message}`}
        >
          <strong>{control.label}</strong>
          {control.operationId && <small>OP {control.operationId}</small>}
        </div>
      </div>
      <div
        className="mixer-project-stem-targets"
        role="group"
        aria-label="Stem Print targets"
      >
        {options.map((option) => (
          <button
            type="button"
            aria-label={`${selected.has(option.key) ? 'Remove' : 'Add'} ${option.kind} ${option.label} from Stem Print`}
            aria-pressed={selected.has(option.key)}
            disabled={!option.canSelect || control.showCancel || control.showRecover}
            key={option.key}
            onClick={() => onToggleTarget(option.target)}
            title={option.message}
          >
            <span>{option.kind === 'group' ? 'GROUP' : 'CH'}</span>
            <strong>{option.label}</strong>
          </button>
        ))}
        {options.length === 0 && <span>NO MIXER TARGETS</span>}
      </div>
    </section>
  );
}

function MixerProjectMixdownBand({
  control,
  onCancel,
  onRecover,
  onRun,
}: Readonly<{
  control: MixerProjectMixdownControlModel;
  onCancel: () => void;
  onRecover: () => void;
  onRun: () => void;
}>) {
  const action = control.showRecover
    ? {
        disabled: !control.canRecover,
        label: 'RECOVER',
        onClick: onRecover,
      }
    : control.showCancel
      ? {
          disabled: !control.canCancel,
          label: control.canCancel ? 'CANCEL' : 'WAIT',
          onClick: onCancel,
        }
      : {
          disabled: !control.canRun,
          label: 'MIXDOWN',
          onClick: onRun,
        };

  return (
    <div
      className={`mixer-project-mixdown-band ${control.tone}`}
      aria-label="Mixer Project Mixdown controls"
    >
      <button
        type="button"
        aria-label={`${action.label} from Mixer`}
        disabled={action.disabled}
        onClick={action.onClick}
      >
        {action.label}
      </button>
      <div
        className="mixer-project-mixdown-status"
        role="status"
        aria-label={`Mixer Project Mixdown status ${control.label}. ${control.message}`}
      >
        <strong>{control.label}</strong>
        {control.operationId && <small>OP {control.operationId}</small>}
      </div>
    </div>
  );
}

function SubscribedMixerMeterGroup({
  inactiveReason,
  label,
  meterStore,
  metersActive,
  scope,
  trackId,
}: Readonly<{
  inactiveReason?: string;
  label: 'Channel' | 'Master';
  meterStore: ProjectPlaybackMeterStore;
  metersActive: boolean;
  scope: ProjectPlaybackMeterScope;
  trackId?: string;
}>) {
  const meter = useProjectPlaybackMeter(
    meterStore,
    scope,
    trackId,
    metersActive && !inactiveReason,
  );

  if (!meter || inactiveReason) {
    return (
      <div className="mixer-meter-unavailable compact" role="status">
        <strong>{label} METER {inactiveReason ?? 'OFFLINE'}</strong>
        <p>{inactiveReason
          ? 'No exact measurement is reported while this Channel is inactive.'
          : 'Exact Playback meter unavailable.'}</p>
      </div>
    );
  }

  return (
    <div className="mixer-meter-group">
      <strong>{label}</strong>
      <MixerMeterLane
        channel="L"
        clipped={meter.left.clipped}
        peak={meter.left.peak}
      />
      <MixerMeterLane
        channel="R"
        clipped={meter.right.clipped}
        peak={meter.right.peak}
      />
    </div>
  );
}

function getMixerConsoleMeterInactiveReason(
  strip: MixerEffectsConsoleChannelStrip,
): 'MUTED' | 'SOLO EXCLUDED' | 'SOURCE OFFLINE' | undefined {
  if (strip.muted) {
    return 'MUTED';
  }

  if (strip.audibility === 'SOLO_EXCLUDED') {
    return 'SOLO EXCLUDED';
  }

  return strip.sourceStatus === 'SOURCE_OFFLINE' ? 'SOURCE OFFLINE' : undefined;
}

function MixerMeterLane({
  channel,
  clipped,
  peak,
}: Readonly<{ channel: 'L' | 'R'; clipped: boolean; peak: number }>) {
  const presentation = createMixerMeterBarPresentation(peak, clipped);
  const style = {
    '--mixer-meter-fill': presentation.fillRatio,
  } as CSSProperties;

  return (
    <div
      className={`mixer-meter-lane ${clipped ? 'clipped' : ''}`}
      aria-label={`${channel} exact sample peak ${presentation.measurementPeak}${
        presentation.clipped ? ', clipped' : ''
      }`}
    >
      <span>{channel}</span>
      <div className="mixer-meter-track" aria-hidden="true">
        <i style={style} />
      </div>
      <strong>{presentation.measurementPeak.toFixed(3)}</strong>
      <b>{presentation.clipped ? 'CLIP' : 'OK'}</b>
    </div>
  );
}

function getEffectParameterValue(
  effect: MixerEffectState,
  parameterName: string,
): number {
  const value = (effect.parameters as Readonly<Record<string, number>>)[
    parameterName
  ];

  if (!Number.isFinite(value)) {
    throw new TypeError('Mixer Effect parameter value is invalid.');
  }

  return value;
}
