// Replaying a class plan through the public API.
//
// Every row this writes is written by the route that owns it: register, join,
// enrol, save, ask, run, submit, reflect, advance. There is no direct database
// access anywhere in this file, which is the point: a seeded class is only
// worth looking at if it went through the same gates a real one does.
//
// THE ONE RULE THAT IS NOT OBVIOUS: re-authenticate after every clock move.
// The demo clock replaces `globalThis.Date`, and `jsonwebtoken` reads
// `Date.now()`, so a token minted before a jump looks expired the moment the
// clock passes its `exp`. The day loop below signs everyone in again at the
// top of each day, and `Identity.call` signs in again on a 401 as a backstop.
import { setTimeout as sleep } from 'timers/promises';
import { closeDrill } from '../passing-work.mjs';
import { request } from '../lib/api-client.mjs';
import { filesFor, withMentorPaste } from './artefacts.mjs';

const DAY_MS = 86_400_000;

/* -------------------------------- the API -------------------------------- */

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class Api {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * One request, with the two retries a long replay actually needs: a 429 when
   * twenty-five learners act inside one minute, and a network hiccup. A 4xx
   * that is not 429 is a bug in the plan and is thrown at once.
   *
   * The backoff on a 429 is deliberately long. The API counts sign-ins per
   * address in a fixed sixty-second window (`SIGNIN_MAX_PER_ADDRESS`), and a
   * class arriving from one machine is one address, so the only thing that
   * clears an exhausted window is waiting for it to end. Seven tries at up to
   * twenty seconds rides out a full window; a shorter backoff just spends the
   * retries inside it.
   */
  async request(method, path, { body, token, attempts = 7 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response;
      try {
        response = await request(this.baseUrl, method, path, { token, body });
      } catch (err) {
        lastError = err;
        await sleep(500 * (attempt + 1));
        continue;
      }
      const { status, data } = response;
      if (status === 429 || status === 503) {
        lastError = new ApiError(method, path, status, data);
        await sleep(Math.min(1500 * 2 ** attempt, 20_000));
        continue;
      }
      if (status >= 400) throw new ApiError(method, path, status, data);
      return data;
    }
    throw lastError;
  }
}

/** One signed-in account, which knows how to sign itself in again. */
export class Identity {
  constructor(api, email, password) {
    this.api = api;
    this.email = email;
    this.password = password;
    this.token = '';
    this.userId = '';
  }

  async signIn() {
    const data = await this.api.request('POST', '/auth/login', {
      body: { email: this.email, password: this.password },
    });
    this.token = data.token;
    this.userId = data.user?.id ?? this.userId;
    return this;
  }

  async register(displayName) {
    const data = await this.api.request('POST', '/auth/register', {
      body: { email: this.email, password: this.password, displayName },
    });
    this.token = data.token;
    this.userId = data.user.id;
    return this;
  }

  /** A call as this account; a 401 after a clock move is a fresh sign-in, not a failure. */
  async call(method, path, body) {
    try {
      return await this.api.request(method, path, { body, token: this.token });
    } catch (err) {
      if (err.status !== 401) throw err;
      await this.signIn();
      return this.api.request(method, path, { body, token: this.token });
    }
  }
}

/* ------------------------------- the clock ------------------------------- */

/** Move the API's clock, and hand back what it now believes the time is. */
export async function moveClock(admin, at) {
  return admin.call('POST', '/demo/clock', { at: at.toISOString() });
}

export async function releaseClock(admin) {
  return admin.call('POST', '/demo/clock', { release: true });
}

/* ----------------------------- mentor questions -------------------------- */

/**
 * What a learner asks. Five per phase, because a learner leaning on the mentor
 * asks five times in one sitting and a class where every question is the same
 * question is a fixture rather than a term.
 */
