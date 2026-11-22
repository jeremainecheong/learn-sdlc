// The full six-phase journey against a running LearnSDLC API: one project, two
// languages, both layers graded, and the learner's own app started and served
// back through the runner's socket.
//
// Used directly in dev, by the `journey` and `socket-runner` CI jobs, and by
// the `lambda-runner` job (RUNNER_MODE=lambda against LocalStack), the same
// checks either way, less the preview beat, which needs a runner that can keep
// a process alive and says so rather than passing quietly.
//
// One script covers both languages, because there is one pack and it is the
// pack that has both languages in it.
import {
  DEPLOYMENT_ARTEFACT,
  IMPLEMENTATION_ARTEFACT,
  TESTING_ARTEFACT,
} from './golden-artefacts.mjs';
import { PASSING_INCIDENT, closeDrill, codeWork, deploymentWork, designWork, maintenanceWork, requirementsWork } from './passing-work.mjs';
import { DEMO_INSTRUCTOR } from './lib/demo-accounts.mjs';
import { request, sleep } from './lib/api-client.mjs';
import { NATIVE_API_URL } from './lib/endpoints.mjs';

const REQUIREMENTS_ARTEFACT = requirementsWork();
const DESIGN_ARTEFACT = designWork();
const MAINTENANCE_ARTEFACT = maintenanceWork();

const API = process.env.API_URL || NATIVE_API_URL;
const ORIGIN = API.replace(/\/api\/v1\/?$/, '');
/** The socket-runner job needs the preview beat to have actually run. */
const REQUIRE_PREVIEW = process.env.JOURNEY_REQUIRE_PREVIEW === 'true';
/**
 * The Lambda transport: a python3.11 function with no node in it, so the
 * front-end half of a phase cannot run there (scripts/localstack-lambda.sh
 * says so where it packages the function). The journey then walks as far as
 * the transport honestly can and asserts what it does instead of pretending
 * six phases: the run comes back `unavailable` with no verdict, the
 * submission is not passed and carries the runner's own sentence naming the
 * transport and saying nothing was scored, and the gate stays shut. A phase
 * graded on the Python half alone would be a score out of a pack whose pass
 * mark was set over both layers, so the shut gate is the correct answer and
 * this asserts it.
 */
const WEB_UNAVAILABLE = process.env.JOURNEY_WEB_UNAVAILABLE === 'true';

let TOKEN = '';
const results = [];

