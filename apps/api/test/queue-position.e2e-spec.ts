import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PhaseStateEntity, UserEntity } from '../src/db/entities';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * A learner's place in the line, and the lab block on the console.
 *
 * The two routes are tested together because they are the two halves of the
 * same afternoon: the console tells forty people where to point a phone, and
 * the queue tells each of them that they are in a line rather than broken.
 *
 * The harness binds loopback and seeds no LAN address, so the lab route here
 * answers with the single-machine state: hosted: false, which is also the
 * state the Playwright suite runs in (`src/classroom/lab.ts`).
 */
describe('Queue position and the lab block (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;

  let anaToken = '';
  let leeToken = '';
  let kimToken = '';
  let leeRunId = '';
  let mondayCode = '';

  const asAna = () => ({ authorization: `Bearer ${anaToken}` });
  const asLee = () => ({ authorization: `Bearer ${leeToken}` });
  const asKim = () => ({ authorization: `Bearer ${kimToken}` });

  const staff = async (email: string, displayName: string): Promise<string> => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName })
      .expect(201);
    await dataSource.getRepository(UserEntity).update({ email }, { role: 'INSTRUCTOR' });
    return registered.body.token;
  };

  const learner = async (
    email: string,
    displayName: string,
    joinCode: string,
  ): Promise<{ token: string; phases: Record<string, string> }> => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName })
      .expect(201);
    const token = registered.body.token;
    const auth = { authorization: `Bearer ${token}` };
    await request(http).post('/api/v1/enrollments/join').set(auth).send({ code: joinCode }).expect(200);
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(auth)
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    return {
      token,
      phases: Object.fromEntries(enrolled.body.phases.map((p: any) => [p.key, p.id])),
    };
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));
    dataSource = app.get(DataSource);

    anaToken = await staff('lab-ana@learnsdlc.test', 'Ana');
    const monday = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(asAna())
      .send({ name: 'Monday class' })
      .expect(201);
    mondayCode = monday.body.joinCode;

    const lee = await learner('lab-lee@learnsdlc.test', 'Lee', mondayCode);
    leeToken = lee.token;
    const kim = await learner('lab-kim@learnsdlc.test', 'Kim', mondayCode);
    kimToken = kim.token;

    // A run row needs a phase the pack can run (the run route refuses
    // requirements with 400 before any row exists), so the
    // implementation phase is unlocked directly and run there.
    await dataSource.manager.update(
      PhaseStateEntity,
      { id: lee.phases.implementation },
      { status: 'in_progress' },
    );
    const run = await request(http)
      .post(`/api/v1/phases/${lee.phases.implementation}/run`)
      .set(asLee())
      .expect(201);
    leeRunId = run.body.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('tells a learner where their own run sits', async () => {
    const res = await request(http)
      .get(`/api/v1/queue/position?kind=run&id=${leeRunId}`)
      .set(asLee())
      .expect(200);
    expect(['queued', 'running', 'done']).toContain(res.body.state);
    expect(res.body.ahead === null || typeof res.body.ahead === 'number').toBe(true);
    expect(res.body.estimateSeconds === null || typeof res.body.estimateSeconds === 'number').toBe(
      true,
    );
  });

  /**
   * Without the ownership check the route is an oracle: it says whether an id
   * exists and how busy the person holding it is, which is a class watching
   * each other work.
   */
  it('will not tell one learner about another learner\'s run', async () => {
    await request(http)
      .get(`/api/v1/queue/position?kind=run&id=${leeRunId}`)
      .set(asKim())
      .expect(404);
  });

  it('answers 404 for an id that is nobody\'s and 400 for a kind that is not a kind', async () => {
    await request(http)
      .get('/api/v1/queue/position?kind=run&id=00000000-0000-4000-8000-000000000000')
      .set(asLee())
      .expect(404);
    await request(http).get('/api/v1/queue/position?kind=run&id=not-an-id').set(asLee()).expect(404);
    await request(http)
      .get(`/api/v1/queue/position?kind=telepathy&id=${leeRunId}`)
      .set(asLee())
      .expect(400);
  });

  it('keeps the lab block off a learner\'s screen', async () => {
    await request(http).get('/api/v1/instructor/lab').set(asLee()).expect(403);
  });

  it('gives an instructor a join link and a QR code for each of their classes', async () => {
    const res = await request(http).get('/api/v1/instructor/lab').set(asAna()).expect(200);
    expect(res.body.hosted).toBe(false);
    expect(res.body.unreachable).toBe('loopback');
    expect(res.body.origin).toBe('http://localhost:3000');
    expect(res.body.cohorts).toHaveLength(1);

    const [monday] = res.body.cohorts;
    const dashed = `${mondayCode.slice(0, 4)}-${mondayCode.slice(4)}`;
    expect(monday.name).toBe('Monday class');
    expect(monday.joinCode).toBe(dashed);
    expect(monday.joinUrl).toBe(`http://localhost:3000/join?code=${dashed}`);
    expect(monday.qrSvg).toContain('<svg');
    expect(monday.qrSvg).not.toContain('<script');
  });

  it('shows an instructor only their own classes', async () => {
    const boToken = await staff('lab-bo@learnsdlc.test', 'Bo');
    await request(http)
      .post('/api/v1/instructor/cohorts')
      .set({ authorization: `Bearer ${boToken}` })
      .send({ name: 'Friday class' })
      .expect((response) => {
        // Preserve a rare unexpected transport/application response without
        // replacing the strict201 assertion or printing fixture credentials.
        if (response.status !== 201) process.stderr.write(JSON.stringify({
          diagnostic: 'queue-position cohort creation',
          status: response.status,
          contentType: response.headers['content-type'],
          server: response.headers.server,
          response: response.text.slice(0, 2000),
        }) + '\n');
      })
      .expect(201);

    const mine = await request(http).get('/api/v1/instructor/lab').set(asAna()).expect(200);
    expect(mine.body.cohorts.map((c: any) => c.name)).toEqual(['Monday class']);
  });
});
