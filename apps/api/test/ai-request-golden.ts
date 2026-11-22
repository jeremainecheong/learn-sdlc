import 'reflect-metadata';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import type { FeedbackCheck, FeedbackReport } from '@learnsdlc/shared';
import { CHANGE_REQUEST_JSON, DESIGN_JSON, RUNBOOK_JSON, STORY_JSON, serialiseDesign, validateDesignRecord } from '@learnsdlc/shared';
import { config } from '../src/config';
import { ContentService } from '../src/content/content.service';
import type { PhaseContent } from '../src/content/content.types';
import { soleTaskFor } from '../src/content/pack-compiler';
import {
  AiCacheEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../src/db/entities';
import type { FeedbackService } from '../src/feedback/feedback.service';
import { InstructorNoteEntity } from '../src/instructor/notes.entity';
import { NotesService } from '../src/instructor/notes.service';
import { WorkflowService } from '../src/workflow/workflow.service';
import { AgentProposalEntity } from '../src/assistant/agent-proposal.entity';
import { AgenticService, regenerationSentence } from '../src/assistant/agentic.service';
import { classifyReaskNote } from '../src/assistant/classify-reask';
import { AssistantService, REVIEW_USAGE_PROVIDER } from '../src/assistant/assistant.service';
import { ExplainService } from '../src/assistant/explain.service';
import { UNDERSTANDING_DIMENSIONS, explanationEvidence } from '../src/assistant/explanation-assessment';
import { GUIDED_REVIEW_KEYS, guidedEvidence } from '../src/assistant/guided-review';
import { INTERVIEW_REVIEW_KEYS } from '../src/assistant/interview-review';
import { InterviewService } from '../src/assistant/interview.service';
import { LocalMentorProvider } from '../src/assistant/local.provider';
import type { ExplainTestDto } from '../src/assistant/mentor.dto';
import { AI_CALL_LABELS, type AiCallLabel } from '../src/assistant/model-call-timing';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { EditExpansionError, editListRefusalReason } from '../src/assistant/proposal-edits';
import { RefusedProposalException } from '../src/assistant/proposal-refusal';
import type { ReviewInput } from '../src/assistant/provider.types';
import { fixedState, graderFor } from './verdict-golden';
import { FIXTURES_DIR } from './fixtures/paths';
import { memoryDataSource } from './support/memory-db';

/**
 * The request-bytes golden: what TaskTrackr's model calls **send**, recorded
 * as one sha256 per request body.
 *
 * Two other nets hold the loader (`content-golden.ts`) and the grader
 * (`verdict-golden.ts`). Neither sees a prompt: the grader's reviewer is a
 * stub there, and the loader stops before any prompt is composed. This one
 * holds the promise that TaskTrackr's requests to the model stay
 * **byte-identical** while the prompts are scoped to the content that declares
 * them, and turns it into a command.
 *
 * **What is recorded, and what is not.** Every body goes through the real
 * `OpenAiProvider`: its composers, its schemas, its `JSON.stringify` of
 * `{model, messages, reasoning_effort, max_completion_tokens,
 * response_format}`: to a recording `fetch` that answers fixed canned JSON.
 * The fixture keeps `{surface, phase, scenario, call, sha256, length}` per
 * body and **never the body**: a body carries the pack's workspace bytes, and
 * no committed fixture carries content (the verdict-golden rule). No key is
 * needed or kept either; the recorder sets a placeholder for the length of a
 * run and puts the old value back.
 *
 * **Through the production call paths, not beside them**:
 * - grading reaches the provider through `FeedbackService.buildReport` →
 *   `AssistantService.reviewSubmission` → `OpenAiProvider.review`, on the same
 *   `graderFor`/`fixedState` the verdict net grades with, so the task slice,
 *   `editableSnapshot` and the check list are what production builds. Two
 *   more grading scenarios compose from fixed inputs straight into
 *   `OpenAiProvider.review` (scaffold with no checks; one fixed check list
 *   that sets passed/failed/warning on every mapped id);
 * - Guided turns, lesson turns and explain turns go through
 *   `AssistantService.chat` (and `ExplainService.explainFailingTest`), so the
 *   lesson wrap, the memory, the instructor notes and the signals are what
 *   production builds;
 * - the interview goes through `InterviewService.ask`;
 * - every Agentic call goes through `AgenticService` (`propose`, `explain`,
 *   `chat`).
 *
 * The services are the real ones, over an in-memory SQLite database and the
 * pack loaded from disk, exactly as their own specs build them. Each scenario
 * is a fresh learner, so no history, cache entry or memory leaks from one
 * scenario into the next.
 *
 * `StuckService` is not here because it makes no model call: it has no
 * provider (the spec pins that). The offline `LocalMentorProvider` is not here
 * because it sends nothing.
 *
 * Regenerating the fixture is a deliberate act with a reason (a planned
 * change to a reference prompt, declared per surface when the fixture is
 * regenerated) and it is never the fix for a failing step.
 */

/** The pack this net holds, and the settings it is recorded under (the hard limit). */
export const AI_GOLDEN_PACK = 'tasktrackr';
export const AI_GOLDEN_MODEL = 'gpt-5.6-luna';
export const AI_GOLDEN_EFFORT = 'none';
/** The production endpoint. The recorder refuses every other URL. */
export const AI_GOLDEN_BASE_URL = 'https://api.openai.com/v1';
/** A placeholder so `available` is true. Not a key, never sent anywhere. */
const PLACEHOLDER_KEY = 'golden-recorder-placeholder-not-a-key';

/**
 * The default fixture records the code-default settings (AI_AGENTIC_EDIT_LIST
 * off, AI_AGENTIC_PAYLOAD full). The `trim` one records the same scenarios
 * with AI_AGENTIC_PAYLOAD=trim, beside it. The `strict` one records them with
 * AI_AGENTIC_EDIT_LIST=strict: every Agentic generation is then
 * `agentic.generate.edits`, answered in the edit-list shape, plus one
 * regeneration scenario and, after it, one prompt assessment re-ask scenario,
 * appended last.
 */
export type AiRequestFixtureVariant = 'trim' | 'strict';

export function aiRequestFixturePath(dir: string = FIXTURES_DIR, variant?: AiRequestFixtureVariant): string {
  return path.join(dir, `${AI_GOLDEN_PACK}-ai-request-digests${variant ? `-${variant}` : ''}.json`);
}

/** One request body, as the fixture keeps it: never the body itself. */
export interface AiRequestEntry {
  /** The production call label (`model-call-timing.ts` `AI_CALL_LABELS`). */
  surface: AiCallLabel;
  phase: string;
  scenario: string;
  /** 1-based position of this body inside its scenario. */
  call: number;
  sha256: string;
  /** UTF-8 byte length of the body. */
  length: number;
}

export interface AiRequestManifest {
  pack: string;
  version: string;
  model: string;
  effort: string;
  entries: AiRequestEntry[];
}

/** What a recorded body parses to: only the fields the canned replies read. */
export interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  reasoning_effort?: string;
  max_completion_tokens?: number;
  response_format?: { type: string; json_schema?: { name: string; schema: Record<string, any> } };
}

