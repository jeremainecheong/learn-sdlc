import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No essential text in the rooms under 12 px: the testing runner's toolbar,
 * notice, empty line and source frames, the task picker, the task card's
 * pre-formatted text and the view-tab labels. This reads the room stylesheet
 * (jsdom lays nothing out) and holds every one of those rules at 12 px or
 * more, so a later tidy cannot shrink them back.
 */

const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');

/**
 * The font size the cascade settles on for this selector: the last rule in the
 * sheet that names it and states a px size (the shell builder raised the old
 * sizes by later rules rather than by editing the first ones), in px.
 */
const fontSizeOf = (selector: string): number => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s*>\s*/g, '\\s*>\\s*').replace(/ /g, '\\s+');
  const rule = new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, 'g');
  let size: number | null = null;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    const px = /font-size:\s*([\d.]+)px/.exec(m[1]) ?? /font:\s*([\d.]+)px/.exec(m[1]);
    if (px) size = Number(px[1]);
  }
  expect(size, `${selector} states a px font size`).not.toBeNull();
  return size!;
};

describe('essential room text is 12 px or more', () => {
  it.each([
    '.implementation-view-tabs',
    '.testing-runner-toolbar>span',
    '.testing-runner-notice',
    '.testing-suite-tree .testing-no-cases',
    '.testing-source-frames code',
    '.task-picker',
    '.task-assignment pre',
  ])('%s', (selector) => {
    expect(fontSizeOf(selector)).toBeGreaterThanOrEqual(12);
  });
});

describe('the quick check\'s title is 14 px', () => {
  // The title is the one word-run that names the offer, so it stands a size
  // above the row's 13 px.
  it('.quick-check-line .quick-check-text strong', () => {
    expect(fontSizeOf('.quick-check-line .quick-check-text strong')).toBe(14);
  });
});
