import { expect, request as pwRequest, test, type APIRequestContext } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { INSTRUCTOR } from './passing-work';
import { deepReceiptRefusal, found, sha256Hex, TASKTRACKR_WORDS, writeDeepReceiptSeam } from './upload-helpers';
import { AI_STUB_URL, API, assertLoopbackApi, RUN } from './support/env';

/**
 * A hand-written interview's answer is DELIVERED on the local stack, end to end.
 *
 * The starter carries its Requirements interview as a file of its own
 * (phases/01-requirements/interview.json), written by hand; nothing is derived
 * from a story at upload. A stub that knows only the reference
 * reviewer's schema makes the API withhold every authored reply (503
 * STAKEHOLDER_REPLY_WITHHELD). The loopback stub (e2e/ai-stub.cjs) also reads
 * the authored reviewer's request ('stakeholder_output_review_v6_authored',
 * its reference inside the TEACHER_BRIEF fence), so an authored answer can
 * pass its review; this walk proves the whole turn on the built API:
 *
 *  1. the seeded instructor fetches the starter from the staff route (its
 *     recorded bytes) and uploads it; no interview is derived;
 *  2. a fast validation, the publish refused for want of a deep receipt, the
 *     test-only deep-receipt seam (writeDeepReceiptSeam), the publish;
 *  3. a new class is assigned the starter; a learner registers, joins with
 *     the code and enrols;
 *  4. the learner opens the Requirements interview (persona + opening only,
 *     nothing asked of any model) and asks ONE question;
 *  5. the answer is delivered (200, not 503), is the hand-written fact's
 *     answer, and settles that fact; the stub was asked exactly one
 *     interview.answer and one interview.review and nothing else; the reply
 *     carries no TaskTrackr word and no other fact's answer.
 *
 * API-only through Playwright's request context, on purpose: the walk is the
 * API's ask -> answer -> review turn, so no page is opened here; the learner's
 * room UI is walked by learner-preview.spec.ts.
 * The AI is the loopback stub only; no model is called.
 */

assertLoopbackApi(__filename);

/** Per worker: a retry uploads, publishes and registers under new names. */
const NONCE = crypto.randomBytes(2).toString('hex');
const TITLE = `Authored interview ${RUN}${NONCE}`;
const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The SHA-256 of the starter archive the staff route serves (apps/api/src/authoring/starter-archive.generated.ts). */
/* Generated content, not an AI-request golden: this pin follows the digest
   apps/api/src/authoring/starter-archive.generated.ts serves, re-pinned by hand when the starter is regenerated. */
const STARTER_SHA256 = 'af815a97dfe7bfe4e652d1a83b90853e60bbd58dcf7a69beaf9974c267e500f9';
/** TaskTrackr's persona and interview words (content/tasktrackr interview.json), never in the starter's room. */
const TASKTRACKR_INTERVIEW_WORDS = ['Dana Osei', 'ten minutes', 'TaskTrackr'];

const STARTER_DIR = path.resolve(__dirname, '../apps/api/test/fixtures/upload-packs/starter');
/** The starter's hand-written interview: its persona, its opening and its sealed facts. */
const INTERVIEW = JSON.parse(fs.readFileSync(path.join(STARTER_DIR, 'phases/01-requirements/interview.json'), 'utf8')) as {
  persona: { name: string };
  opening: string;
  facts: { id: string; topic: string; answer: string }[];
};
const PERSONA = INTERVIEW.persona.name;
const OPENING = INTERVIEW.opening;
const FACTS = INTERVIEW.facts;
/** The one question, aimed at one fact by its own topic words. */
const QUESTION = "What should happen when I type the author's name in small letters?";
const ASKED = FACTS.find((fact) => fact.topic.includes('small letters'));

let api: APIRequestContext;
let staff: { authorization: string };
const fiveHundreds: string[] = [];

async function stubCounts(): Promise<Record<string, number>> {
  const res = await fetch(`${AI_STUB_URL}/__stub/counts`);
  if (!res.ok) throw new Error(`the AI stub did not answer its counts (${res.status})`);
  return ((await res.json()).counts ?? {}) as Record<string, number>;
}

/** What moved between two count snapshots, kinds that did not move left out. */
function moved(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[kind] ?? 0) - (before[kind] ?? 0);
    if (delta !== 0) out[kind] = delta;
  }
  return out;
}

async function call(method: string, route: string, data?: unknown, headers: Record<string, string> = staff) {
  const res = await api.fetch(`${API}${route}`, { method, headers, data });
  if (res.status() >= 500) fiveHundreds.push(`${res.status()} ${method} ${route.replace(IDS, ':id')}`);
  return res;
}

test.beforeAll(async () => {
  api = await pwRequest.newContext();
  const login = await api.post(`${API}/auth/login`, { data: { email: INSTRUCTOR.email, password: INSTRUCTOR.password } });
  expect(login.ok(), 'the seeded instructor signs in through the API').toBeTruthy();
  staff = { authorization: `Bearer ${(await login.json()).token}` };
});

test.afterAll(async () => {
  await api?.dispose();
});

