import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('standalone ACE SA3 Guide and saved Project restoration wiring', () => {
  it('runs the strict T2A Guide mode and commits only the verified result Project', () => {
    expect(appSource).toContain('runAceStepTextToAudioVocalStage');
    expect(appSource).toContain('createAceStepTextToAudioVocalTarget');
    expect(appSource).toContain("preparation.mode === 'stable-audio-3-text-to-audio'");
    expect(appSource).toContain('activateClipTake(\n            result.project,');
    expect(appSource).toContain(
      '{ sourceAvailability: availabilityVerification.evidence }',
    );
    expect(appSource).toContain(
      'ACE-Step Vocal WAV was not registered because final availability verification failed',
    );
    expect(appSource).toContain(
      'The Vocal Track is created only after verified completion.',
    );
  });

  it('restores generated Project Root sources before both saved-project replacement paths', () => {
    expect(appSource).toContain('prepareLoadedProjectSourceRestoration(');
    expect(appSource).toContain('applyProjectSourceRestoration(');
    expect(appSource).toContain('reconnectSessionAudioSources: true');
    expect(appSource).toContain(
      "await replaceLoadedProjectWorkspace(projectLoad, 'Browser save restored')",
    );
    expect(appSource).toContain(
      "await replaceLoadedProjectWorkspace(projectLoad, 'Project loaded')",
    );
    expect(appSource).toContain('PROJECT ROOT RESTORE NEEDED');
  });

  it('opens the exact Project Root JSON before granting Save to Root authority', () => {
    const handlerStart = appSource.indexOf('const handleOpenProjectFromRoot');
    const handlerEnd = appSource.indexOf('const handleSaveProjectToRoot', handlerStart);
    const handlerSource = appSource.slice(handlerStart, handlerEnd);

    expect(appSource).toContain('Open from Root');
    expect(handlerSource).toContain('prepareProjectRootProjectOpen(');
    expect(handlerSource).toContain('applyProjectRootProjectOpen(');
    expect(handlerSource).toContain(
      'opened.loadedProject.projectFilePath !== expectedProjectFilePath',
    );
    expect(handlerSource).toContain(
      'opened.loadedProject.projectFileName !== expectedProjectRoot.projectFileName',
    );
    expect(handlerSource.indexOf('replaceWorkspaceState(opened.workspace')).toBeGreaterThan(-1);
    expect(
      handlerSource.lastIndexOf(
        'authorizedProjectRootPathRef.current = expectedProjectRoot.rootPath',
      ),
    ).toBeGreaterThan(
      handlerSource.indexOf('replaceWorkspaceState(opened.workspace'),
    );
  });

  it('does not send generated relativePath sources to the ordinary File Relink picker', () => {
    expect(appSource).toContain('selectedClip?.sourceFile?.relativePath');
    expect(appSource).toContain("message: 'PROJECT ROOT RESTORE'");
    expect(appSource).toContain("? 'Project Root'");
    expect(appSource).toContain(": 'Relink'");
  });
});