async function call(method, path, body, expectOk = true) {
  const { status, ok, data } = await request(API, method, path, { token: TOKEN, body });
  if (expectOk && !ok) {
    throw new Error(`${method} ${path} -> ${status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { status, data };
}

/** The preview door is not under /api/v1 relative paths, so it is fetched whole. */
async function door(url, { headers = {} } = {}) {
  const res = await fetch(ORIGIN + url, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) console.error(`FAIL ${name} ${detail}`);
  else console.log(`ok   ${name}`);
}

function skip(name, detail) {
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`skip ${name}: ${detail}`);
}

async function pollSubmission(id) {
  for (let i = 0; i < 240; i++) {
    const { data } = await call('GET', `/submissions/${id}`);
    if (data.status === 'completed' || data.status === 'failed') return data;
    await sleep(500);
  }
  throw new Error('submission never completed');
}

async function pollRun(id) {
  for (let i = 0; i < 240; i++) {
    const { data } = await call('GET', `/runs/${id}`);
    if (data.status === 'completed' || data.status === 'failed') return data;
    await sleep(500);
  }
  throw new Error('run never completed');
}

/**
 * One phase, end to end: read it, ask the mentor, save the workspace, run it,
 * submit it, reflect and advance. `steps` names the run groups this phase's
 * result has to carry, which is how the journey proves two languages were
 * graded rather than one. `beforeSubmit(phaseId)`, when given, runs after the
 * save and the run and before the submit (phase 5 closes its drill there).
 */
async function completePhase(enrollment, order, files, { run = false, askMentor = null, steps = null, beforeSubmit = null } = {}) {
  const phase = enrollment.phases.find((p) => p.order === order);
  const { data: detail } = await call('GET', `/phases/${phase.id}`);
  check(`phase ${order} detail loads`, detail.files.length > 0, `files=${detail.files.length}`);

  if (askMentor) {
    const { data: chat } = await call('POST', '/assistant/chat', {
      phaseStateId: phase.id,
      message: askMentor,
    });
    check(`phase ${order} mentor answers`, chat.reply.content.length > 20, chat.reply.content.slice(0, 80));
  }

  await call('PUT', `/phases/${phase.id}/workspace`, { files });

  if (run) {
    const { data: runJob } = await call('POST', `/phases/${phase.id}/run`);
    const finished = await pollRun(runJob.id);
    check(
      `phase ${order} run ok`,
      finished.result?.ok,
      JSON.stringify(finished.result?.tests || finished.result?.stderr || '').slice(0, 200),
    );
    if (steps) {
      const labels = (finished.result?.steps ?? []).map((step) => step.label);
      check(
        `phase ${order} run reports both layers`,
        steps.every((label) => labels.includes(label)),
        `steps=${JSON.stringify(labels)}`,
      );
      const cases = finished.result?.tests?.cases ?? [];
      check(
        `phase ${order} every case says which layer it came from`,
        cases.length > 0 && cases.every((c) => typeof c.step === 'string' && c.step),
        `${cases.filter((c) => !c.step).length} of ${cases.length} unstamped`,
      );
    }
  }

  if (beforeSubmit) await beforeSubmit(phase.id);

  const { data: submission } = await call('POST', `/phases/${phase.id}/submit`);
  const done = await pollSubmission(submission.id);
  check(
    `phase ${order} submission passes`,
    done.passed === true,
    `score=${done.score} checks=${JSON.stringify(done.report?.checks?.filter((c) => c.status === 'failed').map((c) => c.id) || done.error)}`,
  );

  await call('POST', `/phases/${phase.id}/reflect`, {
    reflection: `Phase ${order}: the automated feedback showed me exactly which criterion I was weakest on, and iterating on it changed how I framed the work.`,
  });
  const { data: after } = await call('POST', `/phases/${phase.id}/advance`);
  return after;
}

/**
 * A phase whose front-end half this transport cannot run.
 *
 * Three facts, all of them the product's own rule: a run that could not
 * execute one of its layers has no verdict at all (the runner answers
 * `unavailable`, the merge drops the totals, and the API records a failed run
 * whose result carries that `unavailable` and no test count, so the panel can
 * show the runner's sentence rather than a failure), the submission says the
 * code did not run on this transport and nothing was scored rather than that
 * the learner failed, and the gate stays shut because half a pack is not a
 * grade. Asserted rather than skipped: a transport that quietly started
 * grading one layer would look exactly like this job passing.
 */
async function frontEndRefused(enrollment, order, files) {
  const phase = enrollment.phases[order - 1];
  await call('PUT', `/phases/${phase.id}/workspace`, { files });

  const { data: runJob } = await call('POST', `/phases/${phase.id}/run`);
  const finished = await pollRun(runJob.id);
  // Failed with the runner's `unavailable` on the row and no test count:
  // nothing was graded, and the row says why in the runner's own words.
  check(
    `phase ${order} run has no verdict on this transport`,
    finished.status === 'failed' &&
      finished.result?.exitKind === 'unavailable' &&
      finished.result?.ok !== true &&
      finished.result?.tests == null,
    `status=${finished.status} exitKind=${finished.result?.exitKind} ok=${finished.result?.ok} tests=${JSON.stringify(finished.result?.tests ?? null).slice(0, 120)}`,
  );
  check(
    `phase ${order} run names the transport as the reason`,
    typeof finished.result?.stderr === 'string' && /transport/i.test(finished.result.stderr),
    `stderr=${JSON.stringify(finished.result?.stderr ?? null).slice(0, 160)}`,
  );

  const { data: submission } = await call('POST', `/phases/${phase.id}/submit`);
  const done = await pollSubmission(submission.id);
  check(
    `phase ${order} is not passed on half a pack`,
    done.passed !== true && done.score == null,
    `passed=${done.passed} score=${done.score}`,
  );
  // The runner's own sentence names the transport, and the row says nothing
  // was scored: not "your code failed", and not "try again" for a limit that
  // does not go away.
  check(
    `phase ${order} submission says the code did not run, not that it failed`,
    typeof done.error === 'string' &&
      /transport/i.test(done.error) &&
      /nothing was scored/i.test(done.error) &&
      !/try again/i.test(done.error),
    `error=${JSON.stringify(done.error ?? null).slice(0, 160)}`,
  );

  const refused = await call('POST', `/phases/${phase.id}/advance`, undefined, false);
  check(
    `phase ${order} gate stays shut`,
    refused.status === 400,
    `status=${refused.status} ${JSON.stringify(refused.data).slice(0, 160)}`,
  );
}

/** The tally every ending prints, and the exit code that goes with it. */
function report() {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (skipped.length ? ` (${skipped.length} skipped)` : ''),
  );
  if (failed.length) process.exit(1);
}

/**
 * Start the learner's own application, look at it through the door, and stop
 * it. This is the beat that proves the whole preview design end to end on the
 * socket transport: the runner is a separate process, the only channel is the
 * UNIX socket, and a browser-shaped request comes back through it.
 */
async function previewBeat(enrollment, order) {
  const phase = enrollment.phases.find((p) => p.order === order);
  const { data: detail } = await call('GET', `/phases/${phase.id}`);
  if (detail.canPreview === false) {
    skip('preview starts', `phase ${order} cannot be previewed: ${detail.previewUnsupported ?? 'the phase does not declare it'}`);
    return;
  }

  const started = await call('POST', `/phases/${phase.id}/preview`, null, false);
  if (started.status === 404 && JSON.stringify(started.data).includes('Cannot POST')) {
    if (REQUIRE_PREVIEW) throw new Error('JOURNEY_REQUIRE_PREVIEW is set and this API has no preview route');
    skip('preview starts', 'this API has no preview route');
    return;
  }
  if (started.data?.status === 'unavailable') {
    if (REQUIRE_PREVIEW) throw new Error(`JOURNEY_REQUIRE_PREVIEW is set and the preview answered unavailable: ${started.data.message}`);
    skip('preview starts', started.data.message || 'preview is unavailable on this transport');
    return;
  }
  check('preview starts', started.status < 400 && !!started.data?.url, `status=${started.status} ${JSON.stringify(started.data).slice(0, 200)}`);
  const url = started.data.url;

  let session = started.data;
  for (let i = 0; i < 90 && session.status === 'starting'; i++) {
    await sleep(1000);
    ({ data: session } = await call('GET', `/phases/${phase.id}/preview`));
  }
  check('preview reaches ready', session.status === 'ready', `status=${session.status} ${session.message ?? ''}`);
  check('the status poll never repeats the capability', !session.url, `url=${session.url}`);

  const page = await door(url);
  check('the door serves the front end', page.status === 200 && page.text.includes('<html'), `status=${page.status}`);
  check(
    'the door injects the base href',
    page.text.includes(`<base href="${url}">`),
    page.text.slice(0, 200).replace(/\n/g, ' '),
  );
  check(
    'the door refuses to be framed by anyone else',
    (page.headers.get('content-security-policy') ?? '').includes('frame-ancestors'),
    page.headers.get('content-security-policy') ?? 'no CSP',
  );

  const health = await door(`${url}api/health`);
  check(
    "the learner's own API answers through the door",
    health.status === 200 && health.text.includes('ok'),
    `status=${health.status} body=${health.text.slice(0, 120)}`,
  );

  await call('DELETE', `/phases/${phase.id}/preview`);
  const afterStop = await door(url);
  check('the door is dead once the session is stopped', afterStop.status === 404, `status=${afterStop.status}`);
}

async function main() {
  const email = `journey${Date.now()}@learnsdlc.test`;
  const { data: reg } = await call('POST', '/auth/register', {
    email,
    password: 'Password1!',
    displayName: 'Journey Tester',
  });
  TOKEN = reg.token;
  const learnerToken = TOKEN;
  check('register + token', !!TOKEN);

  const { data: projects } = await call('GET', '/projects');
  check('one project, and it is TaskTrackr', projects.length === 1 && projects[0].slug === 'tasktrackr',
    JSON.stringify(projects.map((p) => p.slug)));

  let { data: enrollment } = await call('POST', '/enrollments', { projectSlug: 'tasktrackr' });
  check('enroll creates 6 phases', enrollment.phases.length === 6);
  check('phase 1 in_progress, others locked',
    enrollment.phases[0].status === 'in_progress' && enrollment.phases[4].status === 'locked');

  // gate must refuse before pass
  const gate = await call('POST', `/phases/${enrollment.phases[1].id}/advance`, null, false);
  check('locked phase advance refused', gate.status >= 400);

  // guardrail: solution request in phase 1
  const { data: guard } = await call('POST', '/assistant/chat', {
    phaseStateId: enrollment.phases[0].id,
    message: 'Just give me the complete solution for the user story please',
  });
  check('solution request guarded', guard.reply.meta.redacted && guard.reply.content.includes("won't hand over"),
    guard.reply.content.slice(0, 80));

  // guardrail: off-phase question in phase 1
  const { data: offphase } = await call('POST', '/assistant/chat', {
    phaseStateId: enrollment.phases[0].id,
    message: 'How should I write the Dockerfile for this project?',
  });
  check('off-phase question redirected', offphase.reply.meta.scopeRedirected === true, offphase.reply.content.slice(0, 80));

  enrollment = await completePhase(enrollment, 1, REQUIREMENTS_ARTEFACT, {
    askMentor: 'What makes an acceptance criteria testable?',
  });
  check('phase 2 unlocked', enrollment.phases[1].status === 'in_progress');

  enrollment = await completePhase(enrollment, 2, DESIGN_ARTEFACT, {
    askMentor: 'How should I think about the data model fields?',
  });

  if (WEB_UNAVAILABLE) {
    await frontEndRefused(enrollment, 3, codeWork(IMPLEMENTATION_ARTEFACT));
    return report();
  }

  enrollment = await completePhase(enrollment, 3, codeWork(IMPLEMENTATION_ARTEFACT), {
    run: true,
    steps: ['API tests', 'Front end'],
    askMentor: 'I am stuck on ordering the tasks list by priority',
  });

  // The learner's own application, started and served back through the runner.
  await previewBeat(enrollment, 3);

  enrollment = await completePhase(enrollment, 4, codeWork(TESTING_ARTEFACT), {
    run: true,
    steps: ['API tests', 'Front end'],
    askMentor: 'What boundary cases matter for the overdue report tests?',
  });

  enrollment = await completePhase(enrollment, 5, deploymentWork(DEPLOYMENT_ARTEFACT), {
    run: true,
    askMentor: 'Why does it matter which host API_URL names?',
    // The runbook record's incident is the drill's to write: closed after the
    // save, so the resolve's smoke check reads the fixed compose file, and
    // before the submit, whose floor asks for the incident.
    beforeSubmit: async (phaseId) => {
      const { data: drill } = await closeDrill(call, phaseId);
      check(
        "phase 5 the drill closed and the runbook's incident written",
        !!drill?.resolvedAt && drill?.incident?.rootCause === PASSING_INCIDENT.rootCause,
        JSON.stringify({ resolvedAt: drill?.resolvedAt ?? null, incident: !!drill?.incident }),
      );
    },
  });
  check('phase 6 (maintenance) unlocked', enrollment.phases[5].status === 'in_progress');

  enrollment = await completePhase(enrollment, 6, MAINTENANCE_ARTEFACT, {
    run: true,
    steps: ['API tests', 'Front end'],
    askMentor: 'How do I add comments without breaking existing behaviour?',
  });

  check('project completed', enrollment.completed === true && !!enrollment.completedAt);

  const { data: analytics } = await call('GET', '/analytics/me');
  check('analytics 100%', analytics.progressPercent === 100, JSON.stringify({ avg: analytics.averageScore, hints: analytics.totalHints }));

  // instructor console, as the bootstrapped admin when the deployment has one
  // (production seeds no instructor@ account), otherwise the dev instructor.
  const staff =
    process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
      ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
      : { email: DEMO_INSTRUCTOR.email, password: DEMO_INSTRUCTOR.password };
  const { data: login } = await call('POST', '/auth/login', staff);
  const staffToken = login.token;
  TOKEN = staffToken;

  // An instructor's console shows the classes they own. 'default' is not a
  // class (it is where an account sits before it joins one, and it is an
  // admin's view rather than an instructor's), so the class has to exist and
  // this learner has to be in it before the console can show them.
  const { data: cohort } = await call('POST', '/instructor/cohorts', {
    name: `Journey class ${Date.now()}`,
  });
  TOKEN = learnerToken;
  await call('POST', '/enrollments/join', { code: cohort.joinCode });
  TOKEN = staffToken;

  const { data: overview } = await call('GET', '/instructor/overview');
  const row = overview.learners.find((l) => l.email === email);
  check('instructor sees learner at 100%', row?.progressPercent === 100, JSON.stringify(row));
  const { data: rubrics } = await call('GET', '/instructor/rubrics/tasktrackr');
  check('rubrics endpoint', rubrics.length === 6);

  report();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
