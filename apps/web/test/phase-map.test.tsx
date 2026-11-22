// @vitest-environment jsdom
/**
 * The catalogue's phase map (`components/learn/PhaseMap.tsx`,
 * `components/learn/phase-map.ts`) and the slot for "How LearnSDLC checks
 * your work" (`components/learn/HowChecksWorkSlot.tsx`), on `/learn`.
 */
import { repoFile } from './support/paths';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moduleText } from './support/source-text';
import type { PhaseKey, PhaseSummary } from '@learnsdlc/shared';
import { PHASE_EXPERIENCE } from '@/components/phases/experience';
import { PhaseMap } from '@/components/learn/PhaseMap';
import { GATE_RULE, PHASE_MAKES, PHASE_NAMES, PHASE_ORDER, gateSentence, mapNodes } from '@/components/learn/phase-map';
import { HowChecksWorkSlot } from '@/components/learn/HowChecksWorkSlot';
import { HOW_CHECKS_STEPS } from '@/components/learn/HowChecksWork';

const shell = vi.hoisted(() => ({ enrollment: null as null | { phases: PhaseSummary[] } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({ ...(await original<typeof import('@/lib/session')>()), useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR' }) }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: shell.enrollment, details: undefined, loading: false }) }));
import LearnPage from '@/app/(app)/learn/page';

const summary = (key: PhaseKey, order: number, status: PhaseSummary['status'], extra: Partial<PhaseSummary> = {}): PhaseSummary =>
  ({ id: `${key}-phase`, key, order, title: PHASE_NAMES[key], status, attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, ...extra }) as PhaseSummary;

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });
const render = (node: ReactNode) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
  return host;
};
const nodeButton = (host: HTMLElement, key: PhaseKey) => host.querySelector<HTMLButtonElement>(`.phase-map-node[data-phase="${key}"]`)!;
const panel = (host: HTMLElement) => host.querySelector<HTMLElement>('#phase-map-panel')!;

describe('the phase states', () => {
  it('opens all six for a teacher or an account with no enrolment', () => {
    const nodes = mapNodes(null, PHASE_ORDER);
    expect(nodes.map((n) => n.key)).toEqual(PHASE_ORDER);
    expect(nodes.every((n) => n.state === 'open' && n.note === 'Open' && n.offered)).toBe(true);
  });

  it('reads a learner’s enrolment: passed, here, locked after the phase before, not held, not offered', () => {
    const enrollment = { phases: [
      summary('requirements', 1, 'passed'),
      summary('design', 2, 'in_progress'),
      summary('implementation', 3, 'locked'),
      summary('testing', 4, 'locked', { scenario: 'own' } as Partial<PhaseSummary>),
      summary('deployment', 5, 'locked'),
    ] };
    const offered: PhaseKey[] = ['requirements', 'design', 'implementation', 'deployment'];
    const byKey = Object.fromEntries(mapNodes(enrollment, offered).map((n) => [n.key, n]));
    expect([byKey.requirements.state, byKey.requirements.note]).toEqual(['passed', 'Passed']);
    expect([byKey.design.state, byKey.design.note]).toEqual(['current', 'You are here']);
    expect([byKey.implementation.state, byKey.implementation.note]).toEqual(['locked', 'Opens after Design']);
    expect([byKey.testing.state, byKey.testing.note, byKey.testing.offered]).toEqual(['not-offered', 'Your teacher wrote this phase', false]);
    expect([byKey.deployment.state, byKey.deployment.note]).toEqual(['locked', 'Opens after Testing']);
    expect([byKey.maintenance.state, byKey.maintenance.note]).toEqual(['not-held', 'Not in your project']);
  });

  it('says the gate as the product decides it: every check and criterion, never a score against a pass mark', () => {
    // The product's own words and rule, read from source: every phase brief
    // says the gate is every criterion and its evidence; the strict gate never
    // compares the score with a threshold; the reviewer is told there is none.
    const dirs = ['01-requirements', '02-design', '03-implementation', '04-testing', '05-deployment', '06-maintenance'];
    dirs.forEach((dir, i) => {
      const brief = (JSON.parse(repoFile(`content/tasktrackr/phases/${dir}/phase.json`)) as { taskPanel: string }).taskPanel;
      if (i < 5) expect(brief, dir).toContain('Every required criterion and its evidence must pass review before');
      else expect(brief, dir).toContain('passing completes the project');
    });
    const strict = repoFile('apps/api/src/feedback/strict-evidence.ts');
    const gate = strict.slice(strict.indexOf('export function strictTaskEvidencePassed'), strict.indexOf('export function reviewerVerdictIsAdvice'));
    expect(gate).toContain("review.verdict !== 'pass'");
    expect(gate).not.toMatch(/passThreshold|PASS_THRESHOLD/);
    expect(repoFile('apps/api/src/assistant/openai.provider.ts')).toContain('there is no pass threshold');
    for (const key of PHASE_ORDER) {
      const sentence = gateSentence(key);
      expect(sentence).toContain(`The phase passes when ${GATE_RULE}.`);
      expect(sentence).toContain('A score on its own never passes it.');
      expect(sentence).not.toMatch(/\b70\b|out of 100|score of|or more/);
    }
    expect(gateSentence('requirements')).toContain('The Pass opens Design.');
    expect(gateSentence('deployment')).toContain('The Pass opens Maintenance.');
    expect(gateSentence('maintenance')).toContain('The Pass completes the project.');
    for (const name of ['gateSentence', 'PhaseMap', 'REQUIREMENTS_FIGURES']) {
      expect(moduleText(name), name).not.toMatch(/\b70\b|DEFAULT_PASS_THRESHOLD|out of 100/);
    }
  });

  it('says what the learner really makes in each phase, checked against the briefs', () => {
    const phase = (dir: string) => JSON.parse(repoFile(`content/tasktrackr/phases/${dir}/phase.json`)) as { taskPanel: string; checks: { editableTargets?: string[]; learnerTestFiles?: unknown } };
    // Requirements: one story, US-4; an epic is optional.
    expect(phase('01-requirements').taskPanel).toContain('Complete your story, US-4');
    expect(phase('01-requirements').taskPanel).toContain('An epic relationship is optional');
    expect(PHASE_MAKES.requirements[0]).toContain('US-4');
    expect(PHASE_MAKES.requirements.join(' ')).not.toMatch(/user stories|epic and/i);
    expect(PHASE_MAKES.requirements[2]).toBe('An epic only if you choose to add one');
    // Design: the brief's tabs include the sequence diagram.
    expect(phase('02-design').taskPanel).toContain('In the Sequence diagram, trace the overdue request');
    expect(PHASE_MAKES.design).toContain('A sequence diagram of the overdue request');
    // Testing: two suites, eight planted copies.
    expect(phase('04-testing').taskPanel).toContain('tests/test_acceptance.py');
    expect(phase('04-testing').taskPanel).toContain('web/src/acceptance.test.tsx');
    // Maintenance: no test file is the learner's to write; the regression suite is supplied.
    const editable = phase('06-maintenance').checks.editableTargets ?? [];
    expect(editable.some((file) => /test/i.test(file))).toBe(false);
    expect(PHASE_MAKES.maintenance.join(' ')).not.toMatch(/^Tests that|write.*tests/i);
    expect(PHASE_MAKES.maintenance[1]).toBe('A green run of the regression suite you are given');
  });

  it('keeps every map string clear of the separators the copy lint refuses', () => {
    const strings = [...Object.values(PHASE_MAKES).flat(), ...PHASE_ORDER.map(gateSentence)];
    for (const text of strings) expect(text).not.toMatch(/[·|]/);
  });
});

describe('the map', () => {
  it('draws six phases on one line with their glyph, number, name, mentor and state in words', () => {
    const host = render(<PhaseMap nodes={mapNodes(null, PHASE_ORDER)} />);
    const nodes = host.querySelectorAll('.phase-map-node');
    expect(nodes).toHaveLength(6);
    PHASE_ORDER.forEach((key, i) => {
      const text = nodes[i].textContent ?? '';
      expect(text).toContain(`0${i + 1}`);
      expect(text).toContain(PHASE_NAMES[key]);
      expect(text).toContain(PHASE_EXPERIENCE[key].name);
      expect(text).toContain('Open');
      expect(nodes[i].querySelector('svg.phase-glyph')).not.toBeNull();
    });
    expect(host.querySelectorAll('.phase-map-gate')).toHaveLength(5);
    expect(panel(host).hidden).toBe(true);
  });

  it('opens each phase’s panel: what you make, the gate, the mentor read from the code, and its guide', () => {
    const host = render(<PhaseMap nodes={mapNodes(null, PHASE_ORDER)} />);
    for (const key of PHASE_ORDER) {
      act(() => nodeButton(host, key).click());
      const box = panel(host);
      expect(box.hidden).toBe(false);
      expect(nodeButton(host, key).getAttribute('aria-expanded')).toBe('true');
      expect(box.querySelector('h3')?.textContent).toContain(PHASE_NAMES[key]);
      expect([...box.querySelectorAll('dd ul li')].map((li) => li.textContent)).toEqual(PHASE_MAKES[key]);
      expect(box.querySelector('[data-testid="phase-map-gate"]')?.textContent).toBe(gateSentence(key));
      expect(box.querySelector('[data-testid="phase-map-gate"]')?.textContent).toContain(GATE_RULE);
      const mentor = PHASE_EXPERIENCE[key];
      expect(box.textContent).toContain(`${mentor.name}, ${mentor.role}. ${mentor.purpose}`);
      expect(box.querySelector('a')?.getAttribute('href')).toBe(`/learn/${key}`);
      // The catalogue card's one name form.
      expect(box.querySelector('a')?.getAttribute('aria-label')).toBe(`Open ${PHASE_NAMES[key]} guide`);
    }
    act(() => nodeButton(host, 'maintenance').click());
    expect(panel(host).hidden).toBe(true);
  });

  it('works by keyboard: buttons in the tab order, arrows, Home and End along the line, Escape back to the phase', () => {
    const host = render(<PhaseMap nodes={mapNodes(null, PHASE_ORDER)} />);
    const row = host.querySelector('.phase-map-row')!;
    for (const key of PHASE_ORDER) expect(nodeButton(host, key).getAttribute('type')).toBe('button');
    const press = (target: Element, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    nodeButton(host, 'requirements').focus();
    press(row, 'ArrowRight');
    expect(document.activeElement).toBe(nodeButton(host, 'design'));
    press(row, 'End');
    expect(document.activeElement).toBe(nodeButton(host, 'maintenance'));
    press(row, 'ArrowRight');
    expect(document.activeElement).toBe(nodeButton(host, 'maintenance'));
    press(row, 'Home');
    expect(document.activeElement).toBe(nodeButton(host, 'requirements'));
    press(row, 'ArrowLeft');
    expect(document.activeElement).toBe(nodeButton(host, 'requirements'));
    act(() => nodeButton(host, 'testing').click());
    press(panel(host).querySelector('h3')!, 'Escape');
    expect(panel(host).hidden).toBe(true);
    expect(document.activeElement).toBe(nodeButton(host, 'testing'));
  });

  /* Escape closes the panel from inside it, and from a phase tile or a
   * gate too. */
  it('closes the panel with Escape from a phase or a gate too, back on the open phase', () => {
    const host = render(<PhaseMap nodes={mapNodes(null, PHASE_ORDER)} />);
    const press = (target: Element, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    act(() => nodeButton(host, 'design').click());
    expect(panel(host).hidden).toBe(false);
    nodeButton(host, 'implementation').focus();
    press(nodeButton(host, 'implementation'), 'Escape');
    expect(panel(host).hidden).toBe(true);
    expect(nodeButton(host, 'design').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(nodeButton(host, 'design'));
    const gate = host.querySelectorAll<HTMLButtonElement>('.phase-map-gate')[1];
    act(() => gate.click());
    expect(panel(host).hidden).toBe(false);
    gate.focus();
    press(gate, 'Escape');
    expect(panel(host).hidden).toBe(true);
    expect(document.activeElement).toBe(nodeButton(host, 'design'));
    // With nothing open, Escape on a phase does nothing.
    press(nodeButton(host, 'testing'), 'Escape');
    expect(panel(host).hidden).toBe(true);
  });

  it('opens the same panel from a gate, at the gate', () => {
    const host = render(<PhaseMap nodes={mapNodes(null, PHASE_ORDER)} />);
    const gate = host.querySelectorAll<HTMLButtonElement>('.phase-map-gate')[3];
    expect(gate.getAttribute('aria-label')).toBe('The gate after Testing: every required check and criterion must pass');
    // The diamond draws no number: the gate is not a score.
    for (const each of host.querySelectorAll('.phase-map-gate')) expect(each.textContent).toBe('');
    act(() => gate.click());
    expect(gate.getAttribute('aria-expanded')).toBe('true');
    expect(panel(host).querySelector('h3')?.textContent).toContain('Testing');
    expect(document.activeElement).toBe(panel(host).querySelector('.phase-map-gate-row'));
  });

  it('gives a phase without a guide its reason and no guide link', () => {
    const enrollment = { phases: [summary('requirements', 1, 'in_progress', { scenario: 'own' } as Partial<PhaseSummary>)] };
    const host = render(<PhaseMap nodes={mapNodes(enrollment, [])} />);
    act(() => nodeButton(host, 'requirements').click());
    expect(panel(host).textContent).toContain('Your teacher wrote this phase. Your phase brief says what it asks of you.');
    expect(panel(host).querySelector('a')).toBeNull();
    expect(panel(host).textContent).not.toContain(PHASE_EXPERIENCE.requirements.purpose);
  });
});

describe('the catalogue page', () => {
  it('draws the map under the hero, with the guides’ links unchanged and the panel closed', () => {
    shell.enrollment = null;
    const host = render(<LearnPage />);
    const catalogue = host.querySelector('[data-testid="learn-catalogue"]')!;
    const map = catalogue.querySelector('[data-testid="phase-map"]')!;
    expect(map).not.toBeNull();
    expect(catalogue.querySelector('.learn-library-hero')!.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const guides = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter((href) => href?.startsWith('/learn/'));
    expect(guides.sort()).toEqual(PHASE_ORDER.map((key) => `/learn/${key}`).sort());
    expect(host.querySelector('[aria-label="Open Requirements guide"]')).not.toBeNull();
    expect(host.querySelectorAll('.learn-makes')).toHaveLength(6);
  });

  it('names a guide’s link one way on the page: the open map panel and the catalogue card both say "Open <Phase> guide"', () => {
    shell.enrollment = null;
    const host = render(<LearnPage />);
    for (const key of PHASE_ORDER) {
      act(() => nodeButton(host, key).click());
      const links = [...host.querySelectorAll<HTMLAnchorElement>(`a[href="/learn/${key}"]`)];
      expect(links.length, key).toBe(2);
      expect(links.some((a) => a.closest('[data-testid="phase-map"]'))).toBe(true);
      expect([...new Set(links.map((a) => a.getAttribute('aria-label')))]).toEqual([`Open ${PHASE_NAMES[key]} guide`]);
    }
  });

  it('draws "How LearnSDLC checks your work" after the map: one section, its heading once, opening on the first step', () => {
    shell.enrollment = null;
    const host = render(<LearnPage />);
    const sections = host.querySelectorAll('[data-testid="how-checks-work"]');
    expect(sections).toHaveLength(1);
    const section = sections[0];
    const map = host.querySelector('[data-testid="phase-map"]')!;
    expect(map.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const headings = [...host.querySelectorAll('h1, h2, h3, h4')].filter((h) => h.textContent === 'How LearnSDLC checks your work');
    expect(headings).toHaveLength(1);
    expect(headings[0].tagName).toBe('H2');
    expect(section.getAttribute('aria-labelledby')).toBe(headings[0].id);
    expect(section.textContent).toContain('Step 1 of 5');
    expect(section.textContent).toContain(HOW_CHECKS_STEPS[0].title);
    expect(section.textContent).toContain('The Deployment incident drill');
    expect(section.textContent).toContain('API_URL: http://localhost:8000');
  });
});

describe('the slot for "How LearnSDLC checks your work"', () => {
  it('draws nothing when no component is given, else its section and the component', () => {
    let host = render(<HowChecksWorkSlot component={null} />);
    expect(host.innerHTML).toBe('');
    cleanup?.();
    const Stub = () => <p data-testid="stub">Propose, explain, apply</p>;
    host = render(<HowChecksWorkSlot component={Stub} />);
    const section = host.querySelector('[data-testid="how-checks-work"]')!;
    expect(section.querySelector('h2')?.textContent).toBe('How LearnSDLC checks your work');
    expect(section.querySelector('[data-testid="stub"]')).not.toBeNull();
  });
});
