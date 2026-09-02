import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('MIDI Clip playback cache lifecycle', () => {
  it('aborts preparation and clears the cache before replacing a workspace', () => {
    const start = appSource.indexOf('const replaceWorkspaceState = useCallback');
    const end = appSource.indexOf('const replaceLoadedProjectWorkspace', start);
    const replacementSource = appSource.slice(start, end);

    expect(replacementSource).toContain('releaseMidiClipPlaybackPreparation();');
    expect(replacementSource).toContain('midiClipPlaybackCacheRef.current.clear();');
  });

  it('prunes removed Clips and clears retained blobs during App cleanup', () => {
    expect(appSource).toContain(
      'midiClipPlaybackCacheRef.current.prune(workspaceRef.current.project);',
    );
    expect(appSource).toContain('}, [project.tracks]);');
    expect(appSource.match(/midiClipPlaybackCacheRef\.current\.clear\(\);/g)).toHaveLength(
      2,
    );
  });
});
