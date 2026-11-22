import 'reflect-metadata';
import * as path from 'path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { DataSource } from 'typeorm';
import { DEFAULT_QUIZ_PASS_MARK, INHERITED_TASK_KEY, QUIZ_ONLY_ADD_REFUSAL } from '@learnsdlc/shared';
import type { AuthoredQuiz, QuizChecks } from '@learnsdlc/shared';
import { config } from '../config';
import { AuditEventEntity } from '../db/entities';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import {
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
} from '../content/project.entities';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { AuthoringController } from './authoring.controller';
import { AuthoredQuizDto } from './authoring.dto';
import { AuthoringService } from './authoring.service';
import { memoryDataSource } from '../../test/support/memory-db';

const TEACHER = { id: 'teacher-1', role: 'INSTRUCTOR' as const, cohort: 'default' };
const OTHER_TEACHER = { id: 'teacher-2', role: 'INSTRUCTOR' as const, cohort: 'default' };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, cohort: 'default' };

/** What a teacher's editor posts. Deliberately synthetic: see `FIXTURE_QUIZ_NOTICE`. */
const authoredQuiz = (over: Partial<AuthoredQuiz> = {}): AuthoredQuiz => ({
  questions: fixtureQuizQuestions(5),
  drawn: 3,
  ...over,
});

/**
 * **The teacher's half of a quiz: the fork inside two routes, and the one
 * door that carries the key.**
 *
 * Three properties, and each of them is a thing that would otherwise fail
 * quietly rather than loudly.
 *
 * - **A quiz mints nothing.** It is the one task a phase adds beside its own
 *   work (`QUIZ_ONLY_ADD_REFUSAL` refuses every other body), and it mints no
 *   artefact path, derives no rules rubric and writes no starter file. *"None"*
 *   is asserted on the functions themselves rather than on the row they would
 *   have written, because the failure this catches is a route that quietly
 *   minted a file nothing ever writes to, which looks exactly like a correct
 *   row until a learner opens the phase.
 *
 * - **The edit passes the real kind.** `updateTask` asks `isAuthorableTask`
 *   with the task's own kind, so a quiz cannot become a record and a record
 *   cannot become a quiz, and the spec walks both arms to say so.
 *
 * - **The key has exactly one door, and it is not the draft's.** `readDraft`
 *   and `listTasks` are guarded by `requireVisibleProject`, which admits every
 *   instructor on the deployment for any platform-owned project and any `ADMIN`
 *   for anybody's. So the third property is not *"a non-owner is refused"* (after a copy
 *   the caller **is** the owner) it is that the two callers that guard admits
 *   are refused at the key route, and that the draft payload carries neither
 *   `correct` nor `explanation` at all.
 *
 * The assertions live here rather than in `authoring.service.spec.ts`, which
 * covers `createProject` and `compile`'s per-phase overlay; nothing below
 * touches either.
 */
