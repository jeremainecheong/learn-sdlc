// @vitest-environment jsdom
/**
 * The record an own Requirements room hands to the review.
 *
 * The Shelf fixture pack's Requirements is a story phase: the learner's story
 * is `requirements/story.json`, a serialised `Story`, and the review grades
 * that record. Check and Submit must hand the review exactly the record the
 * room last saved: every comma in the persona, period in the benefit,
 * parenthesis in the title, tag and epic, and a record the form did not
 * write (a mentor Apply) must be graded as it stands. No markdown file is
 * written anywhere on the way.
 *
 * This file mounts the real RequirementsWorkspace, on the shelf's own room,
 * and reads the record the room hands to the workspace save and to the review
 * on Check and on Submit. `request` and `fetch` are the seams stood in for, as
 * in task-rooms-wiring; the save queue is the real one.
 *
 * Probes (a)-(e) are five such inputs. The last case is a Requirements phase
 * with no story spec, which the room neither reads nor writes.
 */
import { repoFile } from './support/paths';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary, StoryChecksSpec } from '@learnsdlc/shared';
import { EMPTY_STORY, STORY_JSON, serialiseStory, type Story } from '@/components/workspace/panels/requirements/story';

/* ------------------------------- the fixtures ----------------------------- */

const PHASE_ID = 'fixreq-requirements';
/** The shelf's Requirements checks, read from the fixture pack: SH-5 is the learner's, SH-1 to SH-4 are provided. */
const SHELF_CHECKS = (JSON.parse(repoFile('apps/api/test/fixtures/upload-packs/shelf/phases/01-requirements/phase.json')) as { checks: StoryChecksSpec }).checks;
/** `PhaseDetail.story` as the API builds it from those checks. */
const SHELF_SPEC: NonNullable<PhaseDetail['story']> = {
  id: SHELF_CHECKS.learnerStory.id,
  hints: SHELF_CHECKS.learnerStory.hints,
  floor: SHELF_CHECKS.floor,
  providedStories: SHELF_CHECKS.providedStories,
};
/** The record the loader seeds for SH-5: the learner's id and nothing written. */
const SEEDED = serialiseStory({ ...EMPTY_STORY, id: 'SH-5' });
const FIRST_VERSION = '2026-10-02T04:00:00.000Z';
const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

const server = {
  files: {} as Record<string, string>,
  /** Whether the phase carries its story spec; without it the phase is an older markdown one. */
  spec: true,
  version: FIRST_VERSION,
  /** Every workspace write, in order: the files each one carried. */
  puts: [] as Record<string, string>[],
  /** `story.json` as the server held it when each review was started. */
  graded: [] as string[],
};

const OWN_PROVENANCE = (): PhaseProvenanceView => ({
  phaseKey: 'requirements', referenceName: null, rollup: 'own', intro: 'own', interview: null, files: [], tasks: [], roomTask: 'other',
} as PhaseProvenanceView);
const summary = (key: PhaseKey): PhaseSummary => ({
  id: key === 'requirements' ? PHASE_ID : `fixreq-${key}`, key, order: KEYS.indexOf(key) + 1, title: key[0].toUpperCase() + key.slice(1),
  status: key === 'requirements' ? 'in_progress' : 'locked', attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'own',
} as unknown as PhaseSummary);
const detail = () => ({
  ...summary('requirements'),
  projectSlug: 'shelf',
  workspaceUpdatedAt: server.version,
  files: [{ path: STORY_JSON, content: server.files[STORY_JSON] ?? '', editable: true, language: 'json' }],
  ...(server.spec ? { story: SHELF_SPEC } : {}),
  tasks: [],
  rubric: { passThreshold: 70, criteria: [] },
  objectives: [],
  intro: '',
  taskPanel: 'Write SH-5.',
  links: [],
  canRun: false,
  canPreview: false,
  runLabel: 'Run tests',
  lastSubmission: null,
  provenance: OWN_PROVENANCE(),
  stakeholder: null,
  solution: { available: false, files: 0, readAt: null },
});
let project: ReturnType<typeof buildProject>;
const buildProject = () => ({
  enrollment: {
    id: 'fixreq-enrolment', projectSlug: 'shelf', projectTitle: 'Shelf — a project', currentPhaseOrder: 1, completed: false,
    startedAt: '2026-10-02T00:00:00Z', completedAt: null, projectIsDefault: false, phases: KEYS.map(summary),
  },
  currentPhase: summary('requirements'),
  details: { [PHASE_ID]: detail() },
  analytics: null, loading: false, revalidating: false, error: '', reload: vi.fn(),
});

