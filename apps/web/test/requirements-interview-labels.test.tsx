// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getByRole, queryByRole } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSession } from '@/lib/session';

/**
 * The Requirements room puts two
 * conversations side by side: the stakeholder interview, where the story's
 * evidence comes from and which the learner must hold, and the mentor, which
 * is optional help, and the screen must say which is which. Each
 * control carries the task list's own word beside it, "Required" or
 * "Optional", visible at every width; the word is the control's description,
 * so its name ("Stakeholder interview", "Show mentor", "Hide mentor") stays
 * the one every harness and browser script presses. The quick check's
 * "Optional" is pinned in learner-state-words.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workspace/phase-requirements',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ phaseId: 'phase-requirements' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { RequirementsTabs } from '@/components/workspace/requirements/RequirementsWorkspace';
import { useWorkspacePanels, WorkspacePanelControls } from '@/components/workspace/WorkspacePanels';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  setSession({ id: 'polish-labels', email: 'polish@example.test', displayName: 'P', role: 'LEARNER', cohort: 'default', createdAt: '2026-11-09T00:00:00Z' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setSession(null);
});

function Controls({ note }: { note?: 'Optional' }) {
  const panels = useWorkspacePanels();
  return <><WorkspacePanelControls panels={panels} mentorNote={note} /><aside id={panels.mentorId} hidden={!panels.mentorOpen} /></>;
}

describe('the Requirements room says which conversation is required', () => {
  it('the interview tab reads "Required" beside its name, and keeps its name', () => {
    act(() => root.render(<RequirementsTabs base="/workspace/p" active="interview" noInterview={false} onKeyDown={() => undefined} onSelect={() => undefined} />));
    const tab = getByRole(host, 'tab', { name: 'Stakeholder interview', description: 'Required' });
    expect(tab.id).toBe('requirements-interview-tab');
    expect(tab.querySelector('[data-testid="requirements-interview-required"]')?.textContent).toBe('Required');
    // The backlog is the work itself; it carries no qualifier.
    const backlog = getByRole(host, 'tab', { name: 'My backlog' });
    expect(backlog.querySelector('.requirements-qualifier')).toBeNull();
  });

  it('a phase with no interview draws no "Required" word', () => {
    act(() => root.render(<RequirementsTabs base="/workspace/p" active="backlog" noInterview onKeyDown={() => undefined} onSelect={() => undefined} />));
    expect(host.textContent).not.toContain('Required');
  });

  it('the mentor switch reads "Optional" in both its states, and keeps its names', () => {
    act(() => root.render(<Controls note="Optional" />));
    const first = queryByRole(host, 'button', { name: 'Show mentor' }) ? 'Show mentor' : 'Hide mentor';
    const mentor = getByRole(host, 'button', { name: first, description: 'Optional' });
    expect(mentor.querySelector('[data-testid="mentor-note"]')?.textContent).toBe('Optional');
    act(() => mentor.click());
    const other = first === 'Show mentor' ? 'Hide mentor' : 'Show mentor';
    expect(getByRole(host, 'button', { name: other, description: 'Optional' }).querySelector('[data-testid="mentor-note"]')?.textContent).toBe('Optional');
    // The brief's switch is not qualified.
    const brief = getByRole(host, 'button', { name: /brief$/ });
    expect(brief.querySelector('.workspace-panel-note')).toBeNull();
  });

  it('every other room\'s switches are drawn with no note unless asked', () => {
    act(() => root.render(<Controls />));
    expect(host.querySelector('[data-testid="mentor-note"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('button')).map((b) => b.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^(Show|Hide) mentor$/)]));
  });

  it('on phones the room\'s two chips step out of the tabs (WCAG 1.4.10), nowhere else', () => {
    const sheet = readFileSync(resolve(__dirname, '../components/workspace/requirements/requirements-workspace.css'), 'utf8');
    const hides = [...sheet.matchAll(/@media\(([^)]*)\)\{([^{}]*(?:requirements-qualifier|workspace-panel-note)[^{}]*)\{display:\s*none\}\}/g)];
    expect(hides.map((m) => m[1])).toEqual(['max-width:700px']);
    expect(hides[0][2]).toContain('.requirements-tabs .requirements-qualifier');
    expect(hides[0][2]).toContain('.requirements-toolbar .workspace-panel-note');
  });

  it('no stylesheet hides the quick check\'s "Optional", and none hides the qualifiers above phone width', () => {
    const sheets = ['../components/workspace/phase-experience.css', '../components/workspace/requirements/requirements-workspace.css', '../components/workspace/WorkspacePanels.css', '../components/shell/shell-fidelity.css']
      .map((file) => readFileSync(resolve(__dirname, file), 'utf8')).join('\n');
    // The phone rule above is the one exception; outside it nothing hides them.
    const outsidePhone = sheets.replace(/@media\(max-width:700px\)\{\.requirements-tabs \.requirements-qualifier,[^}]*\}\}/, '');
    for (const selector of ['requirements-qualifier', 'workspace-panel-note', 'quick-check-optional', 'concept-prompt-optional']) {
      const hides = new RegExp(`${selector}[^{}]*\\{[^}]*(display:\\s*none|visibility:\\s*hidden)`);
      expect(outsidePhone, selector).not.toMatch(hides);
    }
  });
});
