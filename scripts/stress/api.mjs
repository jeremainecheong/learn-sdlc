// API-layer stress: auth/JWT/RBAC, gating integrity, concurrency and rate limits.
//
// Needs an API already running (see scripts/stress/README.md); CI boots one in
// the `stress-api` job. API_URL points it somewhere other than :4000, which is
// what a second stack on the same machine needs.
import crypto from 'crypto';
import { requirementsWork } from '../passing-work.mjs';
import { DEMO_ADMIN, DEMO_INSTRUCTOR } from '../lib/demo-accounts.mjs';
import { poll, request } from '../lib/api-client.mjs';
import { NATIVE_API_URL } from '../lib/endpoints.mjs';
const API = process.env.API_URL || NATIVE_API_URL;
let pass = 0, fail = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${d}`); };

const raw = (method, path, options) => request(API, method, path, options);
async function ok(method, path, opts) {
  const r = await raw(method, path, opts);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.data).slice(0,200)}`);
  return r.data;
}

async function newLearner(tag) {
  const email = `stress-${tag}-${crypto.randomUUID().slice(0,8)}@t.dev`;
  const reg = await ok('POST', '/auth/register', { body: { email, password: 'Password1!', displayName: `S ${tag}` } });
  return { email, token: reg.token, userId: reg.user.id };
}

/**
 * Phase-one work that clears the requirements gate, and work that does not.
 * Requirements is the story record alone (requirements/story.json): the
 * passing record is the one scripts/passing-work.mjs builds, marked for the CI
 * assessor (E2E_AI_STUB); the thin one has one happy criterion, no boundary
 * and no out-of-scope line, so the story floor refuses it.
 */
const STORY = 'requirements/story.json';
const GOOD_WORK = requirementsWork();
const THIN_WORK = {
  [STORY]: `${JSON.stringify({
    id: 'US-4',
    title: 'Overdue report',
    persona: 'busy learner',
    capability: 'an overdue report',
    benefit: 'I see what I missed',
    criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' }],
    scopeExclusions: [],
    notes: '',
  }, null, 2)}\n`,
};

/**
 * Fail on the API being absent rather than on `fetch failed` forty lines in:
 * this script is part of `npm run stress`, so the first thing it must say
 * is which API it could not reach.
 */
async function requireApi() {
  try {
    const res = await fetch(`${API}/health`);
    if (!res.ok) throw new Error(`health answered ${res.status}`);
  } catch (err) {
    console.error(
      `No API at ${API}: ${err.message}\n` +
        'Start one first, e.g. JWT_SECRET=$(openssl rand -base64 48) DB_PATH=data/stress.sqlite ' +
        'RUNNER_MODE=local SEED_DEMO_ACCOUNTS=true node apps/api/dist/main.js, or point API_URL at a running one.',
    );
    process.exit(2);
  }
}

