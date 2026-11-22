/**
 * @vitest-environment jsdom
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The project store the whole signed-in app reads from.
 *
 * The provider itself is a React component and is walked by the Playwright
 * suite; what is here is the part that decides what a learner is *told* and
 * what survives an invalidation, which is where its bugs have been. The
 * records cache is stubbed so the two invalidation paths can be told apart:
 * "this is a phase behind" keeps what it holds, and "this is somebody else's
 * work" throws it away.
 */

const staleRecords = vi.fn();
const resetRecords = vi.fn();
/** What each phase's revisions are read under, told once per project load. */
const rememberTaskScopes = vi.fn();

vi.mock('@/lib/records', () => ({ staleRecords, resetRecords, rememberTaskScopes }));

type UseProject = typeof import('@/lib/useProject');
type Api = typeof import('@/lib/api');
type Active = typeof import('@/lib/project');

let project: UseProject;
let api: Api;
let active: Active;

beforeEach(async () => {
  staleRecords.mockReset();
  resetRecords.mockReset();
  window.localStorage.clear();
  vi.resetModules();
  api = await import('@/lib/api');
  active = await import('@/lib/project');
  project = await import('@/lib/useProject');
});

describe('learnerMessage', () => {
  it('replaces a 5xx with the sentence that fits what the learner was doing', () => {
    const err = new api.ApiError(503, 'request failed (503)');
    expect(project.learnerMessage(err, 'Your work could not be loaded.')).toBe(
      'Your work could not be loaded.',
    );
  });

  it('keeps the reference support can search for', () => {
    const err = new api.ApiError(500, 'boom (reference req-7)', 'req-7');
    expect(project.learnerMessage(err, 'Your work could not be loaded.')).toBe(
      'Your work could not be loaded. Reference req-7.',
    );
  });

  it('passes a 4xx through, because it names something the learner can change', () => {
    const err = new api.ApiError(409, 'already enrolled in this project');
    expect(project.learnerMessage(err, 'Could not start.')).toBe('already enrolled in this project');
  });

  it('names a dead connection rather than the thing they were doing', () => {
    expect(project.learnerMessage(new TypeError('Failed to fetch'), 'Could not start.')).toBe(
      "Can't reach the server. Check your connection and try again.",
    );
  });

  it('falls back for anything with no story of its own', () => {
    expect(project.learnerMessage(new Error('who knows'), 'Could not start.')).toBe(
      'Could not start.',
    );
  });
});

describe('invalidation', () => {
  it('marks the records stale without emptying them, after a run or a submission', () => {
    project.invalidateProject();
    expect(staleRecords).toHaveBeenCalledTimes(1);
    expect(resetRecords).not.toHaveBeenCalled();
  });

  it('throws them away for a different project or a different learner', () => {
    project.resetProject();
    expect(resetRecords).toHaveBeenCalledTimes(1);
    expect(staleRecords).not.toHaveBeenCalled();
  });
});

describe('how long a copy is used', () => {
  it('is a minute, the same window the records cache uses', () => {
    expect(project.FRESH_MS).toBe(60_000);
  });
});

/**
 * Which project the browser is looking at.
 *
 * Neither a preference in `localStorage` nor a slug literal can survive
 * teacher-authored projects: a remembered slug can name a project this
 * deployment does not ship, and a literal names the wrong project for every
 * learner whose class was assigned another one. So it is neither: it is the
 * slug the **server** resolved, remembered for the tab, written by whoever
 * loaded a project and read by the three places that need the answer without
 * waiting for a request.
 *
 * The functions keep stable names and signatures because many call sites
 * read them.
 */