const QUESTIONS = {
  requirements: [
    'What makes an acceptance criterion testable?',
    'How specific should my scope note be?',
    'Is a task due today overdue, or should I decide that in a criterion?',
    'How do I phrase the persona in a user story?',
    'Should completed tasks appear in the overdue report?',
  ],
  design: [
    'How should I think about the data model fields?',
    'What belongs in the HTTP contract for the tasks list?',
    'How do I write a decision that names its trade-off?',
    'Does every field need a story to justify it?',
    'Where should the overdue boundary rule be written down?',
  ],
  implementation: [
    'I am stuck on ordering the tasks list by priority.',
    'What should the complete route do with an id nothing matches?',
    'How do I keep overdue_tasks readable without a lot of branching?',
    'Should isOverdue read the clock itself or be given the day?',
    'Why does the hidden suite disagree with my visible tests?',
  ],
  testing: [
    'What boundary cases matter for the overdue report tests?',
    'How do I test that completing a task changed the stored state?',
    'What does assertRaises look like for an unknown id?',
    'How do I make a test that would catch a reversed sort order?',
    'My suite passes but the score says my tests are weak. Why?',
  ],
  deployment: [
    'Why does instruction order matter in a Dockerfile?',
    'What should the health check in my runbook prove?',
    'How much detail belongs in a rollback section?',
    'What makes a compose service name different from localhost?',
    'What should I write in the incident section after a drill?',
  ],
  maintenance: [
    'How do I add comments without breaking existing behaviour?',
    'Should a change request update the contracts file first?',
    'What does the regression suite protect that the change test does not?',
    'How do I decide between editing a method and adding one?',
    'What belongs in the release notes for this change?',
  ],
};

/**
 * The words a revision was submitted with.
 *
 * Two thirds of the class writes one and the rest does not, so the pull
 * request's log and the dossier both show the "No message" row the product
 * really has. Keyed by phase so the message is about the work in front of
 * them, and picked by the learner's own index so a seed replays identically.
 */
const COMMIT_MESSAGES = {
  requirements: [
    'Write US-4 and its two criteria',
    'Say why a task due today is not overdue',
    'Add the scope note and the exclusion',
  ],
  design: [
    'Record the overdue boundary as decision D1',
    'Fill in the three contracts',
    'Add the due_date field and its type',
  ],
  implementation: [
    'Implement the tasks list and the complete route',
    'Fix the overdue boundary so due today is not overdue',
    'Sort by priority, then by due date',
  ],
  testing: [
    'Add the completed-task case',
    'Cover the boundary the report keeps getting wrong',
    'Name each test after the criterion it checks',
  ],
  deployment: [
    'Point API_URL at the api service, not localhost',
    'Write the runbook health check',
    'Close INCIDENT-1 and write up the root cause',
  ],
  maintenance: [
    'Add comments and the count on the row',
    'Update the contracts before the code',
    'Write the 2.1.0 release in the change request',
  ],
};

/**
 * The day the testing sandbox calls today. Most of the class
 * pins the same one, so their kill matrices are comparable; two learners pin
 * a different day, which is what the matrix's "not comparable" notice is for.
 */
const RUN_CLOCK = '2026-03-01';
const RUN_CLOCK_ODD = '2026-04-15';

/* ------------------------------ the schedule ----------------------------- */

/**
 * The plan, turned into a list of things to do on numbered lab days.
 *
 * Everyone joins on the first two lab days, whatever day their first attempt
 * falls on: a class arrives at a lab, and the audit trail should say so.
 */
export function buildSchedule(plan) {
  const days = new Map();
  const add = (day, step) => {
    const list = days.get(day);
    if (list) list.push(step);
    else days.set(day, [step]);
  };

  for (const persona of plan.personas) {
    const firstAttemptDay = Math.min(
      ...persona.phases.flatMap((phase) => phase.attempts.map((attempt) => attempt.day)),
    );
    // The class arrives at a lab, so the joins land on the first two days,
    // unless somebody's first attempt is earlier than that, which would leave
    // them submitting to a phase they had not enrolled in.
    add(Math.min(persona.index % 2, firstAttemptDay), { kind: 'enrol', persona });
    for (const phase of persona.phases) {
      phase.attempts.forEach((attempt, i) => {
        add(attempt.day, {
          kind: 'attempt',
          persona,
          phase,
          attempt,
          // Which try this is, so the commit message a revision carries moves
          // with the revision rather than repeating.
          attemptIndex: i,
          last: i === phase.attempts.length - 1,
        });
      });
    }
  }
  return new Map([...days.entries()].sort((a, b) => a[0] - b[0]));
}

