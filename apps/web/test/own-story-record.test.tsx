// @vitest-environment jsdom
/**
 * The story an own Requirements room writes, and the backlog it lists.
 *
 * The Shelf fixture's Requirements phase is a story phase: the learner's story
 * is the record `requirements/story.json`, seeded under the pack's own id
 * SH-5, and the pack's supplied stories SH-1 to SH-4 arrive as
 * `PhaseDetail.story.providedStories`. Save writes the record under SH-5, the
 * form reads it back, Submit grades it, and no state of the walk says 'US-4':
 * the reference story's default id.
 *
 * The harness below is RequirementsWorkspace's own wiring, verbatim where it
 * matters: `useStoryFrom(files[STORY_JSON] ?? '', detail.story)`, `setStory`
 * writing `serialiseStory(next)` into `story.json` and nothing else, the
 * provided stories from the spec, and a save layer that drops a write to a
 * path the phase does not hold as editable (useVersionedWorkspaceSave.setFile).
 *
 * The GUARDS hold recorded file snapshots under `__snapshots__/`: TaskTrackr's
 * walk and its supplied story, the no-shell walk, and the story view over a set
 * of records.
 */
import { repoFile } from './support/paths';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary, StoryChecksSpec } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, LEARNER_PICKS } from '@learnsdlc/shared';

const mount = vi.hoisted(() => ({ project: null as unknown }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 'w3b-requirements' }),
  usePathname: () => '/workspace/w3b-requirements',
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
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => mount.project,
  useProjectMaybe: () => mount.project,
}));

import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { EMPTY_STORY, STORY_JSON, serialiseStory } from '@/components/workspace/panels/requirements/story';
import { storyView, useStoryFrom } from '@/components/workspace/panels/requirements/useStory';
import { jsonLines, namedMarkup } from './support/markup-snapshot';

type Spec = NonNullable<PhaseDetail['story']>;
/** The shelf's Requirements checks, read from the fixture pack. */
const SHELF_CHECKS = (JSON.parse(repoFile('apps/api/test/fixtures/upload-packs/shelf/phases/01-requirements/phase.json')) as { checks: StoryChecksSpec }).checks;
/** `PhaseDetail.story` as the API builds it from those checks. */
const SHELF_SPEC: Spec = { id: SHELF_CHECKS.learnerStory.id, hints: SHELF_CHECKS.learnerStory.hints, floor: SHELF_CHECKS.floor, providedStories: SHELF_CHECKS.providedStories };
/** The record the loader seeds for a fixed id: the id and nothing written. */
const seeded = (id: string) => serialiseStory({ ...EMPTY_STORY, id });
/** TaskTrackr's Requirements as a story phase: US-4 is the learner's, four stories are supplied. */
const TT_SPEC: Spec = {
  id: 'US-4', hints: { persona: 'team lead' }, floor: DEFAULT_STORY_FLOOR,
  providedStories: [
    { id: 'US-1', title: 'Add a task', persona: 'team member', capability: 'to add a task with a title and a due date', benefit: 'nothing is forgotten',
      criteria: [{ id: 'AC-1', given: 'a title and a due date', when: 'I add the task', then: 'it is listed as open', tag: 'happy' }] },
    { id: 'US-2', title: 'Complete a task', persona: 'team member', capability: 'to mark a task complete', benefit: 'the list shows what is left' },
    { id: 'US-3', title: 'Filter, search and order a list', persona: 'team member', capability: 'to filter, search and order the list', benefit: 'I find a task fast' },
    { id: 'US-5', title: 'See at a glance which tasks are late', persona: 'team lead', capability: 'to see late tasks marked on the list', benefit: 'I can chase them' },
  ],
};

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