describe('the project the browser is looking at', () => {
  it('is nothing at all until the server has named one', () => {
    // Not a slug this deployment might not ship, and not a literal: an empty
    // answer, which every reader already guards on. A slug a two-pack browser
    // left behind is not read back either.
    window.localStorage.setItem('lsdlc_project', 'other-pack');
    expect(active.getActiveProject()).toBe('');
  });

  it('is the slug the server resolved, once a load has named it', () => {
    active.setActiveProject('atlas');
    expect(active.getActiveProject()).toBe('atlas');
  });

  it('never persists it, so a stale tab cannot ask for a retired project', () => {
    active.setActiveProject('atlas');
    expect(window.localStorage.getItem('lsdlc_project')).toBeNull();
    // Nor under any other key: nothing about the project reaches storage.
    const stored = Object.keys(window.localStorage).map((key) =>
      window.localStorage.getItem(key),
    );
    expect(stored).not.toContain('atlas');
  });
});

/**
 * The first load, which is the one a learner waits for.
 *
 * The loader must not ask the catalogue and then fan out (one `myEnrollment`
 * per catalogue entry, gathered with `allSettled`) which is an N+1 that
 * grows with every pack. The catalogue in the first case has two entries
 * **only so that a fan-out would be visible**: what is being pinned is that
 * the loader asks about one project, not that the product ships two.
 */
describe('the first load', () => {
  const meta = (slug: string) => ({ slug, title: slug, phaseTitles: [] }) as never;

  it('asks the catalogue once and one enrolment once, rather than one per catalogue entry', async () => {
    const projects = vi
      .spyOn(api.api, 'projects')
      .mockResolvedValue([meta('tasktrackr'), meta('other-pack')]);
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(null as never);

    const data = await project.fetchProject();

    expect(projects).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledTimes(1);
    // With no project named, the enrolment is asked for with no slug at all, so
    // the server's own four-step resolution runs, rather than being asked for
    // by a name the browser chose.
    expect(mine.mock.calls[0][0]).toBeUndefined();
    // Two requests for a first load, whatever the catalogue holds, and no
    // project decided by whichever one it lists first. A learner the server
    // says has started nothing is on no project until the server starts one.
    expect(data.slug).toBe('');
  });

  it('says the learner has started nothing when the API says there is no enrolment', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('tasktrackr')]);
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(null as never);
    const analytics = vi.spyOn(api.api, 'analyticsMe');

    const data = await project.fetchProject();

    expect(data.enrollment).toBeNull();
    expect(data.enrolledSlugs).toEqual([]);
    // Nothing is asked about a project that has not been started.
    expect(analytics).not.toHaveBeenCalled();
  });

  it('loads the enrolment, the analytics and a summary of every phase that is not locked', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('tasktrackr')]);
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [
        { id: 'p1', status: 'in_progress' },
        { id: 'p2', status: 'locked' },
      ],
    } as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue({ minutes: 12 } as never);
    const phase = vi.spyOn(api.api, 'phase').mockResolvedValue({ id: 'p1' } as never);
    const summaryOf = vi
      .spyOn(api.api, 'phaseSummary')
      .mockResolvedValue({ id: 'p1', view: 'summary' } as never);
    // Every open phase in one request rather than one each, so drawing a
    // signed-in page does not ask the same question six times.
    const summaries = vi
      .spyOn(api.api, 'phaseSummaries')
      .mockResolvedValue([{ id: 'p1', view: 'summary' }] as never);
    const map = vi.spyOn(api.api, 'projectMap').mockResolvedValue({ nodes: [], edges: [] } as never);

    const data = await project.fetchProject();

    expect(data.enrolledSlugs).toEqual(['tasktrackr']);
    expect(data.analytics).toEqual({ minutes: 12 });
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveBeenCalledWith('tasktrackr');
    expect(summaryOf).not.toHaveBeenCalled();
    expect(data.details.p1).toEqual({ id: 'p1', view: 'summary' });
    // Fetching the whole workspace of every open phase would cost far more
    // than the landing budget (e2e/render-cost.spec.ts) for a learner a few
    // phases in. The shell holds the index and nothing here asks for a file
    // body.
    expect(phase).not.toHaveBeenCalled();
    // And the map comes down built, folded, in the same pass, so Home's card is
    // in the page's first commit rather than a round trip behind it.
    expect(map).toHaveBeenCalledTimes(1);
    expect(map).toHaveBeenCalledWith('tasktrackr', { compact: true, showLocked: true });
    expect(data.map).toEqual({ nodes: [], edges: [] });
  });

  /**
   * What each phase's revisions are read under, told before anything reads them.
   *
   * The record cache is asked for a phase's revisions by three paths that hold
   * no task list (the dossier's bulk fill, the refresh after a verdict, Home's
   * idle prefetch) and the phase-wide route is refused with 400 on a phase a
   * teacher has split. This is the one pass that knows the answer for every
   * phase, opened or not, so it is the one that says it.
   */
  it('tells the record cache what every phase of the project holds', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('tasktrackr')]);
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [{ id: 'p1', status: 'in_progress' }],
    } as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    vi.spyOn(api.api, 'projectMap').mockResolvedValue(null as never);
    const split = [{ key: 'main' }, { key: 'reminder-story' }];
    vi.spyOn(api.api, 'phaseSummaries').mockResolvedValue([
      { id: 'p1', view: 'summary', tasks: split },
      { id: 'p2', view: 'summary', tasks: [{ key: 'main' }] },
    ] as never);

    await project.fetchProject();

    expect(rememberTaskScopes).toHaveBeenCalledTimes(1);
    expect(rememberTaskScopes.mock.calls[0][0]).toEqual([
      { id: 'p1', view: 'summary', tasks: split },
      { id: 'p2', view: 'summary', tasks: [{ key: 'main' }] },
    ]);
  });

  it('refuses to call a failed request a first-run learner', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('tasktrackr')]);
    vi.spyOn(api.api, 'myEnrollment').mockRejectedValue(new api.ApiError(503, 'request failed (503)'));

    await expect(project.fetchProject()).rejects.toThrow('request failed (503)');
  });

  it('treats a project the API does not know as one the learner has not started', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('tasktrackr')]);
    vi.spyOn(api.api, 'myEnrollment').mockRejectedValue(new api.ApiError(404, 'unknown project'));

    const data = await project.fetchProject();

    expect(data.enrollment).toBeNull();
    expect(data.enrolledSlugs).toEqual([]);
  });
});

