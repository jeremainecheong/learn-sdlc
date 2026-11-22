import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { FeedbackReport, PhaseKey } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import { DirectoryPackSource } from '../content/pack-source';
import { soleTaskFor } from '../content/pack-compiler';
import {
  AiCacheEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { ExecutionService } from '../execution/execution.service';
import { FeedbackService } from '../feedback/feedback.service';
import { NotesService } from '../instructor/notes.service';
import { WorkflowService } from '../workflow/workflow.service';
import { AgentProposalEntity } from './agent-proposal.entity';
import { AgenticService } from './agentic.service';
import { AssistantService } from './assistant.service';
import { ExplainService } from './explain.service';
import { UNDERSTANDING_DIMENSIONS, explanationEvidence } from './explanation-assessment';
import { GUIDED_REVIEW_KEYS, guidedEvidence } from './guided-review';
import { WITHHELD_REPLY_NOTICE } from './guardrails';
import { sealedRedactionSources } from './project-scope';
import { SEALED_MAP_KEYS, SEALED_SNIPPET_KEYS } from '../authoring/sealed-roles';
import type { PhaseChecks } from '../content/content.types';
import { LocalMentorProvider } from './local.provider';
import type { ExplainTestDto } from './mentor.dto';
import type { AiCallLabel } from './model-call-timing';
import { OpenAiProvider } from './openai.provider';
import { RecordingTransport, type ModelRequest } from '../../test/ai-request-golden';
import { ALL_SHELF_MARKERS, SHELF_DIR, SHELF_MARKERS, SHELF_SLUG, TASKTRACKR_SENTINELS } from '../../test/fixtures/upload-packs/markers';

/**
 * No sealed byte of an uploaded application reaches a model request, and a
 * reply that echoes one is redacted.
 *
 * The `shelf` fixture plants one marker per sealed role, the hidden suites, the
 * reference answers, the testing phase's own suites, the implementation it is
 * graded against, the mutants and the drill's faulted copy, and no file a
 * learner is served carries any of them. Every model call below goes through
 * the production services (the request-bytes golden's harness, over `shelf`
 * instead of TaskTrackr) to a recording `fetch` that starts nothing, so a
 * marker in a recorded body is a sealed byte the composers let out: by the
 * reviewer's evidence or its check details, the mentor's workspace or its
 * failing test, the Guided reviewer's files, or the Agentic payload.
 *
 * The replies are canned; the stub transport is the only provider. No real AI
 * call is made, and no body is written anywhere.
 */

const EXECUTABLE: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];
const PLACEHOLDER_KEY = 'n5-sealing-placeholder-not-a-key';
const BASE_URL = 'https://api.openai.com/v1';
const RECORDED = 'Recorded for the sealing net.';
const HIDDEN_FAILURE = 'AssertionError: expected 409 but got 200';

type Reply = (request: ModelRequest) => string;
type Scripted = [AiCallLabel, Reply];

const text = (value: string): Reply => () => value;
function guidedReview(candidate: string): Reply {
  return () => {
    const ids = guidedEvidence(candidate).map((unit) => unit.id);
    return JSON.stringify({
      revealedDecisions: [],
      remainingReasoning: { description: 'The learner still chooses what to check.', substantive: true, candidateEvidenceIds: [ids[ids.length - 1]] },
      checks: GUIDED_REVIEW_KEYS.map((key) => ({ key, met: true, candidateEvidenceIds: [ids[0]], reason: RECORDED })),
    });
  };
}
const rubricReview: Reply = (request) => {
  const variants = (request.response_format?.json_schema?.schema?.properties?.criteriaEvidence?.items?.anyOf ?? []) as Array<{ properties: { key: { enum: string[] } } }>;
  const keys = [...new Set(variants.map((variant) => variant.properties.key.enum[0]))];
  return JSON.stringify({ verdict: 'needs_revision', summary: RECORDED, strengths: [], improvements: [RECORDED], processNote: RECORDED,
    criteriaEvidence: keys.map((key) => ({ key, met: false, evidence: RECORDED, issue: RECORDED, nextStep: RECORDED })) });
};
const DRAFT = 'Start from the brief. Which single rule in it are you least sure about, and what would you check first to confirm it?';
const guidedTurn: Scripted[] = [['guided.draft', text(DRAFT)], ['guided.review', guidedReview(DRAFT)]];
const EXPLANATION = 'The proposal only rewords the first editable file and keeps every rule unchanged. I would verify it by rereading the brief against the file. Nothing here shows that a run happened or passed.';
const understanding: Reply = () => {
  const ids = explanationEvidence(EXPLANATION).map((unit) => unit.id);
  return JSON.stringify({ dimensions: UNDERSTANDING_DIMENSIONS.map((key) => ({ key, met: true, finding: 'supported', learnerEvidenceIds: ids })) });
};
const PROPOSED = 'A bounded rewording of the first editable file.\n';
const generated = (target: string): Reply => text(JSON.stringify({ files: { [target]: PROPOSED } }));

