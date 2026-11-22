import { INestApplication } from '@nestjs/common';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from './quiz-fixture';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import {
  AUTHORING_ROUTES,
  AUTHORING_ROUTE_KEYS,
  ASSIGNMENT_REASON_MIN,
  DRAFT_FIRST_VERSION,
  EXECUTABLE_SPLIT_NOT_READY,
  INHERITED_TASK_KEY,
  MULTI_TASK_CHECK_ID,
  QUIZ_ONLY_ADD_REFUSAL,
  draftAlreadyOpenRefusal,
  draftFromStaleHeadRefusal,
  multiTaskPublishRefusal,
  platformProjectCopyOnlyRefusal,
  publishableTasksPerPhase,
  plainTextOf,
  refusesMultiTaskPublish,
} from '@learnsdlc/shared';
import type {
  AssignableVersionView,
  AuthoringLibraryView,
  AuthoringRouteKey,
  CohortProjectView,
  CreateProjectResult,
  DraftVersionView,
  PublishVersionResult,
  TaskMutationResult,
  ValidationReport,
} from '@learnsdlc/shared';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectPhaseEntity, ProjectTaskEntity } from '../src/content/project.entities';
import {
  AuditEventEntity,
  CohortPhaseScheduleEntity,
  EnrollmentEntity,
  NotificationEntity,
  ProjectEntity,
  ProjectVersionEntity,
  UserEntity,
} from '../src/db/entities';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NOT_YOUR_PROJECT, WorkflowService } from '../src/workflow/workflow.service';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The teacher half of teacher-authored projects, over HTTP, on the wired app.
 *
 * **This file is the connection proof and not a second unit suite.**
 * The unit specs build their service by hand: the authoring specs construct
 * `AuthoringService` with a `DataSource`, the class specs construct
 * `CohortProjectService`, and the web specs mock the client. All of them stay
 * green with `app.module.ts` untouched, which is to say all of them stay green
 * even if the whole feature is dead code nobody can reach. What is asserted here is the
 * part none of them can: that the controllers are *mounted*, that the paths the
 * web client builds out of `AUTHORING_ROUTES` are the paths Nest actually
 * answers on, that the guard chain refuses a learner at the door rather than in
 * a page, and that what a teacher writes reaches the learner the class was
 * assigned to and reaches nobody else.
 *
 * So the walk below is one story, in order, and each step is a link that can be
 * cut: remove `AuthoringController` from `app.module.ts` and step 2 is a 404;
 * remove `CohortProjectController` and step 7 is; remove the `taskPanel`
 * overlay in `AuthoringService.compile` and step 9 reads TaskTrackr's words
 * where the teacher's should be.
 *
 * **The safety gate is asserted as a pair, not as a flag.** A draft holding two
 * tasks in one phase is kept whole, validate names exactly why publish would
 * refuse, and publish refuses with the *same sentence*: one string, from
 * `multiTaskPublishRefusal`, compared against both.
 *
 * A second task in a **written** phase publishes and reaches a learner; a
 * second task in a phase graded by the code, test or deployment grader is
 * refused, and the refusal carries `EXECUTABLE_SPLIT_NOT_READY`. Both halves
 * are asserted below, in that order, because a suite that only ever proved the
 * gate shut would read green against a build that had never opened it.
 */