/**
 * The shell holds a file index for every open phase, and
 * the IDE cannot open on an index: seeding an editor from one would draw an
 * open file with nothing in it, and then autosave over the learner's work with
 * the empty string it was seeded with. `fullDetail` is the guard.
 */
describe('what the workspace may seed from', () => {
  const withFiles = { id: 'p1', files: [{ path: 'a.py', content: 'x = 1\n' }] } as never;

  it('is a phase the shell holds whole', () => {
    expect(project.fullDetail({ p1: withFiles }, 'p1')).toBe(withFiles);
    // A body without `view` is a whole phase too.
    const old = { id: 'p1', files: [] } as never;
    expect(project.fullDetail({ p1: old }, 'p1')).toBe(old);
  });

  it('is never the index, which carries paths and no bodies', () => {
    const index = { id: 'p1', view: 'summary', files: [{ path: 'a.py', content: '' }] } as never;
    expect(project.fullDetail({ p1: index }, 'p1')).toBeUndefined();
  });

  it('is nothing for a phase the shell has not loaded', () => {
    expect(project.fullDetail({}, 'p1')).toBeUndefined();
  });
});

/**
 * The cheap refresh. Landing runs the full pass; coming back to the tab a
 * minute later must not run it again: the catalogue, the enrolment, the
 * analytics and the full detail of every open phase. `refreshProject` is what
 * the focus handler runs instead, and the catalogue it holds is passed through
 * rather than asked for again.
 */