/* --------------------------------- the world ------------------------------- */

interface World {
  db: DataSource;
  content: ContentService;
  shelf: ProjectContent;
  provider: OpenAiProvider;
  assistant: AssistantService;
  agentic: AgenticService;
  explain: ExplainService;
  learners: number;
}

/** The shipped catalogue with `shelf` beside it, the way `second-pack.ts` adds a project. */
function contentWithShelf(): { content: ContentService; shelf: ProjectContent } {
  const content = new ContentService();
  content.loadAll();
  const shelf = new ContentService().loadProject(new DirectoryPackSource(SHELF_DIR));
  const projects = [...content.listProjects(), shelf];
  const getProject = content.getProject.bind(content);
  content.listProjects = () => projects;
  content.getProject = (asked: string) => (asked === SHELF_SLUG ? shelf : getProject(asked));
  return { content, shelf };
}

async function openWorld(): Promise<World> {
  const db = await memoryDataSource();
  const { content, shelf } = contentWithShelf();
  const provider = new OpenAiProvider();
  const feedback = { latestFor: async () => null } as unknown as FeedbackService;
  const workflow = new WorkflowService(db.getRepository(EnrollmentEntity), db.getRepository(PhaseStateEntity), db.getRepository(ReleaseRecordEntity), content, feedback, db);
  const assistant = new AssistantService(
    db.getRepository(AssistantMessageEntity), db.getRepository(AiCacheEntity), db.getRepository(UserEntity), db.getRepository(PhaseStateEntity),
    db.getRepository(EnrollmentEntity), db.getRepository(SubmissionEntity), content, new LocalMentorProvider(), provider, new NotesService(db),
  );
  const agentic = new AgenticService(db.getRepository(AgentProposalEntity), workflow, assistant, provider, db, db.getRepository(ExecutionRunEntity), content);
  const explain = new ExplainService(db.getRepository(SubmissionEntity), db.getRepository(ExecutionRunEntity), workflow, content, assistant);
  return { db, content, shelf, provider, assistant, agentic, explain, learners: 0 };
}

interface Learner { userId: string; states: Record<string, string> }

async function enrol(world: World, slug: string = SHELF_SLUG): Promise<Learner> {
  const manager = world.db.manager;
  world.learners += 1;
  const user = await manager.save(manager.create(UserEntity, { email: `n5-${world.learners}@learnsdlc.test`, passwordHash: 'unused', displayName: `N5 learner ${world.learners}` }));
  const enrollment = await manager.save(manager.create(EnrollmentEntity, { userId: user.id, projectSlug: slug, currentPhaseOrder: 1 }));
  const states: Record<string, string> = {};
  for (const phase of world.content.getProject(slug).phases) {
    const row = await manager.save(manager.create(PhaseStateEntity, {
      enrollmentId: enrollment.id, userId: user.id, phaseKey: phase.key, phaseOrder: phase.order, status: 'in_progress', attempts: 0, bestScore: null, workspace: null,
    }));
    states[phase.key] = row.id;
  }
  return { userId: user.id, states };
}

async function submit(world: World, learner: Learner, key: string, report: Record<string, unknown>): Promise<void> {
  const manager = world.db.manager;
  await manager.save(manager.create(SubmissionEntity, {
    phaseStateId: learner.states[key], userId: learner.userId, status: 'completed', score: 0, passed: false,
    report: { criteria: [], overall: 0, ...report } as unknown as FeedbackReport,
  }));
}