describe('teacher-authored projects, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';

  /** The teacher who authors, the class they own, and two learners. */
  let teacherToken = '';
  let teacherId = '';
  let learnerToken = '';
  let learnerId = '';
  let strangerToken = '';
  let strangerId = '';
  let cohortId = '';
  let joinCode = '';

  /** What the walk accumulates. */
  let defaultSlug = '';
  let defaultProjectId = '';
  let defaultVersionId = '';
  let projectId = '';
  let draftVersionId = '';
  let ownSlug = '';
  let publishedVersionId = '';
  /** The next draft, opened off 1.0.0, and the version it publishes as. */
  let nextDraftVersionId = '';
  let nextPublishedVersionId = '';
  let lateLearnerId = '';
  let inheritedBrief = '';
  let implementationTitle = '';

  const OWN_TITLE = 'Neighbourhood Repair Log';
  const EDITED_BRIEF =
    '## Your stories\n\nWrite the repair log as user stories. Every story names the neighbour who asks for it.';
  /** The rewrite meant for next term's class, published while this term's runs. */
  const NEXT_TERM_BRIEF =
    '## Your stories\n\nRewritten for next term: every story names the neighbour and the street.';
  /** What the editor's door stores of each brief, and what a learner reads: plain text (docs/authoring-format.md, "Plain text"), every word kept. */
  const EDITED_STORED = plainTextOf(EDITED_BRIEF);
  const NEXT_TERM_STORED = plainTextOf(NEXT_TERM_BRIEF);

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' | 'ADMIN' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@teacher-projects.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      // The role is resolved from the users row at request time, but the
      // session is cached: without this the next call still carries LEARNER.
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  beforeAll(async () => {
    // The real pipeline, not a hand-rolled one: the global prefix, the
    // ValidationPipe the DTOs are written against and the guards, exactly as
    // `bootstrap` assembles them, because half of what this file asserts is
    // about that assembly.
    ({ app, http } = await bootApi());
    db = app.get(DataSource);

    const teacher = await account('nadia', 'INSTRUCTOR');
    teacherToken = teacher.token;
    teacherId = teacher.id;

    const made = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(bearer(teacherToken))
      .send({ name: 'Tuesday 9am' })
      .expect(201);
    cohortId = made.body.id;
    joinCode = made.body.joinCode;

    const learner = await account('ade');
    learnerToken = learner.token;
    learnerId = learner.id;

    const stranger = await account('bo');
    strangerToken = stranger.token;
    strangerId = stranger.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  /* ----------------------------- 1. the library ---------------------------- */

  it('mounts the authoring routes and lists the platform project as copy-only', async () => {
    const seen = await request(http)
      .get('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .expect(200);
    const library = seen.body as AuthoringLibraryView;

    // A 200 here is already the registration proof: unmounted, this is Nest's
    // own 404 and every step below never runs.
    expect(Array.isArray(library.mine)).toBe(true);
    expect(library.mine).toHaveLength(0);

    const platform = library.library.find((one) => one.isDefault);
    expect(platform).toBeDefined();
    expect(platform!.platformOwned).toBe(true);
    // Copy-only: the platform's project is assignable and copyable, never
    // editable in place, so the row a teacher reads must
    // already say it is not theirs.
    expect(platform!.mine).toBe(false);
    expect(platform!.publishedVersionId).toBeTruthy();

    defaultSlug = platform!.slug;
    defaultProjectId = platform!.id;
    defaultVersionId = platform!.publishedVersionId as string;

    // The same project the learner half resolves as the deployment default.
    const flagged = await db.getRepository(ProjectEntity).find({ where: { isDefault: true } });
    expect(flagged.map((one) => one.slug)).toEqual([defaultSlug]);
  });

  it('answers on every path the route table declares, for every route it holds', async () => {
    // What the web clients build their calls from is `AUTHORING_ROUTES`
    // (`api-projects.ts`'s `authoringPath`, `api-instructor.ts`'s
    // `authoringRequest`). A path in that table that no controller mounts is a
    // 404 a teacher meets in a demo rather than a red build here, so every key
    // is driven at its own method, with ids that resolve to nothing, and the
    // answer must be the handler's rather than the router's.
    const filled = (key: AuthoringRouteKey) =>
      AUTHORING_ROUTES[key].path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, name: string) =>
        name === 'phaseKey' ? 'requirements' : '00000000-0000-4000-8000-000000000000',
      );

    for (const key of AUTHORING_ROUTE_KEYS) {
      const route = AUTHORING_ROUTES[key];
      const path = `/api/v1${filled(key)}`;
      const send = (request(http) as any)[route.method.toLowerCase()](path).set(bearer(teacherToken));
      const answer = await (route.mutates ? send.send({}) : send);

      // The unmatched-route answer is "Cannot <METHOD> <path>"; a mounted
      // handler that cannot find the row says something about the row. The
      // status is deliberately not asserted: these ids exist nowhere, and what
      // is being proved is that a handler ran at all.
      //
      // It is read out of the raw text as well as the parsed body, and that is
      // the whole net: an unmounted path falls through Nest to Express's own
      // handler, which answers 404 as **HTML**, so `answer.body` is `{}` and a
      // `body.message` alone is the empty string for every route that is not
      // there. Reading the body only, this loop would pass with a route
      // renamed out of the controller: it could not fail for any key.
      const message = String(answer.body?.message ?? '') || String(answer.text ?? '');
      expect(`${key}: ${message}`).not.toMatch(/Cannot (GET|POST|PUT|PATCH|DELETE)/);
    }
  });

  /* ------------------------------ 2. the copy ------------------------------ */

  it('creates a project by copying the default into a draft', async () => {
    ownSlug = `repair-log-${stamp}`;
    const made = await request(http)
      .post('/api/v1/instructor/projects')
      .set(bearer(teacherToken))
      .send({ title: OWN_TITLE, slug: ownSlug, fromVersionId: defaultVersionId })
      .expect(201);
    const created = made.body as CreateProjectResult;

    expect(created.draftVersion).toBe(DRAFT_FIRST_VERSION);
    expect(created.project.mine).toBe(true);
    expect(created.project.platformOwned).toBe(false);
    expect(created.project.origin).toBe('fork');
    projectId = created.project.id;
    draftVersionId = created.draftVersionId;

    const read = await request(http)
      .get(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}`)
      .set(bearer(teacherToken))
      .expect(200);
    const draft = read.body as DraftVersionView;
    expect(draft.editable).toBe(true);
    expect(draft.status).toBe('draft');

    const requirements = draft.phases.find((one) => one.key === 'requirements');
    expect(requirements).toBeDefined();
    const implementation = draft.phases.find((one) => one.key === 'implementation');
    expect(implementation).toBeDefined();
    implementationTitle = implementation!.title;
    // What actually grades each phase, which is what the publish gate asks,
    // not the phase row's own kind, which is only what a new task pre-fills.
    expect(requirements!.checkKind).toBe('story');
    expect(draft.phases.find((one) => one.key === 'design')!.checkKind).toBe('design');
    expect(implementation!.checkKind).toBe('code');

    // Every phase of a copy opens on exactly the one task it inherited, keyed
    // `main`, so nothing is over the gate before the teacher has typed.
    for (const phase of draft.phases) {
      expect(phase.tasks).toHaveLength(1);
      expect(phase.tasks[0].taskKey).toBe(INHERITED_TASK_KEY);
      expect(phase.blocksPublish).toBe(false);
    }
    inheritedBrief = requirements!.tasks[0].brief;
    expect(inheritedBrief.length).toBeGreaterThan(0);

    // The copy references the source's sealed blobs and may never read them.
    const files = await request(http)
      .get(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/files`)
      .set(bearer(teacherToken))
      .expect(200);
    const sealed = files.body.filter((one: any) => one.sealed);
    expect(sealed.length).toBeGreaterThan(0);
    for (const row of sealed) {
      expect(row.content).toBeNull();
      expect(row.size).toBeGreaterThan(0);
    }
  });

  /* --------------------------- 3. the safety gate -------------------------- */

  it('keeps a second task in the draft and names exactly why publish would refuse it', async () => {
    // The shape publish refuses is a second graded task in a phase whose work
    // is EXECUTED, and the pair asserted here is: the draft keeps both,
    // validate names exactly why, and the door refuses with the same string
    // the report printed. The task door adds only a concept quiz beside a
    // phase's own work, so the second task is written into the draft by hand,
    // as an older draft could hold one.
    const doorRefused = await request(http)
      .post(
        `/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/phases/implementation/tasks`,
      )
      .set(bearer(teacherToken))
      .send({ taskKey: 'charter', title: 'Team charter', brief: 'Name who owns which story.', artefactType: 'document', required: true })
      .expect(400);
    expect(String(doorRefused.body.message)).toBe(QUIZ_ONLY_ADD_REFUSAL);
    const implementation = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: draftVersionId, key: 'implementation' });
    const taskRows = db.getRepository(ProjectTaskEntity);
    const own = await taskRows.findOneByOrFail({ projectPhaseId: implementation.id, taskKey: INHERITED_TASK_KEY });
    await taskRows.save(taskRows.create({ ...own, id: undefined, taskKey: 'charter', order: 2, title: 'Team charter' }));
    const draft = (
      await request(http)
        .get(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}`)
        .set(bearer(teacherToken))
        .expect(200)
    ).body as DraftVersionView;
    const result = { phase: draft.phases.find((one) => one.key === 'implementation')! };

    // The draft keeps both. The gate is on publishing, not on drafting.
    expect(result.phase.tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, 'charter']);
    expect(result.phase.blocksPublish).toBe(true);

    // The kind is what decides the sentence, and the sentence carries the one
    // constant that says an executable phase is not split yet.
    const sentence = multiTaskPublishRefusal(implementationTitle, 2, 'code');
    expect(sentence).toContain(EXECUTABLE_SPLIT_NOT_READY);

    const checked = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/validate`)
      .set(bearer(teacherToken))
      .expect(200);
    const report = checked.body as ValidationReport;
    expect(report.publishable).toBe(false);
    expect(report.blocking).toContain(sentence);

    const row = report.checks.find((one) => one.id === MULTI_TASK_CHECK_ID && one.status === 'failed');
    expect(row).toBeDefined();
    expect(row!.phaseKey).toBe('implementation');
    expect(row!.sentence).toBe(sentence);

    // And the door refuses with the same string the report printed. A teacher
    // who reads one wording while drafting and another at the door learns the
    // editor is a guess.
    const refused = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/publish`)
      .set(bearer(teacherToken))
      .send({ version: '1.0.0' })
      .expect(400);
    expect(String(refused.body.message)).toContain(sentence);

    // Nothing was published, so nothing reached a learner. A caller that says
    // nothing about what grades the phase still gets the narrow answer.
    expect(publishableTasksPerPhase()).toBe(1);
    expect(app.get(ContentService).listProjects().some((one) => one.slug === ownSlug)).toBe(false);
  });

  it('lets a second task stand in a written phase, which is what block 3a built', async () => {
    // The other half of the wall, over HTTP: the same act in Design is not
    // refused at all. Since TaskTrackr 4.0.0 Design is a design phase, beside
    // whose one design task only a concept quiz may sit (as beside the
    // Requirements story), so the second task is that quiz. Without this the
    // suite would only ever prove the gate shut.
    const added = await request(http)
      .post(
        `/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/phases/design/tasks`,
      )
      .set(bearer(teacherToken))
      .send({
        taskKey: 'scope',
        title: 'Design concepts',
        brief: FIXTURE_QUIZ_NOTICE,
        artefactType: 'quiz',
        required: false,
        quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
      })
      .expect(201);
    const result = added.body as TaskMutationResult;
    expect(result.phase.tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, 'scope']);
    // Not a refusal, and the editor says so beside the phase rather than only
    // in the report: the same field the executable phase above sets true.
    expect(result.phase.blocksPublish).toBe(false);
    // and a quiz is not counted: two graded tasks are refused on every kind
    expect(refusesMultiTaskPublish(2, 'design')).toBe(true);

    // The only thing still blocking the publish is the executable phase, and
    // the report names that phase and not this one.
    const checked = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/validate`)
      .set(bearer(teacherToken))
      .expect(200);
    const report = checked.body as ValidationReport;
    const gates = report.checks.filter(
      (one) => one.id === MULTI_TASK_CHECK_ID && one.status === 'failed',
    );
    expect(gates.map((one) => one.phaseKey)).toEqual(['implementation']);

    // and it is taken back out, so the walk below publishes one task per
    // phase and every assertion after this one holds as written.
    await request(http)
      .delete(
        `/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/phases/design/tasks/scope`,
      )
      .set(bearer(teacherToken))
      .expect(200);
  });

  /* --------------------------- 4. the teacher's edit ----------------------- */

  it('publishes 1.0.0 once the phase holds one task, carrying the teacher’s own brief', async () => {
    // the second graded task written by hand above leaves the same way (no door removes a task it cannot edit)
    const implementation = await db.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: draftVersionId, key: 'implementation' });
    await db.getRepository(ProjectTaskEntity).delete({ projectPhaseId: implementation.id, taskKey: 'charter' });

    const edited = await request(http)
      .patch(
        `/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/phases/requirements/tasks/${INHERITED_TASK_KEY}`,
      )
      .set(bearer(teacherToken))
      .send({ brief: EDITED_BRIEF })
      .expect(200);
    const after = edited.body as TaskMutationResult;
    expect(after.phase.tasks).toHaveLength(1);
    expect(after.phase.tasks[0].brief).toBe(EDITED_STORED);
    expect(after.phase.blocksPublish).toBe(false);
    expect(after.validation.publishable).toBe(true);
    expect(after.validation.blocking).toEqual([]);

    const done = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}/publish`)
      .set(bearer(teacherToken))
      .send({ version: '1.0.0', notes: 'First run with my own stories.' })
      .expect(200);
    const published = done.body as PublishVersionResult;
    expect(published.version).toBe('1.0.0');
    expect(published.validation.publishable).toBe(true);
    publishedVersionId = published.versionId;

    // Published means servable: `publish` reloads the registry before it
    // answers, so the teacher's next click (and a learner's enrolment) can
    // find it.
    expect(app.get(ContentService).listProjects().some((one) => one.slug === ownSlug)).toBe(true);
  });

  /* ------------------------- 5. immutable, and audited --------------------- */

  it('refuses a further edit to the published version and leaves an audit row per write', async () => {
    const refused = await request(http)
      .patch(
        `/api/v1/instructor/projects/${projectId}/versions/${publishedVersionId}/phases/requirements/tasks/${INHERITED_TASK_KEY}`,
      )
      .set(bearer(teacherToken))
      .send({ brief: 'A change after the fact.' });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const rows = await db.getRepository(AuditEventEntity).find({ where: { actorUserId: teacherId } });
    const events = rows.map((one) => one.event as string);
    expect(events).toContain('project.create');
    expect(events).toContain('project.tasks');
    expect(events).toContain('project.validate');
    expect(events).toContain('project.publish');
  });

  /* ------------------------- 6. the class assignment ----------------------- */

  it('offers the published version to the class and assigns it with a reason', async () => {
    const offered = await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/project/assignable`)
      .set(bearer(teacherToken))
      .expect(200);
    const options = offered.body as AssignableVersionView[];

    const own = options.find((one) => one.versionId === publishedVersionId);
    expect(own).toBeDefined();
    expect(own!.mine).toBe(true);
    expect(own!.current).toBe(false);
    expect(own!.version).toBe('1.0.0');

    // Nothing still being written is offered. Publishing flips the draft row
    // itself rather than writing a second one (`publishedVersionId` and
    // `draftVersionId` are one id) so the question is asked of the rows: every
    // version this picker offers is a published one carrying a snapshot.
    const offeredRows = await db
      .getRepository(ProjectVersionEntity)
      .find({ where: { id: In(options.map((one) => one.versionId)) } });
    expect(offeredRows).toHaveLength(options.length);
    for (const one of offeredRows) {
      expect(one.status).toBe('published');
      expect(one.compiled).not.toBeNull();
    }

    const reason = 'Tuesday works my own repair log this term.';
    expect(reason.length).toBeGreaterThanOrEqual(ASSIGNMENT_REASON_MIN);

    const assigned = await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: publishedVersionId, reason })
      .expect(200);
    const view = assigned.body as CohortProjectView;
    expect(view.active).not.toBeNull();
    expect(view.active!.projectVersionId).toBe(publishedVersionId);
    expect(view.active!.projectSlug).toBe(ownSlug);
    expect(view.active!.version).toBe('1.0.0');
    expect(view.active!.reason).toBe(reason);
    expect(view.history[0].id).toBe(view.active!.id);

    const trail = await db.getRepository(AuditEventEntity).find({ where: { actorUserId: teacherId } });
    expect(trail.map((one) => one.event as string)).toContain('cohort.project');
  });

  /* --------------------------- 7. the learner's side ----------------------- */

  it("serves the class's learner the teacher's project, at the assigned version, with the edited brief", async () => {
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(learnerToken))
      .send({ code: joinCode })
      .expect(200);

    // Before they hold an enrolment of their own, what they resolve is the
    // class's assignment: step 2 of the default-resolution order.
    const pin = await app.get(WorkflowService).projectVersionForLearner({ id: learnerId, cohort: cohortId });
    expect(pin).toEqual({ projectSlug: ownSlug, projectVersionId: publishedVersionId });

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(learnerToken))
      .send({ projectSlug: pin!.projectSlug })
      .expect(201);
    expect(enrolled.body.projectSlug).toBe(ownSlug);

    const row = await db
      .getRepository(EnrollmentEntity)
      .findOneOrFail({ where: { userId: learnerId, projectSlug: ownSlug } });
    expect(row.projectVersionId).toBe(publishedVersionId);

    const requirements = enrolled.body.phases.find((one: any) => one.key === 'requirements');
    expect(requirements).toBeDefined();

    const detail = await request(http)
      .get(`/api/v1/phases/${requirements.id}`)
      .set(bearer(learnerToken))
      .expect(200);
    // The whole point of the teacher half: the words the teacher typed are the
    // words the learner reads. Without the `taskPanel` overlay in
    // `AuthoringService.compile` this is TaskTrackr's brief and the teacher's
    // edit reaches nobody.
    expect(detail.body.taskPanel).toBe(EDITED_STORED);
    // the learner reads the inherited brief as plain text, so it is compared as they read it
    expect(detail.body.taskPanel).not.toBe(plainTextOf(inheritedBrief));
    expect(detail.body.projectSlug).toBe(ownSlug);
  });

  it('leaves a learner in no class on the default project, unchanged', async () => {
    const pin = await app.get(WorkflowService).projectVersionForLearner({ id: strangerId, cohort: '' });
    expect(pin!.projectSlug).toBe(defaultSlug);
    expect(pin!.projectVersionId).not.toBe(publishedVersionId);

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(strangerToken))
      .send({ projectSlug: pin!.projectSlug })
      .expect(201);
    const requirements = enrolled.body.phases.find((one: any) => one.key === 'requirements');

    const detail = await request(http)
      .get(`/api/v1/phases/${requirements.id}`)
      .set(bearer(strangerToken))
      .expect(200);
    expect(detail.body.projectSlug).toBe(defaultSlug);
    // the platform's brief, as its learner reads it: plain text
    expect(detail.body.taskPanel).toBe(plainTextOf(inheritedBrief));
    expect(detail.body.taskPanel).not.toBe(EDITED_STORED);
  });

  /* ------------------------------ 8. the door ------------------------------ */

  it('refuses a learner on every authoring route, at the API', async () => {
    const filled = (key: AuthoringRouteKey) =>
      AUTHORING_ROUTES[key].path
        .replace(':projectId', projectId)
        .replace(':versionId', draftVersionId)
        .replace(':cohortId', cohortId)
        .replace(':phaseKey', 'requirements')
        .replace(':taskKey', INHERITED_TASK_KEY);

    for (const key of AUTHORING_ROUTE_KEYS) {
      const route = AUTHORING_ROUTES[key];
      const send = (request(http) as any)
        [route.method.toLowerCase()](`/api/v1${filled(key)}`)
        .set(bearer(learnerToken));
      const answer = await (route.mutates ? send.send({}) : send);
      // 403 and not 404: the refusal is the role's, decided by the global
      // RolesGuard from the users row, before any handler reads an id. A page
      // that hides a link is a decoration on top of this.
      expect(`${key}: ${answer.status}`).toBe(`${key}: 403`);
    }

    // And the ids in those paths are real, so a staff caller gets through the
    // same doors: the 403s above are about the role, not about a bad id.
    await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .expect(200);
  });

  it("refuses a second teacher the first teacher's project and class", async () => {
    const other = await account('imani', 'INSTRUCTOR');

    // 404 and not 403 by the written policy: guessing ids must tell a second
    // teacher nothing about what exists in other people's libraries.
    await request(http)
      .get(`/api/v1/instructor/projects/${projectId}/versions/${draftVersionId}`)
      .set(bearer(other.token))
      .expect(404);
    await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(other.token))
      .expect(404);

    const seen = await request(http)
      .get('/api/v1/instructor/projects')
      .set(bearer(other.token))
      .expect(200);
    const library = seen.body as AuthoringLibraryView;
    expect(library.mine).toHaveLength(0);
    expect(library.library.every((one) => one.slug !== ownSlug)).toBe(true);
  });

  /* --------------- 9. the next draft, off the published head ---------------- */

  /**
   * The door back into a project that has published.
   *
   * Publishing flips a project's one draft row, so without this door a
   * teacher's own project would be as fixed as the platform's: the term's
   * rewrite would have to be a whole new project, copied, re-slugged and
   * re-assigned. This is the door, over HTTP, and what it has to prove here is the pair no
   * unit spec can: that the route is mounted at the path the web client builds
   * out of `AUTHORING_ROUTES`, and that the version a class is already pinned to
   * does not move when the next one opens.
   */
  it('refuses a draft from anything but the head, and from anybody but the owner', async () => {
    // not the head: the caller's page is holding an id from before somebody
    // else published, and honouring it would copy older rows over newer work
    const stale = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions`)
      .set(bearer(teacherToken))
      .send({ fromVersionId: defaultVersionId });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe(draftFromStaleHeadRefusal('1.0.0'));

    // the platform's own project is copy-only, whoever asks
    const platform = await request(http)
      .post(`/api/v1/instructor/projects/${defaultProjectId}/versions`)
      .set(bearer(teacherToken))
      .send({ fromVersionId: defaultVersionId });
    expect(platform.status).toBe(403);
    const seed = await db.getRepository(ProjectEntity).findOneOrFail({ where: { id: defaultProjectId } });
    expect(platform.body.message).toBe(platformProjectCopyOnlyRefusal(seed.title));

    // and a project a second teacher cannot see answers 404, not 403
    const other = await account('rui', 'INSTRUCTOR');
    await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions`)
      .set(bearer(other.token))
      .send({ fromVersionId: publishedVersionId })
      .expect(404);

    // nothing was opened by any of the three
    const drafts = await db
      .getRepository(ProjectVersionEntity)
      .count({ where: { projectId, status: 'draft' } });
    expect(drafts).toBe(0);
  });

  it('opens the next draft from the published head, once, and leaves 1.0.0 alone', async () => {
    const head = await db
      .getRepository(ProjectVersionEntity)
      .findOneOrFail({ where: { id: publishedVersionId } });

    const opened = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions`)
      .set(bearer(teacherToken))
      .send({ fromVersionId: publishedVersionId })
      .expect(201);
    const draft = opened.body as DraftVersionView;
    nextDraftVersionId = draft.versionId;

    // the shape `version.draft` answers, so the editor routes straight in
    expect(draft.version).toBe('1.0.1');
    expect(draft.status).toBe('draft');
    expect(draft.editable).toBe(true);
    expect(draft.versionId).not.toBe(publishedVersionId);
    expect(draft.phases).toHaveLength(6);

    // it opened from what the teacher published, not from what they copied
    const requirements = draft.phases.find((one) => one.key === 'requirements')!;
    expect(requirements.tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
    expect(requirements.tasks[0].brief).toBe(EDITED_STORED);
    // compared as stored plain, as the learner's read above compares it (TaskTrackr 6.0.0's copied brief is plain
    // already, so this is the bare compare too; a copy of a markdown brief is stored as its plain form)
    expect(requirements.tasks[0].brief).not.toBe(plainTextOf(inheritedBrief));

    // one draft per project, and the second ask says which one to edit
    const again = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions`)
      .set(bearer(teacherToken))
      .send({ fromVersionId: publishedVersionId });
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(draftAlreadyOpenRefusal('1.0.1'));
    expect(
      await db.getRepository(ProjectVersionEntity).count({ where: { projectId, status: 'draft' } }),
    ).toBe(1);

    // the version this term's class is pinned to did not move
    const after = await db
      .getRepository(ProjectVersionEntity)
      .findOneOrFail({ where: { id: publishedVersionId } });
    expect(after.status).toBe('published');
    expect(after.version).toBe('1.0.0');
    expect(after.contentDigest).toBe(head.contentDigest);
    expect(after.publishedAt).toBe(head.publishedAt);
    expect(JSON.stringify(after.compiled)).toBe(JSON.stringify(head.compiled));

    // and the act is its own audit row, not a `project.update`
    const rows = await db.getRepository(AuditEventEntity).find({ where: { targetId: projectId } });
    const drafted = rows.filter((one) => (one.event as string) === 'project.draft');
    expect(drafted).toHaveLength(1);
    expect(drafted[0].actorUserId).toBe(teacherId);
  });

  /* ------------------ 10. a class held on an older version ------------------ */

  /**
   * The read path and the write path, made to agree.
   *
   * `AUTHORING_ROUTES['assignment.assign']` promises "new enrolments take it;
   * pinned ones do not move". Step 7 above is the half of that promise where
   * it costs nothing: the project has exactly one published version, so the
   * class's assignment and the project's head are the same id and a write
   * stamped from either one is right by accident.
   *
   * Here they are different ids. 1.1.0 is published while Tuesday 9am is left
   * on 1.0.0: what a teacher does when a class is mid-term and the rewrite is
   * for the next one. A learner pressing Start has to be pinned to 1.0.0 and
   * has to read 1.0.0's words. Stamping the head instead would override the
   * teacher's decision the instant anybody pressed Start, and, because the
   * resolution answers a learner's own enrolment before it ever looks at the
   * class, would go on overriding it silently for the rest of the term.
   *
   * The second version is a teacher's own act: 1.1.0 is written through the
   * draft step 9 opened and the publish route, so what the pin survives is the
   * head moving the way it actually moves in the product.
   */
  it('pins a learner starting today to the version their class is held on, not the newest', async () => {
    const rewritten = await request(http)
      .patch(
        `/api/v1/instructor/projects/${projectId}/versions/${nextDraftVersionId}/phases/requirements/tasks/${INHERITED_TASK_KEY}`,
      )
      .set(bearer(teacherToken))
      .send({ brief: NEXT_TERM_BRIEF })
      .expect(200);
    expect((rewritten.body as TaskMutationResult).phase.tasks[0].brief).toBe(NEXT_TERM_STORED);

    const released = await request(http)
      .post(`/api/v1/instructor/projects/${projectId}/versions/${nextDraftVersionId}/publish`)
      .set(bearer(teacherToken))
      .send({ version: '1.1.0', notes: 'Rewritten for next term.' })
      .expect(200);
    const newer = released.body as PublishVersionResult;
    expect(newer.version).toBe('1.1.0');
    expect(newer.versionId).toBe(nextDraftVersionId);
    nextPublishedVersionId = newer.versionId;

    // publish reloads the registry before it answers, so the head has moved
    expect(app.get(ContentService).headVersionIdFor(ownSlug)).toBe(newer.versionId);

    // Publishing moved the head. It did not move the class, and the panel the
    // teacher reads still says 1.0.0.
    const panel = await request(http)
      .get(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .expect(200);
    expect((panel.body as CohortProjectView).active!.projectVersionId).toBe(publishedVersionId);
    expect((panel.body as CohortProjectView).active!.version).toBe('1.0.0');

    const late = await account('kofi');
    lateLearnerId = late.id;
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(late.token))
      .send({ code: joinCode })
      .expect(200);

    // What they resolve before they hold a row of their own is the class's
    // assignment, exactly as in step 7.
    const pin = await app
      .get(WorkflowService)
      .projectVersionForLearner({ id: late.id, cohort: cohortId });
    expect(pin).toEqual({ projectSlug: ownSlug, projectVersionId: publishedVersionId });

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(late.token))
      .send({ projectSlug: ownSlug })
      .expect(201);

    const row = await db
      .getRepository(EnrollmentEntity)
      .findOneOrFail({ where: { userId: late.id, projectSlug: ownSlug } });
    expect(row.projectVersionId).toBe(publishedVersionId);
    expect(row.projectVersionId).not.toBe(newer.versionId);
    // The board was cut from the version the pin names, so the column that
    // records which rules graded this attempt is not a version ahead of the
    // content the learner is reading.
    expect(row.packVersion).toBe('1.0.0');

    // And the words, which is the part a learner can see.
    const requirements = enrolled.body.phases.find((one: any) => one.key === 'requirements');
    const detail = await request(http)
      .get(`/api/v1/phases/${requirements.id}`)
      .set(bearer(late.token))
      .expect(200);
    expect(detail.body.taskPanel).toBe(EDITED_STORED);
    expect(detail.body.taskPanel).not.toBe(NEXT_TERM_STORED);

    // The other half of the same sentence: the learner who started in step 7,
    // before 1.1.0 existed, was not moved by the publish either.
    const first = await db
      .getRepository(EnrollmentEntity)
      .findOneOrFail({ where: { userId: learnerId, projectSlug: ownSlug } });
    expect(first.projectVersionId).toBe(publishedVersionId);
  });

  /* ------------ 10b. the browser's own requests, naming nothing ------------ */

  /**
   * Enrolment over the wire, as the web asks.
   *
   * Every step above names the slug on `POST /enrollments`. The browser names
   * none: onboarding and the dashboard's Start send `{}` (`api.enroll()`), the
   * shell reads `GET /projects` and then `GET /enrollments/mine` with no
   * `?project`, and "Learn independently" asks `GET /enrollments/classroom` and
   * leaves the class before it enrols. So the enrolment rules are asked here of
   * exactly those requests, at the moment they can most easily disagree: 1.1.0
   * is published while the class is still held on 1.0.0, and this project's
   * slug sorts before the default's (a teacher's `library-desk` ahead of
   * `tasktrackr`), which is where slug order would pick the wrong project:
   *
   * - a learner who joins the class and names nothing starts the class's
   *   project at the class's version, not the head;
   * - a learner in no class is shown and started on the default, and is refused
   *   the teacher's project by name with nothing written;
   * - a learner an invitation put in the class who then chooses to learn
   *   independently starts the default;
   * - a learner who leaves after starting the class's project is resolved to
   *   the default and can start it, while the row they started stays pinned.
   */
  it('starts each learner on their own project when the browser names none, and refuses a foreign one', async () => {
    const mine = async (token: string) =>
      (await request(http).get('/api/v1/enrollments/mine').set(bearer(token)).expect(200)).body;
    const catalogue = async (token: string) =>
      ((await request(http).get('/api/v1/projects').set(bearer(token)).expect(200)).body as { slug: string }[]).map(
        (one) => one.slug,
      );
    const start = (token: string, body: Record<string, string> = {}) =>
      request(http).post('/api/v1/enrollments').set(bearer(token)).send(body);
    const join = (token: string) =>
      request(http).post('/api/v1/enrollments/join').set(bearer(token)).send({ code: joinCode }).expect(200);
    const leave = (token: string) =>
      request(http).post('/api/v1/enrollments/leave').set(bearer(token)).expect(200);
    const rows = (userId: string) => db.getRepository(EnrollmentEntity).find({ where: { userId } });
    const defaultHead = app.get(ContentService).headVersionIdFor(defaultSlug);

    // The teacher's slug sorts first, and the head has moved past the version
    // the class is held on.
    expect([defaultSlug, ownSlug].sort()[0]).toBe(ownSlug);
    expect(app.get(ContentService).headVersionIdFor(ownSlug)).toBe(nextPublishedVersionId);

    // 1. JOINS THE CLASS, THEN NAMES NOTHING (onboarding's class path).
    const joiner = await account('ines');
    await join(joiner.token);
    expect(await catalogue(joiner.token)).toEqual([ownSlug]);
    expect((await mine(joiner.token))?.id).toBeUndefined();
    const joined = await start(joiner.token).expect(201);
    expect(joined.body.projectSlug).toBe(ownSlug);
    const [joinedRow, ...noMore] = await rows(joiner.id);
    expect(noMore).toHaveLength(0);
    expect(joinedRow.projectSlug).toBe(ownSlug);
    expect(joinedRow.projectVersionId).toBe(publishedVersionId);
    expect(joinedRow.projectVersionId).not.toBe(nextPublishedVersionId);
    expect(joinedRow.packVersion).toBe('1.0.0');
    expect((await mine(joiner.token)).id).toBe(joined.body.id);

    // 2. NO CLASS: shown only the default, refused the teacher's by name.
    const solo = await account('jun');
    const classroom = await request(http)
      .get('/api/v1/enrollments/classroom')
      .set(bearer(solo.token))
      .expect(200);
    expect(classroom.body).toEqual({ classroom: null });
    expect(await catalogue(solo.token)).toEqual([defaultSlug]);
    // Reading the teacher's project by name is the 404 an unknown slug gets.
    const foreign = await request(http).get(`/api/v1/projects/${ownSlug}`).set(bearer(solo.token)).expect(404);
    const unknown = await request(http)
      .get('/api/v1/projects/no-such-project')
      .set(bearer(solo.token))
      .expect(404);
    expect(String(foreign.body.message).replace(ownSlug, '<slug>')).toBe(
      String(unknown.body.message).replace('no-such-project', '<slug>'),
    );
    // Starting it by name is refused in the one sentence, and writes nothing.
    const refused = await start(solo.token, { projectSlug: ownSlug }).expect(403);
    expect(refused.body.message).toBe(NOT_YOUR_PROJECT);
    expect(refused.body.message).not.toContain(ownSlug);
    expect(await rows(solo.id)).toHaveLength(0);
    // Naming nothing starts the default, at its head.
    const own = await start(solo.token).expect(201);
    expect(own.body.projectSlug).toBe(defaultSlug);
    const soloRows = await rows(solo.id);
    expect(soloRows.map((row) => [row.projectSlug, row.projectVersionId])).toEqual([[defaultSlug, defaultHead]]);
    expect((await mine(solo.token)).projectSlug).toBe(defaultSlug);

    // 3. AN INVITATION PUT THEM IN THE CLASS; THEY CHOSE TO LEARN INDEPENDENTLY.
    const invited = await account('kai');
    await join(invited.token);
    const held = await request(http)
      .get('/api/v1/enrollments/classroom')
      .set(bearer(invited.token))
      .expect(200);
    expect(held.body.classroom?.id).toBe(cohortId);
    await leave(invited.token);
    const independent = await start(invited.token).expect(201);
    expect(independent.body.projectSlug).toBe(defaultSlug);
    expect((await rows(invited.id)).map((row) => row.projectSlug)).toEqual([defaultSlug]);

    // 4. LEAVES AFTER STARTING THE CLASS'S PROJECT.
    await leave(joiner.token);
    // Their record keeps the class's project, listed after the one they are
    // given now, which is what the dashboard's Start names.
    expect(await catalogue(joiner.token)).toEqual([defaultSlug, ownSlug]);
    expect((await mine(joiner.token))?.id).toBeUndefined();
    const moved = await start(joiner.token).expect(201);
    expect(moved.body.projectSlug).toBe(defaultSlug);
    expect((await mine(joiner.token)).id).toBe(moved.body.id);
    const after = await rows(joiner.id);
    expect(after.map((row) => row.projectSlug).sort()).toEqual([defaultSlug, ownSlug].sort());
    // Pinned where they started it: leaving moved and deleted nothing.
    expect(after.find((row) => row.projectSlug === ownSlug)!.projectVersionId).toBe(publishedVersionId);

    // 5. STARTED ON THEIR OWN, THEN JOINED.
    //
    // The set-aside rule: the class's active assignment to another project
    // sets a started default or platform row aside, so the learner starts the
    // class's project at the class's version, and the row they started stays
    // whole and pinned in their record: listed, readable by name, in the
    // dossier and in their export.
    const early = await account('lin');
    const alone = await start(early.token).expect(201);
    expect(alone.body.projectSlug).toBe(defaultSlug);
    const alonePin = (await rows(early.id))[0].projectVersionId;
    expect(alonePin).toBe(defaultHead);
    await join(early.token);

    // Told once: the class's project leads, the one they started is marked.
    const listed = (await request(http).get('/api/v1/projects').set(bearer(early.token)).expect(200))
      .body as { slug: string; setAside?: boolean }[];
    expect(listed.map((one) => [one.slug, one.setAside ?? null])).toEqual([
      [ownSlug, null],
      [defaultSlug, true],
    ]);
    // Not started yet: the dashboard offers the class's project.
    expect((await mine(early.token))?.id).toBeUndefined();
    // Naming the one they started is the claim that now fails, in the one sentence.
    const setAside = await start(early.token, { projectSlug: defaultSlug }).expect(403);
    expect(setAside.body.message).toBe(NOT_YOUR_PROJECT);
    const classStart = await start(early.token, { projectSlug: ownSlug }).expect(201);
    expect(classStart.body.projectSlug).toBe(ownSlug);
    expect((await mine(early.token)).id).toBe(classStart.body.id);
    const both = await rows(early.id);
    const classRow = both.find((row) => row.projectSlug === ownSlug)!;
    const ownRow = both.find((row) => row.projectSlug === defaultSlug)!;
    expect(both).toHaveLength(2);
    // The class's VERSION, held on 1.0.0 while 1.1.0 is the head.
    expect(classRow.projectVersionId).toBe(publishedVersionId);
    expect(classRow.projectVersionId).not.toBe(nextPublishedVersionId);
    expect(ownRow.id).toBe(alone.body.id);
    expect(ownRow.projectVersionId).toBe(alonePin);

    // Their record keeps it: the board and the records by name.
    const kept = await request(http)
      .get(`/api/v1/enrollments/mine?project=${defaultSlug}`)
      .set(bearer(early.token))
      .expect(200);
    expect(kept.body.id).toBe(alone.body.id);
    const keptPhases = await request(http)
      .get(`/api/v1/phases/summaries?project=${defaultSlug}`)
      .set(bearer(early.token))
      .expect(200);
    expect(keptPhases.body.length).toBeGreaterThan(0);
    for (const phase of keptPhases.body) expect(phase.projectSlug).toBe(defaultSlug);
    // Their own export carries both rows, pins and all.
    const exported = await request(http).get('/api/v1/account/export').set(bearer(early.token)).expect(200);
    const exportedRows = (exported.body.enrollments ?? []) as { projectSlug: string; projectVersionId: string }[];
    expect(exportedRows.map((row) => [row.projectSlug, row.projectVersionId]).sort()).toEqual(
      [
        [defaultSlug, alonePin],
        [ownSlug, publishedVersionId],
      ].sort(),
    );

    // The teacher's roster shows them on the class's project, the one they
    // started kept after it and marked; the dossier still reads the kept one.
    const seen = await request(http)
      .get(`/api/v1/instructor/learners/${early.id}`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(seen.body.enrollments.map((one: any) => [one.projectSlug, one.setAside ?? null])).toEqual([
      [ownSlug, null],
      [defaultSlug, true],
    ]);
    await request(http)
      .get(`/api/v1/instructor/learners/${early.id}/dossier?project=${defaultSlug}`)
      .set(bearer(teacherToken))
      .expect(200);

    // View as draws the learner's OWN dashboard, and the browser names no
    // project on that load. The view-as twins resolve it the way the
    // learner's own `GET /enrollments/mine` does; resolving it as the oldest
    // enrolment (the default they set aside) would show the teacher a board
    // the learner never sees. The kept row is made
    // plainly the older one first: both were started inside one second here,
    // and the store's timestamps tie at that grain.
    await db
      .getRepository(EnrollmentEntity)
      .update({ id: alone.body.id }, { startedAt: new Date(Date.now() - 60 * 60_000) });
    const viewed = await request(http)
      .get(`/api/v1/instructor/learners/${early.id}/enrollment`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(viewed.body.id).toBe(classStart.body.id);
    expect(viewed.body.projectSlug).toBe(ownSlug);
    const viewedPhases = await request(http)
      .get(`/api/v1/instructor/learners/${early.id}/phases/summaries`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(viewedPhases.body.length).toBeGreaterThan(0);
    for (const phase of viewedPhases.body) expect(phase.projectSlug).toBe(ownSlug);
    const viewedRecords = await request(http)
      .get(`/api/v1/instructor/learners/${early.id}/phases/records`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(Object.keys(viewedRecords.body).sort()).toEqual(
      viewedPhases.body.map((phase: { id: string }) => phase.id).sort(),
    );
    // Naming the kept one still reads it, as the learner's own routes do.
    const viewedKept = await request(http)
      .get(`/api/v1/instructor/learners/${early.id}/enrollment?project=${defaultSlug}`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(viewedKept.body.id).toBe(alone.body.id);

    const overview = await request(http).get('/api/v1/instructor/overview').set(bearer(teacherToken)).expect(200);
    expect(
      overview.body.learners
        .filter((row: any) => row.userId === early.id)
        .map((row: any) => row.projectSlug)
        .sort(),
    ).toEqual([defaultSlug, ownSlug].sort());

    // 6. A LEARNER ON A TEACHER'S PROJECT IS NOT MOVED by the set-aside rule: the first
    // learner of this walk started this project in step 7, and the class's
    // project is still this one: they resolve to their own row, pinned.
    expect(await app.get(WorkflowService).projectVersionForLearner({ id: learnerId, cohort: cohortId })).toEqual({
      projectSlug: ownSlug,
      projectVersionId: publishedVersionId,
    });
  });

  /* ------------------ 11. next term's class, on the rewrite ----------------- */

  /**
   * The other end of the same promise: *"new enrolments take it"*.
   *
   * Publishing 1.1.0 moved nobody, which is step 10. Moving a class is a
   * separate teacher decision with a reason attached, and only once it is made
   * does a learner joining today reach the rewrite, while everybody already
   * inside an attempt stays exactly where they were.
   */
  it('gives a new joiner 1.1.0 once the class is re-assigned, and moves nobody already pinned', async () => {
    const reason = 'Next term works the rewritten repair log.';
    const assigned = await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: nextPublishedVersionId, reason })
      .expect(200);
    const view = assigned.body as CohortProjectView;
    expect(view.active!.projectVersionId).toBe(nextPublishedVersionId);
    expect(view.active!.version).toBe('1.1.0');
    // the class's history keeps the version this term ran on
    expect(view.history.map((one) => one.version)).toContain('1.0.0');

    const next = await account('mei');
    await request(http)
      .post('/api/v1/enrollments/join')
      .set(bearer(next.token))
      .send({ code: joinCode })
      .expect(200);

    const pin = await app
      .get(WorkflowService)
      .projectVersionForLearner({ id: next.id, cohort: cohortId });
    expect(pin).toEqual({ projectSlug: ownSlug, projectVersionId: nextPublishedVersionId });

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(bearer(next.token))
      .send({ projectSlug: ownSlug })
      .expect(201);
    const row = await db
      .getRepository(EnrollmentEntity)
      .findOneOrFail({ where: { userId: next.id, projectSlug: ownSlug } });
    expect(row.projectVersionId).toBe(nextPublishedVersionId);
    expect(row.packVersion).toBe('1.1.0');

    const requirements = enrolled.body.phases.find((one: any) => one.key === 'requirements');
    const detail = await request(http)
      .get(`/api/v1/phases/${requirements.id}`)
      .set(bearer(next.token))
      .expect(200);
    expect(detail.body.taskPanel).toBe(NEXT_TERM_STORED);
    expect(detail.body.taskPanel).not.toBe(EDITED_STORED);

    // and this term's two learners are where they were, mid-attempt
    for (const id of [learnerId, lateLearnerId]) {
      const held = await db
        .getRepository(EnrollmentEntity)
        .findOneOrFail({ where: { userId: id, projectSlug: ownSlug } });
      expect(held.projectVersionId).toBe(publishedVersionId);
      expect(held.projectVersionId).not.toBe(nextPublishedVersionId);
    }
  });
  /* ------------------ 12. what a member of staff may start ------------------ */

  /**
   * The staff-start rule: if `POST /enrollments` naming a slug let any member
   * of staff start any published project, one teacher could read another's
   * unassigned project (brief, phases, files) through an enrolment. So an
   * INSTRUCTOR may start only the platform's projects, their own, or one
   * assigned to a class they own; an ADMIN any. The refusal is the learner's
   * one sentence, whatever the slug names, and writes nothing.
   */
  it("limits a teacher's own start to the platform's, their own and their classes' projects", async () => {
    const start = (token: string, projectSlug: string) =>
      request(http).post('/api/v1/enrollments').set(bearer(token)).send({ projectSlug });
    const held = (userId: string) => db.getRepository(EnrollmentEntity).find({ where: { userId } });

    // A second teacher, with a class of their own and nothing assigned to it.
    const wen = await account('wen', 'INSTRUCTOR');
    const wenClass = (
      await request(http).post('/api/v1/instructor/cohorts').set(bearer(wen.token)).send({ name: 'Friday 2pm' }).expect(201)
    ).body.id as string;

    const foreign = await start(wen.token, ownSlug).expect(403);
    const unknown = await start(wen.token, 'no-such-project').expect(403);
    expect(foreign.body.message).toBe(NOT_YOUR_PROJECT);
    expect(unknown.body.message).toBe(NOT_YOUR_PROJECT);
    expect(foreign.body.message).not.toContain(ownSlug);
    expect(await held(wen.id)).toHaveLength(0);

    // The platform's project is theirs to walk.
    expect((await start(wen.token, defaultSlug).expect(201)).body.projectSlug).toBe(defaultSlug);
    // The owner walks their own.
    expect((await start(teacherToken, ownSlug).expect(201)).body.projectSlug).toBe(ownSlug);

    // An admin (unrestricted) puts Nadia's project on Wen's class; from then
    // on Wen may walk it, because a class of theirs works it.
    const admin = await account('root', 'ADMIN');
    expect((await start(admin.token, ownSlug).expect(201)).body.projectSlug).toBe(ownSlug);
    await request(http)
      .put(`/api/v1/instructor/cohorts/${wenClass}/project`)
      .set(bearer(admin.token))
      .send({ projectVersionId: nextPublishedVersionId, reason: 'Friday works the repair log this term.' })
      .expect(200);
    const given = await start(wen.token, ownSlug).expect(201);
    expect(given.body.projectSlug).toBe(ownSlug);
    expect((await held(wen.id)).map((row) => row.projectSlug).sort()).toEqual([defaultSlug, ownSlug].sort());
  });

  /* ------------- 13. the class moved between two teachers' projects ------------- */

  /**
   * The set-aside and staff-start rules over HTTP, at the moment they can most
   * easily be confused: Nadia moves Tuesday, mid-term, from her repair log to a
   * second project of hers. The set-aside rule is about the platform's rows and
   * nothing else, so:
   *
   * - a learner working the repair log stays on it, at 1.0.0: the class's
   *   active assignment is now a DIFFERENT project, and a teacher's row is still
   *   never set aside, which step 10b.6 could not show while the
   *   class's project and theirs were one;
   * - a learner in the class who had only started the default has it set aside,
   *   is told so on their catalogue, starts the new project at the class's
   *   version, and keeps the default whole;
   * - leaving the class hands them back the default they started, at its
   *   original pin, and writes nothing;
   * - a second teacher may not start the new project (it is on a class that is
   *   not theirs), an admin naming nothing that exists meets the 404, and
   *   view-as reads the learner's kept board and writes no enrolment at all.
   */
  it("moves a class between two teachers' projects without moving anybody on one, and sets aside only the platform's", async () => {
    const mine = async (token: string, project?: string) =>
      (
        await request(http)
          .get(`/api/v1/enrollments/mine${project ? `?project=${project}` : ''}`)
          .set(bearer(token))
          .expect(200)
      ).body;
    const listed = async (token: string) =>
      ((await request(http).get('/api/v1/projects').set(bearer(token)).expect(200)).body as {
        slug: string;
        setAside?: boolean;
      }[]).map((one) => [one.slug, one.setAside ?? null]);
    const start = (token: string, body: Record<string, string> = {}) =>
      request(http).post('/api/v1/enrollments').set(bearer(token)).send(body);
    // By slug, not by `startedAt`: two starts inside one second tie on it.
    const rows = async (userId: string) =>
      (await db.getRepository(EnrollmentEntity).find({ where: { userId } })).sort((a, b) =>
        a.projectSlug.localeCompare(b.projectSlug),
      );
    const pins = async (userId: string) => (await rows(userId)).map((row) => [row.projectSlug, row.projectVersionId]);
    const bySlug = (list: (string | null)[][]) =>
      [...list].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const everyRow = () => db.getRepository(EnrollmentEntity).count();

    // A learner who started the default on their own, then joined Tuesday
    // while it worked the repair log, and has not started the class's project.
    const ola = await account('ola');
    const alone = await start(ola.token).expect(201);
    expect(alone.body.projectSlug).toBe(defaultSlug);
    const olaPin = (await rows(ola.id))[0].projectVersionId;
    await request(http).post('/api/v1/enrollments/join').set(bearer(ola.token)).send({ code: joinCode }).expect(200);
    expect(await listed(ola.token)).toEqual([
      [ownSlug, null],
      [defaultSlug, true],
    ]);

    // Nadia's second project, published, and the class moved onto it.
    const secondSlug = `field-notes-${stamp}`;
    const made = (
      await request(http)
        .post('/api/v1/instructor/projects')
        .set(bearer(teacherToken))
        .send({ title: 'Field Notes', slug: secondSlug, fromVersionId: defaultVersionId })
        .expect(201)
    ).body as CreateProjectResult;
    const second = (
      await request(http)
        .post(`/api/v1/instructor/projects/${made.project.id}/versions/${made.draftVersionId}/publish`)
        .set(bearer(teacherToken))
        .send({ version: '1.0.0', notes: 'The second half of the term.' })
        .expect(200)
    ).body as PublishVersionResult;
    const moved = (
      await request(http)
        .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
        .set(bearer(teacherToken))
        .send({ projectVersionId: second.versionId, reason: 'Tuesday moves on to field notes mid-term.' })
        .expect(200)
    ).body as CohortProjectView;
    expect(moved.active!.projectSlug).toBe(secondSlug);

    // A teacher's row is never set aside, under a real move: the step-7 learner is still on the repair log,
    // at the version they started, and nothing in their catalogue is marked.
    const firstBefore = await rows(learnerId);
    expect(await pins(learnerId)).toEqual([[ownSlug, publishedVersionId]]);
    expect((await mine(learnerToken)).id).toBe(firstBefore[0].id);
    expect(await listed(learnerToken)).toEqual([[ownSlug, null]]);
    expect(await app.get(WorkflowService).projectVersionForLearner({ id: learnerId })).toEqual({
      projectSlug: ownSlug,
      projectVersionId: publishedVersionId,
    });

    // The set-aside rule: the default is still set aside, now for the new project, and
    // Start (naming nothing) starts it at the class's version.
    expect(await listed(ola.token)).toEqual([
      [secondSlug, null],
      [defaultSlug, true],
    ]);
    expect((await mine(ola.token))?.id).toBeUndefined();
    const olaStart = await start(ola.token).expect(201);
    expect(olaStart.body.projectSlug).toBe(secondSlug);
    expect(await pins(ola.id)).toEqual(
      bySlug([
        [defaultSlug, olaPin],
        [secondSlug, second.versionId],
      ]),
    );
    expect((await rows(ola.id)).find((row) => row.projectSlug === defaultSlug)!.id).toBe(alone.body.id);
    expect((await mine(ola.token)).id).toBe(olaStart.body.id);

    // The teacher's console reads them on the class's project, the default kept
    // and marked; view-as reads the kept board by name and writes nothing.
    const seen = await request(http)
      .get(`/api/v1/instructor/learners/${ola.id}`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(seen.body.enrollments.map((one: any) => [one.projectSlug, one.setAside ?? null])).toEqual([
      [secondSlug, null],
      [defaultSlug, true],
    ]);
    const before = await everyRow();
    const viewed = await request(http)
      .get(`/api/v1/instructor/learners/${ola.id}/enrollment?project=${defaultSlug}`)
      .set(bearer(teacherToken))
      .expect(200);
    expect(viewed.body.id).toBe(alone.body.id);
    expect(await everyRow()).toBe(before);
    expect(await rows(teacherId)).toHaveLength(1);

    // The staff-start rule after the move: a teacher who does not own Tuesday
    // may not start the project Tuesday was given, in the one sentence; an
    // admin naming a project nobody published meets the 404.
    const wen = (
      await db.getRepository(UserEntity).findOneOrFail({ where: { email: `wen-${stamp}@teacher-projects.test` } })
    ).id;
    const imani = await account('imani-b', 'INSTRUCTOR');
    const refused = await start(imani.token, { projectSlug: secondSlug }).expect(403);
    expect(refused.body.message).toBe(NOT_YOUR_PROJECT);
    expect(await rows(imani.id)).toHaveLength(0);
    expect(await rows(wen)).toHaveLength(2);
    const root = await account('root-b', 'ADMIN');
    await start(root.token, { projectSlug: 'no-such-project' }).expect(404);
    expect(await rows(root.id)).toHaveLength(0);

    // Leaving: back to the default they started, at its original pin, with
    // nothing written; the class's project stays in their record.
    const rowsBeforeLeaving = await everyRow();
    await request(http).post('/api/v1/enrollments/leave').set(bearer(ola.token)).expect(200);
    const back = await mine(ola.token);
    expect(back.id).toBe(alone.body.id);
    expect(back.projectSlug).toBe(defaultSlug);
    expect(await everyRow()).toBe(rowsBeforeLeaving);
    expect(await pins(ola.id)).toEqual(
      bySlug([
        [defaultSlug, olaPin],
        [secondSlug, second.versionId],
      ]),
    );
    expect((await mine(ola.token, secondSlug)).id).toBe(olaStart.body.id);
  });

  /* ---- 14. the class moved from a teacher's project to the platform's ---- */

  /**
   * Over HTTP: Tuesday works Field Notes (step 13). Pia started the default
   * alone and joined late, then started Field Notes as the set-aside rule lets
   * her; Quin joined on time and started only Field Notes. Nadia then moves
   * Tuesday back to the platform's default. A teacher's row is never set aside,
   * so both stay on Field Notes: the default Pia started before joining does not
   * take her off the teacher's project by becoming the class's. A learner who
   * joins now is given the default at the class's version.
   *
   * And the staff-start rule for a request that names nothing: an instructor seated (by an
   * admin) in Tuesday, which is not theirs, sends the dashboard's `{}` and is
   * refused the class's project in the one sentence, as by name.
   */
  it("keeps a late joiner and an on-time one on the teacher's project when the class moves to the platform's", async () => {
    const mine = async (token: string) =>
      (await request(http).get('/api/v1/enrollments/mine').set(bearer(token)).expect(200)).body;
    const listed = async (token: string) =>
      ((await request(http).get('/api/v1/projects').set(bearer(token)).expect(200)).body as {
        slug: string;
        setAside?: boolean;
      }[]).map((one) => [one.slug, one.setAside ?? null]);
    const start = (token: string, body: Record<string, string> = {}) =>
      request(http).post('/api/v1/enrollments').set(bearer(token)).send(body);
    const join = (token: string) =>
      request(http).post('/api/v1/enrollments/join').set(bearer(token)).send({ code: joinCode }).expect(200);
    const rows = (userId: string) => db.getRepository(EnrollmentEntity).find({ where: { userId } });

    const onNow = (
      await request(http).get(`/api/v1/instructor/cohorts/${cohortId}/project`).set(bearer(teacherToken)).expect(200)
    ).body as CohortProjectView;
    const fieldNotes = onNow.active!.projectSlug;
    expect(fieldNotes).not.toBe(defaultSlug);

    // The staff-start rule, naming nothing: an instructor an admin seated in Tuesday.
    const seated = await account('imani-c', 'INSTRUCTOR');
    await db.manager.update(UserEntity, { id: seated.id }, { cohort: cohortId });
    app.get(AuthService).forgetSession(seated.id);
    const refused = await start(seated.token).expect(403);
    expect(refused.body.message).toBe(NOT_YOUR_PROJECT);
    expect(refused.body.message).not.toContain(fieldNotes);
    expect(await rows(seated.id)).toHaveLength(0);

    // The late joiner and the on-time one, both on Field Notes.
    const pia = await account('pia');
    const solo = (await start(pia.token).expect(201)).body;
    expect(solo.projectSlug).toBe(defaultSlug);
    await join(pia.token);
    const piaOnNotes = (await start(pia.token).expect(201)).body;
    expect(piaOnNotes.projectSlug).toBe(fieldNotes);
    const quin = await account('quin');
    await join(quin.token);
    const quinOnNotes = (await start(quin.token).expect(201)).body;
    expect(quinOnNotes.projectSlug).toBe(fieldNotes);
    const before = await db.getRepository(EnrollmentEntity).count();

    await request(http)
      .put(`/api/v1/instructor/cohorts/${cohortId}/project`)
      .set(bearer(teacherToken))
      .send({ projectVersionId: defaultVersionId, reason: 'Tuesday returns to the platform project.' })
      .expect(200);

    // Neither teacher's-project row is set aside, the late joiner's included.
    expect((await mine(quin.token)).id).toBe(quinOnNotes.id);
    expect((await mine(pia.token)).id).toBe(piaOnNotes.id);
    expect(await listed(pia.token)).toEqual([
      [fieldNotes, null],
      [defaultSlug, true],
    ]);
    const named = await start(pia.token, { projectSlug: defaultSlug }).expect(403);
    expect(named.body.message).toBe(NOT_YOUR_PROJECT);
    expect((await start(pia.token).expect(201)).body.id).toBe(piaOnNotes.id);
    // The teacher's console draws her on Field Notes, the default marked.
    const seen = await request(http).get(`/api/v1/instructor/learners/${pia.id}`).set(bearer(teacherToken)).expect(200);
    expect(seen.body.enrollments.map((one: any) => [one.projectSlug, one.setAside ?? null])).toEqual([
      [fieldNotes, null],
      [defaultSlug, true],
    ]);
    // The default she started is whole and read by name; the move wrote nothing.
    expect(
      (await request(http).get(`/api/v1/enrollments/mine?project=${defaultSlug}`).set(bearer(pia.token)).expect(200)).body.id,
    ).toBe(solo.id);
    expect(await db.getRepository(EnrollmentEntity).count()).toBe(before);

    // A learner who joins now is given the class's project, at the class's version.
    const rae = await account('rae');
    await join(rae.token);
    const raeStart = (await start(rae.token).expect(201)).body;
    expect(raeStart.projectSlug).toBe(defaultSlug);
    expect((await rows(rae.id)).map((row) => row.projectVersionId)).toEqual([defaultVersionId]);

    // In the running app: a date on the class's project reminds the
    // learner who is on it, and not the one whose row on it is set aside.
    await db.manager.save(
      db.manager.create(CohortPhaseScheduleEntity, {
        cohortId,
        projectSlug: defaultSlug,
        phaseKey: 'requirements',
        opensAt: null,
        dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      }),
    );
    await app.get(NotificationsService).sweep();
    const reminded = (userId: string) =>
      db.getRepository(NotificationEntity).count({ where: { userId, kind: 'deadline.near' } });
    expect(await reminded(rae.id)).toBe(1);
    expect(await reminded(pia.id)).toBe(0);
  });
  /* ---- the editor marks an uploaded task for sign-off ---- */

  it("marks an uploaded phase's sole task for sign-off over the route: 200, the answer and the compiled snapshot carry it; a non-boolean is a 400; a published version refuses it", async () => {
    const { UPLOAD_PATH } = require('../src/authoring/upload.service') as typeof import('../src/authoring/upload.service');
    const { zipDirectory } = require('./fixtures/upload-packs/archive') as typeof import('./fixtures/upload-packs/archive');
    const { SHELF_DIR } = require('./fixtures/upload-packs/markers') as typeof import('./fixtures/upload-packs/markers');
    const uploaded = await request(http)
      .post(UPLOAD_PATH)
      .set(bearer(teacherToken))
      .send({ title: `Shelf sign-off ${stamp}`, archiveBase64: zipDirectory(SHELF_DIR).toString('base64') });
    expect({ status: uploaded.status, message: uploaded.status === 201 ? null : uploaded.body?.message }).toEqual({ status: 201, message: null });
    const route = `/api/v1/instructor/projects/${uploaded.body.projectId}/versions/${uploaded.body.versionId}/phases/requirements/tasks/${INHERITED_TASK_KEY}`;
    const compiledMark = async () =>
      ((await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: uploaded.body.versionId })).compiled as any).phases
        .find((one: any) => one.key === 'requirements').tasks[0].signOff;

    const marked = await request(http).patch(route).set(bearer(teacherToken)).send({ signOff: true });
    expect({ status: marked.status, message: marked.status === 200 ? null : marked.body?.message }).toEqual({ status: 200, message: null });
    expect((marked.body as TaskMutationResult).phase.tasks.map((one) => [one.taskKey, one.signOff])).toEqual([[INHERITED_TASK_KEY, true]]);
    expect(await compiledMark()).toBe(true);

    // a non-boolean is the pipe's 400, and nothing moves
    const yes = await request(http).patch(route).set(bearer(teacherToken)).send({ signOff: 'yes' });
    expect(yes.status).toBe(400);
    expect(JSON.stringify(yes.body.message)).toContain('signOff');
    expect(await compiledMark()).toBe(true);

    // GUARD: a body without the member leaves the mark as it was
    await request(http).patch(route).set(bearer(teacherToken)).send({ title: 'Write the shelf story' }).expect(200);
    expect(await compiledMark()).toBe(true);

    // a published version refuses the mark as it refuses every edit
    const published = `/api/v1/instructor/projects/${projectId}/versions/${publishedVersionId}/phases/requirements/tasks/${INHERITED_TASK_KEY}`;
    const brief = await request(http).patch(published).set(bearer(teacherToken)).send({ brief: 'A change after the fact.' });
    const mark = await request(http).patch(published).set(bearer(teacherToken)).send({ signOff: true });
    expect({ status: mark.status, message: mark.body?.message }).toEqual({ status: brief.status, message: brief.body?.message });
    expect(mark.status).toBe(409);
  });
});
