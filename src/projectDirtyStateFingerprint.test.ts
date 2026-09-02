import { describe, expect, it } from 'vitest';

import {
  createProjectDirtyStateFingerprint,
  hasProjectDirtyStateDrift,
} from './projectDirtyStateFingerprint';
import { reconcileProjectMixerState } from './projectMixerState';
import { sampleProject } from './sampleProject';
import type { ProjectMixerStateV1, ProjectState, Track } from './types';

describe('Project dirty-state fingerprint', () => {
  it('tracks Pan, Solo, and Master Fader changes in versioned Mixer state', () => {
    const project = createProject();
    const channel = project.mixer!.channels[0];
    const baseline = createProjectDirtyStateFingerprint(project);

    expect(createProjectDirtyStateFingerprint(withChannel(project, { pan: 0.25 }))).not.toBe(
      baseline,
    );
    expect(createProjectDirtyStateFingerprint(withChannel(project, { solo: true }))).not.toBe(
      baseline,
    );
    expect(
      createProjectDirtyStateFingerprint({
        ...project,
        mixer: {
          ...project.mixer!,
          channels: [channel],
          master: { ...project.mixer!.master, faderDb: -2.5 },
        },
      }),
    ).not.toBe(baseline);
  });

  it('tracks persistent effect bypass and parameter changes', () => {
    const project = createProject();
    const equalizer = project.mixer!.channels[0].inserts[0];
    const enabledProject = {
      ...project,
      mixer: {
        ...project.mixer!,
        channels: project.mixer!.channels.map((channel) => ({
          ...channel,
          inserts: [
            { ...equalizer, bypass: false },
            channel.inserts[1],
            channel.inserts[2],
          ],
        })),
      },
    } as ProjectState;
    const parameterProject = {
      ...project,
      mixer: {
        ...project.mixer!,
        channels: project.mixer!.channels.map((channel) => ({
          ...channel,
          inserts: [
            {
              ...equalizer,
              parameters: { ...equalizer.parameters, lowGainDb: 3 },
            },
            channel.inserts[1],
            channel.inserts[2],
          ],
        })),
      },
    } as ProjectState;

    expect(createProjectDirtyStateFingerprint(enabledProject)).not.toBe(
      createProjectDirtyStateFingerprint(project),
    );
    expect(createProjectDirtyStateFingerprint(parameterProject)).not.toBe(
      createProjectDirtyStateFingerprint(project),
    );
  });

  it('excludes runtime meters and view/session state from the persistent fingerprint', () => {
    const project = createProject();
    const runtimeOnlyProject = {
      ...project,
      isLooping: !project.isLooping,
      playheadTick: project.playheadTick + 480,
      selectedPatchTabId: 'session-only-selection',
      status: 'PLAYING',
      mixer: {
        ...project.mixer!,
        channels: project.mixer!.channels.map((channel) => ({
          ...channel,
          inserts: channel.inserts.map((effect) => ({
            ...effect,
            processorState: { samplesProcessed: 4096 },
          })),
          runtimeMeter: { peakDb: -6 },
        })),
        master: {
          ...project.mixer!.master,
          runtimeMeter: { peakDb: -3 },
        },
      },
    } as unknown as ProjectState;

    expect(createProjectDirtyStateFingerprint(runtimeOnlyProject)).toBe(
      createProjectDirtyStateFingerprint(project),
    );
  });

  it('rejects asynchronous settlement when only Mixer state drifted', () => {
    const sourceProject = createProject();
    const sourceFingerprint = createProjectDirtyStateFingerprint(sourceProject);
    const currentProject = withChannel(sourceProject, { pan: -0.4 });

    expect(hasProjectDirtyStateDrift(sourceFingerprint, currentProject)).toBe(true);
    expect(hasProjectDirtyStateDrift(sourceFingerprint, sourceProject)).toBe(false);
  });
});

function createProject(): ProjectState {
  const track: Track = {
    id: 'vocal',
    name: 'Vocal',
    type: 'audio',
    level: -3,
    muted: false,
    clips: [],
  };

  return reconcileProjectMixerState({
    ...sampleProject,
    tracks: [track],
    mixer: undefined,
  });
}

function withChannel(
  project: ProjectState,
  updates: Partial<
    Pick<ProjectMixerStateV1['channels'][number], 'pan' | 'solo'>
  >,
): ProjectState {
  const channel = project.mixer!.channels[0];

  return {
    ...project,
    mixer: {
      ...project.mixer!,
      channels: [{ ...channel, ...updates }],
    },
  };
}