/** A grader on `shelf` whose sandbox starts nothing and whose reviewer is the real provider (the golden's `graderFor`, over `shelf`). */
function graderFor(world: World): FeedbackService {
  const empty = () => ({
    find: async () => [], findOne: async () => null, findOneBy: async () => null,
    findOneByOrFail: async (where: { id?: string }) => ({ id: where?.id ?? 'ps-1' }),
    count: async () => 0, save: async (row: unknown) => row, update: async () => ({ affected: 0 }), create: (fields: unknown) => fields,
  });
  const sandbox = {
    async execute() {
      return {
        ok: true, exitKind: 'ok', stdout: '', stderr: '', durationMs: 0,
        tests: { total: 2, passed: 1, failed: 1, errored: 0, cases: [
          { name: 'test_lend_refuses_a_lent_book', status: 'failed', hidden: true, message: HIDDEN_FAILURE },
          { name: 'test_lists_books', status: 'passed' },
        ] },
      };
    },
    async analyze() {
      return { issues: [], metrics: { files: 1, functions: 1, todosRemaining: 0, maxComplexity: 1, docstringCoverage: 1 } };
    },
  };
  const enrollments = { ...empty(), findOneByOrFail: async () => ({ id: 'e-1', userId: 'u-1', projectSlug: SHELF_SLUG }) };
  const learnerTestFiles = ExecutionService.prototype.learnerTestFiles as unknown as (this: { content: ContentService }, phase: PhaseContent, workspace: Record<string, string> | null, paths: string[]) => Record<string, string>;
  const assistant = { reviewSubmission: async (phase: PhaseContent, _state: unknown, input: Parameters<OpenAiProvider['review']>[1]) => world.provider.review(phase, input) };
  return new FeedbackService(
    empty() as never, empty() as never, enrollments as never, empty() as never, world.content, sandbox as never,
    { learnerTestFiles: learnerTestFiles.bind({ content: world.content }) } as never, assistant as never,
    { register: () => undefined, enqueue: async () => undefined, durable: false } as never,
    { emitJob: () => undefined } as never, { onVerdict: async () => undefined } as never,
  );
}

const gradedState = (phase: PhaseContent) => ({
  id: `ps-${phase.key}`, enrollmentId: 'e-1', userId: 'u-1', phaseKey: phase.key, phaseOrder: phase.order, status: 'in_progress', bestScore: null, attempts: 1,
  reflection: null, workspace: null, acceptedScreenCopy: null, links: null, drill: null, ranBeforeSubmit: true, unlockedAt: null, passedAt: null,
  interview: null, solutionReadAt: null, runClock: null,
});

/* ------------------------------ the recording ------------------------------ */

interface Recorded { scenario: string; phase: string; surface: AiCallLabel; body: string }

async function withTransport<T>(transport: RecordingTransport, work: () => Promise<T>): Promise<T> {
  const held = { fetch: globalThis.fetch, key: config.openaiApiKey, base: config.openaiBaseUrl, model: config.openaiModel, effort: config.openaiReasoningEffort };
  globalThis.fetch = transport.fetch as unknown as typeof fetch;
  config.openaiApiKey = PLACEHOLDER_KEY;
  config.openaiBaseUrl = BASE_URL;
  config.openaiModel = 'gpt-5.6-luna';
  config.openaiReasoningEffort = 'none';
  try {
    return await work();
  } finally {
    globalThis.fetch = held.fetch;
    config.openaiApiKey = held.key;
    config.openaiBaseUrl = held.base;
    config.openaiModel = held.model;
    config.openaiReasoningEffort = held.effort;
  }
}

