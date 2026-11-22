/**
 * The Playwright suite's AI stub, e2e/ai-stub.cjs, held to what it promises.
 *
 *   node --test e2e/ai-stub.test.mjs
 *
 * Needs `apps/api/dist` (npm run build): every answer the stub gives is fed
 * back through the API's own client, the real OpenAiProvider, pointed at the
 * stub, so the API's own parsers (parseStrictReview, parseInterviewReview,
 * parseGuidedReview) decide whether it is acceptable, against the real
 * TaskTrackr phases. Not a Playwright spec; playwright.config.ts ignores it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(import.meta.url);
const STUB = path.join(here, 'ai-stub.cjs');

let stub;
let server;
let base;
let provider;
let phases;

before(async () => {
  assert.ok(existsSync(STUB), 'e2e/ai-stub.cjs exists');
  stub = require(STUB);
  server = await stub.start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  // The API reads its configuration once, at import: the stub has to be in
  // the environment before the provider module is loaded. Concurrency 1 is the
  // application's limit; the stub does not need more.
  process.env.OPENAI_BASE_URL = `${base}/v1`;
  process.env.OPENAI_API_KEY = stub.KEY;
  process.env.AI_MAX_CONCURRENCY = '1';
  process.chdir(root);
  require(path.join(root, 'node_modules', 'reflect-metadata'));
  const { Logger } = require(path.join(root, 'node_modules', '@nestjs', 'common'));
  Logger.overrideLogger(false);
  const { ContentService } = require(path.join(root, 'apps/api/dist/content/content.service.js'));
  const content = new ContentService();
  content.loadAll();
  const tasktrackr = content.listProjects().find((p) => p.slug === 'tasktrackr');
  phases = Object.fromEntries(tasktrackr.phases.map((p) => [p.key, p]));
  const { OpenAiProvider } = require(path.join(root, 'apps/api/dist/assistant/openai.provider.js'));
  provider = new OpenAiProvider();
});

after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

const post = (body, headers = { authorization: `Bearer ${stub.KEY}` }) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const reviewInput = (workspace) => ({ workspace, criteria: [], checks: [], overall: 0, hints: 0, ranBeforeSubmit: false });

test('it listens on loopback only', async () => {
  assert.equal(server.address().address, '127.0.0.1');
  const outward = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
  if (!outward) return; // a machine with no outward interface has nothing to prove here
  const reached = await new Promise((resolve) => {
    const socket = net.connect({ host: outward.address, port: server.address().port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
  assert.equal(reached, false, 'the stub is not reachable on a non-loopback address');
});

test('it requires the literal key', async () => {
  const body = { model: 'x', messages: [{ role: 'user', content: 'hello' }] };
  assert.equal((await post(body, {})).status, 401);
  assert.equal((await post(body, { authorization: 'Bearer something-else' })).status, 401);
});

test('it refuses what it does not recognise with a 400', async () => {
  const unknownSchema = await post({
    model: 'x',
    messages: [{ role: 'system', content: 'anything' }, { role: 'user', content: 'x' }],
    response_format: { type: 'json_schema', json_schema: { name: 'some_other_schema', schema: {}, strict: true } },
  });
  assert.equal(unknownSchema.status, 400);
  const unknownText = await post({ model: 'x', messages: [{ role: 'system', content: 'Write me a poem.' }, { role: 'user', content: 'x' }] });
  assert.equal(unknownText.status, 400);
  const unknownJson = await post({ model: 'x', messages: [{ role: 'system', content: 'Classify this.' }], response_format: { type: 'json_object' } });
  assert.equal(unknownJson.status, 400);
  const elsewhere = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${stub.KEY}` } });
  assert.equal(elsewhere.status, 404);
  assert.ok(stub.counts.unrecognised >= 4, 'refusals are counted');
});

test('grading passes only when the learner block carries the marker', async () => {
  const phase = phases.requirements;
  const story = '# US-4 Overdue report\n\nAs a learner I want the overdue page so that I see what I missed.\n';
  const plain = await provider.review(phase, reviewInput({ 'requirements/draft.md': story }));
  assert.equal(plain.verdict, 'needs_revision');
  assert.ok(plain.criteriaEvidence.every((c) => c.met === false && c.issue.trim()));
  const marked = await provider.review(phase, reviewInput({ 'requirements/draft.md': `${story}<!-- ${stub.MARKER} -->\n` }));
  assert.equal(marked.verdict, 'pass');
  assert.equal(marked.criteriaEvidence.length, phase.rubric.criteria.length);
  assert.equal(marked.provider, 'local-ai:gpt-5.6-luna');
});

test('grading a story record passes only with the marker in story/notes, as the review reads the record', async () => {
  const phase = phases.requirements;
  const { serialiseStory } = require(path.join(root, 'packages/shared/dist/index.js'));
  const { storyWorkspaceForReview } = require(path.join(root, 'apps/api/dist/feedback/story-report.js'));
  const story = {
    id: 'US-4', title: 'See overdue tasks', persona: 'team lead', capability: 'to see every overdue task in one list',
    benefit: 'I can chase work before it slips further',
    criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the overdue report', then: 'it is listed', tag: 'happy' }],
    scopeExclusions: ['editing tasks from the report'], notes: '',
  };
  const plain = await provider.review(phase, reviewInput(storyWorkspaceForReview(serialiseStory(story))));
  assert.equal(plain.verdict, 'needs_revision');
  const projection = storyWorkspaceForReview(serialiseStory({ ...story, notes: stub.MARKER }));
  assert.equal(projection['story/notes'], stub.MARKER);
  const marked = await provider.review(phase, reviewInput(projection));
  assert.equal(marked.verdict, 'pass');
  assert.ok(marked.criteriaEvidence.every((c) => /story\//.test(c.evidence)), 'every citation names a story/ path');
});

test('grading a multi-file phase passes with the marker and cites a submitted path', async () => {
  const phase = phases.design;
  const marked = await provider.review(phase, reviewInput({ 'design/entity-1/name': `Task ${stub.MARKER}` }));
  assert.equal(marked.verdict, 'pass');
  assert.ok(marked.criteriaEvidence.every((c) => c.evidence.includes('design/entity-1/name')));
});

test('grading a runbook phase cites a projection path for the record criteria', async () => {
  const marked = await provider.review(phases.deployment, reviewInput({ 'docker-compose.yml': 'services: {}\n', 'runbook/env-1/name': `E1: API_URL ${stub.MARKER}` }));
  assert.ok(marked.criteriaEvidence.find((c) => c.key === 'runbook_quality').evidence.startsWith('runbook/env-1/name'));
});

test('grading never passes an execution criterion without a passed check, marker or not', async () => {
  const phase = phases.implementation;
  const review = await provider.review(phase, reviewInput({ 'api/repository/tasks.py': `# ${stub.MARKER}\n` }));
  assert.equal(review.verdict, 'needs_revision');
  assert.ok(review.criteriaEvidence.some((c) => c.met === false));
});

test('the stakeholder answers from the reference facts, and the review credits only what was said', async () => {
  const brief = phases.requirements.interview;
  const reply = await provider.interview(brief, 'TaskTrackr', 'Is a task due today overdue?', []);
  const f2 = brief.facts.find((f) => f.id === 'F2');
  assert.equal(reply.content, f2.answer);
  const reviewed = await provider.reviewInterview({ brief, question: 'Is a task due today overdue?', answer: reply.content, claimedFactIds: [] });
  assert.equal(reviewed.safe, true);
  assert.deepEqual(reviewed.supportedFactIds, ['F2']);
});

test('an authored (teacher-written or derived) interview is answered and its review passes on the stub', async () => {
  // Not the reference's brief, so the API asks under its authored arm: the
  // reviewer schema is 'stakeholder_output_review_v6_authored' and the
  // reference rides inside the TEACHER_BRIEF fence (interview-review.ts).
  const brief = {
    persona: { name: 'Mei Tan', role: 'the owner of a small bakery' },
    opening: 'Thanks for coming. I need a way to take cake orders.',
    unknownReply: 'I have not decided that yet. What would you suggest?',
    refusal: 'That is your part of the work. Ask me what I need instead.',
    maxTurns: 12,
    factsExpected: 2,
    facts: [
      { id: 'F1', topic: 'Order cut-off time', answer: 'Orders placed after three in the afternoon are baked the next day.' },
      { id: 'F2', topic: 'Deposit for large cakes', answer: 'A cake for more than twenty people needs a deposit before we bake it.' },
    ],
  };
  const { isReferenceInterview } = require(path.join(root, 'apps/api/dist/content/reference-content.js'));
  const { interviewReviewSchema } = require(path.join(root, 'apps/api/dist/assistant/interview-review.js'));
  assert.equal(isReferenceInterview(brief), false);
  const question = 'What is the order cut-off time in the afternoon?';
  assert.equal(interviewReviewSchema({ brief, question, answer: 'x.', claimedFactIds: [] }).name, 'stakeholder_output_review_v6_authored');
  const before = { answer: stub.counts['interview.answer'] ?? 0, review: stub.counts['interview.review'] ?? 0 };
  const reply = await provider.interview(brief, 'Bakery Orders', question, []);
  assert.equal(reply.content, brief.facts[0].answer);
  const reviewed = await provider.reviewInterview({ brief, question, answer: reply.content, claimedFactIds: [] });
  assert.equal(reviewed.safe, true);
  assert.deepEqual(reviewed.supportedFactIds, ['F1']);
  assert.equal(stub.counts['interview.answer'], before.answer + 1);
  assert.equal(stub.counts['interview.review'], before.review + 1);
});

test('an authored review whose fenced reference is not JSON is refused with a 400, not guessed', async () => {
  const unrecognised = stub.counts.unrecognised ?? 0;
  const refused = await post({
    model: 'x',
    messages: [
      { role: 'system', content: 'Review.\nSERVER INTERVIEW REFERENCE (facts only):\n<<<TEACHER_BRIEF\nnot json\nTEACHER_BRIEF>>>\n- precedence' },
      { role: 'user', content: 'UNTRUSTED INTERVIEW DATA:\n{"question":"q","candidate":"a.","candidateEvidence":[{"id":"G1","text":"a."}]}' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'stakeholder_output_review_v6_authored', schema: {}, strict: true } },
  });
  assert.equal(refused.status, 400);
  assert.equal(stub.counts.unrecognised, unrecognised + 1);
});

test('a Guided mentor turn is drafted and approved by the Guided review', async () => {
  const ctx = {
    phase: phases.requirements,
    message: 'What should the acceptance criteria cover?',
    history: [],
    interactionCount: 0,
    topicUseCounts: {},
    signals: { todosRemaining: [], lastFailedChecks: [] },
  };
  const reply = await provider.chat(ctx);
  assert.match(reply.content, /\?$/);
  assert.equal(reply.provider, 'local-ai:gpt-5.6-luna');
});

test('the Agentic intent check, proposal and explanation gate pass the API\'s own parsers', async () => {
  const phase = phases.requirements;
  const { composeAgenticIntentAssessment, composeAgenticProposeGeneration } = require(path.join(root, 'apps/api/dist/assistant/agentic.service.js'));
  const { parseAssessment } = require(path.join(root, 'apps/api/dist/assistant/strict-assessment.js'));
  const {
    EXPLANATION_ASSESSMENT_PROMPT,
    explanationAssessmentResponseSchema,
    explanationEvidence,
    hasGroundedUnderstanding,
    parseModelExplanationAssessment,
  } = require(path.join(root, 'apps/api/dist/assistant/explanation-assessment.js'));
  // The Requirements record, as a story phase's editable workspace holds it.
  const { STORY_JSON, serialiseStory, validateStoryRecord } = require(path.join(root, 'packages/shared/dist/index.js'));
  const before = {
    id: 'US-4',
    title: 'See overdue tasks',
    persona: 'team lead',
    capability: 'to see every overdue task in one list',
    benefit: 'I can chase work before it slips further',
    criteria: [
      { id: 'AC-1', given: 'a task due yesterday', when: 'I open the overdue report', then: 'it is listed', tag: 'happy' },
      { id: 'AC-2', given: 'a task with no due date', when: 'I open the overdue report', then: 'it is not listed', tag: 'error' },
    ],
    scopeExclusions: ['editing tasks from the report'],
    notes: '',
  };
  const workspace = { [STORY_JSON]: serialiseStory(before) };
  const prompt = 'Add a boundary criterion to my story saying a task due today is not overdue.';

  const vague = await provider.structured(composeAgenticIntentAssessment(phase), { prompt: 'do it', workspace }, 3000);
  const asked = parseAssessment(vague.value);
  assert.equal(asked.adequate, false);
  assert.equal(asked.questions.length, 1);

  const intent = await provider.structured(composeAgenticIntentAssessment(phase), { prompt, workspace }, 3000);
  assert.equal(parseAssessment(intent.value).adequate, true);

  // The proposal is the whole record and nothing else: one more criterion, a
  // boundary one, the same story id, and still a record the API would accept.
  const generated = await provider.structured(composeAgenticProposeGeneration(phase, 'files'), { prompt, workspace }, 9000);
  const files = generated.value.files;
  assert.deepEqual(Object.keys(files), [STORY_JSON]);
  const checked = validateStoryRecord(files[STORY_JSON], before.id);
  assert.equal(checked.error, null);
  const after = checked.story;
  assert.equal(after.id, before.id);
  assert.equal(after.criteria.length, before.criteria.length + 1);
  assert.equal(after.criteria.at(-1).tag, 'boundary');
  assert.deepEqual(after.criteria.slice(0, -1), before.criteria);
  assert.ok(after.scopeExclusions.length >= before.scopeExclusions.length);
  assert.ok(!/^#|<!--/m.test(files[STORY_JSON]), 'no markdown in the record');

  // An unreadable record is left alone: no proposal rather than a broken one.
  const broken = await provider.structured(composeAgenticProposeGeneration(phase, 'files'),
    { prompt, workspace: { [STORY_JSON]: '{"id":"US-4"' } }, 9000).catch((error) => ({ error }));
  assert.ok(broken.error || !broken.value?.files?.[STORY_JSON], 'an unreadable record gets no proposal');

  const assess = async (explanation) => {
    const result = await provider.structured(`${EXPLANATION_ASSESSMENT_PROMPT}`, {
      reference: { originalRequest: prompt, before: workspace, proposedFiles: files },
      evidence: {},
      learnerAnswer: explanation,
      answerEvidence: explanationEvidence(explanation),
    }, 4500, undefined, explanationAssessmentResponseSchema(explanation));
    return parseModelExplanationAssessment(result.value, explanation);
  };
  const plain = 'The proposal appends one line to my story. Nothing else in the file changes.';
  const refused = await assess(plain);
  assert.equal(refused.adequate, false);
  assert.equal(hasGroundedUnderstanding(refused, plain), false);
  const marked = `${plain} I would compare the two versions to check it. ${stub.MARKER}`;
  const accepted = await assess(marked);
  assert.equal(accepted.adequate, true);
  assert.equal(hasGroundedUnderstanding(accepted, marked), true);
});

test('the Agentic proposal for a design adds one traced operation and fills one screen, and keeps everything else', async () => {
  const { composeAgenticProposeGeneration } = require(path.join(root, 'apps/api/dist/assistant/agentic.service.js'));
  const { DESIGN_JSON, serialiseDesign, validateDesignRecord, validateScreenContract } = require(path.join(root, 'packages/shared/dist/index.js'));
  const record = { entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }], relations: [], operations: [{ id: 'O1', name: 'getOverdue(today)', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: [] }],
    decisions: [{ id: 'D1', title: 't', choice: 'c', alternative: 'a', rationale: 'r', tradeOff: 'o', status: 'accepted', satisfies: [] }], sequence: 'Browser -> Api: getOverdue(today)' };
  const screens = JSON.stringify({ $comment: 'kept', screens: [{ route: '#/', component: 'ListsPage', reads: ['listLists'], components: ['ListsPage'], empty: 'No lists yet. Make the first one.' }, { route: '#/overdue', component: '', title: '', reads: [], components: [], empty: '' }] });
  const workspace = { [DESIGN_JSON]: serialiseDesign(record), 'shared/contract/screens.json': screens };
  const generated = await provider.structured(composeAgenticProposeGeneration(phases.design, 'files'), { prompt: 'Add an operation for US-4 and fill the overdue screen.', workspace, designStories: [{ id: 'US-4', title: 'Overdue', line: 'x' }] }, 9000);
  const files = generated.value.files;
  assert.deepEqual(Object.keys(files).sort(), [DESIGN_JSON, 'shared/contract/screens.json'].sort());
  const after = validateDesignRecord(files[DESIGN_JSON]);
  assert.equal(after.error, null);
  assert.deepEqual(after.design.operations.slice(0, 1), record.operations);
  assert.deepEqual(after.design.operations[1].satisfies, ['US-4']);
  assert.equal(after.design.decisions[0].status, 'accepted');
  assert.equal(after.design.sequence, record.sequence);
  assert.equal(validateScreenContract(files['shared/contract/screens.json']), null);
  const doc = JSON.parse(files['shared/contract/screens.json']);
  assert.equal(doc.$comment, 'kept');
  assert.equal(doc.screens[0].component, 'ListsPage');
  assert.ok(doc.screens[1].empty.length >= 15);
  // and the API's own carry check takes it as it is: nothing it would put back
  const { validateDesignProposal } = require(path.join(root, 'apps/api/dist/assistant/design-proposal.js'));
  const designPhase = { checks: { kind: 'design', record: DESIGN_JSON, contracts: { api: false, screens: true }, sequence: true } };
  assert.doesNotThrow(() => validateDesignProposal(files, designPhase, workspace));
});

test('the design arm adds no operation at the record\'s cap of 30, and still fills the screen', async () => {
  const { composeAgenticProposeGeneration } = require(path.join(root, 'apps/api/dist/assistant/agentic.service.js'));
  const { DESIGN_JSON, serialiseDesign } = require(path.join(root, 'packages/shared/dist/index.js'));
  const operations = Array.from({ length: 30 }, (_, i) => ({ id: `O${i + 1}`, name: `op${i + 1}(x)`, inputs: ['x'], returns: 'y', errors: [], satisfies: [] }));
  const screens = JSON.stringify({ screens: [{ route: '#/overdue', component: '', title: '', reads: [], components: [], empty: '' }] });
  const workspace = { [DESIGN_JSON]: serialiseDesign({ entities: [], relations: [], operations, decisions: [] }), 'shared/contract/screens.json': screens };
  const generated = await provider.structured(composeAgenticProposeGeneration(phases.design, 'files'), { prompt: 'Add an operation and fill the overdue screen.', workspace, designStories: [] }, 9000);
  assert.deepEqual(Object.keys(generated.value.files), ['shared/contract/screens.json']);
});

test('the runbook arm adds one filled item to the first empty list, with the next free id, and never touches the incident', async () => {
  const { composeAgenticProposeGeneration } = require(path.join(root, 'apps/api/dist/assistant/agentic.service.js'));
  const { RUNBOOK_JSON, serialiseRunbook, validateRunbookRecord } = require(path.join(root, 'packages/shared/dist/index.js'));
  const saved = { environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }], health: [{ id: 'H1', name: 'Stub', how: '', expected: '' }], rollback: [], data: [], incident: { rootCause: 'kept', fix: 'kept', actionItem: 'kept' } };
  const workspace = { [RUNBOOK_JSON]: serialiseRunbook(saved), '.github/workflows/ci.yml': 'name: ci\n' };
  const files = (await provider.structured(composeAgenticProposeGeneration(phases.deployment, 'files'), { prompt: 'Add a health check.', workspace }, 9000)).value.files;
  assert.deepEqual(Object.keys(files), [RUNBOOK_JSON]);
  const after = validateRunbookRecord(files[RUNBOOK_JSON]).runbook;
  assert.deepEqual(after.health[1], { id: 'H2', name: 'Stub check', how: 'stub --check', expected: 'stub: ok' });
  assert.deepEqual(after.incident, saved.incident);
});

test('the change arm fills the first empty section, covering the first acceptance id; the contract only when the switch is on', async () => {
  const { composeAgenticProposeGeneration } = require(path.join(root, 'apps/api/dist/assistant/agentic.service.js'));
  const { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, validateChangeRequestRecord } = require(path.join(root, 'packages/shared/dist/index.js'));
  const saved = { ...EMPTY_CHANGE_REQUEST, impact: { operations: ['listComments'], screens: [], files: [] }, contract: [{ id: 'C1', method: 'GET', path: '/x', change: 'added', why: 'w' }] };
  const workspace = { [CHANGE_REQUEST_JSON]: serialiseChangeRequest(saved) };
  const changeTicket = { id: 'CR-2', title: 't', summary: 's', acceptance: [{ id: 'AC-1', line: 'a' }] };
  const files = (await provider.structured(composeAgenticProposeGeneration(phases.maintenance, 'files'), { prompt: 'Add a test.', workspace, changeTicket, changeContract: true }, 9000)).value.files;
  const after = validateChangeRequestRecord(files[CHANGE_REQUEST_JSON], ['AC-1']).change;
  assert.deepEqual(after.tests, [{ id: 'T1', suite: 'stub suite', covers: ['AC-1'], result: 'not-run' }]);
  assert.deepEqual(after.contract, saved.contract);
  // an empty contract list is filled only when the payload's switch (changeContract, beside the ticket) is on
  const noContract = { [CHANGE_REQUEST_JSON]: serialiseChangeRequest({ ...saved, contract: [] }) };
  const on = (await provider.structured(composeAgenticProposeGeneration(phases.maintenance, 'files'), { prompt: 'Amend the contract.', workspace: noContract, changeTicket, changeContract: true }, 9000)).value.files;
  assert.deepEqual(validateChangeRequestRecord(on[CHANGE_REQUEST_JSON], ['AC-1']).change.contract, [{ id: 'C1', method: 'GET', path: '/stub', change: 'added', why: 'The stub needs it.' }]);
  const off = (await provider.structured(composeAgenticProposeGeneration(phases.maintenance, 'files'), { prompt: 'Add a test.', workspace: noContract, changeTicket, changeContract: false }, 9000)).value.files;
  assert.deepEqual(validateChangeRequestRecord(off[CHANGE_REQUEST_JSON], ['AC-1']).change.contract, []);
});

test('it binds the host it is given, for the Compose service', async () => {
  const other = await stub.start(0, '127.0.0.1');
  try {
    assert.equal(other.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});

test('every accepted call was counted by kind', () => {
  for (const kind of ['grading.review', 'interview.answer', 'interview.review', 'guided.draft', 'guided.review',
    'agentic.classify', 'agentic.generate', 'agentic.explanation']) {
    assert.ok(stub.counts[kind] >= 1, `${kind} counted`);
  }
});
