import 'reflect-metadata';
import { DataSource, Logger as TypeormLogger } from 'typeorm';
import { ContentService } from '../content/content.service';
import type { AssistantService } from '../assistant/assistant.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InstructorService } from '../instructor/instructor.service';
import { auditCursor } from '../instructor/audit-cursor';
import {
  ALL_ENTITIES,
  AssistantMessageEntity,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  UserEntity,
} from './entities';

/**
 * A plan line that seeks into the named index rather than walking a table.
 * The alias sqlite prints is TypeORM's, which differs per query, so the index
 * name is what identifies the line.
 */
const SEARCH_USING = (line: string, index: string): boolean =>
  new RegExp(`^SEARCH \\S+ USING (COVERING )?INDEX ${index}`).test(line);

/**
 * A table read end to end. `SCAN <alias> USING ... INDEX` is an ordered walk of
 * an index and is fine; `SCAN <alias>` on its own is the thing these indexes
 * exist to remove. A co-routine's own `SCAN` names the subquery, not a table,
 * so callers that build one exclude it themselves.
 */
const BARE_SCAN = (line: string): boolean => /^SCAN /.test(line) && !line.includes('USING');

/** One statement the application actually issued, with what it bound to it. */
interface Issued {
  query: string;
  parameters: unknown[];
}

/**
 * Records every statement so a test can ask the database how it would run the
 * query the application wrote, rather than how it would run one a test wrote.
 */
class QueryRecorder implements TypeormLogger {
  issued: Issued[] = [];
  logQuery(query: string, parameters?: unknown[]): void {
    this.issued.push({ query, parameters: parameters ?? [] });
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

/**
 * The console's query plans, at the schema.
 *
 * Without these indexes the console's cost would grow with everything the
 * deployment had ever stored rather than with the caller's class:
 * `learnerScope` would open every request with `SCAN users`, and the audit
 * page would read the whole trail and sort all of it to show fifty rows.
 * These are the plans, asked of sqlite
 * for the statements the services really issue: captured through the query
 * logger and handed straight back to `EXPLAIN QUERY PLAN` with their own
 * parameters, so an assertion here cannot pass against a query the
 * application has stopped writing.
 *
 * No `ANALYZE` anywhere, deliberately. sqlite has no automatic statistics and
 * nothing in the product runs `ANALYZE`, so an instructor's laptop plans with
 * the defaults, and that is the regime these assertions have to hold in. With
 * statistics the planner reaches most of these shapes on its own; without them
 * it needs the index to be the obvious answer.
 */
describe('the indexes the console reads through', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let instructor: InstructorService;
  let analytics: AnalyticsService;
  const recorder = new QueryRecorder();

  const assistant = {
    defaultBudget: async () => 20_000,
    budgetFor: async () => 20_000,
    tokensToday: async () => 0,
    activeProviderName: () => 'local-mentor',
    recentProviderName: async () => 'local-mentor',
  } as unknown as AssistantService;

  const manager = () => dataSource.manager;

  let danaId = '';
  let learnerId = '';
  let phaseStateIds: string[] = [];

  /** Every plan line sqlite prints for one recorded statement. */
  const planOf = async (issued: Issued): Promise<string[]> => {
    const rows: { detail: string }[] = await dataSource.query(
      `EXPLAIN QUERY PLAN ${issued.query}`,
      issued.parameters,
    );
    return rows.map((row) => row.detail);
  };

  /** The plans for every recorded statement that reads the named table. */
  const plansTouching = async (table: string): Promise<string[][]> => {
    const matching = recorder.issued.filter(
      (issued) => issued.query.startsWith('SELECT') && issued.query.includes(`"${table}"`),
    );
    expect(matching.length).toBeGreaterThan(0);
    return Promise.all(matching.map(planOf));
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
      logging: true,
      logger: recorder,
    });
    await dataSource.initialize();
    content = new ContentService();
    content.loadAll();
    instructor = new InstructorService(dataSource, content, assistant);
    analytics = new AnalyticsService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(AssistantMessageEntity),
      content,
      assistant,
    );

