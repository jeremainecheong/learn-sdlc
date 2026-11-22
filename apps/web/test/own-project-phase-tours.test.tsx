// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail, PhaseKey, PhaseProvenanceView } from '@learnsdlc/shared';
import { phaseTutorialMarks, type CoachMark } from '@/components/shell/tours';
import { jsonLines } from './support/markup-snapshot';

/* The mounted case below renders the real phase layout around a stand-in room. */
const mount = vi.hoisted(() => ({ phaseId: 'tour-phase-0', project: null as unknown }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: mount.phaseId }),
  usePathname: () => `/workspace/${mount.phaseId}`,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => mount.project,
  useProjectMaybe: () => mount.project,
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'tour-learner', role: 'LEARNER', displayName: 'Ada Example' }),
}));
import Layout from '@/app/(app)/workspace/[phaseId]/layout';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';

/**
 * The implementation tour's preview step on a teacher's own application.
 *
 * The implementation room hides its "App preview" view button when the phase
 * does not run the reference application (`runsReferenceApplication`). The
 * tour's third implementation step points at
 * `[aria-label="Implementation working area"] > :nth-child(3)`, which, with
 * the button gone, is the next entry (the Pull request link), so the card over it would say
 * "Inspect the app preview" there. The tour takes the same predicate and
 * leaves the step out, so it never points at a control that is not there.
 *
 * A TaskTrackr learner's tour is the one recorded in
 * `__snapshots__/tasktrackr-tour-marks.json`: every phase, with and without the
 * phase guide, and the same for every provenance a reference phase can carry
 * (none from an older build, a written phase with no `application`, and
 * TaskTrackr's application).
 */

type Application = Pick<PhaseProvenanceView, 'application'> | null | undefined;
const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const marksFor = (key: PhaseKey, lessons: boolean, application?: Application): CoachMark[] =>
  (phaseTutorialMarks as (key: PhaseKey, lessons?: boolean, application?: Application) => CoachMark[])(key, lessons, application);
const PREVIEW_SELECTOR = '[aria-label="Implementation working area"] > :nth-child(3)';

