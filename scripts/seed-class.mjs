#!/usr/bin/env node
// Seed a class of twenty-five learners into a running LearnSDLC API, so the
// instructor console reads like week seven of a term rather than like a
// fixture.
//
//   npm run seed:class                     seed it
//   npm run seed:class -- --remove         take it out again
//   npm run seed:class -- --at 2026-09-24T14:00+08:00   pin "today"
//
// Every row goes through the public API. The one thing this script does that a
// learner cannot is move the clock (POST /demo/clock, admin only, loopback
// only, DEMO_CLOCK=true only), which is what puts five weeks of dates on rows
// written in ten minutes.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { filesFor, packDrift } from './seed-class/artefacts.mjs';
import { Api, Identity, moveClock, releaseClock, replayClass } from './seed-class/replay.mjs';
import { DEMO_ADMIN, DEMO_INSTRUCTOR } from './lib/demo-accounts.mjs';
import { NATIVE_API_URL } from './lib/endpoints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The plan is TypeScript compiled to CommonJS; ESM has no require of its own.
const require = createRequire(import.meta.url);
const DAY_MS = 86_400_000;

/* -------------------------------- the flags ------------------------------ */

function parseArgs(argv) {
  const options = {
    seed: 20260401,
    remove: false,
    force: false,
    at: null,
    concurrency: 4,
    project: 'tasktrackr',
    clock: true,
    anyMentor: false,
    quiet: false,
    api: process.env.API_URL || NATIVE_API_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--seed') options.seed = Number(next());
    else if (arg === '--remove') options.remove = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--at') options.at = next();
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(next()));
    else if (arg === '--project') options.project = next();
    else if (arg === '--no-clock') options.clock = false;
    else if (arg === '--any-mentor') options.anyMentor = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--api') options.api = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else {
      console.error(`Unknown option ${arg}. Try --help.`);
      process.exit(1);
    }
  }
  return options;
}

const HELP = `Seed a class of 25 learners through the public API.

  --seed <n>          which class to deal (default 20260401)
  --at <ISO>          pin "today", for a reproducible screenshot
  --concurrency <n>   learners replayed at once (default 4)
  --project <slug>    content pack (default tasktrackr)
  --remove            delete the seeded accounts and their work
  --force             replay over a class that is already seeded
  --no-clock          seed a flat class, all dated today
  --any-mentor        allow a live model to answer (hints stop being reproducible)
  --api <url>         API base (default $API_URL or http://localhost:4000/api/v1)
  --quiet             one line per lab day instead of one per learner
`;

/* ------------------------------- the plan -------------------------------- */

/**
 * The plan lives in `apps/api/src/demo/class-plan.ts`, beside the spec that
 * asserts its shape. Prefer the build output; fall back to ts-node so the
 * seeder works in a worktree nobody has built yet.
 */
function loadPlanModule() {
  const compiled = path.join(ROOT, 'apps', 'api', 'dist', 'demo', 'class-plan.js');
  const source = path.join(ROOT, 'apps', 'api', 'src', 'demo', 'class-plan.ts');
  const fresh =
    fs.existsSync(compiled) &&
    fs.existsSync(source) &&
    fs.statSync(compiled).mtimeMs >= fs.statSync(source).mtimeMs;
  if (fresh) return require(compiled);
  require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
  return require(source);
}

/**
 * Everything that can be checked without a network round trip, checked before
 * the first one: the pack's acceptance suite still assembles into itself, and
 * every artefact the plan names still resolves to files. Both would otherwise
 * surface as a mysterious failure eight minutes into a replay.
 */
function selfCheck(plan) {
  const drift = packDrift();
  if (drift) return drift;
  const variants = new Set(
    plan.personas.flatMap((persona) =>
      persona.phases.flatMap((phase) => phase.attempts.map((attempt) => attempt.variant)),
    ),
  );
  for (const variant of variants) {
    try {
      filesFor(variant);
    } catch (err) {
      return `the class plan asks for an artefact this seeder cannot build: ${err.message}`;
    }
  }
  return null;
}

/* ------------------------------- the guards ------------------------------ */

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

const isLoopback = (apiUrl) => {
  try {
    return LOOPBACK.test(new URL(apiUrl).hostname);
  } catch {
    return false;
  }
};

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

/* ------------------------------- the output ------------------------------ */

const pad = (value, width) => String(value).padEnd(width);

function printSummary({ plan, className, joinCode, elapsedMs, apiUrl, dbPath }) {
  const minutes = Math.floor(elapsedMs / 60000);
  const seconds = Math.round((elapsedMs % 60000) / 1000);
  console.log(`==> Done in ${minutes}m ${seconds}s`);
  console.log(`  Class      ${className}, join code ${joinCode}`);
  console.log(
    `  Sign in    ${plan.personas[0].email} and the rest, password ${plan.password}`,
  );
  console.log(`  Console    ${process.env.WEB_ORIGIN || 'http://localhost:3000'}/instructor`);
  console.log('  Remove     npm run seed:class -- --remove');
  if (dbPath.exists) {
    const mb = (dbPath.bytes / 1_048_576).toFixed(1);
    console.log(
      `  Database   ${dbPath.path} is now ${mb} MB. Workspace snapshots are the bulk of it; ` +
        'retention keeps the newest five revisions per phase (runbook, retention).',
    );
  } else {
    console.log(
      `  Database   not found at ${dbPath.path}. The API is a separate process; set DB_PATH to ` +
        'the file it is writing to and the size is printed here.',
    );
  }
}

