import { PasswordWorkService } from './password-work.service';
import { BadRequestException, Injectable, Logger, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { config, siteUrl } from '../config';
import { UserEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { recordAudit } from '../audit/audit';
import { MailService } from '../mail/mail.service';
import { AuthService } from './auth.service';
import { CognitoService, passwordChangedSignInRequired } from './cognito.service';
import { BUMP_TOKEN_VERSION } from '../db/token-version';
import { normaliseEmail } from './email';
import { escapeHtml } from './html';

export type RecoveryPurpose = 'reset' | 'verify';

/**
 * A reset link is a bearer credential for the account sitting in an inbox;
 * an hour is long enough to open the mail and short enough that a mailbox
 * compromised next week finds nothing usable. Verification proves only
 * mailbox control, so it gets a day.
 */
export const RESET_TOKEN_TTL = '1h';
export const VERIFY_TOKEN_TTL = '24h';

/**
 * What /auth/forgot answers, whether or not the address is registered. One
 * object, returned by reference, so there is no way for the two cases to
 * drift apart and start telling an attacker which addresses have accounts.
 */
export const FORGOT_RESPONSE = Object.freeze({
  sent: true,
  message: 'If an account exists for that address, a reset link has been requested. Check your inbox in a few minutes. The link expires in an hour.',
});

/**
 * Recovery links are signed with a key derived from the session secret, not
 * the session secret itself. The bearer guard verifies against the session
 * secret, so a reset token (which sits in an email, a URL and a browser
 * history for an hour) can never be presented as a session, and a session
 * token can never be presented as a reset. Exported so the e2e suite can mint
 * an already-expired link.
 */
export function recoveryTokenSecret(jwtSecret: string): string {
  return createHmac('sha256', jwtSecret).update('learnsdlc-recovery').digest('hex');
}

interface RecoveryPayload {
  sub: string;
  purpose: RecoveryPurpose;
  /** Reset links: the tokenVersion the link was minted for. */
  ver?: number;
  /** Verification links: the address being confirmed. */
  email?: string;
}

const LINK_INVALID: Record<RecoveryPurpose, string> = {
  reset: 'this reset link is invalid, has expired or has already been used — request a new one',
  verify: 'this verification link is invalid or has expired — request a new one from your account',
};

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly secret = recoveryTokenSecret(config.jwtSecret);

  constructor(
    private readonly passwords: PasswordWorkService,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly auth: AuthService,
    @Optional() private readonly cognito?: CognitoService,
  ) {}

  /**
   * Always the same 200, and always in about the same time: the token is
   * signed synchronously and the mail is handed off without being awaited, so
   * the response does not wait on SMTP for registered addresses only. A
   * suspended account gets no link: the reset would succeed and the sign-in
   * would still be refused, which is a worse experience than silence.
   */
  async forgot(email: string) {
    if (config.authProvider === 'cognito') {
      if (!this.cognito?.enabled()) throw new ServiceUnavailableException('Managed recovery is unavailable.');
      return this.cognito.forgot(normaliseEmail(email));
    }
    const delivery = this.mail.delivery();
    if (!delivery.available) throw new ServiceUnavailableException('Password recovery is unavailable on this installation. Contact the LearnSDLC host to enable email delivery, then try again.');
    const normalized = normaliseEmail(email);
    const user = await this.users.findOne({ where: { email: normalized } });
    if (user && !user.disabledAt) {
      const token = this.jwt.sign(
        { sub: user.id, purpose: 'reset', ver: user.tokenVersion } satisfies RecoveryPayload,
        { secret: this.secret, expiresIn: RESET_TOKEN_TTL },
      );
      const link = `${siteUrl()}/reset?token=${encodeURIComponent(token)}`;
      this.mail
        .send({
          to: user.email,
          subject: 'Reset your LearnSDLC password',
          text: [
            `Hi ${user.displayName},`,
            '',
            'Someone — probably you — asked to reset the password for this LearnSDLC account.',
            'Open the link below within the hour to choose a new one:',
            '',
            link,
            '',
            'If you did not ask for this, ignore this message; your password stays as it is.',
          ].join('\n'),
          html: [
            `<p>Hi ${escapeHtml(user.displayName)},</p>`,
            '<p>Someone — probably you — asked to reset the password for this LearnSDLC account. Open the link below within the hour to choose a new one:</p>',
            `<p><a href="${link}">${link}</a></p>`,
            '<p>If you did not ask for this, ignore this message; your password stays as it is.</p>',
          ].join('\n'),
        })
        .catch((err: unknown) => {
          // The id, never the address: this is the log line that gets read
          // while someone is hammering the endpoint.
          this.logger.error(`reset mail for ${user.id} failed: ${(err as Error).message}`);
        });
    }
    return delivery.mode === 'email' ? FORGOT_RESPONSE : {
      sent: true,
      delivery: delivery.mode,
      message: delivery.mode === 'local_inbox'
        ? 'If an account exists for that address, its reset link has been requested in the local test inbox. This installation does not send mail to external inboxes. The link expires in an hour.'
        : 'If an account exists for that address, its reset link has been requested in this installation’s private development mailbox. Ask the LearnSDLC host for your link; no external email is sent.',
      ...(delivery.inboxUrl ? { inboxUrl: delivery.inboxUrl } : {}),
    };
  }

  /**
   * The link is checked against the row's current tokenVersion, and the write
   * bumps that version. Both together are what makes a link single-use: the
   * first reset changes the number the link was minted for, so the same link
   * presented again fails the same check an hour-old stolen session would.
   */
  async reset(token: string, password: string, email?: string, code?: string): Promise<{ changed: true }> {
    if (config.authProvider === 'cognito') {
      if (!this.cognito?.enabled()) throw new ServiceUnavailableException('Managed recovery is unavailable.');
      if (!email || !code || token) throw new BadRequestException('Enter your email and managed password-reset code.');
      const normalized=normaliseEmail(email);
      // Email locates an existing binding; it is never authority to create or
      // relink an account. Cognito verifies the code against this exact sub.
      const existing=await this.users.findOneBy({email:normalized});
      const bound=existing?.cognitoSub ? {id:existing.id,subject:existing.cognitoSub} : undefined;
      const result=await this.cognito.reset(normalized,code,password,bound?.subject);
      // Past this point the provider password change is committed. Preserve
      // that fact even if local persistence or concurrent binding checks fail.
      try {
        const user=bound
          ? await this.users.findOneBy({id:bound.id,cognitoSub:bound.subject})
          : await this.users.findOneBy({cognitoSub:result.subject});
        if (bound && !user) throw passwordChangedSignInRequired();
        if (user) {
          const changed=await this.users.update({id:user.id,cognitoSub:result.subject},
            {tokenVersion: BUMP_TOKEN_VERSION});
          this.auth.forgetSession(user.id);
          if (changed.affected!==1) throw passwordChangedSignInRequired();
          if (result.verifiedEmail===user.email && !user.emailVerifiedAt) {
            await this.users.update({id:user.id,cognitoSub:result.subject,email:user.email,emailVerifiedAt:IsNull()},
              {emailVerifiedAt:new Date().toISOString()});
          }
          await recordAudit(this.users.manager,{event:'password.reset',actorUserId:user.id,subjectUserId:user.id,
            action:'managed password reset by confirmation code',detail:{sessionsRevoked:true}});
        }
      } catch {
        if (bound) this.auth.forgetSession(bound.id);
        throw passwordChangedSignInRequired();
      }
      return {changed:true};
    }
    if (email || code) throw new BadRequestException('This installation uses password-reset links.');
    const payload = await this.readToken(token, 'reset');
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user || payload.ver !== user.tokenVersion) {
      throw new BadRequestException(LINK_INVALID.reset);
    }
    if (user.disabledAt) throw new BadRequestException('this account is suspended');

    const passwordHash = await this.passwords.hash(password);
    // Opening a link that only the mailbox received is proof of the address:
    // the same proof the verification link asks for.
    const verifiedNow = !user.emailVerifiedAt;
    // Consume the version in the same database write as the password. Two
    // concurrent requests can both verify the JWT, but only one may reset it.
    // Updating only these fields also preserves concurrent profile edits.
    const changed = await this.users.update(
      { id: user.id, tokenVersion: payload.ver, disabledAt: IsNull() },
      { passwordHash, tokenVersion: user.tokenVersion + 1, emailVerifiedAt: user.emailVerifiedAt || new Date().toISOString() },
    );
    if (changed.affected !== 1) throw new BadRequestException(LINK_INVALID.reset);
    this.auth.forgetSession(user.id);

    // The one credential change nobody has to prove they knew the old password
    // for: whoever opened the link now holds the account. So it goes in the
    // trail beside the change made from the account page, with the same two
    // ends, and an account taken over through a forwarded inbox leaves a dated
    // row rather than nothing at all.
    await recordAudit(this.users.manager, {
      event: 'password.reset',
      actorUserId: user.id,
      subjectUserId: user.id,
      action: 'password reset by emailed link',
      detail: { sessionsRevoked: true, verifiedEmail: verifiedNow },
    });

    this.logger.log(`password reset for ${user.id} by emailed link; earlier sessions and links revoked`);
    return { changed: true };
  }

  async requestVerification(userId: string): Promise<{ sent: boolean; verified: boolean; message?: string; inboxUrl?: string }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('this account no longer exists');
    if (user.emailVerifiedAt) return { sent: false, verified: true };
    if (config.authProvider === 'cognito') throw new BadRequestException('Confirm your address through managed sign-in.');
    const delivery = this.mail.delivery();
    if (!delivery.available) throw new ServiceUnavailableException('Email confirmation is unavailable on this installation. Contact the LearnSDLC host to enable email delivery, then try again.');

    const token = this.jwt.sign(
      { sub: user.id, purpose: 'verify', email: user.email } satisfies RecoveryPayload,
      { secret: this.secret, expiresIn: VERIFY_TOKEN_TTL },
    );
    const link = `${siteUrl()}/verify?token=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: user.email,
      subject: 'Confirm your LearnSDLC email address',
      text: [
        `Hi ${user.displayName},`,
        '',
        'Open the link below within 24 hours to confirm this address for your LearnSDLC account:',
        '',
        link,
        '',
        'If you did not create an account, ignore this message.',
      ].join('\n'),
      html: [
        `<p>Hi ${escapeHtml(user.displayName)},</p>`,
        '<p>Open the link below within 24 hours to confirm this address for your LearnSDLC account:</p>',
        `<p><a href="${link}">${link}</a></p>`,
        '<p>If you did not create an account, ignore this message.</p>',
      ].join('\n'),
    });
    return { sent: true, verified: false, ...(delivery.mode === 'email' ? {} : {
      message: delivery.mode === 'local_inbox' ? 'Your confirmation link is in the local test inbox. No external email is sent.' : 'Your confirmation link is in this installation’s private development mailbox. Ask the LearnSDLC host for your link.',
      ...(delivery.inboxUrl ? { inboxUrl: delivery.inboxUrl } : {}),
    }) };
  }

  /**
   * Public: the link may be opened on a device that is not signed in. Bound
   * to the address in the token rather than the row's version, so a link
   * survives an unrelated password change but can never confirm an address
   * the account has since moved away from.
   */
  async verify(token: string): Promise<{ verified: true; email: string }> {
    if (config.authProvider === 'cognito') throw new BadRequestException('This installation uses managed email-confirmation codes.');
    const payload = await this.readToken(token, 'verify');
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user || user.email !== payload.email) throw new BadRequestException(LINK_INVALID.verify);

    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date().toISOString();
      await this.users.save(user);
      this.logger.log(`email verified for ${user.id}`);
    }
    return { verified: true, email: user.email };
  }

  async status(userId: string): Promise<{ email: string; verified: boolean; verifiedAt: string | null }> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: ['id', 'email', 'emailVerifiedAt'],
    });
    if (!user) throw new UnauthorizedException('this account no longer exists');
    return { email: user.email, verified: Boolean(user.emailVerifiedAt), verifiedAt: user.emailVerifiedAt };
  }

  /**
   * Garbage, a bad signature, an expired link and a link for the other
   * purpose all get the same 400: the holder of a link learns nothing about
   * why it failed beyond "get another one".
   */
  private async readToken(token: string, purpose: RecoveryPurpose): Promise<RecoveryPayload> {
    let payload: Partial<RecoveryPayload>;
    try {
      payload = await this.jwt.verifyAsync<Partial<RecoveryPayload>>(token, { secret: this.secret });
    } catch {
      throw new BadRequestException(LINK_INVALID[purpose]);
    }
    if (payload.purpose !== purpose || typeof payload.sub !== 'string') {
      throw new BadRequestException(LINK_INVALID[purpose]);
    }
    return payload as RecoveryPayload;
  }
}
