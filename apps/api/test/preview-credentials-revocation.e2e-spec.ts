import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PhaseStateEntity } from '../src/db/entities';
import { SandboxService } from '../src/execution/sandbox.service';
import { bootApi } from './support/app';
import type { HttpTarget } from './support/http';

/** Real HTTP auth/DI/SQLite lifecycle; preview transport is deliberately mocked.
 * No provider, sandbox process, or production data is touched. The throwaway
 * implementation phase is explicitly opened only to reach the preview seam.
 */
describe('preview credentials follow HTTP account revocation', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let phaseId: string;
  let token: string;
  const email = 'preview-revocation@flow-security.test';
  const password = 'Test!PreviewRevocation42';
  const stoppedRunners = new Set<string>();
  const stopApp = jest.fn(async (id: string) => { stoppedRunners.add(id); });
  const assetApp = jest.fn(async () => ({ status: 200, contentType: 'text/plain', body: 'mock preview', bytes: Buffer.from('mock preview') }));
  let runner = 0;

  beforeAll(async () => {
    ({ app, http } = await bootApi({
      pipeline: 'prefix',
      overrides: [[SandboxService, {
        // The transport a start asks for before it reserves a seat: a
        // deployment that has one answers its socket, which is what the real
        // service does on the socket transport.
        previewSocket: jest.fn(async () => '/tmp/flow-security-preview.sock'),
        startApp: jest.fn(async () => ({ id: `mock-runner-${++runner}`, status: 'ready', bundleOk: true, console: [], cursor: 0 })),
        stopApp, assetApp,
        statusApp: jest.fn(async (id: string) => ({ id, status: stoppedRunners.has(id) ? 'stopped' : 'ready',
          cleanupConfirmed: stoppedRunners.has(id), console: [], cursor: 0 })),
      }]],
    }));
    const auth = await request(http).post('/api/v1/auth/register').send({ email, password, displayName: 'Revocation fixture' }).expect(201);
    token = auth.body.token;
    const enrollment = await request(http).post('/api/v1/enrollments').set('authorization', `Bearer ${token}`).send({ projectSlug: 'tasktrackr' }).expect(201);
    expect(enrollment.body.phases.filter((p: { status: string }) => p.status === 'locked')).toHaveLength(5);
    phaseId = enrollment.body.phases.find((p: { key: string }) => p.key === 'implementation').id;
    await app.get(DataSource).manager.update(PhaseStateEntity, { id: phaseId }, { status: 'in_progress' });
  });
  afterAll(async () => { await app?.close(); });

  async function open() {
    const start = await request(http).post(`/api/v1/phases/${phaseId}/preview`).set('authorization', `Bearer ${token}`).expect(200);
    expect(start.body.url).toMatch(/^\/api\/v1\/preview\//);
    await request(http).get(start.body.url).expect(200, 'mock preview');
    return start.body.url as string;
  }

  it('invalidates the anonymous capability door as soon as authenticated logout completes', async () => {
    const url = await open();
    await request(http).post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`).expect(200);
    const reads = assetApp.mock.calls.length;
    await request(http).get(url).expect(404);
    expect(assetApp).toHaveBeenCalledTimes(reads);
    await request(http).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`).expect(401);
    expect(stopApp).toHaveBeenCalledWith('mock-runner-1', 'learner');
  });

  it('also invalidates a newly issued preview after an actual password change', async () => {
    const login = await request(http).post('/api/v1/auth/login').send({ email, password }).expect(200);
    token = login.body.token;
    const url = await open();
    await request(http).post('/api/v1/account/password').set('authorization', `Bearer ${token}`).send({ currentPassword: password, newPassword: 'Changed!PreviewRevocation43' }).expect(200);
    await request(http).get(url).expect(404);
    await request(http).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`).expect(401);
    expect(stopApp).toHaveBeenCalledWith('mock-runner-2', 'learner');
  });
});
