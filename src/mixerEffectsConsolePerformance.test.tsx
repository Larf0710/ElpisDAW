import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MixerEffectsEditor } from './MixerEffectsEditor';
import { normalizeProjectMixerState } from './projectMixerState';
import { createProjectPlaybackMeterStore } from './projectPlaybackMeterStore';
import { sampleProject } from './sampleProject';
import type { ProjectState, Track } from './types';
import { resolveMixerEffectsConsole } from './mixerEffectsUiModel';
import { createMixerProjectMixdownControlModel } from './projectMixdownUiState';

describe('Mixer Console bounded scale evidence', () => {
  it('derives and renders 16, 32, 64, and 128 stable Channel strips with fixed Master placement', () => {
    const measurements: Array<{
      channelCount: number;
      deriveMilliseconds: number;
      renderMilliseconds: number;
    }> = [];

    for (const channelCount of [16, 32, 64, 128]) {
      const project = createStressProject(channelCount);
      const deriveStarted = performance.now();
      const resolution = resolveMixerEffectsConsole(project);
      const deriveMilliseconds = performance.now() - deriveStarted;
      const renderStarted = performance.now();
      const markup = renderToStaticMarkup(
        <MixerEffectsEditor
          activeTransport="STOP"
          isActive
          isEditingLocked={false}
          meterStore={createProjectPlaybackMeterStore()}
          projectMixdownControl={createMixerProjectMixdownControlModel({
            engineAcceptsNewJobs: true,
            engineAvailabilityMessage: 'Ready.',
            isProjectRootReady: true,
            state: { status: 'IDLE' },
          })}
          onCancelProjectMixdown={() => undefined}
          onCommand={() => ({ message: 'No command.', status: 'NO_OP' })}
          onRecoverProjectMixdown={() => undefined}
          onRequestReset={() => undefined}
          onRunProjectMixdown={() => undefined}
          onSelectTrack={() => undefined}
          onToggleTrackMute={() => undefined}
          project={project}
        />,
      );
      const renderMilliseconds = performance.now() - renderStarted;

      expect(resolution.status).toBe('READY');
      if (resolution.status !== 'READY') {
        continue;
      }
      expect(resolution.channels).toHaveLength(channelCount);
      expect(markup.match(/data-mixer-selection-target="true"/g)).toHaveLength(
        channelCount + 1,
      );
      expect(markup.indexOf('Project Channel strips in Timeline order')).toBeLessThan(
        markup.indexOf('Fixed Master strip'),
      );
      expect(markup).toContain(
        `Open Stress Track ${String(channelCount).padStart(3, '0')} Channel details`,
      );
      measurements.push({ channelCount, deriveMilliseconds, renderMilliseconds });
    }

    console.info(`Mixer Console scale evidence ${JSON.stringify(measurements)}`);
    expect(measurements).toHaveLength(4);
    expect(measurements.every((measurement) =>
      Number.isFinite(measurement.deriveMilliseconds) &&
      Number.isFinite(measurement.renderMilliseconds)))
      .toBe(true);
  });
});

function createStressProject(channelCount: number): ProjectState {
  const master = sampleProject.tracks.find((track) => track.type === 'master');
  if (!master) {
    throw new Error('Sample Project Master track is required.');
  }
  const tracks: Track[] = [
    ...Array.from({ length: channelCount }, (_, index): Track => ({
      clips: [],
      id: `stress-track-${String(index + 1).padStart(3, '0')}`,
      level: -index / 4,
      name: `Stress Track ${String(index + 1).padStart(3, '0')}`,
      type: index % 2 === 0 ? 'audio' : 'midi',
    })),
    { ...master, clips: master.clips.map((clip) => ({ ...clip })) },
  ];
  const normalization = normalizeProjectMixerState(tracks, undefined);

  return {
    ...sampleProject,
    mixer: normalization.mixer,
    selection: { items: [] },
    tracks: normalization.tracks,
  };
}