/* ------------------------------ the replay ------------------------------- */

/** Run `jobs` with at most `limit` in flight, preserving nothing but the errors. */
async function pool(jobs, limit) {
  const queue = [...jobs];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      await job();
    }
  });
  await Promise.all(workers);
}

const poll = async (fetchOne, done, tries = 400, waitMs = 400) => {
  let value;
  for (let i = 0; i < tries; i++) {
    value = await fetchOne();
    if (done(value)) return value;
    await sleep(waitMs);
  }
  throw new Error('a job never reached a verdict');
};

/**
 * One learner's live state during the replay: their account, their enrolment,
 * and the phase state id per phase order, which changes as they advance,
 * because `advance` is what unlocks the next phase's row.
 */
class Learner {
  constructor(api, persona, plan) {
    this.persona = persona;
    this.identity = new Identity(api, persona.email, plan.password);
    this.phaseIds = new Map();
    this.loaded = new Set();
    this.lastReply = '';
    this.submissions = 0;
    this.failures = [];
  }

  rememberPhases(enrollment) {
    for (const phase of enrollment.phases) this.phaseIds.set(phase.order, phase.id);
  }
}

/**
 * Replay a whole class. `hooks.onLearner` is called once per learner when
 * their last step is done, and `hooks.onDay` at the top of each lab day.
 */
export async function replayClass({
  api,
  plan,
  admin,
  joinCode,
  projectSlug,
  today,
  concurrency,
  useClock,
  hooks = {},
}) {
  const learners = new Map(
    plan.personas.map((persona) => [persona.index, new Learner(api, persona, plan)]),
  );
  const schedule = buildSchedule(plan);
  const remaining = new Map(plan.personas.map((persona) => [persona.index, 0]));
  for (const steps of schedule.values()) {
    for (const step of steps) remaining.set(step.persona.index, remaining.get(step.persona.index) + 1);
  }

  const instantFor = (day) => new Date(today.getTime() - (plan.termDays - day) * DAY_MS);

  for (const [day, steps] of schedule) {
    if (useClock) {
      // No proactive re-authentication, on purpose. A token lasts seven days
      // and the clock moves one, so signing everybody in at the top of every
      // lab day is twenty-seven sign-ins a day from one address, which is what
      // exhausts the API's per-address window (`SIGNIN_MAX_PER_ADDRESS`) part
      // way through a run. `Identity.call` signs in again on the 401 the jump
      // eventually causes, which is one sign-in per account per week of term.
      await moveClock(admin, instantFor(day));
    }
    hooks.onDay?.(day, instantFor(day), steps.length);

    const byPersona = new Map();
    for (const step of steps) {
      const list = byPersona.get(step.persona.index);
      if (list) list.push(step);
      else byPersona.set(step.persona.index, [step]);
    }

    await pool(
      [...byPersona.entries()].map(([index, personaSteps]) => async () => {
        const learner = learners.get(index);
        for (const step of personaSteps) {
          try {
            if (step.kind === 'enrol') {
              await enrol(learner, { joinCode, projectSlug });
            } else {
              await runAttempt(learner, step);
            }
          } catch (err) {
            learner.failures.push(`${step.kind} ${step.phase?.key ?? ''}: ${err.message}`);
            throw err;
          }
          remaining.set(index, remaining.get(index) - 1);
          if (remaining.get(index) === 0) hooks.onLearner?.(learner);
        }
      }),
      concurrency,
    );
  }

  return learners;
}