type Reply = (request: ModelRequest) => string;
type ScriptedCall = [AiCallLabel, Reply];

/* ------------------------------ the transport ----------------------------- */

/**
 * A `fetch` that starts nothing and remembers every model request body, in
 * order, answering each from the scenario's own script.
 *
 * It refuses any URL but `${config.openaiBaseUrl}/chat/completions`, so a
 * path that tried to reach anything else (a local model's version probe, a
 * second endpoint) fails the recording rather than being recorded as if it
 * were a model call. It also refuses a call the scenario did not declare.
 */
export class RecordingTransport {
  readonly bodies: string[] = [];
  private replies: Reply[] = [];

  /** Arm the transport for one scenario. */
  script(replies: Reply[]): void {
    this.bodies.length = 0;
    this.replies = [...replies];
  }

  /** Canned replies the scenario declared and the code never asked for. */
  get unused(): number {
    return this.replies.length;
  }

  readonly fetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url);
    const allowed = `${config.openaiBaseUrl}/chat/completions`;
    if (url !== allowed) {
      throw new Error(`the AI-request recorder refuses ${url}: the only model endpoint is ${allowed}`);
    }
    if (typeof init?.body !== 'string') throw new Error('the AI-request recorder saw a model request with no string body');
    this.bodies.push(init.body);
    const reply = this.replies.shift();
    if (!reply) throw new Error(`the AI-request recorder saw an undeclared model call (#${this.bodies.length})`);
    const content = reply(JSON.parse(init.body) as ModelRequest);
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

export const digestOfBody = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

/* ----------------------------- canned replies ----------------------------- */

const RECORDED = 'Recorded for the request-bytes golden.';

const GUIDED_DRAFT = 'Start from the brief. Which single sentence in it names the behaviour you are least sure about, and what would you check first to confirm it?';
const GUIDED_REPAIR_DRAFT = 'Pick one requirement from the brief and restate it in your own words. What one observation in your saved files would show it is met?';

/** A schema-valid Guided output review of `candidate`; `failing` names the checks to fail. */
function guidedReview(candidate: string, failing: readonly string[] = []): Reply {
  return () => {
    const ids = guidedEvidence(candidate).map((unit) => unit.id);
    return JSON.stringify({
      revealedDecisions: [],
      remainingReasoning: { description: 'The learner still chooses what to check.', substantive: true, candidateEvidenceIds: [ids[ids.length - 1]] },
      checks: GUIDED_REVIEW_KEYS.map((key) => ({ key, met: !failing.includes(key), candidateEvidenceIds: [ids[0]], reason: RECORDED })),
    });
  };
}

const text = (value: string): Reply => () => value;

/** A needs-revision rubric review over exactly the criteria the request's schema names. */
const rubricReview: Reply = (request) => {
  const variants = (request.response_format?.json_schema?.schema?.properties?.criteriaEvidence?.items?.anyOf ?? []) as Array<{ properties: { key: { enum: string[] } } }>;
  const keys = [...new Set(variants.map((variant) => variant.properties.key.enum[0]))];
  return JSON.stringify({
    verdict: 'needs_revision',
    summary: RECORDED,
    strengths: [],
    improvements: [RECORDED],
    processNote: RECORDED,
    criteriaEvidence: keys.map((key) => ({ key, met: false, evidence: RECORDED, issue: RECORDED, nextStep: RECORDED })),
  });
};

const INTERVIEW_ANSWER = 'Thanks for asking. I mostly need to see which work is running late so I can follow it up, and I am happy to go through a specific case with you.';
const INTERVIEW_REPAIR_ANSWER = 'Good question. I use the list to decide who to follow up with this week, so tell me which case you want to check.';
const INTERVIEW_SECOND_ANSWER = 'For that case I would rather keep it simple, so ask me about the exact situation you have in mind.';

/** A schema-valid stakeholder review of `answer`; `failing` fails checks, `supported` settles facts. */
function interviewReview(answer: string, failing: readonly string[] = [], supported: 'first' | 'none' = 'none'): Reply {
  return (request) => {
    const ids = guidedEvidence(answer).map((unit) => unit.id);
    const facts = Object.keys(request.response_format?.json_schema?.schema?.properties?.facts?.properties ?? {});
    return JSON.stringify({
      checks: INTERVIEW_REVIEW_KEYS.map((key) => ({ key, met: !failing.includes(key), reason: RECORDED, candidateEvidenceIds: [ids[0]] })),
      facts: Object.fromEntries(facts.map((id, at) => [id, {
        status: supported === 'first' && at === 0 ? 'supported' : 'unaddressed',
        reason: RECORDED,
        candidateEvidenceIds: [ids[0]],
      }])),
    });
  };
}

