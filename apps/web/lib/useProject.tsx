'use client';

/**
 * One loader for everything the learner-facing pages draw from: the project
 * catalogue, the active enrolment, its analytics and the detail (files,
 * rubric, last verdict) of every phase that is no longer locked.
 *
 * It is loaded once, above the router, by {@link ProjectProvider} in
 * `app/(app)/layout.tsx`. Home, Phases, Map, Journal, Artefacts and the
 * workspace all read the same copy through {@link useProject}, and so does the
 * shell: the sidebar's phase rows, the top bar's token readout and the bell's
 * count are derived from it rather than passed in by each page.
 *
 * Because the provider outlives every navigation, a page mount is not a reason
 * to fetch anything. The copy in memory is used as it stands until it is a
 * minute old; after that a window focus or an explicit reload refreshes it in
 * the background. `revalidating` says a refresh is in flight and must never
 * put a skeleton on the screen; `loading` is true only when there is nothing
 * to show yet.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useRouter } from 'next/navigation';
import type {
  EnrollmentView,
  LearnerAnalytics,
  PhaseDetail,
  PhaseSummary,
  ProjectMapData,
  ProjectMeta,
} from '@learnsdlc/shared';
import { firstPhaseOf } from '@learnsdlc/shared';
import { ApiError, api, describeError } from './api';
import { phaseDoorHref } from '@/components/shell/routes';
import { clearActiveProject, getActiveProject, setActiveProject } from './project';
// The map comes down built, and the folded one comes down
// with the project so Home's card is in the page's first commit.
import { CARD_MAP, putMap, resetMaps, staleMaps } from './project-map';
import { rememberTaskScopes, resetRecords, staleRecords } from './records';
import { ProjectContext } from './project-context';
import { resetReviewHistory, staleReviewHistory } from './review-history';
import { onSessionEnd, ownedByToken } from './session';
import { sameSession } from './session-token';
// The token as the app reads it: `lib/session` only reads storage, and a
// browser that blocks site data holds the session in memory instead.
import { getToken } from './api';

export interface ProjectData {
  projects: ProjectMeta[];
  /** Slugs of projects this learner has started. */
  enrolledSlugs: string[];
  slug: string;
  enrollment: EnrollmentView | null;
  analytics: LearnerAnalytics | null;
  /**
   * Keyed by phase id; only phases that are not locked.
   *
   * These are SUMMARIES: every path is there with its `lines` and `touched`,
   * and no file body and no brief. Anything that reads a body (the IDE, the
   * dossier, the repo export) asks for the phase itself. `PhaseDetail.view`
   * says which is in
   * hand.
   */
  details: Record<string, PhaseDetail>;
  /**
   * The folded project map with locked placeholders: Home's card, built by the
   * API. Null while the first load is in flight, and for a learner who has not
   * started the project. The unfolded map (⌘K and the map page) is fetched
   * when it is looked at; see `lib/project-map`.
   */
  map: ProjectMapData | null;
}

export interface ProjectState extends ProjectData {
  loading: boolean;
  /** True while a cached copy is shown and a fresh one is on its way. */
  revalidating: boolean;
  error: string;
  enrolling: string;
  currentPhase: PhaseSummary | undefined;
  /**
   * Start the project this learner has been given. It takes no slug: the
   * server resolves which project that is, and the tab holds its answer.
   */
  start: () => Promise<void>;
  switchTo: (slug: string) => Promise<void>;
  reload: () => Promise<void>;
}

/** How long a cached copy is used without asking the API for a fresh one. */
export const FRESH_MS = 60_000;

/** What `enrolling` holds while a Start is in flight: the project is the server's to name. */
const STARTING = 'starting';

interface Held {
  data: ProjectData;
  at: number;
  /** Set by an invalidation: still drawn, no longer trusted. */
  stale?: boolean;
}

const cache = new Map<string, Held>();
const inflight = new Map<string, Promise<ProjectData>>();
/**
 * Bumped by every invalidation and every reset. A fetch already in the air
 * when one of those happens asked its question before the change, so its
 * answer cannot replace a newer request in either cache or rendered state.
 */