/* ------------------------------- the stand-ins ---------------------------- */

const rig = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), request: rig.request }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 'fixreq-requirements' }),
  usePathname: () => '/workspace/fixreq-requirements/issue',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
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
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => project,
  useProjectMaybe: () => project,
  invalidateProject: vi.fn(),
}));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
// The real control, plus a trigger for its `onReset`: the room's own answer to
// a finished reset is what the marks case below reads. The control itself
// offers nothing on this fixture's untasked phase.
vi.mock('@/components/workspace/TaskResetControl', async (original) => {
  const actual = await original<typeof import('@/components/workspace/TaskResetControl')>();
  return {
    ...actual,
    TaskResetControl: (props: Parameters<typeof actual.TaskResetControl>[0]) => <>
      <actual.TaskResetControl {...props} />
      <button type="button" data-testid="test-task-reset" hidden onClick={() => void props.onReset({ version: props.baseVersion() ?? '' } as never, { restores: [], reseeds: [] } as never)} />
    </>,
  };
});

import { RequirementsWorkspace } from '@/components/workspace/requirements/RequirementsWorkspace';
import { TOKEN_KEY } from '@/lib/session';
import { resetRecords } from '@/lib/records';
import { settle, stubMatchMedia } from './support/dom';

/* -------------------------------- the server ------------------------------ */

const nextVersion = () => new Date(Date.parse(server.version) + 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const serve = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  if (method === 'GET' && path === `/phases/${PHASE_ID}`) return detail();
  if (method === 'PUT' && path === `/phases/${PHASE_ID}/workspace`) {
    const sent = (body as { files?: Record<string, string> })?.files ?? {};
    server.puts.push({ ...sent });
    Object.assign(server.files, sent);
    server.version = nextVersion();
    return { saved: true, version: server.version };
  }
  if (method === 'POST' && path === `/phases/${PHASE_ID}/submit`) {
    server.graded.push(server.files[STORY_JSON] ?? '');
    return { id: `fixreq-revision-${server.graded.length}`, taskKey: null, status: 'completed', passed: false, score: null, attempt: server.graded.length, createdAt: '2026-10-02T04:10:00.000Z', report: null };
  }
  // The shelf's Requirements holds no interview; the hook still reads the shape.
  if (method === 'GET' && path === `/phases/${PHASE_ID}/interview`) return { persona: { name: 'Member', role: 'Member' }, turns: [], facts: [], factsExpected: [], turnsLeft: 0, closed: true };
  return [];
};
const serveFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = url.replace(/^.*\/api\/v1/, '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const answer = await serve(method, path, body);
  return new Response(JSON.stringify(answer ?? null), { status: 200, headers: { 'content-type': 'application/json' } });
};

/* ------------------------------- the harness ------------------------------ */