function provenance(key: PhaseKey, over: Partial<PhaseProvenanceView> = {}): PhaseProvenanceView {
  return { phaseKey: key, referenceName: 'TaskTrackr', rollup: 'reference', intro: 'reference', interview: 'reference', files: [], tasks: [], roomTask: 'reference', ...over };
}
const OWN_REQUIREMENTS = () => provenance('requirements', { referenceName: null, rollup: 'own', intro: 'own', interview: null, roomTask: 'other' });
function summary(key: PhaseKey, scenario: PhaseSummary['scenario']): PhaseSummary {
  return {
    id: `w3b-${key}`, key, order: KEYS.indexOf(key) + 1, title: key[0].toUpperCase() + key.slice(1), status: key === 'requirements' ? 'in_progress' : 'locked',
    attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, ...(scenario ? { scenario } : {}),
  } as PhaseSummary;
}
function enrollment(title: string, scenario: PhaseSummary['scenario'], projectIsDefault: boolean): EnrollmentView {
  return {
    id: 'w3b-enrolment', projectSlug: projectIsDefault ? 'reference-slug' : 'shelf', projectTitle: `${title} — a project`, currentPhaseOrder: 1, completed: false,
    startedAt: '2026-10-02T00:00:00Z', completedAt: null, projectIsDefault, phases: KEYS.map((key) => summary(key, scenario)),
  } as unknown as EnrollmentView;
}
function heldDetail(key: PhaseKey, over: Record<string, unknown> = {}): PhaseDetail {
  return { ...summary(key, undefined), view: 'summary', intro: '', objectives: [], files: [], tasks: [], rubric: { passThreshold: 70, criteria: [] }, ...over } as unknown as PhaseDetail;
}
function shellState(enrol: EnrollmentView | null, details: PhaseDetail[] = []) {
  return {
    enrollment: enrol, currentPhase: enrol?.phases[0] ?? null, details: Object.fromEntries(details.map((one) => [one.id, one])),
    loading: false, revalidating: false, error: '', analytics: null, reload: () => Promise.resolve(),
  };
}
/** The Shelf fixture: an own application whose Requirements phase holds no interview. */
const OWN_SHELL = () => shellState(enrollment('Shelf', 'own', false), [heldDetail('requirements', { provenance: OWN_REQUIREMENTS(), stakeholder: null })]);
const TASKTRACKR_SHELL = () => shellState(enrollment('TaskTrackr', 'reference', true), [heldDetail('requirements', { provenance: provenance('requirements') })]);