describe('no sealed byte of an uploaded application reaches a model request', () => {
  let world: World;
  const transport = new RecordingTransport();
  const recorded: Recorded[] = [];

  const scenario = async (name: string, phase: string, calls: Scripted[], drive: () => Promise<unknown>) => {
    transport.script(calls.map(([, reply]) => reply));
    let failure: unknown = null;
    try {
      await drive();
    } catch (error) {
      failure = error;
    }
    expect([name, phase, failure ? String((failure as Error).message) : null, transport.bodies.length, transport.unused]).toEqual([name, phase, null, calls.length, 0]);
    transport.bodies.forEach((body, at) => recorded.push({ scenario: name, phase, surface: calls[at][0], body }));
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openWorld();
    await withTransport(transport, async () => {
      for (const key of EXECUTABLE) {
        const phase = world.content.getPhase(SHELF_SLUG, key);
        const tasks = [soleTaskFor(phase)];
        const grader = graderFor(world);
        await scenario('grading:build-report', key, [['grading.review', rubricReview]], () => grader.buildReport(phase, gradedState(phase) as never, tasks, tasks[0]));

        let learner = await enrol(world);
        await scenario('guided:plain', key, guidedTurn, () => world.assistant.chat(learner.userId, learner.states[key], 'Which rule in the brief should I check first?'));

        learner = await enrol(world);
        await submit(world, learner, key, { checks: [
          { id: 'hidden-tests', label: 'Hidden tests', status: 'failed', detail: HIDDEN_FAILURE },
          { id: 'visible-tests', label: 'Visible tests', status: 'passed', detail: RECORDED },
        ] });
        await scenario('guided:last-failed-checks', key, guidedTurn, () => world.assistant.chat(learner.userId, learner.states[key], 'Why did my submission fail?'));

        learner = await enrol(world);
        await scenario('lesson:plain', key, guidedTurn, () => world.assistant.chat(learner.userId, learner.states[key], 'Can you teach me the idea of this phase?', { lesson: true }));

        const target = phase.checks.kind === 'code' ? phase.checks.editableTargets[0] : phase.checks.kind === 'tests' ? phase.checks.learnerTestFiles[0] : null;
        if (target) {
          learner = await enrol(world);
          await submit(world, learner, key, { checks: [], tests: { total: 1, passed: 0, failed: 1, errored: 0, cases: [
            { name: 'test_lend_refuses_a_lent_book', status: 'failed', hidden: true, message: `${HIDDEN_FAILURE}\nsecond line is not sent`, frames: [{ path: target, line: 3 }] },
          ] } });
          const dto = { source: 'submission', testName: 'test_lend_refuses_a_lent_book' } as ExplainTestDto;
          await scenario('explain:failing-test', key, guidedTurn, () => world.explain.explainFailingTest(learner.userId, learner.states[key], dto));
        }

        const editable = phase.files.find((file) => file.editable)!.path;
        learner = await enrol(world);
        const proposer = learner;
        await scenario('agentic:propose-explain', key, [
          ['agentic.classify', text(JSON.stringify({ adequate: true, feedback: 'The change and its constraint are clear.', questions: [] }))],
          ['agentic.generate', generated(editable)],
          ['agentic.explanation', understanding],
        ], async () => {
          const proposal = await world.agentic.propose(proposer.userId, proposer.states[key], 'Make one small, bounded improvement to the first editable file without changing any rule.');
          await world.agentic.explain(proposer.userId, proposer.states[key], proposal.id, proposal.proposalHash, EXPLANATION);
        });

        learner = await enrol(world);
        const chatter = learner;
        await scenario('agentic:chat', key, [
          ['agentic.classify', text(JSON.stringify({ kind: 'proposal', reply: 'Understood: one bounded rewording. Review the proposed file when it is ready.', questions: [] }))],
          ['agentic.generate', generated(editable)],
        ], async () => {
          const turn = await world.agentic.chat(chatter.userId, chatter.states[key], { requestId: `n5-chat-${key}`, message: 'Please propose one bounded rewording of the first editable file.' });
          if ((turn as { status?: string }).status !== 'completed') throw new Error(`agentic chat ended ${(turn as { status?: string }).status}`);
        });
      }
    });
  }, 120_000);

  afterAll(async () => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
    await world?.db.destroy();
  });

  it('recorded every surface on every executable phase through the production services', () => {
    const surfaces = new Set(recorded.map((one) => one.surface));
    expect([...surfaces].sort()).toEqual(['agentic.classify', 'agentic.explanation', 'agentic.generate', 'grading.review', 'guided.draft', 'guided.review'].sort());
    for (const key of EXECUTABLE) expect([key, recorded.filter((one) => one.phase === key).length > 0]).toEqual([key, true]);
    expect(recorded.filter((one) => one.scenario === 'explain:failing-test').map((one) => one.phase).filter((v, i, all) => all.indexOf(v) === i)).toEqual(['implementation', 'testing', 'maintenance']);
  });

  it('every sealed role of the Shelf pack really carries its marker, so the grep below can see a leak', () => {
    const phases = world.shelf.phases;
    const sealedText = JSON.stringify(phases.map((phase) => phase.checks));
    for (const [role, marker] of Object.entries(SHELF_MARKERS)) expect([role, sealedText.includes(marker)]).toEqual([role, true]);
    const served = JSON.stringify(phases.map((phase) => phase.files));
    expect(ALL_SHELF_MARKERS.filter((marker) => served.includes(marker))).toEqual([]);
  });

  it('no request body carries a sealed marker, including check details and the failing test', () => {
    const leaks = recorded.flatMap((one) => ALL_SHELF_MARKERS.filter((marker) => one.body.includes(marker)).map((marker) => `${one.scenario} ${one.phase} ${one.surface}: ${marker}`));
    expect(leaks).toEqual([]);
    // the channels the plan names did carry their server data, so the grep looked where a leak would ride
    const grading = recorded.filter((one) => one.scenario === 'grading:build-report');
    expect(grading.every((one) => one.body.includes('allowedSourcePaths'))).toBe(true);
    const explained = recorded.filter((one) => one.scenario === 'explain:failing-test' && one.surface === 'guided.draft');
    expect(explained.length).toBe(3);
    for (const one of explained) {
      expect(one.body).toContain('test that failed: test_lend_refuses_a_lent_book');
      expect(one.body).toContain(`assertion: ${HIDDEN_FAILURE}`);
      expect(one.body).toContain('suite: hidden (the learner cannot read it)');
      expect(one.body).not.toContain('second line is not sent');
    }
    const failedChecks = recorded.filter((one) => one.scenario === 'guided:last-failed-checks' && one.surface === 'guided.draft');
    expect(failedChecks.every((one) => one.body.includes('check that failed on the last submission: Hidden tests'))).toBe(true);
  });

  it('no request body carries a TaskTrackr sentinel on any surface, through the services', () => {
    const hits = recorded.flatMap((one) => TASKTRACKR_SENTINELS.filter((term) => one.body.toLowerCase().includes(term.toLowerCase())).map((term) => `${one.scenario} ${one.phase} ${one.surface}: ${term}`));
    expect(hits).toEqual([]);
  });
});

