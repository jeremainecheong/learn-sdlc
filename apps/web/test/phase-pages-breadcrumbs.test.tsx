// @vitest-environment jsdom
/**
 * Facts that span several pages of a phase.
 *
 * The shared review (`FeedbackPanel`) reads a floor rule the teacher set to 0 as "Not required" only when it is given
 * the phase's floors (mounted in pr-page-parts.test.tsx, "the IDE review"); without them the same rule would read
 * "✓ At least 0 …". Every call site hands the phase it holds.
 * Each call site is mounted with a report holding a rule of 0: the workspace's Review tab and Implementation's
 * `?panel=files` trail in signoff-last-phase, Requirements' Review view in requirements-design-rooms, Design's Review tab
 * in design-review-floors; the quiz and reference solution trails in quiz-breadcrumbs and
 * solution-room. The breadcrumbs below are read from the pages' text, wherever each page is split to, because the
 * frame that draws them is stood in for in the pages' own tests.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { closureText, moduleText } from './support/source-text';
import { Matrix } from '@/components/workspace/panels/testing/Matrix';
import { NO_BUG_BEHIND } from '@/components/workspace/panels/testing/MatrixDoc';
import type { MatrixView } from '@/components/workspace/panels/testing/lib';

const read = (file: string) => closureText(file);

/*
 * Every page of a phase reads "<project> › <Phase> › <leaf>", the phase a link to its place on the phases page and the
 * leaf the row's entry for the view or the record. Implementation's workspace names no "Files" leaf for the file tree,
 * which is not a row entry (it is the left column's tab), and the change request's loading frame draws the phase as a
 * link, not as a page.
 */
describe('the breadcrumbs agree after the merge', () => {
  it('Implementation\'s workspace names the view, never "Files", as its leaf', () => {
    // The whole room, wherever it is split to: the breadcrumbs are drawn by a module the page imports.
    const page = read('app/(app)/workspace/[phaseId]/page.tsx');
    expect(page).not.toContain("pane === 'files' ? 'Files'");
    expect(page).toContain("? implementationView === 'split' ? 'Split' : implementationView === 'preview' ? previewLabel : 'Code'");
  });
  it('the phase is a link to its place on the phases page on every code phase\'s pages', () => {
    for (const [file, phase] of [
      ['app/(app)/workspace/[phaseId]/drill/page.tsx', "href: '/phases?phase=deployment'"],
      ['app/(app)/workspace/[phaseId]/matrix/page.tsx', "href: '/phases?phase=testing'"],
      ['app/(app)/workspace/[phaseId]/pr/page.tsx', 'href: `/phases?phase=${phaseKey}`'],
      ['app/(app)/workspace/[phaseId]/page.tsx', 'href: `/phases?phase=${detail.key}`'],
      ['app/(app)/workspace/[phaseId]/design/page.tsx', "{ label: 'Design', href: '/phases?phase=design' }"],
      ['components/workspace/requirements/RequirementsWorkspace.tsx', "{ label: 'Requirements', href: '/phases?phase=requirements' }"],
    ] as const) expect(read(file), file).toContain(phase);
    const change = read('app/(app)/workspace/[phaseId]/change/page.tsx');
    expect(change).toContain("{ label: 'Maintenance', href: '/phases?phase=maintenance' },\n          { label: 'Change request' },");
    expect(change).toContain("{ label: detail.title, href: '/phases?phase=maintenance' },\n        { label: m.ticket.id },");
    expect(moduleText('app/(app)/workspace/[phaseId]/change/page.tsx')).not.toMatch(/\{ label: 'Maintenance' \}/);
  });
});

/*
 * The planted bugs have one name. The planted bugs page draws no "Kill matrix", "No kill matrix yet" or "No bug
 * behind it"; the workspace's own grid (the lower panel's Matrix) draws them.
 */
describe('the workspace\'s grid says what the planted bugs page says', () => {
  const draw = async (view: MatrixView) => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Matrix view={view} submitLabel="Submit PR-4" busy={false} onSubmit={() => undefined} />));
    const text = host.textContent ?? '';
    act(() => root.unmount()); host.remove();
    return text;
  };
  it('before any grid: "Planted bugs", "No planted bugs have run yet", never "kill matrix"', async () => {
    const text = await draw({ columns: [], rows: [], killed: 0, total: 0, unrun: false });
    expect(text).toContain('Planted bugs');
    expect(text).toContain('No planted bugs have run yet');
    expect(text.toLowerCase()).not.toContain('kill matrix');
  });
  it('a test no planted bug depends on reads the page\'s one phrase', async () => {
    const text = await draw({
      columns: [{ key: 'test_a', label: 'T1', name: 'test_a', kills: [], verdict: 'kills-nothing' }, { key: 'test_b', label: 'T2', name: 'test_b', kills: ['B1'], verdict: 'load-bearing' }],
      rows: [{ row: { mutant: 'm1', description: 'Bug 1', killed: true, cases: [{ name: 'test_b', status: 'failed' }] }, id: 'B1', killers: ['T2'], ran: ['T1', 'T2'] }],
      killed: 1, total: 1, unrun: false,
    });
    expect(NO_BUG_BEHIND).toBe('No planted bug behind it');
    expect(text).toContain(NO_BUG_BEHIND);
    expect(text).not.toContain('No bug behind it');
    expect(text.toLowerCase()).not.toContain('kill matrix');
  });
});
