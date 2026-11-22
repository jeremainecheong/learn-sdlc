import { PasswordWorkService } from './password-work.service';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import type { AuditEventView, AuthResponse, Role } from '@learnsdlc/shared';
import { config } from '../config';
import { UserEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { recordAudit } from '../audit/audit';
import { AuthService, emailDomainRefusal } from './auth.service';
import { safeReturnPath } from './return-path';
import {
  codeChallenge,
  GoogleIdentity,
  GoogleIdTokenVerifier,
  GoogleTokenError,
  googleIdTokenVerifier,
} from './google-tokens';

/** DI token, so a spec can hand the service a verifier without a network. */
export const GOOGLE_ID_TOKEN_VERIFIER = 'GOOGLE_ID_TOKEN_VERIFIER';

export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * How long the round trip to Google may take. Long enough for a consent
 * screen and a password manager, short enough that a state pasted back a day
 * later is refused rather than replayed.
 */
export const STATE_TTL_MS = 15 * 60_000;

/** What the callback carries back, once the state has proved to be ours. */
interface StatePayload {
  /** Ties the ID token to this attempt (the OpenID `nonce`) and seeds PKCE. */
  n: string;
  /** Where the web app should land afterwards. Always a same-origin path. */
  r: string;
  /** Epoch milliseconds. */
  exp: number;
}

export class GoogleSignInError extends Error {}

/**
 * The audit event a reclaimed account writes.
 *
 * It is a member of `AuditEventView['event']` in `packages/shared`. The
 * console renders an unknown event as its own name rather than blank, so the
 * row is legible to a console that does not know it too.
 */
export const ACCOUNT_CLAIMED_EVENT: AuditEventView['event'] = 'account.claimed';

/**
 * Where the nonce that started a sign-in is kept between the two legs.
 *
 * `__Host-` is the strong name: the browser accepts it only over a secure
 * connection, for this exact host, at path `/`, with no `Domain`, and it
 * costs the `Secure` attribute, which a browser will not take over plain
 * http. Google itself allows a plain-http redirect URI only on localhost, so
 * the prefix is used wherever the callback is https (every real deployment)
 * and the plain name on a local http one, where there is no sibling host to
 * defend against in the first place. The callback's own origin decides,
 * because that is the origin the cookie is set on and read at.
 */
export function oauthNonceCookie(): { name: string; secure: boolean } {
  const secure = config.googleRedirectUrl.startsWith('https://');
  return { name: secure ? '__Host-oauth-nonce' : 'oauth-nonce', secure };
}

/**
 * Google sign-in.
 *
 * The API holds no session of its own between the two requests, so everything
 * the callback needs travels in the `state` parameter, signed with a key
 * derived from JWT_SECRET: the same trick recovery links use, and for the
 * same reason: a value that has been out in a browser must never be
 * presentable as a session. A tampered or expired state is refused before a
 * single byte is sent to Google.
 *
 * PKCE rides on the same nonce. The verifier is not put in the URL, it is
 * derived from the signed nonce with a server-side key, so the copy of the
 * redirect that ends up in browser history or a referrer header cannot be
 * used to complete the exchange even if the code were stolen with it.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  private readonly stateKey = createHmac('sha256', config.jwtSecret)
    .update('learnsdlc-oauth-state')
    .digest();
  private readonly pkceKey = createHmac('sha256', config.jwtSecret)
    .update('learnsdlc-oauth-pkce')
    .digest();

  private readonly verifier: GoogleIdTokenVerifier;

  constructor(
    private readonly passwords: PasswordWorkService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly auth: AuthService,
    @Optional() @Inject(GOOGLE_ID_TOKEN_VERIFIER) verifier?: GoogleIdTokenVerifier,
  ) {
    this.verifier = verifier ?? googleIdTokenVerifier;
  }

  /** Both halves of an OAuth client, or the button is never offered. */
  enabled(): boolean {
    return config.authProvider !== 'cognito' && Boolean(config.googleClientId && config.googleClientSecret);
  }

  private assertEnabled(): void {
    if (!this.enabled()) {
      throw new BadRequestException('Google sign-in is not configured on this server');
    }
  }

  /* ------------------------------- the state ------------------------------ */

  private sign(payload: string): string {
    return createHmac('sha256', this.stateKey).update(payload).digest('base64url');
  }

  /**
   * The return path the state carries: a path on this site or '', by the rule
   * both sign-in doors share (auth/return-path.ts). A method so a spec can
   * stand a state minted under another rule in front of the callback.
   */
  private returnPath(next: string | undefined): string {
    return safeReturnPath(next);
  }

  /** 128 bits, base64url, so it survives a cookie and a URL untouched. */
  private mintNonce(): string {
    return randomBytes(16).toString('base64url');
  }

  private mintState(
    next: string | undefined,
    now: number,
    withNonce?: string,
  ): { state: string; nonce: string } {
    const nonce = withNonce || this.mintNonce();
    const payload: StatePayload = {
      n: nonce,
      r: this.returnPath(next),
      exp: now + STATE_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { state: `${body}.${this.sign(body)}`, nonce };
  }

  /**
   * The reverse, and the first thing the callback does. Signature before
   * contents, and compared in constant time, so the check itself leaks
   * nothing about the key.
   */
  readState(state: string, now = Date.now()): StatePayload {
    const [body, signature] = (state || '').split('.');
    if (!body || !signature) throw new GoogleSignInError('that sign-in link is not one of ours');

    const expected = Buffer.from(this.sign(body), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new GoogleSignInError('that sign-in link is not one of ours');
    }

    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    } catch {
      throw new GoogleSignInError('that sign-in link is not one of ours');
    }
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new GoogleSignInError('that sign-in attempt took too long — start again');
    }
    if (typeof payload.n !== 'string' || !payload.n) {
      throw new GoogleSignInError('that sign-in link is not one of ours');
    }
    return payload;
  }

  /** A verifier nobody can compute without this process's key. */
  private codeVerifier(nonce: string): string {
    return createHmac('sha256', this.pkceKey).update(nonce).digest('base64url');
  }

  /* ------------------------------ the redirect ----------------------------- */

  /**
   * Where to send the browser to start a sign-in, and the nonce that attempt
   * is now identified by.
   *
   * The caller puts the nonce in a cookie on this origin. The signed state
   * proves the callback's parameters are ours; the cookie proves they came
   * back to the browser that asked for them, which the state alone cannot say:
   * anyone who obtains one can walk it to a callback from anywhere.
   */
  beginSignIn(next?: string, now = Date.now()): { url: string; nonce: string } {
    const nonce = this.mintNonce();
    return { url: this.authorizationUrl(next, now, nonce), nonce };
  }

  /** Where to send the browser to start a sign-in. */
  authorizationUrl(next?: string, now = Date.now(), withNonce?: string): string {
    this.assertEnabled();
    const { state, nonce } = this.mintState(next, now, withNonce);
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirectUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge(this.codeVerifier(nonce)),
      code_challenge_method: 'S256',
      // A classroom machine is often a shared one, so the account chooser is
      // asked for every time rather than letting Google sign in whoever it
      // last saw. Consent is still remembered; only the choice is re-asked.
      prompt: 'select_account',
    });
    // Google returns the accounts that match before the picker is drawn, which
    // is the whole point of restricting sign-in to one institution.
    if (config.allowedEmailDomains.length === 1) params.set('hd', config.allowedEmailDomains[0]);
    return `${GOOGLE_AUTHORIZATION_URL}?${params.toString()}`;
  }

  /* ------------------------------ the callback ----------------------------- */

  /**
   * Swap the code for an ID token. The client secret makes this the one leg
   * of the flow an attacker holding a stolen code cannot walk.
   */
  private async exchange(code: string, verifier: string): Promise<string> {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUrl,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) {
      // The reason is Google's and belongs in the log, not on the page: the
      // person at the browser cannot act on "invalid_grant".
      this.logger.warn(`google token exchange failed (${res.status}): ${body.error ?? 'no id_token'}`);
      throw new GoogleSignInError('Google would not complete that sign-in — try again');
    }
    return body.id_token;
  }

  /**
   * The whole callback: prove the state is ours, prove it is this browser's,
   * exchange the code, verify the token Google signed, then apply this
   * deployment's rules to the address it names. Returns the same session a
   * password sign-in returns, plus where the web app should go next.
   *
   * `browserNonce` is the cookie set when the redirect was minted. Both
   * checks happen before Google is spoken to, so a callback that was never
   * started here costs this server nothing.
   */
  async complete(
    code: string | undefined,
    state: string | undefined,
    browserNonce: string | undefined,
    now = Date.now(),
  ): Promise<{ auth: AuthResponse; returnPath: string }> {
    this.assertEnabled();
    const payload = this.readState(state || '', now);
    this.assertStartedHere(payload.n, browserNonce);
    if (!code) throw new GoogleSignInError('Google sent us back without a sign-in code');

    const idToken = await this.exchange(code, this.codeVerifier(payload.n));

    let identity: GoogleIdentity;
    try {
      identity = await this.verifier.verify(idToken, config.googleClientId);
    } catch (err) {
      if (err instanceof GoogleTokenError) throw new GoogleSignInError(err.message);
      throw err;
    }
    // Binds the token to the redirect we started: a token minted for another
    // attempt, or replayed from one, carries a different nonce.
    if (identity.nonce !== payload.n) {
      throw new GoogleSignInError('that sign-in did not match the attempt it started from');
    }
    if (!identity.emailVerified) {
      throw new GoogleSignInError(
        'Google has not confirmed that address yet — confirm it with Google, or sign in with a password',
      );
    }
    this.assertDomainAllowed(identity.email);

    const user = await this.linkOrCreate(identity.email, identity.name);
    return { auth: await this.auth.issueSession(user), returnPath: this.returnPath(payload.r) };
  }

  /**
   * The state proves the parameters are ours. This proves they came back to
   * the browser that asked for them.
   *
   * Without it the state is a bearer token for a sign-in: one lifted from a
   * shared machine's history, a referrer or a screen can be finished from
   * anywhere, and a state minted by an attacker and planted on someone else's
   * browser signs them into the attacker's account: the classic login CSRF,
   * where the victim then does their work inside an account that is watched.
   * The nonce lives in an HttpOnly cookie on this origin, so no page can read
   * it and no other origin can present it.
   */
  private assertStartedHere(nonce: string, browserNonce: string | undefined): void {
    const expected = Buffer.from(nonce, 'utf8');
    const given = Buffer.from(browserNonce || '', 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new GoogleSignInError('that sign-in did not start in this browser — start again');
    }
  }

  /** The shared rule, in this door's words. Registration applies the same one. */
  private assertDomainAllowed(email: string): void {
    const refusal = emailDomainRefusal(email, 'Google sign-in');
    if (refusal) throw new GoogleSignInError(refusal);
  }

  /**
   * One account per address, whichever way its owner signs in. An instructor
   * who registered with a password and later uses the button lands on the row
   * they already have (same id, same role, same cohort, same work) because
   * a second row would silently orphan a term of it.
   *
   * A new row gets LEARNER and a password nobody holds: the hash is of random
   * bytes that are discarded here, so the account cannot be entered with a
   * password until its owner sets one through /forgot.
   */
  private async linkOrCreate(email: string, name?: string): Promise<UserEntity> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      if (existing.disabledAt) {
        throw new GoogleSignInError('this account is suspended — contact your instructor');
      }
      // Google only hands over an address it has confirmed, which is the same
      // proof our own emailed link gives, so a learner who arrives this way is
      // not asked to confirm an address twice.
      if (!existing.emailVerifiedAt) return this.claim(existing);
      return existing;
    }

    const displayName = (name || '').trim() || email.slice(0, email.indexOf('@'));
    const user = this.users.create({
      email,
      passwordHash: await this.passwords.hash(randomBytes(32).toString('base64')),
      displayName,
      role: 'LEARNER' as Role,
      emailVerifiedAt: new Date().toISOString(),
    });
    await this.users.save(user);
    this.logger.log(`google sign-in created account ${user.id}`);
    return user;
  }

  /**
   * A row holding this address that nobody has ever proved they own.
   *
   * Registration asks for an address and takes it on trust, so anyone could
   * open an account on a classmate's address, sit on it, and wait: when the
   * real owner pressed the Google button they landed on the squatter's row,
   * verified at last, still carrying the squatter's password and whatever
   * sessions they were holding. The address is only now proved, and it is
   * proved to the person at this browser, so the credentials nobody proved
   * anything with do not survive the moment:
   *
   * - the password is written out (the column is NOT NULL, so "none" is a
   *   value bcrypt cannot match: it refuses anything that is not a 60
   *   character hash, so no candidate matches an empty one). /forgot sets a
   *   real one, from the mailbox this sign-in just proved;
   * - `tokenVersion` moves, which refuses every token issued before now, and
   *   the cached row is dropped so the guard and the socket see it at once;
   * - a row goes in the trail, because losing a password silently is not
   *   something a person should have to reconstruct from memory.
   *
   * A learner who registered here and simply prefers the button lands in the
   * same place, and that is the intended trade: the account was never
   * confirmed, so the server cannot tell the two apart, and the recoverable
   * cost is one password reset.
   */
  private async claim(existing: UserEntity): Promise<UserEntity> {
    existing.emailVerifiedAt = new Date().toISOString();
    existing.passwordHash = '';
    existing.tokenVersion += 1;
    await this.users.save(existing);
    this.auth.forgetSession(existing.id);

    await recordAudit(this.users.manager, {
      event: ACCOUNT_CLAIMED_EVENT,
      actorUserId: existing.id,
      subjectUserId: existing.id,
      action: 'google',
      reason:
        'Google confirmed this address on an account nobody had confirmed. Its password was ' +
        'cleared and its earlier sessions were signed out.',
      detail: { via: 'google', passwordCleared: true, tokenVersion: existing.tokenVersion },
    });
    this.logger.warn(
      `google sign-in claimed unconfirmed account ${existing.id}: password cleared, ` +
        `sessions signed out (tokenVersion ${existing.tokenVersion})`,
    );
    return existing;
  }
}
