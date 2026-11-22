// @vitest-environment jsdom
/*
 * With Presentation view on, the printable record's cover drew the
 * learner's email on its first paint and the mask arrived a frame later (the
 * switch started every component at "off" and read storage in an effect). The
 * switch is now read while rendering: a page drawn in the browser never paints
 * an address the switch hides, a render that cannot read it (the server's, and
 * the hydration that matches it) treats it as on, and the print of the page
 * holds what the page holds. With the switch off, the email is drawn.
 */
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, LearnerDossier, PhaseDetail } from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import { PresentationToggle } from '@/components/experience/PresentationToggle';
import {
  PRESENTATION_VIEW_KEY,
  usePresentationView,
  usePresentationViewSetting,
} from '@/components/experience/presentation-view';

const mocks = vi.hoisted(() => ({ dossier: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ userId: 'ada' }),
  useSearchParams: () => new URLSearchParams('project=tasktrackr'),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/components/experience/shared', () => ({
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  LoadingState: () => <p role="status">Loading</p>,
}));
vi.mock('@/components/shell/AppFrame', () => ({ RetryNotice: ({ message }: { message: string }) => <p role="alert">{message}</p> }));
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: { learnerDossier: mocks.dossier },
  getConsoleProject: () => '',
  ALL_PROJECTS: 'all',
}));

const EMAIL = 'ada.lovelace@smu.example';
const MASKED = 'Email hidden in Presentation view';
const phase = { id: 'phase-req', key: 'requirements', order: 1, title: 'Requirements', status: 'in_progress', attempts: 0, bestScore: null, passedAt: null };
const enrollment = {
  phases: [phase], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
} as unknown as EnrollmentView;
const details = { 'phase-req': { ...phase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] } } } as unknown as Record<string, PhaseDetail>;
const dossier = (): LearnerDossier => ({ ...buildDossier(enrollment, details, {}, {}, null), displayName: 'Ada Lovelace', email: EMAIL });

const setSwitch = (on: boolean) => {
  if (on) window.localStorage.setItem(PRESENTATION_VIEW_KEY, 'on');
  else window.localStorage.removeItem(PRESENTATION_VIEW_KEY);
};

let root: Root | null; let host: HTMLDivElement;
beforeEach(() => { setSwitch(false); host = document.createElement('div'); document.body.append(host); root = null; });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove();
  setSwitch(false);
  vi.restoreAllMocks();
});

/** What the page holds at its first commit, before the browser paints and before any effect runs. */
function FirstCommit({ children, seen }: { children: ReactNode; seen: string[] }) {
  useLayoutEffect(() => {
    seen.push(document.body.textContent ?? '');
  }, [seen]);
  return <>{children}</>;
}

/** Every text the page ever held while it settles: added, removed and replaced. */
function watchEveryText(target: Node): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.oldValue) texts.push(record.oldValue);
      for (const node of [...record.addedNodes, ...record.removedNodes]) texts.push(node.textContent ?? '');
    }
  });
  observer.observe(target, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  return { texts, stop: () => { texts.push(...observer.takeRecords().flatMap((r) => [r.oldValue ?? '', ...[...r.addedNodes, ...r.removedNodes].map((n) => n.textContent ?? '')])); observer.disconnect(); } };
}

describe('the record’s cover before the switch is read', () => {
  it('a render that cannot read the switch (the server’s) draws no email, whatever the switch says', () => {
    setSwitch(false);
    const html = renderToString(<Dossier dossier={dossier()} />);
    expect(html).not.toContain(EMAIL);
    expect(html).toContain(MASKED);
  });

  it('switch on: the first commit in the browser already hides the email', async () => {
    setSwitch(true);
    const seen: string[] = [];
    root = createRoot(host);
    await act(async () => root!.render(<FirstCommit seen={seen}><Dossier dossier={dossier()} /></FirstCommit>));
    expect(seen[0]).toContain(MASKED);
    expect(seen[0]).not.toContain(EMAIL);
    expect(host.textContent).not.toContain(EMAIL);
  });

  it('switch off: the first commit in the browser draws the email', async () => {
    const seen: string[] = [];
    root = createRoot(host);
    await act(async () => root!.render(<FirstCommit seen={seen}><Dossier dossier={dossier()} /></FirstCommit>));
    expect(seen[0]).toContain(EMAIL);
    expect(host.querySelector('[data-testid="dossier-cover-email"]')!.textContent).toBe(EMAIL);
  });

  it('hydrating the server’s page: masked until read, then masked (on) or shown (off)', async () => {
    for (const on of [true, false]) {
      setSwitch(false);
      host.innerHTML = renderToString(<Dossier dossier={dossier()} />);
      setSwitch(on);
      const watch = watchEveryText(host);
      await act(async () => { root = hydrateRoot(host, <Dossier dossier={dossier()} />); });
      watch.stop();
      const cover = host.querySelector('[data-testid="dossier-cover-email"]')!.textContent;
      if (on) {
        expect(cover).toBe(MASKED);
        expect(watch.texts.join('\n')).not.toContain(EMAIL);
      } else {
        expect(cover).toBe(EMAIL);
      }
      await act(async () => root!.unmount());
      root = null;
      host.innerHTML = '';
    }
  });
});

describe('the print route under the switch', () => {
  const openPrintPage = async () => {
    mocks.dossier.mockResolvedValue(dossier());
    const { default: Page } = await import('@/app/(app)/instructor/learners/[userId]/dossier/page');
    const watch = watchEveryText(host);
    root = createRoot(host);
    await act(async () => root!.render(<Page />));
    await act(async () => { await Promise.resolve(); });
    watch.stop();
    return watch.texts;
  };
  const printNow = async (): Promise<string> => {
    let printed = '';
    vi.spyOn(window, 'print').mockImplementation(() => { printed = document.body.textContent ?? ''; });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="dossier-print"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    return printed;
  };

  it('on: the page never holds the email while it loads, and the print holds none', async () => {
    setSwitch(true);
    const texts = await openPrintPage();
    expect(host.querySelector('[data-testid="dossier-cover-email"]')!.textContent).toBe(MASKED);
    expect(texts.join('\n')).not.toContain(EMAIL);
    const printed = await printNow();
    expect(printed).toContain(MASKED);
    expect(printed).not.toContain(EMAIL);
  });

  it('off: the print holds the email as it does today', async () => {
    await openPrintPage();
    const printed = await printNow();
    expect(printed).toContain(EMAIL);
  });
});

describe('the switch itself before it is read', () => {
  function Probe() {
    const [hide] = usePresentationView();
    const setting = usePresentationViewSetting();
    return <p>{`${hide}/${String(setting)}`}</p>;
  }

  it('the server’s render has no value; every email-drawing component reads it as on', () => {
    setSwitch(false);
    expect(renderToString(<Probe />)).toContain('true/null');
  });

  it('the toggle never claims to be on before it is read', () => {
    setSwitch(true);
    const html = renderToString(<PresentationToggle />);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('Presentation view on');
  });

  it('read in the browser, it is the stored value', async () => {
    setSwitch(true);
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    expect(host.textContent).toBe('true/true');
    setSwitch(false);
    window.dispatchEvent(new StorageEvent('storage', { key: PRESENTATION_VIEW_KEY }));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toBe('false/false');
  });
});