/* ---------------------- the output redaction union ---------------------- */

/**
 * Two lines of `files` a reply can carry whole: code-shaped (the guardrail's
 * own `carriable` rule, 16+ characters with code punctuation), not an import
 * and not a comment, and not in any file the phase serves the learner. (The
 * implementation a tests phase grades against and a config phase's smoke
 * files are the application the learner also sees locked: an echo of their
 * served lines is the learner's own screen and is kept, see the
 * "served or owns" table below.)
 */
function sealedLines(phase: PhaseContent, files: Record<string, string>): string[] {
  const served = new Set(phase.files.flatMap((file) => file.content.split('\n').map((line) => line.trim())));
  const picked: string[] = [];
  for (const content of Object.values(files)) {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      // a backtick is markdown dress in a reply, so a line holding one is not echoed byte for byte
      if (line.length < 16 || !/[()[\]{}=:]/.test(line) || /^(#|\/\/|import |from |"""|\*)/.test(line) || line.includes('`') || served.has(line) || picked.includes(line)) continue;
      picked.push(line);
      if (picked.length === 2) return picked;
    }
  }
  throw new Error(`${phase.key}: fewer than two sealed lines a reply could carry`);
}

const echoOf = (lines: string[]) => `Here is one way to look at it:\nFirst, notice this: ${lines[0]}\nThen compare it with this: ${lines[1]}\nWhich of the two would you check first?`;

describe('a reply that echoes a sealed file is redacted on every executable kind', () => {
  let world: World;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openWorld();
  });
  afterAll(async () => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
    await world?.db.destroy();
  });

  // Every row has all four members: jest-each reads a short row's missing member as a `done` callback.
  // The implementation and smoke rows (served locked on `shelf`, every line) are in the "served or owns" table below.
  const cases: Array<[string, PhaseKey, (phase: PhaseContent) => Record<string, string>, string]> = [
    ['a hidden test (code)', 'implementation', (p) => (p.checks.kind === 'code' ? p.checks.hiddenTestFiles : {}), 'sealed'],
    ['a reference answer (code)', 'maintenance', (p) => (p.checks.kind === 'code' ? p.checks.solutionFiles : {}), 'sealed'],
    ['a reference test (tests)', 'testing', (p) => (p.checks.kind === 'tests' ? p.checks.referenceTestFiles : {}), 'sealed'],
    ['a mutant (tests)', 'testing', (p) => (p.checks.kind === 'tests' ? Object.assign({}, ...p.checks.mutants.map((m) => m.files)) : {}), 'sealed'],
    ["the drill's faulted file (config)", 'deployment', (p) => (p.checks.kind === 'config' && p.checks.drill ? p.checks.drill.faultedFiles : {}), 'sealed'],
  ];

  it.each(cases)('withholds a mentor reply that carries %s', async (_what, key, sealed) => {
    const phase = world.content.getPhase(SHELF_SLUG, key);
    const lines = sealedLines(phase, sealed(phase));
    const echo = echoOf(lines);
    const transport = new RecordingTransport();
    transport.script([text(echo), guidedReview(echo)]);
    const learner = await enrol(world);
    const response = await withTransport(transport, () => world.assistant.chat(learner.userId, learner.states[key], 'What should this look like?'));
    expect(transport.unused).toBe(0);
    const shown = (response as { reply: { content: string } }).reply;
    for (const line of lines) expect(shown.content).not.toContain(line);
    expect(shown.content).toBe(WITHHELD_REPLY_NOTICE);
  });

  it('leaves an ordinary reply on the same phases untouched (the union redacts sealed echoes only)', async () => {
    for (const key of EXECUTABLE) {
      const transport = new RecordingTransport();
      transport.script([text(DRAFT), guidedReview(DRAFT)]);
      const learner = await enrol(world);
      const response = await withTransport(transport, () => world.assistant.chat(learner.userId, learner.states[key], 'Where do I start?'));
      expect([key, (response as { reply: { content: string } }).reply.content]).toEqual([key, DRAFT]);
    }
  });
});

