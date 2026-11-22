import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The review-and-explain dialog's summary, file list and columns
 * scroll as one body, and the BEFORE and AFTER column heads stay at the top of
 * it. A sticky head draws over the rows that scroll under it, so its background
 * must be opaque: the AFTER head's green tint is a tenth opaque on its own and
 * would let the rows show through, so the tint sits on the AFTER body's own
 * surface.
 *
 * jsdom lays nothing out, so this reads the stylesheet the dialog loads, as
 * `case-file-tabs.test.ts` does for the case file.
 */

const css = readFileSync(resolve(__dirname, '../components/workspace/mentor/ProposalCompare.css'), 'utf8');

const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
};

describe('the compare dialog\'s sticky column heads', () => {
  it('keeps the column heads at the top of the one scrolling body', () => {
    expect(rule('.apv-scroll .apv-col-head')).toMatch(/position:\s*sticky/);
    expect(rule('.apv-scroll .apv-col-head')).toMatch(/top:\s*0/);
  });

  it('draws the AFTER head\'s tint on an opaque base, so scrolled rows do not show through it', () => {
    const after = rule('.apv-after .apv-col-head');
    expect(after).toMatch(/background:\s*linear-gradient\(var\(--apv-green-tint\),\s*var\(--apv-green-tint\)\),\s*var\(--tool-surface\)/);
  });

  it('draws the BEFORE head on the opaque canvas', () => {
    expect(rule('.apv-before .apv-col-head')).toMatch(/background:\s*var\(--tool-canvas\)/);
  });
});
