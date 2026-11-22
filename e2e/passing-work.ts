import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { DESIGN_JSON, STORY_JSON, serialiseDesign, serialiseStory, type Story } from '@learnsdlc/shared';
import { DEMO_ADMIN, DEMO_INSTRUCTOR } from '../scripts/lib/demo-accounts.mjs';
import { IMPLEMENTATION_ARTEFACT } from './fixtures';
import { E2E_PASS } from './pw-fixtures';
import { DESIGN_ARTEFACT as DESIGN_RECORD_ARTEFACT, DESIGN_RECORD, REQUIREMENTS_STORY } from './golden-records';
import { API } from './support/env';

/**
 * Written work that passes a phase, and the API walk that submits it (release
 * B, PW).
 *
 * A written phase passes its gate only on an assessed verdict, and the suite's
 * assessor is the canned stub in e2e/ai-stub.cjs: it passes a submission only
 * when the learner's own files carry the E2E-PASS marker. So the marker lives
 * here, in one place, in a field a learner can write and nothing grades by
 * shape: the story's notes (which the review reads as `story/notes`), and the
 * design record's notes (which the review reads as `design/notes`).
 *
 * Requirements is the story record alone, `requirements/story.json`, written
 * by the product's own serialiser; there is no markdown in the phase.
 */


const MARKED_STORY: Story = { ...REQUIREMENTS_STORY, notes: `${REQUIREMENTS_STORY.notes} ${E2E_PASS}` };

/** Phase 1, complete and marked: the story record. */
export const PASSING_REQUIREMENTS: Record<string, string> = {
  [STORY_JSON]: serialiseStory(MARKED_STORY),
};

/** Phase 2, complete and marked: the design record, marked in its notes, and both contracts as written. */
export const PASSING_DESIGN: Record<string, string> = {
  ...DESIGN_RECORD_ARTEFACT,
  [DESIGN_JSON]: serialiseDesign({ ...DESIGN_RECORD, notes: `${DESIGN_RECORD.notes} ${E2E_PASS}` }),
};

export interface ApiLearner {
  email: string;
  password: string;
  name: string;
  token: string;
  userId: string;
  headers: { authorization: string };
}

/**
 * A learner made through the API, with setup marked complete, so signing in
 * in the browser lands on the dashboard rather than the one-page setup.
 * Enrolling is a separate step: a spec about a learner with no project skips it.
 */
export async function registerByApi(
  request: APIRequestContext,
  who: { email: string; password: string; name: string },
): Promise<ApiLearner> {
  const registered = await request.post(`${API}/auth/register`, {
    data: { email: who.email, password: who.password, displayName: who.name },
  });
  expect(registered.ok(), 'the learner registers').toBeTruthy();
  const body = await registered.json();
  const headers = { authorization: `Bearer ${body.token}` };
  const profile = await request.patch(`${API}/account/profile`, {
    headers,
    data: { displayName: who.name, onboardingCompleted: true },
  });
  expect(profile.ok(), 'the learner finishes setup').toBeTruthy();
  return { ...who, token: body.token, userId: body.user.id, headers };
}

export type ApiPhase = { id: string; order: number; key: string; status?: string };

export async function enrolByApi(request: APIRequestContext, learner: ApiLearner): Promise<ApiPhase[]> {
  const enrolled = await request.post(`${API}/enrollments`, {
    headers: learner.headers,
    data: { projectSlug: 'tasktrackr' },
  });
  expect(enrolled.ok(), 'the learner enrols').toBeTruthy();
  return (await enrolled.json()).phases;
}

/** A submission as GET /submissions/:id reports it: the fields the specs read. */
export interface SettledSubmission {
  id: string;
  status: string;
  passed: boolean | null;
}

