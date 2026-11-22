import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuditEventEntity } from '../src/db/entities';
import { recoveryTokenSecret } from '../src/auth/recovery.service';
import { config } from '../src/config';
import { MailService } from '../src/mail/mail.service';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * Password recovery and address verification end to end, against the
 * in-memory database and the console mail transport. The transport is what a
 * developer runs with (no SMTP_HOST) so the link is read off the message
 * MailService was asked to send, exactly as it would be read off the log.
 */
describe('Recovery (e2e)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let mail: MailService;
  let sent: jest.SpyInstance;
  let captureDir: string;
  const originalCapture = process.env.MAIL_CAPTURE_FILE;

  const EMAIL = 'recovery@learnsdlc.test';
  const ORIGINAL = 'original-Correct-Horse';
  const REPLACEMENT = 'replacement-Battery-Staple';

  let registrationToken = '';
  let resetToken = '';

  const lastMessage = () => sent.mock.calls[sent.mock.calls.length - 1][0] as { to: string; text: string };
  const tokenFrom = (text: string, path: string) => {
    const match = text.match(/https?:\/\/\S+/);
    expect(match).not.toBeNull();
    const url = new URL(match![0]);
    expect(url.pathname).toBe(path);
    return url.searchParams.get('token') || '';
  };

  beforeAll(async () => {
    captureDir = mkdtempSync(join(tmpdir(), 'learnsdlc-recovery-e2e-'));
    process.env.MAIL_CAPTURE_FILE = join(captureDir, 'mail.jsonl');
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));

    mail = app.get(MailService);
    sent = jest.spyOn(mail, 'send');

    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: EMAIL, password: ORIGINAL, displayName: 'Recovery Tester' })
      .expect(201);
    registrationToken = res.body.token;
  });

  afterAll(async () => {
    await app.close();
    if (originalCapture === undefined) delete process.env.MAIL_CAPTURE_FILE;
    else process.env.MAIL_CAPTURE_FILE = originalCapture;
    rmSync(captureDir, { recursive: true, force: true });
  });

  it('runs with the console transport', () => {
    expect(mail.mode).toBe('console');
    expect(mail.delivery()).toEqual({ available: true, mode: 'local_file' });
  });

  it('refuses known and unknown recovery alike when delivery is unavailable, without claiming success', async () => {
    const unavailable = jest.spyOn(mail, 'delivery').mockReturnValue({ available: false, mode: 'unavailable' });
    sent.mockClear();
    try {
      const known = await request(http).post('/api/v1/auth/forgot').send({ email: EMAIL }).expect(503);
      const unknown = await request(http).post('/api/v1/auth/forgot').send({ email: 'absent@learnsdlc.test' }).expect(503);
      expect(known.body).toEqual(unknown.body);
      expect(known.body.message).toContain('Contact the LearnSDLC host');
      expect(sent).not.toHaveBeenCalled();
    } finally { unavailable.mockRestore(); }
  });

  it('answers forgot for an unknown address with 200 and sends nothing', async () => {
    sent.mockClear();
    const res = await request(http)
      .post('/api/v1/auth/forgot')
      .send({ email: 'nobody@learnsdlc.test' })
      .expect(200);
    expect(res.body.sent).toBe(true);
    expect(sent).not.toHaveBeenCalled();
  });

  it('answers forgot for a known address with the identical body, and mails a reset link', async () => {
    sent.mockClear();
    const unknown = await request(http)
      .post('/api/v1/auth/forgot')
      .send({ email: 'nobody-else@learnsdlc.test' })
      .expect(200);
    const known = await request(http)
      .post('/api/v1/auth/forgot')
      .send({ email: EMAIL.toUpperCase() })
      .expect(200);
    expect(known.body).toEqual(unknown.body);

    expect(sent).toHaveBeenCalledTimes(1);
    const message = lastMessage();
    expect(message.to).toBe(EMAIL);
    resetToken = tokenFrom(message.text, '/reset');
    expect(resetToken.length).toBeGreaterThan(20);
  });

  it('refuses the reset link as a bearer token', async () => {
    await request(http)
      .get('/api/v1/auth/me')
      .set({ authorization: `Bearer ${resetToken}` })
      .expect(401);
  });

  it('applies the sign-up password rules to the new password', async () => {
    await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: resetToken, password: 'short' })
      .expect(400);
    const common = await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: resetToken, password: 'password123' })
      .expect(400);
    expect(String(common.body.message)).toContain('breach');
  });

  it('resets the password with the link: old login 401, new login 200, old sessions out', async () => {
    const res = await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: resetToken, password: REPLACEMENT })
      .expect(200);
    expect(res.body).toEqual({ changed: true });

    await request(http)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: ORIGINAL })
      .expect(401);
    const login = await request(http)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: REPLACEMENT })
      .expect(200);
    expect(login.body.user.email).toBe(EMAIL);

    // The token issued at registration carries the old version.
    await request(http)
      .get('/api/v1/auth/me')
      .set({ authorization: `Bearer ${registrationToken}` })
      .expect(401);
  });

  it('records the reset in the audit trail', async () => {
    // The reset is the one credential change nobody proves they knew the old
    // password for (whoever opened the link now holds the account) so it
    // must leave a trace.
    const rows = await app
      .get(DataSource)
      .manager.find(AuditEventEntity, { where: { event: 'password.reset' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(rows[0].subjectUserId);
    expect(rows[0].action).toBe('password reset by emailed link');
    expect(rows[0].detail).toMatchObject({ sessionsRevoked: true });
    expect(JSON.stringify(rows[0])).not.toContain(REPLACEMENT);
  });

  it('refuses the same link a second time', async () => {
    await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: resetToken, password: 'another-Fine-Password' })
      .expect(400);
    // And the password did not move again.
    await request(http)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: REPLACEMENT })
      .expect(200);
  });

  it('refuses garbage, an expired link, and a link signed with the session secret', async () => {
    await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: 'not-a-token', password: 'another-Fine-Password' })
      .expect(400);

    const jwt = app.get(JwtService);
    const me = await request(http)
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: REPLACEMENT })
      .expect(200);
    const expired = jwt.sign(
      { sub: me.body.user.id, purpose: 'reset', ver: 1 },
      { secret: recoveryTokenSecret(config.jwtSecret), expiresIn: -1 },
    );
    await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: expired, password: 'another-Fine-Password' })
      .expect(400);

    // A session token has the right sub and ver; only the key is wrong.
    const session = jwt.sign({ sub: me.body.user.id, purpose: 'reset', ver: 1 });
    await request(http)
      .post('/api/v1/auth/reset')
      .send({ token: session, password: 'another-Fine-Password' })
      .expect(400);
  });

  describe('address verification', () => {
    let bearer = '';
    let verifyToken = '';

    beforeAll(async () => {
      const res = await request(http)
        .post('/api/v1/auth/register')
        .send({ email: 'verify@learnsdlc.test', password: ORIGINAL, displayName: 'Verify Tester' })
        .expect(201);
      bearer = res.body.token;
    });

    it('starts unverified and needs a session to ask for a link', async () => {
      await request(http).post('/api/v1/auth/verify/request').expect(401);
      const status = await request(http)
        .get('/api/v1/auth/verify/status')
        .set({ authorization: `Bearer ${bearer}` })
        .expect(200);
      expect(status.body).toEqual({ email: 'verify@learnsdlc.test', verified: false, verifiedAt: null });
    });

    it('mails a verification link', async () => {
      sent.mockClear();
      const res = await request(http)
        .post('/api/v1/auth/verify/request')
        .set({ authorization: `Bearer ${bearer}` })
        .expect(200);
      expect(res.body).toEqual({ sent: true, verified: false, message: 'Your confirmation link is in this installation’s private development mailbox. Ask the LearnSDLC host for your link.' });
      expect(sent).toHaveBeenCalledTimes(1);
      expect(lastMessage().to).toBe('verify@learnsdlc.test');
      verifyToken = tokenFrom(lastMessage().text, '/verify');
    });

    it('will not accept a verification link as a reset, or vice versa', async () => {
      await request(http)
        .post('/api/v1/auth/reset')
        .send({ token: verifyToken, password: 'another-Fine-Password' })
        .expect(400);
      // The reset link from earlier is spent, but the purpose check fires first.
      await request(http).post('/api/v1/auth/verify').send({ token: resetToken }).expect(400);
    });

    it('verifies without a session, is idempotent, and then stops offering links', async () => {
      const first = await request(http)
        .post('/api/v1/auth/verify')
        .send({ token: verifyToken })
        .expect(200);
      expect(first.body).toEqual({ verified: true, email: 'verify@learnsdlc.test' });
      await request(http).post('/api/v1/auth/verify').send({ token: verifyToken }).expect(200);

      const status = await request(http)
        .get('/api/v1/auth/verify/status')
        .set({ authorization: `Bearer ${bearer}` })
        .expect(200);
      expect(status.body.verified).toBe(true);
      expect(typeof status.body.verifiedAt).toBe('string');

      sent.mockClear();
      const again = await request(http)
        .post('/api/v1/auth/verify/request')
        .set({ authorization: `Bearer ${bearer}` })
        .expect(200);
      expect(again.body).toEqual({ sent: false, verified: true });
      expect(sent).not.toHaveBeenCalled();
    });

    it('treats a reset as proof of the address too', async () => {
      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: REPLACEMENT })
        .expect(200);
      const status = await request(http)
        .get('/api/v1/auth/verify/status')
        .set({ authorization: `Bearer ${login.body.token}` })
        .expect(200);
      expect(status.body.verified).toBe(true);
    });
  });

  it('consumes a reset link exactly once when two requests arrive together', async () => {
    await request(http).post('/api/v1/auth/forgot').send({ email: EMAIL }).expect(200);
    const token = tokenFrom(lastMessage().text, '/reset');
    const replies = await Promise.all([
      request(http).post('/api/v1/auth/reset').send({ token, password: REPLACEMENT }),
      request(http).post('/api/v1/auth/reset').send({ token, password: REPLACEMENT }),
    ]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 400]);
  });
});
