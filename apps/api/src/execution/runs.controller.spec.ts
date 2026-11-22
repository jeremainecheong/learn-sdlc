import 'reflect-metadata';
import { Module, NotFoundException, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import request = require('supertest');
import { RunsController } from './runs.controller';
import { ExecutionService } from './execution.service';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/auth.guards';

const owner = '4c9a0e32-3c3d-4d78-8ab3-43e2f8f13c70';
const ownRun = '9e27c60d-8de3-4478-97d8-c1e57c5c0325';
const foreignRun = 'eb80bce3-4d72-4a5c-a849-90e726810efc';
const phaseId = '168e0f34-da78-4dd9-a3c4-8f4d2d41b87b';
const execution = {
  getRun: jest.fn(async (id: string, userId: string) => {
    if (id !== ownRun || userId !== owner) throw new NotFoundException('run not found');
    return { id, phaseStateId: phaseId, status: 'completed', kind: 'run', result: null };
  }),
};
const auth = {
  authenticate: jest.fn(async (token: string) => {
    if (token !== 'owned-test-session') throw new UnauthorizedException();
    return { id: owner, role: 'LEARNER', email: 'run-validation@example.test', cohort: 'default' };
  }),
};

@Module({
  controllers: [RunsController],
  providers: [
    { provide: ExecutionService, useValue: execution },
    { provide: AuthService, useValue: auth },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
class RunValidationModule {}

describe('RunsController UUID boundary', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await NestFactory.create(RunValidationModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => jest.clearAllMocks());

  it.each(['not-a-run', 'null', '00000000-0000-4000-8000-00000000000g', "' OR 1=1--"])(
    'rejects malformed run ID %s before the execution repository', async id => {
      const response = await request(app.getHttpServer()).get(`/api/v1/runs/${encodeURIComponent(id)}`)
        .set('Authorization', 'Bearer owned-test-session');
      expect(response.status).toBe(400);
      expect(execution.getRun).not.toHaveBeenCalled();
    },
  );

  it('authenticates before validating a malformed ID', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/runs/not-a-run')).status).toBe(401);
    expect(auth.authenticate).not.toHaveBeenCalled();
    expect(execution.getRun).not.toHaveBeenCalled();
  });

  it('passes the authenticated owner into a valid run lookup and retains its phase ID', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/runs/${ownRun}`)
      .set('Authorization', 'Bearer owned-test-session');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: ownRun, phaseStateId: phaseId });
    expect(execution.getRun).toHaveBeenCalledTimes(1);
    expect(execution.getRun).toHaveBeenCalledWith(ownRun, owner);
  });

  it('preserves the owner-scoped not-found result for an existing foreign UUID', async () => {
    const response = await request(app.getHttpServer()).get(`/api/v1/runs/${foreignRun}`)
      .set('Authorization', 'Bearer owned-test-session');
    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty('phaseStateId');
    expect(execution.getRun).toHaveBeenCalledWith(foreignRun, owner);
  });
});