describe('the sixty-second focus refresh', () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    status: 'in_progress',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...over,
  });
  const held = (over: Record<string, unknown> = {}) => ({
    projects: [{ slug: 'tasktrackr' }] as never,
    enrolledSlugs: ['tasktrackr'],
    slug: 'tasktrackr',
    enrollment: { id: 'e1', projectSlug: 'tasktrackr', phases: [summary()] } as never,
    analytics: null,
    details: { p1: { ...summary(), view: 'summary', files: [{ path: 'a.py' }] } as never },
    map: { nodes: [], edges: [] } as never,
    ...over,
  });

  it('asks for the enrolment and the analytics, and nothing else, when nothing has moved', async () => {
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [summary()],
    } as never);
    const analytics = vi.spyOn(api.api, 'analyticsMe').mockResolvedValue({ minutes: 12 } as never);
    const phase = vi.spyOn(api.api, 'phase').mockResolvedValue({} as never);
    const summaryOf = vi.spyOn(api.api, 'phaseSummary').mockResolvedValue({} as never);
    const map = vi.spyOn(api.api, 'projectMap').mockResolvedValue({ nodes: [], edges: [] } as never);
    const projects = vi.spyOn(api.api, 'projects').mockResolvedValue([] as never);

    const next = await project.refreshProject(held() as never);

    expect(mine).toHaveBeenCalledTimes(1);
    expect(analytics).toHaveBeenCalledTimes(1);
    // The two the full pass would repeat for nothing.
    expect(phase).not.toHaveBeenCalled();
    expect(summaryOf).not.toHaveBeenCalled();
    expect(projects).not.toHaveBeenCalled();
    // The map is drawn from those same phases, so a board that has not moved is
    // a map that has not moved either. Two requests, still.
    expect(map).not.toHaveBeenCalled();
    // And the picture is whole: the heavy half is the copy already held, the
    // summary fields come from the enrolment that was just fetched.
    expect((next.details.p1 as never as { files: unknown[] }).files).toHaveLength(1);
    expect(next.projects).toHaveLength(1);
    expect(next.analytics).toEqual({ minutes: 12 });
  });

  /**
   * The cheap refresh re-reads phase details too, and a
   * phase a teacher split after the first load (or a split phase first loaded
   * here) must reach the record cache, or its revisions are asked for on the
   * phase-wide route the API refuses on a split phase.
   */
  it('tells the record cache what every phase it holds is split into', async () => {
    const split = [{ key: 'main' }, { key: 'reminder-story' }];
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [summary({ tasksUpdatedAt: '2026-09-20T10:00:00.000Z' })],
    } as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    vi.spyOn(api.api, 'phaseSummary').mockResolvedValue({
      ...summary({ tasksUpdatedAt: '2026-09-20T10:00:00.000Z' }),
      view: 'summary',
      tasks: split,
    } as never);
    vi.spyOn(api.api, 'projectMap').mockResolvedValue(null as never);
    rememberTaskScopes.mockClear();

    const next = await project.refreshProject(held() as never);

    expect(rememberTaskScopes).toHaveBeenCalledTimes(1);
    expect(rememberTaskScopes.mock.calls[0][0]).toEqual(Object.values(next.details));
    expect((rememberTaskScopes.mock.calls[0][0] as { tasks?: unknown }[])[0].tasks).toEqual(split);
  });

  it('refetches the summary and the map of a phase the enrolment says has moved', async () => {
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [summary({ status: 'passed', bestScore: 88, attempts: 1 })],
    } as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    const summaryOf = vi.spyOn(api.api, 'phaseSummary').mockResolvedValue({
      ...summary({ status: 'passed' }),
      view: 'summary',
      files: [{ path: 'a.py' }, { path: 'b.py' }],
    } as never);
    const map = vi
      .spyOn(api.api, 'projectMap')
      .mockResolvedValue({ nodes: [{ id: 'n1' }], edges: [] } as never);

    const next = await project.refreshProject(held() as never);

    expect(summaryOf).toHaveBeenCalledWith('p1');
    expect((next.details.p1 as never as { files: unknown[] }).files).toHaveLength(2);
    // A phase that moved is a map that moved: the graph draws its verdicts.
    expect(map).toHaveBeenCalledWith('tasktrackr', { compact: true, showLocked: true });
    expect(next.map).toEqual({ nodes: [{ id: 'n1' }], edges: [] });
  });

  /**
   * A phase a teacher has split can move without any of the seven
   * fields above moving. Passing the optional task of a written phase leaves
   * the phase `in_progress` at the same score with the same attempt count
   * (the phase row is a roll-up over the required set and an optional task is
   * not in it) so `tasksUpdatedAt` is the only thing that says the learner's
   * own progress changed. Without it every per-task room draws from a cache
   * that cannot see a task move.
   */
  it('a task move invalidates the cached phase detail', async () => {
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [summary({ tasksUpdatedAt: '2026-09-19T10:00:00.000Z' })],
    } as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    vi.spyOn(api.api, 'projectMap').mockResolvedValue({ nodes: [], edges: [] } as never);
    const summaryOf = vi.spyOn(api.api, 'phaseSummary').mockResolvedValue({
      ...summary({ tasksUpdatedAt: '2026-09-19T10:00:00.000Z' }),
      view: 'summary',
      files: [{ path: 'a.py' }, { path: 'b.py' }],
    } as never);

    const held = {
      projects: [{ slug: 'tasktrackr' }] as never,
      enrolledSlugs: ['tasktrackr'],
      slug: 'tasktrackr',
      enrollment: { id: 'e1', projectSlug: 'tasktrackr', phases: [summary({ tasksUpdatedAt: null })] } as never,
      analytics: null,
      details: { p1: { ...summary({ tasksUpdatedAt: null }), view: 'summary', files: [{ path: 'a.py' }] } as never },
      map: { nodes: [], edges: [] } as never,
    };
    const next = await project.refreshProject(held as never);

    expect(summaryOf).toHaveBeenCalledWith('p1');
    expect((next.details.p1 as never as { files: unknown[] }).files).toHaveLength(2);
  });

  /**
   * The refresh must not name the slug the tab holds: a named read answers
   * that row whatever the server now resolves, so a tab open when the
   * teacher assigned the class a project would keep drawing, on every return
   * to it, the board the server had set aside, and the Start card that says
   * why would never appear. The refresh asks the server which
   * project is this learner's, and takes the full pass when it is not the one
   * held.
   */
  it('follows the server off a project set aside since the tab loaded, and never names the one it held', async () => {
    const catalogue = [
      { slug: 'field-notes', title: 'Field Notes' },
      { slug: 'tasktrackr', title: 'TaskTrackr', setAside: true },
    ];
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(null as never);
    const projects = vi.spyOn(api.api, 'projects').mockResolvedValue(catalogue as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);

    const next = await project.refreshProject(held() as never);

    expect(mine.mock.calls.every((call) => call[0] === undefined)).toBe(true);
    expect(mine).not.toHaveBeenCalledWith('tasktrackr');
    expect(projects).toHaveBeenCalledTimes(1);
    expect(next.enrollment).toBeNull();
    expect(next.slug).toBe('');
    expect(next.projects).toEqual(catalogue);
  });

  it('takes the full pass when the server now answers another project the learner has started', async () => {
    const board = { id: 'e2', projectSlug: 'field-notes', phases: [summary({ id: 'q1' })] };
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(board as never);
    const projects = vi
      .spyOn(api.api, 'projects')
      .mockResolvedValue([{ slug: 'field-notes' }, { slug: 'tasktrackr', setAside: true }] as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    vi.spyOn(api.api, 'phaseSummaries').mockResolvedValue([] as never);
    vi.spyOn(api.api, 'projectMap').mockResolvedValue(null as never);

    const next = await project.refreshProject(held() as never);

    expect(mine).not.toHaveBeenCalledWith('tasktrackr');
    expect(projects).toHaveBeenCalledTimes(1);
    expect(next.slug).toBe('field-notes');
    expect(next.enrollment).toEqual(board);
  });

  it('leaves a phase whose tasks have not moved alone', async () => {
    const stamped = { tasksUpdatedAt: '2026-09-19T10:00:00.000Z' };
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue({
      id: 'e1',
      projectSlug: 'tasktrackr',
      phases: [summary(stamped)],
    } as never);
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    const summaryOf = vi.spyOn(api.api, 'phaseSummary').mockResolvedValue({} as never);
    const map = vi.spyOn(api.api, 'projectMap').mockResolvedValue({ nodes: [], edges: [] } as never);

    await project.refreshProject(
      held({
        enrollment: { id: 'e1', projectSlug: 'tasktrackr', phases: [summary(stamped)] } as never,
        details: { p1: { ...summary(stamped), view: 'summary', files: [{ path: 'a.py' }] } as never },
      }) as never,
    );

    expect(summaryOf).not.toHaveBeenCalled();
    expect(map).not.toHaveBeenCalled();
  });
});

