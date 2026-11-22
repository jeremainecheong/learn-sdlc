/**
 * A canned, loopback, OpenAI-compatible endpoint for the Playwright suite.
 *
 * It is a harness, not a model. The API under test is started with
 * OPENAI_BASE_URL pointing here and OPENAI_API_KEY set to the literal below, so
 * every AI request the suite causes reaches this process and nothing else:
 * no real provider is called, and no local model runs. `e2e/` is not packaged
 * (release.py), so none of this ships.
 *
 * What it answers, keyed on what the API actually sends (openai.provider.ts):
 *
 *   json_schema learning_rubric_review        grading.review
 *   json_schema stakeholder_output_review_v6  interview.review
 *   json_schema stakeholder_output_review_v6_authored
 *                                             interview.review (a teacher's
 *                                             or derived interview; reference
 *                                             inside the TEACHER_BRIEF fence)
 *   json_object + the Guided reviewer's line  guided.review
 *   json_object + the Agentic intent check    agentic.classify
 *   json_object + the Agentic chat triage     agentic.chat
 *   json_object + the Agentic files contract  agentic.generate (the story,
 *                                             design, runbook or change
 *                                             record, when it is editable)
 *   json_schema learner_understanding_v6      agentic.explanation
 *   plain text  + the mentor's line           guided.draft
 *   plain text  + the stakeholder's line      interview.answer
 *
 * Anything else is refused with a 400 and counted, so a new call kind shows up
 * as a failure rather than as a silent default.
 *
 * Every answer is built from the request itself, the schema's own criterion
 * keys and citations, the reference facts, the candidate's sentence ids, so
 * the API's real parsers accept it. The one judgement it makes is the grading
 * verdict: a review passes ONLY when the untrusted learner block of the request
 * carries the marker E2E-PASS. A spec that submits work without the marker gets
 * a Needs revision with a reason on every criterion, so a failure-before-success
 * walk stays honest: the stub never passes work nobody marked as passing.
 *
 * The Agentic explanation gate follows the same rule: an explanation is
 * accepted on every dimension only when it carries the marker, and otherwise
 * comes back with the three reasoning dimensions missing, so Apply stays shut.
 * The intent check calls a prompt of eight words or more adequate and asks
 * one question otherwise, and a proposal appends one comment line to one
 * editable file (the one the prompt names, when it names one).
 *
 *   node e2e/ai-stub.cjs            listens on $PW_AI_HOST:$PW_AI_PORT
 *                                   (127.0.0.1:4199 unless set)
 *   GET /__stub/counts              requests per call kind
 *
 * PW_AI_HOST exists for one caller: the Compose stack's `ai-stub` service
 * (docker-compose.ai-stub.yml), where the API reaches the stub over the
 * project's private network and 0.0.0.0 inside that container publishes
 * nothing on the host. Everything else leaves it unset.
 *
 * PW_AI_STUB_LOG, when set, receives one JSON line per request: the call kind,
 * the HTTP status and the verdict. Never the request body.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');

const HOST = process.env.PW_AI_HOST || '127.0.0.1';
const DEFAULT_PORT = 4199;
const KEY = 'e2e-stub-not-a-secret';
const MARKER = 'E2E-PASS';
const LEARNER_OPEN = '<<<LEARNER_DATA';
const LEARNER_CLOSE = 'LEARNER_DATA>>>';

/* ------------------------------ small helpers ----------------------------- */

/** Every stretch of text inside a learner-data fence, from user turns only. */
function learnerBlocks(messages) {
  const out = [];
  for (const message of messages) {
    if (!message || message.role !== 'user' || typeof message.content !== 'string') continue;
    let from = 0;
    for (;;) {
      const open = message.content.indexOf(LEARNER_OPEN, from);
      if (open < 0) break;
      const close = message.content.indexOf(LEARNER_CLOSE, open);
      if (close < 0) break;
      out.push(message.content.slice(open + LEARNER_OPEN.length, close));
      from = close + LEARNER_CLOSE.length;
    }
  }
  return out;
}

const systemOf = (messages) =>
  messages.filter((m) => m && m.role === 'system').map((m) => String(m.content ?? '')).join('\n');
