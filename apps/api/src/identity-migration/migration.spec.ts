import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import type { Request } from 'express';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { config, resolveCognitoConfig } from '../config';
import { SettingEntity, UserEntity } from '../db/entities';
import { IdentityMigrationService, verifyMigrationRequest } from './identity-migration.service';

const managed = {
  AUTH_PROVIDER: 'cognito', COGNITO_USER_POOL_ID: 'ap-southeast-1_TestPool', COGNITO_CLIENT_ID: 'testclient123',
  COGNITO_DOMAIN: 'https://learnsdlc-test.auth.ap-southeast-1.amazoncognito.com',
  COGNITO_REDIRECT_URL: 'https://learnsdlc.example/api/v1/auth/sso/callback',
  COGNITO_MIGRATION_SECRET: 'ba'.repeat(32), COGNITO_PROVIDERS: 'Google,SMU',
};
const saved = resolveCognitoConfig();
const password = 'Migration fixture password 9!';
const email = 'migration-fixture@example.test';

function request(overrides: Record<string, unknown> = {}, at = Date.now()) {
  const rawBody = Buffer.from(JSON.stringify({ email, password, poolId: managed.COGNITO_USER_POOL_ID, trigger: 'UserMigration_Authentication', ...overrides }));
  const timestamp = String(Math.floor(at / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', Buffer.from(managed.COGNITO_MIGRATION_SECRET, 'hex'))
    .update(`${timestamp}.${nonce}.`).update(rawBody).digest('hex');
  return { rawBody, headers: { 'x-cognito-migration-timestamp': timestamp, 'x-cognito-migration-nonce': nonce, 'x-cognito-migration-signature': signature } } as unknown as Request & { rawBody: Buffer };
}

describe('managed identity configuration', () => {
  it('keeps local development explicit and fails a misspelled provider', () => {
    expect(resolveCognitoConfig({}).authProvider).toBe('local');
    expect(() => resolveCognitoConfig({ AUTH_PROVIDER: 'congito' })).toThrow('AUTH_PROVIDER');
  });
  it('accepts the exact configured code callback and provider list', () => {
    expect(resolveCognitoConfig(managed)).toMatchObject({ authProvider: 'cognito', cognitoProviders: ['Google', 'SMU'] });
  });
  it.each([
    ['COGNITO_USER_POOL_ID', 'bad'], ['COGNITO_CLIENT_ID', ''],
    ['COGNITO_DOMAIN', 'http://identity.example'], ['COGNITO_DOMAIN', 'https://user:secret@identity.example'],
    ['COGNITO_DOMAIN', 'https://identity.example/path'],
    ['COGNITO_REDIRECT_URL', 'https://app.example/other'],
    ['COGNITO_REDIRECT_URL', 'http://public.example/api/v1/auth/sso/callback'],
    ['COGNITO_REDIRECT_URL', 'https://app.example/api/v1/auth/sso/callback?next=evil'],
    ['COGNITO_PROVIDERS', 'Google,https://other'], ['COGNITO_MIGRATION_SECRET', 'weak'],
  ])('rejects invalid %s before managed authentication starts', (key, value) => {
    expect(() => resolveCognitoConfig({ ...managed, [key]: value })).toThrow();
  });
});

describe('trusted legacy identity migration', () => {
  let db: DataSource;
  let service: IdentityMigrationService;
  let id: string;
  beforeAll(async () => {
    Object.assign(config, resolveCognitoConfig(managed));
    db = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [UserEntity, SettingEntity], synchronize: true }).initialize();
    service = new IdentityMigrationService(passwordWorkFixture(), db.getRepository(UserEntity), db.getRepository(SettingEntity));
  });
  beforeEach(async () => {
    await db.getRepository(SettingEntity).clear();
    await db.getRepository(UserEntity).clear();
    id = randomUUID();
    await db.getRepository(UserEntity).save({ id, email, passwordHash: await bcrypt.hash(password, 4), displayName: 'Migration fixture', role: 'LEARNER' });
  });
  afterAll(async () => { Object.assign(config, saved); await db?.destroy(); });

  it('preserves the internal id without modifying account or learning data', async () => {
    const before = await db.getRepository(UserEntity).findOneByOrFail({ id });
    expect(await service.migrate(request())).toEqual({ id, email, emailVerified: false, displayName: 'Migration fixture' });
    expect(await db.getRepository(UserEntity).findOneByOrFail({ id })).toEqual(before);
  });
  it('consumes a proof once even across service instances and concurrent calls', async () => {
    const req = request();
    const other = new IdentityMigrationService(passwordWorkFixture(), db.getRepository(UserEntity), db.getRepository(SettingEntity));
    const results = await Promise.allSettled([service.migrate(req), other.migrate(req)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(other.migrate(req)).rejects.toThrow('refused');
  });
  it('refuses tampered bytes, invalid signatures, expired/future timestamps and duplicate headers', () => {
    const changed = request(); changed.rawBody = Buffer.from('{}');
    expect(() => verifyMigrationRequest(changed)).toThrow('refused');
    const signature = request(); signature.headers['x-cognito-migration-signature'] = '0'.repeat(64);
    expect(() => verifyMigrationRequest(signature)).toThrow('refused');
    expect(() => verifyMigrationRequest(request({}, Date.now() - 120_000))).toThrow('refused');
    expect(() => verifyMigrationRequest(request({}, Date.now() + 120_000))).toThrow('refused');
    const duplicate = request(); duplicate.headers['x-cognito-migration-nonce'] = ['one', 'two'];
    expect(() => verifyMigrationRequest(duplicate)).toThrow('refused');
  });
  it.each([
    { poolId: 'ap-southeast-1_OtherPool' }, { trigger: 'PreSignUp_SignUp' },
    { id: 'forged-id' }, { email: 'UPPER@EXAMPLE.TEST' }, { password: null },
  ])('refuses a signed but invalid migration payload %j', (body) => {
    expect(() => verifyMigrationRequest(request(body))).toThrow('refused');
  });
  it('does not authenticate unknown users, wrong passwords, suspended or already-linked users', async () => {
    await expect(service.migrate(request({ email: 'unknown@example.test' }))).rejects.toThrow('refused');
    await expect(service.migrate(request({ password: 'Definitely incorrect' }))).rejects.toThrow('refused');
    await db.getRepository(UserEntity).update({ id }, { disabledAt: new Date().toISOString() });
    await expect(service.migrate(request())).rejects.toThrow('refused');
    await db.getRepository(UserEntity).update({ id }, { disabledAt: null, cognitoSub: 'already-linked-subject' });
    await expect(service.migrate(request())).rejects.toThrow('refused');
  });
  it('only migrates forgot-password requests for an actually verified legacy mailbox', async () => {
    const body = { trigger: 'UserMigration_ForgotPassword', password: null };
    await expect(service.migrate(request(body))).rejects.toThrow('refused');
    await db.getRepository(UserEntity).update({ id }, { emailVerifiedAt: new Date().toISOString() });
    expect(await service.migrate(request(body))).toMatchObject({ id, emailVerified: true });
  });
  it('cannot operate in local mode even with a correct signature', () => {
    config.authProvider = 'local';
    try { expect(() => verifyMigrationRequest(request())).toThrow('refused'); }
    finally { config.authProvider = 'cognito'; }
  });
});
