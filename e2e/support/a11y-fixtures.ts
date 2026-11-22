import { expect, request as pwRequest, type Browser, type BrowserContext } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INSTRUCTOR, PASSING_DESIGN, PASSING_REQUIREMENTS, passPhaseByApi, type ApiPhase } from '../passing-work';
import { LEARNER_PASSWORD, signInAs } from '../pw-fixtures';
import { shelfArchive } from '../upload-helpers';
import { API, RUN_ID } from './env';
import { NAVIGATION, SANDBOX_RUN, UI_READY } from './timeouts';

/*
 * The accessibility spec's fixtures (e2e/a11y-axe.spec.ts): the accounts,
 * classes and projects its screens are opened on, made through the API once
 * per run and kept in a file under the system's temporary folder, so a worker
 * that restarts after a failure finds them again; and one signed-in browser
 * session per role.
 */

/* -------------------------------- fixture -------------------------------- */

export type Role = 'public' | 'learner' | 'newcomer' | 'plain' | 'teacher';

export interface Ids {
  tag: string;
  projectId: string;
  draftVersionId: string;
  publishedVersionId: string;
  cohortId: string;
  learnerId: string;
  quizPhase: string;
  phases: Record<string, string>;
  /** The learner on a teacher's project whose Requirements has no interview. */
  plainPhases: Record<string, string>;
}

const emailFor = (tag: string, who: string) => `axe-${tag}-${who}@example.test`;

