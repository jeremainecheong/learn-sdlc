import { REQUIREMENTS_ARTEFACT } from '../../../e2e/golden-records';
import { EMPTY_STORY, serialiseStory, validateStoryRecord } from '@learnsdlc/shared';
import { INestApplication } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { mockAiForRoutes } from './mock-ai';
import { config } from '../src/config';
import { ContentService } from '../src/content/content.service';
// teacher-authored projects: the compiled grain the task routes resolve
// against. The versions below are installed rather than published, because
// what the routes have to be right about is the task list a pin resolves to,
// and publishing has suites of its own.
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../src/content/pack-compiler';
import type { ProjectContent } from '../src/content/content.types';
import { EnrollmentEntity, PhaseStateEntity, SubmissionEntity } from '../src/db/entities';
import { WorkflowService } from '../src/workflow/workflow.service';
import { HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The routes the phase panels read and write: revision and run history, the
 * learner's links, the incident drill, and the release a merge leaves behind.
 * Everything runs against the real container and an in-memory database, so a
 * route that a guard, a pipe or a repository would refuse fails here.
 */
describe('Phase panel routes (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;

  let token = '';
  let bystanderToken = '';
  let bystanderId = '';
  let phases: Record<string, string> = {};
  let strongSubmissionId = '';

  const auth = () => ({ authorization: `Bearer ${token}` });
  const asBystander = () => ({ authorization: `Bearer ${bystanderToken}` });

  const GOOD_STORY = REQUIREMENTS_ARTEFACT['requirements/story.json'];

  const MERGE_MESSAGE =
    'Wrote every criterion as given/when/then and named the boundary: due today is not yet overdue.';

  /**
   * A deployment a learner could hand in. The pack is two services, so a
   * finished workspace is a *pair*: the api image the smoke run builds, and the
   * compose file its selfcheck reads to answer "can web reach api". A
   * Dockerfile on its own cannot answer that, and a root `Dockerfile` is not a
   * file this phase ships at all: writing it is a 400.
   */
  const WORKING_API_DOCKERFILE =
    'FROM python:3.11-slim\nWORKDIR /app\nCOPY requirements.txt ./\nCOPY api/ ./api/\n' +
    'COPY ops/ ./ops/\nCOPY docker-compose.yml ./\n' +
    'RUN pip install --no-cache-dir -r requirements.txt\n' +
    'ENV TASKTRACKR_DB=/data/tasktrackr.db\nENV HOST=0.0.0.0\nENV PORT=8000\n' +
    'VOLUME ["/data"]\nEXPOSE 8000\nENTRYPOINT ["python3", "api/main.py"]\n';

  /** The pack's own compose file, read off disk so it cannot drift from it. */
  const WORKING_COMPOSE = fs.readFileSync(
    path.join(config.contentDir, 'tasktrackr', 'canonical', 'docker-compose.yml'),
    'utf-8',
  );

  const FINISHED_DEPLOYMENT = {
    'api/Dockerfile': WORKING_API_DOCKERFILE,
    'docker-compose.yml': WORKING_COMPOSE,
  };

  /** The deployment phase as the pack declares it, for the facts below. */
  const deploymentChecks = () => {
    const phase = app.get(ContentService).getPhase('tasktrackr', 'deployment');
    if (phase.checks.kind !== 'config') throw new Error('expected config checks');
    return { phase, checks: phase.checks, drill: app.get(ContentService).drillSpec(phase)! };
  };

  /**
   * sqlite stores a CreateDateColumn to the second, so two rows written inside
   * one tick carry the same timestamp and "oldest first" has nothing left to
   * order by. Real revisions are minutes apart; the suite waits out the tick
   * rather than asserting an order the storage cannot express.
   */
  const crossSecondBoundary = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 1100));
  };

  const submitAndWait = async (phaseId: string): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseId}/submit`)
      .set(auth())
      .expect(201);
    return waitForSubmission(http, auth(), submitted.body.id, { attempts: 80, intervalMs: 250, message: 'submission did not finish' });
  };

  /**
   * The same poll, for a submission that belongs to somebody other than this
   * suite's learner and whose verdict is not the assertion.
   * A terminal status is what keeps a grading job from outliving the app.
   */
  const pollToTerminal = async (id: string, headers: Record<string, string>): Promise<any> => {
    return waitForSubmission(http, headers, id, { attempts: 240, intervalMs: 250, message: 'submission did not finish' });
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], pipeline: 'prefix' }));
    dataSource = app.get(DataSource);

    const learner = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'panels@learnsdlc.test', password: 'Password1!', displayName: 'Panel Tester' })
      .expect(201);
    token = learner.body.token;

    const other = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'bystander@learnsdlc.test', password: 'Password1!', displayName: 'Bystander' })
      .expect(201);
    bystanderToken = other.body.token;
    bystanderId = other.body.user.id;

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    phases = Object.fromEntries(enrolled.body.phases.map((p: any) => [p.key, p.id]));
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  describe('GET /phases/:id/submissions and /runs', () => {
    it('answers a phase with no history with two empty lists', async () => {
      const submissions = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/submissions`)
        .set(auth())
        .expect(200);
      expect(submissions.body).toEqual([]);

      const runs = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/runs`)
        .set(auth())
        .expect(200);
      expect(runs.body).toEqual([]);
    });

    it('refuses a locked phase and another learner´s phase', async () => {
      await request(http)
        .get(`/api/v1/phases/${phases.design}/submissions`)
        .set(auth())
        .expect(403);
      await request(http)
        .get(`/api/v1/phases/${phases.requirements}/runs`)
        .set(asBystander())
        .expect(403);
      await request(http).get(`/api/v1/phases/${phases.requirements}/runs`).expect(401);
    });

    it('numbers the revisions oldest first and withholds the snapshots', async () => {
      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/workspace`)
        .set(auth())
        .send({ files: { 'requirements/story.json': serialiseStory({ ...EMPTY_STORY, capability: 'a fast overdue thing etc.' }) } })
        .expect(200);
      const weak = await submitAndWait(phases.requirements);
      expect(weak.passed).toBe(false);
      await crossSecondBoundary();

      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/workspace`)
        .set(auth())
        .send({ files: REQUIREMENTS_ARTEFACT })
        .expect(200);
      const strong = await submitAndWait(phases.requirements);
      expect(strong.passed).toBe(true);
      strongSubmissionId = strong.id;

      const list = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/submissions`)
        .set(auth())
        .expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.map((s: any) => s.attempt)).toEqual([1, 2]);
      expect(list.body[0].passed).toBe(false);
      expect(list.body[1].passed).toBe(true);
      // The list is for choosing a revision; the files come with the one chosen.
      expect(list.body.every((s: any) => s.workspaceSnapshot === undefined)).toBe(true);
    });

    it('serves the chosen revision with its attempt number and its files', async () => {
      const one = await request(http)
        .get(`/api/v1/submissions/${strongSubmissionId}?include=snapshot`)
        .set(auth())
        .expect(200);
      expect(one.body.attempt).toBe(2);
      // The record as the save stored it: validated and written back by `serialiseStory`.
      expect(one.body.workspaceSnapshot['requirements/story.json']).toBe(serialiseStory(validateStoryRecord(GOOD_STORY).story!));
    });

    it('leaves the files out of the poll response, which asks for a status', async () => {
      const polled = await request(http)
        .get(`/api/v1/submissions/${strongSubmissionId}`)
        .set(auth())
        .expect(200);
      expect(polled.body.attempt).toBe(2);
      expect(polled.body.status).toBe('completed');
      expect(polled.body.workspaceSnapshot).toBeUndefined();
    });

  });

  /**
   * The phase index and the project map. Downloading every open phase's whole
   * workspace so the browser could build the project map out of the files would
   * cost a learner with three open phases far more, on landing on Home, than the
   * 60 KB budget e2e/render-cost.spec.ts holds it to. The shell asks for the
   * index instead, and the API answers with the map.
   */
  describe('the landing pair: GET /phases/:id?view=summary and GET /projects/:slug/map', () => {
    it('answers the summary with every path, no bodies and no brief', async () => {
      const full = await request(http)
        .get(`/api/v1/phases/${phases.requirements}`)
        .set(auth())
        .expect(200);
      const summary = await request(http)
        .get(`/api/v1/phases/${phases.requirements}?view=summary`)
        .set(auth())
        .expect(200);

      expect(summary.body.view).toBe('summary');
      expect(full.body.view).toBe('full');
      expect(summary.body.files.map((f: any) => f.path)).toEqual(
        full.body.files.map((f: any) => f.path),
      );
      expect(summary.body.files.every((f: any) => f.content === '')).toBe(true);
      expect(summary.body.files.every((f: any) => typeof f.lines === 'number')).toBe(true);
      expect(summary.body.taskPanel).toBe('');
      // The whole point, on the wire: less than half the bytes.
      expect(JSON.stringify(summary.body).length * 2).toBeLessThan(
        JSON.stringify(full.body).length,
      );
    });

    it('leaves the default view alone, because the IDE opens files from it', async () => {
      const whole = await request(http)
        .get(`/api/v1/phases/${phases.requirements}`)
        .set(auth())
        .expect(200);
      expect(whole.body.files.every((f: any) => f.content.length > 0)).toBe(true);
      expect(whole.body.taskPanel.length).toBeGreaterThan(0);
      // An unknown view is the whole phase, not a refusal: a client that has
      // not heard of the summary gets the whole phase.
      const odd = await request(http)
        .get(`/api/v1/phases/${phases.requirements}?view=whatever`)
        .set(auth())
        .expect(200);
      expect(odd.body.view).toBe('full');
    });

    it('answers the map with the graph, folded or not, as the caller asks', async () => {
      const unfolded = await request(http)
        .get('/api/v1/projects/tasktrackr/map?compact=0&showLocked=0')
        .set(auth())
        .expect(200);
      const folded = await request(http)
        .get('/api/v1/projects/tasktrackr/map?compact=1&showLocked=1')
        .set(auth())
        .expect(200);

      expect(unfolded.body.nodes.length).toBeGreaterThan(0);
      expect(unfolded.body.nodes.some((n: any) => n.kind === 'placeholder')).toBe(false);
      // Folding is a different set of nodes, which is why the client cannot
      // make one shape out of the other and both are served.
      expect(folded.body.nodes.some((n: any) => n.kind === 'placeholder')).toBe(true);
      expect(folded.body.nodes.some((n: any) => String(n.id).startsWith('fold:'))).toBe(true);
      // And it is a fraction of the files it was derived from.
      const detail = await request(http)
        .get(`/api/v1/phases/${phases.requirements}`)
        .set(auth())
        .expect(200);
      expect(JSON.stringify(folded.body).length).toBeLessThan(
        JSON.stringify(detail.body).length * 3,
      );
    });

    it('is the signed-in learner and nobody else', async () => {
      await request(http).get('/api/v1/projects/tasktrackr/map').expect(401);
      // A learner who has not started the project has an empty graph rather
      // than a refusal: it is what the pages draw before a project is started.
      const stranger = await request(http)
        .get('/api/v1/projects/tasktrackr/map')
        .set(asBystander())
        .expect(200);
      expect(stranger.body).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('PUT /phases/:id/links', () => {
    it('stores the set and returns it on the phase', async () => {
      const saved = await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({
          links: [
            { from: 'test_overdue_boundary', to: 'US-4/AC-2', kind: 'verifies' },
            { from: 'test_completed_hidden', to: 'US-4/AC-3', kind: 'covers' },
          ],
        })
        .expect(200);
      expect(saved.body).toEqual({ saved: true });

      const detail = await request(http)
        .get(`/api/v1/phases/${phases.requirements}`)
        .set(auth())
        .expect(200);
      expect(detail.body.links).toHaveLength(2);
      expect(detail.body.links[0]).toMatchObject({
        from: 'test_overdue_boundary',
        to: 'US-4/AC-2',
        kind: 'verifies',
      });
      expect(typeof detail.body.links[0].at).toBe('string');
    });

    it('refuses a kind it does not know, an id that is prose, and more than 200 links', async () => {
      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({ links: [{ from: 'a', to: 'US-1', kind: 'proves' }] })
        .expect(400);

      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({ links: [{ from: 'x'.repeat(201), to: 'US-1', kind: 'verifies' }] })
        .expect(400);

      // Markup or a scheme in either end is refused at the door: every page
      // that draws links treats both ends as ids.
      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({
          links: [{ from: '<img src=x onerror=alert(1)>', to: 'US-1', kind: 'verifies' }],
        })
        .expect(400);
      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({ links: [{ from: 'test_overdue', to: 'javascript:alert(1)', kind: 'verifies' }] })
        .expect(400);

      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({
          links: Array.from({ length: 201 }, (_, i) => ({
            from: `t${i}`,
            to: 'US-1',
            kind: 'verifies',
          })),
        })
        .expect(400);

      // None of the refusals disturbed the set already stored.
      const detail = await request(http)
        .get(`/api/v1/phases/${phases.requirements}`)
        .set(auth())
        .expect(200);
      expect(detail.body.links).toHaveLength(2);
    });

    it('clears the set when the learner sends an empty one', async () => {
      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/links`)
        .set(auth())
        .send({ links: [] })
        .expect(200);
      const detail = await request(http)
        .get(`/api/v1/phases/${phases.requirements}`)
        .set(auth())
        .expect(200);
      expect(detail.body.links).toEqual([]);
    });
  });

  describe('PUT /phases/:id/workspace with a key an object cannot be given', () => {
    it('answers 400, not 500, to a constructor key, and refuses a __proto__ key outright', async () => {
      const constructorKey = await request(http)
        .put(`/api/v1/phases/${phases.requirements}/workspace`)
        .set(auth())
        .send({ files: { constructor: 'x' } })
        .expect(400);
      expect(String(constructorKey.body.message)).not.toMatch(/internal/i);

      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/workspace`)
        .set(auth())
        .set('content-type', 'application/json')
        .send('{"files":{"__proto__":{"polluted":1},"requirements/story.json":"x"}}')
        .expect(400);

      // The process is still up and the route still answers an honest save.
      await request(http)
        .put(`/api/v1/phases/${phases.requirements}/workspace`)
        .set(auth())
        .send({ files: REQUIREMENTS_ARTEFACT })
        .expect(200);
    });
  });

  describe('POST /phases/:id/run on a phase that cannot run', () => {
    it('is refused before a row exists, so no failed attempt is minted', async () => {
      const before = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/runs`)
        .set(auth())
        .expect(200);

      const refused = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/run`)
        .set(auth())
        .expect(400);
      expect(String(refused.body.message)).toContain('nothing to run');

      const after = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/runs`)
        .set(auth())
        .expect(200);
      expect(after.body).toHaveLength(before.body.length);
    });
  });

  describe('POST /phases/:id/advance', () => {
    it('leaves a release record the enrolment can read', async () => {
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/reflect`)
        .set(auth())
        .send({ reflection: MERGE_MESSAGE })
        .expect(201);

      const advanced = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/advance`)
        .set(auth())
        .expect(201);
      expect(advanced.body.releases).toHaveLength(1);
      expect(advanced.body.releases[0]).toMatchObject({
        version: 'v1',
        phaseKey: 'requirements',
        phaseOrder: 1,
        notes: MERGE_MESSAGE,
      });
      expect(advanced.body.releases[0].score).toBeGreaterThanOrEqual(70);

      const mine = await request(http)
        .get('/api/v1/enrollments/mine?project=tasktrackr')
        .set(auth())
        .expect(200);
      expect(mine.body.releases.map((r: any) => r.version)).toEqual(['v1']);
    });

    it('does not write a second record when advance is called again', async () => {
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/advance`)
        .set(auth())
        .expect(201);
      const mine = await request(http)
        .get('/api/v1/enrollments/mine?project=tasktrackr')
        .set(auth())
        .expect(200);
      expect(mine.body.releases).toHaveLength(1);
    });
  });

  describe('the incident drill', () => {
    beforeAll(async () => {
      // The drill lives in the deployment phase; unlocking it here keeps this
      // suite off the four phases in between, which have their own coverage.
      await dataSource.manager.update(
        PhaseStateEntity,
        { id: phases.deployment },
        { status: 'in_progress' },
      );
    });

    it('refuses every drill route on a phase that declares no drill', async () => {
      const incident = {
        rootCause: 'The working directory and the entrypoint disagreed.',
        fix: 'Pointed the entrypoint at the working directory the image uses.',
        actionItem: 'Smoke the built image in CI before the release job runs.',
      };
      // A locked phase is refused by the gate before the drill is consulted.
      await request(http)
        .post(`/api/v1/phases/${phases.testing}/drill/start`)
        .set(auth())
        .expect(403);

      const started = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/drill/start`)
        .set(auth())
        .expect(400);
      expect(started.body.message).toMatch(/no incident drill/);

      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/drill/health`)
        .set(auth())
        .expect(400);
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/drill/resolve`)
        .set(auth())
        .send({ incident })
        .expect(400);

      // And an unlocked phase that simply declares no drill says so too.
      const design = await request(http)
        .post(`/api/v1/phases/${phases.design}/drill/start`)
        .set(auth())
        .expect(400);
      expect(design.body.message).toMatch(/no incident drill/);
    });

    it('pages the learner with the failure the faulted container produced', async () => {
      const paged = await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/start`)
        .set(auth())
        .expect(200);

      // The fault reported is the fault the pack declares, read from the pack
      // rather than typed here: rename it and this still has to pass.
      expect(paged.body.fault).toBe(deploymentChecks().drill.fault);
      expect(paged.body.pagedAt).toEqual(expect.any(String));
      expect(paged.body.resolvedAt).toBeNull();
      expect(paged.body.incident).toBeNull();
      // The page is not empty: this learner has written nothing yet, so what
      // stops their container first is their own unfinished Dockerfile, and
      // the page says which directive is missing rather than nothing at all.
      expect(paged.body.beforeStderr).toMatch(/ENTRYPOINT|CMD/);
      // TaskTrackr 5.0.0's runbook is the record: no runbook text is kept at paging, and the incident is written into the record.
      expect(paged.body.runbookBefore).toBeNull();

      const detail = await request(http)
        .get(`/api/v1/phases/${phases.deployment}`)
        .set(auth())
        .expect(200);
      expect(detail.body.drill.fault).toBe(deploymentChecks().drill.fault);
    }, 120000);

    it('reports the unfinished container as a failing health check', async () => {
      const health = await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/health`)
        .set(auth())
        .expect(200);
      expect(health.body.exit).toBe(1);
      expect(health.body.stderr).not.toBe('');
    }, 120000);

    it('refuses to close the incident while the container still does not start', async () => {
      const refused = await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/resolve`)
        .set(auth())
        .send({
          incident: {
            rootCause: 'The entrypoint pointed at a path the image never creates.',
            fix: 'I changed the ENTRYPOINT so it matches the WORKDIR.',
            actionItem: 'Add a container smoke step to CI before the release job.',
          },
        })
        .expect(409);
      expect(refused.body.message).toMatch(/smoke check still fails/);

      const detail = await request(http)
        .get(`/api/v1/phases/${phases.deployment}`)
        .set(auth())
        .expect(200);
      expect(detail.body.drill.resolvedAt).toBeNull();
      expect(detail.body.drill.incident).toBeNull();
    }, 120000);

    it('refuses a write-up too short to say anything', async () => {
      await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/resolve`)
        .set(auth())
        .send({ incident: { rootCause: 'broke', fix: 'fixed it', actionItem: 'watch it' } })
        .expect(400);
    });

    it('closes the incident once the container starts again', async () => {
      await request(http)
        .put(`/api/v1/phases/${phases.deployment}/workspace`)
        .set(auth())
        .send({ files: FINISHED_DEPLOYMENT })
        .expect(200);

      const health = await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/health`)
        .set(auth())
        .expect(200);
      expect(health.body.exit).toBe(0);
      // what the pack says a working deployment prints, not a string typed here
      expect(health.body.stdout).toContain(deploymentChecks().checks.expectInOutput);

      const resolved = await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/resolve`)
        .set(auth())
        .send({
          incident: {
            rootCause: 'API_URL named localhost, so the web service dialled its own container.',
            fix: 'Pointed API_URL at the api service the compose file declares.',
            actionItem: 'Add a container smoke step to CI before the release job.',
          },
        })
        .expect(200);

      expect(resolved.body.resolvedAt).toEqual(expect.any(String));
      expect(resolved.body.fixAppliedAt).toEqual(expect.any(String));
      expect(resolved.body.incident.rootCause).toContain('API_URL named localhost');

      const detail = await request(http)
        .get(`/api/v1/phases/${phases.deployment}`)
        .set(auth())
        .expect(200);
      expect(detail.body.drill.incident.actionItem).toContain('smoke step');
    }, 180000);

    it('lists the runs the drill left behind, oldest first', async () => {
      const queued = await request(http)
        .post(`/api/v1/phases/${phases.deployment}/run`)
        .set(auth())
        .expect(201);
      for (let i = 0; i < 80; i += 1) {
        const res = await request(http)
          .get(`/api/v1/runs/${queued.body.id}`)
          .set(auth())
          .expect(200);
        if (res.body.status === 'completed' || res.body.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 250));
      }

      const runs = await request(http)
        .get(`/api/v1/phases/${phases.deployment}/runs`)
        .set(auth())
        .expect(200);
      expect(runs.body).toHaveLength(1);
      expect(runs.body[0]).toMatchObject({ id: queued.body.id, kind: 'run', status: 'completed' });
      expect(runs.body[0].result.stdout).toContain(deploymentChecks().checks.expectInOutput);

      // The run list is the learner's own: nobody else can read it.
      await request(http)
        .get(`/api/v1/phases/${phases.deployment}/runs`)
        .set(asBystander())
        .expect(403);
    }, 180000);

    it('keeps another learner out of the drill entirely', async () => {
      await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/start`)
        .set(asBystander())
        .expect(403);
      await request(http)
        .post(`/api/v1/phases/${phases.deployment}/drill/health`)
        .set(asBystander())
        .expect(403);
    });
  });

  describe('the drill, for a learner whose container already starts', () => {
    let shipped = '';
    let deployment = '';
    const asShipped = () => ({ authorization: `Bearer ${shipped}` });

    const INCIDENT = {
      rootCause: 'API_URL named localhost, so the web service dialled its own container.',
      fix: 'Pointed API_URL at the api service the compose file declares.',
      actionItem: 'Add a container smoke step to CI before the release job.',
    };

    beforeAll(async () => {
      // The pack tells the learner to start the drill once their build check
      // is green, so this is the ordinary case: a finished Dockerfile before
      // the page. Their phase is unlocked here rather than played through the
      // four phases in between, which have their own coverage.
      const learner = await request(http)
        .post('/api/v1/auth/register')
        .send({ email: 'shipped@learnsdlc.test', password: 'Password1!', displayName: 'Already Shipping' })
        .expect(201);
      shipped = learner.body.token;

      const enrolled = await request(http)
        .post('/api/v1/enrollments')
        .set(asShipped())
        .send({ projectSlug: 'tasktrackr' })
        .expect(201);
      deployment = enrolled.body.phases.find((p: any) => p.key === 'deployment').id;
      await dataSource.manager.update(
        PhaseStateEntity,
        { id: deployment },
        { status: 'in_progress' },
      );
      await request(http)
        .put(`/api/v1/phases/${deployment}/workspace`)
        .set(asShipped())
        .send({ files: FINISHED_DEPLOYMENT })
        .expect(200);
    }, 120000);

    it('stamps the pack the enrolment was cut from', async () => {
      const state = await dataSource.manager.findOneByOrFail(PhaseStateEntity, { id: deployment });
      const enrollment = await dataSource.manager.findOneByOrFail(EnrollmentEntity, {
        id: state.enrollmentId,
      });
      expect(enrollment.packVersion).toBe(
        app.get(ContentService).getProject('tasktrackr').version,
      );
    });

    it('will not close the incident until a check has gone from failing to passing', async () => {
      const paged = await request(http)
        .post(`/api/v1/phases/${deployment}/drill/start`)
        .set(asShipped())
        .expect(200);
      // The learner is paged with the failure, not with an empty panel. Their
      // container starts, so the run reaches the runner and the pack's own
      // sentence is the whole of the evidence there is, and this pack's
      // selfcheck prints it on STDOUT before exiting 1, which is why the route
      // has to read stdout as well as stderr.
      expect(paged.body.beforeStderr).toContain('API_URL');
      // The paged run is the drill's red, and it is recorded rather than assumed.
      expect(paged.body.pagedExit).toBe(1);

      // Their container starts, so the smoke run at resolve passes, and the
      // write-up is still refused, because nothing has been checked.
      const refused = await request(http)
        .post(`/api/v1/phases/${deployment}/drill/resolve`)
        .set(asShipped())
        .send({ incident: INCIDENT })
        .expect(409);
      expect(refused.body.message).toMatch(/from failing to passing/);

      const open = await request(http)
        .get(`/api/v1/phases/${deployment}`)
        .set(asShipped())
        .expect(200);
      expect(open.body.drill.resolvedAt).toBeNull();
      expect(open.body.drill.incident).toBeNull();
      expect(open.body.drill.fixAppliedAt).toBeNull();
    }, 180000);

    it('accepts it once they have run the health check against their own files', async () => {
      const health = await request(http)
        .post(`/api/v1/phases/${deployment}/drill/health`)
        .set(asShipped())
        .expect(200);
      expect(health.body.exit).toBe(0);
      expect(health.body.stdout).toContain(deploymentChecks().checks.expectInOutput);

      const resolved = await request(http)
        .post(`/api/v1/phases/${deployment}/drill/resolve`)
        .set(asShipped())
        .send({ incident: INCIDENT })
        .expect(200);
      expect(resolved.body.resolvedAt).toEqual(expect.any(String));
      expect(resolved.body.fixAppliedAt).toEqual(expect.any(String));
      // The learner's own Dockerfile is the one they wrote, start to finish.
      const detail = await request(http)
        .get(`/api/v1/phases/${deployment}`)
        .set(asShipped())
        .expect(200);
      const dockerfile = detail.body.files.find((f: any) => f.path === 'api/Dockerfile');
      expect(dockerfile.content).toBe(WORKING_API_DOCKERFILE);
      const compose = detail.body.files.find((f: any) => f.path === 'docker-compose.yml');
      expect(compose.content).toBe(WORKING_COMPOSE);
    }, 180000);
  });

  /* ------------------ the commit message and the run clock ------------------ */

  describe('POST /phases/:id/submit and the words on the revision', () => {
    it('still grades a submit with no body at all, and records no message', async () => {
      // The case that protects every caller that posts no message: the
      // journey script, several e2e specs, the stress scripts and the demo
      // script. A required message would break all of them.
      await crossSecondBoundary();
      const graded = await submitAndWait(phases.requirements);

      expect(graded.status).toBe('completed');
      expect(graded.commitMessage).toBeNull();
    }, 120000);

    it('carries the message onto the revision list', async () => {
      await crossSecondBoundary();
      const submitted = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/submit`)
        .set(auth())
        .send({ message: '  Name the boundary: due today is not overdue  ' })
        .expect(201);
      expect(submitted.body.commitMessage).toBe('Name the boundary: due today is not overdue');

      const list = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/submissions`)
        .set(auth())
        .expect(200);
      const mine = list.body.find((s: any) => s.id === submitted.body.id);
      expect(mine.commitMessage).toBe('Name the boundary: due today is not overdue');
      // Every earlier revision reads as one with no message, which is what it is.
      expect(list.body.filter((s: any) => s.commitMessage === null).length).toBeGreaterThan(0);
    }, 120000);

    it('refuses a message that is not one line, and submits nothing', async () => {
      const before = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/submissions`)
        .set(auth())
        .expect(200);

      const long = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/submit`)
        .set(auth())
        .send({ message: 'x'.repeat(141) })
        .expect(400);
      expect(String(long.body.message)).toContain('a commit message is one line of at most 140 characters');

      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/submit`)
        .set(auth())
        .send({ message: 'first line\nsecond line' })
        .expect(400);

      const after = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/submissions`)
        .set(auth())
        .expect(200);
      expect(after.body).toHaveLength(before.body.length);
    });
  });

  describe('PUT /phases/:id/clock', () => {
    let testing = '';

    beforeAll(async () => {
      // The learner has not reached phase 4 in this suite, and the clock is a
      // property of the phase rather than of the gate, so the row is opened
      // directly rather than by grading three phases to get there.
      testing = phases.testing;
      await dataSource.getRepository(PhaseStateEntity).update(testing, { status: 'in_progress' });
    });

    it('pins the day, and the phase carries it back', async () => {
      const saved = await request(http)
        .put(`/api/v1/phases/${testing}/clock`)
        .set(auth())
        .send({ date: '2026-03-01' })
        .expect(200);
      expect(saved.body).toEqual({ saved: true, runClock: '2026-03-01' });

      const detail = await request(http).get(`/api/v1/phases/${testing}`).set(auth()).expect(200);
      expect(detail.body.runClock).toBe('2026-03-01');
    });

    it('clears back to the machine’s clock', async () => {
      const cleared = await request(http)
        .put(`/api/v1/phases/${testing}/clock`)
        .set(auth())
        .send({ date: null })
        .expect(200);
      expect(cleared.body).toEqual({ saved: true, runClock: null });
    });

    it('refuses a phase that is not the testing phase', async () => {
      const refused = await request(http)
        .put(`/api/v1/phases/${phases.requirements}/clock`)
        .set(auth())
        .send({ date: '2026-03-01' })
        .expect(400);
      expect(String(refused.body.message)).toContain('the run clock belongs to the testing phase');
    });

    it('refuses anything that is not a date, and another learner’s phase', async () => {
      const bad = await request(http)
        .put(`/api/v1/phases/${testing}/clock`)
        .set(auth())
        .send({ date: '1 March 2026' })
        .expect(400);
      expect(String(bad.body.message)).toContain('pin the clock to a date, as 2026-03-01');

      await request(http)
        .put(`/api/v1/phases/${testing}/clock`)
        .set(asBystander())
        .send({ date: '2026-03-01' })
        .expect(403);
      await request(http).put(`/api/v1/phases/${testing}/clock`).send({ date: '2026-03-01' }).expect(401);
    });
  });

  /**
   * The task routes, and the three kept phase-level ones.
   *
   * **This block installs a second and a third project and must therefore be
   * the last one in the file.** `installVersions` replaces the catalogue, and
   * the shipped project is re-installed under its own version id beside the two
   * copies so that the enrolment every test above works from resolves exactly
   * what it resolved before.
   *
   * Two shapes, and the first matters more than the second:
   *
   * - **`ms-tan-main`**: every phase holding **one authored task keyed
   *   `main`**, of every kind, which is what every teacher-authored project
   *   is. The three kept routes have to serve it. Defaulting their key
   *   to `SOLE_TASK_KEY` would answer 404 *"unknown task"* on every phase of
   *   every teacher project, because `soleTaskList` is false for a one-task
   *   list keyed `main` and `find('')` matches nothing.
   * - **`ms-tan-split`**: Requirements holding three tasks, which is what the
   *   kept routes refuse by name rather than picking one.
   *
   * The copies are installed rather than published: the routes are about the
   * task list a pin resolves to, and publishing has suites of its own.
   * `enroll` pins to the head of the slug it is given, so the
   * enrolments below hold exactly these lists.
   */
  describe('the task routes, and the three kept phase-level ones', () => {
    const MAIN_SLUG = 'ms-tan-main';
    const SPLIT_SLUG = 'ms-tan-split';
    const KEYS = [
      'requirements',
      'design',
      'implementation',
      'testing',
      'deployment',
      'maintenance',
    ];
    /** The refusal, spelled out, because the keys are what makes it actionable. */
    const SPLIT_REFUSAL = 'This phase has 3 tasks. Submit one of them: story, criteria, scope.';

    /** The teacher's learner. The suite's own learner is on none of these projects. */
    const asTeacherLearner = asBystander;

    let mainPhases: Record<string, string> = {};
    let splitRequirements = '';

    /** One authored task per phase, keyed `main`: what a copied project compiles to. */
    const mainTasks = (project: ProjectContent): CompiledPhaseTasks[] =>
      project.phases.map((one) => ({
        key: one.key,
        tasks: [{ ...soleTaskFor(one), taskKey: 'main' }],
      }));

    /** The same, with Requirements split three ways: two required and one not. */
    const splitTasks = (project: ProjectContent): CompiledPhaseTasks[] =>
      mainTasks(project).map((phase) => {
        if (phase.key !== 'requirements') return phase;
        const sole = phase.tasks[0];
        const at = (taskKey: string, order: number, required: boolean): CompiledTask => ({
          ...sole,
          taskKey,
          order,
          required,
          title: taskKey,
        });
        return {
          key: phase.key,
          tasks: [at('story', 1, true), at('criteria', 2, true), at('scope', 3, false)],
        };
      });

    beforeAll(async () => {
      const content = app.get(ContentService);
      const shipped = content.getProject('tasktrackr');
      const shippedId = content.headVersionIdFor('tasktrackr');
      if (!shippedId) throw new Error('the shipped project is not installed from a version row');
      const main: ProjectContent = { ...shipped, slug: MAIN_SLUG, title: 'Ms Tan — TaskTrackr' };
      const split: ProjectContent = {
        ...shipped,
        slug: SPLIT_SLUG,
        title: 'Ms Tan — TaskTrackr (split)',
      };
      content.installVersions([
        {
          versionId: shippedId,
          content: shipped,
          compiler: COMPILER_IDENTITY,
          phases: shipped.phases.map((one) => ({ key: one.key, tasks: [soleTaskFor(one)] })),
        },
        {
          versionId: 'v-ms-tan-main',
          content: main,
          compiler: COMPILER_IDENTITY,
          phases: mainTasks(main),
        },
        {
          versionId: 'v-ms-tan-split',
          content: split,
          compiler: COMPILER_IDENTITY,
          phases: splitTasks(split),
        },
      ]);

      // Written through the service rather than posted to `/enrollments`.
      // What this block needs is one learner holding boards on two
      // teacher-authored projects at once, and the route will not write that:
      // it enrols a learner into the project the server resolves for **them**
      // (their class's assignment, else the deployment's default) and
      // refuses any other slug, which is the whole point of it. Manufacturing
      // a fixture is not a learner pressing Start, so it says so.
      const workflow = app.get(WorkflowService);
      const enrolledMain = await workflow.enroll(bystanderId, MAIN_SLUG);
      mainPhases = Object.fromEntries(enrolledMain.phases.map((one: any) => [one.key, one.id]));
      // The gate is not this block's subject and grading five phases to reach
      // the sixth is not how to test a route, so every room is opened directly:
      // the same move `PUT /phases/:id/clock` above makes for the same reason.
      await dataSource
        .getRepository(PhaseStateEntity)
        .update({ enrollmentId: enrolledMain.id }, { status: 'in_progress' });

      const enrolledSplit = await workflow.enroll(bystanderId, SPLIT_SLUG);
      splitRequirements = enrolledSplit.phases.find(
        (one: any) => one.key === 'requirements',
      )!.id;
    }, 120000);

    it('the three kept routes refuse a multi-task phase by name', async () => {
      // Naming the keys rather than picking one, because picking one is how a
      // learner's work goes to the wrong grader, and a 400 that says which
      // keys exist is a refusal a journey script or a stale tab can act on.
      const submitted = await request(http)
        .post(`/api/v1/phases/${splitRequirements}/submit`)
        .set(asTeacherLearner())
        .expect(400);
      expect(String(submitted.body.message)).toBe(SPLIT_REFUSAL);

      const listed = await request(http)
        .get(`/api/v1/phases/${splitRequirements}/submissions`)
        .set(asTeacherLearner())
        .expect(400);
      expect(String(listed.body.message)).toBe(SPLIT_REFUSAL);

      const door = await request(http)
        .get(`/api/v1/phases/${splitRequirements}/solution`)
        .set(asTeacherLearner())
        .expect(400);
      expect(String(door.body.message)).toBe(SPLIT_REFUSAL);

      // And nothing was graded on the way to the refusal.
      const rows = await dataSource
        .getRepository(SubmissionEntity)
        .count({ where: { phaseStateId: splitRequirements } });
      expect(rows).toBe(0);
    });

    it('the three kept routes serve a teacher-authored one-task phase, of every kind', async () => {
      // Every phase of the copy, of every kind: one authored task keyed `main`,
      // and the kept route answers it rather than 404 "unknown task".
      for (const key of KEYS) {
        const listed = await request(http)
          .get(`/api/v1/phases/${mainPhases[key]}/submissions`)
          .set(asTeacherLearner())
          .expect(200);
        expect(listed.body).toEqual([]);
      }

      const submitted = await request(http)
        .post(`/api/v1/phases/${mainPhases.requirements}/submit`)
        .set(asTeacherLearner())
        .expect(201);
      // The revision is recorded against the phase's only task. Read off the
      // row rather than off the body, so the assertion is about what was
      // stored rather than what `FeedbackService.toView` reports.
      const stored = await dataSource
        .getRepository(SubmissionEntity)
        .findOneByOrFail({ id: submitted.body.id });
      expect(stored.taskKey).toBe('main');

      const graded = await pollToTerminal(submitted.body.id, asTeacherLearner());
      expect(['completed', 'failed']).toContain(graded.status);

      const after = await request(http)
        .get(`/api/v1/phases/${mainPhases.requirements}/submissions`)
        .set(asTeacherLearner())
        .expect(200);
      expect(after.body).toHaveLength(1);
      expect(after.body[0].attempt).toBe(1);
    }, 180000);

    it('the new routes carry the same ownership check', async () => {
      // `loadOwnedState` is the product's one ownership check and these routes
      // take it rather than a second copy: another learner's phase state is
      // 403 and no token at all is 401, on both of these routes and on the
      // per-task door beside them.
      await request(http)
        .post(`/api/v1/phases/${mainPhases.requirements}/tasks/main/submit`)
        .set(auth())
        .expect(403);
      await request(http)
        .get(`/api/v1/phases/${mainPhases.requirements}/tasks/main/submissions`)
        .set(auth())
        .expect(403);
      await request(http)
        .get(`/api/v1/phases/${mainPhases.requirements}/tasks/main/solution`)
        .set(auth())
        .expect(403);
      await request(http)
        .get(`/api/v1/phases/${mainPhases.requirements}/tasks/main/submissions`)
        .expect(401);

      // And a plain learner reaches their own, which is the statement that no
      // route here carries `@Roles`.
      const mine = await request(http)
        .get(`/api/v1/phases/${mainPhases.requirements}/tasks/main/submissions`)
        .set(asTeacherLearner())
        .expect(200);
      expect(Array.isArray(mine.body)).toBe(true);

      // A key the pinned version does not declare is 404 in `getPhase`'s own
      // register, never a silent fall back to some other task.
      const unknown = await request(http)
        .get(`/api/v1/phases/${mainPhases.requirements}/tasks/story/submissions`)
        .set(asTeacherLearner())
        .expect(404);
      // The register's own shape, `unknown phase: <key>` one grain down, and
      // the same sentence the per-task submit answers for the same key: one
      // resolution serves both, so the two cannot answer differently.
      expect(String(unknown.body.message)).toBe('unknown task: story');
    });

    it('the per-task route grades the task it names', async () => {
      const submitted = await request(http)
        .post(`/api/v1/phases/${splitRequirements}/tasks/scope/submit`)
        .set(asTeacherLearner())
        .expect(201);
      const stored = await dataSource
        .getRepository(SubmissionEntity)
        .findOneByOrFail({ id: submitted.body.id });
      expect(stored.taskKey).toBe('scope');

      await pollToTerminal(submitted.body.id, asTeacherLearner());

      // The revision list is per task: `scope` has one and its siblings have
      // none, because a revision list is a list of tries at one piece of work
      // and its attempt numbers say "my third try at this".
      const scope = await request(http)
        .get(`/api/v1/phases/${splitRequirements}/tasks/scope/submissions`)
        .set(asTeacherLearner())
        .expect(200);
      expect(scope.body).toHaveLength(1);
      const story = await request(http)
        .get(`/api/v1/phases/${splitRequirements}/tasks/story/submissions`)
        .set(asTeacherLearner())
        .expect(200);
      expect(story.body).toEqual([]);
    }, 180000);

    it('the kept revision list is not empty for a pre-3a teacher-project phase', async () => {
      // Key adoption at the route. A stored revision can carry the key `''`
      // while every phase of a teacher-authored project declares `main`, so a
      // learner's older passing revisions can hold a key the kept route's
      // narrow cannot see. The adoption is what gives them the key
      // the pinned version declares, and this is the end-to-end statement that
      // the two meet: a revision the learner made is theirs to read back.
      const phaseStateId = mainPhases.design;
      const state = await dataSource
        .getRepository(PhaseStateEntity)
        .findOneByOrFail({ id: phaseStateId });
      const rows = dataSource.getRepository(SubmissionEntity);
      const orphan = await rows.save(
        rows.create({
          phaseStateId,
          userId: state.userId,
          taskKey: '',
          status: 'completed',
          score: 90,
          passed: true,
        }),
      );

      // The room read, which is what every learner makes on the way in and is
      // where the board is repaired: this route is not: `loadOwnedState`
      // stamps the pack and leaves the board to the reads that describe it, so
      // the adoption's window is one board read wide and the list below is
      // empty until it closes. The dashboard's summaries and the enrolment
      // view close it too, and so does the learner's first submit.
      await request(http)
        .get(`/api/v1/phases/${phaseStateId}`)
        .set(asTeacherLearner())
        .expect(200);

      const listed = await request(http)
        .get(`/api/v1/phases/${phaseStateId}/submissions`)
        .set(asTeacherLearner())
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].id).toBe(orphan.id);
      expect(listed.body[0].attempt).toBe(1);

      // And the row itself now carries the key the pinned version declares, so
      // `strictPass`' narrow finds it and `advance` is not refused for ever.
      expect((await rows.findOneByOrFail({ id: orphan.id })).taskKey).toBe('main');
    });
  });
});