/* ----------- what the learner is served or owns is not a sealed echo ----------- */

/**
 * Two lines of `files` a reply can carry whole (the same picker as
 * `sealedLines`) that the phase **does** serve the learner: the sealed map
 * repeats them, but the learner reads them in the explorer or wrote them.
 */
function servedLines(phase: PhaseContent, files: Record<string, string>): string[] {
  const served = new Set(phase.files.flatMap((file) => file.content.split('\n').map((line) => line.trim())));
  const picked: string[] = [];
  for (const content of Object.values(files)) {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line.length < 16 || !/[()[\]{}=:]/.test(line) || /^(#|\/\/|import |from |"""|\*)/.test(line) || line.includes('`') || !served.has(line) || picked.includes(line)) continue;
      picked.push(line);
      if (picked.length === 2) return picked;
    }
  }
  throw new Error(`${phase.key}: fewer than two served lines a sealed map repeats`);
}

describe('a reply quoting what the learner is served or owns is not withheld', () => {
  let world: World;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openWorld();
  });
  afterAll(async () => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
    await world?.db.destroy();
  });

  const chatEcho = async (slug: string, key: PhaseKey, lines: string[], workspace?: (phase: PhaseContent) => Record<string, string>) => {
    const echo = echoOf(lines);
    const transport = new RecordingTransport();
    transport.script([text(echo), guidedReview(echo)]);
    const learner = await enrol(world, slug);
    if (workspace) await world.db.manager.update(PhaseStateEntity, { id: learner.states[key] }, { workspace: workspace(world.content.getPhase(slug, key)) });
    const response = await withTransport(transport, () => world.assistant.chat(learner.userId, learner.states[key], 'What does this part do?'));
    expect(transport.unused).toBe(0);
    return { echo, shown: (response as { reply: { content: string } }).reply.content };
  };

  const served: Array<[string, string, PhaseKey, (phase: PhaseContent) => Record<string, string>]> = [
    ['the application a tests phase grades against, served locked (finding 2)', 'tasktrackr', 'testing', (p) => (p.checks.kind === 'tests' ? p.checks.implFiles : {})],
    ['a mutant line the served application also holds (finding 2)', 'tasktrackr', 'testing', (p) => (p.checks.kind === 'tests' ? Object.assign({}, ...p.checks.mutants.map((m) => m.files)) : {})],
    ['the application a config phase smokes, served locked (finding 2)', 'tasktrackr', 'deployment', (p) => (p.checks.kind === 'config' ? p.checks.smokeImplFiles : {})],
    ["the learner's own config the drill copies (finding 1)", 'tasktrackr', 'deployment', (p) => (p.checks.kind === 'config' && p.checks.drill ? p.checks.drill.faultedFiles : {})],
    ['the visible tests a hidden suite repeats (finding 3)', 'tasktrackr', 'implementation', (p) => (p.checks.kind === 'code' ? p.checks.hiddenTestFiles : {})],
    ['the served application on an upload (finding 2)', SHELF_SLUG, 'testing', (p) => (p.checks.kind === 'tests' ? p.checks.implFiles : {})],
    ['the served smoke files on an upload (finding 2)', SHELF_SLUG, 'deployment', (p) => (p.checks.kind === 'config' ? p.checks.smokeImplFiles : {})],
  ];

  it.each(served)('keeps a reply that quotes %s on %s', async (_what, slug, key, sealed) => {
    const phase = world.content.getPhase(slug, key);
    const { echo, shown } = await chatEcho(slug, key, servedLines(phase, sealed(phase)));
    expect(shown).toBe(echo);
  });

  it("keeps a reply that quotes two lines the learner wrote into their own file, though a sealed suite holds them too", async () => {
    const phase = world.content.getPhase(SHELF_SLUG, 'testing');
    if (phase.checks.kind !== 'tests') throw new Error('testing is tests');
    const lines = sealedLines(phase, phase.checks.referenceTestFiles);
    const own = phase.files.find((file) => file.editable)!;
    const { echo, shown } = await chatEcho(SHELF_SLUG, 'testing', lines, () => ({ [own.path]: `${own.content}\n${lines.join('\n')}\n` }));
    expect(shown).toBe(echo);
  });

  // GUARD: the subtraction takes only what is served or owned; a sealed line nobody is shown still withholds, on the reference too.
  const unserved: Array<[string, PhaseKey, (phase: PhaseContent) => Record<string, string>]> = [
    ['a hidden test', 'implementation', (p) => (p.checks.kind === 'code' ? p.checks.hiddenTestFiles : {})],
    ['a reference test', 'testing', (p) => (p.checks.kind === 'tests' ? p.checks.referenceTestFiles : {})],
    ['a smoke file the phase does not serve', 'deployment', (p) => (p.checks.kind === 'config' ? p.checks.smokeImplFiles : {})],
  ];
  it.each(unserved)("still withholds a TaskTrackr reply that carries %s nobody is served (%s)", async (_what, key, sealed) => {
    const phase = world.content.getPhase('tasktrackr', key);
    const lines = sealedLines(phase, sealed(phase));
    const { shown } = await chatEcho('tasktrackr', key, lines);
    for (const line of lines) expect(shown).not.toContain(line);
    expect(shown).toBe(WITHHELD_REPLY_NOTICE);
  });

  it('still withholds the reference answer on a code phase even where the starter repeats it', async () => {
    const phase = world.content.getPhase('tasktrackr', 'implementation');
    if (phase.checks.kind !== 'code') throw new Error('implementation is code');
    const { shown } = await chatEcho('tasktrackr', 'implementation', servedLines(phase, phase.checks.solutionFiles));
    expect(shown).toBe(WITHHELD_REPLY_NOTICE);
  });
});