let generation = 0;
// The cache belongs to one signed-in session. A different token (sign out,
// then sign in as someone else in the same tab, with or without the sign-out)
// must never see the previous learner's project, so the cache is dropped the
// moment the token changes.
const ownCache = ownedByToken(() => {
  generation += 1;
  cache.clear();
  inflight.clear();
  // And the slug itself (`lib/project`), which is the same cache with one
  // value in it: keeping it would hand the next account the last one's
  // project as the thing to load, and (before setup asked the server) as
  // the thing to enrol into.
  clearActiveProject();
});

/** The copy in memory for the project being looked at, if there is one. */
function peek(want?: string): Held | undefined {
  ownCache();
  return cache.get(want || getActiveProject()) || cache.get('*');
}

const isStale = (held: Held | undefined): boolean =>
  !held || held.stale === true || Date.now() - held.at > FRESH_MS;

/**
 * "The learner is not enrolled" and "the API did not answer" must stay
 * different values here. If every per-project request were wrapped in
 * `.catch(() => null)`, a 500 during a restart would look exactly like a
 * first-run learner: the dashboard would draw the start panel, and pressing
 * Start would answer `already enrolled in this project`. The API says "no
 * enrolment" with a 200 and a null body, and 404 for a project it does not
 * know, so those two are the only rejections worth swallowing.
 */
function isNoEnrolment(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * The sentence a learner is shown for a failure.
 *
 * `describeError` (lib/api) already turns a dead connection into English and
 * passes a 4xx through untouched, because a 4xx names something the learner
 * can change. A 5xx names nothing they can change ("request failed (503)")
 * so it is replaced by the sentence that fits what they were doing, keeping
 * the reference the API logged it under, which is the one string support can
 * search for.
 */
export function learnerMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status >= 500) {
    return err.requestId ? `${fallback} Reference ${err.requestId}.` : fallback;
  }
  return describeError(err, fallback);
}

/**
 * The enrolment an answer carries, or null. `request` turns an empty 200 body
 * into `{}`, so an answer with no id is no enrolment.
 */
function asEnrollment(found: EnrollmentView | null): EnrollmentView | null {
  return found && (found as { id?: unknown }).id ? found : null;
}

/**
 * The whole picture, from nothing: the catalogue, then the enrolment and what
 * hangs off it.
 *
 * It asks about one project, once: a first load is two requests rather than
 * one `myEnrollment` per catalogue entry. `enrolledSlugs` is a list, and it is
 * `[slug]` or `[]`.
 *
 * **The server decides which project.** Content order is not a product
 * decision, and with two projects
 * `catalogue[0]` would silently land a learner on the wrong one: including a
 * learner with a term of work whose class was reassigned, who would be looked
 * up under a project they hold no enrolment in and shown the first-run screen.
 * So with no name in hand this asks the server, with no `?project` at all, and
 * takes the slug from the enrolment it answers.
 *
 * **And a learner the server has not placed is on no project at all.** A
 * fallback to `catalogue[0]` for them would be the same mistake one step
 * later: the catalogue a member of staff reads is every published project in
 * content order, so a teacher's project that sorted first would be the
 * project the page was drawn around and the one Start sent. The slug stays
 * empty until the server starts a project (`start`, which names none) or the
 * page names one. The catalogue is handed on whole, for the one page
 * that says what Start will begin: see `EmptyProject`.
 *
 * Exported for the unit suite. The app reaches it through {@link load}, which
 * is what dedupes and caches.
 */
