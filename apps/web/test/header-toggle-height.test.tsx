// @vitest-environment jsdom
/**
 * In the header row (the workspace's PhaseHeader and a
 * document page's strip laid out as that header, both `.phase-header`) the
 * Details / More toggle was 36 px tall beside 34 px buttons. The strip's rule
 * gives its summary 8 px of padding all round (shell-fidelity.css), and the
 * header's rule sets 13 px type at the inherited 1.5 line height: 8 + 19.5 + 8.
 * The header's rule now gives the summary the buttons' 34 px with no block
 * padding, so the line sits in the middle of 34 px.
 *
 * jsdom lays nothing out, so a height cannot be read here; what is pinned is the
 * cascade: the two sheets loaded in the app's order, the summary inside each
 * header row computes min-height 34px and no block padding, the buttons beside
 * it keep min-height 34px, and a strip that is not the header row keeps its 8 px.
 * The drawn 34 px is a browser's to confirm.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sheet = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');
let styles: HTMLStyleElement[] = [];
beforeEach(() => {
  styles = ['components/shell/shell-fidelity.css', 'components/workspace/phase-experience.css'].map((file) => {
    const style = document.createElement('style');
    style.textContent = sheet(file);
    document.head.append(style);
    return style;
  });
});
afterEach(() => {
  styles.forEach((style) => style.remove());
  document.body.innerHTML = '';
});

function row(className: string) {
  document.body.innerHTML = `<div class="${className}">
    <details class="phase-strip-details"><summary data-testid="toggle">Details</summary></details>
    <div class="phase-strip-primary"><button data-testid="primary">Submit PR-4</button></div>
    <div class="phase-header-secondary"><button data-testid="secondary">Run tests</button></div>
  </div>`;
  const style = (id: string) => getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!);
  return { toggle: style('toggle'), primary: style('primary'), secondary: style('secondary') };
}

describe('the header row\'s Details / More toggle is the 34 px of its buttons', () => {
  it.each([
    ['the workspace header (More)', 'phase-strip-approved phase-header'],
    ['a document page\'s header (Details)', 'phase-strip-approved phase-header phase-header--doc'],
  ])('%s', (_name, className) => {
    const { toggle, primary } = row(className);
    expect(toggle.minHeight).toBe('34px');
    expect([toggle.paddingTop, toggle.paddingBottom]).toEqual(['0px', '0px']);
    expect([toggle.paddingLeft, toggle.paddingRight]).toEqual(['8px', '8px']);
    expect(toggle.fontSize).toBe('13px');
    expect(primary.minHeight).toBe('34px');
  });

  it('the workspace header\'s own buttons beside it are 34 px too', () => {
    expect(row('phase-strip-approved phase-header').secondary.minHeight).toBe('34px');
  });

  it('a strip that is not the header row keeps its 8 px padding', () => {
    const { toggle } = row('phase-strip-approved');
    expect([toggle.paddingTop, toggle.paddingBottom]).toEqual(['8px', '8px']);
  });
});