const lastUserOf = (messages) => {
  const users = messages.filter((m) => m && m.role === 'user');
  return users.length ? String(users[users.length - 1].content ?? '') : '';
};

/** Undo the literal-escaping reviewResponseSchema applies to a citation. */
const unescapeLiteral = (value) => value.replace(/\\(.)/g, '$1');

/** Split `a|b|c` on the bars that are not escaped. */
function literalAlternatives(pattern) {
  const out = [];
  let current = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      current += ch + pattern[i + 1];
      i++;
    } else if (ch === '|') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map(unescapeLiteral).filter(Boolean);
}

/* -------------------------------- the calls -------------------------------- */

/** grading.review: one entry per criterion key the schema allows, in order. */
function gradingReview(body, messages) {
  const schema = body.response_format.json_schema.schema;
  const variants = schema?.properties?.criteriaEvidence?.items?.anyOf;
  if (!Array.isArray(variants) || !variants.length) return null;
  const rows = new Map();
  for (const variant of variants) {
    const key = variant?.properties?.key?.enum?.[0];
    const met = variant?.properties?.met?.enum?.[0];
    if (typeof key !== 'string' || typeof met !== 'boolean') return null;
    const row = rows.get(key) ?? { key, citations: null };
    if (met) row.citations = literalAlternatives(String(variant.properties.evidence?.pattern ?? ''));
    rows.set(key, row);
  }
  const marked = learnerBlocks(messages).some((block) => block.includes(MARKER));
  // a record's projection path (runbook/..., change/...) is cited before any file, so the record criteria cite the record
  const cite = (citations) => citations.find((c) => /^(runbook|change)\//.test(c)) ?? citations[0];
  const criteriaEvidence = [...rows.values()].map(({ key, citations }) =>
    marked && citations && citations.length
      ? { key, met: true, evidence: `${cite(citations)} meets ${key} (e2e stub).`, issue: '', nextStep: '' }
      : {
          key,
          met: false,
          evidence: marked ? `No passing evidence can be cited for ${key} (e2e stub).` : `The submission is not marked ${MARKER} (e2e stub).`,
          issue: `The e2e stub does not pass ${key} for this submission.`,
          nextStep: `Revise ${key} and submit again.`,
        },
  );
  const pass = criteriaEvidence.every((row) => row.met);
  return {
    verdict: pass ? 'pass' : 'needs_revision',
    content: {
      verdict: pass ? 'pass' : 'needs_revision',
      summary: pass ? 'Every criterion is met (e2e stub).' : 'Some criteria are not met yet (e2e stub).',
      strengths: pass ? ['The submission is marked for the e2e stub.'] : [],
      improvements: pass ? [] : ['Revise the unmet criteria and submit again.'],
      processNote: 'Assessed by the e2e stub.',
      criteriaEvidence,
    },
  };
}

const REFERENCE_LABEL = 'SERVER INTERVIEW REFERENCE (facts only):';
const TEACHER_BRIEF_OPEN = '<<<TEACHER_BRIEF';

/**
 * The reviewer's reference, as the one JSON line the API wrote
 * (interview-review.ts composeInterviewReviewMessages): on the reference arm
 * it follows the label and a space; on the authored arm (a teacher's or a
 * derived interview) it is the first line inside the TEACHER_BRIEF fence that
 * follows the label. Anything else is not a reference this stub can read.
 */
function referenceLine(system) {
  const at = system.indexOf(REFERENCE_LABEL);
  if (at < 0) return null;
  const rest = system.slice(at + REFERENCE_LABEL.length);
  if (rest.startsWith(' ')) return rest.slice(1).split('\n')[0];
  const fenced = `\n${TEACHER_BRIEF_OPEN}\n`;
  if (rest.startsWith(fenced)) return rest.slice(fenced.length).split('\n')[0];
  return null;
}

/** interview.review: safe, and a fact is supported only if its answer is quoted. */
function interviewReview(body, messages) {
  const system = systemOf(messages);
  const refLine = referenceLine(system);
  const user = lastUserOf(messages);
  const dataAt = user.indexOf('\n');
  if (refLine === null || dataAt < 0) return null;
  let brief;
  let data;
  try {
    brief = JSON.parse(refLine);
    data = JSON.parse(user.slice(dataAt + 1));
  } catch {
    return null;
  }
  const ids = Array.isArray(data.candidateEvidence) ? data.candidateEvidence.map((e) => e.id) : [];
  const candidate = String(data.candidate ?? '');
  if (!ids.length || !Array.isArray(brief.facts)) return null;
  const facts = {};
  for (const fact of brief.facts) {
    const supported = typeof fact.answer === 'string' && candidate.includes(fact.answer);
    facts[fact.id] = {
      status: supported ? 'supported' : 'unaddressed',
      reason: supported ? 'The answer states this rule (e2e stub).' : 'The answer does not state this rule (e2e stub).',
      candidateEvidenceIds: [ids[0]],
    };
  }
  const check = (key) => ({ key, met: true, reason: 'Acceptable (e2e stub).', candidateEvidenceIds: [ids[0]] });
  return { content: { checks: [check('grounded'), check('relevant'), check('no_artifact')], facts } };
}

/** guided.review: approve the exact candidate, citing its own sentence ids. */
function guidedReview(messages) {
  const block = learnerBlocks(messages)[0];
  if (block === undefined) return null;
  const json = block.slice(block.indexOf('\n') + 1).trim();
  let evidence;
  try {
    evidence = JSON.parse(json);
  } catch {
    return null;
  }
  const ids = Array.isArray(evidence.candidateEvidence) ? evidence.candidateEvidence.map((e) => e.id) : [];
  if (!ids.length) return null;
  const check = (key) => ({ key, met: true, candidateEvidenceIds: [ids[0]], reason: 'Acceptable (e2e stub).' });
  return {
    content: {
      revealedDecisions: [],
      remainingReasoning: { description: 'The learner predicts one case (e2e stub).', substantive: true, candidateEvidenceIds: [ids[ids.length - 1]] },
      checks: [check('limited_step'), check('grounded'), check('learner_reasoning')],
    },
  };
}

const GUIDED_DRAFT =
  'Start from what your saved work already shows. Which single case would you check first, and what do you expect it to give?';

const STOP = new Set(
  'a an the is are was be do does did of to in on it its and or for with what should would how i you me my your we this that there up'.split(' '),
);
const words = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

/** interview.answer: the reference fact the question is about, in its own words. */
function interviewAnswer(messages) {
  const system = systemOf(messages);
  const facts = [];
  for (const line of system.split('\n')) {
    const match = /^\[([A-Za-z0-9_-]+)\] (.+?) — "(.*)"$/.exec(line);
    if (match) facts.push({ id: match[1], topic: match[2], answer: match[3] });
  }
  const question = new Set(words(lastUserOf(messages)));
  let best = null;
  let bestScore = 0;
  for (const fact of facts) {
    const score =
      2 * words(fact.topic).filter((w) => question.has(w)).length +
      words(fact.answer).filter((w) => question.has(w)).length;
    if (score > bestScore) {
      best = fact;
      bestScore = score;
    }
  }
  return best ? best.answer : 'I have not decided that particular matter yet. What would you suggest?';
}

/* ------------------------------ the Agentic calls ------------------------------ */

/** The JSON object the structured calls carry inside their one learner block. */
function structuredData(messages) {
  const block = learnerBlocks(messages)[0];
  if (block === undefined) return null;
  try {
    return JSON.parse(block.slice(block.indexOf('\n') + 1).trim());
  } catch {
    return null;
  }
}

/** agentic.classify: adequate from eight words up, otherwise one question. */
function agenticClassify(messages) {
  const data = structuredData(messages);
  if (!data || typeof data.prompt !== 'string') return null;
  const adequate = data.prompt.trim().split(/\s+/).filter(Boolean).length >= 8;
  return adequate
    ? { adequate: true, feedback: 'The request names a bounded change (e2e stub).', questions: [] }
    : {
        adequate: false,
        feedback: 'The request does not yet say which change you want (e2e stub).',
        questions: ['Which file should change, and what should it do differently?'],
      };
}

/** agentic.chat: a request to change something is a proposal, anything else a discussion. */
function agenticChat(messages) {
  const data = structuredData(messages);
  const text = String(data?.currentMessage ?? '');
  if (!text.trim()) return null;
  const wantsChange = /\b(add|change|edit|fix|rename|remove|update|write|propose|refactor)\b/i.test(text);
  return wantsChange
    ? { kind: 'proposal', reply: 'Review the proposed files below (e2e stub).', questions: [] }
    : { kind: 'discussion', reply: 'The proposal changes only the files it lists (e2e stub).', questions: [] };
}

const COMMENT = [
  [/\.(py|sh|ya?ml|toml|txt)$/, (text) => `# ${text}`],
  [/\.(js|jsx|ts|tsx|mjs|cjs|css)$/, (text) => `// ${text}`],
  [/\.(md|html)$/, (text) => `<!-- ${text} -->`],
];

/** The Requirements story record (STORY_JSON in @learnsdlc/shared). */
const STORY_RECORD = 'requirements/story.json';
const STORY_LIST_CAP = 20; // STORY_CAPS.listItems
const BOUNDARY_CRITERION = { given: 'a task due today', when: 'I open the overdue report', then: 'it is not listed', tag: 'boundary' };
const STUB_EXCLUSION = 'reminders and notifications';

/**
 * The record arm of agentic.generate: the saved story with one boundary
 * criterion and one out-of-scope line added, as the whole record. The id and
 * every existing field are kept; criteria are renumbered AC-1..n as the room
 * numbers them, and nothing grows past the record's list cap. A record that
 * does not read as one gets no proposal (null), so the file stays as it is.
 * Self-contained on purpose: the Compose service mounts this file alone.
 */
function storyProposal(text) {
  let story;
  try {
    story = JSON.parse(text);
  } catch {
    return null;
  }
  if (!story || typeof story !== 'object' || Array.isArray(story)) return null;
  if (typeof story.id !== 'string' || !Array.isArray(story.criteria) || !Array.isArray(story.scopeExclusions)) return null;
  const criteria = story.criteria.length < STORY_LIST_CAP ? [...story.criteria, { id: '', ...BOUNDARY_CRITERION }] : [...story.criteria];
  const scopeExclusions =
    story.scopeExclusions.includes(STUB_EXCLUSION) || story.scopeExclusions.length >= STORY_LIST_CAP
      ? [...story.scopeExclusions]
      : [...story.scopeExclusions, STUB_EXCLUSION];
  const next = { ...story, criteria: criteria.map((c, i) => ({ ...c, id: `AC-${i + 1}` })), scopeExclusions };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** The Design record (DESIGN_JSON in @learnsdlc/shared) and the screen contract beside it. */
const DESIGN_RECORD = 'design/design.json';
const SCREEN_CONTRACT = 'shared/contract/screens.json';
const DESIGN_OPERATIONS_CAP = 30; // DESIGN_CAPS.operations

/**
 * The design arm of agentic.generate: the record with one traced operation
 * added, and the first screen row with no component filled. Every other key,
 * row, id and status is kept and the sequence is untouched, so the proposal
 * is one validateDesignProposal accepts. An unreadable record gets no
 * proposal (null); an unreadable contract is left alone.
 */
function designProposal(workspace, stories) {
  let record;
  try {
    record = JSON.parse(workspace[DESIGN_RECORD]);
  } catch {
    return null;
  }
  if (!record || !Array.isArray(record.operations)) return null;
  const files = {};
  // at the record's operation cap the stub adds none, as STORY_LIST_CAP holds the story arm
  if (record.operations.length < DESIGN_OPERATIONS_CAP) {
    const taken = new Set(record.operations.map((op) => op.id));
    let n = record.operations.length + 1;
    while (taken.has(`O${n}`)) n += 1;
    const story = Array.isArray(stories) && stories[0] && typeof stories[0].id === 'string' ? stories[0].id : null;
    record.operations.push({ id: `O${n}`, name: 'stubOperation(input)', inputs: ['input'], returns: 'the stub result', errors: [], satisfies: story ? [story] : [] });
    files[DESIGN_RECORD] = `${JSON.stringify(record, null, 2)}\n`;
  }
  if (typeof workspace[SCREEN_CONTRACT] === 'string') {
    try {
      const doc = JSON.parse(workspace[SCREEN_CONTRACT]);
      const row = Array.isArray(doc.screens) ? doc.screens.find((s) => s && typeof s === 'object' && !String(s.component ?? '').trim()) : null;
      if (row) {
        Object.assign(row, { component: 'StubScreen', title: row.title || 'Stub screen', reads: ['stubOperation'], components: ['StubScreen'], empty: 'Nothing to show here yet, the stub says.' });
        files[SCREEN_CONTRACT] = `${JSON.stringify(doc, null, 2)}\n`;
      }
    } catch {
      /* an unreadable contract is left alone */
    }
  }
  return Object.keys(files).length ? { files } : null;
}

/** The runbook record (RUNBOOK_JSON in @learnsdlc/shared), its list cap, and the ids the room mints. */
const RUNBOOK_RECORD = 'deployment/runbook.json';
const RUNBOOK_LIST_CAP = 20; // RUNBOOK_CAPS.listItems
const RUNBOOK_STUBS = {
  environment: ['E', { name: 'STUB_SETTING', purpose: 'What the stub says this setting controls.', kind: 'config' }],
  health: ['H', { name: 'Stub check', how: 'stub --check', expected: 'stub: ok' }],
  rollback: ['R', { step: 'Run the stub rollback.', verify: 'The stub check passes again.' }],
  data: ['D', { what: 'The stub store', how: 'Copied nightly by the stub.', where: 'The stub volume' }],
};
/**
 * A copy of the shared filled-item rule (filledRunbookCounts in
 * @learnsdlc/shared, spec 5.1's table), written again because the Compose
 * service mounts this file alone: an item counts when every field named
 * here is non-blank.
 */
const filled = {
  environment: (e) => [e.name, e.purpose].every((t) => String(t ?? '').trim()),
  health: (h) => [h.name, h.how, h.expected].every((t) => String(t ?? '').trim()),
  rollback: (s) => [s.step, s.verify].every((t) => String(t ?? '').trim()),
  data: (d) => [d.what, d.how, d.where].every((t) => String(t ?? '').trim()),
};
/** The next free number after `letter` among the list's ids (a copy of nextItemId's rule in @learnsdlc/shared, written again: the Compose service mounts this file alone). */
function nextId(list, letter) {
  let n = 1;
  for (const item of list) {
    const m = new RegExp(`^${letter}(\\d+)$`).exec(String(item.id));
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${letter}${n}`;
}

/**
 * The runbook arm of agentic.generate: one filled item added to the first of
 * environment, health, rollback and data that holds no filled item; when all
 * four hold one, one environment entry under the cap; at the cap, nothing.
 * The incident is never touched (a drill phase carries it).
 */
function runbookProposal(text) {
  let runbook;
  try {
    runbook = JSON.parse(text);
  } catch {
    return null;
  }
  if (!runbook || typeof runbook !== 'object' || !Array.isArray(runbook.environment)) return null;
  const list = ['environment', 'health', 'rollback', 'data'].find((key) => Array.isArray(runbook[key]) && !runbook[key].some(filled[key])) ?? 'environment';
  if (runbook[list].length >= RUNBOOK_LIST_CAP) return null;
  const [letter, item] = RUNBOOK_STUBS[list];
  runbook[list] = [...runbook[list], { id: nextId(runbook[list], letter), ...item }];
  return `${JSON.stringify(runbook, null, 2)}\n`;
}

/** The change request record (CHANGE_REQUEST_JSON in @learnsdlc/shared). */
const CHANGE_RECORD = 'maintenance/change-request.json';

/**
 * The change arm: fills the first empty one of the impact's operations, the
 * contract (only when the payload's `changeContract` switch is on), the tests
 * and the release's change lines, covering the ticket's first acceptance id
 * (`changeTicket`, as the design arm reads `designStories`). When none is
 * empty, nothing.
 */
function changeProposal(text, ticket, contract) {
  let change;
  try {
    change = JSON.parse(text);
  } catch {
    return null;
  }
  if (!change || typeof change !== 'object' || !change.impact || !change.release) return null;
  const first = Array.isArray(ticket?.acceptance) && ticket.acceptance[0] ? [String(ticket.acceptance[0].id)] : [];
  if (!change.impact.operations.length) change.impact.operations = ['stubOperation'];
  else if (contract === true && !change.contract.length) change.contract = [{ id: 'C1', method: 'GET', path: '/stub', change: 'added', why: 'The stub needs it.' }];
  else if (!change.tests.length) change.tests = [{ id: 'T1', suite: 'stub suite', covers: first, result: 'not-run' }];
  else if (!change.release.changes.length) change.release.changes = [{ id: 'L1', line: 'The stub change line.', covers: first }];
  else return null;
  return `${JSON.stringify(change, null, 2)}\n`;
}

/**
 * agentic.generate. When the story record is editable, the proposal is the
 * record alone (storyProposal above); when the design record is, the record
 * and perhaps the screen contract (designProposal above); when the runbook or
 * the change request is, that record alone (runbookProposal, changeProposal
 * above), so Deployment and Maintenance never reach the fall-through. Otherwise one
 * comment line appended to one editable file: the file the prompt names wins, else the first, by path,
 * whose type takes a comment. JSON takes none, so a JSON-only workspace gets
 * no proposal and the API says so, as it does for any model that proposes
 * nothing.
 */
function agenticGenerate(messages) {
  const data = structuredData(messages);
  const workspace = data && (data.workspace ?? data.proposedWorkspace);
  if (!workspace || typeof workspace !== 'object') return null;
  if (typeof workspace[STORY_RECORD] === 'string') {
    const record = storyProposal(workspace[STORY_RECORD]);
    return record === null ? null : { files: { [STORY_RECORD]: record } };
  }
  if (typeof workspace[DESIGN_RECORD] === 'string') return designProposal(workspace, data.designStories);
  if (typeof workspace[RUNBOOK_RECORD] === 'string') {
    const record = runbookProposal(workspace[RUNBOOK_RECORD]);
    return record === null ? null : { files: { [RUNBOOK_RECORD]: record } };
  }
  if (typeof workspace[CHANGE_RECORD] === 'string') {
    const record = changeProposal(workspace[CHANGE_RECORD], data.changeTicket, data.changeContract === true);
    return record === null ? null : { files: { [CHANGE_RECORD]: record } };
  }
  const prompt = String(data.prompt ?? data.originalAndContinuedRequest ?? '');
  const commentable = Object.keys(workspace)
    .filter((path) => typeof workspace[path] === 'string' && COMMENT.some(([pattern]) => pattern.test(path)))
    .sort();
  const path = commentable.find((candidate) => prompt.includes(candidate)) ?? commentable[0];
  if (!path) return null;
  const [, comment] = COMMENT.find(([pattern]) => pattern.test(path));
  const body = workspace[path];
  const line = comment('Proposed by the e2e stub: one line, nothing else changed.');
  return { files: { [path]: `${body}${body.endsWith('\n') || !body ? '' : '\n'}${line}\n` } };
}

/** agentic.explanation: every dimension met only for a marked answer. */
function agenticExplanation(messages) {
  const data = structuredData(messages);
  const ids = Array.isArray(data?.answerEvidence) ? data.answerEvidence.map((unit) => unit.id).filter((id) => typeof id === 'string') : [];
  if (!ids.length || typeof data.learnerAnswer !== 'string') return null;
  const marked = data.learnerAnswer.includes(MARKER);
  const dimension = (key) =>
    marked
      ? { key, met: true, finding: 'supported', learnerEvidenceIds: ids }
      : key === 'consistency'
        ? { key, met: true, finding: 'supported', learnerEvidenceIds: [ids[0]] }
        : { key, met: false, finding: 'missing', learnerEvidenceIds: [] };
  return { dimensions: ['effects', 'constraints', 'verification', 'consistency'].map(dimension) };
}

/* -------------------------------- the server ------------------------------- */

const counts = {};
const bump = (kind) => {
  counts[kind] = (counts[kind] ?? 0) + 1;
};

function log(entry) {
  const file = process.env.PW_AI_STUB_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // a log that cannot be written is not a reason to fail the call
  }
}

function send(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function refuse(res, kind, status, message) {
  bump(kind);
  log({ call: kind, status });
  send(res, status, { error: { message, type: 'invalid_request_error' } });
}

function completion(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return {
    id: `chatcmpl-e2e-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'e2e-stub',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/** Which call this is, from the response format and the system prompt's fixed line. */
function classify(body, messages) {
  const format = body.response_format;
  const system = systemOf(messages);
  if (format && format.type === 'json_schema') {
    const name = format.json_schema && format.json_schema.name;
    if (name === 'learning_rubric_review') return 'grading.review';
    if (name === 'stakeholder_output_review_v6' || name === 'stakeholder_output_review_v6_authored') return 'interview.review';
    if (name === 'learner_understanding_v6') return 'agentic.explanation';
    return null;
  }
  if (format && format.type === 'json_object') {
    if (system.startsWith('You review a proposed Guided mentor reply before the learner may see it.')) return 'guided.review';
    if (system.includes("Assess whether the learner's prompt provides adequate intent")) return 'agentic.classify';
    if (system.includes("You are having a normal conversation about the learner's intended change.")) return 'agentic.chat';
    // The prompt's closing brace moved in 75ef854d; match the sentence up to the file's value, as it has read since.
    if (system.includes('Return {"files":{"editable/path":"complete revised file contents"}')) return 'agentic.generate';
    return null;
  }
  if (format) return null;
  if (/^Your name is [^\n]*\. You are the [^\n]* mentor\./.test(system)) return 'guided.draft';
  if (/^You are [^\n]* project\. A learner is interviewing you about what they should build\./.test(system)) return 'interview.answer';
  return null;
}

function handle(req, res, raw) {
  const url = new URL(req.url, `http://${HOST}`);
  if (req.method === 'GET' && url.pathname === '/__stub/counts') return send(res, 200, { counts });
  if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
    return refuse(res, 'unrecognised', 404, 'The e2e stub answers POST /v1/chat/completions only.');
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return refuse(res, 'unauthorised', 401, 'The e2e stub requires its literal key.');
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(res, 'unrecognised', 400, 'The body is not JSON.');
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const kind = classify(body, messages);
  if (!kind) return refuse(res, 'unrecognised', 400, 'The e2e stub does not recognise this call.');
  let answer = null;
  let verdict;
  if (kind === 'grading.review') {
    const review = gradingReview(body, messages);
    if (review) {
      answer = review.content;
      verdict = review.verdict;
    }
  } else if (kind === 'interview.review') answer = interviewReview(body, messages)?.content ?? null;
  else if (kind === 'guided.review') answer = guidedReview(messages)?.content ?? null;
  else if (kind === 'agentic.classify') answer = agenticClassify(messages);
  else if (kind === 'agentic.chat') answer = agenticChat(messages);
  else if (kind === 'agentic.generate') answer = agenticGenerate(messages);
  else if (kind === 'agentic.explanation') answer = agenticExplanation(messages);
  else if (kind === 'guided.draft') answer = GUIDED_DRAFT;
  else if (kind === 'interview.answer') answer = interviewAnswer(messages);
  if (answer === null) return refuse(res, 'unrecognised', 400, `The e2e stub could not read this ${kind} request.`);
  bump(kind);
  log({ call: kind, status: 200, ...(verdict ? { verdict } : {}) });
  return send(res, 200, completion(answer));
}

function start(port = Number(process.env.PW_AI_PORT || DEFAULT_PORT), host = HOST) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        refuse(res, 'unrecognised', 400, 'The e2e stub could not answer.');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { start, counts, MARKER, KEY, DEFAULT_PORT };

if (require.main === module) {
  start().then(
    (server) => {
      const { port } = server.address();
      process.stdout.write(`e2e ai stub on ${server.address().address}:${port}\n`);
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    },
    (error) => {
      process.stderr.write(`e2e ai stub could not start: ${error.message}\n`);
      process.exit(1);
    },
  );
}
