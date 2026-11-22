// @vitest-environment jsdom
/**
 * Every text a teacher wrote is drawn as plain text, in one component (spec
 * 6.1, 6.3).
 *
 * `PlainText` draws paragraphs at blank lines, keeps every line break and each
 * line's leading whitespace, wraps long words, hides HTML comments once per
 * display path and interprets nothing. The cases after its own are one per
 * surface that reads a teacher's text: each draws `**kept**` as the asterisks a
 * learner reads, keeps a brief's two paragraphs and its indented lines, and
 * builds no `.prose-docs`, which is where `Markdown` would have drawn them.
 * Model output (the mentor, the persona, Agentic replies) and the teacher guide
 * keep `Markdown` (decision 10), so nothing here asks about them.
 */
import { REPO_ROOT, webPath } from './support/paths';
import { act, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plainTextOf, withoutHtmlComments } from '@learnsdlc/shared';
import type { DraftPhaseView, DraftTaskView, LearnerPreviewView, PhaseKey, PhaseTaskView, QuizReport } from '@learnsdlc/shared';

/* ------------------------------ the scenario ------------------------------ */

const PHASE_ID = 'phase-plain';
const VERSION = '2026-10-17T09:00:00.000Z';
const ORDER: Record<string, number> = { requirements: 1, design: 2, implementation: 3, testing: 4, deployment: 5, maintenance: 6 };
const ARTEFACT: Record<string, string> = { requirements: 'user-story', design: 'design', implementation: 'code', testing: 'tests', deployment: 'config', maintenance: 'code' };
const KIND: Record<string, string> = { requirements: 'story', design: 'design', implementation: 'code', testing: 'tests', deployment: 'config', maintenance: 'code' };

/**
 * A brief as the API serves it to a learner: plain (it already went through
 * `learnerText`), two paragraphs, the second indented code, and a pair of
 * asterisks `Markdown` would have read as emphasis.
 */
const SERVED = 'Read the **shelf** first.\nThen run the tests.\n\n    def day(offset):\n        return offset';
const SERVED_FIRST = 'Read the **shelf** first.\nThen run the tests.';
const SERVED_SECOND = '    def day(offset):\n        return offset';

const scenario = {
  key: 'implementation' as PhaseKey,
  /** `application: null` (a teacher's own application) when false; the reference's when true. */
  reference: false,
  /** Two code tasks on Implementation, the second with its own brief. */
  split: false,
  /** What the phase detail's `taskPanel` holds. */
  taskPanel: SERVED,
  /** The quiz or concept room's answers. */
  quizView: null as Record<string, unknown> | null,
  quizReport: null as QuizReport | null,
  preview: null as LearnerPreviewView | null,
};

const task = (over: Partial<PhaseTaskView> & { key: string; order: number }): PhaseTaskView =>
  taskView({ artefactType: ARTEFACT[scenario.key] as PhaseTaskView['artefactType'], evidence: 'automated', ...over });

