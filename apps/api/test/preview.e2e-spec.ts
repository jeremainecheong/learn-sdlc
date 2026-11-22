import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuditEventEntity, PhaseStateEntity } from '../src/db/entities';
import { previewDoorCors } from '../src/preview/preview-proxy.controller';
import { HttpTarget } from './support/http';

/**
 * The live preview, end to end.
 *
 * This is the whole design in one walk: the API starts the learner's own
 * application inside the runner, the runner serves it back through the UNIX
 * socket, and a browser-shaped request comes in through one public door with a
 * capability in its path and nothing else. Nothing here mocks the runner
 * (that would prove the plumbing and not the product) so it needs the
 * pre-baked dependency layer, and says so rather than failing when it is
 * missing.
 */

const RUNTIME = path.resolve(__dirname, '..', 'runner', 'runtime');
const PREBAKED = fs.existsSync(path.join(RUNTIME, 'manifest.json'));
const describeWithPrebake = PREBAKED ? describe : describe.skip;

if (!PREBAKED) {
  console.warn(
    'preview.e2e-spec: skipped, because the sandbox dependencies are not built on this machine. Run npm run prebake.',
  );
}

describeWithPrebake('The live preview (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;
  let socketDir = '';

  let token = '';
  let otherToken = '';
  let implementation = '';
  let otherPhase = '';
  let url = '';

  const auth = () => ({ authorization: `Bearer ${token}` });
  const asOther = () => ({ authorization: `Bearer ${otherToken}` });

  beforeAll(async () => {
    // Its own socket, in its own directory: this suite starts a real serve.py
    // and must not adopt or disturb a runner anything else is using.
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdlc-preview-e2e-'));
    process.env.PREVIEW_SOCKET = path.join(socketDir, 'preview.sock');
    process.env.PREVIEW_SESSIONS = '2';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(previewDoorCors());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
    dataSource = app.get(DataSource);

    const learner = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'preview@learnsdlc.test', password: 'Password1!', displayName: 'Previewer' })
      .expect(201);
    token = learner.body.token;

    const other = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'preview-other@learnsdlc.test', password: 'Password1!', displayName: 'Someone Else' })
      .expect(201);
    otherToken = other.body.token;

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(auth())
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    implementation = enrolled.body.phases.find((p: { key: string }) => p.key === 'implementation').id;
    // The preview is not gated on a passed phase, but the phase
    // itself is: a learner who has not reached implementation cannot open it,
    // and that gate is loadOwnedState's, not the preview's.
    await dataSource.manager.update(
      PhaseStateEntity,
      { id: implementation },
      { status: 'in_progress' },
    );

    const otherEnrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(asOther())
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    otherPhase = otherEnrolled.body.phases.find((p: { key: string }) => p.key === 'requirements').id;
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.PREVIEW_SOCKET;
    delete process.env.PREVIEW_SESSIONS;
    if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
  });

  it('tells the phase itself whether it has an app to run', async () => {
    const detail = await request(http)
      .get(`/api/v1/phases/${implementation}`)
      .set(auth())
      .expect(200);

    // On the phase and not on a settings route: the tab has to say something
    // the moment it is drawn, and a second request would draw an empty panel.
    expect(detail.body.canPreview).toBe(true);
    expect(detail.body.previewUnsupported).toBeNull();
  });

  it('starts the learner’s own application and serves it back through one door', async () => {
    const started = await request(http)
      .post(`/api/v1/phases/${implementation}/preview`)
      .set(auth())
      .expect(200);

    expect(['starting', 'ready']).toContain(started.body.status);
    expect(started.body.url).toMatch(/^\/api\/v1\/preview\/[A-Za-z0-9_-]+\/$/);
    url = started.body.url;

    // Poll exactly as the panel does, until the runner stops saying "starting".
    let view = started.body;
    const deadline = Date.now() + 90_000;
    while (view.status === 'starting' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const polled = await request(http)
        .get(`/api/v1/phases/${implementation}/preview?cursor=0`)
        .set(auth())
        .expect(200);
      view = polled.body;
    }

    const console_ = (view.console || [])
      .map((line: { text: string }) => line.text)
      .join('\n');
    expect(view.status).toBe('ready');
    expect(view.bundleOk).toBe(true);
    // A status poll never repeats the capability.
    expect(view.url).toBeNull();
    // Whatever the app printed is redacted before it is stored: no host path.
    expect(console_).not.toContain(os.tmpdir());
  }, 180000);

  it('serves the pack’s own page, with the base tag that makes their front end work', async () => {
    // No authorization header at all: the frame is opaque-origin and carries
    // nothing but the capability in the path.
    const page = await request(http).get(url).expect(200);

    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain(`<base href="${url}">`);
    expect(page.text).toContain('data-app="tasktrackr"');
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.headers['cache-control']).toBe('no-store');
  });

  it('answers the learner’s own API through the same door', async () => {
    const health = await request(http).get(`${url}api/health`).expect(200);

    // Their Flask app, on a loopback port nobody was ever told, answering a
    // request that came in over a UNIX socket.
    expect(health.body.status).toBe('ok');
    expect(health.headers['access-control-allow-origin']).toBe('null');
    expect(health.headers['access-control-allow-credentials']).toBeUndefined();

    const lists = await request(http).get(`${url}api/lists`).expect(200);
    // The seed ran: the preview a learner opens has something in it.
    expect(Array.isArray(lists.body)).toBe(true);
    expect(lists.body.length).toBeGreaterThan(0);
  });

  it('serves the front end it built, out of the runner’s own workspace', async () => {
    const bundle = await request(http).get(`${url}app.js`).expect(200);

    expect(bundle.headers['content-type']).toContain('text/javascript');
    expect(bundle.text.length).toBeGreaterThan(1000);
  });

  it('refuses another learner’s phase before it starts anything', async () => {
    await request(http)
      .post(`/api/v1/phases/${implementation}/preview`)
      .set(asOther())
      .expect(403);
    await request(http).get(`/api/v1/phases/${otherPhase}/preview`).set(auth()).expect(403);
  });

  it('answers an unknown capability 404, and never 403', async () => {
    // 403 would tell whoever is guessing that the session exists.
    await request(http).get('/api/v1/preview/not-a-real-capability/').expect(404);
    await request(http).get('/api/v1/preview/not-a-real-capability/api/health').expect(404);
  });

  it('closes the door when the learner stops the app', async () => {
    const stopped = await request(http)
      .delete(`/api/v1/phases/${implementation}/preview`)
      .set(auth())
      .expect(200);
    expect(stopped.body).toEqual({ stopped: true });

    // The capability died with the session.
    await request(http).get(url).expect(404);
    await request(http).get(`${url}api/health`).expect(404);

    const after = await request(http)
      .get(`/api/v1/phases/${implementation}/preview`)
      .set(auth())
      .expect(200);
    expect(after.body.status).toBe('stopped');
    expect(after.body.stopReason).toBe('learner');
  }, 60000);

  it('lets a learner press Run app six times a minute and not a seventh', async () => {
    // A start builds a bundle and spawns a process. Somebody pressing it a
    // seventh time in a minute is not previewing, they are stuck, and the
    // panel says that better than a queue would. Counted on a phase that has
    // no app to run, so the limit is proved without starting six of them: the
    // guard runs before the handler, so a 400 costs the same as a start.
    const learner = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'preview-eager@learnsdlc.test', password: 'Password1!', displayName: 'Eager' })
      .expect(201);
    const eager = { authorization: `Bearer ${learner.body.token}` };
    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(eager)
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    const requirements = enrolled.body.phases.find((p: { key: string }) => p.key === 'requirements').id;

    const codes: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const answer = await request(http)
        .post(`/api/v1/phases/${requirements}/preview`)
        .set(eager);
      codes.push(answer.status);
    }

    expect(codes.slice(0, 6)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(codes[6]).toBe(429);
  }, 60000);

  it('leaves two audit rows and no row per request', async () => {
    const rows = await dataSource.manager.find(AuditEventEntity);
    const preview = rows.filter((row) => row.event.startsWith('preview.'));

    // Two rows a session, never one per proxied request: this walk made a
    // page load, three API calls and a bundle fetch between them. Sorted by
    // name rather than by createdAt, which is stored to the second and does
    // not order two rows a learner wrote inside one.
    expect(preview.map((row) => row.event).sort()).toEqual(['preview.start', 'preview.stop']);
    const start = preview.find((row) => row.event === 'preview.start');
    const stop = preview.find((row) => row.event === 'preview.stop');
    expect(start?.targetId).toBe(implementation);
    expect(stop?.detail).toMatchObject({ stopReason: 'learner' });
    // And nothing anywhere near an audit row carries the capability.
    expect(JSON.stringify(preview)).not.toContain(url.split('/')[4]);
  });
});
