// @vitest-environment jsdom
/**
 * The learner preview page a teacher opens.
 *
 * The banner is on every frame, and no Run, Check, Submit, Ask or mentor
 * control exists (by role and by test id). The phases arrive in order with
 * their gate sentences. The files are read-only: no writable input,
 * textarea or select, no contenteditable and no editor is mounted (the
 * runbook's read-only forms are let through). A fetch spy sees one request, the
 * preview GET, and nothing else. The learner's project store is never
 * mounted (`useProject` and `useProjectMaybe` are spies), and
 * no preview source imports a learner store. Axe (WCAG 2.0/2.1 A and AA,
 * colour contrast off: jsdom has no layout) finds nothing.
 *
 * Deployment carries a runbook and its starting record, so every rule above
 * also holds over the Runbook tab the preview draws read-only; Maintenance
 * carries a ticket and its starting change request, so they hold over the
 * change room's forms too.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAxe } from './support/axe-bridge';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseChangeRequest, serialiseRunbook, type LearnerPreviewView } from '@learnsdlc/shared';

const useProject = vi.fn();
const useProjectMaybe = vi.fn();
vi.mock('@/lib/useProject', () => ({ useProject: () => useProject(), useProjectMaybe: () => useProjectMaybe() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { LearnerPreview } from '@/components/staff/preview/LearnerPreview';
import { PREVIEW_BANNER } from '@/components/staff/preview/copy';
import { TOKEN_KEY } from '@/lib/session';
import { settle } from './support/dom';

const PHASES = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];

/** Deployment's starting record: an item in every list and an incident, so each kind of field the Runbook tab draws is drawn. */
const STARTING_RUNBOOK = serialiseRunbook({
  ...EMPTY_RUNBOOK,
  environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where the web app finds the API', kind: 'config' }],
  health: [{ id: 'H1', name: 'API health', how: 'curl /health', expected: 'ok' }],
  rollback: [{ id: 'R1', step: 'Redeploy the last tag', verify: 'The health URL answers ok' }],
  data: [{ id: 'D1', what: 'Loans', how: 'Nightly dump', where: 'The backups bucket' }],
  incident: { rootCause: 'The web app pointed at localhost', fix: 'Set API_URL', actionItem: 'Name the URL in the compose file' },
  notes: 'Kept by the team.',
});

/** Maintenance's ticket and starting record: an item in every list, so each kind of field the change room's forms draw is drawn. */
const TICKET = { id: 'CHG-1', title: 'Shelve by surname', summary: 'Readers find books by the author surname.', acceptance: [{ id: 'AC-1', line: 'The shelf sorts by surname.' }] };
const STARTING_CHANGE = serialiseChangeRequest({
  ...EMPTY_CHANGE_REQUEST,
  impact: { operations: ['listBooks'], screens: ['Shelf'], files: ['api/app.py'] },
  contract: [{ id: 'C1', method: 'GET', path: '/books', change: 'changed', why: 'Sorted by surname' }],
  tests: [{ id: 'T1', suite: 'tests/test_shelf.py', covers: ['AC-1'], result: 'pass' }],
  release: { version: '2.1.0', summary: 'Shelve by surname', changes: [{ id: 'L1', line: 'The shelf sorts by surname.', covers: ['AC-1'] }], rollback: 'Redeploy 2.0.0', risks: ['Old links'] },
  notes: 'Kept by the team.',
});