const buildDetail = () => {
  const key = scenario.key;
  const file = key === 'testing' ? 'tests/test_acceptance.py' : key === 'deployment' ? 'deploy/compose.yml' : 'src/shelf.py';
  const tasks = scenario.split
    ? [
        task({ key: 'main', order: 1, title: 'The shelf', primaryPath: file, artefactPath: file, brief: 'The phase task.', objectives: [] } as never),
        task({ key: 'lend', order: 2, title: 'Lend a book', primaryPath: file, artefactPath: file, brief: SERVED, objectives: ['Lend one book.'] } as never),
      ]
    : [task({ key: '', order: 1, title: key, primaryPath: file, artefactPath: file })];
  return {
    id: PHASE_ID,
    key,
    order: ORDER[key],
    place: ORDER[key],
    count: 6,
    title: key[0].toUpperCase() + key.slice(1),
    intro: 'What learners read first.',
    status: 'in_progress',
    projectSlug: 'shelf',
    artifactKind: KIND[key],
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    workspaceUpdatedAt: VERSION,
    updatedAt: VERSION,
    files: [{ path: file, content: 'print(1)\n', editable: true, language: key === 'deployment' ? 'yaml' : 'python' }],
    tasks,
    taskCounts: { total: tasks.length, required: tasks.length, passed: 0, passedRequired: 0 },
    rubric: { passThreshold: 70, criteria: [{ key: 'works', title: 'It works', weight: 100, description: 'The checks pass.' }] },
    objectives: ['Make it work.'],
    taskPanel: scenario.taskPanel,
    links: [],
    drill: null,
    runClock: null,
    canRun: true,
    canPreview: false,
    runLabel: 'Run tests',
    lastSubmission: null,
    solution: { available: false, files: 0, readAt: null },
    provenance: {
      phaseKey: key,
      referenceName: 'TaskTrackr',
      rollup: 'own',
      intro: 'own',
      interview: null,
      files: [],
      tasks: [{ taskKey: '', provenance: 'edited', titleEdited: false }],
      roomTask: 'other',
      application: scenario.reference ? { name: 'TaskTrackr' } : null,
    },
    stakeholder: null,
    opensAt: null,
    dueAt: null,
  };
};

const summary = () => ({
  id: PHASE_ID,
  key: scenario.key,
  order: ORDER[scenario.key],
  title: scenario.key[0].toUpperCase() + scenario.key.slice(1),
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
  scenario: 'own',
  intro: 'What learners read first.',
});

const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const rig = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
  request: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  const read = () => `${window.location.pathname}?${window.location.search}`;
  return {
    useRouter: () => rig.router,
    useParams: () => ({ phaseId: PHASE_ID }),
    usePathname: () => {
      useSyncExternalStore(subscribe, read, read);
      return window.location.pathname;
    },
    useSearchParams: () => {
      useSyncExternalStore(subscribe, read, read);
      return new URLSearchParams(window.location.search);
    },
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Ada Example' }),
  getSession: () => ({ id: 'learner-one', role: 'LEARNER', displayName: 'Ada Example' }),
}));
let project: ReturnType<typeof buildProject>;
const buildProject = () => ({
  enrollment: {
    id: 'enrolment-one',
    projectTitle: 'Shelf',
    projectSlug: 'shelf',
    projectIsDefault: false,
    currentPhaseOrder: ORDER[scenario.key],
    completed: false,
    phases: [summary()],
    releases: [],
  },
  currentPhase: summary(),
  details: { [PHASE_ID]: wire(buildDetail()) },
  analytics: null,
  loading: false,
  error: '',
  reload: vi.fn(),
});
vi.mock('@/lib/useProject', async (original) => {
  const actual = await original<typeof import('@/lib/useProject')>();
  return { ...actual, useProject: () => project, useProjectMaybe: () => project, invalidateProject: vi.fn() };
});
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Code" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn(), start: vi.fn() }),
  stopPreviewOnExit: vi.fn(),
}));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));

import { PlainText } from '@/components/PlainText';
import Layout from '@/app/(app)/workspace/[phaseId]/layout';
import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { QuizPaper } from '@/components/workspace/quiz/QuizPaper';
import { QuizResult } from '@/components/workspace/quiz/QuizResult';
import { QuizRoom } from '@/components/workspace/quiz/QuizRoom';
import { ConceptRoom } from '@/components/workspace/concept/ConceptRoom';
import { LearnerPreview } from '@/components/staff/preview/LearnerPreview';
import { BriefCard } from '@/components/staff/projects/BriefCard';
import { briefSummary } from '@/components/staff/projects/PhaseTasks';
import { collectCriteria } from '@/components/workspace/panels/testing/lib';
import { ApiError } from '@/lib/api';
import { TOKEN_KEY } from '@/lib/session';
import { resetRecords } from '@/lib/records';
import { taskView } from './fixtures';
import { stubMatchMedia } from './support/dom';

