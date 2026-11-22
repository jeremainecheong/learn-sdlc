// @vitest-environment jsdom
/**
 * The smaller finds on the teacher's pages after the by-hand pass:
 * the help lines name their topic, the export buttons line up by their tops,
 * the version in force keeps its gap before the form, and "Copied." on the
 * invite panel moves nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closureText, webSource } from './support/source-text';

import { InlineHelp } from '@/components/staff/guide/InlineHelp';

/** Every rule of a stylesheet as [selector, declarations], comments dropped, at-rules flattened. */
function rules(css: string): Array<[string, string]> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const out: Array<[string, string]> = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([m[1].trim(), m[2].trim()]);
  }
  return out;
}
const declsOf = (css: string, selector: string) =>
  rules(css)
    .filter(([sel]) => sel === selector)
    .map(([, d]) => d)
    .join(';');
const prop = (decls: string, name: string) =>
  new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(decls)?.[1].trim() ?? null;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('help lines, export buttons and the invite panel', () => {
  it('a "What is this?" line shows its topic, so two stacked lines read as two', async () => {
    await act(async () =>
      root.render(
        <>
          <InlineHelp topic="tasks" />
          <InlineHelp topic="interview" />
        </>,
      ),
    );
    const summaries = [...host.querySelectorAll('summary')];
    expect(summaries.map((one) => one.textContent)).toEqual([
      'What is this? About tasks.',
      'What is this? About the stakeholder interview.',
    ]);
    for (const summary of summaries) expect(summary.querySelector('.sr-only')).toBeNull();
  });

  const portal = closureText('TeacherPortal');
  const exp = webSource('components/experience/experience.css');

  it('the export buttons line up by their tops', () => {
    // The row's classes are asserted on the rendered class page in `teacher-class-page-refresh.test.tsx`.
    expect(prop(declsOf(exp, '.exp-actions.exp-exports'), 'align-items')).toBe('flex-start');
  });

  it('the version in force keeps a paragraph\'s gap before "Version to assign"', () => {
    expect(closureText('ClassProjectCard')).toContain('<div className="exp-project-active" data-testid="class-project-active">');
    expect(prop(declsOf(exp, '.exp-project-active'), 'margin-bottom')).toBe('15px');
  });

  it('"Copied." on the invite panel is drawn under the buttons, out of the row', () => {
    expect(portal).toMatch(/<div className="exp-invite-code">\s*<span className="exp-caption">Class join code<\/span>\s*<JoinCode code=\{cohort\.joinCode\} \/>/);
    expect(prop(declsOf(exp, '.exp-invite-code'), 'position')).toBe('relative');
    const status = declsOf(exp, '.exp-invite-code .exp-join-code > [role="status"]');
    expect(prop(status, 'position')).toBe('absolute');
    expect(prop(status, 'top')).toBe('100%');
    // The status the copy fills is still JoinCode's own, a live region from the start.
    expect(closureText('JoinCode')).toContain('<span role="status" className="exp-caption">');
  });
});