async function enrol(learner, { joinCode, projectSlug }) {
  await learner.identity.register(learner.persona.displayName);
  await learner.identity.call('POST', '/enrollments/join', { code: joinCode });
  // The join moved this account into the class, and the guard caches the row
  // it read; signing in again is the cheapest way to hold a token that agrees.
  await learner.identity.signIn();
  const enrollment = await learner.identity.call('POST', '/enrollments', { projectSlug });
  learner.rememberPhases(enrollment);
}

async function runAttempt(learner, step) {
  const { persona, phase, attempt, attemptIndex = 0, last } = step;
  const id = learner.phaseIds.get(phase.order);
  if (!id) throw new Error(`phase ${phase.order} is not unlocked for ${persona.email}`);

  if (!learner.loaded.has(phase.order)) {
    await learner.identity.call('GET', `/phases/${id}`);
    learner.loaded.add(phase.order);
  }

  const bank = QUESTIONS[phase.key];
  for (let i = 0; i < attempt.hints; i++) {
    const chat = await learner.identity.call('POST', '/assistant/chat', {
      phaseStateId: id,
      message: bank[(persona.index + i) % bank.length],
    });
    learner.lastReply = chat?.reply?.content ?? learner.lastReply;
  }

  let files = filesFor(attempt.variant);
  if (attempt.pasteMentorReply) files = withMentorPaste(files, learner.lastReply);
  await learner.identity.call('PUT', `/phases/${id}/workspace`, { files });

  if (attempt.ran) {
    const started = await learner.identity.call('POST', `/phases/${id}/run`);
    await poll(
      () => learner.identity.call('GET', `/runs/${started.id}`),
      (run) => run.status === 'completed' || run.status === 'failed',
    );
  }

  // The day the sandbox calls today, before the run and the
  // submit that read it, and only on the phase whose suite has a clock to read.
  if (phase.key === 'testing') {
    await learner.identity.call('PUT', `/phases/${id}/clock`, {
      date: persona.index % 12 === 5 ? RUN_CLOCK_ODD : RUN_CLOCK,
    });
  }

  // The incident drill, worked the way the phase asks for it: get paged
  // against the pack's faulted copy, prove the container starts again with a
  // health check, and only then write the incident up. The resolve writes the
  // runbook record's incident, which the runbook floor asks for, so a learner
  // dealt the full deployment closes it after the save and before the submit.
  // `drillResolve` refuses a write-up that has not seen a check go from red to
  // green, so the order in closeDrill is the behaviour rather than a convention.
  if (attempt.variant === 'deployment-full') {
    await closeDrill((method, path, body) => learner.identity.call(method, path, body), id);
  }

  // Two thirds of the revisions carry the words that make the revision list a
  // log; the other third leaves the "No message" row for the product to draw.
  const bankOfMessages = COMMIT_MESSAGES[phase.key] ?? [];
  const writesMessage = bankOfMessages.length > 0 && (persona.index + attemptIndex) % 3 !== 2;
  const message = writesMessage
    ? bankOfMessages[(persona.index + attemptIndex) % bankOfMessages.length]
    : undefined;
  const submitted = await learner.identity.call(
    'POST',
    `/phases/${id}/submit`,
    message ? { message } : undefined,
  );
  const verdict = await poll(
    () => learner.identity.call('GET', `/submissions/${submitted.id}`),
    (row) => row.status === 'completed' || row.status === 'failed',
  );
  learner.submissions += 1;

  if (!last || !phase.advanced) return;

  if (verdict.passed !== true) {
    // The plan promised this artefact opens the gate (class-plan.spec.ts,
    // "finishes every merged phase on an artefact that opens the gate"), so
    // this is the pack's rubric having moved, not a flaky run.
    throw new Error(
      `${persona.email} needed ${phase.key} to pass so they could advance, and it scored ` +
        `${verdict.score} on "${attempt.variant}"`,
    );
  }
  await learner.identity.call('POST', `/phases/${id}/reflect`, { reflection: phase.reflection });
  const enrollment = await learner.identity.call('POST', `/phases/${id}/advance`);
  learner.rememberPhases(enrollment);
}