async function main() {
  await requireApi();

  // ---------- AUTH & JWT ----------
  const a = await newLearner('auth');
  {
    const r = await raw('GET', '/analytics/me'); rec('no token -> 401', r.status === 401, `got ${r.status}`);
  }
  {
    const r = await raw('GET', '/analytics/me', { token: a.token + 'x' }); rec('tampered signature -> 401', r.status === 401, `got ${r.status}`);
  }
  {
    // forge a token with a bogus HS256 signature but valid-looking payload
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: a.userId, email: a.email, role: 'ADMIN', iat: 0, exp: 9999999999 })).toString('base64url');
    const forged = `${h}.${p}.${crypto.createHmac('sha256', 'wrong-secret').update(`${h}.${p}`).digest('base64url')}`;
    const r = await raw('GET', '/instructor/overview', { token: forged }); rec('forged ADMIN token rejected -> 401/403', r.status === 401 || r.status === 403, `got ${r.status}`);
  }
  {
    const r = await raw('POST', '/auth/login', { body: { email: a.email, password: 'WrongPass1!' } }); rec('bad password -> 401', r.status === 401, `got ${r.status}`);
  }
  {
    // alg:none downgrade attempt
    const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: a.userId, role: 'ADMIN' })).toString('base64url');
    const r = await raw('GET', '/instructor/overview', { token: `${h}.${p}.` }); rec('alg:none downgrade rejected', r.status === 401 || r.status === 403, `got ${r.status}`);
  }

  // ---------- RBAC ----------
  {
    const r = await raw('GET', '/instructor/overview', { token: a.token }); rec('learner hitting instructor -> 403', r.status === 403, `got ${r.status}`);
    // An administrator's write is the lever a learner would try to steal.
    const r2 = await raw('PATCH', `/admin/users/${a.userId}`, { token: a.token, body: { role: 'ADMIN' } }); rec('learner cannot promote themselves -> 403', r2.status === 403, `got ${r2.status}`);
  }

  // ---------- CROSS-USER ISOLATION ----------
  const b = await newLearner('victim');
  const bEnr = await ok('POST', '/enrollments', { token: b.token, body: { projectSlug: 'tasktrackr' } });
  {
    // attacker 'a' tries to read/write victim 'b' phase
    const r = await raw('GET', `/phases/${bEnr.phases[0].id}`, { token: a.token }); rec("cross-user phase read -> 403", r.status === 403, `got ${r.status}`);
    const r2 = await raw('PUT', `/phases/${bEnr.phases[0].id}/workspace`, { token: a.token, body: { files: { [STORY]: 'x' } } }); rec('cross-user workspace write -> 403', r2.status === 403, `got ${r2.status}`);
    const r3 = await raw('POST', '/assistant/chat', { token: a.token, body: { phaseStateId: bEnr.phases[0].id, message: 'hi' } }); rec('cross-user assistant -> 403', r3.status === 403, `got ${r3.status}`);
  }

  // ---------- GATING INTEGRITY ----------
  const g = await newLearner('gate');
  const gEnr = await ok('POST', '/enrollments', { token: g.token, body: { projectSlug: 'tasktrackr' } });
  const P = (o) => gEnr.phases.find(p => p.order === o);
  {
    // A second enrol is a retry after a lost response: it hands back the same
    // board rather than a second one (WorkflowService.enrollAt).
    const r = await raw('POST', '/enrollments', { token: g.token, body: { projectSlug: 'tasktrackr' } }); rec('double enroll returns the same enrolment', r.status < 300 && r.data?.id === gEnr.id && r.data?.phases?.[0]?.id === gEnr.phases[0].id, `got ${r.status} ${r.data?.id === gEnr.id ? 'same' : 'different'} id`);
    const r2 = await raw('GET', `/phases/${P(3).id}`, { token: g.token }); rec('locked phase detail -> 403', r2.status === 403, `got ${r2.status}`);
    const r3 = await raw('POST', `/phases/${P(2).id}/advance`, { token: g.token }); rec('advance locked phase -> 400/403', r3.status >= 400, `got ${r3.status}`);
    const r4 = await raw('PUT', `/phases/${P(1).id}/workspace`, { token: g.token, body: { files: { 'docs/notes.md': 'HACK' } } }); rec('write a file the phase does not let the learner edit -> 400', r4.status === 400, `got ${r4.status}`);
    const r5 = await raw('POST', `/phases/${P(1).id}/advance`, { token: g.token }); rec('advance unpassed phase -> 400', r5.status === 400, `got ${r5.status}`);
    // unknown project / phase ids
    // A learner may start only the project they were given, so a slug that is
    // not theirs is refused before anything says whether it exists; an admin,
    // who may start any project, learns that it does not.
    const r6 = await raw('POST', '/enrollments', { token: g.token, body: { projectSlug: 'nonexistent' } }); rec('learner naming an unknown project -> 403', r6.status === 403, `got ${r6.status}`);
    const adm = await ok('POST', '/auth/login', { body: { email: DEMO_ADMIN.email, password: DEMO_ADMIN.password } });
    const r6a = await raw('POST', '/enrollments', { token: adm.token, body: { projectSlug: 'nonexistent' } }); rec('admin naming an unknown project -> 404', r6a.status === 404, `got ${r6a.status}`);
    const r7 = await raw('GET', '/phases/00000000-0000-0000-0000-000000000000', { token: g.token }); rec('unknown phase id -> 404', r7.status === 404, `got ${r7.status}`);
  }
  {
    // Pass phase 1 legitimately, then the gate. The reflection is optional
    // (WorkflowService: `advance` does not read it), so a
    // passed phase advances without one; /reflect still holds its own floor.
    await ok('PUT', `/phases/${P(1).id}/workspace`, { token: g.token, body: { files: GOOD_WORK } });
    const sub = await ok('POST', `/phases/${P(1).id}/submit`, { token: g.token });
    const done = await poll(() => ok('GET', `/submissions/${sub.id}`, { token: g.token }), (v) => v.status === 'completed');
    rec('legit phase-1 submission passes', done.passed === true, `score=${done.score}`);
    const thin = await raw('POST', `/phases/${P(1).id}/reflect`, { token: g.token, body: { reflection: 'ok' } }); rec('reflection under its floor -> 400', thin.status === 400, `got ${thin.status}`);
    const adv = await ok('POST', `/phases/${P(1).id}/advance`, { token: g.token });
    rec('advance after a pass, no reflection needed', adv.currentPhaseOrder === 2, `order=${adv.currentPhaseOrder}`);
    await ok('POST', `/phases/${P(1).id}/reflect`, { token: g.token, body: { reflection: 'Writing testable criteria forced me to decide the boundary cases up front and rethink scope.' } });
    const adv2 = await ok('POST', `/phases/${P(1).id}/advance`, { token: g.token });
    rec('advance idempotent', adv2.currentPhaseOrder === 2, `order=${adv2.currentPhaseOrder}`);
  }

  // ---------- INPUT VALIDATION ----------
  {
    const r = await raw('POST', '/auth/register', { body: { email: 'not-an-email', password: 'x', displayName: '' } }); rec('bad register payload -> 400', r.status === 400, `got ${r.status}`);
    const r2 = await raw('POST', '/assistant/chat', { token: g.token, body: { phaseStateId: P(2).id, message: '' } }); rec('empty chat message -> 400', r2.status === 400, `got ${r2.status}`);
    const huge = 'x'.repeat(300000);
    const r3 = await raw('PUT', `/phases/${P(2).id}/workspace`, { token: g.token, body: { files: { 'shared/contract/api.json': huge } } }); rec('oversized file (300KB) rejected by DTO -> 400', r3.status === 400, `got ${r3.status}`);
    // a large file the design phase takes: the API contract, valid in shape, padded in its $comment
    const legit = `${JSON.stringify({ $comment: 'x'.repeat(150000), operations: [], errors: {} }, null, 2)}\n`;
    const r4 = await raw('PUT', `/phases/${P(2).id}/workspace`, { token: g.token, body: { files: { 'shared/contract/api.json': legit } } }); rec('legit large file (150KB) accepted', r4.status < 400, `got ${r4.status}`);
  }

  // ---------- RATE LIMITING ----------
  {
    const learner = await newLearner('rate');
    const enr = await ok('POST', '/enrollments', { token: learner.token, body: { projectSlug: 'tasktrackr' } });
    const pid = enr.phases[0].id;
    // assistant chat is limited to 20/min
    const bursts = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      raw('POST', '/assistant/chat', { token: learner.token, body: { phaseStateId: pid, message: `rate probe ${i}` } })));
    const limited = bursts.filter(r => r.status === 429).length;
    rec('assistant rate limit fires (429)', limited > 0, `${limited}/40 rejected`);
  }

  // ---------- CONCURRENCY: 12 learners enroll + submit phase 1 in parallel ----------
  {
    const t0 = Date.now();
    const learners = await Promise.all(Array.from({ length: 12 }, (_, i) => newLearner(`conc${i}`)));
    const outcomes = await Promise.all(learners.map(async (l) => {
      const enr = await ok('POST', '/enrollments', { token: l.token, body: { projectSlug: 'tasktrackr' } });
      const pid = enr.phases[0].id;
      await ok('PUT', `/phases/${pid}/workspace`, { token: l.token, body: { files: GOOD_WORK } });
      const sub = await ok('POST', `/phases/${pid}/submit`, { token: l.token });
      const done = await poll(() => ok('GET', `/submissions/${sub.id}`, { token: l.token }), (v) => v.status === 'completed' || v.status === 'failed');
      return done.passed === true;
    }));
    const allPassed = outcomes.every(Boolean);
    rec('12 concurrent learners submit correctly', allPassed, `${outcomes.filter(Boolean).length}/12 in ${Date.now()-t0}ms`);
  }

  // ---------- TWO LEARNERS IN ONE COHORT SUBMIT AT THE SAME INSTANT ----------
  {
    // The shape a class actually has: one instructor's cohort, two learners in
    // it, submitting together. Both rows are graded by the same worker pool
    // against the same phase, so a verdict written to the wrong row, or a
    // report cached across users, shows up here and nowhere else in the suite.
    const inst = await ok('POST', '/auth/login', { body: { email: DEMO_INSTRUCTOR.email, password: DEMO_INSTRUCTOR.password } });
    const cohort = await ok('POST', '/instructor/cohorts', { token: inst.token, body: { name: `Stress ${crypto.randomUUID().slice(0, 6)}` } });
    const [one, two] = await Promise.all([newLearner('coh1'), newLearner('coh2')]);
    await Promise.all([
      ok('POST', '/enrollments/join', { token: one.token, body: { code: cohort.joinCode } }),
      ok('POST', '/enrollments/join', { token: two.token, body: { code: cohort.joinCode } }),
    ]);

    const enrol = async (l, files) => {
      const enr = await ok('POST', '/enrollments', { token: l.token, body: { projectSlug: 'tasktrackr' } });
      const pid = enr.phases.find((p) => p.order === 1).id;
      await ok('PUT', `/phases/${pid}/workspace`, { token: l.token, body: { files } });
      return pid;
    };
    // Deliberately different work, so the two verdicts differ: a swap is
    // visible as a wrong `passed`, not only as a wrong id.
    const [pidOne, pidTwo] = await Promise.all([enrol(one, GOOD_WORK), enrol(two, THIN_WORK)]);

    const [subOne, subTwo] = await Promise.all([
      ok('POST', `/phases/${pidOne}/submit`, { token: one.token }),
      ok('POST', `/phases/${pidTwo}/submit`, { token: two.token }),
    ]);
    const settled = (v) => v.status === 'completed' || v.status === 'failed';
    const [verdictOne, verdictTwo] = await Promise.all([
      poll(() => ok('GET', `/submissions/${subOne.id}`, { token: one.token }), settled),
      poll(() => ok('GET', `/submissions/${subTwo.id}`, { token: two.token }), settled),
    ]);
    rec('cohort-mates get their own verdicts', verdictOne.passed === true && verdictTwo.passed === false,
      `one=${verdictOne.passed}/${verdictOne.score} two=${verdictTwo.passed}/${verdictTwo.score}`);
    rec('each cohort-mate has exactly one submission row',
      (await ok('GET', `/phases/${pidOne}/submissions`, { token: one.token })).length === 1 &&
        (await ok('GET', `/phases/${pidTwo}/submissions`, { token: two.token })).length === 1);
    // Same class, same instructor, still no read across.
    const peek = await raw('GET', `/submissions/${subOne.id}`, { token: two.token });
    rec("a cohort-mate cannot read the other's verdict", peek.status === 403 || peek.status === 404, `got ${peek.status}`);
  }

  // ---------- CONCURRENT DOUBLE-SUBMIT same phase ----------
  {
    const l = await newLearner('dbl');
    const enr = await ok('POST', '/enrollments', { token: l.token, body: { projectSlug: 'tasktrackr' } });
    const pid = enr.phases[0].id;
    await ok('PUT', `/phases/${pid}/workspace`, { token: l.token, body: { files: GOOD_WORK } });
    const [s1, s2] = await Promise.all([
      raw('POST', `/phases/${pid}/submit`, { token: l.token }),
      raw('POST', `/phases/${pid}/submit`, { token: l.token }),
    ]);
    rec('concurrent double-submit both accepted', s1.status < 400 && s2.status < 400, `${s1.status}/${s2.status}`);

    // Accepting both is the weaker half:
    // what has to hold is that one workspace is graded once. Whether the two
    // requests genuinely overlap depends on the queue. On the in-process queue
    // with sqlite the first submission is graded inside its own request
    // (better-sqlite3 is synchronous, so nothing else runs), and the second
    // request is then a second attempt rather than a double-click. On the
    // durable queue they do overlap, and the in-flight guard (or, if it loses
    // the read-then-write race, `UQ_submissions_in_flight`) has to hand the
    // second caller the first caller's row. So the strong assertion is made
    // exactly when the overlap happened, and both backends are checked here.
    const ids = new Set([s1.data?.id, s2.data?.id]);
    const settled = (v) => v.status === 'completed' || v.status === 'failed';
    for (const id of ids) await poll(() => ok('GET', `/submissions/${id}`, { token: l.token }), settled);
    const rows = await ok('GET', `/phases/${pid}/submissions`, { token: l.token });

    if (ids.size === 1) {
      rec('overlapping double-submit graded one row', rows.length === 1, `${rows.length} rows`);
    } else {
      rec('serialised double-submit graded one row each', rows.length === 2 && ids.size === 2,
        `${rows.length} rows, ${ids.size} ids`);
    }
    // Whichever way it went: no row the learner was never handed an id for,
    // never two in flight for one phase, and one verdict per row.
    rec('double-submit invented no extra submission row', rows.length === ids.size,
      `${rows.length} rows for ${ids.size} ids`);
    rec('no two submissions in flight for one phase',
      rows.filter((r) => r.status === 'queued' || r.status === 'running').length <= 1,
      rows.map((r) => r.status).join(','));
    rec('every submission reached exactly one verdict',
      rows.every((r) => r.status === 'completed' && typeof r.passed === 'boolean'),
      rows.map((r) => `${r.status}/${r.passed}`).join(' '));
  }

  console.log(`\nAPI STRESS: ${pass}/${pass+fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