export async function call<T = unknown>(method: string, route: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(API + route, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The route with its ids blanked and the status: never a body that could carry a token.
    throw new Error(`fixture: ${method} ${route.replace(/[0-9a-f-]{36}/g, ':id')} -> ${res.status}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const signInApi = async (email: string, password: string): Promise<string> =>
  (await call<{ token: string }>('POST', '/auth/login', null, { email, password })).token;

async function newLearner(tag: string, who: string, displayName: string, finishSetup: boolean) {
  const email = emailFor(tag, who);
  await call('POST', '/auth/register', null, { email, password: LEARNER_PASSWORD, displayName });
  const token = await signInApi(email, LEARNER_PASSWORD);
  const me = await call<{ id: string; profileVersion?: number }>('GET', '/auth/me', token);
  const done = async () =>
    call('PATCH', '/account/profile', token, { displayName, onboardingCompleted: true, baseVersion: me.profileVersion || 0 });
  return { token, id: me.id, finishSetup: finishSetup ? done : async () => undefined };
}

const questions = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    stem: `Accessibility fixture question ${i + 1}. Option A is keyed.`,
    options: [
      { id: 'a', text: 'Option A, the keyed option.' },
      { id: 'b', text: 'Option B, the other option.' },
    ],
    correct: ['a'],
    explanation: `Accessibility fixture explanation ${i + 1}.`,
    concept: `a11y-concept-${i + 1}`,
  }));
const quizBody = (prefix: string) => ({
  questions: questions(6, prefix),
  shuffleOptions: true,
  passMark: 80,
  attempts: { max: null, cooldownSeconds: null },
  criterion: 'concepts',
});

const phasesOf = (enrolled: { phases: { id: string; key: string; order: number }[] }) =>
  Object.fromEntries([...enrolled.phases].sort((a, b) => a.order - b.order).map((p) => [p.key, p.id]));

/**
 * The fixture: a teacher's copy of the platform project with two authored quizzes
 * (no authored written task: Requirements holds one story, Design one design, a code
 * phase one task and Deployment is a config phase, so a copy has no phase to put one
 * in; the reset and the files' room are read on Design's inherited `main` task), a class pinned to it, one learner with all six phases
 * opened by the teacher's reopen lever (no Pass is seeded), a quiz paper left
 * open and another marked, a fresh draft for the editor and a learner who has
 * not finished setup. Plus a second copy whose Requirements has no
 * interview, its own class and a learner on it.
 */
async function makeFixture(): Promise<Ids> {
  const tag = `${RUN_ID}-${crypto.randomBytes(2).toString('hex')}`;
  const tt = await signInApi(INSTRUCTOR.email, INSTRUCTOR.password);

  const library = await call<{ library: { isDefault: boolean; publishedVersionId: string }[] }>('GET', '/instructor/projects', tt);
  const platform = library.library.find((p) => p.isDefault);
  if (!platform) throw new Error('fixture: the platform project is not in the library');

  const cohort = await call<{ id: string; joinCode: string }>('POST', '/instructor/cohorts', tt, { name: `Accessibility ${tag}` });
  const slug = `axe-desk-${tag}`;
  const made = await call<{ project: { id: string }; draftVersionId: string }>('POST', '/instructor/projects', tt, {
    title: 'Accessibility Desk',
    slug,
    fromVersionId: platform.publishedVersionId,
  });
  const projectId = made.project.id;
  const draft = made.draftVersionId;
  const tasks = (phase: string) => `/instructor/projects/${projectId}/versions/${draft}/phases/${phase}/tasks`;
  let quizPhase = 'requirements';
  try {
    await call('POST', tasks('requirements'), tt, { taskKey: 'concepts', title: 'Check the requirements concepts', brief: 'Fixture quiz.', artefactType: 'quiz', required: false, quiz: quizBody('r') });
  } catch {
    quizPhase = 'design';
    await call('POST', tasks('design'), tt, { taskKey: 'concepts', title: 'Check the design concepts', brief: 'Fixture quiz.', artefactType: 'quiz', required: false, quiz: quizBody('r') });
  }
  await call('POST', tasks('design'), tt, { taskKey: 'design-check', title: 'Check the design ideas', brief: 'Fixture quiz.', artefactType: 'quiz', required: false, quiz: quizBody('d') });
  const published = await call<{ versionId: string }>('POST', `/instructor/projects/${projectId}/versions/${draft}/publish`, tt, { version: '1.0.0', notes: 'Accessibility fixture.' });
  await call('PUT', `/instructor/cohorts/${cohort.id}/project`, tt, { projectVersionId: published.versionId, reason: 'Accessibility fixture class.' });
  const nextDraft = await call<{ versionId: string }>('POST', `/instructor/projects/${projectId}/versions`, tt, { fromVersionId: published.versionId });

  const learner = await newLearner(tag, 'l', 'Ama Access', true);
  await call('POST', '/enrollments/join', learner.token, { code: cohort.joinCode });
  const phases = phasesOf(await call('POST', '/enrollments', learner.token, { projectSlug: slug }));
  await learner.finishSetup();
  for (const [key, id] of Object.entries(phases)) {
    if (key === 'requirements') continue;
    await call('POST', `/instructor/learners/${learner.id}/phases/${id}/override`, tt, {
      action: 'reopen',
      reason: 'Accessibility fixture: opened for rendering only; no Pass is seeded.',
    });
  }
  // A paper left open, and a paper handed in and marked.
  await call('POST', `/phases/${phases[quizPhase]}/tasks/concepts/quiz/attempts`, learner.token);
  const paper = await call<{ attemptId: string; questions: { id: string; options: { id: string; text: string }[] }[] }>(
    'POST',
    `/phases/${phases.design}/tasks/design-check/quiz/attempts`,
    learner.token,
  );
  const answers: Record<string, string[]> = {};
  for (const q of paper.questions) answers[q.id] = [(q.options.find((o) => o.text.startsWith('Option A')) || q.options[0]).id];
  const handed = await call<{ id: string }>('POST', `/phases/${phases.design}/tasks/design-check/quiz/attempts/${paper.attemptId}`, learner.token, { answers });
  await expect
    .poll(async () => (await call<{ status: string }>('GET', `/submissions/${handed.id}`, learner.token)).status, { timeout: UI_READY })
    .toMatch(/^(completed|failed)$/);

  await newLearner(tag, 'n', 'Ola Access', false);

  // A Requirements room with no interview.
  const plainCohort = await call<{ id: string; joinCode: string }>('POST', '/instructor/cohorts', tt, { name: `Accessibility plain ${tag}` });
  const plainSlug = `axe-plain-${tag}`;
  const plain = await call<{ project: { id: string }; draftVersionId: string }>('POST', '/instructor/projects', tt, {
    title: 'Accessibility Plain Desk',
    slug: plainSlug,
    fromVersionId: platform.publishedVersionId,
  });
  await call('DELETE', `/instructor/projects/${plain.project.id}/versions/${plain.draftVersionId}/phases/requirements/interview`, tt);
  const plainPublished = await call<{ versionId: string }>('POST', `/instructor/projects/${plain.project.id}/versions/${plain.draftVersionId}/publish`, tt, {
    version: '1.0.0',
    notes: 'Accessibility fixture: no interview.',
  });
  await call('PUT', `/instructor/cohorts/${plainCohort.id}/project`, tt, { projectVersionId: plainPublished.versionId, reason: 'Accessibility fixture class.' });
  const plainLearner = await newLearner(tag, 'p', 'Ivo Access', true);
  await call('POST', '/enrollments/join', plainLearner.token, { code: plainCohort.joinCode });
  const plainPhases = phasesOf(await call('POST', '/enrollments', plainLearner.token, { projectSlug: plainSlug }));
  await plainLearner.finishSetup();

  return {
    tag,
    projectId,
    draftVersionId: nextDraft.versionId,
    publishedVersionId: published.versionId,
    cohortId: cohort.id,
    learnerId: learner.id,
    quizPhase,
    phases,
    plainPhases,
  };
}

/**
 * One fixture per run. A failed test restarts the worker, and the worker
 * would otherwise make the whole fixture again, so its ids (never a password
 * or a token) are kept for the run in a private temporary file.
 */
const FIXTURE_FILE = path.join(os.tmpdir(), `learnsdlc-a11y-axe-${RUN_ID}.json`);
let fixture: Promise<Ids> | null = null;
export function ids(): Promise<Ids> {
  fixture ||= (async () => {
    try {
      return JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as Ids;
    } catch {
      const made = await makeFixture();
      fs.writeFileSync(FIXTURE_FILE, JSON.stringify(made), { mode: 0o600 });
      return made;
    }
  })();
  return fixture;
}

/** Signed-in browser storage, one sign-in per role per worker. */
const sessions = new Map<Role, Promise<Awaited<ReturnType<BrowserContext['storageState']>>>>();
export function session(browser: Browser, role: Exclude<Role, 'public'>, fx: Ids) {
  if (!sessions.has(role)) {
    const who =
      role === 'teacher'
        ? INSTRUCTOR
        : { email: emailFor(fx.tag, role === 'learner' ? 'l' : role === 'newcomer' ? 'n' : 'p'), password: LEARNER_PASSWORD };
    sessions.set(
      role,
      (async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        try {
          const page = await ctx.newPage();
          await page.goto('/login', { waitUntil: 'domcontentloaded' });
          await signInAs(page, who.email, who.password);
          await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: NAVIGATION });
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
          return await ctx.storageState();
        } finally {
          await ctx.close();
        }
      })(),
    );
  }
  return sessions.get(role)!;
}

/* ------------------------ upload and sign-off fixture ----------------------- */

/**
 * The upload screens' own fixture, made only for a test whose label starts
 * "Upload: " (the spec's beforeEach), so the other screens never wait on it: the
 * `shelf` fixture project (shelfArchive) uploaded through the API as the
 * teacher's draft (the upload door, the
 * executable editor, deep validation's cost warning), and a class whose
 * project marks Design's one task, the design, `signOff` with a learner
 * waiting on it (a Design phase holds exactly one task, so nothing is
 * added beside it; the learner passes Requirements on the story record first,
 * so Design opens, then hands in the marked design)
 * (the sign-off queue; the quiz-results export block). No AI model: the one
 * review it asks for goes to the loopback stub, before the test reads the
 * stub's counts. The spec's write fence still holds: every upload screen is
 * checked with writes aborted.
 */
export interface UploadIds {
  uploadProjectId: string;
  uploadDraftVersionId: string;
  signCohortId: string;
}

async function makeUploadFixture(): Promise<UploadIds> {
  const tag = `${RUN_ID}-${crypto.randomBytes(2).toString('hex')}`;
  const tt = await signInApi(INSTRUCTOR.email, INSTRUCTOR.password);
  const uploaded = await call<{ projectId: string; versionId: string }>('POST', '/instructor/projects/upload', tt, {
    title: `Accessibility Shelf ${tag}`,
    archiveBase64: shelfArchive().toString('base64'),
  });
  let signCohortId = '';
  // A class with one learner waiting on a countersignature (the task marked through the editor's route).
  const library = await call<{ library: { isDefault: boolean; publishedVersionId: string }[] }>('GET', '/instructor/projects', tt);
  const platform = library.library.find((p) => p.isDefault);
  if (!platform) throw new Error('upload fixture: the platform project is not in the library');
  const slug = `axe-sign-${tag}`;
  const made = await call<{ project: { id: string }; draftVersionId: string }>('POST', '/instructor/projects', tt, {
    title: 'Accessibility Sign-off Desk',
    slug,
    fromVersionId: platform.publishedVersionId,
  });
  const at = `/instructor/projects/${made.project.id}/versions/${made.draftVersionId}`;
  // Design's one task, the design, is the countersigned one: a Design phase holds exactly one task.
  const draft = await call<{ phases: { key: string; tasks: { taskKey: string }[] }[] }>('GET', at, tt);
  const designKey = draft.phases.find((one) => one.key === 'design')?.tasks[0]?.taskKey;
  if (!designKey) throw new Error('upload fixture: the copy has no Design task');
  const marked = await call<{ phase: { tasks: { taskKey: string; signOff?: boolean }[] } }>('PATCH', `${at}/phases/design/tasks/${encodeURIComponent(designKey)}`, tt, { signOff: true });
  if (marked.phase.tasks.find((one) => one.taskKey === designKey)?.signOff !== true) throw new Error('upload fixture: the design task is not marked');
  const published = await call<{ versionId: string }>('POST', `${at}/publish`, tt, { version: '1.0.0', notes: 'Accessibility fixture: a design to countersign.' });
  const cohort = await call<{ id: string; joinCode: string }>('POST', '/instructor/cohorts', tt, { name: `Accessibility sign-off ${tag}` });
  await call('PUT', `/instructor/cohorts/${cohort.id}/project`, tt, { projectVersionId: published.versionId, reason: 'Accessibility fixture class.' });
  const learner = await newLearner(tag, 's', 'Sol Access', true);
  await call('POST', '/enrollments/join', learner.token, { code: cohort.joinCode });
  const enrolled = await call<{ phases: ApiPhase[] }>('POST', '/enrollments', learner.token, { projectSlug: slug });
  const phases = phasesOf(enrolled);
  await learner.finishSetup();
  // Requirements first, on the story record (its sole task), so Design opens.
  const http = await pwRequest.newContext();
  try {
    await passPhaseByApi(http, { headers: { authorization: `Bearer ${learner.token}` } }, enrolled.phases, 1, PASSING_REQUIREMENTS, 'Requirements: the floor named the boundary I had left out.');
  } finally {
    await http.dispose();
  }
  // The design, written as the room's forms write it and marked, handed in: the stub passes it and it waits.
  await call('PUT', `/phases/${phases.design}/workspace`, learner.token, { files: PASSING_DESIGN });
  const handed = await call<{ id: string }>('POST', `/phases/${phases.design}/tasks/${encodeURIComponent(designKey)}/submit`, learner.token);
  await expect
    .poll(async () => (await call<{ status: string; passed?: boolean }>('GET', `/submissions/${handed.id}`, learner.token)).passed, { timeout: SANDBOX_RUN })
    .toBe(true);
  signCohortId = cohort.id;
  return { uploadProjectId: uploaded.projectId, uploadDraftVersionId: uploaded.versionId, signCohortId };
}

const UPLOAD_FIXTURE_FILE = path.join(os.tmpdir(), `learnsdlc-a11y-axe-upload-${RUN_ID}.json`);
let uploadFixture: Promise<UploadIds> | null = null;
export function uploadIds(): Promise<UploadIds> {
  uploadFixture ||= (async () => {
    try {
      return JSON.parse(fs.readFileSync(UPLOAD_FIXTURE_FILE, 'utf8')) as UploadIds;
    } catch {
      const made = await makeUploadFixture();
      fs.writeFileSync(UPLOAD_FIXTURE_FILE, JSON.stringify(made), { mode: 0o600 });
      return made;
    }
  })();
  return uploadFixture;
}