const adequateIntent = text(JSON.stringify({ adequate: true, feedback: 'The change and its constraint are clear.', questions: [] }));
const proposalTurn = text(JSON.stringify({ kind: 'proposal', reply: 'Understood: one bounded rewording. Review the proposed file when it is ready.', questions: [] }));
const PROPOSED_BYTES = 'Golden proposal: the first editable file, reworded without changing any requirement.\n';
/** A story phase's proposal is its whole record, so the golden proposes one that validates. */
const PROPOSED_STORY = JSON.stringify({
  id: 'US-4', title: 'Overdue report', persona: 'person who runs TaskTrackr every morning', capability: 'a report of the tasks that are overdue',
  benefit: 'I catch what I missed before the day starts',
  criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' }],
  scopeExclusions: [], notes: '',
}, null, 2) + '\n';
/**
 * A design proposal: the phase's starting record with one note added, so the
 * proposal keeps every id and status it was made against (a design phase
 * accepts only a valid record of its own).
 */
const proposedDesign = (starting: string): string => {
  const { design } = validateDesignRecord(starting);
  if (!design) throw new Error('the starting design record is not valid');
  return serialiseDesign({ ...design, notes: 'Overdue means due strictly before today.' });
};

/** The bytes the golden proposes for `target`, whichever contract the generation answers under. */
const proposedFor = (target: string, starting: string): string =>
  target === STORY_JSON ? PROPOSED_STORY : target === DESIGN_JSON ? proposedDesign(starting) : PROPOSED_BYTES;

const generated = (target: string, starting = ''): Reply =>
  text(JSON.stringify({ files: { [target]: proposedFor(target, starting) } }));

/** The summary a strict answer carries: its schema requires one, and the explanation's reference never reads it. */
const EDITED_SUMMARY = 'Golden proposal: the first editable file reworded; check it against the brief.';
/** A record as the edit-list contract asks for it: compact JSON on one line, laid out again by the server. */
const compact = (record: string): string => JSON.stringify(JSON.parse(record));
/** The record a Deployment or Maintenance proposal carries beside its code, if the phase has one. */
const recordOf = (phase: PhaseContent) => phase.files.find((file) => file.editable && (file.path === RUNBOOK_JSON || file.path === CHANGE_REQUEST_JSON));

/**
 * The same proposal as `generated`, in the edit-list shape the strict contract
 * asks for: Design's record whole in `files` as compact JSON; Deployment's and
 * Maintenance's record whole and compact (unchanged, so the server lays it out
 * and drops it as unchanged) beside one edit of the code or configuration
 * file; every other phase one edit. Each edit quotes its file whole, so it is
 * unique and the expanded file is exactly `generated`'s; a file that starts
 * empty is given whole in `files`, as the contract says. Every proposal then
 * expands and normalises to the bytes `generated` proposes, so every body after
 * the generation (the explanation's reference among them) is the default
 * fixture's: the end-to-end proof that a compact record stores the same bytes.
 */
function edited(phase: PhaseContent, target: string, starting: string): Reply {
  const proposed = proposedFor(target, starting);
  if (target === DESIGN_JSON) return text(JSON.stringify({ files: [{ path: target, contents: compact(proposed) }], edits: [], summary: EDITED_SUMMARY }));
  const record = recordOf(phase);
  if (record?.path === target) throw new Error(`${phase.key}'s first editable file is its record; the golden edits a code file beside it`);
  const files = [...(record ? [{ path: record.path, contents: compact(record.content) }] : []), ...(starting ? [] : [{ path: target, contents: proposed }])];
  const edits = starting ? [{ path: target, oldString: starting, newString: proposed }] : [];
  return text(JSON.stringify({ files, edits, summary: EDITED_SUMMARY }));
}

/** What the regeneration scenario's first answer edits field by field: text the starting runbook holds more than once. */
const REPEATED_RUNBOOK_TEXT = '"purpose": ""';

const AGENTIC_PROMPT = 'Make one small, bounded improvement to the first editable file: tighten its wording without changing any requirement or contract.';
const AGENTIC_CHAT = 'Please propose one bounded change: tighten the wording of the first editable file without changing any requirement or contract.';
const EXPLANATION = 'The proposal only rewords the first editable file and keeps every requirement and contract unchanged. I would verify it by rereading the brief against the file. Nothing here shows that a run happened or passed.';

const understanding: Reply = () => {
  const ids = explanationEvidence(EXPLANATION).map((unit) => unit.id);
  return JSON.stringify({ dimensions: UNDERSTANDING_DIMENSIONS.map((key) => ({ key, met: true, finding: 'supported', learnerEvidenceIds: ids })) });
};

/* ------------------------------- fixed inputs ------------------------------ */

const MENTOR_QUESTION = 'I have read the brief. Which part should I think about first, and why?';
const LESSON_QUESTION = 'Can you teach me the main idea of this phase with a small example?';
const INTERVIEW_QUESTION = 'Who will read this report, and what do they need to decide from it?';
const INTERVIEW_FOLLOW_UP = 'What should happen to a task that has no due date?';
const INSTRUCTOR_NOTE = 'Remind learners to reread the brief before they ask for help.';
const CLASS_ID = 'golden-class';

/**
 * What a finished earlier phase leaves behind, so the mentor's memory has something in it.
 * Requirements' is the older markdown a 2.x learner left: the later phases'
 * recorded bytes hold still across the 3.0.0 bump, and the memory still reads it
 * until the workspace migration converts such workspaces to the record.
 */