export async function fetchProject(want?: string): Promise<ProjectData> {
  const catalogue = await api.projects();
  // A named project still wins where the catalogue knows it, so a link that
  // carries a slug is not quietly redirected. A name the catalogue does not
  // know is not a name: it falls through to the server's own resolution rather
  // than to whatever sorted first.
  //
  // Nor is a project the server has set aside for the learner's class. The
  // name is the tab's own: a reload names what it was drawn
  // around. Taken as a name, it redraws the old board over the class's
  // project, and the Start card that says why never appears. The row still
  // answers every read that names it (records, dossier, export). The shell
  // just does not open on it.
  const named =
    want && catalogue.some((p) => p.slug === want && !p.setAside) ? want : undefined;
  // "Not enrolled" is a 200 with a null body, and a 404 is a project this
  // deployment does not ship. Anything else is the API failing to answer, and
  // the caller must be told the picture is incomplete rather than shown a
  // first-run screen built from the gap.
  const found = await api.myEnrollment(named).catch((err) => {
    if (isNoEnrolment(err)) return null;
    throw err;
  });
  const enrollment = asEnrollment(found);
  const slug = named ?? enrollment?.projectSlug ?? '';
  const started = enrollment ? [slug] : [];
  if (!enrollment) {
    return { projects: catalogue, enrolledSlugs: started, slug, enrollment: null, analytics: null, details: {}, map: null };
  }
  // Analytics that will not load are held as none, and the pages draw without them.
  const analytics = await api.analyticsMe(slug).catch(() => null);
  // Summaries, and the map built where the files already are. Fetching every
  // open phase whole so the browser could build the map would cost 133 KB of
  // workspace for a 26 KB graph, against a 60 KB budget. The map comes down
  // with the rest so Home's card is drawn in the page's first commit rather
  // than after a second round trip.
  // One request for every open phase, not one each. The per-phase route is
  // what a single stale phase costs; this is the cold load, where one request
  // per phase would be six of the shell's thirteen requests asking the same
  // question six times.
  const [loaded, map] = await Promise.all([
    api.phaseSummaries(slug).catch(() => [] as PhaseDetail[]),
    // A map that will not load is held as none, and Home draws its card without one.
    api.projectMap(slug, CARD_MAP).catch(() => null),
  ]);
  const details: Record<string, PhaseDetail> = {};
  loaded.forEach((d) => {
    if (d) details[d.id] = d;
  });
  // What each phase's revisions are read under, said once for the whole
  // project. The record cache is asked for a phase's revisions by paths that
  // hold no task list: the dossier's bulk fill, the refresh after a verdict,
  // Home's idle prefetch, and the phase-wide route is refused on a phase a
  // teacher has split. This is the one place that knows the answer for every
  // phase, whether or not a room in it has been opened.
  rememberTaskScopes(Object.values(details));
  return { projects: catalogue, enrolledSlugs: started, slug, enrollment, analytics, details, map };
}

/**
 * The shell's copy of a phase, but only when it is one an editor can open on.
 *
 * The provider holds SUMMARIES: every path, its line
 * count and whether the learner has touched it, and no file bodies. That is
 * everything Home, Phases, the journal and the shelf draw, and it is not
 * something the IDE can seed from: seeding an editor from an index would draw
 * an open file with nothing in it. So the workspace rooms ask for this, get
 * nothing while the shell holds a summary, and draw their loading state until
 * their own `workspaceApi.phase` call lands.
 */
export function fullDetail(
  details: Record<string, PhaseDetail>,
  phaseId: string,
): PhaseDetail | undefined {
  const held = details[phaseId];
  return held && held.view !== 'summary' ? held : undefined;
}

/**
 * Has this phase moved in a way that changes the heavy half of its detail?
 *
 * The summary carries everything a submission, a grading or a reflection
 * changes. The detail's own body (the files, the rubric, the last verdict, the
 * links) only ever changes with one of those, so a phase whose summary is
 * identical is a phase whose detail can be reused.
 *
 * The eighth comparison, `tasksUpdatedAt`, is not tidiness. On a phase a
 * teacher has split, passing an **optional** task moves nothing above it: the
 * phase's status, score and attempt count are a roll-up over the **required**
 * set, so a task can be finished, scored and recorded while every one of the
 * seven fields stands still. `tasksUpdatedAt` is `MAX(task_states.updatedAt)`
 * for the phase, and without it every surface in this block would draw from a
 * cache that cannot see a task move.
 */