const serve = async (method: string, apiPath: string): Promise<unknown> => {
  if (method === 'GET' && apiPath === `/phases/${PHASE_ID}`) return wire(buildDetail());
  // No stakeholder: the Requirements room holds no interview.
  if (method === 'GET' && apiPath === `/phases/${PHASE_ID}/interview`) throw new ApiError(404, 'This phase has no interview.');
  if (method === 'GET' && /^\/phases\/[^/]+\/tasks\/[^/]+\/quiz$/.test(apiPath)) return scenario.quizView;
  if (method === 'GET' && apiPath === '/submissions/s1')
    return { id: 's1', status: 'completed', score: 50, passed: false, createdAt: VERSION, report: { quiz: scenario.quizReport } };
  if (method === 'GET' && apiPath.endsWith('/learner-preview')) return scenario.preview;
  if (method === 'PUT' && apiPath === `/phases/${PHASE_ID}/workspace`) return { saved: true, version: VERSION };
  return [];
};
const serveFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const apiPath = url.replace(/^.*\/api\/v1/, '').replace(/\?.*$/, '');
  const answer = await serve((init?.method ?? 'GET').toUpperCase(), apiPath);
  return new Response(JSON.stringify(answer ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
};

let host: HTMLDivElement;
let root: Root;
let tokens = 0;

const settle = async (rounds = 30) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const draw = async (node: ReactNode, url = '/') => {
  project = buildProject();
  window.history.replaceState(null, '', url);
  await act(async () => {
    root.render(node);
  });
  await settle();
};

const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const paragraphsOf = (el: Element | null) => [...(el?.querySelectorAll('p') ?? [])].map((p) => p.textContent);

/** What every surface owes a served brief: two paragraphs as written, the indentation kept, nothing interpreted. */
function expectPlain(el: Element | null) {
  expect(el, 'the surface is drawn').not.toBeNull();
  expect(paragraphsOf(el!.querySelector('.plain-text'))).toEqual([SERVED_FIRST, SERVED_SECOND]);
  expect(el!.querySelector('.plain-text :is(strong, em, pre, code)')).toBeNull();
  expect(el!.querySelector('.prose-docs')).toBeNull();
}

/** A surface's type: the size it is set at, and the 1.65 line height `Markdown`'s `.prose-docs` gives every one of them. */
function expectType(el: Element | null, size: string) {
  const classes = (el?.className ?? '').split(/\s+/);
  expect(classes, 'the text is set at its surface size').toContain(`text-[${size}]`);
  expect(classes, 'the text keeps the 1.65 line height').toContain('leading-[1.65]');
}

beforeEach(() => {
  vi.clearAllMocks();
  scenario.key = 'implementation';
  scenario.reference = false;
  scenario.split = false;
  scenario.taskPanel = SERVED;
  scenario.quizView = null;
  scenario.quizReport = null;
  scenario.preview = null;
  tokens += 1;
  window.localStorage.setItem(TOKEN_KEY, `learner-token-${tokens}`);
  rig.request.mockImplementation((method: string, apiPath: string) => serve(method, apiPath));
  resetRecords();
  vi.stubGlobal('fetch', vi.fn(serveFetch));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true, writable: true });
  stubMatchMedia();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------------ the component ------------------------------ */

function render(text: string, extra: { commentsHidden?: boolean } = {}): HTMLElement {
  act(() => root.render(<PlainText text={text} testId="pt" {...extra} />));
  return host.querySelector('[data-testid="pt"]') as HTMLElement;
}

describe('PlainText (spec 6.3)', () => {
  it('draws paragraphs at blank lines and keeps line breaks and indentation', () => {
    const el = render('First line\nsecond line\n\n    def day(offset):\n        return offset');
    const paragraphs = el.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe('First line\nsecond line');
    expect(paragraphs[1].textContent).toBe('    def day(offset):\n        return offset');
    expect(getComputedStyle(paragraphs[1]).whiteSpace).toBe('pre-wrap');
    expect(getComputedStyle(paragraphs[1]).overflowWrap).toBe('anywhere');
  });
  it('shows no HTML comment', () => {
    expect(render('Before.\n\n<!-- for the teacher -->\n\nAfter.').textContent).not.toContain('for the teacher');
  });
  it('draws a CRLF brief as two paragraphs (Review Focus 3)', () => {
    const el = render('One\r\nline two\r\n\r\nTwo');
    expect(paragraphsOf(el)).toEqual(['One\nline two', 'Two']);
  });
  it('splits paragraphs at a lone CR as it does at CRLF and LF (m6)', () => {
    expect(paragraphsOf(render('One\r\rTwo'))).toEqual(['One', 'Two']);
    expect(paragraphsOf(render('One\rline two\r \t\r\r    Two'))).toEqual(['One\nline two', '    Two']);
  });
  it('interprets nothing', () => {
    const el = render('**bold** and <b>tag</b>');
    expect(el.querySelector('strong, b')).toBeNull();
    expect(el.textContent).toBe('**bold** and <b>tag</b>');
  });
  it('shows a code span and a fenced block as they are kept, backticks and fence lines as plain characters', () => {
    const el = render('Call `__init__` first.\n\n```sh\n# install\n```');
    expect(el.querySelector('code, pre')).toBeNull();
    expect(el.querySelectorAll('p')[1].textContent).toBe('```sh\n# install\n```');
  });
  it("splits at a run of blank lines, a line of only spaces among them, without eating the next line's indentation", () => {
    const el = render('Intro.\n\n  \t\n\n    indented()\n  also');
    expect(paragraphsOf(el)).toEqual(['Intro.', '    indented()\n  also']);
  });
  it('draws nothing for a text that is only blank lines or only a comment', () => {
    expect(render('\n  \n\n').querySelectorAll('p')).toHaveLength(0);
    expect(render('<!-- only the teacher reads this -->').querySelectorAll('p')).toHaveLength(0);
  });
  it('removes no comment from a text the API already displayed, so a text gets one display per path (Task 3: the display is not idempotent)', () => {
    // A served text holds no comment the API's display removed; one it kept was code by that reading, and a second display must not take it.
    const kept = '```a <!-- x`y --> b\n````\n<!-- c -->';
    expect(render(kept, { commentsHidden: true }).textContent).toBe(kept);
    expect(render('Before. <!-- kept as served -->', { commentsHidden: true }).textContent).toBe('Before. <!-- kept as served -->');
  });
});

/* ------------------------------- the surfaces ------------------------------ */

describe('every surface that reads a teacher\'s text draws it through PlainText', () => {
  it("the Requirements room's full brief", async () => {
    scenario.key = 'requirements';
    await draw(<Layout><WorkspacePage /></Layout>, `/workspace/${PHASE_ID}`);
    expectPlain(q('.requirements-full-brief'));
    // Set at the aside's 12px, as the case file around it is (I2), and the room's rule reads the plain text, not the gone `.prose-docs`.
    expectType(q('.requirements-full-brief .plain-text'), '12px');
    const css = readFileSync(webPath('components/workspace/requirements/requirements-workspace.css'), 'utf8');
    expect(css).toContain('.requirements-full-brief .plain-text{');
    expect(css).not.toContain('.requirements-full-brief .prose-docs');
  });

  it("the split task's brief", async () => {
    scenario.key = 'implementation';
    scenario.split = true;
    await draw(<Layout><WorkspacePage /></Layout>, `/workspace/${PHASE_ID}?task=lend`);
    expectPlain(q('[data-testid="task-brief"]'));
    // The phase's own brief stands down for a task it is not about.
    expect(q('[data-testid="phase-brief"]')).toBeNull();
  });

  for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as const) {
    it(`the IDE's "The brief" section for ${key}`, async () => {
      scenario.key = key;
      await draw(<Layout><WorkspacePage /></Layout>, `/workspace/${PHASE_ID}`);
      expect(host.querySelectorAll('[data-testid="phase-brief"]')).toHaveLength(1);
      const section = q('[data-testid="phase-brief"]');
      expect(section?.querySelector('h3')?.textContent).toBe('The brief');
      expectPlain(section);
      expectType(section?.querySelector('.plain-text') ?? null, '13px');
    });
  }

  it(`the IDE's "The brief" section beside TaskTrackr's five-task panel on the reference application`, async () => {
    scenario.key = 'implementation';
    scenario.reference = true;
    await draw(<Layout><WorkspacePage /></Layout>, `/workspace/${PHASE_ID}`);
    expectPlain(q('[data-testid="phase-brief"]'));
    // Open, the block scrolls inside half the column and does not grow over the five-task panel (I3).
    const block = q('[data-testid="phase-brief"]')?.closest('.phase-task-content');
    expect(block?.className.split(/\s+/)).toEqual(expect.arrayContaining(['phase-task-content', 'max-h-[50%]', 'shrink-0']));
  });

  it("a teacher's own intro beside TaskTrackr's five-task panel, where no intro card stands, is read once, in the case file's fold", async () => {
    scenario.key = 'implementation';
    scenario.reference = true;
    await draw(<Layout><WorkspacePage /></Layout>, `/workspace/${PHASE_ID}`);
    const panel = q('[data-workspace-panel="brief"]');
    expect(panel?.querySelector('[data-testid="phase-brief-own-intro"]')).toBeNull();
    expect(panel?.querySelector('[data-testid="phase-mission-mission"]')?.textContent).toContain('What learners read first.');
    expect((panel?.textContent ?? '').split('What learners read first.').length - 1).toBe(1);
  });

  // Folded under the name and at the size Requirements gives its brief.
  it("the design room's brief, in Requirements' fold", async () => {
    scenario.key = 'design';
    const { default: DesignPage } = await import('@/app/(app)/workspace/[phaseId]/design/page');
    await draw(<Layout><DesignPage /></Layout>, `/workspace/${PHASE_ID}/design`);
    const section = q('[data-testid="phase-brief"]');
    expect(section?.tagName).toBe('DETAILS');
    expect(section?.querySelector('summary')?.textContent).toBe('Full project brief and deliverables');
    expectPlain(section);
    expectType(section?.querySelector('.plain-text') ?? null, '12px');
    // One fold, as Requirements has: the mission and the review criteria are inside it, not a second fold (C-reqdesign-2)
    const aside = q('[data-workspace-panel="brief"]');
    expect([...(aside?.querySelectorAll('details') ?? [])].map((fold) => fold.querySelector('summary')?.textContent)).toEqual(['Full project brief and deliverables']);
    const mission = section?.querySelector('[data-testid="phase-mission"]');
    expect(mission?.tagName).toBe('DIV');
    expect(mission?.querySelector('[data-testid="phase-mission-review"]')).not.toBeNull();
    expect(aside?.textContent).not.toContain('Mission and review criteria');
  });

  it("the Learner preview's brief", async () => {
    scenario.preview = {
      title: 'Shelf',
      version: '1.0.0',
      phases: [
        {
          key: 'implementation',
          order: 1,
          title: 'Implementation',
          intro: 'What learners read first.',
          objectives: [],
          brief: SERVED,
          files: [],
          tasks: [],
          quizzes: [],
          interview: null,
          canRun: true,
          runLabel: 'Run tests',
          checkLabels: [],
          gate: 'Learners open this first.',
        },
      ],
    } as unknown as LearnerPreviewView;
    await draw(<LearnerPreview projectId="p-1" versionId="v-1" />);
    expectPlain(q('[data-testid="preview-brief-implementation"]'));
  });

  it("the Learner preview's intro, objectives, quiz stems and options", async () => {
    scenario.preview = {
      title: 'Shelf',
      version: '1.0.0',
      phases: [
        {
          key: 'testing',
          order: 1,
          title: 'Testing',
          intro: SERVED,
          objectives: [SERVED, 'Name **one** edge'],
          brief: '',
          files: [],
          tasks: [],
          quizzes: [{ taskKey: 'check', title: 'Check', drawn: 1, passMark: 60, questions: [{ id: 'q1', stem: SERVED, options: [SERVED, 'The middle'] }] }],
          interview: null,
          canRun: true,
          runLabel: 'Run tests',
          checkLabels: [],
          gate: 'Learners open this first.',
        },
      ],
    } as unknown as LearnerPreviewView;
    await draw(<LearnerPreview projectId="p-1" versionId="v-1" />);
    expectPlain(q('[data-testid="preview-intro-testing"]'));
    const objectives = [...(q('[data-testid="preview-objectives-testing"]')?.querySelectorAll('li') ?? [])];
    expect(objectives).toHaveLength(2);
    expectPlain(objectives[0]);
    expect(paragraphsOf(objectives[1].querySelector('.plain-text'))).toEqual(['Name **one** edge']);
    expectPlain(q('[data-testid="preview-stem-q1"]'));
    const options = [...(q('[data-testid="preview-options-q1"]')?.querySelectorAll('li') ?? [])];
    expect(options).toHaveLength(2);
    expectPlain(options[0]);
    expect(paragraphsOf(options[1].querySelector('.plain-text'))).toEqual(['The middle']);
  });

  it("the quiz room's brief", async () => {
    scenario.quizView = {
      taskKey: 'check',
      title: 'Check',
      brief: SERVED,
      required: false,
      status: 'in_progress',
      drawn: 1,
      passMark: 60,
      attemptsUsed: 0,
      attemptsLeft: 3,
      cooldownSecondsLeft: null,
      bestScore: null,
      lastSubmissionId: null,
      paper: null,
    };
    await draw(<QuizRoom phaseId={PHASE_ID} taskKey="check" />);
    expectPlain(q('[data-testid="quiz-header"]'));
    expectType(q('[data-testid="quiz-header"] .plain-text'), '13px');
  });

  const question = { id: 'q1', stem: SERVED, options: [{ id: 'o1', text: 'The **edge**\nof it' }, { id: 'o2', text: 'The middle' }], multiple: false };

  it("a paper's stem and options", async () => {
    await draw(
      <QuizPaper paper={{ attemptId: 'a1', startedAt: VERSION, questions: [question] }} answers={{}} onChange={() => {}} onHandIn={() => {}} busy={false} />,
    );
    expectPlain(host);
    expect(host.textContent).toContain('The **edge**');
    const texts = [...host.querySelectorAll('.plain-text')];
    expect(texts.length).toBeGreaterThanOrEqual(3);
    expectType(texts[0], '13.5px');
    for (const option of texts.slice(1)) expectType(option, '13px');
  });

  /**
   * A served explanation (I1): every report reaches the web through `learnerText` once, at read (`toView`,
   * `historyRevision`, `conceptSubmissionView`), so this is already plain with its comments displayed. It still holds
   * `<!-- start` inside a fenced block, which that one display kept as code; a second `withoutHtmlComments` would read
   * the first line as a fence opener and take everything from `<!-- start` to `-->`, words the learner should read.
   */
  const SERVED_EXPLANATION = '```a  b\n\n```\n<!-- start\n```\n\nVisible words the teacher wrote -->\n\nEnd.';
  const SERVED_EXPLANATION_PARAGRAPHS = ['```a  b', '```\n<!-- start\n```', 'Visible words the teacher wrote -->', 'End.'];

  const marked = (): QuizReport => ({
    correctCount: 0,
    drawn: 1,
    passMark: 60,
    attempt: 1,
    attemptsLeft: 2,
    questions: [
      {
        ...question,
        selected: ['o1'],
        outcome: 'wrong',
        explanation: SERVED_EXPLANATION,
        concept: 'Boundaries',
      },
    ],
  });

  /** A served report drawn as served: the stem's two paragraphs, the options and every word of the explanation, nothing taken a second time, at its sizes with the 1.65 line height. */
  function expectServedReport(el: Element | null) {
    // The case only proves something because a second display would take words here.
    expect(withoutHtmlComments(SERVED_EXPLANATION)).not.toBe(SERVED_EXPLANATION);
    const texts = [...(el?.querySelectorAll('.plain-text') ?? [])];
    expect(paragraphsOf(texts[0])).toEqual([SERVED_FIRST, SERVED_SECOND]);
    expect(el?.querySelector('strong, pre, code, .prose-docs')).toBeNull();
    expect(el?.textContent).toContain('The **edge**\nof it');
    expect(paragraphsOf(texts[texts.length - 1])).toEqual(SERVED_EXPLANATION_PARAGRAPHS);
    expectType(texts[0], '13.5px');
    for (const rest of texts.slice(1)) expectType(rest, '13px');
  }

  it("a marked paper's stem, options and explanation, drawn as the API served them (one display per path)", async () => {
    await draw(<QuizResult report={marked()} passed={false} />);
    expectServedReport(host);
  });

  it('the concept room', async () => {
    scenario.quizView = {
      taskKey: 'concept-after',
      title: 'Quick check',
      brief: '',
      required: false,
      status: 'passed',
      drawn: 1,
      passMark: 0,
      attemptsUsed: 1,
      attemptsLeft: null,
      cooldownSecondsLeft: null,
      bestScore: 0,
      lastSubmissionId: 's1',
      paper: null,
    };
    scenario.quizReport = marked();
    await draw(<ConceptRoom phaseId={PHASE_ID} kind="after" backHref="/workspace" />);
    expectServedReport(q('[data-testid="concept-result"]'));
  });

  it("the builders' read-only brief and background: two lines stay two lines", async () => {
    const phase = { key: 'deployment', title: 'Deployment', intro: 'Ship it.\nThen watch it.', provenance: null } as unknown as DraftPhaseView;
    const draftTask = {
      taskKey: 'main',
      order: 1,
      required: true,
      title: 'Ship the shelf',
      brief: 'Write the runbook.\nKeep it **short**.\n\n<!-- read in the editor only -->',
      artefactType: 'config',
      artefactPath: null,
      checkKind: 'config',
      rubric: { passThreshold: 70, criteria: [] },
      objectives: ['One'],
      owns: [],
      authorable: false,
      notice: null,
    } as unknown as DraftTaskView;
    await draw(
      <BriefCard
        projectId="p-1"
        versionId="v-1"
        phase={phase}
        task={draftTask}
        writeTask={async () => ({}) as never}
        editable={false}
        taskEditable={false}
        state="current"
        onFocusCard={() => {}}
        onSaved={() => {}}
        oldFile={null}
        testId="brief"
      />,
    );
    const texts = [...host.querySelectorAll('.plain-text')];
    expect(texts.map((one) => paragraphsOf(one))).toEqual([['Ship it.\nThen watch it.'], ['Write the runbook.\nKeep it **short**.']]);
    expect(host.textContent).not.toContain('read in the editor only');
    // A label holds phrasing content and labels a control: a read-only row is a div around its paragraphs.
    expect(host.querySelector('label .plain-text')).toBeNull();
    expect(texts.map((one) => one.parentElement?.tagName)).toEqual(['DIV', 'DIV']);
    expect(texts.every((one) => one.parentElement?.classList.contains('tre-labelled'))).toBe(true);
  });
});