/**
 * Landing on the learner's **own** project.
 *
 * The server has a four-step resolution (the learner's own enrolment, then
 * their class's active assignment, then the `DEFAULT_PROJECT` slug, then the
 * project the importer flagged default) and the three learner routes run it
 * whenever a request names no project. An enrolment call that builds
 * `?project=${project}` from a defaulted argument would always name one, and
 * the resolution would never run.
 *
 * Two things are being pinned here. The request the resolution hangs off
 * carries no `project=` at all, and the slug the loader settles on is the one
 * the **server** named rather than whatever the catalogue happened to lead
 * with. The fixture slugs are deliberately not the shipped pack's: a test
 * written against "tasktrackr" would pass just as happily against a
 * hard-coded slug.
 */
describe('landing on the project the server says the learner is in', () => {
  const meta = (slug: string) => ({ slug, title: slug, phaseTitles: [] }) as never;
  const enrolment = (slug: string) =>
    ({ id: 'e1', projectSlug: slug, phases: [] }) as never;

  /** Everything the pass asks for once it knows which project it is loading. */
  function stubTheRest(): void {
    vi.spyOn(api.api, 'analyticsMe').mockResolvedValue(null as never);
    vi.spyOn(api.api, 'phaseSummaries').mockResolvedValue([] as never);
    vi.spyOn(api.api, 'projectMap').mockResolvedValue(null as never);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the enrolment with no query string at all when no project is named', async () => {
    // The URL, not the argument: this is the half a test written on the
    // server alone would go green over.
    const sent: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      sent.push(String(url));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(null),
        headers: { get: () => null },
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.setItem('lsdlc_token', 'jwt-value');

    await api.api.myEnrollment();
    await api.api.myEnrollment('atlas');

    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toContain('project=');
    expect(sent[0].endsWith('/enrollments/mine')).toBe(true);
    // A named project is still named, so the explicit path still works.
    expect(sent[1].endsWith('/enrollments/mine?project=atlas')).toBe(true);
  });

  it('sends no project parameter on any request it makes for a learner it has not placed', async () => {
    const projects = vi.spyOn(api.api, 'projects').mockResolvedValue([meta('ledger')]);
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(null as never);

    const data = await project.fetchProject();

    expect(mine.mock.calls[0][0]).toBeUndefined();
    expect(projects).toHaveBeenCalledTimes(1);
    // A learner the server says holds no enrolment is placed on nothing by the
    // browser. The catalogue is a list, and its order is not an answer: the
    // Start that follows names no project and the server resolves it.
    expect(data.slug).toBe('');
    expect(data.enrollment).toBeNull();
  });

  /**
   * The shell must not DISPLAY the wrong project by putting an unplaced
   * learner on `catalogue[0]`: the catalogue a member of staff reads is every
   * published project, in content order, so a teacher's project that sorts
   * first (`library-desk`) would be the project the page is drawn around.
   */
  it('puts nobody on a project because it sorts first in the catalogue', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('library-desk'), meta('tasktrackr')]);
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(null as never);
    const analytics = vi.spyOn(api.api, 'analyticsMe');

    const data = await project.fetchProject();

    expect(data.slug).toBe('');
    expect(data.slug).not.toBe('library-desk');
    expect(data.enrollment).toBeNull();
    // And nothing downstream is asked about a project nobody named.
    expect(analytics).not.toHaveBeenCalled();
    // The catalogue is still handed on whole, for the page that names what the
    // server will start.
    expect(data.projects.map((row) => row.slug)).toEqual(['library-desk', 'tasktrackr']);
  });

  it('takes the slug from the enrolment the server resolved, not from the catalogue', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('ledger'), meta('atlas')]);
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(enrolment('atlas'));
    stubTheRest();

    const data = await project.fetchProject();

    expect(mine.mock.calls[0][0]).toBeUndefined();
    expect(data.slug).toBe('atlas');
    expect(data.enrolledSlugs).toEqual(['atlas']);
    // And everything downstream of the slug names the one the server answered.
    expect(api.api.phaseSummaries).toHaveBeenCalledWith('atlas');
    expect(api.api.analyticsMe).toHaveBeenCalledWith('atlas');
  });

  it('still lets a named project win where the catalogue knows it', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('ledger'), meta('atlas')]);
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(enrolment('ledger'));
    stubTheRest();

    const data = await project.fetchProject('ledger');

    expect(mine).toHaveBeenCalledWith('ledger');
    expect(data.slug).toBe('ledger');
  });

  it('asks the server rather than the catalogue for a name the catalogue does not know', async () => {
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('ledger')]);
    const mine = vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(enrolment('atlas'));
    stubTheRest();

    const data = await project.fetchProject('retired-pack');

    // Not `catalogue[0]`, which would be content order deciding which project
    // a learner sees.
    expect(mine.mock.calls[0][0]).toBeUndefined();
    expect(data.slug).toBe('atlas');
  });

  it('does not draw a first-run screen for a learner whose class was reassigned', async () => {
    // On the browser: the learner has a term of work on `ledger`; their
    // class was reassigned to `atlas`, so the class's view (and the catalogue
    // it leads) names `atlas`. Step 1 of the four-step order is the learner's
    // own enrolment, and the browser reads that answer rather than
    // deriving one of its own, so the enrolment survives the reassignment.
    vi.spyOn(api.api, 'projects').mockResolvedValue([meta('atlas'), meta('ledger')]);
    vi.spyOn(api.api, 'myEnrollment').mockResolvedValue(enrolment('ledger'));
    stubTheRest();

    const data = await project.fetchProject();

    expect(data.slug).toBe('ledger');
    expect(data.enrollment).not.toBeNull();
    expect(data.enrolledSlugs).toEqual(['ledger']);
  });
});

