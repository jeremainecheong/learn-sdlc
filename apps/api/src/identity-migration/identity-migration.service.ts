import { PasswordWorkService } from '../auth/password-work.service';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { isEmail } from 'class-validator';
import { Repository } from 'typeorm';
import { API_PREFIX, config } from '../config';
import { SettingEntity, UserEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';

export const COGNITO_MIGRATION_PATH = `${API_PREFIX}/auth/cognito/migrate`;
export const MIGRATION_WINDOW_MS = 60_000;
const NONCE_PREFIX = 'auth.cognito.migration.';
type MigrationBody = {
  email: string;
  password: string | null;
  poolId: string;
  trigger: 'UserMigration_Authentication' | 'UserMigration_ForgotPassword';
};

/** Checks the exact signed bytes before returning any identity attributes. */
export function verifyMigrationRequest(req: Request & { rawBody?: Buffer }, now = Date.now()): MigrationBody {
  const denied = () => new UnauthorizedException('identity migration request refused');
  if (config.authProvider !== 'cognito' || !/^[a-f0-9]{64}$/.test(config.cognitoMigrationSecret)) throw denied();
  const raw = req.rawBody;
  const timestamp = req.headers['x-cognito-migration-timestamp'];
  const nonce = req.headers['x-cognito-migration-nonce'];
  const signature = req.headers['x-cognito-migration-signature'];
  if (!Buffer.isBuffer(raw) || raw.length > 4096 ||
      typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp) * 1000) > MIGRATION_WINDOW_MS ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw denied();
  const expected = createHmac('sha256', Buffer.from(config.cognitoMigrationSecret, 'hex'))
    .update(`${timestamp}.${nonce}.`).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw denied();
  let body: MigrationBody;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw denied(); }
  if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'email,password,poolId,trigger' ||
      typeof body.email !== 'string' || body.email.length > 254 || !isEmail(body.email) ||
      body.email !== body.email.trim().toLowerCase() || body.poolId !== config.cognitoUserPoolId ||
      !['UserMigration_Authentication', 'UserMigration_ForgotPassword'].includes(body.trigger)) throw denied();
  if (body.trigger === 'UserMigration_Authentication') {
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 100) throw denied();
  } else if (body.password !== null) throw denied();
  return body;
}

@Injectable()
export class IdentityMigrationService {
  constructor(
    private readonly passwords: PasswordWorkService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(SettingEntity) private readonly settings: Repository<SettingEntity>,
  ) {}

  async migrate(req: Request & { rawBody?: Buffer }) {
    const body = verifyMigrationRequest(req);
    const now = Date.now();
    // Unique database insertion is the replay barrier across restarts/replicas.
    // Keep entries beyond the full signed timestamp window, including clock skew.
    try {
      await this.settings.createQueryBuilder().delete()
        .where('"key" LIKE :prefix', { prefix: `${NONCE_PREFIX}%` })
        .andWhere('"value" < :cutoff', { cutoff: String(now) }).execute();
      await this.settings.insert({ key: NONCE_PREFIX + req.headers['x-cognito-migration-nonce'], value: String(now + 2 * MIGRATION_WINDOW_MS) });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '23505' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new UnauthorizedException('identity migration request refused');
      }
      throw new ServiceUnavailableException('identity migration is temporarily unavailable');
    }
    const user = await this.users.findOne({ where: { email: body.email } });
    if (!user || user.disabledAt || user.cognitoSub) throw new UnauthorizedException('identity migration request refused');
    if (body.trigger === 'UserMigration_Authentication') {
      if (!(await this.passwords.compare(body.password as string, user.passwordHash))) {
        throw new UnauthorizedException('identity migration request refused');
      }
    } else if (!user.emailVerifiedAt) {
      // A legacy unverified email must never become a recovery channel by migration.
      throw new UnauthorizedException('identity migration request refused');
    }
    return { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt), displayName: user.displayName };
  }
}