    const dana = await manager().save(
      manager().create(UserEntity, {
        email: 'dana@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'Dana',
        role: 'INSTRUCTOR',
        cohort: 'tuesday',
      }),
    );
    danaId = dana.id;
    await manager().save(
      manager().create(CohortEntity, {
        id: 'tuesday',
        name: 'Tuesday class',
        joinCode: 'TUES2222',
        ownerUserId: danaId,
      }),
    );
    const learner = await manager().save(
      manager().create(UserEntity, {
        email: 'ash@learnsdlc.test',
        passwordHash: 'x',
        displayName: 'Ash',
        cohort: 'tuesday',
      }),
    );
    learnerId = learner.id;
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId: learnerId, projectSlug: 'tasktrackr' }),
    );
    for (const phase of content.getProject('tasktrackr').phases) {
      const state = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId: learnerId,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          status: phase.order === 1 ? 'in_progress' : 'locked',
        }),
      );
      phaseStateIds.push(state.id);
      for (let attempt = 0; attempt < 3; attempt++) {
        await manager().save(
          manager().create(SubmissionEntity, {
            phaseStateId: state.id,
            userId: learnerId,
            status: 'failed',
            score: 40 + attempt,
            createdAt: new Date(1_788_000_000_000 + attempt * 1000),
          } as Partial<SubmissionEntity>),
        );
      }
      await manager().save(
        manager().create(AssistantMessageEntity, {
          userId: learnerId,
          enrollmentId: enrollment.id,
          phaseStateId: state.id,
          phaseKey: phase.key,
          role: 'user',
          content: 'why',
        }),
      );
      await manager().save(
        manager().create(AuditEventEntity, {
          event: 'phase.override',
          actorUserId: danaId,
          subjectUserId: learnerId,
          reason: 'they asked in the lab',
        }),
      );
    }
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(() => {
    recorder.issued = [];
  });

  describe('no instructor request scans a table it does not need', () => {
    it('finds the caller class without reading every account the deployment has held', async () => {
      await instructor.exportCsv({ id: danaId, role: 'INSTRUCTOR', cohort: 'tuesday' });

      const plans = await plansTouching('users');
      const scoped = plans.filter((plan) =>
        plan.some((line) => line.includes('IDX_users_role_cohort')),
      );
      expect(scoped.length).toBeGreaterThan(0);
      for (const plan of scoped) {
        // A seek into the caller's class, not a walk of the table. The export
        // also sorts by email, which is a b-tree over the class and not over
        // everyone the deployment has ever enrolled; that one is the point of
        // the page, not a cost that grows with the term.
        expect(plan.some((line) => SEARCH_USING(line, 'IDX_users_role_cohort'))).toBe(true);
        expect(plan.some(BARE_SCAN)).toBe(false);
      }
    });

    it('reads the audit page as a range on an index already in its order', async () => {
      const caller = { id: danaId, role: 'INSTRUCTOR' as const, cohort: 'tuesday' };
      // Every shape the page has: a class, one learner, an admin, and a
      // second page. The first three were `SCAN audit_events` and a sort of
      // the whole table before the indexes existed; the fourth could not be
      // asked for at all.
      const page = await instructor.auditLog(caller, undefined, 3);
      await instructor.auditLog(caller, learnerId, 3);
      await instructor.auditLog({ id: danaId, role: 'ADMIN', cohort: 'tuesday' }, undefined, 3);
      await instructor.auditLog(caller, undefined, 3, auditCursor(page[page.length - 1]));

      const plans = await plansTouching('audit_events');
      expect(plans.length).toBe(4);
      for (const plan of plans) {
        expect(plan.some((line) => /USING INDEX IDX_audit_events_/.test(line))).toBe(true);
        expect(plan.some((line) => SEARCH_USING(line, 'IDX_audit_events_'))).toBe(true);
        // The sort is what grew with the term: fifty rows shown, every row read.
        expect(plan.some((line) => line.includes('TEMP B-TREE'))).toBe(false);
        expect(plan.some(BARE_SCAN)).toBe(false);
      }
    });

    it('finds the newest attempt per phase without reading the attempts before it', async () => {
      await analytics.classMap({ id: danaId, role: 'INSTRUCTOR', cohort: 'tuesday' }, 'tasktrackr');

      const plans = await plansTouching('submissions');
      const newest = plans.filter((plan) =>
        plan.some((line) => line.includes('IDX_submissions_phase_state_created')),
      );
      expect(newest.length).toBeGreaterThan(0);
      // `MAX(createdAt)` per phase state never leaves the index, and the row it
      // names is found by `(phaseStateId, createdAt)` rather than by reading
      // the phase's back catalogue.
      expect(
        newest.some((plan) =>
          plan.some((line) =>
            /USING COVERING INDEX IDX_submissions_phase_state_created \(phaseStateId=\?\)/.test(line),
          ),
        ),
      ).toBe(true);
      expect(
        newest.some((plan) =>
          plan.some((line) =>
            /USING INDEX IDX_submissions_phase_state_created \(phaseStateId=\? AND createdAt=\?\)/.test(
              line,
            ),
          ),
        ),
      ).toBe(true);
      for (const plan of plans) {
        expect(plan.some((line) => /^SCAN \S+ \(submissions\)/.test(line))).toBe(false);
        expect(plan.some((line) => /^SCAN submissions\b(?! USING)/.test(line))).toBe(false);
      }
    });

    it("sums the class's tokens for the day without walking anybody's term", async () => {
      await analytics.instructorOverview(danaId);

      const plans = await plansTouching('assistant_messages');
      const tokens = plans.filter((plan) =>
        plan.some((line) => line.includes('IDX_assistant_messages_user_created')),
      );
      expect(tokens.length).toBeGreaterThan(0);
      for (const plan of tokens) {
        expect(
          plan.some((line) =>
            /USING INDEX IDX_assistant_messages_user_created \(userId=\? AND createdAt>\?\)/.test(line),
          ),
        ).toBe(true);
      }
      expect(plans.every((plan) => !plan.some(BARE_SCAN))).toBe(true);
    });
  });

  describe('an enrolment and a submission can record which pack they used', () => {
    it('stores a pack version on both, and leaves it null where nothing stamped one', async () => {
      const enrollment = await manager().save(
        manager().create(EnrollmentEntity, {
          userId: learnerId,
          projectSlug: 'other-pack',
          packVersion: '2026.09.1',
        }),
      );
      const submission = await manager().save(
        manager().create(SubmissionEntity, {
          phaseStateId: phaseStateIds[0],
          userId: learnerId,
          status: 'completed',
          passed: true,
          packVersion: '2026.09.2',
        }),
      );

      const storedEnrollment = await manager().findOneByOrFail(EnrollmentEntity, {
        id: enrollment.id,
      });
      const storedSubmission = await manager().findOneByOrFail(SubmissionEntity, {
        id: submission.id,
      });
      expect(storedEnrollment.packVersion).toBe('2026.09.1');
      expect(storedSubmission.packVersion).toBe('2026.09.2');

      // Null is the truth for everything written before packs were versioned,
      // and nothing backfills it: a reader must not read null as a version.
      const older = await manager().findOneByOrFail(SubmissionEntity, {
        phaseStateId: phaseStateIds[0],
        status: 'failed',
      });
      expect(older.packVersion).toBeNull();
    });
  });
});