let host: HTMLDivElement;
let root: Root;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  mount.project = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
});
const click = (pattern: RegExp, scope: ParentNode = host) => {
  const button = Array.from(scope.querySelectorAll('button')).find((one) => pattern.test((one.textContent ?? '').trim()));
  expect(button, String(pattern)).toBeDefined();
  act(() => button!.click());
};
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function type(id: string, value: string) {
  const node = byTestId(id) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(node, id).not.toBeNull();
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
    node!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const valueOf = (id: string) => (byTestId(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value;

/** What the harness exposes after each action. */
const room = { files: {} as Record<string, string>, submitted: [] as string[] };

/**
 * RequirementsWorkspace's story wiring around a real IssueDesk. `editable` is
 * the set of paths the phase holds as editable; a write to any other path is
 * dropped, as `useVersionedWorkspaceSave.setFile` drops it.
 */
function Room({ initial, editable, spec }: { initial: Record<string, string>; editable: string[]; spec: Spec }) {
  const [files, setFiles] = useState(initial);
  const [reviewOpen, setReviewOpen] = useState(false);
  room.files = files;
  const setFile = (path: string, text: string) => { if (editable.includes(path)) setFiles((prev) => ({ ...prev, [path]: text })); };
  const view = useStoryFrom(files[STORY_JSON] ?? '', spec);
  const submit = () => { room.submitted.push(files[STORY_JSON] ?? ''); };
  return (
    <IssueDesk
      phaseId="w3b-requirements" embedded active view={view} spec={spec} providedStories={spec.providedStories}
      projectTitle="Shelf" statusLabel="In progress" statusTone="accent" storyState="now" assignedTo="Ada"
      canRecord={view.canRecord && editable.includes(STORY_JSON)} setStory={(next) => setFile(STORY_JSON, serialiseStory(next))}
      reviewOpen={reviewOpen} onReviewOpenChange={setReviewOpen}
      footerRight={<button type="button" onClick={submit}>Submit for review</button>}
    />
  );
}

/** The learner's walk on a Requirements room: write a story, save, reopen, review, submit. */
function walk(): { states: string[]; reopened: Record<string, string | undefined>; afterSave: string } {
  const states: string[] = [host.innerHTML];
  click(/^(Create (US-4 |your )?story|Edit your story)$/);
  type('phase-requirements-title', 'Free books by an author');
  type('phase-requirements-persona', 'member');
  type('phase-requirements-capability', "to see which of an author's books are free to borrow right now");
  type('phase-requirements-benefit', 'I do not walk to the shelf for a book that is out');
  click(/^Add a criterion$/);
  type('phase-requirements-criterion-1-given', 'an author with two books on the shelf');
  type('phase-requirements-criterion-1-when', 'I ask for that author');
  type('phase-requirements-criterion-1-then', 'both books are listed as free');
  click(/^Add a criterion$/);
  type('phase-requirements-criterion-2-given', 'an author whose only book is on loan');
  type('phase-requirements-criterion-2-when', 'I ask for that author');
  type('phase-requirements-criterion-2-then', 'no book is listed as free');
  states.push(host.innerHTML);
  click(/^Save story$/);
  const afterSave = room.files[STORY_JSON] ?? '';
  states.push(host.innerHTML);
  click(/^(Edit your story|Create (US-4 |your )?story)$/);
  const reopened = {
    title: valueOf('phase-requirements-title'),
    persona: valueOf('phase-requirements-persona'),
    given1: valueOf('phase-requirements-criterion-1-given'),
    then2: valueOf('phase-requirements-criterion-2-then'),
  };
  states.push(host.innerHTML);
  click(/^Cancel$/);
  click(/^Review$/);
  states.push(host.innerHTML);
  click(/^Submit for review$/);
  states.push(host.innerHTML);
  return { states, reopened, afterSave };
}

describe('an own Requirements room writes its record', () => {
  it('Save writes the learner\'s story under SH-5, the form keeps it, and Submit grades it', () => {
    mount.project = OWN_SHELL();
    room.submitted = [];
    act(() => root.render(<Room spec={SHELF_SPEC} initial={{ [STORY_JSON]: seeded('SH-5') }} editable={[STORY_JSON]} />));
    const { states, reopened, afterSave } = walk();
    // The record the room writes is the learner's story, under the pack's own id.
    expect(JSON.parse(afterSave)).toEqual({
      ...EMPTY_STORY, id: 'SH-5', title: 'Free books by an author', persona: 'member',
      capability: "to see which of an author's books are free to borrow right now", benefit: 'I do not walk to the shelf for a book that is out',
      criteria: [
        { id: 'AC-1', given: 'an author with two books on the shelf', when: 'I ask for that author', then: 'both books are listed as free', tag: 'happy' },
        { id: 'AC-2', given: 'an author whose only book is on loan', when: 'I ask for that author', then: 'no book is listed as free', tag: 'happy' },
      ],
    });
    // The form reads it back: nothing the learner wrote reverts.
    expect(reopened).toEqual({
      title: 'Free books by an author',
      persona: 'member',
      given1: 'an author with two books on the shelf',
      then2: 'no book is listed as free',
    });
    // Submit grades what the learner saved, and only the record was ever written.
    expect(room.submitted).toEqual([afterSave]);
    expect(Object.keys(room.files)).toEqual([STORY_JSON]);
    // No state of the walk says 'US-4', the Review view's evidence included,
    // and none of them carries a markdown dump.
    for (const markup of states) expect(markup).not.toContain('US-4');
    for (const markup of states) expect(markup).not.toContain('my-story.md');
    expect(states[4]).toContain('data-testid="phase-requirements-story-card"');
    expect(states[4]).toContain('SH-5');
    expect(states[4]).toContain('Free books by an author');
    expect(states[4]).toContain("As a member, I want to see which of an author's books are free to borrow right now, so that I do not walk to the shelf for a book that is out.");
    expect(states[4]).toContain('data-testid="phase-requirements-floor"');
  });

  it('the form opens on the seeded record under SH-5, with no notice about a missing record', () => {
    mount.project = OWN_SHELL();
    act(() => root.render(<Room spec={SHELF_SPEC} initial={{ [STORY_JSON]: seeded('SH-5') }} editable={[STORY_JSON]} />));
    click(/^Create your story$/);
    expect(byTestId('phase-requirements-no-record')).toBeNull();
    expect(byTestId('phase-requirements-story-id')).toBeNull();
    expect(valueOf('phase-requirements-title')).toBe('');
    expect(host.innerHTML).toContain('aria-label="Edit story SH-5"');
  });

  it('where the learner picks the id, the id is a field and the record carries what they typed', () => {
    mount.project = OWN_SHELL();
    act(() => root.render(<Room spec={{ ...SHELF_SPEC, id: LEARNER_PICKS }} initial={{ [STORY_JSON]: seeded('') }} editable={[STORY_JSON]} />));
    click(/^Create your story$/);
    expect(valueOf('phase-requirements-story-id')).toBe('');
    type('phase-requirements-story-id', 'SH-9');
    type('phase-requirements-title', 'Reserve a book');
    click(/^Save story$/);
    expect(JSON.parse(room.files[STORY_JSON] ?? '{}')).toMatchObject({ id: 'SH-9', title: 'Reserve a book' });
  });

  it('the view reads the seeded record and a saved one under the phase\'s id', () => {
    const scaffold = storyView(seeded('SH-5'), SHELF_SPEC);
    expect(scaffold.story.id).toBe('SH-5');
    expect(scaffold.story.title).toBe('');
    expect(scaffold.started).toBe(false);
    expect(scaffold.results.map((r) => [r.id, r.passed])).toEqual([
      ['story.record', true], ['story.sentence', false], ['story.criteria.min', false], ['story.criteria.tags', false], ['story.scope.min', false],
    ]);
    const saved = serialiseStory({ ...EMPTY_STORY, id: 'SH-5', title: 'T', persona: 'member', capability: 'x', benefit: 'y', criteria: [{ id: 'AC-1', given: 'a', when: 'b', then: 'c', tag: 'happy' }, { id: 'AC-2', given: 'd', when: 'e', then: 'f', tag: 'boundary' }], scopeExclusions: ['z'], notes: 'Why?' });
    const back = storyView(saved, SHELF_SPEC);
    expect(back.story).toMatchObject({ id: 'SH-5', title: 'T', persona: 'member', capability: 'x', benefit: 'y', scopeExclusions: ['z'], notes: 'Why?' });
    expect(back.started).toBe(true);
    expect(back.results.every((r) => r.passed)).toBe(true);
  });
});

describe('an own room lists its supplied stories', () => {
  it('the shelf\'s SH-1 to SH-4 are listed beside the learner\'s own SH-5, and open read-only with their criteria', () => {
    expect(SHELF_SPEC.providedStories.map((one) => one.id)).toEqual(['SH-1', 'SH-2', 'SH-3', 'SH-4']);
    mount.project = OWN_SHELL();
    act(() => root.render(<Room spec={SHELF_SPEC} initial={{ [STORY_JSON]: seeded('SH-5') }} editable={[STORY_JSON]} />));
    expect(host.querySelector('.jira-epic-list')?.textContent).toContain('All stories 5');
    const rows = Array.from(host.querySelectorAll('.jira-issue-row code')).map((one) => one.textContent);
    expect(rows).toEqual(['SH-1', 'SH-2', 'SH-3', 'SH-4', 'SH-5']);
    click(/^SH-1Browse the shelf/);
    expect(host.querySelector('dialog[aria-label="SH-1: Browse the shelf"]')).not.toBeNull();
    const story = host.querySelector('.jira-provided-issue')?.textContent ?? '';
    expect(story).toContain('As a member, I want to see every book in shelf order, so that I can find one without asking.');
    expect(story).toContain('Given books with different titles, when I open the shelf, then they are listed by title.');
    expect(story).not.toContain('Lend a book');
    expect(host.querySelector('.jira-provided-issue input, .jira-provided-issue textarea')).toBeNull();
  });
});

/** The names of the six renders `walk` takes, in its order. */
const WALK_STATES = ['the room opened', 'the story typed', 'saved', 'the story reopened', 'the Review view', 'submitted'];
/** A walk as one snapshot file: each render's markup, then what the walk read back, wrote and submitted. */
const walkPrint = (walked: ReturnType<typeof walk>) =>
  namedMarkup(walked.states.map((html, i) => [WALK_STATES[i] ?? `render ${i + 1}`, html] as const))
  + jsonLines({ reopened: walked.reopened, afterSave: walked.afterSave, files: room.files, submitted: room.submitted });

describe('TaskTrackr and the no-shell room match their snapshots', () => {
  it('the story view over the seeded record, a written one, a broken one, an empty buffer and no spec', async () => {
    const record = serialiseStory({ ...EMPTY_STORY, title: 'Overdue', persona: 'manager', capability: 'a report', benefit: 'I act', criteria: [{ id: 'AC-1', given: 'a', when: 'b', then: 'c', tag: 'boundary' }] });
    const inputs: Array<[string, Spec | undefined]> = [
      [seeded('US-4'), TT_SPEC],
      [record, TT_SPEC],
      [record, SHELF_SPEC],
      ['', TT_SPEC],
      ['{broken', SHELF_SPEC],
      [record, { ...SHELF_SPEC, id: LEARNER_PICKS }],
      [record, undefined],
    ];
    await expect(jsonLines(inputs.map(([json, spec]) => storyView(json, spec)))).toMatchFileSnapshot('__snapshots__/story-view-records.json');
  });

  it('the TaskTrackr room\'s walk, record for record and state for state', async () => {
    mount.project = TASKTRACKR_SHELL();
    room.submitted = [];
    act(() => root.render(<Room spec={TT_SPEC} initial={{ [STORY_JSON]: seeded('US-4') }} editable={[STORY_JSON]} />));
    const walked = walk();
    expect(JSON.parse(walked.afterSave)).toMatchObject({ id: 'US-4', title: 'Free books by an author' });
    expect(walked.states).toHaveLength(WALK_STATES.length);
    await expect(walkPrint(walked)).toMatchFileSnapshot('__snapshots__/tasktrackr-story-walk.html');
  });

  it('a TaskTrackr supplied story opens as its snapshot holds', async () => {
    mount.project = TASKTRACKR_SHELL();
    act(() => root.render(<Room spec={TT_SPEC} initial={{ [STORY_JSON]: seeded('US-4') }} editable={[STORY_JSON]} />));
    const before = host.innerHTML;
    click(/^US-1/);
    await expect(namedMarkup([['the room opened', before], ['US-1 opened', host.innerHTML]]))
      .toMatchFileSnapshot('__snapshots__/tasktrackr-supplied-story.html');
  });

  it('with no shell, the room walks as its snapshot holds', async () => {
    mount.project = null;
    room.submitted = [];
    act(() => root.render(<Room spec={TT_SPEC} initial={{ [STORY_JSON]: seeded('US-4') }} editable={[STORY_JSON]} />));
    const walked = walk();
    expect(walked.states).toHaveLength(WALK_STATES.length);
    await expect(walkPrint(walked)).toMatchFileSnapshot('__snapshots__/story-walk-no-shell.html');
  });
});