/*
 * The redaction union hand-lists the sealed keys per
 * kind, beside the sealing door's own list (`authoring/sealed-roles.ts`). A
 * sealed key added there fails here until the mentor's union reads it, or it
 * is declared below with the reason it need not.
 */
describe('the redaction union reads every sealed key the sealing door knows', () => {
  const REDACTED: Record<string, PhaseChecks['kind']> = {
    solutionSources: 'code', hiddenTestFiles: 'code', referenceTestFiles: 'tests', implFiles: 'tests', smokeImplFiles: 'config', faultedFiles: 'config',
  };
  const NOT_REDACTED: Record<string, string> = {
    solutionFiles: 'its values are the solutionSources the union keeps whole',
    supportFiles: 'read-only support the learner is served (the overlay map), never an answer',
  };

  it('accounts for every sealed key', () => {
    expect([...SEALED_MAP_KEYS, ...SEALED_SNIPPET_KEYS].sort()).toEqual([...Object.keys(REDACTED), ...Object.keys(NOT_REDACTED)].sort());
  });

  it.each(Object.entries(REDACTED))('redacts a line planted under %s (%s), flat and per run', (key, kind) => {
    const planted = (where: string) => `sealed_line_${key}_${where}(value) == expected`;
    const map = (where: string) => (key === 'solutionSources' ? [planted(where)] : { [`ours/${where}.txt`]: planted(where) });
    const checks = key === 'faultedFiles'
      ? { kind, drill: { faultedFiles: map('flat') } }
      : { kind, [key]: map('flat'), runs: [{ [key]: map('run') }] };
    const union = sealedRedactionSources(checks as unknown as PhaseChecks, { files: [{ content: 'a served line nobody sealed = 1' }] }).join('\n');
    expect(union).toContain(planted('flat'));
    if (key !== 'faultedFiles' && key !== 'smokeImplFiles' && key !== 'solutionSources') expect(union).toContain(planted('run'));
  });
});