/**
 * No learner-facing module names a project.
 *
 * Client-side project literals would stop a second project from existing.
 * This is the source-level statement that there are none: a quoted string
 * that is nothing but the shipped slug, a `project=` query built from it, and
 * `DEFAULT_PROJECT`, none of the three appears in a module a learner loads.
 * Prose and comments that mention the pack by name are not slugs and are not
 * scanned for.
 *
 * `ALLOWED` is the list of modules excused from the scan. It is empty, so
 * every scanned module is held to the same rule, which is what makes
 * `grep -rn "DEFAULT_PROJECT" apps/web` returning nothing a fact this suite
 * defends rather than one a reader has to check by hand.
 */
describe('no learner-facing web module names a project', () => {
  const WEB_ROOT = resolve(__dirname, '..');
  const SCANNED = ['lib', 'components', 'app'];
  const ALLOWED = new Set<string>([]);
  const SLUG_LITERAL = /(['"`])tasktrackr\1/;
  const SLUG_IN_QUERY = /project=tasktrackr/;

  function sources(dir: string, at = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(join(WEB_ROOT, dir, at), { withFileTypes: true })) {
      const rel = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) found.push(...sources(dir, rel));
      else if (/\.tsx?$/.test(entry.name)) found.push(rel);
    }
    return found;
  }

  const named = (test: RegExp): string[] => {
    const hits: string[] = [];
    for (const dir of SCANNED) {
      for (const rel of sources(dir)) {
        const path = `${dir}/${rel}`;
        if (ALLOWED.has(path)) continue;
        if (test.test(readFileSync(join(WEB_ROOT, path), 'utf8'))) hits.push(path);
      }
    }
    return hits;
  };

  it('holds no quoted project slug', () => {
    expect(named(SLUG_LITERAL)).toEqual([]);
  });

  it('builds no request that names a project slug of its own', () => {
    expect(named(SLUG_IN_QUERY)).toEqual([]);
  });

  it('imports no DEFAULT_PROJECT', () => {
    expect(named(/DEFAULT_PROJECT/)).toEqual([]);
  });
});