let host: HTMLDivElement;
let root: Root;
let tokens = 0;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  server.files = { [STORY_JSON]: SEEDED };
  server.spec = true;
  server.version = FIRST_VERSION;
  server.puts = [];
  server.graded = [];
  tokens += 1;
  window.localStorage.setItem(TOKEN_KEY, `fixreq-token-${tokens}`);
  rig.request.mockImplementation(serve);
  resetRecords();
  vi.stubGlobal('fetch', vi.fn(serveFetch));
  stubMatchMedia();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const open = async () => {
  project = buildProject();
  await act(async () => { root.render(<RequirementsWorkspace phaseId={PHASE_ID} />); });
  await settle();
};
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (pattern: RegExp, scope: ParentNode = host) => {
  const button = Array.from(scope.querySelectorAll('button')).find((one) => pattern.test((one.textContent ?? '').trim()));
  expect(button, String(pattern)).toBeDefined();
  await act(async () => button!.click());
};
const press = async (id: string) => {
  const button = byTestId(id) as HTMLButtonElement | null;
  expect(button, id).not.toBeNull();
  await act(async () => button!.click());
  await settle();
};
const setValue = async (node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null, value: string, event: 'input' | 'change' = 'input') => {
  expect(node).not.toBeNull();
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
    node!.dispatchEvent(new Event(event, { bubbles: true }));
  });
};
const type = (id: string, value: string) => setValue(byTestId(id) as HTMLInputElement | HTMLTextAreaElement | null, value);
const valueOf = (id: string) => (byTestId(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value;

interface Draft { title: string; persona: string; capability: string; benefit: string; criteria: Array<{ given: string; when: string; then: string; tag?: 'happy' | 'boundary' | 'error' }> }

/** Open the learner's own story, fill the form, press Save story. */
async function writeStory(draft: Draft, epic?: string) {
  await click(/^(Create your story|Edit your story)$/);
  await type('phase-requirements-title', draft.title);
  if (epic) await setValue(host.querySelector('select[aria-label="Parent epic"]'), epic, 'change');
  await type('phase-requirements-persona', draft.persona);
  await type('phase-requirements-capability', draft.capability);
  await type('phase-requirements-benefit', draft.benefit);
  for (const [i, c] of draft.criteria.entries()) {
    await click(/^Add a criterion$/);
    await type(`phase-requirements-criterion-${i + 1}-given`, c.given);
    await type(`phase-requirements-criterion-${i + 1}-when`, c.when);
    await type(`phase-requirements-criterion-${i + 1}-then`, c.then);
    if (c.tag) await setValue(byTestId(`phase-requirements-criterion-${i + 1}-tag`) as HTMLSelectElement, c.tag, 'change');
  }
  await click(/^Save story$/);
  await settle();
}

/** The story the form saves, as a record: what the review must read. */
const expected = (draft: Draft, epics?: Story['epics'], parentEpicId?: string): Story => ({
  ...EMPTY_STORY, id: 'SH-5', title: draft.title, persona: draft.persona, capability: draft.capability, benefit: draft.benefit,
  criteria: draft.criteria.map((c, i) => ({ id: `AC-${i + 1}`, given: c.given, when: c.when, then: c.then, tag: c.tag ?? 'happy' })),
  ...(epics ? { epics } : {}), ...(parentEpicId ? { parentEpicId } : {}),
});

/** Every record write the room made since `from`, then Check, then Submit. */
async function checkAndSubmit() {
  const fromCheck = server.puts.length;
  const checkEnabled = !(byTestId('phase-requirements-render') as HTMLButtonElement).disabled;
  await press('phase-requirements-render');
  const atCheck = server.files[STORY_JSON];
  const checkWrites = server.puts.slice(fromCheck).map((put) => put[STORY_JSON]).filter((text): text is string => text !== undefined);
  const fromSubmit = server.puts.length;
  await press('phase-requirements-submit');
  const submitWrites = server.puts.slice(fromSubmit).map((put) => put[STORY_JSON]).filter((text): text is string => text !== undefined);
  return { checkEnabled, atCheck, checkWrites, submitWrites, graded: server.graded.at(-1) };
}

/** No write the room made carried anything but the record. */
const onlyTheRecord = () => expect(server.puts.flatMap((put) => Object.keys(put)).filter((path) => path !== STORY_JSON)).toEqual([]);

/** The record the room last saved, read back. */
const saved = () => JSON.parse(server.files[STORY_JSON] ?? '{}') as Story;

const CAPABILITY = "to see which of an author's books are free to borrow right now";
const BENEFIT = 'I do not walk to the shelf for a book that is out';
const CRITERIA: Draft['criteria'] = [
  { given: 'an author with two books on the shelf', when: 'I ask for that author', then: 'both books are listed as free' },
  { given: 'an author whose only book is on loan', when: 'I ask for that author', then: 'no book is listed as free' },
];

/* ------------------------------- the probes ------------------------------- */

describe('a story room hands the review the record it holds', () => {
  it('(a) a persona with a comma: Save, then Check and Submit grade the record the form saved', async () => {
    const draft: Draft = { title: 'Free books by an author', persona: 'member, who borrows weekly', capability: CAPABILITY, benefit: BENEFIT, criteria: CRITERIA };
    await open();
    expect(byTestId('requirements-workspace')).not.toBeNull();
    await writeStory(draft);
    const out = await checkAndSubmit();
    expect(out.checkEnabled).toBe(true);
    // Check saves the record the form wrote; Submit grades exactly that.
    expect(saved()).toEqual(expected(draft));
    expect(out.atCheck).toBe(server.files[STORY_JSON]);
    expect(out.checkWrites.every((text) => text === out.atCheck)).toBe(true);
    expect(out.submitWrites.every((text) => text === out.atCheck)).toBe(true);
    expect(out.graded).toBe(out.atCheck);
    onlyTheRecord();
  });

  it('(b) a benefit with a period is graded whole, not cut at the period', async () => {
    const draft: Draft = { title: 'Free books by an author', persona: 'member', capability: CAPABILITY, benefit: 'I can borrow one today, e.g. before closing', criteria: CRITERIA };
    await open();
    await writeStory(draft);
    const out = await checkAndSubmit();
    expect((JSON.parse(out.graded ?? '{}') as Story).benefit).toBe('I can borrow one today, e.g. before closing');
    expect(JSON.parse(out.graded ?? '{}')).toEqual(expected(draft));
  });

  it('(c) a title with parentheses is kept in the graded record', async () => {
    const draft: Draft = { title: 'Free books by an author (available now)', persona: 'member', capability: CAPABILITY, benefit: BENEFIT, criteria: CRITERIA };
    await open();
    await writeStory(draft);
    const out = await checkAndSubmit();
    expect(out.atCheck).toBe(out.graded);
    expect((JSON.parse(out.graded ?? '{}') as Story).title).toBe('Free books by an author (available now)');
  });

  it('(d) a criterion tagged error/boundary and a new epic are kept: the epic reaches the graded record', async () => {
    await open();
    // A new epic, saved before the story names it as its parent.
    await click(/^Create your first epic$/);
    const form = host.querySelector('.jira-epic-form');
    expect(form).not.toBeNull();
    await setValue(form!.querySelector('input'), 'Find a book fast');
    await setValue(form!.querySelector('textarea'), 'Members find a free book without walking the shelves');
    await click(/^Save epic$/, form!);
    await settle();
    // The epic is still in the backlog after its Save.
    expect(host.querySelector('.jira-epic-list')?.textContent).toContain('Find a book fast');
    const draft: Draft = {
      title: 'Free books by an author', persona: 'member', capability: CAPABILITY, benefit: BENEFIT,
      criteria: [{ ...CRITERIA[0], tag: 'boundary' }, { ...CRITERIA[1], tag: 'error' }],
    };
    await writeStory(draft, 'EP-1');
    const epics = [{ id: 'EP-1', title: 'Find a book fast', outcome: 'Members find a free book without walking the shelves' }];
    // The form reads back what it saved: the tags and the parent epic.
    await click(/^Edit your story$/);
    expect(valueOf('phase-requirements-criterion-1-tag')).toBe('boundary');
    expect(valueOf('phase-requirements-criterion-2-tag')).toBe('error');
    expect((host.querySelector('select[aria-label="Parent epic"]') as HTMLSelectElement | null)?.value).toBe('EP-1');
    await click(/^Cancel$/);
    const out = await checkAndSubmit();
    expect(out.checkWrites.every((text) => text === out.atCheck)).toBe(true);
    expect(out.graded).toBe(out.atCheck);
    expect(JSON.parse(out.graded ?? '{}')).toEqual(expected(draft, epics, 'EP-1'));
    onlyTheRecord();
  });

  const APPLIED: Story = {
    ...EMPTY_STORY, id: 'SH-5', title: 'Free books by an author',
    persona: 'member', capability: CAPABILITY, benefit: BENEFIT,
    criteria: [
      { id: 'AC-1', given: 'an author with two books on the shelf', when: 'I ask for that author', then: 'both books are listed as free to borrow', tag: 'happy' },
      { id: 'AC-2', given: 'an author whose only book is on loan', when: 'I ask for that author', then: 'the book is listed as on loan and not free', tag: 'boundary' },
    ],
    scopeExclusions: ['reserving a book'],
  };
  // Written by something other than the form (a mentor Apply): indented
  // differently, so a re-serialisation would show.
  const APPLIED_TEXT = JSON.stringify(APPLIED);

  it('(e) a record the form did not write: Check and Submit hand it over byte for byte', async () => {
    server.files[STORY_JSON] = APPLIED_TEXT;
    await open();
    const out = await checkAndSubmit();
    expect(out.checkEnabled).toBe(true);
    expect(out.checkWrites).toEqual([]);
    expect(out.submitWrites).toEqual([]);
    expect(out.atCheck).toBe(APPLIED_TEXT);
    expect(out.graded).toBe(APPLIED_TEXT);
  });

  it('(e) the seeded record, untouched: Check stays off and Submit grades it as it stands', async () => {
    await open();
    const out = await checkAndSubmit();
    expect(out.checkEnabled).toBe(false);
    expect(out.checkWrites).toEqual([]);
    expect(out.submitWrites).toEqual([]);
    expect(out.graded).toBe(SEEDED);
  });

  it('(e) a record changed after the form\'s Save (a mentor Apply) is graded as it now stands', async () => {
    const draft: Draft = { title: 'Free books by an author', persona: 'member', capability: CAPABILITY, benefit: BENEFIT, criteria: CRITERIA };
    await open();
    await writeStory(draft);
    await press('phase-requirements-render');
    // The record moves on elsewhere; the learner comes back to the room, which
    // loads the phase afresh in the same tab.
    await act(async () => root.unmount());
    server.files[STORY_JSON] = APPLIED_TEXT;
    server.version = nextVersion();
    root = createRoot(host);
    await open();
    const fromSubmit = server.puts.length;
    await press('phase-requirements-submit');
    expect(server.puts.slice(fromSubmit).map((put) => put[STORY_JSON]).filter(Boolean)).toEqual([]);
    expect(server.graded.at(-1)).toBe(APPLIED_TEXT);
  });

  it('a task reset ends the marks of the fields an applied proposal changed', async () => {
    sessionStorage.setItem(`learnsdlc:touched:${PHASE_ID}`, JSON.stringify({ 'story/so-that': 'I catch what slipped' }));
    await open();
    await press('test-task-reset');
    expect(sessionStorage.getItem(`learnsdlc:touched:${PHASE_ID}`)).toBeNull();
  });

  it('a submit ends the marks of the fields an applied proposal changed', async () => {
    sessionStorage.setItem(`learnsdlc:touched:${PHASE_ID}`, JSON.stringify({ 'story/so-that': 'I catch what slipped' }));
    await open();
    await press('phase-requirements-submit');
    expect(server.graded).toHaveLength(1);
    expect(sessionStorage.getItem(`learnsdlc:touched:${PHASE_ID}`)).toBeNull();
  });
});

describe('a phase with no story spec is an older format the room does not touch', () => {
  it('one sentence in place of the form, and neither ⌘↵ nor ⌘⇧↵ saves, checks or submits', async () => {
    server.spec = false;
    await open();
    expect(byTestId('phase-requirements-older-format')?.textContent).toBe("This project's Requirements task is in an older format; its owner needs to re-save it.");
    expect(byTestId('phase-requirements-submit')).toBeNull();
    expect(byTestId('phase-requirements-render')).toBeNull();
    expect(host.querySelector('.jira-issue-desk')).toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true })); });
    await settle();
    expect(host.textContent).not.toContain('Saved your story');
    expect(server.graded).toEqual([]);
    expect(server.puts).toEqual([]);
  });
});
