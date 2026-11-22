import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { API_CONTRACT_JSON, DESIGN_JSON, INHERITED_TASK_KEY, serialiseDesign, type Design, type PublishVersionResult } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { ContentService } from '../src/content/content.service';
import { ProjectImporterService } from '../src/content/importer.service';
import { MemoryPackSource } from '../src/content/memory-pack-source';
import { ProjectRegistryService } from '../src/content/project-registry.service';
import { UserEntity } from '../src/db/entities';
import { entriesOf } from './fixtures/upload-packs/archive';
import { mockAiForRoutes } from './mock-ai';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';
import { uploadPack } from './fixtures/paths';

/**
 * A pack with no Requirements phase: Shelf's
 * design-kind Design alone, at order 1. A teacher's copy of it publishes and is
 * assigned to a class, and a learner's Design submission is graded against the
 * phase's own stories list (SH-1 to SH-3), with no Requirements phase to read
 * stories from.
 */
const SHELF = uploadPack('shelf');

function designOnlyPack(slug: string): MemoryPackSource {
  const entries = entriesOf(SHELF).flatMap((entry) => {
    if (entry.name === 'project.json') {
      const project = JSON.parse(entry.data.toString('utf8'));
      return [{ name: entry.name, bytes: Buffer.from(JSON.stringify({ ...project, slug }, null, 2)) }];
    }
    // the folder layout (docs/authoring-format.md, "The archive layout"): the phase is its folder, numbered 01 by its place
    if (!entry.name.startsWith('phases/02-design/')) return [];
    return [{ name: entry.name.replace('phases/02-design/', 'phases/01-design/'), bytes: entry.data }];
  });
  return new MemoryPackSource(entries, slug);
}

const op = (id: string, name: string, story: string) => ({ id, name, inputs: ['id'], returns: 'Book', errors: [], satisfies: [story] });
const design = (stories: string[]): Design => ({
  entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [{ name: 'title', type: 'string' }], responsibilities: [], satisfies: [] }],
  relations: [],
  operations: stories.map((story, i) => op(`O${i + 1}`, `op${i + 1}(id)`, story)),
  decisions: [{ id: 'D1', title: 'Store', choice: 'memory', alternative: 'a database', rationale: 'one process', tradeOff: 'lost on restart', status: 'accepted', satisfies: [] }],
});
const api = JSON.stringify({
  operations: [
    { id: 'list', method: 'GET', path: '/api/books' },
    { id: 'lend', method: 'POST', path: '/api/books/1/loan', errors: ['book_not_found'] },
    { id: 'back', method: 'DELETE', path: '/api/books/1/loan', errors: ['book_not_found'] },
    { id: 'one', method: 'GET', path: '/api/books/1', errors: ['book_not_found'] },
  ],
  errors: { book_not_found: { status: 404, meaning: 'No book has that id.' } },
});

describe('a Design phase in a pack with no Requirements phase, end to end', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const stamp = Date.now();

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@design-alone.test`, password: 'Correct-Horse-9', displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return { id, token: registered.body.token as string };
  };

  const submit = async (token: string, phaseStateId: string): Promise<any> => {
    const submitted = await request(http).post(`/api/v1/phases/${phaseStateId}/tasks/${INHERITED_TASK_KEY}/submit`).set(bearer(token)).expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 100, intervalMs: 200, message: 'the Design submission did not finish' });
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]] }));
    db = app.get(DataSource);
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  it('publishes, is assigned, and grades a learner against the phase\'s own stories', async () => {
    const slug = `design-alone-${stamp}`;
    const imported = await new ProjectImporterService(app.get(ContentService), db).importPack(designOnlyPack(slug), { origin: 'seed', platformOwned: true });
    await app.get(ProjectRegistryService).load();

    const teacher = await account('design-alone-teacher', 'INSTRUCTOR');
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacher.token)).send({ name: `Class ${slug}` }).expect(201);
    const copySlug = `${slug}-copy`;
    const created = await request(http).post('/api/v1/instructor/projects').set(bearer(teacher.token))
      .send({ title: 'Shelf design alone', slug: copySlug, fromVersionId: imported.projectVersionId }).expect(201);
    const published = (await request(http)
      .post(`/api/v1/instructor/projects/${created.body.project.id}/versions/${created.body.draftVersionId}/publish`)
      .set(bearer(teacher.token)).send({ version: '1.0.0' }).expect(200)).body as PublishVersionResult;
    await request(http).put(`/api/v1/instructor/cohorts/${cohort.body.id}/project`).set(bearer(teacher.token))
      .send({ projectVersionId: published.versionId, reason: 'This class works a Design with no Requirements.' }).expect(200);

    const learner = await account('design-alone-learner');
    await request(http).post('/api/v1/enrollments/join').set(bearer(learner.token)).send({ code: cohort.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learner.token)).send({ projectSlug: copySlug }).expect(201);
    expect(enrolled.body.phases.map((one: any) => [one.key, one.order, one.status])).toEqual([['design', 1, 'in_progress']]);
    const phaseId = enrolled.body.phases[0].id as string;
    const detail = await request(http).get(`/api/v1/phases/${phaseId}`).set(bearer(learner.token)).expect(200);
    expect(detail.body.design.stories.map((one: { id: string }) => one.id)).toEqual(['SH-1', 'SH-2', 'SH-3']);

    // SH-3 untraced: the trace rule names it, read from the phase's own list
    await request(http).put(`/api/v1/phases/${phaseId}/workspace`).set(bearer(learner.token))
      .send({ files: { [DESIGN_JSON]: serialiseDesign(design(['SH-1', 'SH-2', 'SH-1'])), [API_CONTRACT_JSON]: api } }).expect(200);
    const short = await submit(learner.token, phaseId);
    const traceOf = (verdict: any) => (verdict.report.checks as { id: string; status: string; detail?: string }[]).find((check) => check.id === 'design.trace');
    expect(traceOf(short)).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(traceOf(short))).toContain('SH-3');

    // every listed story traced: the floor passes whole
    await request(http).put(`/api/v1/phases/${phaseId}/workspace`).set(bearer(learner.token))
      .send({ files: { [DESIGN_JSON]: serialiseDesign(design(['SH-1', 'SH-2', 'SH-3'])), [API_CONTRACT_JSON]: api } }).expect(200);
    const full = await submit(learner.token, phaseId);
    expect(traceOf(full)).toMatchObject({ status: 'passed' });
    const floor = (full.report.checks as { id: string; status: string }[]).filter((check) => check.id.startsWith('design.'));
    expect(floor.filter((check) => check.status !== 'passed')).toEqual([]);
  }, 180000);
});
