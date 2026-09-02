import { describe, expect, it } from 'vitest';

import { BUILTIN_PATCH_TAB_TYPE_IDS } from './patchTabPortContract';
import {
  canStartProjectMixdown,
  createClipFilerProjectMixdownOwner,
  createMixerProjectMixdownControlModel,
  isProjectMixdownOwner,
  MIXER_PROJECT_MIXDOWN_OWNER,
  resolveProjectMixdownStartEntry,
  type ProjectMixdownUiState,
} from './projectMixdownUiState';
import { sampleProject } from './sampleProject';
import type { PatchTab, ProjectState } from './types';

describe('Project Mixdown UI ownership', () => {
  it('allows Mixer Print without any Clip Filer PatchTab or Clip Filer settings', () => {
    const project: ProjectState = { ...sampleProject, patchTabs: [] };

    expect(
      resolveProjectMixdownStartEntry(project, MIXER_PROJECT_MIXDOWN_OWNER),
    ).toEqual({ canStart: true });
    expect(MIXER_PROJECT_MIXDOWN_OWNER).toEqual({ kind: 'mixer' });
    expect(MIXER_PROJECT_MIXDOWN_OWNER).not.toHaveProperty('patchTabId');
  });

  it('bypasses invalid Clip Filer settings only for Mixer-owned Print', () => {
    const patchTab: PatchTab = {
      ...sampleProject.patchTabs[0],
      id: 'invalid-clip-filer',
      name: 'Clip Filer',
      nodeTypeId: BUILTIN_PATCH_TAB_TYPE_IDS.clipFiler,
      parameters: [],
    };
    const project: ProjectState = { ...sampleProject, patchTabs: [patchTab] };

    expect(
      resolveProjectMixdownStartEntry(project, MIXER_PROJECT_MIXDOWN_OWNER),
    ).toEqual({ canStart: true });
    expect(
      resolveProjectMixdownStartEntry(
        project,
        createClipFilerProjectMixdownOwner(patchTab.id),
      ),
    ).toMatchObject({ canStart: false });
  });

  it('keeps one owner-neutral operation lock across Mixer and Clip Filer entry points', () => {
    const clipFilerOwner = createClipFilerProjectMixdownOwner('clip-filer-a');
    const state: ProjectMixdownUiState = {
      owner: clipFilerOwner,
      status: 'RUNNING',
    };
    const mixer = createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Ready.',
      isProjectRootReady: true,
      state,
    });

    expect(mixer).toMatchObject({
      canRun: false,
      label: 'BUSY',
      showCancel: false,
      showRecover: false,
    });
    expect(isProjectMixdownOwner(state.owner, clipFilerOwner)).toBe(true);
    expect(
      isProjectMixdownOwner(state.owner, MIXER_PROJECT_MIXDOWN_OWNER),
    ).toBe(false);
    expect(canStartProjectMixdown(state)).toBe(false);
    expect(
      canStartProjectMixdown({
        owner: MIXER_PROJECT_MIXDOWN_OWNER,
        status: 'RUNNING',
      }),
    ).toBe(false);
  });

  it('blocks Raw Mixdown while Stem Print owns the shared render lock', () => {
    expect(createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Ready.',
      hasStemPrintLock: true,
      isProjectRootReady: true,
      state: { status: 'IDLE' },
    })).toMatchObject({
      canRun: false,
      label: 'BUSY',
      message: expect.stringContaining('Stem Print'),
    });
  });

  it('exposes cancel and exact recovery only to the Mixer that owns the operation', () => {
    const running = createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Ready.',
      isProjectRootReady: true,
      state: {
        operationId: 'mixdown-op-1',
        owner: MIXER_PROJECT_MIXDOWN_OWNER,
        status: 'RUNNING',
      },
    });
    const unknown = createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Ready.',
      isProjectRootReady: true,
      state: {
        operationId: 'mixdown-op-1',
        owner: MIXER_PROJECT_MIXDOWN_OWNER,
        status: 'MIXDOWN_OUTCOME_UNKNOWN',
      },
    });
    const clipFilerUnknown = createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Ready.',
      isProjectRootReady: true,
      state: {
        operationId: 'mixdown-op-1',
        owner: createClipFilerProjectMixdownOwner('clip-filer-a'),
        status: 'MIXDOWN_OUTCOME_UNKNOWN',
      },
    });

    expect(running).toMatchObject({
      canCancel: true,
      canRun: false,
      label: 'RUNNING',
      operationId: 'mixdown-op-1',
      showCancel: true,
    });
    expect(unknown).toMatchObject({
      canRecover: true,
      canRun: false,
      label: 'OUTCOME UNKNOWN',
      operationId: 'mixdown-op-1',
      showRecover: true,
    });
    expect(clipFilerUnknown).toMatchObject({
      canRecover: false,
      canRun: false,
      label: 'OUTCOME UNKNOWN',
      showRecover: false,
    });
  });

  it('presents successful Mixer registration as ready without offering download or playback actions', () => {
    const model = createMixerProjectMixdownControlModel({
      engineAcceptsNewJobs: true,
      engineAvailabilityMessage: 'Ready.',
      isProjectRootReady: true,
      state: {
        message: 'Raw Mix 01 is registered on muted Track Raw Mixes.',
        operationId: 'mixdown-op-1',
        owner: MIXER_PROJECT_MIXDOWN_OWNER,
        status: 'REGISTERED',
      },
    });

    expect(model).toMatchObject({
      canRun: true,
      label: 'READY',
      showCancel: false,
      showRecover: false,
      tone: 'success',
    });
    expect(Object.keys(model)).not.toContain('download');
    expect(Object.keys(model)).not.toContain('play');
  });
});
