// @vitest-environment jsdom
/**
 * Axe on the rail and on /teacher/guide, beyond teacher-guide-content's two arms
 * (the rail with no draft, every step closed; the TeacherGuide component) and
 * its empty-header tripwire.
 *
 * - The rail as the editor draws it: every state (done, out of date, not yet,
 *   does not apply), the next step named, and every step OPENED, so the help,
 *   "Take me there" and the guide links are inside what axe reads (a closed
 *   <details> hides them from it).
 * - The Projects page's "Start here", with its stateless rail opened.
 * - The /teacher/guide route itself: the page file's default export.
 * - The helper is armed: a nameless button is reported, so a green here is
 *   not a check that sees nothing.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAxe } from './support/axe-bridge';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/teacher/guide',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSession: () => ({ id: 'teacher-1', role: 'INSTRUCTOR', displayName: 'A Teacher' }),
}));

import { GuideRail } from '@/components/staff/guide/GuideRail';
import { StartHere } from '@/components/staff/guide/StartHere';
import { deriveGuideSteps, type DerivedGuideStep } from '@/components/staff/guide/guide-steps';
import TeacherGuidePage from '@/app/(app)/teacher/guide/page';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const render = (node: ReactNode) => act(async () => root.render(node));

/** Open every step, so axe reads the help and the links inside it. */
function openAll(): number {
  const all = host.querySelectorAll('details');
  all.forEach((one) => one.setAttribute('open', ''));
  return all.length;
}

async function axeFindings(extra: Record<string, { enabled: boolean }> = {}): Promise<string[]> {
  const axe = await loadAxe();
  const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, ...extra } });
  return result.violations.map((one) => `${one.id}: ${one.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

/** The editor's rail mid-path: each state the rail can say, once at least. */
function midPath(): DerivedGuideStep[] {
  const state: Record<string, Pick<DerivedGuideStep, 'state' | 'applies'>> = {
    prepare: { state: 'done', applies: true },
    upload: { state: 'done', applies: true },
    refine: { state: 'done', applies: true },
    seal: { state: 'done', applies: true },
    'deep-validate': { state: 'stale', applies: true },
    preview: { state: 'todo', applies: true },
    publish: { state: 'todo', applies: true },
    assign: { state: 'todo', applies: true },
    'sign-off': { state: 'done', applies: true },
    export: { state: 'todo', applies: false },
  };
  return deriveGuideSteps({ view: null }).map((step) => ({ ...step, ...state[step.key] }));
}

describe('axe on the rail and on /teacher/guide', () => {
  it('the helper is armed: a nameless button is reported', async () => {
    await render(<button type="button" />);
    expect((await axeFindings()).join('\n')).toMatch(/^button-name:/m);
  });

  it("the editor's rail, every state drawn and every step opened, is clean", async () => {
    await render(<GuideRail steps={midPath()} where="editor" />);
    expect(host.querySelector('[data-testid="guide-rail"]')).not.toBeNull();
    // Every state word the rail says is on the page.
    const words = [...host.querySelectorAll('summary .label-sm')].map((one) => one.textContent);
    expect(words).toEqual(expect.arrayContaining(['Done', 'Out of date', 'Not yet', 'Does not apply']));
    expect(openAll()).toBe(10);
    expect(host.querySelectorAll('[data-testid^="guide-step-go-"]').length).toBeGreaterThan(0);
    expect(await axeFindings()).toEqual([]);
  });

  it("the Projects page's Start here, its stateless rail opened, is clean", async () => {
    await render(<StartHere />);
    expect(openAll()).toBe(10);
    expect(await axeFindings()).toEqual([]);
  });

  it('the /teacher/guide route (the page file), every step opened, is clean', async () => {
    await render(<TeacherGuidePage />);
    expect(host.querySelector('h1')?.textContent).toBe('Teacher guide');
    expect(openAll()).toBeGreaterThanOrEqual(10);
    expect(await axeFindings()).toEqual([]);
  });
});