const PASSED_WORK: Record<string, { workspace: Record<string, string> | null; report: Record<string, unknown> }> = {
  // The story record the 3.0.0 room writes: the same story the 2.x markdown
  // here said, its "due today" boundary now a boundary-tagged criterion.
  requirements: {
    workspace: {
      'requirements/story.json': JSON.stringify({
        id: 'US-4',
        title: 'Overdue report for team leads',
        persona: 'team lead',
        capability: 'to see overdue tasks',
        benefit: 'I can follow them up',
        criteria: [{ id: 'AC-1', given: 'a task due today', when: 'I open the overdue report', then: 'it is not listed', tag: 'boundary' }],
        scopeExclusions: [],
        notes: '',
      }),
    },
    report: { checks: [] },
  },
  design: {
    workspace: { 'design/my-design.md': '# Design\n\n## listTasks\n\n## getOverdue\n\n## completeTask\n' },
    report: { checks: [] },
  },
  implementation: {
    workspace: null,
    report: { checks: [], tests: { total: 2, passed: 2, failed: 0, errored: 0, cases: [{ name: 'test_overdue_excludes_today', status: 'passed' }, { name: 'test_completed_not_overdue', status: 'passed' }] } },
  },
  testing: { workspace: null, report: { checks: [], mutation: { survivors: [] } } },
  deployment: { workspace: null, report: { checks: [], drill: { fault: 'wrong port', passedAfterFix: true } } },
  maintenance: { workspace: null, report: { checks: [], impact: { functions: [{ name: 'list_tasks' }] } } },
};

const LAST_FAILED_CHECKS: FeedbackCheck[] = [
  { id: 'golden-failed-one', label: 'The first golden check that failed', status: 'failed', detail: RECORDED },
  { id: 'golden-failed-two', label: 'The second golden check that failed', status: 'failed', detail: RECORDED },
  { id: 'golden-passed', label: 'A golden check that passed', status: 'passed', detail: RECORDED },
];

/** Every check id a reviewer maps: the phase's own rules, the structural ids and the execution ids. */
function fixedCheckList(phase: PhaseContent): FeedbackCheck[] {
  // a story phase's own checks are its record line and floor lines
  const rules = phase.checks.kind === 'story'
    ? ['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']
    : [];
  // the record-consistency and word-count ids belong to the retired markdown
  // kind, which no phase the harness replays holds; they stay in every phase
  // but a story's so the recorded request bodies keep their bytes
  const structural = phase.checks.kind === 'story' ? [] : ['requirements-record-consistency', 'min-words'];
  const ids = [...new Set([
    ...rules,
    ...structural,
    'visible-tests',
    'ran-before-submit',
    'tests-on-correct',
    'mutation',
    'build-smoke',
  ])];
  const statuses: FeedbackCheck['status'][] = ['passed', 'failed', 'warning'];
  return ids.map((id, at) => ({ id, label: `Golden check ${id}`, status: statuses[at % statuses.length], detail: `${RECORDED} (${id})` }));
}

const editableScaffold = (phase: PhaseContent): Record<string, string> =>
  Object.fromEntries(phase.files.filter((file) => file.editable).map((file) => [file.path, file.content]));

function reviewInput(phase: PhaseContent, variant: 'scaffold-no-checks' | 'fixed-checks'): ReviewInput {
  const fixed = variant === 'fixed-checks';
  return {
    workspace: editableScaffold(phase),
    criteria: phase.rubric.criteria.map((criterion) => ({
      key: criterion.key,
      title: criterion.title,
      weight: criterion.weight,
      score: fixed ? 50 : 0,
      evidence: fixed ? [`${RECORDED} (${criterion.key})`] : [],
    })),
    checks: fixed ? fixedCheckList(phase) : [],
    overall: fixed ? 40 : 0,
    hints: fixed ? 2 : 0,
    ranBeforeSubmit: fixed,
    task: soleTaskFor(phase),
  };
}

/** The file a failing test's deepest frame lands in: the phase's first learner-edited target. */
function explainTarget(phase: PhaseContent): string | null {
  if (phase.checks.kind === 'code') return phase.checks.editableTargets[0] ?? null;
  if (phase.checks.kind === 'tests') return phase.checks.learnerTestFiles[0] ?? null;
  return null;
}

/* --------------------------------- the world ------------------------------- */

interface World {
  db: DataSource;
  content: ContentService;
  assistant: AssistantService;
  interview: InterviewService;
  agentic: AgenticService;
  explain: ExplainService;
  learners: number;
}

async function openWorld(content: ContentService): Promise<World> {
  const db = await memoryDataSource();
  const provider = new OpenAiProvider();
  const feedback = { latestFor: async () => null } as unknown as FeedbackService;
  const workflow = new WorkflowService(
    db.getRepository(EnrollmentEntity),
    db.getRepository(PhaseStateEntity),
    db.getRepository(ReleaseRecordEntity),
    content,
    feedback,
    db,
  );
  const assistant = new AssistantService(
    db.getRepository(AssistantMessageEntity),
    db.getRepository(AiCacheEntity),
    db.getRepository(UserEntity),
    db.getRepository(PhaseStateEntity),
    db.getRepository(EnrollmentEntity),
    db.getRepository(SubmissionEntity),
    content,
    new LocalMentorProvider(),
    provider,
    new NotesService(db),
  );
  const interview = new InterviewService(
    db.getRepository(PhaseStateEntity),
    db.getRepository(AssistantMessageEntity),
    workflow,
    content,
    assistant,
    provider,
  );
  const agentic = new AgenticService(
    db.getRepository(AgentProposalEntity),
    workflow,
    assistant,
    provider,
    db,
    db.getRepository(ExecutionRunEntity),
    // The pinned-task reader, the constructor's last argument. It feeds the
    // harness only; the recorded bodies do not change.
    content,
  );
  const explain = new ExplainService(
    db.getRepository(SubmissionEntity),
    db.getRepository(ExecutionRunEntity),
    workflow,
    content,
    assistant,
  );
  return { db, content, assistant, interview, agentic, explain, learners: 0 };
}

interface Learner {
  userId: string;
  /** Phase state id by phase key. */
  states: Record<string, string>;
}

/**
 * A fresh learner on the pack's head, every phase open. `passedBefore` marks
 * every phase ordered before it passed, with the work in `PASSED_WORK`, so the
 * mentor has a memory to carry; `cohort` puts the learner in the class the
 * instructor notes are written for.
 */
