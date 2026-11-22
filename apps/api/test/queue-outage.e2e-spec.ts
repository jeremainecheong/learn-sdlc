import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { HttpTarget } from './support/http';

/**
 * Run with the queue down, end to end. With REDIS_URL pointed at a closed
 * port, pressing Run must still get an answer. Nothing else would give one:
 * ioredis carries a command across a reconnect rather than rejecting it, Nest
 * sets no request timeout, and the web's fetch has no abort signal, so the
 * learner would watch a button spin for as long as the tab stayed open. The
 * whole container is booted here, because the
 * claim is about what the route returns, not about the queue class.
 */
describe('The queue being unreachable (e2e)', () => {
  const savedRedisUrl = process.env.REDIS_URL;

  let app: INestApplication;
  let http: HttpTarget;
  let queueUnavailableMessage = '';
  let token = '';
  let phaseId = '';
  let runPhaseId = '';

  beforeAll(async () => {
    // config reads REDIS_URL once, at import, so the whole container has to be
    // required after it is set: that is also what selects the durable queue.
    process.env.REDIS_URL = 'redis://127.0.0.1:1/0';
    jest.resetModules();
    const { ValidationPipe } = require('@nestjs/common');
    const { Test } = require('@nestjs/testing');
    const { AppModule } = require('../src/app.module');
    queueUnavailableMessage = require('../src/jobs/bull.queue').QUEUE_UNAVAILABLE_MESSAGE;

    // Nothing is stubbed. This suite boots the container on
    // the production shape (a durable queue, the socket gateway's pub/sub
    // adapter and all) against a Redis that is not there, which is the point:
    // the claim is about what the route answers on that deployment, not about
    // the queue class in isolation.
    // The boot is written out here rather than through test/support/app.ts,
    // because it must use the modules required after the reset above.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'queue-outage@learnsdlc.test', password: 'Password1!', displayName: 'Outage Tester' })
      .expect(201);
    token = registered.body.token;

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set({ authorization: `Bearer ${token}` })
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    phaseId = enrolled.body.phases[0].id;
    // Run needs a phase the pack can run (the run route refuses requirements
    // with 400 before the queue is asked), so the implementation
    // phase is unlocked directly; Submit still goes to requirements.
    const { DataSource } = require('typeorm');
    const { PhaseStateEntity } = require('../src/db/entities');
    runPhaseId = enrolled.body.phases.find((p: any) => p.order === 3).id;
    await app.get(DataSource).manager.update(PhaseStateEntity, { id: runPhaseId }, { status: 'in_progress' });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    jest.resetModules();
  });

  it('boots on the durable queue, so this is the production shape', () => {
    const { JobsService } = require('../src/jobs/jobs.service');
    expect(app.get(JobsService).durable).toBe(true);
  });

  it('answers Run with a 503 the learner can act on, in seconds', async () => {
    const startedAt = Date.now();

    const res = await request(http)
      .post(`/api/v1/phases/${runPhaseId}/run`)
      .set({ authorization: `Bearer ${token}` })
      .expect(503);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(res.body.message).toBe(queueUnavailableMessage);
    // Nothing about our plumbing reaches the learner.
    expect(JSON.stringify(res.body)).not.toMatch(/redis|127\.0\.0\.1|ioredis|bullmq/i);
  }, 20_000);

  // This pins only that the route answers, not what becomes of the
  // submission row and the spent attempt on the way out.
  it('answers Submit the same way', async () => {
    const res = await request(http)
      .post(`/api/v1/phases/${phaseId}/submit`)
      .set({ authorization: `Bearer ${token}` })
      .expect(503);

    expect(res.body.message).toBe(queueUnavailableMessage);
  }, 20_000);
});