function phaseMoved(had: PhaseSummary, now: PhaseSummary): boolean {
  return (
    had.status !== now.status ||
    had.bestScore !== now.bestScore ||
    had.attempts !== now.attempts ||
    had.passedAt !== now.passedAt ||
    had.reflection !== now.reflection ||
    had.opensAt !== now.opensAt ||
    had.dueAt !== now.dueAt ||
    (had.tasksUpdatedAt ?? null) !== (now.tasksUpdatedAt ?? null)
  );
}

/**
 * A held phase detail brought up to date by its summary. `PhaseDetail`
 * extends `PhaseSummary` and both carry `intro`: the summary's is the
 * opening, cut at `PHASE_SUMMARY_INTRO_MAX` with an ellipsis, and the detail's
 * is the whole of it. Spreading the summary over the detail would cut a
 * teacher's long intro on every focus refresh, so the held intro stays.
 */
export function keepHeldDetail(had: PhaseDetail, summary: PhaseSummary): PhaseDetail {
  return { ...had, ...summary, intro: had.intro };
}

/**
 * The cheap half of {@link fetchProject}, for refreshing a picture already
 * held.
 *
 * Repeating the whole landing on a return to the tab (the catalogue, the
 * enrolment, the analytics and the full detail of every open phase) would be
 * seven or eight requests and 44 KB for a learner three phases in, of which
 * 36 KB is phase details that had not changed. The
 * catalogue does not change during a term and neither does which projects this
 * learner has started, so a refresh asks for the enrolment and the analytics
 * and refetches a phase's detail only where the enrolment says that phase has
 * moved. Two requests for a learner who has been reading, rather than eight.
 *
 * Anything that changes work in *this* tab goes through `invalidateProject`,
 * which takes the full path, so this is only ever the "nothing of mine has
 * happened" case.
 *
 * **It asks the server which project, and never names the one held.**
 * Something can happen to the learner that is not theirs and not this tab's:
 * their teacher assigns the class a project, and the platform project they
 * had open is set aside for it. A read that named the held slug would answer
 * that row regardless, so a tab left open would draw the set-aside board on
 * every return to it and the Start card that says why would never appear. The
 * unnamed read costs the same one request; when it answers the project held,
 * this refreshes it in place, and when it answers another (or none) the
 * full pass draws what the server resolves, the catalogue and its notice
 * included.
 */
export async function refreshProject(held: ProjectData): Promise<ProjectData> {
  const found = await api.myEnrollment();
  const enrollment = asEnrollment(found);
  if (!enrollment || enrollment.projectSlug !== held.slug) return fetchProject();
  // Analytics that will not load are held as none, and the pages draw without them.
  const analytics = await api.analyticsMe(held.slug).catch(() => null);
  const details: Record<string, PhaseDetail> = {};
  const wanted: PhaseSummary[] = [];
  for (const p of enrollment.phases) {
    if (p.status === 'locked') continue;
    const had = held.details[p.id];
    // The summary fields are taken from the enrolment either way, so a phase
    // that only moved its dates is current without another request.
    if (had && !phaseMoved(had, p)) details[p.id] = keepHeldDetail(had, p);
    else wanted.push(p);
  }
  // One stale phase is one request; three or more is cheaper as the batch.
  const loaded =
    wanted.length > 2
      ? await api.phaseSummaries(held.slug).catch(() => wanted.map((p) => held.details[p.id] ?? null))
      : await Promise.all(
          wanted.map((p) => api.phaseSummary(p.id).catch(() => held.details[p.id] ?? null)),
        );
  loaded.forEach((d) => {
    if (d) details[d.id] = d;
  });
  // The map is drawn from those same phases, so it is asked for exactly when
  // one of them moved. A learner who has been reading still costs two requests.
  let map = held.map;
  if (wanted.length) {
    // A map that will not load keeps the one in hand.
    const fresh = await api.projectMap(held.slug, CARD_MAP).catch(() => null);
    if (fresh) {
      map = fresh;
    }
  }
  // The same statement the full pass makes, made here too: a phase
  // re-read by this refresh may be one a teacher has split since the first
  // load, and the record cache must hear it before a refresh of that phase's
  // revisions asks the phase-wide route the API refuses on a split phase.
  rememberTaskScopes(Object.values(details));
  return { projects: held.projects, enrolledSlugs: held.enrolledSlugs, slug: held.slug, enrollment, analytics, details, map };
}

