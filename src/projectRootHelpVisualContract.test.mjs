import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('Project Root help contract', () => {
  it('explains the accepted folder choices from the menu hover target', () => {
    expect(appSource).toContain(
      'Choose a new empty folder for this Project or select an existing ElpisDAW Project Root.',
    );
    expect(appSource).toMatch(
      /className="menu-command project-root-command"[\s\S]*?getHelpPreviewProps\(createProjectRootHelpMessage\(projectRootState\)\)/,
    );
    expect(appSource).toContain('The previous Project Root remains active.');
  });

  it('shows an accessible transient notice when selection is rejected', () => {
    expect(appSource).toContain('PROJECT_ROOT_SELECTION_NOTICE_DURATION_MS = 10_000');
    expect(appSource).toContain('showProjectRootSelectionNotice(message)');
    expect(appSource).toMatch(
      /className="project-root-selection-notice"[\s\S]*?role="alert"[\s\S]*?aria-live="assertive"/,
    );
    expect(appSource).toContain('Folder not selected');
    expect(appSource).toContain('Dismiss Project Root notice');
    expect(stylesSource).toContain('.project-root-selection-notice');
  });
});