async function enrol(world: World, options: { passedBefore?: number; cohort?: string } = {}): Promise<Learner> {
  const manager = world.db.manager;
  world.learners += 1;
  const user = await manager.save(manager.create(UserEntity, {
    email: `golden-${world.learners}@learnsdlc.test`,
    passwordHash: 'unused',
    displayName: `Golden learner ${world.learners}`,
    ...(options.cohort ? { cohort: options.cohort } : {}),
  }));
  const enrollment = await manager.save(manager.create(EnrollmentEntity, {
    userId: user.id,
    projectSlug: AI_GOLDEN_PACK,
    currentPhaseOrder: options.passedBefore ?? 1,
  }));
  const states: Record<string, string> = {};
  for (const phase of world.content.getProject(AI_GOLDEN_PACK).phases) {
    const passed = options.passedBefore !== undefined && phase.order < options.passedBefore;
    const row = await manager.save(manager.create(PhaseStateEntity, {
      enrollmentId: enrollment.id,
      userId: user.id,
      phaseKey: phase.key,
      phaseOrder: phase.order,
      status: passed ? 'passed' : 'in_progress',
      attempts: passed ? 1 : 0,
      bestScore: passed ? 80 : null,
      workspace: passed ? PASSED_WORK[phase.key]?.workspace ?? null : null,
    }));
    states[phase.key] = row.id;
    if (passed) {
      await submit(world, user.id, row.id, PASSED_WORK[phase.key]?.report ?? { checks: [] });
    }
  }
  return { userId: user.id, states };
}

/** A completed submission carrying `report`, for the reads that look for one. */
async function submit(world: World, userId: string, phaseStateId: string, report: Record<string, unknown>): Promise<void> {
  const manager = world.db.manager;
  await manager.save(manager.create(SubmissionEntity, {
    phaseStateId,
    userId,
    status: 'completed',
    score: 0,
    passed: false,
    report: { criteria: [], overall: 0, ...report } as unknown as FeedbackReport,
  }));
}

/** How many earlier messages the history scenario seeds: more than the twelve a prompt carries. */
export const HISTORY_SEEDED = 14;
/** One earlier reply longer than the 4,000 characters a history message is cut to. */
const LONG_REPLY = `${'Consider the brief one sentence at a time. '.repeat(100)}Which sentence would you check first?`;

/**
 * Earlier turns of this learner on this phase, oldest first, a minute apart so
 * the `createdAt DESC, id DESC` read never falls back to the random id.
 */
async function seedHistory(world: World, learner: Learner, phaseKey: string): Promise<void> {
  const manager = world.db.manager;
  const state = await manager.findOneByOrFail(PhaseStateEntity, { id: learner.states[phaseKey] });
  for (let at = 0; at < HISTORY_SEEDED; at += 1) {
    const role = at % 2 === 0 ? 'user' : 'assistant';
    await manager.save(manager.create(AssistantMessageEntity, {
      userId: learner.userId,
      enrollmentId: state.enrollmentId,
      phaseStateId: state.id,
      phaseKey: phaseKey as never,
      conversationScope: 'project',
      role,
      content: role === 'user' ? `Earlier question ${at / 2 + 1}: what should I read first?` : at === HISTORY_SEEDED - 1 ? LONG_REPLY : `Earlier reply ${(at + 1) / 2}: start from the brief.`,
      provider: 'openai',
      createdAt: new Date(Date.UTC(2026, 8, 1, 9, at)),
    }));
  }
}

/* ------------------------------ the recording ------------------------------ */

class Recorder {
  readonly entries: AiRequestEntry[] = [];
  constructor(private readonly transport: RecordingTransport) {}

  /**
   * One scenario: arm the transport with its script, drive the production
   * path, and keep one digest per body. The scenario must make **exactly**
   * the calls it declares and finish without an error: a recording of a
   * path production does not take would be a net over nothing.
   */
  async scenario(scenario: string, phase: string, calls: ScriptedCall[], drive: () => Promise<unknown>): Promise<void> {
    this.transport.script(calls.map(([, reply]) => reply));
    let failure: unknown = null;
    try {
      await drive();
    } catch (error) {
      failure = error;
    }
    const seen = this.transport.bodies.length;
    if (failure || seen !== calls.length || this.transport.unused) {
      const why = failure ? `; it threw: ${(failure as Error).message}` : '';
      throw new Error(`${scenario} ${phase}: declared ${calls.length} model call(s) [${calls.map(([surface]) => surface).join(', ')}] and saw ${seen}${why}`);
    }
    this.transport.bodies.forEach((body, at) => {
      this.entries.push({
        surface: calls[at][0],
        phase,
        scenario,
        call: at + 1,
        sha256: digestOfBody(body),
        length: Buffer.byteLength(body, 'utf8'),
      });
    });
  }
}

/** Run `work` with the transport, the placeholder key and the golden model settings, then put everything back. */
async function withRecordingTransport<T>(transport: RecordingTransport, work: () => Promise<T>): Promise<T> {
  const held = {
    fetch: globalThis.fetch,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    openaiReasoningEffort: config.openaiReasoningEffort,
  };
  globalThis.fetch = transport.fetch as unknown as typeof fetch;
  config.openaiApiKey = PLACEHOLDER_KEY;
  config.openaiBaseUrl = AI_GOLDEN_BASE_URL;
  // Pinned to the fixture's own settings before anything is composed:
  // the body carries both, so a machine whose environment named another model
  // would otherwise record (or compare) a different request.
  config.openaiModel = AI_GOLDEN_MODEL;
  config.openaiReasoningEffort = AI_GOLDEN_EFFORT;
  try {
    return await work();
  } finally {
    globalThis.fetch = held.fetch;
    config.openaiApiKey = held.openaiApiKey;
    config.openaiBaseUrl = held.openaiBaseUrl;
    config.openaiModel = held.openaiModel;
    config.openaiReasoningEffort = held.openaiReasoningEffort;
  }
}

