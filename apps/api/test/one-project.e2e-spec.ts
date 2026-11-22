import { INestApplication } from '@nestjs/common';
import { compareProjectVersions } from '@learnsdlc/shared';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ContentService } from '../src/content/content.service';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import {
  EnrollmentEntity,
  ProjectEntity,
  ProjectVersionEntity,
  UserEntity,
} from '../src/db/entities';
import { NOT_YOUR_PROJECT, WorkflowService } from '../src/workflow/workflow.service';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The default project, and the routes that still carry a slug.
 *
 * The platform ships one reference pack and no project chooser, but
 * `projectSlug` stays on every entity and every route. What this file holds: a
 * request that names no project gets the project this deployment actually
 * holds rather than a slug somebody typed into a controller, enrolling twice is
 * a conflict, an unknown project is answered as itself, and a phase says which
 * project it belongs to so a bookmarked workspace URL renders the right rail.
 *
 * Two facts are read from where they live rather than assumed. The catalogue
 * is not asserted to hold exactly one project, because a teacher's published
 * project joins it. And the default is not whichever directory sorted first:
 * it is a `projects` row the importer flagged, and it is that row the last
 * step of the four-step default-resolution order reads. A learner cannot tell
 * the difference.
 */
describe('the default project', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  let token = '';
  let userId = '';
  let slug = '';
  let flagged: ProjectEntity[] = [];
  let published: ProjectVersionEntity[] = [];

  const auth = () => ({ authorization: `Bearer ${token}` });
  const stamp = Date.now();

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));
    db = app.get(DataSource);

    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({
        email: `one-${stamp}@project.test`,
        password: 'Correct-Horse-9',
        displayName: 'Learner',
      })
      .expect(201);
    token = reg.body.token;
    userId = reg.body.user.id;

    // The default project is read here, not inside the first test. Four later
    // tests need `slug`, and a module-scoped variable assigned inside a test
    // makes declaration order load-bearing: under `--randomize` the later
    // tests would read `undefined`. The test below asserts what this read
    // found rather than being the only place that reads.
    flagged = await db.getRepository(ProjectEntity).find({ where: { isDefault: true } });
    slug = flagged[0]?.slug ?? '';
    published = flagged[0]
      ? await db
          .getRepository(ProjectVersionEntity)
          .find({ where: { projectId: flagged[0].id, status: 'published' } })
      : [];
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves the default from the database, not from directory order', () => {
    // The boot imports content/tasktrackr as rows and flags one project, so "the project a
    // request naming none answers for" is a stored fact with a version behind
    // it rather than the first name `fs.readdirSync` happened to return.
    expect(flagged).toHaveLength(1);

    const [row] = flagged;
    expect(row.slug).toBeTruthy();
    expect(row.platformOwned).toBe(true);
    expect(row.origin).toBe('seed');
    expect(slug).toBe(row.slug);

    // The flag is on the project and the version is resolved under it, so a
    // bumped pack becomes the head with no second write. `''` is what an
    // unpinned enrolment holds in the pin column, so the head is what every read takes,
    // and it has to exist.
    expect(published.length).toBeGreaterThan(0);

    const head = [...published].sort((a, b) => compareProjectVersions(b.version, a.version))[0];
    expect(head.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(head.compiled).not.toBeNull();
  });

  it("a learner's catalogue holds their enrolments plus the default", async () => {
    // Not a count: what the route owes a learner is that the project they can
    // start is in it, whatever else the platform holds.
    const projects = await request(http).get('/api/v1/projects').set(auth()).expect(200);

    const slugs = projects.body.map((p: any) => p.slug);
    expect(slugs).toContain(slug);

    const held = await db
      .getRepository(EnrollmentEntity)
      .find({ where: { userId } })
      .then((rows) => rows.map((row) => row.projectSlug));
    for (const entry of projects.body) {
      expect(entry.slug === slug || held.includes(entry.slug)).toBe(true);
      // A catalogue entry carries the phase
      // titles the sidebar draws, and every pack this platform ships has six.
      expect(entry.phaseTitles).toHaveLength(6);
    }
  });

  /**
   * A second published project, and the learner who is in neither.
   *
   * A staff-owned second project, for two facts. The first is asserted here:
   * the default a request
   * naming none resolves is the flagged `projects` row, so another teacher
   * publishing a project cannot move an unattached learner off the project
   * they have always landed on, which is what "the default is resolvable from
   * the database" is *for*, and what directory order could never promise.
   *
   * The second fact (that a learner's catalogue never carries that project,
   * because `GET /projects` is scoped per caller) is asserted by the test
   * after this one, which runs once this one has
   * published and registered the second project.
   */
  it('a second published project never changes what an unclassed learner gets', async () => {
    const workflow = app.get(WorkflowService);
    const content = app.get(ContentService);
    const projects = db.getRepository(ProjectEntity);
    const versions = db.getRepository(ProjectVersionEntity);

    const newcomer = await request(http)
      .post('/api/v1/auth/register')
      .send({
        email: `unattached-${stamp}@project.test`,
        password: 'Correct-Horse-9',
        displayName: 'Newcomer',
      })
      .expect(201);
    const newcomerId = newcomer.body.user.id as string;
    const learner = { id: newcomerId, cohort: 'default' };

    // In no class, holding no enrolment: every step of the default-resolution
    // order but the last has nothing to answer with, and the last one answers.
    const before = await workflow.projectVersionForLearner(learner);
    expect(before).toEqual({ projectSlug: slug, projectVersionId: content.headVersionIdFor(slug) });

    // A second teacher publishes. Rows, not a directory: a published version
    // with a compiled snapshot is what a project *is* to every reader.
    const source = await versions.findOneOrFail({
      where: { projectId: flagged[0].id, status: 'published' },
    });
    const snapshot = source.compiled;
    if (!snapshot) throw new Error('the imported default published no compiled snapshot');
    const staff = await db.getRepository(UserEntity).findOneOrFail({ where: { role: 'INSTRUCTOR' } });
    const second = await projects.save(
      projects.create({
        slug: 'ledger-lab',
        title: 'Ledger Lab',
        platformOwned: false,
        ownerUserId: staff.id,
        isDefault: false,
        origin: 'upload',
      }),
    );
    await versions.save(
      versions.create({
        projectId: second.id,
        version: '1.0.0',
        status: 'published',
        manifest: source.manifest,
        compiled: {
          ...snapshot,
          slug: 'ledger-lab',
          version: '1.0.0',
          content: { ...snapshot.content, slug: 'ledger-lab', title: 'Ledger Lab', version: '1.0.0' },
        },
        sandboxBudget: source.sandboxBudget,
        publishedAt: new Date().toISOString(),
        publishedByUserId: staff.id,
      }),
    );
    await app.get(ProjectRegistryService).load();

    // It really is published and really is registered, so the assertions below
    // are about a resolution and not about a row nothing can see.
    expect(content.getProject('ledger-lab').title).toBe('Ledger Lab');
    expect(content.headVersionIdFor('ledger-lab')).toBeTruthy();

    // And the answer for a learner in no class is the same answer, version and
    // all. The flag is on the project the importer set it on; publishing does
    // not move it, and nothing here resolves by directory order or by which
    // row was written last.
    expect(await workflow.projectVersionForLearner(learner)).toEqual(before);
    const stillFlagged = await projects.find({ where: { isDefault: true } });
    expect(stillFlagged.map((row) => row.slug)).toEqual([slug]);

    // The coverage this file exists for, on the far side of a second project:
    // they still have somewhere to go, and it is still the same somewhere.
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set({ authorization: `Bearer ${newcomer.body.token}` })
      .send({ projectSlug: (before as { projectSlug: string }).projectSlug })
      .expect(201);
    expect(enrolled.body.projectSlug).toBe(slug);
    expect(enrolled.body.phases).toHaveLength(6);
  });

  /**
   * The catalogue is scoped per caller, checked with the second project
   * published and registered above.
   *
   * The catalogue test near the top of this file runs before any second
   * project exists, so it cannot tell a scoped catalogue from one that lists
   * everything. A
   * teacher's project reaches only learners of a class it is assigned to, and
   * its title, description and phase titles are part of it: a learner in no
   * class is listed their own project and nothing else, and asking for another
   * teacher's by name is answered exactly as a slug nobody published is.
   */
  it("a learner's catalogue never carries another teacher's project", async () => {
    expect(app.get(ContentService).getProject('ledger-lab').title).toBe('Ledger Lab');

    const listed = await request(http).get('/api/v1/projects').set(auth()).expect(200);
    const slugs = listed.body.map((p: any) => p.slug);
    expect(slugs[0]).toBe(slug);
    expect(slugs).not.toContain('ledger-lab');

    const hidden = await request(http).get('/api/v1/projects/ledger-lab').set(auth()).expect(404);
    const missing = await request(http).get('/api/v1/projects/no-such-pack').set(auth()).expect(404);
    expect(hidden.body.message).toBe('unknown project: ledger-lab');
    expect(missing.body.message).toBe('unknown project: no-such-pack');
    await request(http).get(`/api/v1/projects/${slug}`).set(auth()).expect(200);
  });

  it('a learner with no class always has somewhere to go', async () => {
    // `users.cohort` defaults to 'default', which cohort-scope.ts documents as
    // "not a class: it is the absence of one". Step 2 of the default-resolution order has
    // nothing to answer with for this learner, and the coverage this file
    // exists for is that they still land somewhere they can work.
    const user = await db.getRepository(UserEntity).findOne({ where: { id: userId } });
    expect(user?.cohort).toBe('default');

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: slug })
      .expect(201);
    expect(enrolled.body.projectSlug).toBe(slug);
    expect(enrolled.body.phases.length).toBe(6);

    const first = enrolled.body.phases.find((p: any) => p.order === 1);
    expect(first.key).toBe('requirements');
    expect(first.status).not.toBe('locked');
    await request(http).get(`/api/v1/phases/${first.id}`).set(auth()).expect(200);
  });

  it('enrols once; retrying returns the same project board', async () => {
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: slug })
      .expect(201);
    expect(enrolled.body.projectSlug).toBe(slug);
    expect(enrolled.body.phases.length).toBe(6);

    const retry = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: slug })
      .expect(201);
    expect(retry.body.id).toBe(enrolled.body.id);
  });

  /**
   * The request the browser sends names no project, so it cannot name the
   * wrong one.
   *
   * If naming the project were mandatory, the only slug the browser would have
   * to hand is whatever the tab remembered: on a shared machine, the previous
   * account's. A request that names nothing is answered with the project this
   * learner has been given; a request that names some other project is refused
   * in the same sentence whatever the slug is, so it cannot be used to find out
   * which projects this deployment holds.
   */
  it('starts the project the learner was given, named or not, and refuses any other', async () => {
    const unnamed = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({})
      .expect(201);
    expect(unnamed.body.projectSlug).toBe(slug);

    const refused = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: 'other-pack' })
      .expect(403);
    expect(refused.body.message).toBe(NOT_YOUR_PROJECT);
    expect(refused.body.message).not.toContain('other-pack');

    const held = await db.getRepository(EnrollmentEntity).find({ where: { userId } });
    expect(held).toHaveLength(1);
    expect(held[0].projectSlug).toBe(slug);
  });

  it('answers a request that names no project with the project it ships', async () => {
    // Whatever resolves the default, the answer a learner
    // gets with no `?project` is the board they get when they name their own
    // project, and that is what this asserts: against the catalogue rather
    // than against a slug typed in this file, so renaming the pack still has
    // to pass.
    const implied = await request(http).get('/api/v1/enrollments/mine').set(auth()).expect(200);
    const named = await request(http)
      .get(`/api/v1/enrollments/mine?project=${slug}`)
      .set(auth())
      .expect(200);

    expect(implied.body.projectSlug).toBe(slug);
    expect(implied.body.id).toBe(named.body.id);
  });

  it('answers for the project asked for, never for the one the learner happens to have', async () => {
    // ?project= is read rather than ignored, so a slug this learner is not on
    // comes back empty instead of quietly answering with their enrolment.
    const other = await request(http)
      .get('/api/v1/enrollments/mine?project=other-pack')
      .set(auth())
      .expect(200);
    expect(other.body.projectSlug).toBeUndefined();
    expect(other.body.id).toBeUndefined();
  });

  it('scopes analytics to the project asked for', async () => {
    // Every pack carries six phases with the same keys, so `projectSlug` is
    // the only field that tells two analytics answers apart. A slug this
    // learner is not on has to come back as that slug with nothing under it,
    // rather than as their own enrolment wearing someone else's name, which
    // is what answering with whichever enrolment the database yields first
    // would do.
    const named = await request(http)
      .get(`/api/v1/analytics/me?project=${slug}`)
      .set(auth())
      .expect(200);
    expect(named.body.projectSlug).toBe(slug);
    expect(named.body.totalPhases).toBe(6);

    const implied = await request(http).get('/api/v1/analytics/me').set(auth()).expect(200);
    expect(implied.body.projectSlug).toBe(slug);
    expect(implied.body.totalPhases).toBe(6);

    const other = await request(http)
      .get('/api/v1/analytics/me?project=other-pack')
      .set(auth())
      .expect(200);
    expect(other.body.projectSlug).toBe('other-pack');
    expect(other.body.totalPhases).toBe(0);
  });

  it('tells the workspace which project a phase belongs to', async () => {
    const mine = await request(http).get('/api/v1/enrollments/mine').set(auth()).expect(200);
    const firstPhase = mine.body.phases.find((p: any) => p.order === 1);

    const detail = await request(http)
      .get(`/api/v1/phases/${firstPhase.id}`)
      .set(auth())
      .expect(200);

    // Without this the workspace has to guess, and a bookmarked URL renders
    // the wrong phase rail.
    expect(detail.body.projectSlug).toBe(slug);
  });
});
