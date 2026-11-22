import { PasswordWorkService } from './password-work.service';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '../db/inject';
import { JwtService } from '@nestjs/jwt';
import { config } from '../config';
import { isUniqueViolation } from '../db/unique-violation';
import { BUMP_TOKEN_VERSION } from '../db/token-version';
import { isoText } from '../db/timestamps';
import { normaliseEmail } from './email';
import { PUBLISHED_DEFAULT_PASSWORDS } from '../seed/demo-accounts';

/** New hashes retain cost 12; comparisons honor each existing hash's cost. */
export { PASSWORD_BCRYPT_ROUNDS as BCRYPT_ROUNDS } from './password-work.protocol';
import { IsNull, Repository } from 'typeorm';
import { CognitoService, type CognitoIdentity, type ConfirmationRequired } from './cognito.service';
import type { AuthResponse, Role, UserProfile } from '@learnsdlc/shared';
import { UserEntity } from '../db/entities';
import type { AuthUser } from './auth.decorators';
import { isUUID } from 'class-validator';

/** The kind of account a log line names: "an instructor", "an admin", "a learner". */
function accountKind(role: Role): string {
  const kind = role.toLowerCase();
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/** Ten wrong passwords in a quarter hour locks the account, not the address. */
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const LOGIN_FAILURE_SWEEP_SIZE = 10_000;

/**
 * How long a managed (AUTH_PROVIDER=cognito) session token lives: three hours,
 * renewed in the background while the person is using the app (the web's
 * lib/api.ts asks `POST /auth/renew` once less than two hours are left). The
 * local mode keeps JWT_EXPIRES_IN's life (seven days by default).
 */
export const MANAGED_SESSION_LIFE_SECONDS = 3 * 60 * 60;
/**
 * How long after the sign-in renewals stop: twelve hours, counted from the
 * `orig` claim the sign-in set. The token renewed last still runs to its own
 * `exp`, and then the person signs in again.
 */
export const MANAGED_SESSION_CAP_MS = 12 * 60 * 60_000;
/** The `code` a renewal refused at the cap answers with (401). */
export const SESSION_CAP_REACHED = 'session-cap-reached';

/** What a bearer token must match to be honoured. Null caches "no such row". */
interface SessionEntry {
  readonly row: Promise<SessionRow | null>;
  revoked: boolean;
  waiters: number;
}

type SessionRow = Pick<
  UserEntity,
  'id' | 'email' | 'role' | 'cohort' | 'tokenVersion' | 'disabledAt' | 'cognitoSub'
>;

interface FailureWindow {
  count: number;
  resetAt: number;
}

/**
 * ALLOWED_EMAIL_DOMAINS, applied to one address. Returns the sentence to
 * refuse with, or null when the address may come in.
 *
 * One function, because there is more than one door: the setting promises
 * that on a server set to `uni.example.edu` nobody else's account can walk in, and
 * that promise must hold at the Google button and at `POST /auth/register`
 * alike. `opening` names the door in the
 * sentence, so each one says what it is refusing without the rule itself
 * being written twice.
 */
export function emailDomainRefusal(email: string, opening: string): string | null {
  const allowed = config.allowedEmailDomains;
  if (allowed.length === 0) return null;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (allowed.includes(domain)) return null;
  return `${opening} on this server is for ${allowed.map((d) => `@${d}`).join(', ')} addresses`;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /**
   * Session rows are shared only while a lookup is in flight, never across
   * requests: PostgreSQL is the revocation authority on every API process.
   */
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly loginFailures = new Map<string, FailureWindow>();
  private readonly revocationListeners: Array<(userId: string) => void> = [];

  constructor(
    private readonly passwords: PasswordWorkService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwtService: JwtService,
    @Optional() private readonly cognito?: CognitoService,
  ) {}

  toProfile(user: UserEntity): UserProfile {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar ?? 0,
      bio: user.bio ?? '',
      goals: user.goals ?? '',
      onboardingCompleted: user.onboardingCompleted ?? false,
      profileVersion: user.profileVersion ?? 0,
      role: user.role,
      cohort: user.cohort,
      createdAt: isoText(user.createdAt),
    };
  }

  /**
   * The token names the account and the version of it that was signed in;
   * everything else (role, cohort, whether the account still exists) is read
   * from the row at each request, so it cannot go stale for the token's life.
   *
   * Public because password sign-in is not the only way in: Google
   * sign-in (google.service.ts) hands back the identical session, and one
   * function minting them is what keeps the two ways in from drifting.
   *
   * A managed token lives MANAGED_SESSION_LIFE_SECONDS and carries `orig`, the time
   * of the sign-in it descends from. Sign-in sets it to now; `renewSession`
   * passes the old token's value through unchanged, which is what lets the
   * renewal cap count from the sign-in and not from the last renewal.
   */
  async issueSession(user: UserEntity, signedInAt: number = Date.now()): Promise<AuthResponse> {
    const managed = config.authProvider === 'cognito';
    if (managed && !user.cognitoSub) throw new UnauthorizedException('Managed sign-in is required.');
    const token = await this.jwtService.signAsync({
      sub: user.id,
      ver: user.tokenVersion,
      provider: managed ? 'cognito' : 'local',
      ...(managed ? { cognitoSub: user.cognitoSub, orig: signedInAt } : {}),
    }, managed ? { expiresIn: MANAGED_SESSION_LIFE_SECONDS } : undefined);
    return { token, user: this.toProfile(user) };
  }

  /**
   * A fresh token for the caller of a token that still works
   * (`POST /auth/renew`). The web asks for one in the background while the
   * person is using the app, so a class is not cut off mid-work when the
   * token it signed in with runs out.
   *
   * The token is checked exactly as every request checks it (`authenticate`:
   * signature, expiry, provider, account, suspension, `ver`), so a signed-out
   * or suspended session cannot renew itself, and the new token is minted
   * from the row as it is now. In the managed mode the new token keeps the
   * old one's `orig`, and renewal is refused once MANAGED_SESSION_CAP_MS has
   * passed since that sign-in: the session then ends at its own `exp`, and
   * the person signs in again. A managed token that carries no `orig`
   * counts from its `iat`. In the local mode it is simply a fresh token of
   * the usual (JWT_EXPIRES_IN) life, with no cap: the local mode's week-long
   * token never comes near the web's renewal threshold anyway.
   */
  async renewSession(token: string, now: number = Date.now()): Promise<AuthResponse> {
    const caller = await this.authenticate(token);
    const user = await this.users.findOneBy({ id: caller.id });
    if (!user) throw new UnauthorizedException('this account no longer exists');
    const claims = this.jwtService.decode(token) as { orig?: unknown; iat?: unknown; cognitoSub?: unknown } | null;
    // The row is read twice (authenticate, then here) and the new token is
    // signed from this second read. A sign-out, suspension, password reset or
    // identity change committed between the two would otherwise mint a token
    // that outlives it, so the second read must still be the session the
    // first one accepted.
    if (user.tokenVersion !== caller.sessionVersion) throw new UnauthorizedException('this session has been signed out');
    if (user.disabledAt) throw new UnauthorizedException('this account is suspended');
    if (config.authProvider === 'cognito' && (!user.cognitoSub || claims?.cognitoSub !== user.cognitoSub)) {
      throw new UnauthorizedException('Managed identity no longer matches this account.');
    }
    if (config.authProvider !== 'cognito') return this.issueSession(user);
    const signedInAt = typeof claims?.orig === 'number' && Number.isFinite(claims.orig)
      ? claims.orig
      : typeof claims?.iat === 'number' ? claims.iat * 1000 : NaN;
    if (!Number.isFinite(signedInAt) || now - signedInAt >= MANAGED_SESSION_CAP_MS) {
      throw new UnauthorizedException({ code: SESSION_CAP_REACHED, message: 'This session has reached its limit. Sign in again to continue.' });
    }
    return this.issueSession(user, signedInAt);
  }

  /**
   * Turn a bearer token into the caller, or refuse it. The signature proves
   * the token was ours once; the row proves it still is. A token issued
   * before a password change carries an older `ver` than the row and is
   * refused, as is one for a suspended or deleted account: the same answer
   * (401) in every case, since a stolen token's holder learns nothing useful
   * from a finer distinction.
   */
  async authenticate(token: string): Promise<AuthUser> {
    let payload: { sub?: string; ver?: number; purpose?: string; provider?: string; cognitoSub?: string };
    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
    if (typeof payload.sub !== 'string' || !isUUID(payload.sub) ||
        !Number.isSafeInteger(payload.ver) || (payload.ver as number) < 0) {
      throw new UnauthorizedException('invalid or expired token');
    }
    // Recovery links (reset, verify) are signed with a different key, so they
    // already fail the verify above; the claim check is the second lock, so a
    // future key change cannot quietly turn an emailed link into a session.
    if (payload.purpose !== undefined) throw new UnauthorizedException('invalid or expired token');

    if (config.authProvider === 'cognito' ? payload.provider !== 'cognito' : (payload.provider !== undefined && payload.provider !== 'local')) {
      throw new UnauthorizedException('Sign in again using this installation’s current sign-in provider.');
    }
    const session = this.sessionEntry(payload.sub);
    try {
      await session.row;
      // A different replica may have committed logout while this shared lookup
      // was in flight. A fresh authoritative read fences that delayed response;
      // a database failure never falls back to a previously accepted row.
      const row = await this.readSessionAuthority(payload.sub);
      // Revocation can commit while the database read is still in flight. Its
      // old row must neither authenticate this request nor repopulate the cache.
      if (session.revoked) throw new UnauthorizedException('this session has been signed out');
      if (!row) throw new UnauthorizedException('this account no longer exists');
      if (row.disabledAt) throw new UnauthorizedException('this account is suspended');
      if (config.authProvider === 'cognito' && (!row.cognitoSub || payload.cognitoSub !== row.cognitoSub)) throw new UnauthorizedException('Managed identity no longer matches this account.');
      if (payload.ver !== row.tokenVersion) {
        throw new UnauthorizedException('this session has been signed out');
      }
      return { id: row.id, email: row.email, role: row.role, cohort: row.cohort, sessionVersion: row.tokenVersion };
    } finally {
      session.waiters -= 1;
      if (session.waiters === 0 && this.sessions.get(payload.sub) === session) this.sessions.delete(payload.sub);
    }
  }

  /**
   * Fence pending local reads after a committed authority change: a tokenVersion bump, a
   * suspension, a role change. Listeners (the socket gateway) are told so a
   * connection that authenticated earlier is closed too.
   */
  forgetSession(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) session.revoked = true;
    this.sessions.delete(userId);
    for (const listener of this.revocationListeners) {
      try { listener(userId); }
      catch { this.logger.warn('session revocation listener failed; shared authority remains revoked'); }
    }
  }

  onSessionRevoked(listener: (userId: string) => void): void {
    this.revocationListeners.push(listener);
  }

  /**
   * Sign the account out everywhere: every token minted so far carries a
   * `ver` behind the row after this, and `authenticate` refuses it. Added to
   * in SQL rather than read-and-written, the way the password change does it,
   * so two revocations landing together advance the version twice. An account
   * that is already gone is not an error: the caller is leaving either way.
   */
  async signOut(userId: string): Promise<{ signedOut: true }> {
    await this.users.update({ id: userId }, { tokenVersion: BUMP_TOKEN_VERSION });
    this.forgetSession(userId);
    return { signedOut: true };
  }

  /** Used by shared preview authorization; never reads a process-local cache. */
  async readSessionAuthority(userId: string): Promise<SessionRow | null> {
    return this.users.findOne({
      where: { id: userId },
      select: ['id', 'email', 'role', 'cohort', 'tokenVersion', 'disabledAt', 'cognitoSub'],
    });
  }

  private sessionEntry(userId: string): SessionEntry {
    const cached = this.sessions.get(userId);
    if (cached) { cached.waiters += 1; return cached; }
    const read = this.readSessionAuthority(userId);
    const entry: SessionEntry = { revoked: false, row: read, waiters: 1 };
    this.sessions.set(userId, entry);
    return entry;
  }

  /**
   * The other door. It applies the same domain rule the Google button does:
   * a server restricted to one institution has to be restricted at every way
   * in, or the restriction is decoration, and it is checked before the row
   * is looked for, so an address this server will not take is never told
   * whether it is already registered.
   *
   * The existence check that follows is a courtesy, not the guarantee: two
   * sign-ups a millisecond apart both read no row, both pay bcrypt, and the
   * unique index on the address decides. That refusal is the same 409 the
   * pre-check raises, because it is the same answer to the same question.
   */
  async register(email: string, password: string, displayName: string): Promise<AuthResponse | ConfirmationRequired> {
    const normalized = normaliseEmail(email);
    const refusal = emailDomainRefusal(normalized, 'Registration');
    if (refusal) throw new ForbiddenException(refusal);

    const existing = await this.users.findOne({ where: { email: normalized } });
    if (existing) throw new ConflictException('an account with this email already exists');
    if (config.authProvider === 'cognito') return this.managed().register(normalized,password,displayName);
    const user = this.users.create({
      email: normalized,
      passwordHash: await this.passwords.hash(password),
      displayName: displayName.trim(),
      role: 'LEARNER' as Role,
    });
    try {
      await this.users.save(user);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictException('an account with this email already exists');
    }
    return this.issueSession(user);
  }

  /**
   * Two brakes, one per caller and one per target. The route's per-IP limit
   * stops a single machine hammering the endpoint; this one stops a botnet
   * spreading guesses at one account across many addresses, each under the
   * IP limit, and bills every guess at full bcrypt cost. Once the account is
   * locked the guess is refused before the hash is checked. The wording is the
   * same 401 whether the password was wrong or the account is locked, so the
   * lock does not itself confirm that the address is registered.
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const normalized = normaliseEmail(email);
    if (config.authProvider === 'cognito') {
      const refusal = emailDomainRefusal(normalized,'Sign-in');
      if (refusal) throw new ForbiddenException(refusal);
      const { identity } = await this.managed().passwordIdentity(normalized,password);
      return this.cognitoSession(identity,'native');
    }
    const user = await this.users.findOne({ where: { email: normalized } });

    const now = Date.now();
    const window = this.loginFailures.get(normalized);
    if (window && window.resetAt > now && window.count >= LOGIN_FAILURE_LIMIT) {
      // The id, never the address: a throttled log line is the one that gets
      // read while someone is attacking, and it should not carry the target.
      this.logger.warn(`login refused: account ${user?.id ?? '(unregistered)'} is locked after repeated failures`);
      throw new UnauthorizedException('invalid email or password');
    }

    if (!user || !(await this.passwords.compare(password, user.passwordHash))) {
      this.recordLoginFailure(normalized, now);
      throw new UnauthorizedException('invalid email or password');
    }
    // A demo account's password is printed in the README. The seed creates
    // those accounts only on loopback, but a database the demo used can later
    // be served to a room, so wherever the network can reach this API the
    // published password is treated as the wrong one: the same answer and the
    // same count towards the lock. The log names the kind of account and its
    // id, never the password or the address.
    if (!config.bindIsLoopback && PUBLISHED_DEFAULT_PASSWORDS.has(password)) {
      this.recordLoginFailure(normalized, now);
      this.logger.warn(
        `login refused: ${accountKind(user.role)} account ${user.id} still has a password this repository ` +
          `publishes, and this API is reachable from the network (API_BIND=${config.bindAddress}); ` +
          'give it another with npm run user:set-password -w @learnsdlc/api',
      );
      throw new UnauthorizedException('invalid email or password');
    }
    this.loginFailures.delete(normalized);
    // Checked after the password, so the answer only reaches the account's
    // owner: the guard would refuse the token on its first use anyway, but a
    // sign-in that silently bounced back to the form would tell them nothing.
    if (user.disabledAt) {
      throw new UnauthorizedException('this account is suspended — contact your instructor');
    }
    return this.issueSession(user);
  }

  private managed(): CognitoService {
    if (!this.cognito?.enabled()) throw new ServiceUnavailableException('Managed sign-in is unavailable. Contact the LearnSDLC host.');
    return this.cognito;
  }

  /** Accept only identities already verified by the configured Cognito pool.
   * custom:learnsdlc_id is trusted only because provisioning makes it immutable
   * and removes public-client write access. Email alone never links accounts. */
  async cognitoSession(identity: CognitoIdentity, channel: 'native' | 'external' = 'external'): Promise<AuthResponse> {
    if (config.authProvider !== 'cognito') throw new UnauthorizedException('Managed sign-in is not enabled.');
    if (!identity.emailVerified && (channel !== 'native' || !identity.appUserId)) throw new UnauthorizedException('Confirm your email with the sign-in provider.');
    const refusal = emailDomainRefusal(identity.email,'Sign-in');
    if (refusal) throw new ForbiddenException(refusal);
    let user = await this.users.findOneBy({ cognitoSub: identity.sub });
    if (user && !identity.emailVerified && (identity.appUserId !== user.id || identity.email !== user.email)) throw new UnauthorizedException('Legacy identity does not match this account.');
    if (user && identity.appUserId && identity.appUserId !== user.id) throw new UnauthorizedException('Managed identity mapping does not match.');
    if (!user && identity.appUserId) {
      const previous = await this.users.findOneBy({ id: identity.appUserId });
      if (!previous || previous.disabledAt || previous.email !== identity.email || (previous.cognitoSub && previous.cognitoSub !== identity.sub)) {
        throw new UnauthorizedException('This managed identity cannot be linked to the existing account.');
      }
      const update = await this.users.update({ id: previous.id, cognitoSub: IsNull(), disabledAt: IsNull() },
        { cognitoSub: identity.sub, emailVerifiedAt: previous.emailVerifiedAt || (identity.emailVerified ? new Date().toISOString() : null), tokenVersion: BUMP_TOKEN_VERSION });
      this.forgetSession(previous.id);
      user = await this.users.findOneBy({ id: previous.id });
      if ((!update.affected && user?.cognitoSub !== identity.sub) || !user) throw new UnauthorizedException('The account changed during sign-in. Start again.');
    }
    if (!user) {
      if (await this.users.existsBy({ email: identity.email })) throw new ConflictException({code:'IDENTITY_LINK_REQUIRED',
        message:'An existing LearnSDLC account uses this address. Sign in with its existing password to migrate it, or contact the LearnSDLC host. Automatic email linking is disabled.'});
      try {
        user = await this.users.save(this.users.create({ email: identity.email, cognitoSub: identity.sub, passwordHash: '',
          displayName: identity.name || identity.email.split('@')[0], role:'LEARNER', emailVerifiedAt:new Date().toISOString() }));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        user = await this.users.findOneBy({cognitoSub:identity.sub});
        if (!user) throw new ConflictException('This identity needs account-link assistance. Contact the LearnSDLC host.');
      }
    }
    if (user.disabledAt) throw new UnauthorizedException('This account is suspended. Contact your instructor.');
    if (identity.emailVerified && identity.email === user.email && !user.emailVerifiedAt) {
      await this.users.update({id:user.id,cognitoSub:identity.sub,email:identity.email,emailVerifiedAt:IsNull(),disabledAt:IsNull()},
        {emailVerifiedAt:new Date().toISOString()});
      user=await this.users.findOneByOrFail({id:user.id});
      if (user.disabledAt) throw new UnauthorizedException('This account is suspended. Contact your instructor.');
    }
    return this.issueSession(user);
  }

  private recordLoginFailure(key: string, now: number): void {
    if (this.loginFailures.size >= LOGIN_FAILURE_SWEEP_SIZE) {
      for (const [k, w] of this.loginFailures) {
        if (w.resetAt <= now) this.loginFailures.delete(k);
      }
    }
    const window = this.loginFailures.get(key);
    if (!window || window.resetAt <= now) {
      this.loginFailures.set(key, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
      return;
    }
    window.count += 1;
  }

  /**
   * The guard has already refused a token whose row is gone, so this lookup
   * fails only when the account is deleted between the guard's read and this
   * one. Answering 401 rather than letting the missing row surface as a 500 is
   * what tells the web client to drop the dead credential.
   */
  async profile(userId: string): Promise<UserProfile> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException('this account no longer exists');
    return this.toProfile(user);
  }

  /**
   * Create an account with a fixed role if it does not exist (seeding).
   *
   * Deliberately outside the domain rule: this is the operator naming the
   * accounts their own deployment starts with, and the first admin's address
   * is often not the institution's.
   */
  async ensureAccount(email: string, password: string, displayName: string, role: Role): Promise<void> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) return;
    await this.users.save(
      this.users.create({
        email,
        passwordHash: await this.passwords.hash(password),
        displayName,
        role,
      }),
    );
  }
}