const guidedTurn: ScriptedCall[] = [['guided.draft', text(GUIDED_DRAFT)], ['guided.review', guidedReview(GUIDED_DRAFT)]];

/**
 * Record every TaskTrackr model request body, in a fixed order: by surface
 * family, then by the pack's phase order, then by call.
 */
export async function recordAiRequests(content: ContentService): Promise<AiRequestManifest> {
  const project = content.getProject(AI_GOLDEN_PACK);
  const transport = new RecordingTransport();
  const recorder = new Recorder(transport);
  // Off records the whole-file generation; strict the edit list. `on` (with its
  // untuned fallback) is no shipped setting, so no fixture records it.
  if (config.agenticEditList === 'on') throw new Error('the request-bytes net records AI_AGENTIC_EDIT_LIST off or strict, never on');
  const strict = config.agenticEditList === 'strict';
  const generation: AiCallLabel = strict ? 'agentic.generate.edits' : 'agentic.generate';
  const answer = (phase: PhaseContent, target: string, starting: string): Reply => strict ? edited(phase, target, starting) : generated(target, starting);

  await withRecordingTransport(transport, async () => {
    const world = await openWorld(content);
    try {
      // --- grading.review, composed from fixed inputs straight into the provider.
      const direct = new OpenAiProvider();
      for (const variant of ['scaffold-no-checks', 'fixed-checks'] as const) {
        for (const phase of project.phases) {
          await recorder.scenario(`grading:${variant}`, phase.key, [['grading.review', rubricReview]], () =>
            direct.review(phase, reviewInput(phase, variant)));
        }
      }

      // --- grading.review through the grader, as production calls it.
      for (const phase of project.phases) {
        const { service } = graderFor(content);
        // The verdict net's stub reviewer, replaced by the real review path:
        // `AssistantService.reviewSubmission` → `OpenAiProvider.review`.
        (service as unknown as { assistant: AssistantService }).assistant = world.assistant;
        const tasks = [soleTaskFor(phase)];
        await recorder.scenario('grading:build-report', phase.key, [['grading.review', rubricReview]], () =>
          service.buildReport(phase, fixedState(phase, phase.order) as never, tasks, tasks[0]));
      }

      // --- Guided mentor turns through AssistantService.chat.
      for (const phase of project.phases) {
        const learner = await enrol(world);
        await recorder.scenario('guided:plain', phase.key, guidedTurn, () =>
          world.assistant.chat(learner.userId, learner.states[phase.key], MENTOR_QUESTION));
      }
      for (const phase of project.phases) {
        const learner = await enrol(world, { cohort: CLASS_ID });
        await world.db.manager.save(world.db.manager.create(InstructorNoteEntity, {
          kind: 'mentor',
          cohortId: CLASS_ID,
          projectSlug: AI_GOLDEN_PACK,
          phaseKey: phase.key,
          text: INSTRUCTOR_NOTE,
          authorUserId: 'golden-instructor',
          sourceId: null,
          doneAt: null,
        }));
        try {
          await recorder.scenario('guided:instructor-notes', phase.key, guidedTurn, () =>
            world.assistant.chat(learner.userId, learner.states[phase.key], MENTOR_QUESTION));
        } finally {
          await world.db.manager.delete(InstructorNoteEntity, { cohortId: CLASS_ID });
        }
      }
      for (const phase of project.phases) {
        const learner = await enrol(world, { passedBefore: phase.order });
        await recorder.scenario('guided:memory', phase.key, guidedTurn, () =>
          world.assistant.chat(learner.userId, learner.states[phase.key], MENTOR_QUESTION));
      }
      for (const phase of project.phases) {
        const learner = await enrol(world);
        await submit(world, learner.userId, learner.states[phase.key], { checks: LAST_FAILED_CHECKS });
        await recorder.scenario('guided:last-failed-checks', phase.key, guidedTurn, () =>
          world.assistant.chat(learner.userId, learner.states[phase.key], MENTOR_QUESTION));
      }
      for (const phase of project.phases) {
        const learner = await enrol(world);
        await recorder.scenario('guided:repair', phase.key, [
          ['guided.draft', text(GUIDED_DRAFT)],
          ['guided.review', guidedReview(GUIDED_DRAFT, ['limited_step'])],
          ['guided.draft', text(GUIDED_REPAIR_DRAFT)],
          ['guided.review', guidedReview(GUIDED_REPAIR_DRAFT)],
        ], () => world.assistant.chat(learner.userId, learner.states[phase.key], MENTOR_QUESTION));
      }

      // --- The lesson turn: the same chat path with the lesson wrap.
      for (const phase of project.phases) {
        const learner = await enrol(world);
        await recorder.scenario('lesson:plain', phase.key, guidedTurn, () =>
          world.assistant.chat(learner.userId, learner.states[phase.key], LESSON_QUESTION, { lesson: true }));
      }

      // --- Explain this failing test, through ExplainService.
      for (const phase of project.phases) {
        const target = explainTarget(phase);
        if (!target) continue;
        const learner = await enrol(world);
        await submit(world, learner.userId, learner.states[phase.key], {
          checks: [],
          tests: {
            total: 1, passed: 0, failed: 1, errored: 0,
            cases: [{ name: 'test_golden_failure', status: 'failed', hidden: false, message: 'AssertionError: expected 2 but got 3\nsecond line is not sent', frames: [{ path: target, line: 3 }] }],
          },
        });
        const dto = { source: 'submission', testName: 'test_golden_failure' } as ExplainTestDto;
        await recorder.scenario('explain:failing-test', phase.key, guidedTurn, () =>
          world.explain.explainFailingTest(learner.userId, learner.states[phase.key], dto));
      }

      // --- The stakeholder interview, through InterviewService.ask.
      for (const phase of project.phases) {
        if (!content.interviewBrief(phase)) continue;
        let learner = await enrol(world);
        await recorder.scenario('interview:plain', phase.key, [
          ['interview.answer', text(INTERVIEW_ANSWER)],
          ['interview.review', interviewReview(INTERVIEW_ANSWER)],
        ], () => world.interview.ask(learner.userId, learner.states[phase.key], INTERVIEW_QUESTION));

        learner = await enrol(world);
        await recorder.scenario('interview:repair', phase.key, [
          ['interview.answer', text(INTERVIEW_ANSWER)],
          ['interview.review', interviewReview(INTERVIEW_ANSWER, ['grounded'])],
          ['interview.answer', text(INTERVIEW_REPAIR_ANSWER)],
          ['interview.review', interviewReview(INTERVIEW_REPAIR_ANSWER)],
        ], () => world.interview.ask(learner.userId, learner.states[phase.key], INTERVIEW_QUESTION));

        // A second question after the first settled a fact: `settled` reaches the prompt.
        learner = await enrol(world);
        const asker = learner;
        await recorder.scenario('interview:settled', phase.key, [
          ['interview.answer', text(INTERVIEW_ANSWER)],
          ['interview.review', interviewReview(INTERVIEW_ANSWER, [], 'first')],
          ['interview.answer', text(INTERVIEW_SECOND_ANSWER)],
          ['interview.review', interviewReview(INTERVIEW_SECOND_ANSWER)],
        ], async () => {
          await world.interview.ask(asker.userId, asker.states[phase.key], INTERVIEW_QUESTION);
          await world.interview.ask(asker.userId, asker.states[phase.key], INTERVIEW_FOLLOW_UP);
        });
      }

      // --- Agentic: propose then explain (classify, generate, explanation), and chat.
      for (const phase of project.phases) {
        const editable = phase.files.find((file) => file.editable);
        const target = editable?.path;
        if (!target) throw new Error(`${phase.key} has no editable file for an Agentic proposal`);
        const learner = await enrol(world);
        const id = learner.states[phase.key];
        await recorder.scenario('agentic:propose-explain', phase.key, [
          ['agentic.classify', adequateIntent],
          [generation, answer(phase, target, editable.content)],
          ['agentic.explanation', understanding],
        ], async () => {
          const proposal = await world.agentic.propose(learner.userId, id, AGENTIC_PROMPT);
          await world.agentic.explain(learner.userId, id, proposal.id, proposal.proposalHash, EXPLANATION);
        });
      }
      for (const phase of project.phases) {
        const editable = phase.files.find((file) => file.editable)!;
        const target = editable.path;
        const learner = await enrol(world);
        const id = learner.states[phase.key];
        await recorder.scenario('agentic:chat', phase.key, [
          ['agentic.classify', proposalTurn],
          [generation, answer(phase, target, editable.content)],
        ], async () => {
          const turn = await world.agentic.chat(learner.userId, id, { requestId: `golden-chat-${phase.key}`, message: AGENTIC_CHAT });
          // A failed turn is returned, not thrown: it must be completed here.
          if ((turn as { status?: string }).status !== 'completed') {
            throw new Error(`the Agentic chat turn ended ${(turn as { status?: string }).status} (${(turn as { errorCode?: string }).errorCode ?? 'no code'})`);
          }
        });
      }

      // --- A Guided turn with a conversation behind it.
      // Every scenario above is a first turn, so none of them holds the
      // history bytes. The learner here has more earlier turns than the
      // twelve a prompt carries, and one earlier reply longer than the 4,000
      // characters a history message is cut to, so the window and the cut are
      // both in the digest. Appended last: no entry above moves.
      for (const phase of project.phases) {
        const learner = await enrol(world);
        await seedHistory(world, learner, phase.key);
        await recorder.scenario('guided:history', phase.key, guidedTurn, () =>
          world.assistant.chat(learner.userId, learner.states[phase.key], MENTOR_QUESTION));
      }

      // --- The one regeneration, strict only, appended last.
      // A Deployment proposal whose first answer edits the runbook field by
      // field, quoting text the record holds more than once: the expander
      // refuses it and, with the budget's room, the same call is made once more
      // with the refusal's sentence at the end of its briefing. The scenario
      // proves the second body is the first plus `regenerationSentence(…,
      // 'edits')`, three usage rows and one `agentic_regeneration` line.
      if (strict) {
        const phase = project.phases.find((one) => recordOf(one)?.path === RUNBOOK_JSON);
        if (!phase) throw new Error('the pack has no runbook phase for the regeneration scenario');
        const editable = phase.files.find((file) => file.editable)!;
        const runbook = recordOf(phase)!;
        if (runbook.content.split(REPEATED_RUNBOOK_TEXT).length < 3) throw new Error(`the starting runbook no longer holds ${REPEATED_RUNBOOK_TEXT} more than once`);
        const learner = await enrol(world);
        const id = learner.states[phase.key];
        const fieldByField = text(JSON.stringify({ files: [], edits: [{ path: RUNBOOK_JSON, oldString: REPEATED_RUNBOOK_TEXT, newString: '"purpose": "Restart the API."' }], summary: EDITED_SUMMARY }));
        await recorder.scenario('agentic:regenerate', phase.key, [
          ['agentic.classify', adequateIntent],
          ['agentic.generate.edits', fieldByField],
          ['agentic.generate.edits', edited(phase, editable.path, editable.content)],
        ], async () => {
          const lines: string[] = [];
          const log = Logger.prototype.log;
          Logger.prototype.log = function (message: unknown) { lines.push(String(message)); };
          try {
            await world.agentic.propose(learner.userId, id, AGENTIC_PROMPT);
          } finally {
            Logger.prototype.log = log;
          }
          const regenerated = lines.filter((line) => line.startsWith('agentic_regeneration '));
          if (JSON.stringify(regenerated) !== JSON.stringify(['agentic_regeneration site=propose code=files_proposal_refused clause=edit_list outcome=started'])) {
            throw new Error(`the regeneration logged ${JSON.stringify(regenerated)}`);
          }
          const usage = await world.db.manager.count(AssistantMessageEntity, { where: { phaseStateId: id, provider: REVIEW_USAGE_PROVIDER } });
          if (usage !== 3) throw new Error(`the regeneration recorded ${usage} usage rows, not 3`);
          const refused = new RefusedProposalException('files_proposal_refused', 'edit_list', editListRefusalReason(new EditExpansionError('multiple_matches', RUNBOOK_JSON)));
          const [first, second] = transport.bodies.slice(1).map((body) => JSON.parse(body) as ModelRequest);
          // The sentence ends the generation briefing, which the system message carries before the provider's own
          // closing lines: the second system message is the first with the sentence inserted there, once.
          const tail = regenerationSentence(refused, 'edits');
          const at = second.messages[0].content.indexOf(tail);
          const rebuilt = at < 0 ? '' : `${first.messages[0].content.slice(0, at)}${tail}${first.messages[0].content.slice(at)}`;
          if (rebuilt !== second.messages[0].content || JSON.stringify(second.messages.slice(1)) !== JSON.stringify(first.messages.slice(1))) {
            throw new Error('the regeneration\'s body is not the first body with the refusal\'s sentence at the end of its briefing');
          }
        });

        // --- The one prompt assessment re-ask, strict only, appended after it.
        // A Design proposal whose first classify answer breaks the one-question rule
        // (two questions where an inadequate request takes one): the same classify request
        // is sent once more with one trailing system note, and the usable second answer
        // leads to the propose scenario's own generation. The scenario proves the second
        // body is the first with that one message inserted once, three usage rows and one
        // `agentic_regeneration site=classify` line.
        const design = project.phases.find((one) => one.key === 'design');
        if (!design) throw new Error('the pack has no design phase for the prompt assessment re-ask scenario');
        const designFile = design.files.find((file) => file.editable)!;
        const asker = await enrol(world);
        const designId = asker.states[design.key];
        const questionnaire = text(JSON.stringify({ adequate: false, feedback: 'Two things are unclear.', questions: ['Which story does this serve?', 'Which component should change?'] }));
        await recorder.scenario('agentic:classify-reask', design.key, [
          ['agentic.classify', questionnaire],
          ['agentic.classify', adequateIntent],
          [generation, answer(design, designFile.path, designFile.content)],
        ], async () => {
          const lines: string[] = [];
          const log = Logger.prototype.log;
          Logger.prototype.log = function (message: unknown) { lines.push(String(message)); };
          try {
            await world.agentic.propose(asker.userId, designId, AGENTIC_PROMPT);
          } finally {
            Logger.prototype.log = log;
          }
          const reasked = lines.filter((line) => line.startsWith('agentic_regeneration '));
          if (JSON.stringify(reasked) !== JSON.stringify(['agentic_regeneration site=classify code=intent_assessment clause=one_question outcome=ok'])) {
            throw new Error(`the prompt assessment re-ask logged ${JSON.stringify(reasked)}`);
          }
          const usage = await world.db.manager.count(AssistantMessageEntity, { where: { phaseStateId: designId, provider: REVIEW_USAGE_PROVIDER } });
          if (usage !== 3) throw new Error(`the prompt assessment re-ask recorded ${usage} usage rows, not 3`);
          // The second body is the first, byte for byte, with one system message holding the note
          // inserted once after the first request's messages; every other field and byte is the same.
          const [first, second] = transport.bodies.slice(0, 2);
          const parsed = JSON.parse(first) as ModelRequest;
          const rebuilt = JSON.stringify({ ...parsed, messages: [...parsed.messages, { role: 'system', content: classifyReaskNote('one_question') }] });
          const inserted = JSON.stringify({ role: 'system', content: classifyReaskNote('one_question') });
          if (JSON.stringify(parsed) !== first || rebuilt !== second || second.split(inserted).length !== 2) {
            throw new Error('the prompt assessment re-ask\'s body is not the first body with the note inserted once');
          }
        });
      }
    } finally {
      await world.db.destroy();
    }
  });

  return {
    pack: AI_GOLDEN_PACK,
    version: project.version,
    model: AI_GOLDEN_MODEL,
    effort: AI_GOLDEN_EFFORT,
    entries: recorder.entries,
  };
}

