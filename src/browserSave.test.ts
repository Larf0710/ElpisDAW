import { describe, expect, it, vi } from 'vitest';

import { persistBrowserSave } from './browserSave';

describe('persistBrowserSave', () => {
  it('reports a successful browser save', () => {
    const setItem = vi.fn();

    expect(persistBrowserSave({ setItem }, 'project-key', '{"project":true}')).toBe(true);
    expect(setItem).toHaveBeenCalledWith('project-key', '{"project":true}');
  });

  it('reports a browser storage failure without throwing', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('Storage quota exceeded.', 'QuotaExceededError');
    });

    expect(persistBrowserSave({ setItem }, 'project-key', '{"project":true}')).toBe(false);
  });
});