/**
 * The store the API is writing to, as best this process can tell: it is a
 * different process and may have been started anywhere, so DB_PATH is the
 * answer when it is set and the two documented defaults are the guess.
 */
function sqliteSize() {
  const candidates = [
    process.env.DB_PATH,
    path.join(ROOT, 'data', 'learnsdlc.sqlite'),
    path.join(ROOT, 'apps', 'api', 'data', 'learnsdlc.sqlite'),
  ].filter(Boolean);
  const resolved = candidates.map((c) => (path.isAbsolute(c) ? c : path.join(ROOT, c)));
  const file = resolved.find((c) => fs.existsSync(c)) ?? resolved[0];
  if (!fs.existsSync(file)) return { path: file, exists: false, bytes: 0 };
  let bytes = fs.statSync(file).size;
  // WAL mode keeps recent writes in a sidecar until a checkpoint, and a seed
  // that just wrote 25 terms leaves a big one; counting it is the honest number.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) bytes += fs.statSync(file + suffix).size;
  }
  return { path: file, exists: true, bytes };
}

/* -------------------------------- the run -------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  const { buildClassPlan, CLASS_NAME, CLASS_EMAIL_DOMAIN } = loadPlanModule();
  const plan = buildClassPlan(options.seed);
  const api = new Api(options.api);

  const wrong = selfCheck(plan);
  if (wrong) fail(wrong);

  if (!isLoopback(options.api)) {
    fail(
      'The class seed creates 25 accounts with one published password, so it refuses an API ' +
        `other machines can reach. Run it against http://localhost:4000.`,
    );
  }

  let health;
  try {
    health = await api.request('GET', '/health', { attempts: 1 });
  } catch {
    fail(`No API answered at ${options.api}. Start it with: npm run demo`);
  }

  const admin = new Identity(
    api,
    process.env.SEED_ADMIN_EMAIL || DEMO_ADMIN.email,
    process.env.SEED_ADMIN_PASSWORD || DEMO_ADMIN.password,
  );
  const instructor = new Identity(
    api,
    process.env.SEED_INSTRUCTOR_EMAIL || DEMO_INSTRUCTOR.email,
    process.env.SEED_INSTRUCTOR_PASSWORD || DEMO_INSTRUCTOR.password,
  );
  try {
    await admin.signIn();
    await instructor.signIn();
  } catch (err) {
    if (err.status === 429) {
      fail(
        'The API is still counting sign-ins from this machine after an earlier run. Wait a minute ' +
          'and try again, or raise SIGNIN_MAX_PER_ADDRESS on the API (docs/production-runbook.md).',
      );
    }
    fail(
      `Could not sign in as ${admin.email} and ${instructor.email}: ${err.message}\n` +
        'The seed needs the demo staff accounts. Start the API with SEED_DEMO_ACCOUNTS=true ' +
        '(scripts/start.sh does), or set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD and ' +
        'SEED_INSTRUCTOR_EMAIL / SEED_INSTRUCTOR_PASSWORD.',
    );
  }

  /* --- who is already here ------------------------------------------------ */

  // One request, not twenty-five: the instructor's own overview is the roll of
  // the class this seeder fills, and the admin console's lookup is limited to
  // sixty calls a minute; a per-persona probe spends half of that before the
  // run starts.
  const roll = await instructor
    .call(`GET`, `/instructor/overview?project=${encodeURIComponent(options.project)}`)
    .catch(() => ({ learners: [] }));
  const seeded = new Set(
    (roll.learners || [])
      .map((learner) => String(learner.email || '').toLowerCase())
      .filter((email) => email.endsWith(`@${CLASS_EMAIL_DOMAIN}`)),
  );
  const existing = plan.personas.filter((persona) => seeded.has(persona.email.toLowerCase()));

  if (options.remove) {
    if (!existing.length) {
      console.log('No seeded learners found. Nothing to remove.');
      return;
    }
    for (const persona of existing) {
      const learner = new Identity(api, persona.email, plan.password);
      try {
        await learner.signIn();
        await learner.call('DELETE', '/account', { email: persona.email });
      } catch (err) {
        console.error(`  could not remove ${persona.email}: ${err.message}`);
      }
    }
    console.log(
      `Removed ${existing.length} seeded learners and their work. The class "${CLASS_NAME}" is ` +
        'now empty; there is no route that deletes a class, so it stays in your list.',
    );
    return;
  }

  if (existing.length && !options.force) {
    // One admin lookup, only to date the last run for the message.
    const first = await admin
      .call('GET', `/admin/users?email=${encodeURIComponent(existing[0].email)}`)
      .catch(() => null);
    const when = first?.createdAt
      ? new Date(first.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
      : 'an earlier run';
    console.log(
      `${CLASS_NAME} already holds ${existing.length} seeded learners, seeded on ${when}. ` +
        'Nothing to do. Use --force to replay it, or --remove to take it out.',
    );
    return;
  }
  if (existing.length && options.force) {
    console.log(`==> Removing ${existing.length} learners from the last run`);
    for (const persona of existing) {
      const learner = new Identity(api, persona.email, plan.password);
      await learner
        .signIn()
        .then(() => learner.call('DELETE', '/account', { email: persona.email }))
        .catch(() => undefined);
    }
  }

  /* --- the clock and the mentor ------------------------------------------ */

  if (options.clock) {
    try {
      await admin.call('GET', '/demo/clock');
    } catch {
      fail(
        'The API is running without the demo clock, so the class would all be dated today. ' +
          'Start it with DEMO_CLOCK=true, or pass --no-clock to seed a flat class anyway.',
      );
    }
  }

  // The offline mentor names itself 'local-mentor'; anything else answering is
  // a model, and a model's hints differ between runs.
  const provider = String(health?.aiProvider || 'local-mentor');
  if (!provider.startsWith('local') && !options.anyMentor) {
    fail(
      `A live model is answering as "${provider}", so the hints would differ between runs. ` +
        'Pass --any-mentor to seed with it anyway.',
    );
  }

  /* --- the class ---------------------------------------------------------- */

  const today = options.at ? new Date(options.at) : new Date();
  if (Number.isNaN(today.getTime())) fail(`--at is not a date: ${options.at}`);

  // Wind back before the class is created, not after: `cohort.create` is the
  // first thing that happened this term and the audit trail should say so.
  // Everything after this point is dated inside the term.
  if (options.clock) await moveClock(admin, new Date(today.getTime() - plan.termDays * DAY_MS));

  const owned = await instructor.call('GET', '/instructor/cohorts');
  let cohort = (owned || []).find((row) => row.name === CLASS_NAME);
  if (!cohort) {
    cohort = await instructor.call('POST', '/instructor/cohorts', { name: CLASS_NAME });
    // Creating a class moves the creator into it, so the token in hand
    // describes a cohort the instructor is no longer in.
    await instructor.signIn();
  }

  console.log(
    `==> Seeding ${CLASS_NAME} (seed ${options.seed}, ${plan.personas.length} learners, ` +
      `${options.project})`,
  );
  console.log(`  ok    class created, join code ${cohort.joinCode}`);
  if (!options.clock) {
    console.log('  note  --no-clock: every row will be dated today, so nobody will read as idle');
  }

  const started = Date.now();
  let done = 0;
  let lastWeek = 0;
  const total = plan.personas.length;

  /**
   * Put the clock back on the way out, however this process ends.
   *
   * A wound-back clock is not only a wrong date: the API's rate-limit buckets
   * hold `resetAt = now + window`, so a bucket created before the wind-back
   * expires five weeks into the future and never clears. A run killed with
   * ctrl-C would leave the API refusing every sign-in until it was
   * restarted, which is a bad way to learn what the demo clock touches.
   */
  const release = () => {
    if (!options.clock) return Promise.resolve();
    return releaseClock(admin).catch(() => undefined);
  };
  const onSignal = (signal) => {
    release().then(() => {
      console.error(`\nStopped on ${signal}. The clock is back on real time; run --remove.`);
      process.exit(2);
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    await replayClass({
      api,
      plan,
      admin,
      joinCode: cohort.joinCode,
      projectSlug: options.project,
      today,
      concurrency: options.concurrency,
      useClock: options.clock,
      hooks: {
        onDay: (day, at, steps) => {
          if (options.quiet) {
            console.log(
              `  day   ${pad(day, 3)} ${at.toISOString().slice(0, 10)}  ${steps} things happened`,
            );
            return;
          }
          // A learner's line is only printed when their last step is done, and
          // the first of those is minutes in. A heading per week of term keeps
          // a nine-minute replay from looking like a hung one.
          const week = Math.floor(day / 7) + 1;
          if (week === lastWeek) return;
          lastWeek = week;
          console.log(`  --    week ${week} of the term, from ${at.toISOString().slice(0, 10)}`);
        },
        onLearner: (learner) => {
          done += 1;
          if (options.quiet) return;
          console.log(
            `  ok    ${pad(`${done}/${total}`, 6)}${pad(learner.persona.displayName, 20)} ` +
              learner.persona.summary,
          );
        },
      },
    });
  } catch (err) {
    await release();
    const runnerish = /runner|unavailable|never reached a verdict|503/i.test(err.message);
    console.error(
      runnerish
        ? `The code runner could not be reached, so the replay stopped after ${done} of ${total} ` +
            'learners. Nothing is half-written: run --remove and try again.'
        : `The replay stopped after ${done} of ${total} learners: ${err.message}\n` +
            'Run --remove and try again.',
    );
    process.exit(2);
  }

  await release();

  printSummary({
    plan,
    className: CLASS_NAME,
    joinCode: cohort.joinCode,
    elapsedMs: Date.now() - started,
    apiUrl: options.api,
    dbPath: sqliteSize(),
  });
  void DAY_MS;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
