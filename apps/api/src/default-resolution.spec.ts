import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { config, resolveDefaultProject, resolveNamedProject } from './config';
import { ContentService } from './content/content.service';
import { ProjectRegistryService } from './content/project-registry.service';
import {
  CohortEntity,
  CohortProjectAssignmentEntity,
  EnrollmentEntity,
  ProjectEntity,
  ProjectVersionEntity,
  UserEntity,
} from './db/entities';
import { WorkflowService } from './workflow/workflow.service';

/**
 * Which project a learner is in when the request names none.
 *
 * The order is four steps: the learner's own enrolment, then their class's
 * active assignment, then the `DEFAULT_PROJECT` env slug, then the project the
 * importer flagged. `WorkflowService.projectVersionForLearner` is where it
 * lives and the three learner routes are what it answers for, so this file
 * asserts three things: that `config.defaultProject` is a *slug fallback* and
 * nothing more; that the explicit-slug path answers about the slug it names,
 * whatever the unnamed path resolves; and that the four steps resolve in order
 * (version as well as slug) for learners whose own project is not the one this
 * deployment defaults to, which is the case a content-directory probe could
 * never answer.
 */
describe('the server-side default', () => {
  describe('config.defaultProject is a slug fallback only', () => {
    const env = (over: Record<string, string | undefined> = {}) =>
      ({ ...over }) as NodeJS.ProcessEnv;

    it('answers the named slug synchronously, with no content directory and no database', () => {
      // Step 3 of the order is "the DEFAULT_PROJECT env slug, if set", and it
      // has to be answerable before anything is connected: `config` is read at
      // module load, long before a repository exists. So the env branch returns
      // without reading a directory at all: passing a path that is not there
      // is the proof, and a `string` rather than a `Promise<string>` is the
      // rest of it.
      const missing = path.join(os.tmpdir(), 'lsdlc-no-such-content-default-resolution');
      const named = resolveDefaultProject(missing, env({ DEFAULT_PROJECT: 'ledger' }));
      expect(named).toBe('ledger');
      expect(typeof named).toBe('string');
    });

    it('answers the empty string rather than a guess when no operator named one', () => {
      // The distinction step 3 rests on: "an operator named a project" has to
      // be tellable from "an operator named none", because the second case is
      // what hands the question on to step 4 (the `projects` row the importer
      // flagged) rather than to whichever directory sorted first.
      const missing = path.join(os.tmpdir(), 'lsdlc-no-such-content-default-resolution');
      expect(resolveDefaultProject(missing, env({}))).toBe('');
      expect(resolveDefaultProject(missing, env({ DEFAULT_PROJECT: '   ' }))).toBe('');
    });

    it('tells "an operator named a project" apart from "a pack sorted first"', () => {
      // `defaultProject` answers a slug either way (the env override first,
      // the content directory after it) so on its own it cannot carry step 3's
      // question, and a resolver that asked it would never reach step 4. The
      // two readings are separate values: `namedProject` is the choice and
      // `defaultProject` is the choice-or-guess the seed needs to know which
      // pack to flag.
      expect(resolveNamedProject(env({}))).toBe('');
      expect(resolveNamedProject(env({ DEFAULT_PROJECT: '  ledger  ' }))).toBe('ledger');

      // This deployment names none, and still ships one: the whole point in
      // one pair of lines.
      expect(config.namedProject).toBe('');
      expect(config.defaultProject).not.toBe('');
    });
  });

  /**
   * One app for both readings of the three routes: the parameter-absent path
   * and the named one. Two boots of `AppModule` in one file would run the seed
   * importer twice for no coverage that is not here already.
   */
  describe('the three learner routes', () => {
    let app: INestApplication;
    let http: any;
    let token = '';
    let slug = '';
    let phaseIds: string[] = [];

    const auth = () => ({ authorization: `Bearer ${token}` });
    const stamp = Date.now();

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.setGlobalPrefix('api/v1');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      http = app.getHttpServer();

      const reg = await request(http)
        .post('/api/v1/auth/register')
        .send({
          email: `default-resolution-${stamp}@project.test`,
          password: 'Correct-Horse-9',
          displayName: 'Learner',
        })
        .expect(201);
      token = reg.body.token;

      const [project] = await app
        .get(DataSource)
        .getRepository(ProjectEntity)
        .find({ where: { isDefault: true } });
      slug = project.slug;

      const enrolled = await request(http)
        .post('/api/v1/enrollments')
        .set(auth())
        .send({ projectSlug: slug })
        .expect(201);
      phaseIds = enrolled.body.phases.map((p: any) => p.id);
    });

    afterAll(async () => {
      await app.close();
    });

    /**
     * **Regression guard.** It cannot tell the two resolutions apart, because
     * this deployment ships one pack: the `projects` row the importer flagged
     * and the directory that sorted first carry the same slug, so the two
     * resolutions cannot be told apart here. What earns it its place is that
     * it is written against the flagged row: `slug` above is read from
     * `isDefault: true`, never from `config.defaultProject`, so it is still
     * the right assertion whichever way the resolution goes, and that it is the only
     * coverage `GET /phases/summaries` and `GET /phases/records` have on the
     * parameter-absent path at all. The browser takes that path for
     * `GET /enrollments/mine` on every load.
     *
     * It is not the four-step order's test. That one needs a learner whose own
     * enrolment disagrees with the deployment's default, and it is the first of
     * the tests below.
     */
    it('three routes resolve server-side when the parameter is absent', async () => {
      const mine = await request(http).get('/api/v1/enrollments/mine').set(auth()).expect(200);
      expect(mine.body.projectSlug).toBe(slug);
      expect(mine.body.phases).toHaveLength(6);

      const summaries = await request(http)
        .get('/api/v1/phases/summaries')
        .set(auth())
        .expect(200);
      expect(summaries.body.length).toBeGreaterThan(0);
      for (const detail of summaries.body) {
        expect(detail.projectSlug).toBe(slug);
        expect(phaseIds).toContain(detail.id);
      }

      const records = await request(http).get('/api/v1/phases/records').set(auth()).expect(200);
      expect(Object.keys(records.body)).toEqual(summaries.body.map((d: any) => d.id));
    });

    describe('an explicit slug is unchanged', () => {
      it('answers all three routes for the slug the request names', async () => {
        // The three learner routes: `enrollments/mine`, `phases/summaries` and
        // `phases/records`. The named path does not depend on how the unnamed
        // one resolves, so its shape is written down here.
        const mine = await request(http)
          .get(`/api/v1/enrollments/mine?project=${slug}`)
          .set(auth())
          .expect(200);
        expect(mine.body.projectSlug).toBe(slug);
        expect(mine.body.phases).toHaveLength(6);

        const summaries = await request(http)
          .get(`/api/v1/phases/summaries?project=${slug}`)
          .set(auth())
          .expect(200);
        expect(summaries.body.length).toBeGreaterThan(0);
        for (const detail of summaries.body) {
          expect(detail.projectSlug).toBe(slug);
          expect(phaseIds).toContain(detail.id);
        }

        const records = await request(http)
          .get(`/api/v1/phases/records?project=${slug}`)
          .set(auth())
          .expect(200);
        // One entry per open phase, keyed by phase state id, each carrying the
        // three record lists the room draws.
        expect(Object.keys(records.body)).toEqual(summaries.body.map((d: any) => d.id));
        for (const row of Object.values(records.body) as any[]) {
          expect(Array.isArray(row.submissions)).toBe(true);
          expect(Array.isArray(row.runs)).toBe(true);
          expect(Array.isArray(row.chat)).toBe(true);
        }
      });

      it('answers empty, not an error, for a slug the learner is not on', async () => {
        // A named project the learner holds no enrolment in is a learner who has
        // not started it, and the browser draws the first-run screen off these
        // three empties. A 404 here would be a crash on the only path a second
        // project can reach.
        const mine = await request(http)
          .get('/api/v1/enrollments/mine?project=other-pack')
          .set(auth())
          .expect(200);
        expect(mine.body.projectSlug).toBeUndefined();

        const summaries = await request(http)
          .get('/api/v1/phases/summaries?project=other-pack')
          .set(auth())
          .expect(200);
        expect(summaries.body).toEqual([]);

        const records = await request(http)
          .get('/api/v1/phases/records?project=other-pack')
          .set(auth())
          .expect(200);
        expect(records.body).toEqual({});
      });
    });

    /* ------- the four-step order, and the screen it takes away --------- */

    /**
     * A second project this deployment holds, a class that can be assigned one,
     * and learners whose own project is not the one the deployment defaults to.
     *
     * Every test above is about a deployment that ships a single pack, where
     * the flagged `projects` row and the directory that sorted first carry the
     * same slug and no resolution can be told from any other. These are the
     * ones that can: a second published project in the database, reachable by
     * the registry, with two published versions so that "the version the
     * learner holds" and "the newest published version" are different strings.
     *
     * The second project is written as rows rather than imported from a
     * directory on purpose. What the runtime reads is
     * `project_versions.compiled`, so a published row with a compiled snapshot
     * is exactly what a second teacher-authored project *is* to every reader in
     * this order, and the repository ships no second pack to import.
     */
    describe('a learner whose project is not the deployment default', () => {
      const OTHER = 'ledger-lab';
      /** `project_versions.id` of `ledger-lab` 1.0.0: published, and superseded. */
      let firstVersion = '';
      /** `project_versions.id` of `ledger-lab` 1.1.0: the newest published. */
      let headVersion = '';
      /** The flagged project's newest published version, step 4's answer. */
      let defaultHead: string | null = null;
      /** Who owns the classes below and signs their assignments. */
      let teacher = '';
      let classes = 0;

      const db = () => app.get(DataSource);

      const register = async (who: string) => {
        const res = await request(http)
          .post('/api/v1/auth/register')
          .send({
            email: `${who}-${stamp}@project.test`,
            password: 'Correct-Horse-9',
            displayName: 'Learner',
          })
          .expect(201);
        return {
          token: res.body.token as string,
          id: res.body.user.id as string,
          auth: () => ({ authorization: `Bearer ${res.body.token}` }),
        };
      };

      /**
       * A class working one project version, with the learner in it.
       *
       * This is the row the class panel writes and step 2 reads; the fixture
       * writes it directly.
       */
      const classAssigned = async (projectVersionId: string, learnerId: string) => {
        classes += 1;
        const cohort = await db()
          .getRepository(CohortEntity)
          .save(
            db()
              .getRepository(CohortEntity)
              .create({
                name: `Class ${classes}`,
                joinCode: `DR-${stamp}-${classes}`,
                ownerUserId: teacher,
              }),
          );
        await db()
          .getRepository(CohortProjectAssignmentEntity)
          .save(
            db()
              .getRepository(CohortProjectAssignmentEntity)
              .create({
                cohortId: cohort.id,
                projectVersionId,
                assignedByUserId: teacher,
                state: 'active',
                reason: 'the class was moved for the term',
              }),
          );
        await db().getRepository(UserEntity).update({ id: learnerId }, { cohort: cohort.id });
        return cohort.id;
      };

      /**
       * The same class moved to another project version by its teacher: the
       * active row superseded, a new one written. This is a reassignment: the
       * learner stays in the class, which is what the tests below describe;
       * moving the learner into a second class is a class switch, and a
       * teacher's project reaches only learners of a class it is assigned to.
       */
      const reassign = async (cohortId: string, projectVersionId: string) => {
        const assignments = db().getRepository(CohortProjectAssignmentEntity);
        await assignments.update({ cohortId, state: 'active' }, { state: 'superseded' });
        await assignments.save(
          assignments.create({
            cohortId,
            projectVersionId,
            assignedByUserId: teacher,
            state: 'active',
            reason: 'the class was moved for the term',
          }),
        );
      };

      beforeAll(async () => {
        const projects = db().getRepository(ProjectEntity);
        const versions = db().getRepository(ProjectVersionEntity);
        const users = db().getRepository(UserEntity);

        const flagged = await projects.findOneOrFail({ where: { isDefault: true } });
        const source = await versions.findOneOrFail({
          where: { projectId: flagged.id, status: 'published' },
        });
        const snapshot = source.compiled;
        if (!snapshot) throw new Error('the imported default published no compiled snapshot');
        const staff =
          (await users.findOne({ where: { role: 'INSTRUCTOR' } })) ?? (await users.find({ take: 1 }))[0];
        teacher = staff.id;

        const project = await projects.save(
          projects.create({
            slug: OTHER,
            title: 'Ledger Lab',
            platformOwned: false,
            ownerUserId: teacher,
            isDefault: false,
            origin: 'upload',
          }),
        );
        const publish = async (version: string) => {
          const row = await versions.save(
            versions.create({
              projectId: project.id,
              version,
              status: 'published',
              manifest: source.manifest,
              compiled: {
                ...snapshot,
                slug: OTHER,
                version,
                content: { ...snapshot.content, slug: OTHER, title: 'Ledger Lab', version },
              },
              sandboxBudget: source.sandboxBudget,
              publishedAt: new Date().toISOString(),
              publishedByUserId: teacher,
            }),
          );
          return row.id;
        };
        firstVersion = await publish('1.0.0');
        headVersion = await publish('1.1.0');

        // What a publish and the boot both call:
        // the registry re-reads every published row, so the second project is
        // resolvable by slug and by version id from here on.
        await app.get(ProjectRegistryService).load();
        defaultHead = app.get(ContentService).headVersionIdFor(slug);
      });

      it('installs the second project without moving the flag', async () => {
        // The fixture's own guard. Everything below is about telling two
        // projects apart, and it would tell them apart just as well if the
        // second one had quietly become the default.
        const flagged = await db().getRepository(ProjectEntity).find({ where: { isDefault: true } });
        expect(flagged.map((row) => row.slug)).toEqual([slug]);

        const content = app.get(ContentService);
        expect(content.getProject(OTHER).version).toBe('1.1.0');
        expect(content.headVersionIdFor(OTHER)).toBe(headVersion);
        expect(headVersion).not.toBe(firstVersion);
        expect(defaultHead).toBeTruthy();
      });

      /**
       * The resolution order, one case per step, each asserting the **version** as well
       * as the slug, because "which project" and "which version of it" are two
       * questions and only the second one is the pin.
       *
       * Read against `config.defaultProject`, which on this deployment is the
       * flagged slug: three of the four answers are a different project
       * entirely, and the fourth is the same slug arrived at from the `projects`
       * row rather than from `readdirSync`.
       */
      it('the four-step order resolves in order, version as well as slug', async () => {
        const workflow = app.get(WorkflowService);
        const enrollments = db().getRepository(EnrollmentEntity);
        expect(config.defaultProject).toBe(slug);

        // 1. The learner's own enrolment, at the version they hold: over a
        // class that says otherwise, and over the head of their own project.
        const own = await register('step-one');
        await enrollments.save(
          enrollments.create({
            userId: own.id,
            projectSlug: OTHER,
            packVersion: '1.0.0',
            projectVersionId: firstVersion,
          }),
        );
        const movedClass = await classAssigned(firstVersion, own.id);
        await reassign(movedClass, defaultHead as string);
        expect(await workflow.projectVersionForLearner({ id: own.id, cohort: movedClass })).toEqual({
          projectSlug: OTHER,
          projectVersionId: firstVersion,
        });

        // 2. The class's active assignment, at the version the class was
        // assigned, never the head, so a class stays where it was put.
        const classmate = await register('step-two');
        const workingClass = await classAssigned(firstVersion, classmate.id);
        expect(
          await workflow.projectVersionForLearner({ id: classmate.id, cohort: workingClass }),
        ).toEqual({ projectSlug: OTHER, projectVersionId: firstVersion });

        // 3. The slug an operator named, at its newest published version. The
        // content directory still holds one pack and still sorts the same way;
        // what changes the answer is `DEFAULT_PROJECT`, and nothing else.
        const unattached = await register('step-three');
        const named = config.namedProject;
        try {
          (config as any).namedProject = OTHER;
          expect(
            await workflow.projectVersionForLearner({ id: unattached.id, cohort: 'default' }),
          ).toEqual({ projectSlug: OTHER, projectVersionId: headVersion });
        } finally {
          (config as any).namedProject = named;
        }

        // 4. The project the importer flagged, at its newest published version.
        // The product rule in one line, and the step the deployment
        // actually takes: nobody named a project here.
        expect(config.namedProject).toBe('');
        expect(
          await workflow.projectVersionForLearner({ id: unattached.id, cohort: 'default' }),
        ).toEqual({ projectSlug: slug, projectVersionId: defaultHead });
      });

      /**
       * The reason step 1 comes first.
       *
       * A learner with a term of work on one project, whose class is then moved
       * to another (an ordinary reassignment, not the audited migrate) asks
       * for their board with no `?project`, because the browser sends none. A
       * resolution that answered the class's assignment, or the deployment's
       * default, looks up `{userId, projectSlug}` for a project they hold no
       * enrolment in and answers `null` and `[]`: a first-run screen drawn for
       * somebody who has a term of scores.
       */
      it("a reassigned class's existing learner keeps their own project", async () => {
        const learner = await register('reassigned');
        // The term starts with the class on OTHER, which is the only way a
        // learner comes to hold a project that is not the deployment's
        // default: `POST /enrollments` writes the project the server resolves
        // for them and refuses any other, so a slug alone never puts
        // anybody anywhere.
        const theClass = await classAssigned(firstVersion, learner.id);
        const enrolled = await request(http)
          .post('/api/v1/enrollments')
          .set(learner.auth())
          .send({ projectSlug: OTHER })
          .expect(201);
        expect(enrolled.body.projectSlug).toBe(OTHER);

        // The class moves to the deployment's default project. The learner's
        // own enrolment does not move with it: that is the audited migrate,
        // which this test does not exercise.
        await reassign(theClass, defaultHead as string);

        const mine = await request(http)
          .get('/api/v1/enrollments/mine')
          .set(learner.auth())
          .expect(200);
        expect(mine.body.projectSlug).toBe(OTHER);
        expect(mine.body.id).toBe(enrolled.body.id);
        expect(mine.body.phases).toHaveLength(6);

        const summaries = await request(http)
          .get('/api/v1/phases/summaries')
          .set(learner.auth())
          .expect(200);
        expect(summaries.body.length).toBeGreaterThan(0);
        for (const detail of summaries.body) expect(detail.projectSlug).toBe(OTHER);
      });

      /**
       * The three routes, on the path the browser actually takes.
       *
       * The guard above it in this file asserts the same three routes for a
       * learner whose project *is* the deployment's default, where the answer
       * is the same whichever resolution runs. This one is the same three
       * routes for a learner whose project is not, which is the case
       * `config.defaultProject` could never answer, because it is a fact about
       * the content directory and not about the learner.
       */
      it('the three routes answer for the learner’s own project, not the deployment’s', async () => {
        const learner = await register('own-project');
        // Their class works OTHER, which is what makes it theirs to start.
        await classAssigned(firstVersion, learner.id);
        const enrolled = await request(http)
          .post('/api/v1/enrollments')
          .set(learner.auth())
          .send({ projectSlug: OTHER })
          .expect(201);

        const mine = await request(http)
          .get('/api/v1/enrollments/mine')
          .set(learner.auth())
          .expect(200);
        expect(mine.body.projectSlug).toBe(OTHER);
        expect(mine.body.id).toBe(enrolled.body.id);

        const summaries = await request(http)
          .get('/api/v1/phases/summaries')
          .set(learner.auth())
          .expect(200);
        expect(summaries.body.length).toBeGreaterThan(0);
        for (const detail of summaries.body) expect(detail.projectSlug).toBe(OTHER);

        const records = await request(http)
          .get('/api/v1/phases/records')
          .set(learner.auth())
          .expect(200);
        expect(Object.keys(records.body)).toEqual(summaries.body.map((d: any) => d.id));
      });

      /**
       * Step 4 asks step 3's question too.
       *
       * The flag is a `projects` row and the catalogue is the set of published
       * versions that hold a compiled snapshot, so the two can part company
       * without anybody moving the flag: an owner leaving archives every
       * version of their project (`account.service.ts`), and a published row
       * with no snapshot is skipped by name
       * (`project-registry.service.ts`). `ensureDefaultProject` leaves the flag
       * where it is in both cases, because one flagged row that matches the
       * wanted slug is the state it is there to produce.
       *
       * Answering that slug anyway hands the warm-up a pin whose project the
       * registry holds nothing for, and `requireWarmup` raises `unknown
       * project: <slug>` at a learner who asked for their own first page.
       * Step 3 has this guard already; the two steps answer the same kind of
       * thing and have to be as careful as each other.
       */
      it('a flagged project this deployment cannot serve is not the answer', async () => {
        const projects = db().getRepository(ProjectEntity);
        const versions = db().getRepository(ProjectVersionEntity);
        const workflow = app.get(WorkflowService);
        const unservable = await register('shuttered');
        const flaggedBefore = await projects.find({ where: { isDefault: true } });

        const shuttered = await projects.save(
          projects.create({
            slug: `shuttered-${stamp}`,
            title: 'A project whose owner left',
            platformOwned: false,
            ownerUserId: teacher,
            isDefault: false,
            origin: 'upload',
          }),
        );
        const source = await versions.findOneOrFail({
          where: { projectId: flaggedBefore[0].id, status: 'published' },
        });
        await versions.save(
          versions.create({
            projectId: shuttered.id,
            version: '1.0.0',
            status: 'archived',
            manifest: source.manifest,
            compiled: source.compiled,
            sandboxBudget: source.sandboxBudget,
          }),
        );

        try {
          // The flag moved onto it and nothing else did: the catalogue still
          // holds the two projects it held, and neither of them is this one.
          await projects.update({ isDefault: true }, { isDefault: false });
          await projects.update({ id: shuttered.id }, { isDefault: true });
          expect(
            app.get(ContentService).listProjects().map((project) => project.slug),
          ).not.toContain(shuttered.slug);

          // Not the flagged slug, and not a slug at all: with no flagged row
          // this deployment can serve, "no project" is the honest answer and
          // the three routes already say it (`null`, `[]` and `{}`) where
          // `unknown project` is a 404 at a learner who asked for their board.
          expect(
            await workflow.projectVersionForLearner({ id: unservable.id, cohort: 'default' }),
          ).toBeNull();
        } finally {
          await projects.update({ isDefault: true }, { isDefault: false });
          for (const row of flaggedBefore) {
            await projects.update({ id: row.id }, { isDefault: true });
          }
        }

        expect(
          (await projects.find({ where: { isDefault: true } })).map((row) => row.slug),
        ).toEqual(flaggedBefore.map((row) => row.slug));
      });
    });
  });
});