/** Wait for a submission to finish and return it as the API reports it. */
export async function settledSubmission(
  request: APIRequestContext,
  learner: Pick<ApiLearner, 'headers'>,
  id: string,
  timeout = 180_000,
): Promise<SettledSubmission> {
  const deadline = Date.now() + timeout;
  let done: SettledSubmission | null = null;
  while (Date.now() < deadline) {
    const read: SettledSubmission = await (await request.get(`${API}/submissions/${id}`, { headers: learner.headers })).json();
    done = read;
    if (read.status === 'completed' || read.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // The loop reads at least once for any positive timeout.
  return done as SettledSubmission;
}

/**
 * Save `files`, submit, wait for the verdict, and, when it passes, reflect
 * and advance. Returns the phases as the advance left them.
 *
 * Only the learner's session is read, so a spec that signs its learner in by
 * hand passes `{ headers }`; `phases` is the enrolment's own list (each phase
 * with its `order`), from `POST /enrollments` or `GET /enrollments/mine`.
 */
export async function passPhaseByApi(
  request: APIRequestContext,
  learner: Pick<ApiLearner, 'headers'>,
  phases: ApiPhase[],
  order: number,
  files: Record<string, string>,
  reflection = `Phase ${order}: the feedback named the weakest criterion and I fixed it.`,
  message?: string,
): Promise<ApiPhase[]> {
  const phase = phases.find((p) => p.order === order)!;
  const saved = await request.put(`${API}/phases/${phase.id}/workspace`, { headers: learner.headers, data: { files } });
  expect(saved.ok(), `phase ${order} saves`).toBeTruthy();
  // A code phase scores its process criterion on a run made before the
  // submission, so one is made and must succeed. The runner's own sentence
  // rides on a failure: a host that cannot isolate learner code says so here.
  if (order >= 3) {
    const started = await request.post(`${API}/phases/${phase.id}/run`, { headers: learner.headers });
    expect(started.ok(), `phase ${order} starts a run`).toBeTruthy();
    const runId = (await started.json()).id as string;
    let run: any = null;
    await expect
      .poll(async () => {
        run = await (await request.get(`${API}/runs/${runId}`, { headers: learner.headers })).json();
        return run.status;
      }, { timeout: 240_000, intervals: [1_000, 2_000] })
      .toMatch(/completed|failed/);
    expect(run.status, run.result?.stderr).toBe('completed');
  }
  const started = await request.post(`${API}/phases/${phase.id}/submit`, { headers: learner.headers, data: message ? { message } : {} });
  expect(started.ok(), `phase ${order} submits`).toBeTruthy();
  const done = await settledSubmission(request, learner, (await started.json()).id);
  expect(done?.passed, `phase ${order} passes its gate`).toBe(true);
  const reflected = await request.post(`${API}/phases/${phase.id}/reflect`, { headers: learner.headers, data: { reflection } });
  expect(reflected.ok(), `phase ${order} takes its reflection`).toBeTruthy();
  const advanced = await request.post(`${API}/phases/${phase.id}/advance`, { headers: learner.headers });
  expect(advanced.ok(), `phase ${order} advances`).toBeTruthy();
  return (await advanced.json()).phases;
}

/**
 * Register, set up, enrol, and pass the two written phases, so the learner
 * stands on Implementation. Returns the learner and the Implementation phase id.
 */
export async function reachImplementationByApi(
  request: APIRequestContext,
  who: { email: string; password: string; name: string },
): Promise<{ learner: ApiLearner; phaseId: string; phases: ApiPhase[] }> {
  const learner = await registerByApi(request, who);
  let phases = await enrolByApi(request, learner);
  phases = await passPhaseByApi(request, learner, phases, 1, PASSING_REQUIREMENTS);
  phases = await passPhaseByApi(request, learner, phases, 2, PASSING_DESIGN);
  return { learner, phaseId: phases.find((p) => p.order === 3)!.id, phases };
}

/**
 * The signed-in learner's phases, keyed by phase key, read with the page's own
 * session. For a spec that needs to open a phase the rooms give no direct link
 * to from where it stands.
 */
export async function myPhaseIds(page: Page): Promise<Record<string, string>> {
  const token = await page.evaluate(() => window.localStorage.getItem('lsdlc_token'));
  expect(token, 'the page has a session').toBeTruthy();
  const mine = await page.request.get(`${API}/enrollments/mine`, { headers: { authorization: `Bearer ${token}` } });
  expect(mine.ok(), 'the enrolment reads').toBeTruthy();
  const body = await mine.json();
  const phases: ApiPhase[] = Array.isArray(body) ? body : body.phases ?? body.enrollment?.phases ?? [];
  return Object.fromEntries(phases.map((phase) => [phase.key, phase.id]));
}

/**
 * The same files with the E2E-PASS marker added as a comment at the end of the
 * first file that takes one, for code phases whose work comes from the pack's
 * own solutions. A comment changes nothing a check or a test reads; it only
 * tells the suite's AI stub that this submission is meant to pass.
 */
export function markPassing(files: Record<string, string>): Record<string, string> {
  const comment = (path: string): string | null => {
    if (/\.(py|ya?ml|toml|sh)$|(^|\/)Dockerfile$/.test(path)) return `# ${E2E_PASS}`;
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return `// ${E2E_PASS}`;
    if (/\.md$/.test(path)) return `<!-- ${E2E_PASS} -->`;
    return null;
  };
  const target = Object.keys(files).find((path) => comment(path) !== null);
  if (!target) throw new Error('markPassing: no file here takes a comment');
  const body = files[target];
  return { ...files, [target]: `${body}${body.endsWith('\n') ? '' : '\n'}${comment(target)}\n` };
}

/**
 * Everything reachImplementationByApi does, then Implementation passed with the
 * pack's own solution (marked), after a run. Needs a host that can run learner
 * code; on one that cannot, the run fails with the runner's sentence.
 */
export async function reachTestingByApi(
  request: APIRequestContext,
  who: { email: string; password: string; name: string },
): Promise<{ learner: ApiLearner; phaseId: string; phases: ApiPhase[] }> {
  const reached = await reachImplementationByApi(request, who);
  const phases = await passPhaseByApi(request, reached.learner, reached.phases, 3, markPassing(IMPLEMENTATION_ARTEFACT));
  return { learner: reached.learner, phaseId: phases.find((p) => p.order === 4)!.id, phases };
}

/* ------------------------------- staff side ------------------------------- */

/**
 * The seeded instructor and admin, which the API seeds for the suite
 * (SEED_DEMO_ACCOUNTS in playwright.config.ts). Their addresses and default
 * passwords live once, in scripts/lib/demo-accounts.mjs; SEED_PASSWORD, when
 * set, is both accounts' password.
 */
export const INSTRUCTOR = DEMO_INSTRUCTOR;
export const ADMIN = DEMO_ADMIN;

/**
 * The administrator a spec acts as: ADMIN_EMAIL and ADMIN_PASSWORD when the
 * shell names a bootstrap administrator (the API under test reads the same
 * two), the seeded admin otherwise.
 */
export const CONFIGURED_ADMIN = {
  email: process.env.ADMIN_EMAIL || ADMIN.email,
  password: process.env.ADMIN_PASSWORD || ADMIN.password,
};

export interface StaffParty {
  token: string;
  headers: { authorization: string };
}

/** Sign a seeded staff account in through the API. */
export async function staffByApi(
  request: APIRequestContext,
  who: { email: string; password: string } = INSTRUCTOR,
): Promise<StaffParty> {
  const res = await request.post(`${API}/auth/login`, { data: { email: who.email, password: who.password } });
  expect(res.ok(), 'the staff account signs in').toBeTruthy();
  const token = (await res.json()).token as string;
  return { token, headers: { authorization: `Bearer ${token}` } };
}

/**
 * A class of the instructor's, made through the API. The staff specs open the
 * class's own page (/teacher/class?class=<id>) rather than the teacher home:
 * the home reads every learner in every one of the teacher's classes with one
 * GET /instructor/learners/:userId each, and that route allows 60 a minute per
 * account, so over a suite's worth of classes a few home loads in a minute are
 * refused ("rate limit exceeded — slow down") and the home draws no classes.
 * The class page reads only its own learners.
 */
export async function classByApi(
  request: APIRequestContext,
  className: string,
): Promise<{ staff: StaffParty; cohortId: string; joinCode: string }> {
  const staff = await staffByApi(request);
  const made = await request.post(`${API}/instructor/cohorts`, { headers: staff.headers, data: { name: className } });
  expect(made.ok(), 'the class is created').toBeTruthy();
  const cohort = await made.json();
  return { staff, cohortId: cohort.id as string, joinCode: cohort.joinCode as string };
}

/**
 * A class, and a learner in it who has started the project, the state every
 * staff lever needs, made the cheap way.
 */
export async function classWithLearnerByApi(
  request: APIRequestContext,
  className: string,
  who: { email: string; password: string; name: string },
): Promise<{ staff: StaffParty; cohortId: string; joinCode: string; learner: ApiLearner; phases: ApiPhase[] }> {
  const made = await classByApi(request, className);
  const learner = await registerByApi(request, who);
  const joined = await request.post(`${API}/enrollments/join`, { headers: learner.headers, data: { code: made.joinCode } });
  expect(joined.ok(), 'the learner joins the class').toBeTruthy();
  const phases = await enrolByApi(request, learner);
  return { ...made, learner, phases };
}
