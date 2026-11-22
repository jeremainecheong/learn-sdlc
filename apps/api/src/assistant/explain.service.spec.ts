import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { FeedbackReport, RunResult, TestCaseResult } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import {
  ALL_ENTITIES,
  AiCacheEntity,
  AssistantMessageEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  SettingEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { NotesService } from '../instructor/notes.service';
import { WorkflowService } from '../workflow/workflow.service';
import { AssistantService } from './assistant.service';
import { ExplainService } from './explain.service';
import { EXPLAIN_WITHHELD_NOTICE, WITHHELD_REPLY_NOTICE } from './guardrails';
import { LocalMentorProvider } from './local.provider';
import { OpenAiProvider } from './openai.provider';
import type { MentorContext } from './provider.types';

/**
 * The explain route's own rules live here: which result the button was drawn
 * from, which case it named, and, the case this file exists for, what the
 * mentor is allowed to see about it. Everything else the turn does (budget,
 * cache, guardrails, transcript) belongs to `AssistantService` and is proved by
 * `assistant.service.spec.ts`; nothing of it is re-proved here.
 */

/** A learner file of numbered lines, so an excerpt can be read exactly. */
const numbered = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line_${i + 1} = ${i + 1}`).join('\n');

const failedCase = (over: Partial<TestCaseResult> = {}): TestCaseResult => ({
  name: 'test_overdue_excludes_today',
  status: 'failed',
  message: 'AssertionError: assert 2 == 1\n  File "manager.py", line 56\n    trailing trace',
  frames: [{ path: 'api/repository/tasks.py', line: 56 }],
  ...over,
});

const report = (cases: TestCaseResult[]): FeedbackReport =>
  ({
    overall: 40,
    passed: false,
    passThreshold: 70,
    criteria: [],
    checks: [],
    tests: { total: cases.length, passed: 0, failed: cases.length, errored: 0, cases },
    aiReview: { summary: '', strengths: [], improvements: [], processNote: '', provider: 'local' },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: {
      relianceFlag: false,
      relianceIndex: 0,
      mentorPasteFlag: false,
      noEffortFlag: false,
      note: '',
    },
  }) as unknown as FeedbackReport;

const runResult = (cases: TestCaseResult[]): RunResult => ({
  ok: false,
  exitKind: 'ok',
  stdout: '',
  stderr: '',
  durationMs: 12,
  tests: { total: cases.length, passed: 0, failed: cases.length, errored: 0, cases },
});

describe('ExplainService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let local: LocalMentorProvider;
  let notes: NotesService;
  let assistant: AssistantService;
  let explain: ExplainService;
  let phase: PhaseContent;

  let userId = '';
  let enrollment: EnrollmentEntity;
  let state: PhaseStateEntity;
  /** What the workflow's ownership check answers with; a test may make it throw. */
  let owned: () => Promise<{ state: PhaseStateEntity; phase: PhaseContent; enrollment: EnrollmentEntity }>;

  const manager = () => dataSource.manager;

  const build = () => {
    assistant = new AssistantService(
      dataSource.getRepository(AssistantMessageEntity),
      dataSource.getRepository(AiCacheEntity),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(SubmissionEntity),
      content,
      local,
      { available: true, name: 'mock-ai', chat: (ctx: MentorContext) => local.chat(ctx) } as unknown as OpenAiProvider,
      notes,
    );
    explain = new ExplainService(
      dataSource.getRepository(SubmissionEntity),
      dataSource.getRepository(ExecutionRunEntity),
      { loadOwnedState: () => owned() } as unknown as WorkflowService,
      content,
      assistant,
    );
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    local = new LocalMentorProvider();
    notes = new NotesService(dataSource);
    phase = content.getPhase('tasktrackr', 'implementation');
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    const user = await manager().save(
      manager().create(UserEntity, {
        email: 'lee@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'Lee',
      }),
    );
    userId = user.id;
    enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 3,
      }),
    );
    state = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId,
        phaseKey: 'implementation',
        phaseOrder: 3,
        status: 'in_progress',
        attempts: 1,
        workspace: { 'api/repository/tasks.py': numbered(120) },
      }),
    );
    owned = async () => ({ state, phase, enrollment });
    build();
  });

  const saveSubmission = (cases: TestCaseResult[], over: Partial<SubmissionEntity> = {}) =>
    manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: state.id,
        userId,
        status: 'completed',
        score: 40,
        passed: false,
        report: report(cases),
        ...over,
      }),
    );

  const saveRun = (cases: TestCaseResult[], over: Partial<ExecutionRunEntity> = {}) =>
    manager().save(
      manager().create(ExecutionRunEntity, {
        phaseStateId: state.id,
        userId,
        kind: 'run',
        status: 'completed',
        result: runResult(cases),
        ...over,
      }),
    );

  it('explains the failing case the button named', async () => {
    await saveSubmission([failedCase()]);

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });

    expect(answer.question).toBe('Why does test_overdue_excludes_today fail?');
    expect(answer.reply.role).toBe('assistant');
    expect(answer.reply.content).toContain('overdue excludes today');
    expect(answer.subject).toEqual({
      testName: 'test_overdue_excludes_today',
      hidden: false,
      assertion: 'AssertionError: assert 2 == 1',
      where: 'api/repository/tasks.py, line 56',
      step: null,
    });
    // The turn is a real pair in the transcript, which is what makes it a hint.
    const history = await assistant.history(userId, state.id);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe('Why does test_overdue_excludes_today fail?');
  });

  it('refuses a case that is not in that result', async () => {
    await saveSubmission([failedCase()]);
    await expect(
      explain.explainFailingTest(userId, state.id, {
        testName: 'test_that_never_ran',
        source: 'submission',
      }),
    ).rejects.toThrow('that test is not in this result any more');
  });

  it('refuses a case that passed', async () => {
    await saveSubmission([failedCase({ status: 'passed', message: '' })]);
    await expect(
      explain.explainFailingTest(userId, state.id, {
        testName: 'test_overdue_excludes_today',
        source: 'submission',
      }),
    ).rejects.toThrow('that test is not in this result any more');
  });

  it('reads the newest completed submission when none is named', async () => {
    const older = await saveSubmission([failedCase({ message: 'AssertionError: the old one' })]);
    const newer = await saveSubmission([failedCase({ message: 'AssertionError: the new one' })]);
    // Two rows can share a createdAt on sqlite, which is the tie the id break
    // in the service is for.
    expect(older.id).not.toBe(newer.id);
    await manager().update(SubmissionEntity, newer.id, {
      createdAt: (older as unknown as { createdAt: Date }).createdAt,
    } as never);

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });
    expect([older.id, newer.id]).toContain(
      (await manager().findOneByOrFail(SubmissionEntity, { id: newer.id })).id,
    );
    expect(answer.subject.assertion).toBe('AssertionError: the new one');
  });

  it('reads a run when the button was drawn on one', async () => {
    await saveSubmission([failedCase({ message: 'AssertionError: from the submission' })]);
    await saveRun([failedCase({ message: 'AssertionError: from the run' })]);

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'run',
    });
    expect(answer.subject.assertion).toBe('AssertionError: from the run');
  });

  it('tells the two halves of a full-stack result apart by their step', async () => {
    await saveSubmission([
      failedCase({ step: 'api', message: 'AssertionError: the python half' }),
      failedCase({
        step: 'web',
        message: 'AssertionError: the typescript half',
        frames: [{ path: 'web/src/lib/overdue.ts', line: 8 }],
      }),
    ]);

    const web = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
      step: 'web',
    });
    expect(web.subject.assertion).toBe('AssertionError: the typescript half');
    expect(web.subject.step).toBe('web');
  });

  it('never hands the mentor a hidden test source', async () => {
    const sealed = 'SEALED_HIDDEN_ASSERTION_9f2c';
    const sealedPhase = {
      ...phase,
      checks: {
        ...phase.checks,
        hiddenTestFiles: { 'hidden_tests/api/test_seal.py': `def test_seal():\n    ${sealed}\n` },
      },
    } as PhaseContent;
    owned = async () => ({ state, phase: sealedPhase, enrollment });
    jest.spyOn(content, 'getPhase').mockReturnValue(sealedPhase);
    // The frame names the hidden file itself: the worst case, and the one a
    // filter would have to catch. Nothing filters, `executionFiles` maps
    // `phase.files` alone, and the sealed suite is not in it.
    await saveSubmission([
      failedCase({ hidden: true, frames: [{ path: 'hidden_tests/api/test_seal.py', line: 2 }] }),
    ]);
    const seen: MentorContext[] = [];
    jest.spyOn(local, 'chat').mockImplementation(async (ctx: MentorContext) => {
      seen.push(ctx);
      return { content: 'a hint', tokensIn: 1, tokensOut: 1, provider: 'local-mentor' };
    });

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0].failingTest)).not.toContain(sealed);
    expect(seen[0].failingTest?.excerpt).toBe('');
    expect(seen[0].failingTest?.hidden).toBe(true);
    expect(answer.subject.hidden).toBe(true);
  });

  it("sends the learner's own file around the frame, and only that", async () => {
    await saveSubmission([failedCase()]);
    const seen: MentorContext[] = [];
    jest.spyOn(local, 'chat').mockImplementation(async (ctx: MentorContext) => {
      seen.push(ctx);
      return { content: 'a hint', tokensIn: 1, tokensOut: 1, provider: 'local-mentor' };
    });

    await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });

    const excerpt = seen[0].failingTest?.excerpt ?? '';
    expect(excerpt).toContain('line_56 = 56');
    expect(excerpt).toContain('line_44 = 44');
    expect(excerpt).not.toContain('line_16 = 16');
    expect(excerpt).not.toContain('line_120 = 120');
  });

  it('sends no excerpt when the frame landed in a file the learner cannot edit', async () => {
    await saveSubmission([failedCase({ frames: [{ path: 'api/db.py', line: 10 }] })]);
    const seen: MentorContext[] = [];
    jest.spyOn(local, 'chat').mockImplementation(async (ctx: MentorContext) => {
      seen.push(ctx);
      return { content: 'a hint', tokensIn: 1, tokensOut: 1, provider: 'local-mentor' };
    });

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });
    expect(seen[0].failingTest?.excerpt).toBe('');
    // The frame is still named: where it landed is not a secret, the file is.
    expect(answer.subject.where).toBe('api/db.py, line 10');
  });

  it('caps the assertion at the first line and 160 characters', async () => {
    await saveSubmission([
      failedCase({ message: `AssertionError: ${'x'.repeat(300)}\nsecond line` }),
    ]);
    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });
    expect(answer.subject.assertion).toHaveLength(160);
    expect(answer.subject.assertion.endsWith('…')).toBe(true);
    expect(answer.subject.assertion).not.toContain('second line');
  });

  it('a locked phase is refused', async () => {
    await saveSubmission([failedCase()]);
    owned = async () => {
      throw new ForbiddenException('phase is locked');
    };
    await expect(
      explain.explainFailingTest(userId, state.id, {
        testName: 'test_overdue_excludes_today',
        source: 'submission',
      }),
    ).rejects.toThrow('phase is locked');
  });

  /* ------------------- a withheld explanation ------------------------------- */

  /**
   * The reply a small model actually sent when asked to explain a red test:
   * ten lines of the function, unfenced, which is exactly what the output
   * guardrail's second pass exists to eat. The learner must not get
   * `WITHHELD_REPLY_NOTICE` back, "I was writing this out for you rather than
   * with you", for a question the product typed on their behalf, nor spend
   * one of the ten that cost nothing on it.
   */
  const WHOLE_FUNCTION = [
    'def overdue_tasks(conn, today):',
    '    rows = conn.execute("select * from tasks").fetchall()',
    '    result = []',
    '    for row in rows:',
    '        if row["due"] is None:',
    '            continue',
    '        if row["due"] < today:',
    '            result.append(row)',
    '    result.sort(key=lambda r: r["due"])',
    '    return result',
  ].join('\n');

  /** The same service, over a model that is available and answers with `said`. */
  const buildWithModel = (said: string): void => {
    assistant = new AssistantService(
      dataSource.getRepository(AssistantMessageEntity),
      dataSource.getRepository(AiCacheEntity),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(SubmissionEntity),
      content,
      local,
      {
        available: true,
        name: 'openai',
        chat: async () => ({ content: said, provider: 'openai', tokensIn: 40, tokensOut: 120 }),
      } as unknown as OpenAiProvider,
      notes,
    );
    explain = new ExplainService(
      dataSource.getRepository(SubmissionEntity),
      dataSource.getRepository(ExecutionRunEntity),
      { loadOwnedState: () => owned() } as unknown as WorkflowService,
      content,
      assistant,
    );
  };

  it('withholds a full solution without substituting a simulated explanation', async () => {
    await saveSubmission([failedCase()]);
    buildWithModel(WHOLE_FUNCTION);

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });

    expect(answer.reply.content).toBe(EXPLAIN_WITHHELD_NOTICE);
    expect(answer.reply.content).not.toContain(WHOLE_FUNCTION);
    expect(answer.reply.meta?.provider).toBe('guardrail');
    const history = await assistant.history(userId, state.id);
    expect(history.map((m) => m.role)).toEqual(['assistant']);
    // The model's draft was never shown, so it was never cached as the answer.
    const cached = await dataSource.getRepository(AiCacheEntity).find();
    expect(cached).toHaveLength(0);
  });

  it('does not charge a question for an explanation it could not give', async () => {
    await saveSubmission([failedCase()]);
    buildWithModel(WHOLE_FUNCTION);
    // The offline explanation cannot normally trip the filter, it is pack
    // prose, so the residual path is forced here rather than left untested.
    jest.spyOn(local, 'chat').mockResolvedValue({
      content: WHOLE_FUNCTION,
      provider: 'local-mentor',
      tokensIn: 0,
      tokensOut: 0,
    });

    const answer = await explain.explainFailingTest(userId, state.id, {
      testName: 'test_overdue_excludes_today',
      source: 'submission',
    });

    expect(answer.reply.content).toBe(EXPLAIN_WITHHELD_NOTICE);
    expect(answer.reply.content).toContain('did not count as a question');
    // No `role: 'user'` row, which is the definition every hint count shares.
    const rows = await dataSource
      .getRepository(AssistantMessageEntity)
      .find({ where: { phaseStateId: state.id } });
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(0);
    expect(rows.filter((row) => row.role === 'assistant')).toHaveLength(1);
  });
});