/* ------------------------- the Agentic reply ------------------------- */

/**
 * Agentic replies are not redacted, on either arm. An Agentic proposal is
 * whole editable files by contract,
 * and its control is the explanation gate, not an output filter, the same on
 * TaskTrackr as on an upload. The seal on this surface is the input side: its
 * requests carry the editable files only, which the marker grep above proves
 * for every executable kind. This pins the answer so a change to it is a
 * decision, not a drift.
 */
describe('the Agentic surface is sealed on its input and not filtered on its output', () => {
  let world: World;
  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openWorld();
  });
  afterAll(async () => {
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
    await world?.db.destroy();
  });

  it.each([['tasktrackr', 'implementation'], [SHELF_SLUG, 'implementation']] as const)(
    'keeps a %s proposal exactly as generated, and its request carries no sealed file',
    async (slug, key) => {
      const phase = world.content.getPhase(slug, key);
      if (phase.checks.kind !== 'code') throw new Error('implementation is code');
      const target = phase.files.find((file) => file.editable)!.path;
      const proposed = `${phase.files.find((file) => file.path === target)!.content}\n# proposed change\n`;
      const transport = new RecordingTransport();
      transport.script([
        text(JSON.stringify({ adequate: true, feedback: 'Clear.', questions: [] })),
        text(JSON.stringify({ files: { [target]: proposed } })),
      ]);
      const manager = world.db.manager;
      world.learners += 1;
      const user = await manager.save(manager.create(UserEntity, { email: `n5-agentic-${world.learners}@learnsdlc.test`, passwordHash: 'unused', displayName: 'N5 agentic' }));
      const enrollment = await manager.save(manager.create(EnrollmentEntity, { userId: user.id, projectSlug: slug, currentPhaseOrder: 1 }));
      const state = await manager.save(manager.create(PhaseStateEntity, { enrollmentId: enrollment.id, userId: user.id, phaseKey: key, phaseOrder: phase.order, status: 'in_progress', attempts: 0, bestScore: null, workspace: null }));
      const proposal = await withTransport(transport, () => world.agentic.propose(user.id, state.id, 'Add one comment that names the rule this function keeps.'));
      expect((proposal as { files: Record<string, string> }).files).toEqual({ [target]: proposed });
      const sealed = Object.values({ ...phase.checks.hiddenTestFiles, ...phase.checks.solutionFiles });
      for (const body of transport.bodies) {
        for (const file of sealed) expect(body.includes(JSON.stringify(file).slice(1, -1))).toBe(false);
        if (slug === SHELF_SLUG) expect(ALL_SHELF_MARKERS.filter((marker) => body.includes(marker))).toEqual([]);
      }
    },
  );
});
