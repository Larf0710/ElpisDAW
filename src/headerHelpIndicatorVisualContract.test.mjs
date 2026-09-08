import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('Header Help indicator visual contract', () => {
  it('scrolls forward for seven seconds, holds for two, then restarts', () => {
    expect(styles).toMatch(
      /\.header-help-message\.scrolling span\s*\{[\s\S]*?animation:\s*header-help-scroll 9s ease-in-out 1s infinite;/,
    );
    expect(styles).not.toMatch(
      /animation:\s*header-help-scroll[^;]*\balternate\b/,
    );
    expect(styles).toMatch(
      /@keyframes header-help-scroll\s*\{[\s\S]*?from\s*\{[\s\S]*?translateX\(0\);[\s\S]*?77\.7778%,\s*to\s*\{[\s\S]*?translateX\(calc\(-1 \* var\(--help-scroll-distance, 0px\)\)\);/,
    );
  });
});