class ProjectLoadSuperseded extends Error {}

function load(want?: string, refreshFrom?: ProjectData): Promise<ProjectData> {
  ownCache();
  const owner = getToken();
  const key = want || '*';
  // A page that names the project and the shell that does not use two
  // different keys for one question, so landing on /complete would fetch the
  // catalogue, the enrolment and the analytics twice each. A load
  // for the project already in the air joins it: `fetchProject(undefined)`
  // resolves to the active project, which is what the named call is asking
  // for.
  const running =
    inflight.get(key) ??
    (key === '*' ? inflight.get(getActiveProject()) : want === getActiveProject() ? inflight.get('*') : undefined);
  if (running) return running;
  const mine = generation;
  // All outcomes, including failures, must belong to the same session and
  // current request. An old caller may adopt the winner, never its own stale
  // result. The map is published only after this fence as well.
  const replacement = (): Promise<ProjectData> | ProjectData | null => {
    if (!sameSession(getToken(), owner)) throw new ProjectLoadSuperseded();
    if (mine === generation && inflight.get(key) === p) return null;
    const newer = inflight.get(key) ??
      (key === '*' ? inflight.get(getActiveProject()) : want === getActiveProject() ? inflight.get('*') : undefined);
    if (newer && newer !== p) return newer;
    const held = cache.get(key);
    if (held && !held.stale) return held.data;
    throw new ProjectLoadSuperseded();
  };
  // A refresh falls back to the full pass whenever the copy in hand has no
  // enrolment to refresh from: there is nothing cheap to do with "not started".
  const p: Promise<ProjectData> = (refreshFrom?.enrollment
    ? refreshProject(refreshFrom)
    : fetchProject(want))
    .then((data) => {
      const newer = replacement();
      if (newer) return newer;
      const at = Date.now();
      cache.set(data.slug, { data, at });
      cache.set('*', { data, at });
      setActiveProject(data.slug);
      if (data.map) putMap(data.slug, CARD_MAP, data.map);
      return data;
    }, (error) => {
      const newer = replacement();
      if (newer) return newer;
      throw error;
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/* --------------------------- invalidation signal -------------------------- */

let version = 0;
const bumps = new Set<() => void>();

/** Mark what is held as no longer trustworthy, without throwing it away. */
function markStale(): void {
  generation += 1;
  cache.forEach((held) => {
    held.stale = true;
  });
  // Anything in the air was asked for before the thing that changed.
  inflight.clear();
  staleRecords();
  staleReviewHistory();
  staleMaps();
}

/**
 * Each enrolment a change's answer has replaced, and the answer. The provider
 * reads it while it renders, so the render the invalidation causes already
 * draws the answer, before its effect takes the adopted copy into state: a
 * navigation committed between the two never sees the enrolment replaced.
 */
const superseded = new WeakMap<EnrollmentView, EnrollmentView>();

/** The server's answer for the enrolment a held copy is of, in place of the one it held. */
function adoptEnrollment(answered: EnrollmentView): void {
  cache.forEach((held) => {
    const had = held.data.enrollment;
    if (!had || had.id !== answered.id || held.data.slug !== answered.projectSlug) return;
    superseded.set(had, answered);
    held.data = { ...held.data, enrollment: answered };
  });
}

/**
 * What is on screen is now a phase behind: after a submission, a run, a merge
 * or a drill. The provider hears this and refetches; pages call it and carry
 * on.
 *
 * It does not empty the cache: that would leave the provider nothing to hand
 * the next page and put a skeleton over a Home it had a perfectly good copy
 * of. The copy stays and is served as it stands; `revalidating` says a fresh one
 * is on its way, and it replaces the old one when it lands.
 *
 * **A change that answers with the enrolment hands that answer in** (`answered`).
 * Continue is the one that must: the advance opens the next phase and the
 * learner is sent into it at once, while the fresh copy is still four requests
 * away. Served as it stood, the held copy would still say that phase is `locked`,
 * and the workspace layout, which finds a phase with no held detail yet in
 * `enrollment.phases`, would draw "<Phase> is locked" until the copy landed: a
 * heading and a live notice an accessibility reader announces over a room that
 * is open. The server's own answer replaces the held enrolment before
 * anything is drawn from it, so the next room starts from what the server said.
 * Only the enrolment is taken, and only into a copy of that same enrolment; the
 * rest of the copy is refetched in the background.
 */
export function invalidateProject(answered?: EnrollmentView | null): void {
  if (answered?.id) adoptEnrollment(answered);
  markStale();
  version += 1;
  bumps.forEach((fn) => fn());
}

/**
 * The harder one: throw the copy away and load from nothing. Only for a change
 * of subject (a different project, a different learner) where showing what
 * is held would be showing the wrong learner's or the wrong project's work.
 */
export function resetProject(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
  resetRecords();
  resetReviewHistory();
  resetMaps();
  version += 1;
  bumps.forEach((fn) => fn());
}

function subscribeVersion(fn: () => void): () => void {
  bumps.add(fn);
  return () => {
    bumps.delete(fn);
  };
}

onSessionEnd(() => {
  generation += 1;
  cache.clear();
  inflight.clear();
  clearActiveProject();
});

/* -------------------------------- provider -------------------------------- */

// In its own module, so the gate band can read it without the hooks below (`lib/project-context`).

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const held = peek();
  const [data, setData] = useState<ProjectData | null>(held?.data ?? null);
  const [loading, setLoading] = useState(!held);
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState('');
  const [enrolling, setEnrolling] = useState('');
  const alive = useRef(true);
  const runSequence = useRef(0);
  const at = useSyncExternalStore(
    subscribeVersion,
    () => version,
    () => 0,
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runSequence.current += 1;
    };
  }, []);

  const run = useCallback(async (want?: string, refreshFrom?: ProjectData) => {
    const sequence = ++runSequence.current;
    const owner = getToken();
    const current = () => alive.current && sequence === runSequence.current && sameSession(owner, getToken());
    try {
      const next = await load(want, refreshFrom);
      if (!current()) return;
      setData(next);
      setError('');
    } catch (err) {
      if (!current() || err instanceof ProjectLoadSuperseded) return;
      // Never the raw "Failed to fetch". A learner can act on the sentence
      // below; they can do nothing at all with the other.
      setError(
        learnerMessage(err, 'Your project could not be loaded. Try again in a moment.'),
      );
    } finally {
      if (current()) {
        setLoading(false);
        setRevalidating(false);
      }
    }
  }, []);

  // The one place a load starts on its own: the first mount of the shell, and
  // again whenever something invalidates the cache. A page mount is not on
  // this list, that is the whole point.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    const current = peek();
    if (current) {
      setData(current.data);
      setLoading(false);
      if (!isStale(current)) return;
      setRevalidating(true);
    } else {
      setLoading(true);
    }
    void run();
  }, [run, at]);

  // Coming back to the tab after a while is the one moment a learner expects
  // the numbers to be current. Inside the minute, nothing is asked for.
  useEffect(() => {
    const onFocus = () => {
      if (!getToken() || document.visibilityState === 'hidden') return;
      const current = peek();
      if (!isStale(current)) return;
      setRevalidating(true);
      // What the learner came back for is the numbers, not the
      // catalogue. `refreshProject` reuses what is held and asks only for what
      // can have changed. A copy marked stale by an invalidation is a
      // different matter and takes the full pass.
      void run(undefined, current && !current.stale ? current.data : undefined);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [run]);

  /**
   * The dashboard's Start.
   *
   * It never sends the slug the page holds: for anybody the server has not
   * placed that slug is `catalogue[0]`: for a member of staff, whichever
   * published project sorted first, which the staff exception would then
   * enrol them in. So it names nothing: the server starts
   * the project it resolves for this account, and the tab holds the slug the
   * server answers with rather than one it guessed.
   */
  const start = useCallback(
    async () => {
      setEnrolling(STARTING);
      setError('');
      try {
        const created = await api.enroll();
        const slug = created.projectSlug;
        setActiveProject(slug);
        // A different project: what is held is the last one's, down to the
        // phase details, so it goes rather than being shown while the new one
        // loads.
        resetProject();
        const first = firstPhaseOf(created);
        if (first) {
          // The phase's door: the brief, for a phase nobody has
          // submitted in yet, rather than the IDE.
          router.push(phaseDoorHref(first));
          return;
        }
        await run(slug);
      } catch (err) {
        setError(
          learnerMessage(err, 'That project could not be started. Try again in a moment.'),
        );
      } finally {
        if (alive.current) setEnrolling('');
      }
    },
    [router, run],
  );

  /**
   * With one project in the catalogue nothing calls this with a different slug,
   * so it is a reload, but it stays on the exported context type, and stays
   * correct, for the deployment that ships a second pack.
   */
  const switchTo = useCallback(
    async (slug: string) => {
      setActiveProject(slug);
      const cached = cache.get(slug);
      if (cached) {
        setData(cached.data);
        setRevalidating(true);
      } else {
        setLoading(true);
      }
      await run(slug);
    },
    [run],
  );

  const reload = useCallback(async () => {
    // The project this copy is of, unless a page has just told the tab to
    // forget it. A class join or leave changes which project the server
    // resolves, and a request that names the old slug is answered with the
    // old enrolment, which is how a learner who left a teacher's class stayed
    // on that class's project. With the tab's slug cleared the reload names
    // nothing and the server answers the question afresh.
    const want = getActiveProject() ? data?.slug : undefined;
    // Asked for by a page that has just changed something, so the copy in hand
    // stays on screen while the fresh one is fetched.
    markStale();
    setRevalidating(true);
    await run(want);
  }, [run, data?.slug]);

  // The enrolment in state, or the answer that replaced it (`invalidateProject(answered)`).
  // `at` is read above, so a render after the invalidation always reaches here.
  const enrollment = data?.enrollment ? (superseded.get(data.enrollment) ?? data.enrollment) : null;
  const value = useMemo<ProjectState>(() => {
    return {
      projects: data?.projects ?? [],
      enrolledSlugs: data?.enrolledSlugs ?? [],
      slug: data?.slug ?? getActiveProject(),
      enrollment,
      analytics: data?.analytics ?? null,
      details: data?.details ?? {},
      map: data?.map ?? null,
      loading,
      revalidating,
      error,
      enrolling,
      currentPhase: enrollment?.phases.find((p) => p.order === enrollment.currentPhaseOrder),
      start,
      switchTo,
      reload,
    };
  }, [data, enrollment, loading, revalidating, error, enrolling, start, switchTo, reload]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/**
 * The project the shell is drawn around. A context read rather than a loader,
 * so it costs no request.
 */
export function useProject(): ProjectState {
  const value = useContext(ProjectContext);
  if (!value) {
    throw new Error(
      'useProject must be used inside <ProjectProvider> — the signed-in pages live under app/(app)/',
    );
  }
  return value;
}

/**
 * The same read for the shell, which is drawn in one place but exported for
 * pages that lay themselves out by hand. Outside the provider it is null and
 * the chrome falls back to what it was passed.
 */
export function useProjectMaybe(): ProjectState | null {
  return useContext(ProjectContext);
}