function view(): LearnerPreviewView {
  return {
    title: 'Shelf',
    version: '1.0.0',
    phases: PHASES.map((key, at) => ({
      key,
      order: at + 1,
      title: TITLES[at],
      intro: `The ${TITLES[at]} intro.`,
      objectives: [`Objective of ${TITLES[at]}`],
      brief: `${TITLES[at]} brief\n\nRead the stories.`,
      files: [
        { path: `${key}/mine.md`, content: `editable ${key} bytes`, editable: true, language: 'markdown' },
        { path: `${key}/given.md`, content: `locked ${key} bytes`, editable: false, language: 'markdown' },
        ...(key === 'deployment' ? [{ path: RUNBOOK_JSON, content: STARTING_RUNBOOK, editable: true, language: 'json' }] : []),
        ...(key === 'maintenance' ? [{ path: CHANGE_REQUEST_JSON, content: STARTING_CHANGE, editable: true, language: 'json' }] : []),
      ],
      ...(key === 'deployment'
        ? { runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 1, requireIncident: true }, drill: false } }
        : {}),
      ...(key === 'maintenance'
        ? { change: { ticket: TICKET, contract: true, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true } } }
        : {}),
      tasks: [
        { key: 'main', order: 1, required: true, title: `Do ${TITLES[at]}`, artefactType: 'document', evidence: at === 0 ? 'signed-off' : 'reviewed', needsSignOff: at === 0 },
      ],
      quizzes:
        key === 'design'
          ? [{ taskKey: 'design-check', title: 'Check the contract', drawn: 1, passMark: 80, questions: [{ id: 'q1', stem: 'Which verb lists books?', options: ['GET', 'POST'], multiple: false }] }]
          : [],
      interview: key === 'requirements' ? { persona: { name: 'Ines Moreau', role: 'circulation desk lead' }, opening: 'Ask me about the shelf.' } : null,
      canRun: key === 'implementation',
      runLabel: 'Run the tests',
      checkLabels: ['Story', 'Acceptance criteria'],
      gate: at === 0 ? 'Learners open this first.' : `Learners open this after every task in ${TITLES[at - 1]} has passed and, where a task needs it, has been signed off.`,
    })),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.setItem(TOKEN_KEY, 'teacher-token');
  fetchSpy = vi.fn(async () => new Response(JSON.stringify(view()), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});


async function mount() {
  await act(async () => {
    root?.render(<LearnerPreview projectId="p-1" versionId="v-1" />);
  });
  await settle();
}

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const CONTROL = /\b(run|check|submit|ask|mentor|hand in|start)\b/i;

