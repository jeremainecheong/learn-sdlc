import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/auth.guards';
import { RateLimitGuard } from '../auth/rate-limit.guard';
import { UserEntity } from '../db/entities';
import { PreviewController } from './preview.controller';
import { PreviewService } from './preview.service';

/** Real HTTP routing, JWT verification and SQL authority; only the runner-facing
 * service and unrelated rate counter are controlled in this boundary test. */
describe('preview HTTP authorization and identifier boundary', () => {
  let app: INestApplication;
  let db: DataSource;
  let token: string;
  let userId: string;
  const service = { start: jest.fn(async () => ({})), status: jest.fn(async () => null), stop: jest.fn(async () => ({ stopped: false })) };
  const phaseId = '4b3cb22a-c933-41b3-8819-2540f7f3380a';

  beforeAll(async () => {
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [UserEntity], synchronize: true }).initialize();
    const row = await db.manager.save(UserEntity, db.manager.create(UserEntity, {
      email: 'preview-http-boundary@example.invalid', displayName: 'HTTP fixture', passwordHash: 'unused', tokenVersion: 3,
    }));
    userId = row.id;
    const auth = new AuthService(passwordWorkFixture(), db.getRepository(UserEntity), new JwtService({ secret: 'http-boundary-test-only', signOptions: { expiresIn: '1h' } }));
    token = (await auth.issueSession(row)).token;
    const module = await Test.createTestingModule({ controllers: [PreviewController], providers: [{ provide: PreviewService, useValue: service }] })
      .overrideGuard(RateLimitGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalGuards(new JwtAuthGuard(auth, new Reflector()));
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => { await app?.close(); if (db?.isInitialized) await db.destroy(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it.each(['post', 'get', 'delete'] as const)('refuses unauthenticated %s before inspecting malformed phase ids', async method => {
    await request(app.getHttpServer())[method]('/phases/not-a-uuid/preview').expect(401);
    expect(service.start).not.toHaveBeenCalled(); expect(service.status).not.toHaveBeenCalled(); expect(service.stop).not.toHaveBeenCalled();
  });

  it.each(['post', 'get', 'delete'] as const)('rejects authenticated malformed %s ids before a workspace or runner lookup', async method => {
    await request(app.getHttpServer())[method]('/phases/not-a-uuid/preview').set('Authorization', `Bearer ${token}`).expect(400);
    expect(service.start).not.toHaveBeenCalled(); expect(service.status).not.toHaveBeenCalled(); expect(service.stop).not.toHaveBeenCalled();
  });

  it('carries the verified generation into the long-lived preview start', async () => {
    await request(app.getHttpServer()).post(`/phases/${phaseId}/preview`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(service.start).toHaveBeenCalledWith(userId, phaseId, 3);
  });
});