describe('the phase tours on a teacher\'s own application', () => {
  it('a TaskTrackr learner\'s tour steps are the recorded ones, whatever provenance a reference phase carries', async () => {
    const tours: Record<string, CoachMark[]> = {};
    for (const key of KEYS) {
      for (const lessons of [true, false]) {
        const today = marksFor(key, lessons);
        tours[`${key}:${lessons}`] = today;
        for (const application of [undefined, null, { application: 'TaskTrackr' }, {}] as Application[]) {
          expect(marksFor(key, lessons, application), `${key} lessons=${lessons} ${JSON.stringify(application)}`).toEqual(today);
        }
      }
    }
    await expect(jsonLines(tours)).toMatchFileSnapshot('__snapshots__/tasktrackr-tour-marks.json');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * The implementation nav as the workspace draws it, with or without the App preview button. Each view
   * button carries its view's name (`data-view`) and the row ends with the Pull request link, as the workspace draws them.
   */
  const VIEW: Record<string, string> = { Code: 'code', Split: 'split', 'App preview': 'preview' };
  const drawNav = (preview: boolean) => {
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Implementation working area');
    // No Files button; the file tree is the left column's Files tab.
    for (const label of ['Code', 'Split', ...(preview ? ['App preview'] : [])]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-view', VIEW[label]);
      button.textContent = label;
      nav.append(button);
    }
    const pr = document.createElement('a');
    pr.setAttribute('href', '/workspace/p-3/pr');
    pr.textContent = 'Pull request';
    nav.append(pr);
    const span = document.createElement('span');
    span.textContent = 'Saved workspace';
    nav.append(span);
    document.body.append(nav);
  };
  const pointedAt = (mark: CoachMark) => (mark.selector ? document.querySelector(mark.selector)?.textContent ?? null : null);

  it('for an own application the tour never points at a control that is not there', () => {
    drawNav(false);
    for (const lessons of [true, false]) {
      const marks = marksFor('implementation', lessons, { application: null });
      // No step speaks about the App preview, and none is aimed at the slot it filled.
      expect(marks.map((mark) => mark.target)).not.toContain('implementation-tutorial-preview');
      expect(marks.map((mark) => mark.selector)).not.toContain(PREVIEW_SELECTOR);
      expect(marks.map((mark) => `${mark.title} ${mark.body}`).join(' ')).not.toMatch(/app preview/i);
      // Every step aimed into the nav lands on the control it names.
      for (const mark of marks) {
        const label = pointedAt(mark);
        if (label && mark.selector?.startsWith('[aria-label="Implementation working area"]')) {
          expect(`${mark.title} ${mark.body}`, mark.target).toContain(label);
        }
      }
      // The rest of the tour is TaskTrackr's, step for step, except that its
      // first step names the brief rather than Design contracts an own
      // application does not have.
      const reference = marksFor('implementation', lessons).filter((mark) => mark.target !== 'implementation-tutorial-preview');
      expect(marks.slice(1)).toEqual(reference.slice(1));
      expect({ ...marks[0], title: reference[0].title, body: reference[0].body }).toEqual(reference[0]);
      expect(marks[0].title).toBe('Work in the editable files');
      expect(`${marks[0].title} ${marks[0].body}`).not.toMatch(/contract/i);
    }
    // Implementation and maintenance draw a nav that lost children (maintenance: see below);
    // every other phase's tour is unchanged.
    for (const key of KEYS.filter((k) => k !== 'implementation' && k !== 'maintenance')) {
      expect(marksFor(key, true, { application: null }), key).toEqual(marksFor(key, true));
    }
  });

  /**
   * The maintenance runtime nav ('Phase working area') of an own application
   * draws only [Edit files, Execution evidence, Pull request]: App preview
   * and the Change request link are hidden. TaskTrackr's tour aims its change
   * step at the Change request link (first in the row) and names
   * "Change request" twice, so an own application's tour must differ.
   */
  const drawMaintenanceNav = () => {
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Phase working area');
    for (const label of ['Edit files', 'Execution evidence']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      nav.append(button);
    }
    const pr = document.createElement('a');
    pr.setAttribute('href', '/workspace/p-6/pr');
    pr.textContent = 'Pull request';
    nav.append(pr);
    document.body.append(nav);
  };

  it('for an own application the maintenance tour never points at a control that is not there', () => {
    drawMaintenanceNav();
    for (const lessons of [true, false]) {
      const marks = marksFor('maintenance', lessons, { application: null });
      // No step sends the learner to a Change request the room does not draw.
      expect(marks.map((mark) => `${mark.title} ${mark.body}`).join(' ')).not.toMatch(/change request/i);
      // Every step aimed into the nav lands on a control, and on the one it names.
      for (const mark of marks) {
        if (!mark.selector?.startsWith('[aria-label="Phase working area"]')) continue;
        const label = pointedAt(mark);
        expect(label, mark.target).not.toBeNull();
        expect(`${mark.title} ${mark.body}`, mark.target).toContain(label!);
      }
      // The pull request step lands on Pull request.
      const pr = marks.find((mark) => mark.target === 'maintenance-tutorial-pr');
      expect(pr && pointedAt(pr)).toBe('Pull request');
      // Same steps, same order, as TaskTrackr's tour.
      expect(marks.map((mark) => mark.target)).toEqual(marksFor('maintenance', lessons).map((mark) => mark.target));
    }
  });

  it('TaskTrackr\'s maintenance tour lands on the control each step names in the row that leads with Change request', () => {
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Phase working area');
    nav.innerHTML = '<a href="/workspace/p-6/change">Change request</a><button type="button">Edit files</button><button type="button">Execution evidence</button><button type="button">App preview</button><a href="/workspace/p-6/pr">Pull request</a>';
    document.body.append(nav);
    for (const lessons of [true, false]) {
      const marks = marksFor('maintenance', lessons);
      const at = (target: string) => pointedAt(marks.find((mark) => mark.target === target)!);
      // The first step aims at the change request's own heading where the page draws it, then at the row's Change request.
      const change = marks.find((mark) => mark.target === 'maintenance-tutorial-change')!;
      expect(change.selector).toBe('[data-testid="change-title"]');
      expect([change.fallbackSelector].flat().map((selector) => selector && document.querySelector(selector)?.textContent).find(Boolean)).toBe('Change request');
      expect(at('maintenance-tutorial-files')).toBe('Edit files');
      expect(at('maintenance-tutorial-pr')).toBe('Pull request');
      expect(marks.map((mark) => mark.body).join(' ')).not.toMatch(/Edit changes|Files changed/);
    }
  });

  it('an uploaded room with a change request: the tour lands on Edit files, Execution evidence and Pull request', () => {
    // The row an uploaded project's Maintenance draws when its teacher wrote a change request (opensChangeRoom) and its page has a preview.
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Phase working area');
    nav.innerHTML = '<a href="/workspace/p-6/change">Change request</a><button type="button">Edit files</button><button type="button">Execution evidence</button><button type="button">Page preview</button><a href="/workspace/p-6/pr">Pull request</a>';
    document.body.append(nav);
    const marks = marksFor('maintenance', true, { application: null });
    // The first selector that finds a control, as CoachMarks takes them: the step's own, then its fallbacks (no header-run here).
    const lands = (target: string) => {
      const mark = marks.find((one) => one.target === target)!;
      const fallbacks = mark.fallbackSelector === undefined ? [] : Array.isArray(mark.fallbackSelector) ? mark.fallbackSelector : [mark.fallbackSelector];
      for (const selector of [mark.selector, ...fallbacks]) {
        const found = selector ? document.querySelector(selector) : null;
        if (found) return found.textContent;
      }
      return null;
    };
    expect(document.querySelector('[data-testid="header-run"]')).toBeNull();
    expect(lands('maintenance-tutorial-files')).toBe('Edit files');
    expect(lands('maintenance-tutorial-check')).toBe('Execution evidence');
    expect(lands('maintenance-tutorial-pr')).toBe('Pull request');
  });

  it('the reference application\'s preview step still lands on App preview', () => {
    drawNav(true);
    const step = marksFor('implementation', true, { application: 'TaskTrackr' }).find((mark) => mark.target === 'implementation-tutorial-preview');
    expect(step && pointedAt(step)).toBe('App preview');
  });

  /**
   * Mounted. The phase layout hands the held detail's provenance to the
   * tour (layout.tsx → PhaseTutorialProvider → CoachMarks), so the steps a
   * learner is walked through are the ones tours.ts chose for the room drawn.
   */
  describe('mounted: the phase layout hands the held detail\'s provenance to the tour', () => {
    const realRect = Element.prototype.getBoundingClientRect;
    const realScroll = Element.prototype.scrollIntoView;
    const realShow = HTMLDialogElement.prototype.showModal;
    const realClose = HTMLDialogElement.prototype.close;
    let host: HTMLDivElement;
    let root: Root;
    let serial = 0;
    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
      mount.phaseId = `tour-phase-${++serial}`;
      // Every element has a box, so CoachMarks sees its targets; the Pull request link has its own.
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const left = this.matches('a[href$="/pr"]') ? 300 : 20;
        return { top: 20, left, right: left + 100, bottom: 60, width: 100, height: 40, x: left, y: 20, toJSON() {} } as DOMRect;
      };
      Element.prototype.scrollIntoView = () => {};
      HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
      HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    });
    afterEach(() => {
      act(() => root.unmount());
      host.remove();
      Element.prototype.getBoundingClientRect = realRect;
      Element.prototype.scrollIntoView = realScroll;
      HTMLDialogElement.prototype.showModal = realShow;
      HTMLDialogElement.prototype.close = realClose;
    });

    /** The room as the workspace draws it for this provenance, ready once its phase GET is in. */
    function Room({ detail, own }: { detail: PhaseDetail; own: boolean }) {
      usePhaseTutorialReady(detail);
      return detail.key === 'implementation' ? (
        <>
          <nav aria-label="Implementation working area">
            {['Code', 'Split', ...(own ? [] : ['App preview'])].map((label) => <button key={label} type="button" data-view={VIEW[label]}>{label}</button>)}
            <a href={`/workspace/${detail.id}/pr`}>Pull request</a>
            <span>Saved workspace</span>
          </nav>
          <button type="button" data-testid="header-run">Run tests</button>
        </>
      ) : (
        <>
          <nav aria-label="Phase working area">
            {own ? null : <a href={`/workspace/${detail.id}/change`}>Change request</a>}
            <button type="button">Edit files</button>
            <button type="button">Execution evidence</button>
            <a href={`/workspace/${detail.id}/pr`}>Pull request</a>
          </nav>
          <button type="button" data-testid="header-run">Run tests</button>
        </>
      );
    }

    /** Mount the real layout around the room and walk every step the tour shows. */
    const walk = (key: PhaseKey, application: Application) => {
      const detail = {
        id: mount.phaseId, key, order: key === 'implementation' ? 3 : 6, title: key, status: 'in_progress', files: [], tasks: [],
        ...(application === undefined ? {} : { provenance: { phaseKey: key, rollup: application?.application === null ? 'own' : 'reference', ...application } }),
      } as unknown as PhaseDetail;
      mount.project = { enrollment: null, currentPhase: null, details: { [mount.phaseId]: detail }, loading: false, error: '', reload: () => Promise.resolve() };
      act(() => root.render(<Layout><Room detail={detail} own={application?.application === null} /></Layout>));
      const coach = () => host.querySelector<HTMLElement>('[data-testid="coach"]');
      expect(coach(), 'the tour opens on first entry').not.toBeNull();
      const steps: { target: string; text: string; highlightLeft: string | undefined }[] = [];
      for (let guard = 0; guard < 20; guard += 1) {
        const card = host.querySelector<HTMLElement>('[data-testid="coach-card"]')!;
        steps.push({
          target: card.getAttribute('data-target') ?? '',
          text: card.querySelector('.coach-copy')?.textContent ?? '',
          highlightLeft: host.querySelector<HTMLElement>('[data-testid="coach-highlight"]')?.style.left,
        });
        const [at, of] = (host.querySelector('[data-testid="coach-count"]')?.textContent ?? '').split(' of ');
        if (at === of) break;
        act(() => host.querySelector<HTMLButtonElement>('[data-testid="coach-next"]')!.click());
      }
      return steps;
    };

    it('an own application\'s implementation tour has no App preview step', () => {
      const steps = walk('implementation', { application: null });
      expect(steps.map((step) => step.target)).not.toContain('implementation-tutorial-preview');
      expect(steps.map((step) => step.text).join(' ')).not.toMatch(/inspect the app preview/i);
      expect(steps.map((step) => step.target)).toEqual(marksFor('implementation', true, { application: null }).map((mark) => mark.target));
    });

    it('an own application\'s maintenance tour has no Change request step and aims Pull request at the nav link', () => {
      const steps = walk('maintenance', { application: null });
      expect(steps.map((step) => step.text).join(' ')).not.toMatch(/change request/i);
      const pr = steps.find((step) => step.target === 'maintenance-tutorial-pr');
      expect(pr?.highlightLeft, 'the Pull request step lands on the nav link').toBe('296px');
    });

    it('a TaskTrackr phase\'s mounted tour is unchanged', () => {
      for (const application of [undefined, { application: 'TaskTrackr' }] as Application[]) {
        const label = JSON.stringify(application);
        const implementation = walk('implementation', application);
        expect(implementation.map((step) => step.target), label).toEqual(marksFor('implementation', true).map((mark) => mark.target));
        expect(implementation.map((step) => step.target), label).toContain('implementation-tutorial-preview');
        localStorage.clear();
        mount.phaseId = `tour-phase-${++serial}`;
        const maintenance = walk('maintenance', application);
        expect(maintenance.map((step) => step.target), label).toEqual(marksFor('maintenance', true).map((mark) => mark.target));
        // The first step reads the request where it is drawn, rather than naming a control that opens it.
        expect(maintenance.map((step) => step.text).join(' '), label).toMatch(/Read the change request: the behavior that must change/);
        localStorage.clear();
        mount.phaseId = `tour-phase-${++serial}`;
      }
    });
  });
});