/* --------------------------- the readers of a brief ------------------------- */

describe('the readers of a plain brief', () => {
  it('PhaseTasks summarises a plain brief by its first line', () => {
    expect(briefSummary('Write US-4, the overdue report story.\nThen hand it in.')).toBe('Write US-4, the overdue report story.');
    expect(briefSummary('\n  \n  Plain first line.  \nSecond.')).toBe('Plain first line.');
    // A plain list keeps its marker and its number, as plain text writes them.
    expect(briefSummary('- Name the actor\n- Then the goal')).toBe('- Name the actor');
    expect(briefSummary('1. Open the file')).toBe('1. Open the file');
    expect(briefSummary('')).toBe('');
  });

  const frozen = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/api/test/fixtures/plain-text-5.0.0.json'), 'utf8')) as Record<string, Record<string, string>>;

  it('the testing harvest finds US-3/AC-2 and US-5/AC-2 in the 5.0.0 Testing brief read as plain text', () => {
    const brief = plainTextOf(frozen['content/tasktrackr/phases/04-testing'].brief);
    const ids = collectCriteria([], [], [], brief, { reference: true }).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['US-3/AC-2', 'US-5/AC-2']));
  });

  it("the testing harvest reads an own brief's story lines once plain text has taken their # and stars", () => {
    const asides = 'Target ES-6 syntax. The API-1 note and the COVID-19 opening hours do not change.';
    const headed = `## US-1 Find a book by author\n- **AC-1** — Given a shelf, when I filter by author, then only that author's books show.\n\n## US-2 Lend a book\n\n${asides}`;
    const plain = plainTextOf(headed);
    expect(plain).not.toBe(headed);
    const ids = (brief: string) => collectCriteria([], [], [], brief, { reference: false }).map((c) => c.id);
    expect(ids(plain)).toEqual(ids(headed));
    expect(ids(plain)).toEqual(['US-1/AC-1', 'US-2']);
    const titled = collectCriteria([], [], [], plain, { reference: false }).find((c) => c.id === 'US-1/AC-1');
    expect(titled?.title).toBe("Only that author's books show");
  });

  it("the testing harvest offers the version's own story prefix from a plain brief, SH-n on a Shelf, and never a stray id-shaped line such as ID-7 or PR-2 (the harvest ruling)", () => {
    const brief = [
      'SH-1 Find a book by author',
      '- AC-1 Given a shelf, when I filter by author, then only that author\'s books show.',
      'ID-7 is the ticket this came from, and PR-2 the pull request.',
      'SH-3 Return a book',
      'US-4 is not a story of this project.',
      'Then SH-2 and SH-4 are in scope.',
    ].join('\n');
    const ids = collectCriteria([], [], [], brief, { reference: false, prefixes: ['SH'] }).map((c) => c.id);
    expect(ids).toEqual(['SH-1/AC-1', 'SH-2', 'SH-3', 'SH-4']);
    // the same brief on a version whose stories are US-n offers only US-4
    expect(collectCriteria([], [], [], brief, { reference: false, prefixes: ['US'] }).map((c) => c.id)).toEqual(['US-4']);
  });

  it("the testing harvest offers only US-n stories and their AC-n criteria from an own application's plain brief, never another id-shaped line", () => {
    // Every line here opens with an id-shaped token, as a plain brief's story line does once its ## is gone.
    const brief = [
      'SH-1 Find a book by author',
      '- AC-1 Given a shelf, when I filter by author, then only that author\'s books show.',
      'API-1 returns the shelf as JSON, and API-2 lends a book.',
      'ES-6 modules are fine.',
      'US-3 Return a book',
      '- AC-2 Given a book on loan, when I return it, then it is on the shelf again.',
      'Then SH-2, CR-4 and US-4 are in scope.',
    ].join('\n');
    const ids = collectCriteria([], [], [], brief, { reference: false }).map((c) => c.id);
    expect(ids).toEqual(['US-3/AC-2', 'US-4']);
  });
});
