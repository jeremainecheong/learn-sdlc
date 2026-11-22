// What scripts/author-requirements.mjs, author-design.mjs, author-deployment.mjs
// and author-maintenance.mjs share: one API call, the copy -> edit -> publish ->
// new class -> assign sequence a teacher's builder runs, the limits their
// bodies respect, and the command-line entry point the authoring scripts use
// when they are run directly. Each script supplies only its phase's edit and
// its own copy, publish and assign bodies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mustOk } from './lib/api-client.mjs';
import { DEMO_INSTRUCTOR, stackInstructor } from './lib/demo-accounts.mjs';
import { STACK_API_URL } from './lib/endpoints.mjs';
import { readEnvFile } from './stack-seed.mjs';

/** The longest task title the API accepts (TASK_TITLE_MAX, apps/api/src/authoring/draft.ts). */
export const TITLE_MAX = 160;

/** The longest project slug the API accepts (CreateProjectDto.slug, apps/api/src/authoring/authoring.dto.ts). */
const SLUG_MAX = 48;

/** A project slug no other copy has: `prefix`, then the time and a random tail, cut to the API's limit. */
export function proofSlug(prefix) {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${tag}`.slice(0, SLUG_MAX);
}

/** One JSON call; a refusal throws with the API's own sentence and the route's ids left out. */
export function call(api, token, method, route, body) {
  return mustOk(api, method, route, { token, body });
}

/**
 * Copy the platform's published default project, run `edit(at)` on the
 * draft (`at` is the draft version's route), publish, open a class and give
 * the class the copy. Returns what a learner needs to reach it.
 * @returns {Promise<{ projectId: string, versionId: string, joinCode: string }>}
 */
export async function authorCopy({ api, token, title, copyBody, edit, publishBody, assignBody }) {
  const library = await call(api, token, 'GET', '/instructor/projects');
  const platform = (library.library ?? []).find((one) => one.isDefault);
  if (!platform?.publishedVersionId) throw new Error('the library has no published default project to copy');

  const made = await call(api, token, 'POST', '/instructor/projects', copyBody(title, platform.publishedVersionId));
  const projectId = made.project?.id;
  const draftId = made.draftVersionId;
  if (!projectId || !draftId) throw new Error('the copy answered without a project or a draft');
  const at = `/instructor/projects/${projectId}/versions/${draftId}`;

  await edit(at);

  const published = await call(api, token, 'POST', `${at}/publish`, publishBody());
  const versionId = published.versionId;
  if (!versionId) throw new Error('the publish answered without a version');

  const cohort = await call(api, token, 'POST', '/instructor/cohorts', { name: `${title} class` });
  await call(api, token, 'PUT', `/instructor/cohorts/${cohort.id}/project`, assignBody(versionId));
  return { projectId, versionId, joinCode: cohort.joinCode };
}

/**
 * The command line every authoring script takes: `--api` (API_URL, then the
 * local stack's API) and `--title` (`titlePrefix` and the time).
 */
export function parseAuthorArgs(argv, titlePrefix) {
  const opt = { api: process.env.API_URL || STACK_API_URL, title: `${titlePrefix} ${Date.now()}` };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api') opt.api = argv[++i].replace(/\/$/, '');
    else if (argv[i] === '--title') opt.title = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  return opt;
}

/**
 * The demo instructor at `api`: on the local Compose stack, the one
 * scripts/stack-seed.mjs made, whose password .env.verify holds; anywhere
 * else, the native demo's (SEED_PASSWORD overrides its password).
 */
export function demoInstructorAt(api, envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.verify')) {
  if (api.replace(/\/+$/, '') === STACK_API_URL && fs.existsSync(envFile)) {
    const { email, password } = stackInstructor(readEnvFile(envFile));
    return { email, password };
  }
  return { email: DEMO_INSTRUCTOR.email, password: DEMO_INSTRUCTOR.password };
}

/** Sign in as the demo instructor at `api` (demoInstructorAt): `{ token }`. */
export async function signInAsDemoInstructor(api) {
  const login = await call(api, '', 'POST', '/auth/login', demoInstructorAt(api));
  return { token: login.token };
}

/** The line an authoring script prints: the title it published and the class's join code. */
const publishedLine = (made, { title }) => `Published "${title}"; a learner joins its class with code ${made.joinCode}.`;

/**
 * When `moduleUrl` is the script node was asked to run: read the command
 * line, sign in (`signIn(api)` answers the extra arguments `run` takes; the
 * demo instructor's `{ token }` unless told otherwise), run
 * `run({ api, title, ...signedIn })` and print `report(result, { api, title })`.
 * Any failure prints its sentence and exits 1.
 */
export function runWhenMain(moduleUrl, run, titlePrefix, { signIn = signInAsDemoInstructor, report = publishedLine } = {}) {
  if (!process.argv[1] || fileURLToPath(moduleUrl) !== process.argv[1]) return;
  (async () => {
    const opt = parseAuthorArgs(process.argv.slice(2), titlePrefix);
    const signedIn = await signIn(opt.api);
    const result = await run({ api: opt.api, ...signedIn, title: opt.title });
    console.log(report(result, opt));
  })().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