describe('the teacher authoring a quiz', () => {
  let dataSource: DataSource;
  let importer: ProjectImporterService;
  let content: ContentService;
  let registry: ProjectRegistryService;
  let service: AuthoringService;
  let seedProjectId = '';
  let seedVersionId = '';

  const copyOfTheDefault = async (slug: string, title: string, caller = TEACHER) =>
    service.createProject(caller, { title, slug, fromVersionId: seedVersionId });

  const taskRowFor = async (versionId: string, phaseKey: string, taskKey: string) => {
    const phase = await dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });
    return dataSource
      .getRepository(ProjectTaskEntity)
      .findOneByOrFail({ projectPhaseId: phase.id, taskKey });
  };

  /** Checks that are a quiz's, asserted rather than cast. */
  const quizOf = (checks: ProjectTaskEntity['checks']): QuizChecks => {
    expect(checks.kind).toBe('quiz');
    return checks as QuizChecks;
  };

  /**
   * The rows this one door leaves, by event.
   *
   * By event and not "the last row", because a task mutation writes
   * `project.tasks` in the same second and `createdAt` ties: a reader who
   * took the tail would be asserting about whichever row the sort happened to
   * put last.
   */
  const rowsOf = async (targetId: string, event: string) =>
    (await dataSource.getRepository(AuditEventEntity).find({ where: { targetId } })).filter(
      (row) => String(row.event) === event,
    );

  const keyReadsOf = async (targetId: string) => rowsOf(targetId, 'project.quiz-key');

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    importer = new ProjectImporterService(content, dataSource);
    registry = new ProjectRegistryService(content, dataSource, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);

    const imported = await importer.importPack(
      new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')),
      { origin: 'seed', platformOwned: true },
    );
    seedProjectId = imported.projectId;
    seedVersionId = imported.projectVersionId;
    await dataSource.getRepository(ProjectEntity).update({ id: seedProjectId }, { isDefault: true });
    await registry.load();

    service = new AuthoringService(dataSource, importer, registry);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /**
   * The step a quiz must not reach, watched rather than inferred: a workspace
   * file. `insertFiles` is spied on the importer instance the service holds.
   * The row's own `artefactPath: null` is asserted beside it.
   */
  const watchTheFileSteps = () => ({
    insertFiles: jest.spyOn(importer, 'insertFiles'),
  });

  /* ------------------------------ addTask -------------------------------- */

  describe('addTask, forked on the quiz before the mint', () => {
    it('writes a quiz that owns no file, and reaches none of the file steps', async () => {
      const made = await copyOfTheDefault('quiz-add', 'Quiz Add');
      const watched = watchTheFileSteps();

      const result = await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'concepts',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz(),
      });

      // no workspace file: a route that wrote one here would leave a file
      // nothing ever writes to.
      expect(watched.insertFiles).not.toHaveBeenCalled();

      const row = await taskRowFor(made.draftVersionId, 'design', 'concepts');
      expect(row.artefactType).toBe('quiz');
      expect(row.artefactPath).toBeNull();
      expect(row.required).toBe(false);
      expect(row.order).toBe(2);
      expect(row.primaryPath).toBeNull();
      expect(quizOf(row.checks).questions).toHaveLength(5);

      // and it owns nothing: `ownsFor` answers the empty list for a row with
      // no path and no graded path, so the inherited task keeps **every**
      // editable file the phase mounts (a quiz minted none of them away from
      // it) and `no task owns the editable file` still passes
      const view = result.phase.tasks.find((one) => one.taskKey === 'concepts');
      expect(view?.owns).toEqual([]);
      expect(result.phase.tasks.find((one) => one.taskKey === INHERITED_TASK_KEY)?.owns).toEqual([
        // TaskTrackr 4.0.0's Design: its three records
        'design/design.json',
        'shared/contract/api.json',
        'shared/contract/screens.json',
      ]);

      // no file row was added for it either: the assertion beneath the spy
      const files = await dataSource
        .getRepository(ProjectFileEntity)
        .count({ where: { projectVersionId: made.draftVersionId } });
      const untouched = await copyOfTheDefault('quiz-add-control', 'Quiz Add Control');
      expect(files).toBe(
        await dataSource
          .getRepository(ProjectFileEntity)
          .count({ where: { projectVersionId: untouched.draftVersionId } }),
      );
    });

    it('derives one criterion, keyed by the quiz\'s own, at the mark the quiz passes on', async () => {
      const made = await copyOfTheDefault('quiz-rubric', 'Quiz Rubric');

      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'concepts',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ criterion: 'design-concepts', passMark: 80 }),
      });

      const row = await taskRowFor(made.draftVersionId, 'design', 'concepts');
      // exactly one criterion and its key is `checks.criterion`, which is what
      // `quiz-rubric-key-is-the-quiz's` holds a published snapshot to: a
      // mismatch is `scores.get(key) ?? 0`, a flat zero with no evidence.
      expect(row.rubric.criteria).toHaveLength(1);
      expect(row.rubric.criteria[0].key).toBe('design-concepts');
      expect(row.rubric.criteria[0].weight).toBe(1);
      expect(row.rubric.criteria[0].description).not.toMatch(/rule/i);
      // one number and not two: the rubric's gate is the mark the quiz is
      // passed at, so the editor's rubric panel cannot say 70 while the paper
      // passes at 80.
      expect(row.rubric.passThreshold).toBe(80);
      expect(quizOf(row.checks).passMark).toBe(80);
    });

    it('fills the defaults the contract names, and the attempts default turns on requiredness', async () => {
      const made = await copyOfTheDefault('quiz-defaults', 'Quiz Defaults');

      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'gated',
        title: 'A gate',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: true,
        quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
      });
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
        taskKey: 'formative',
        title: 'A formative check',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: { questions: fixtureQuizQuestions(5) },
      });

      const gated = quizOf((await taskRowFor(made.draftVersionId, 'design', 'gated')).checks);
      expect(gated.passMark).toBe(DEFAULT_QUIZ_PASS_MARK);
      expect(gated.shuffleOptions).toBe(true);
      expect(gated.criterion).toBe('concepts');
      expect(gated.drawn).toBe(3);
      // a required quiz is created with a finite limit, because an unlimited
      // re-sit of a fixed paper is a gate that opens on persistence
      expect(gated.attempts).toEqual({ max: 3, cooldownSeconds: null });

      const formative = quizOf(
        (await taskRowFor(made.draftVersionId, 'requirements', 'formative')).checks,
      );
      expect(formative.attempts).toEqual({ max: null, cooldownSeconds: null });
      expect(formative.drawn).toBeUndefined();
    });

    it('refuses a quiz type with no paper, and a paper on another type', async () => {
      // Maintenance: a written door that is not Design's (a Design phase holds one design task)
      const made = await copyOfTheDefault('quiz-refusals', 'Quiz Refusals');
      const base = {
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        required: false,
      };

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', {
          ...base,
          taskKey: 'no-paper',
          artefactType: 'quiz',
        }),
      ).rejects.toThrow(/questions/i);

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', {
          ...base,
          taskKey: 'wrong-type',
          artefactType: 'design-doc',
          quiz: authoredQuiz(),
        }),
      ).rejects.toThrow(/quiz/i);

      // and nothing of any of them was written
      const phase = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: made.draftVersionId, key: 'maintenance' as never });
      const rows = await dataSource
        .getRepository(ProjectTaskEntity)
        .find({ where: { projectPhaseId: phase.id } });
      expect(rows.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
    });

    it('refuses a pass mark, an attempt limit and a criterion a report could not read', async () => {
      const made = await copyOfTheDefault('quiz-bounds', 'Quiz Bounds');
      const base = {
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz' as const,
        required: false,
      };

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
          ...base,
          taskKey: 'over',
          quiz: authoredQuiz({ passMark: 500 }),
        }),
      ).rejects.toThrow(/pass mark/i);

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
          ...base,
          taskKey: 'nil-attempts',
          quiz: authoredQuiz({ attempts: { max: 0, cooldownSeconds: null } }),
        }),
      ).rejects.toThrow(/attempt/i);

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
          ...base,
          taskKey: 'bad-criterion',
          quiz: authoredQuiz({ criterion: 'Not A Key' }),
        }),
      ).rejects.toThrow(/criterion/i);
    });

    it('refuses a task that is not a quiz beside the phase\'s own task, and mints nothing', async () => {
      const made = await copyOfTheDefault('quiz-only-add', 'Quiz Only Add');
      const watched = watchTheFileSteps();

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
          taskKey: 'story',
          title: 'The stories',
          brief: 'Write the stories.',
          artefactType: 'user-story',
        }),
      ).rejects.toThrow(QUIZ_ONLY_ADD_REFUSAL);

      expect(watched.insertFiles).not.toHaveBeenCalled();
      const phase = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: made.draftVersionId, key: 'requirements' as never });
      const rows = await dataSource.getRepository(ProjectTaskEntity).find({ where: { projectPhaseId: phase.id } });
      expect(rows.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
    });
  });

  /* ----------------------------- updateTask ------------------------------ */

  describe('updateTask, on the task\'s real kind', () => {
    /** A copy whose design phase holds one authored quiz beside the inherited task. */
    const withAQuiz = async (slug: string, over: Partial<AuthoredQuiz> = {}) => {
      const made = await copyOfTheDefault(slug, slug);
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'concepts',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz(over),
      });
      return made;
    };

    it('replaces the whole paper, key and settings together, and moves the rubric with it', async () => {
      const made = await withAQuiz('quiz-update');
      const watched = watchTheFileSteps();

      await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'design', 'concepts', {
        title: 'Design concepts, revised',
        quiz: {
          questions: fixtureQuizQuestions(3, 'r'),
          shuffleOptions: false,
          passMark: 100,
          criterion: 'revised-concepts',
          attempts: { max: 2, cooldownSeconds: 600 },
        },
      });


      const row = await taskRowFor(made.draftVersionId, 'design', 'concepts');
      const checks = quizOf(row.checks);
      expect(row.title).toBe('Design concepts, revised');
      expect(checks.questions.map((one) => one.id)).toEqual(['r1', 'r2', 'r3']);
      expect(checks.shuffleOptions).toBe(false);
      expect(checks.passMark).toBe(100);
      expect(checks.attempts).toEqual({ max: 2, cooldownSeconds: 600 });
      // the old `drawn` does not survive a replacement: the whole quiz is one
      // edit, so a pool of three cannot keep a draw of five's leftovers
      expect(checks.drawn).toBeUndefined();
      // and the rubric followed the criterion, which is the mismatch
      // `quiz-rubric-key-is-the-quiz's` exists to refuse
      expect(row.rubric.criteria.map((one) => one.key)).toEqual(['revised-concepts']);
      expect(row.rubric.passThreshold).toBe(100);
    });

    /**
     * The save the sealed panel makes, which is every save a teacher makes
     * from it.
     *
     * `QuizEditor.tsx` states that a sealed quiz saves nothing, and
     * `TaskEditor.tsx` therefore sends `{title, brief, artefactType,
     * objectives}` with **no** `quiz` key whenever the answer panel is shut.
     * Everything that protects the question bank on that path is the one
     * `if (body.quiz)` guard in `updateTask`: widen it, or write
     * `patch.checks = this.checkedQuiz(body.quiz ?? something)`, and renaming
     * a quiz would wipe its questions, its key and its explanations. The web
     * suite asserts the client half (that the panel sends no paper) so this
     * is the server half, and it is the half a teacher's question bank
     * actually rests on.
     */
    it('leaves the sealed paper byte-identical when the body carries no quiz', async () => {
      const made = await withAQuiz('quiz-sealed-save', {
        criterion: 'design-concepts',
        passMark: 80,
        attempts: { max: 2, cooldownSeconds: 600 },
      });
      const before = await taskRowFor(made.draftVersionId, 'design', 'concepts');
      const sealed = JSON.stringify(before.checks);
      const rubric = JSON.stringify(before.rubric);

      await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'design', 'concepts', {
        title: 'Renamed',
        brief: FIXTURE_QUIZ_NOTICE,
        objectives: ['Name what the phase is for'],
      });

      const after = await taskRowFor(made.draftVersionId, 'design', 'concepts');
      expect(after.title).toBe('Renamed');
      expect(after.objectives).toEqual(['Name what the phase is for']);
      // byte for byte, and then field by field, because the serialisation is
      // one assertion and the four things a teacher would lose are four
      expect(JSON.stringify(after.checks)).toBe(sealed);
      const checks = quizOf(after.checks);
      expect(checks.questions).toHaveLength(5);
      expect(checks.questions.map((one) => one.correct)).toEqual(
        quizOf(before.checks).questions.map((one) => one.correct),
      );
      expect(checks.questions.map((one) => one.explanation)).toEqual(
        quizOf(before.checks).questions.map((one) => one.explanation),
      );
      expect(checks.passMark).toBe(80);
      expect(checks.attempts).toEqual({ max: 2, cooldownSeconds: 600 });
      expect(checks.criterion).toBe('design-concepts');
      expect(checks.drawn).toBe(3);
      // the rubric is the quiz's, so it does not move on a save that did not
      // move the quiz
      expect(JSON.stringify(after.rubric)).toBe(rubric);

      // and the audit row says which branch ran: a save that replaced the
      // paper writes `questions` and `criterion` into its detail, and this one
      // names only what it moved
      const saves = (await rowsOf(made.project.id, 'project.tasks'))
        .map((row) => row.detail as Record<string, unknown>)
        .filter((detail) => detail.taskKey === 'concepts');
      const rename = saves.find((detail) => detail.title === 'Renamed');
      expect(rename).toBeDefined();
      expect(rename).not.toHaveProperty('questions');
      expect(rename).not.toHaveProperty('criterion');
    });

    it('refuses a paper on a story task, and a type that leaves the kind behind', async () => {
      const made = await withAQuiz('quiz-update-refusals');

      // the copy's own Requirements story task
      await expect(
        service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', INHERITED_TASK_KEY, {
          quiz: authoredQuiz(),
        }),
      ).rejects.toThrow(/quiz/i);

      // a quiz cannot become a record and a record cannot become a quiz: the
      // kind that scores a task is not a field an edit carries
      await expect(
        service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'design', 'concepts', {
          artefactType: 'design-doc',
        }),
      ).rejects.toThrow();
      await expect(
        service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', INHERITED_TASK_KEY, {
          artefactType: 'quiz',
        }),
      ).rejects.toThrow();
    });
  });

  /* ------------------------------ the key -------------------------------- */

  describe('the one door that carries the key', () => {
    const withAQuiz = async (slug: string, caller = TEACHER) => {
      const made = await copyOfTheDefault(slug, slug, caller);
      await service.addTask(caller, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'concepts',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ criterion: 'design-concepts', passMark: 80 }),
      });
      return made;
    };

    it('answers the owner with the key and the explanations, and leaves one audit row', async () => {
      const made = await withAQuiz('quiz-key-owner');
      expect(await keyReadsOf(made.project.id)).toHaveLength(0);

      const key = await service.readQuizKey(
        TEACHER,
        made.project.id,
        made.draftVersionId,
        'design',
        'concepts',
      );

      expect(key.questions).toHaveLength(5);
      expect(key.questions[0].correct).toEqual(['a']);
      expect(key.questions[0].explanation).toContain('Fixture explanation 1');
      expect(key.passMark).toBe(80);
      expect(key.criterion).toBe('design-concepts');
      expect(key.drawn).toBe(3);

      // who looked at this key, and when: the question the door exists to
      // make answerable, in `solution.read`'s own shape
      const rows = await keyReadsOf(made.project.id);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.actorUserId).toBe(TEACHER.id);
      expect(row.subjectUserId).toBe(TEACHER.id);
      expect(row.action).toBe('design');
      expect(row.detail).toMatchObject({ phaseKey: 'design', taskKey: 'concepts', questions: 5 });
      // the row says a key was read, never what the key is
      expect(JSON.stringify(row.detail)).not.toContain('correct');
      expect(JSON.stringify(row.detail)).not.toContain('Fixture explanation');
    });

    it('refuses the two callers requireVisibleProject admits: an ADMIN who does not own it, and a platform-owned read', async () => {
      const made = await withAQuiz('quiz-key-guard');

      // an ADMIN may read every project. They may not read somebody else's
      // answer key, and the draft payload they *can* read carries none.
      await expect(
        service.readQuizKey(ADMIN, made.project.id, made.draftVersionId, 'design', 'concepts'),
      ).rejects.toThrow();
      // another teacher cannot see the project at all
      await expect(
        service.readQuizKey(
          OTHER_TEACHER,
          made.project.id,
          made.draftVersionId,
          'design',
          'concepts',
        ),
      ).rejects.toThrow();
      // and the platform's own project is readable by every instructor on the
      // deployment through `requireVisibleProject`, and by nobody here
      await expect(
        service.readQuizKey(OTHER_TEACHER, seedProjectId, seedVersionId, 'design', INHERITED_TASK_KEY),
      ).rejects.toThrow();

      // a refused read is not a read, so it leaves no row either
      expect(await keyReadsOf(made.project.id)).toHaveLength(0);
      expect(await keyReadsOf(seedProjectId)).toHaveLength(0);
    });

    /**
     * The copy carries the key, and the copy is where the trail is.
     *
     * A task's `checks` are its sealed slice and `authoredTaskFor` writes them
     * into the snapshot, so a quiz's `correct` and `explanation` travel with a
     * copy the way a code phase's hidden suites and solutions do. The source
     * of a copy is `requireVisibleProject`, so the two callers refused above
     * can copy first and read the key on the copy they then own. That is
     * copying rather than a way around the gate (the copy is theirs to re-key
     * through `updateTask`, and a key withheld from the person who may replace
     * it would leave them able to overwrite a question bank and unable to
     * revise one) and this pins the shape of it, including the one row that
     * says where the key came from and which project it is filed against.
     * Narrowing it is a later slice's decision, and this spec is what such a
     * decision has to come and change.
     */
    it('travels with a copy, and the copy is the trail that says where from', async () => {
      const mine = await withAQuiz('quiz-key-copied-source');
      const published = await service.publish(TEACHER, mine.project.id, mine.draftVersionId, {
        version: '1.0.0',
      });

      // refused in place, as above: an ADMIN reading this teacher's key
      await expect(
        service.readQuizKey(ADMIN, mine.project.id, published.versionId, 'design', 'concepts'),
      ).rejects.toThrow();

      const theirs = await service.createProject(ADMIN, {
        title: 'Quiz Key Copied',
        slug: 'quiz-key-copied',
        fromVersionId: published.versionId,
      });
      const key = await service.readQuizKey(
        ADMIN,
        theirs.project.id,
        theirs.draftVersionId,
        'design',
        'concepts',
      );
      expect(key.questions).toHaveLength(5);
      expect(key.questions[0].correct).toEqual(['a']);
      expect(key.questions[0].explanation).toContain('Fixture explanation 1');

      // the read is audited against the copy, and the source's own trail gains
      // no key row from it
      expect(await keyReadsOf(theirs.project.id)).toHaveLength(1);
      expect(await keyReadsOf(mine.project.id)).toHaveLength(0);

      // what does say it happened is the copy's own creation row: this account
      // made a copy of that version, which is the sentence a reader chasing a
      // key follows
      const creations = await rowsOf(theirs.project.id, 'project.create');
      expect(creations).toHaveLength(1);
      expect(creations[0].actorUserId).toBe(ADMIN.id);
      expect(creations[0].detail).toMatchObject({
        copiedFrom: {
          projectSlug: 'quiz-key-copied-source',
          version: '1.0.0',
          versionId: published.versionId,
        },
      });
    });

    it('answers 404 for a task that is not a quiz and for one that is not there', async () => {
      const made = await withAQuiz('quiz-key-missing');

      await expect(
        service.readQuizKey(
          TEACHER,
          made.project.id,
          made.draftVersionId,
          'design',
          INHERITED_TASK_KEY,
        ),
      ).rejects.toThrow(/quiz/i);
      await expect(
        service.readQuizKey(TEACHER, made.project.id, made.draftVersionId, 'design', 'nobody'),
      ).rejects.toThrow(/no task/i);
    });

    it('is the only door that carries it: the draft and the task list carry neither field', async () => {
      const made = await withAQuiz('quiz-key-sealed');

      const drafted = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      const listed = await service.listTasks(TEACHER, made.project.id, made.draftVersionId, 'design');

      for (const payload of [drafted, listed]) {
        const wire = JSON.stringify(payload);
        // The fixture's explanations are a string nothing else in the pack
        // says, so this is one substring assertion over the **whole**
        // serialised response rather than a walk of its fields.
        expect(wire).not.toContain('Fixture explanation');
      }
      // `correct` is asked of the quiz the payload carries rather than of the
      // whole response, because the shipped pack's own prose uses the word,
      // which is exactly why `AuthoredQuizViewQuestion` names its count
      // `answerCount`: the field names are the part a spec can hold.
      for (const quiz of [
        drafted.phases.flatMap((one) => one.tasks).find((one) => one.taskKey === 'concepts')?.quiz,
        listed.tasks.find((one) => one.taskKey === 'concepts')?.quiz,
      ]) {
        expect(quiz).toBeDefined();
        expect(JSON.stringify(quiz)).not.toContain('correct');
        expect(JSON.stringify(quiz)).not.toContain('explanation');
      }

      // and what it does carry is the view: stems, options and a count
      const view = listed.tasks.find((one) => one.taskKey === 'concepts');
      expect(view?.quiz?.questions).toHaveLength(5);
      expect(view?.quiz?.questions[0].answerCount).toBe(1);
      expect(view?.quiz?.questions[0].options.map((one) => one.id)).toEqual(['a', 'b']);
      expect(view?.quiz?.passMark).toBe(80);
      expect(view && 'rules' in view).toBe(false);
      expect(view?.authorable).toBe(true);
    });
  });

  /* ------------------------- what the fork writes ------------------------- */

  /**
   * The row the quiz fork writes is the row the compiler reads.
   *
   * Every refusal in `addTask` is about a body; these are about the **snapshot**
   * the body turns into, and they are the reason the derivations above are
   * derivations rather than fields on a DTO. `quiz-owns-no-file` and
   * `quiz-rubric-key-is-the-quiz's` are the two rules a hand-written quiz row
   * can fail, and a route that derived either of them wrongly would be found
   * here rather than by a teacher at publish.
   */
  describe('the row the fork writes, held against the compiler', () => {
    it('publishes an optional quiz beside the phase\'s own task, on a written phase', async () => {
      const made = await copyOfTheDefault('quiz-publishes', 'Quiz Publishes');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'concepts',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ criterion: 'design-concepts' }),
      });

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      expect(report.blocking).toEqual([]);
      expect(report.publishable).toBe(true);

      const published = await service.publish(TEACHER, made.project.id, made.draftVersionId, {
        version: '1.0.0',
      });
      expect(published.version).toBe('1.0.0');

      // and the compiled task carries one graded unit per question in the
      // POOL, its own slice, and no path
      const snapshot = published.validation;
      expect(snapshot.failed).toBe(0);
      const row = await taskRowFor(made.draftVersionId, 'design', 'concepts');
      expect(quizOf(row.checks).questions).toHaveLength(5);
      expect(row.artefactPath).toBeNull();
    });

    /**
     * The all-six-phases rule, reached through the door a teacher actually
     * uses.
     *
     * The editor's gate counts **non-quiz** tasks and a quiz has four
     * fast-tier rows of its own, and `draftPhaseView` reads the first of
     * those from the task views it is handed. The validation report is built
     * from a second projection of the same rows (`report()`) and if that
     * projection carried neither the task's kind nor its quiz, the row the
     * teacher reads would count every task against a kind-only budget and the
     * four quiz rows would never appear at all. The editor would say *ships*
     * and the report *cannot*, which breaks the one property that tier exists
     * to keep.
     */
    it('publishes a quiz beside the one executable task of an executable phase', async () => {
      const made = await copyOfTheDefault('quiz-executable', 'Quiz Executable');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'deployment', {
        taskKey: 'ops-concepts',
        title: 'Deployment concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz(),
      });

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      const gate = report.checks.filter(
        (one) => one.id === 'phase-holds-one-task' && one.phaseKey === 'deployment',
      );
      expect(gate.map((one) => one.status)).toEqual(['passed']);
      expect(report.blocking).toEqual([]);
      expect(report.publishable).toBe(true);

      // and the quiz's own four rows are in the report the teacher reads,
      // rather than in a tier nothing calls
      const quizRows = report.checks.filter((one) => one.id.startsWith('quiz-'));
      expect(quizRows.map((one) => one.id).sort()).toEqual([
        'quiz-draw-fits-pool',
        'quiz-pass-mark-reachable',
        'quiz-questions-well-formed',
        'quiz-retake-is-a-new-paper',
      ]);
      for (const one of quizRows) {
        expect(one.taskKey).toBe('ops-concepts');
        expect(one.status).not.toBe('failed');
      }

      // the editor's banner and the report agree, which is the property
      const draft = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      expect(draft.phases.find((one) => one.key === 'deployment')?.blocksPublish).toBe(false);

      await expect(
        service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' }),
      ).resolves.toMatchObject({ version: '1.0.0' });
    });

    it('still refuses two tasks of the phase\'s own kind, in the wall\'s own sentence', async () => {
      const made = await copyOfTheDefault('quiz-wall', 'Quiz Wall');
      // a second *executable* task is what the wall is about, and adding a
      // quiz beside it must not have bought it a way through
      const phase = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: made.draftVersionId, key: 'deployment' as never });
      const inherited = await dataSource
        .getRepository(ProjectTaskEntity)
        .findOneByOrFail({ projectPhaseId: phase.id, taskKey: INHERITED_TASK_KEY });
      const repo = dataSource.getRepository(ProjectTaskEntity);
      await repo.save(
        repo.create({
          ...inherited,
          id: undefined,
          taskKey: 'second-config',
          order: 2,
          title: 'A second deployment task',
        }),
      );

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      expect(report.publishable).toBe(false);
      expect(report.blocking.join(' ')).toMatch(/Deployment/);
    });

    it('refuses a required quiz beside an optional artefact task, by name and by phase', async () => {
      const made = await copyOfTheDefault('quiz-gate', 'Quiz Gate');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'concepts',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: true,
        quiz: authoredQuiz(),
      });
      // the shape the quiz rules refuse: a phase opened by multiple-choice alone
      await service.setTaskRequired(
        TEACHER,
        made.project.id,
        made.draftVersionId,
        'design',
        INHERITED_TASK_KEY,
        { required: false },
      );

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      expect(report.publishable).toBe(false);
      expect(report.blocking.join(' ')).toMatch(/design/);
      expect(report.blocking.join(' ')).toMatch(/multiple-choice/i);
    });
  });

  /* --------------------------- the door, mounted -------------------------- */

  describe('the controller', () => {
    it('mounts the key route as a GET, under the class\'s staff roles', () => {
      const prototype = AuthoringController.prototype as unknown as Record<string, unknown>;
      const handler = prototype.quizKey;

      expect(handler).toBeDefined();
      expect(Reflect.getMetadata(PATH_METADATA, handler as object)).toBe(
        'projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/quiz/key',
      );
      // Nest numbers GET first in `RequestMethod`
      expect(Reflect.getMetadata(METHOD_METADATA, handler as object)).toBe(0);
    });
  });

  /* ----------------------------- the outer wall --------------------------- */

  describe('the body a quiz arrives in', () => {
    const body = (correct: string[]): unknown => ({
      questions: [
        {
          id: 'q-one',
          stem: 'Fixture question one.',
          options: [
            { id: 'a', text: 'Fixture option A.' },
            { id: 'b', text: 'Fixture option B.' },
          ],
          correct,
          explanation: 'Fixture explanation one.',
        },
      ],
      drawn: 1,
    });

    const errorsOn = async (correct: string[]): Promise<string[]> => {
      const dto = plainToInstance(AuthoredQuizDto, body(correct));
      const failures = await validate(dto as object, { whitelist: true });
      return failures
        .flatMap((one) => one.children ?? [])
        .flatMap((one) => one.children ?? [])
        .map((one) => one.property);
    };

    it('refuses a key that names one option twice, at the wall as well as in the report', async () => {
      // Two halves of one fact, because a teacher can reach the service
      // without the editor. `@ArrayUnique()` is the wall: a body whose key
      // repeats an option never becomes a compiled slice at all. The fast
      // tier's sentence beside it is what a teacher can act on, and
      // `validation.spec.ts` holds that one.
      expect(await errorsOn(['a'])).toEqual([]);
      expect(await errorsOn(['a', 'a'])).toEqual(['correct']);
    });
  });

  /* ------------------------- the practice-quiz reveal ------------------------- */

  /**
   * **When an optional quiz releases its explanations.**
   *
   * `revealExplanation` is the teacher's choice on an **optional** quiz only
   * (a required quiz keeps the fixed quiz policy). Three joins, each of which fails quietly:
   * the DTO line (the global pipe strips an undeclared property, so without it
   * the choice never reaches the service), the fork that writes it into the
   * row's `QuizChecks`, and the view the editor reads it back from. A required
   * quiz is refused by name (`quiz-reveal-optional-only`); absent keeps the default.
   */
  describe('the reveal a teacher chooses for an optional quiz', () => {
    const quizBody = (over: Record<string, unknown> = {}): unknown => ({
      questions: [
        {
          id: 'q-one',
          stem: 'Fixture question one.',
          options: [
            { id: 'a', text: 'Fixture option A.' },
            { id: 'b', text: 'Fixture option B.' },
          ],
          correct: ['a'],
          explanation: 'Fixture explanation one.',
        },
      ],
      drawn: 1,
      ...over,
    });

    it('keeps the field through the whitelisting DTO, and refuses a value that is neither rule', async () => {
      const kept = plainToInstance(AuthoredQuizDto, quizBody({ revealExplanation: 'always' }));
      expect(await validate(kept as object, { whitelist: true })).toEqual([]);
      expect((kept as { revealExplanation?: string }).revealExplanation).toBe('always');

      const onPass = plainToInstance(AuthoredQuizDto, quizBody({ revealExplanation: 'on-pass' }));
      expect(await validate(onPass as object, { whitelist: true })).toEqual([]);
      expect((onPass as { revealExplanation?: string }).revealExplanation).toBe('on-pass');

      const wrong = plainToInstance(AuthoredQuizDto, quizBody({ revealExplanation: 'never' }));
      const failures = await validate(wrong as object, { whitelist: true });
      expect(failures.map((one) => one.property)).toEqual(['revealExplanation']);

      // absent stays absent: no default is invented on the way in
      const absent = plainToInstance(AuthoredQuizDto, quizBody());
      expect(await validate(absent as object, { whitelist: true })).toEqual([]);
      expect('revealExplanation' in (absent as object)).toBe(false);
    });

    it('writes the choice on an optional quiz, and the draft, the task list and the key route echo it', async () => {
      const made = await copyOfTheDefault('quiz-reveal', 'Quiz Reveal');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'practice',
        title: 'A practice check',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ attempts: { max: 2, cooldownSeconds: null }, revealExplanation: 'always' }),
      });
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'plain',
        title: 'A plain check',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz(),
      });

      expect(quizOf((await taskRowFor(made.draftVersionId, 'design', 'practice')).checks).revealExplanation).toBe(
        'always',
      );
      // absent keeps the default rule and the default row: the key is not written at all
      expect('revealExplanation' in quizOf((await taskRowFor(made.draftVersionId, 'design', 'plain')).checks)).toBe(
        false,
      );

      const drafted = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      const listed = await service.listTasks(TEACHER, made.project.id, made.draftVersionId, 'design');
      const draftTask = (key: string) =>
        drafted.phases.flatMap((one) => one.tasks).find((one) => one.taskKey === key);
      expect(draftTask('practice')?.quiz?.revealExplanation).toBe('always');
      expect(listed.tasks.find((one) => one.taskKey === 'practice')?.quiz?.revealExplanation).toBe('always');
      expect('revealExplanation' in (draftTask('plain')?.quiz ?? {})).toBe(false);

      const key = await service.readQuizKey(TEACHER, made.project.id, made.draftVersionId, 'design', 'practice');
      expect(key.revealExplanation).toBe('always');
      const plainKey = await service.readQuizKey(TEACHER, made.project.id, made.draftVersionId, 'design', 'plain');
      expect('revealExplanation' in plainKey).toBe(false);

      // an edit that sends the whole paper again moves the choice with it
      await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'design', 'practice', {
        quiz: authoredQuiz({ attempts: { max: 2, cooldownSeconds: null }, revealExplanation: 'on-pass' }),
      });
      expect(quizOf((await taskRowFor(made.draftVersionId, 'design', 'practice')).checks).revealExplanation).toBe(
        'on-pass',
      );
      await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'design', 'practice', {
        quiz: authoredQuiz({ attempts: { max: 2, cooldownSeconds: null } }),
      });
      expect(
        'revealExplanation' in quizOf((await taskRowFor(made.draftVersionId, 'design', 'practice')).checks),
      ).toBe(false);
    });

    it('refuses the choice on a required quiz, by name, and writes nothing', async () => {
      const made = await copyOfTheDefault('quiz-reveal-required', 'Quiz Reveal Required');
      const before = await dataSource
        .getRepository(ProjectTaskEntity)
        .count({ where: { projectPhaseId: (await taskRowFor(made.draftVersionId, 'design', INHERITED_TASK_KEY)).projectPhaseId } });

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
          taskKey: 'gated',
          title: 'A gate',
          brief: FIXTURE_QUIZ_NOTICE,
          artefactType: 'quiz',
          required: true,
          quiz: authoredQuiz({ revealExplanation: 'always' }),
        }),
      ).rejects.toThrow(/A gate is required, and only an optional quiz chooses when its explanations are shown/);
      expect(
        await dataSource
          .getRepository(ProjectTaskEntity)
          .count({ where: { projectPhaseId: (await taskRowFor(made.draftVersionId, 'design', INHERITED_TASK_KEY)).projectPhaseId } }),
      ).toBe(before);

      // and an edit of a required quiz's paper is refused the same way
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'gated',
        title: 'A gate',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: true,
        quiz: authoredQuiz(),
      });
      await expect(
        service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'design', 'gated', {
          quiz: authoredQuiz({ revealExplanation: 'on-pass' }),
        }),
      ).rejects.toThrow(/only an optional quiz chooses/);
      expect('revealExplanation' in quizOf((await taskRowFor(made.draftVersionId, 'design', 'gated')).checks)).toBe(
        false,
      );

      // a service caller that skips the DTO cannot write a third rule either
      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
          taskKey: 'odd',
          title: 'An odd check',
          brief: FIXTURE_QUIZ_NOTICE,
          artefactType: 'quiz',
          required: false,
          quiz: authoredQuiz({ revealExplanation: 'never' as never }),
        }),
      ).rejects.toThrow(/after a pass or when the attempts run out, or after every attempt/);
    });

    it('holds a quiz made required after the choice to the publish gate, in the same sentence', async () => {
      const made = await copyOfTheDefault('quiz-reveal-toggle', 'Quiz Reveal Toggle');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'design', {
        taskKey: 'practice',
        title: 'A practice check',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: authoredQuiz({ attempts: { max: 3, cooldownSeconds: null }, revealExplanation: 'always' }),
      });
      await service.setTaskRequired(TEACHER, made.project.id, made.draftVersionId, 'design', 'practice', {
        required: true,
      });

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      const rows = report.checks.filter((one) => one.id === 'quiz-reveal-optional-only');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].taskKey).toBe('practice');
      expect(rows[0].sentence).toMatch(/A practice check is required, and only an optional quiz chooses/);
      expect(report.publishable).toBe(false);
    });
  });
});