test('a learner asks the hand-written Requirements interview one question and its answer is delivered', async () => {
  expect(PERSONA, 'the starter names its stakeholder').toBe('Head Librarian');
  expect(ASKED, 'the starter has a fact about typing the name in small letters').toBeTruthy();

  const ids: { projectId?: string; versionId?: string; slug?: string; cohortId?: string; joinCode?: string } = {};

  await test.step('the starter is uploaded; nothing is derived', async () => {
    const starter = await call('GET', '/instructor/starter/starter');
    expect(starter.status()).toBe(200);
    const archive = await starter.body();
    expect(sha256Hex(archive), 'the recorded starter bytes').toBe(STARTER_SHA256);
    const uploaded = await call('POST', '/instructor/projects/upload', { title: TITLE, archiveBase64: archive.toString('base64') });
    expect(uploaded.status(), 'the starter is accepted').toBe(201);
    const made = await uploaded.json();
    // The interview is the pack's own file, so the upload derives none and says nothing about one.
    expect(made.interview, 'no interview is derived').toBeUndefined();
    ids.projectId = made.projectId;
    ids.versionId = made.versionId;
    ids.slug = (await (await call('GET', `/instructor/projects/${ids.projectId}/versions/${ids.versionId}`)).json()).slug;
    expect(ids.slug).toBeTruthy();
  });

  await test.step('validated, refused for want of a deep receipt, then published behind the ratified seam', async () => {
    const base = `/instructor/projects/${ids.projectId}/versions/${ids.versionId}`;
    expect((await call('POST', `${base}/validate`)).status()).toBe(200);
    const refused = await call('POST', `${base}/publish`, { version: '1.0.0', notes: 'The authored-interview walk publishes the starter.' });
    expect(refused.status(), 'no deep receipt: refused').toBeGreaterThanOrEqual(400);
    expect(refused.status()).toBeLessThan(500);
    expect(JSON.stringify(await refused.json())).toContain(deepReceiptRefusal('Implementation'));
    // The test-only deep-receipt seam: macOS runs no learner code, so the passed deep receipt is written directly.
    writeDeepReceiptSeam(ids.versionId!);
    expect((await call('POST', `${base}/validate`)).status()).toBe(200);
    const published = await call('POST', `${base}/publish`, { version: '1.0.0', notes: 'The authored-interview walk publishes the starter.' });
    expect(published.status(), 'published').toBe(200);
    ids.versionId = (await published.json()).versionId ?? ids.versionId;
  });

  await test.step('a new class is assigned the starter', async () => {
    const made = await call('POST', '/instructor/cohorts', { name: `Authored class ${RUN}${NONCE}` });
    expect(made.status()).toBe(201);
    const body = await made.json();
    ids.cohortId = body.id;
    ids.joinCode = body.joinCode;
    const assigned = await call('PUT', `/instructor/cohorts/${ids.cohortId}/project`, {
      projectVersionId: ids.versionId,
      reason: 'This class works on the starter project.',
    });
    expect(assigned.status()).toBe(200);
  });

  const learnerEmail = `authored-interview-${RUN}${NONCE}@example.test`;
  const registered = await call('POST', '/auth/register', { email: learnerEmail, password: 'Correct-Horse-9', displayName: `Lia Authored ${RUN}` }, {});
  expect(registered.status()).toBe(201);
  const learner = { authorization: `Bearer ${(await registered.json()).token}` };
  expect((await call('POST', '/enrollments/join', { code: ids.joinCode }, learner)).status()).toBe(200);
  const enrolled = await call('POST', '/enrollments', { projectSlug: ids.slug }, learner);
  expect(enrolled.status()).toBe(201);
  const requirements = (await enrolled.json()).phases.find((one: any) => one.key === 'requirements');
  expect(requirements?.id, 'the Requirements phase row').toBeTruthy();

  const before = await stubCounts();

  await test.step('the learner opens the interview: persona and opening, no model asked', async () => {
    const opened = await call('GET', `/phases/${requirements.id}/interview`, undefined, learner);
    expect(opened.status()).toBe(200);
    const room = await opened.json();
    expect(room.persona?.name).toBe(PERSONA);
    expect(room.opening).toBe(OPENING);
    expect(room.turns).toEqual([]);
    const text = JSON.stringify(room);
    expect(found(text, TASKTRACKR_INTERVIEW_WORDS), 'no TaskTrackr interview word in the room').toEqual([]);
    expect(found(text, FACTS.map((fact) => fact.answer)), 'no fact answer in the room before a question').toEqual([]);
    expect(moved(before, await stubCounts()), 'opening the room asked no model').toEqual({});
  });

  await test.step('one question: the fact\'s answer is delivered, reviewed and settles its fact', async () => {
    const asked = await call('POST', `/phases/${requirements.id}/interview/ask`, { question: QUESTION }, learner);
    const text = await asked.text();
    expect(text, 'not withheld').not.toContain('STAKEHOLDER_REPLY_WITHHELD');
    expect(asked.status(), 'delivered, not 503').toBe(200);
    const body = JSON.parse(text);
    expect(body.turn.question).toBe(QUESTION);
    expect(body.turn.answer, "the hand-written fact's own answer").toBe(ASKED!.answer);
    expect(body.turn.facts, 'the review settled exactly that fact').toEqual([ASKED!.id]);
    expect(body.state.turns).toHaveLength(1);
    // Exactly one answer and one review reached the stub, nothing else (no repair, no refusal).
    expect(moved(before, await stubCounts()), 'the stub was asked one answer and one review').toEqual({
      'interview.answer': 1,
      'interview.review': 1,
    });
    // Nothing beyond the delivered answer: no TaskTrackr word, no other fact's answer.
    const others = FACTS.map((fact) => fact.answer).filter((needle) => !ASKED!.answer.includes(needle));
    expect(found(text, [...TASKTRACKR_WORDS, ...TASKTRACKR_INTERVIEW_WORDS]), 'no TaskTrackr word in the reply').toEqual([]);
    expect(found(text, others), "no other fact's answer in the reply").toEqual([]);
    // The learner's room, re-read: the one turn, the same answer.
    const room = await (await call('GET', `/phases/${requirements.id}/interview`, undefined, learner)).json();
    expect(room.turns.map((turn: any) => turn.answer)).toEqual([ASKED!.answer]);
  });

  expect(fiveHundreds, 'no response had a status of 500 or more').toEqual([]);
});