describe('the learner preview page', () => {
  it('the banner is there before, during and after the load, and there is no Run, Check, Submit, Ask or mentor control', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    await act(async () => {
      root?.render(<LearnerPreview projectId="p-1" versionId="v-1" />);
    });
    expect(byId('preview-banner')?.textContent).toBe(PREVIEW_BANNER);
    expect(byId('preview-loading')).not.toBeNull();
    await act(async () => release(new Response(JSON.stringify(view()), { status: 200, headers: { 'content-type': 'application/json' } })));
    await settle();
    expect(byId('preview-banner')?.textContent).toBe(PREVIEW_BANNER);
    expect(byId('preview-banner-frame')?.className).toContain('sticky');
    const controls = [...document.querySelectorAll('button, [role="button"], input, select, textarea, form')];
    expect(controls.map((one) => one.textContent ?? '').filter((name) => CONTROL.test(name))).toEqual([]);
    expect(document.querySelectorAll('button, form, [role="button"]').length).toBe(0);
    const ids = [...document.querySelectorAll('[data-testid]')].map((one) => one.getAttribute('data-testid') as string);
    expect(ids.filter((id) => /(^|-)(run|check|submit|ask|mentor|chat|hand-in)(-|$)/.test(id) && !/^preview-(checks|quiz)-/.test(id) /* named after a phase key or a teacher's task key, never a control */)).toEqual([]);
  });

  it('the banner stays on a refusal too', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'no project with that id in your library' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    await mount();
    expect(byId('preview-banner')?.textContent).toBe(PREVIEW_BANNER);
    expect(byId('preview-error')).not.toBeNull();
  });

  it('the stepper holds the six phases in order, and each phase carries its gate sentence', async () => {
    await mount();
    const steps = [...(byId('preview-stepper')?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(steps).toEqual(TITLES.map((title, at) => `${at + 1}. ${title}`));
    const sections = [...document.querySelectorAll('[data-testid^="preview-phase-"]')].map((one) => one.getAttribute('data-testid'));
    expect(sections).toEqual(PHASES.map((key) => `preview-phase-${key}`));
    expect(byId('preview-gate-requirements')?.textContent).toBe('Learners open this first.');
    for (let at = 1; at < PHASES.length; at += 1) {
      const gate = byId(`preview-gate-${PHASES[at]}`)?.textContent ?? '';
      expect(gate).toContain(TITLES[at - 1]);
      expect(gate).toContain('signed off');
    }
    expect(byId('preview-interview-requirements')?.textContent).toContain('Ask me about the shelf.');
    expect(byId('preview-quiz-design-check')?.textContent).toContain('Which verb lists books?');
    expect(byId('preview-tasks-requirements')?.textContent).toContain('You sign this off');
  });

  it('the files, the runbook and the change request are shown read-only: no writable input, textarea or select, no contenteditable, no editor', async () => {
    await mount();
    expect(byId('preview-files-requirements')?.textContent).toContain('requirements/mine.md');
    expect(byId('preview-files-requirements')?.textContent).toContain('Learners edit this');
    // The Runbook tab's forms are drawn read-only (the negative control: they are there, and none takes typing).
    const runbook = byId('preview-runbook');
    expect((byId('runbook-environment-0-name') as HTMLTextAreaElement | null)?.value).toBe('API_URL');
    expect(runbook?.querySelectorAll('textarea, select').length).toBeGreaterThan(0);
    // So are the change room's (the same negative control), and its record is never listed as a file.
    expect(byId('change-ticket')?.textContent).toContain('CHG-1');
    expect((byId('change-amendment-0-path') as HTMLInputElement | null)?.value).toBe('/books');
    expect(byId('preview-change')?.querySelectorAll('input, textarea, select').length).toBeGreaterThan(0);
    expect(byId('preview-files-maintenance')?.textContent).not.toContain(CHANGE_REQUEST_JSON);
    // a readonly checkbox or radio still toggles, so only disabled holds those
    const writable = 'input:not([readonly]):not([disabled]), input[type="checkbox"]:not([disabled]), input[type="radio"]:not([disabled]), textarea:not([readonly]):not([disabled]), select:not([disabled])';
    expect(document.querySelectorAll(`${writable}, [contenteditable="true"], [contenteditable=""], .monaco-editor`).length).toBe(0);
    expect([...document.querySelectorAll('pre')].some((pre) => pre.textContent === 'editable requirements bytes')).toBe(true);
  });

  it('the page makes one request, the preview GET, and no learner or AI request', async () => {
    await mount();
    const calls = fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? 'GET' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toMatch(/\/api\/v1\/instructor\/projects\/p-1\/versions\/v-1\/learner-preview$/);
  });

  it('the learner project store is never mounted, and no preview source imports a learner store', async () => {
    await mount();
    expect(useProject).not.toHaveBeenCalled();
    expect(useProjectMaybe).not.toHaveBeenCalled();
    const web = resolve(__dirname, '..');
    const dir = join(web, 'components', 'staff', 'preview');
    // The Runbook tab and the change room's forms are the room components the preview draws
    // (`PreviewRunbook`, `PreviewChangeRoom`, read-only): they are let in by name, and every
    // module they reach (by a relative or `@/` import, a side-effect import or a dynamic
    // import) is held to the same rule below.
    const roomForms = new Set([
      '@/components/workspace/panels/deployment/RunbookTab',
      '@/components/workspace/panels/maintenance/ChangeForms',
    ]);
    // `from '…'`, `import '…'` and `import('…')`, in any quotes
    const specsOf = (text: string) => [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const reached = new Set<string>();
    const walk = (file: string) => {
      if (reached.has(file)) return;
      reached.add(file);
      for (const spec of specsOf(readFileSync(file, 'utf-8'))) {
        if (!/^(\.{1,2}\/|@\/)/.test(spec)) continue;
        const base = spec.startsWith('@/') ? join(web, spec.slice(2)) : resolve(dirname(file), spec);
        const found = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map((end) => base + end).find((one) => existsSync(one) && statSync(one).isFile());
        expect(found, `${file} imports ${spec}`).toBeDefined();
        walk(found as string);
      }
    };
    walk(join(web, 'components', 'workspace', 'panels', 'deployment', 'RunbookTab.tsx'));
    walk(join(web, 'components', 'workspace', 'panels', 'maintenance', 'ChangeForms.tsx'));
    const sources = [
      ...readdirSync(dir).map((name) => join(dir, name)),
      join(web, 'app', '(app)', 'teacher', 'projects', '[projectId]', 'versions', '[versionId]', 'preview', 'page.tsx'),
      ...reached,
    ];
    expect(sources.some((file) => file.endsWith(join('design', 'cells.tsx')))).toBe(true);
    for (const file of sources) {
      const text = readFileSync(file, 'utf-8');
      const imported = specsOf(text);
      expect(imported.filter((spec) => !roomForms.has(spec) && /useProject|^@\/components\/workspace\/|^@\/lib\/(api-workspace|api-mentor|api-lab|api-solution|project|view-as)$|caret-store|monaco/.test(spec))).toEqual([]);
      expect(text).not.toMatch(/\buseProject(Maybe)?\(/);
    }
  });

  it('axe: no WCAG 2.0/2.1 A or AA violation (colour contrast excepted: jsdom has no layout)', async () => {
    await mount();
    const axe = await loadAxe();
    const result = await axe.run(host as HTMLElement, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(result.violations.map((one) => `${one.id}: ${one.nodes.length}`)).toEqual([]);
  });
});