/* ------------------------------- the fixture ------------------------------- */

/** The one identity of an entry: which scenario, phase and call it is. */
export const entryKey = (entry: AiRequestEntry): string => `${entry.scenario} ${entry.phase} #${entry.call} (${entry.surface})`;

/** The first entry that is not where it was, as a sentence, or null when none moved. */
export function firstDifferingEntry(recorded: AiRequestEntry[], fresh: AiRequestEntry[]): string | null {
  const most = Math.max(recorded.length, fresh.length);
  for (let at = 0; at < most; at += 1) {
    const was = recorded[at];
    const now = fresh[at];
    if (!was) return `${entryKey(now)} is new`;
    if (!now) return `${entryKey(was)} is gone`;
    if (entryKey(was) !== entryKey(now)) return `${entryKey(was)} -> ${entryKey(now)}`;
    if (was.sha256 !== now.sha256 || was.length !== now.length) {
      return `${entryKey(now)}: sha256 ${was.sha256.slice(0, 12)}… (${was.length} bytes) -> ${now.sha256.slice(0, 12)}… (${now.length} bytes)`;
    }
  }
  return null;
}

/** The labels a TaskTrackr learner can cause; the catch-all is for unnamed callers only. */
export const RECORDED_SURFACES: readonly AiCallLabel[] = AI_CALL_LABELS.filter((label) => label !== 'structured.other');

export function readAiRequestFixture(dir: string = FIXTURES_DIR, variant?: AiRequestFixtureVariant): AiRequestManifest | null {
  const at = aiRequestFixturePath(dir, variant);
  if (!fs.existsSync(at)) return null;
  return JSON.parse(fs.readFileSync(at, 'utf-8')) as AiRequestManifest;
}

/** What the fixture file holds, byte for byte, so the CLI and the spec agree. */
export function serialiseAiRequestFixture(manifest: AiRequestManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
