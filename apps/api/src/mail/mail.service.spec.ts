import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MailService, recipientDigest } from './mail.service';

// Nothing here may open a socket: in smtp mode the transport is a stub that
// records what it was asked to send. Referenced lazily, from inside
// createTransport, so the hoisted factory never touches it before it exists.
const mockSendMail = jest.fn().mockResolvedValue({ accepted: [] });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

/**
 * The MAIL_CAPTURE_FILE test hook. It exists for the browser suite
 * (e2e/mail.ts) and must stay exactly this narrow: console mode only, append
 * only, and inert without the variable.
 */
describe('MailService capture file', () => {
  const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_CAPTURE_FILE', 'MAIL_PREVIEW_URL'] as const;
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
  let dir: string;
  let log: jest.SpyInstance;

  const message = {
    to: 'learner@learnsdlc.test',
    subject: 'Reset your LearnSDLC password',
    text: 'Open the link below within the hour:\n\nhttp://localhost:3000/reset?token=abc.def.ghi\n',
    html: '<p>ignored by the capture</p>',
  };

  beforeEach(() => {
    for (const key of ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-mail-'));
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Console mode warns at construction now; keep it out of the test output.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    mockSendMail.mockClear();
  });

  afterEach(() => {
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lines = (file: string) =>
    fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0);

  it('appends one JSON line per message in console mode when MAIL_CAPTURE_FILE is set', async () => {
    // A directory that does not exist yet: the hook has to make it.
    const file = path.join(dir, 'nested', 'mail-capture.jsonl');
    process.env.MAIL_CAPTURE_FILE = file;
    const mail = new MailService();
    expect(mail.mode).toBe('console');
    expect(mail.delivery()).toEqual({ available: true, mode: 'local_file' });

    await mail.send(message);
    await mail.send({ ...message, to: 'other@learnsdlc.test', subject: 'Confirm your LearnSDLC email address' });

    const written = lines(file);
    expect(written).toHaveLength(2);
    const first = JSON.parse(written[0]);
    expect(first).toEqual({
      to: message.to,
      subject: message.subject,
      text: message.text,
      sentAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(first.sentAt))).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(written[1])).toMatchObject({
      to: 'other@learnsdlc.test',
      subject: 'Confirm your LearnSDLC email address',
    });
    // Still the console transport underneath: never sent. The log line names
    // a digest of the recipient and the subject; the address is in the file
    // above, and the body, which carries the link, is there and nowhere else.
    expect(log).toHaveBeenCalledWith(expect.stringContaining(recipientDigest(message.to)));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(message.to));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('token='));
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('never truncates: a message lands after whatever the file already holds', async () => {
    const file = path.join(dir, 'mail-capture.jsonl');
    fs.writeFileSync(file, '{"to":"earlier@learnsdlc.test","subject":"s","text":"t","sentAt":"2026-09-02T00:00:00.000Z"}\n');
    process.env.MAIL_CAPTURE_FILE = file;

    await new MailService().send(message);

    const written = lines(file);
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]).to).toBe('earlier@learnsdlc.test');
    expect(JSON.parse(written[1]).to).toBe(message.to);
  });

  it('writes nothing in smtp mode even with MAIL_CAPTURE_FILE set', async () => {
    const file = path.join(dir, 'mail-capture.jsonl');
    process.env.SMTP_HOST = 'smtp.example.edu';
    process.env.MAIL_CAPTURE_FILE = file;
    const mail = new MailService();
    expect(mail.mode).toBe('smtp');

    await mail.send(message);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: message.to, subject: message.subject, text: message.text }),
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes nothing when MAIL_CAPTURE_FILE is unset', async () => {
    const mail = new MailService();
    expect(mail.mode).toBe('console');
    expect(mail.delivery()).toEqual({ available: false, mode: 'unavailable' });

    await mail.send(message);

    // Nothing is written, and the link is not in the log either: with neither
    // SMTP_HOST nor MAIL_CAPTURE_FILE the message is simply gone, which the
    // boot warning says out loud. The address is not in the log either.
    expect(log).toHaveBeenCalledWith(expect.stringContaining(recipientDigest(message.to)));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(message.to));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('token='));
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('exposes an explicit loopback inbox but never remote or credential-bearing preview URLs', () => {
    process.env.SMTP_HOST = 'mailpit';
    const mail = new MailService();
    process.env.MAIL_PREVIEW_URL = 'http://localhost:5085';
    expect(mail.delivery()).toEqual({ available: true, mode: 'local_inbox', inboxUrl: 'http://localhost:5085' });
    for (const value of ['https://mail.example.test', 'http://name:secret@localhost:5085', 'javascript:alert(1)']) {
      process.env.MAIL_PREVIEW_URL = value;
      expect(mail.delivery()).toEqual({ available: true, mode: 'email' });
    }
  });
});

/**
 * What console mode is allowed to say out loud, and when it says anything.
 *
 * A reset link is a one-hour credential for somebody's account, and console
 * mode is not the development path: it is every deployment without SMTP, the
 * laptop hosting a section included. Without these rules the whole class's
 * links would scroll past on the instructor's screen, and a warning gated on
 * NODE_ENV=production would never fire there.
 */
describe('MailService in console mode', () => {
  const RESET_LINK = 'http://localhost:3000/reset?token=eyJhbGciOi.SECRET-TOKEN-VALUE.9dK1';
  const message = {
    to: 'learner@example.edu',
    subject: 'Reset your LearnSDLC password',
    text: `Someone asked to reset your password.\n\n${RESET_LINK}\n\nThe link expires in one hour.`,
  };

  let logs: string[];
  let warnings: string[];
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['SMTP_HOST', 'MAIL_CAPTURE_FILE']) saved[key] = process.env[key];
    delete process.env.SMTP_HOST;
    delete process.env.MAIL_CAPTURE_FILE;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-mail-log-'));
    logs = [];
    warnings = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => void warnings.push(String(m)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('logs a digest of the recipient and the subject, and never the link or the address', async () => {
    process.env.MAIL_CAPTURE_FILE = path.join(dir, 'mail.jsonl');

    await new MailService().send(message);

    const line = logs.join('\n');
    // The address is a learner's personal data on a log the class host ships
    // to an aggregator; eight hex characters of its hash match two lines to
    // one person without saying who.
    expect(line).toContain(`recipient=${recipientDigest('learner@example.edu')}`);
    expect(line).not.toContain('learner@example.edu');
    expect(line).not.toContain('@');
    expect(line).toContain('Reset your LearnSDLC password');
    expect(line).not.toContain('token=');
    expect(line).not.toContain('SECRET-TOKEN-VALUE');
    expect(line).not.toContain(RESET_LINK);
    // Nor by another route: no part of the body is in the log.
    expect(line).not.toContain('expires in one hour');
  });

  it('still puts the link somewhere a person can read it', async () => {
    const file = path.join(dir, 'mail.jsonl');
    process.env.MAIL_CAPTURE_FILE = file;

    await new MailService().send(message);

    const captured = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    expect(captured.to).toBe('learner@example.edu');
    expect(captured.text).toContain(RESET_LINK);
  });

  it('warns at construction whenever SMTP_HOST is unset, not only in production', () => {
    // NODE_ENV is 'test' here, and is unset on the class laptop. A warning
    // guarded by config.isProduction would never reach the one deployment
    // where real people are waiting for real links.
    expect(process.env.NODE_ENV).not.toBe('production');
    process.env.MAIL_CAPTURE_FILE = path.join(dir, 'mail.jsonl');

    new MailService();

    expect(warnings.join('\n')).toMatch(/SMTP_HOST is not set/);
    expect(warnings.join('\n')).toContain(path.join(dir, 'mail.jsonl'));
  });

  it('says plainly that no link is recorded when there is nowhere to record it', () => {
    new MailService();

    expect(warnings.join('\n')).toMatch(/SMTP_HOST is not set/);
    expect(warnings.join('\n')).toMatch(/MAIL_CAPTURE_FILE/);
  });

  it('keeps the body and the address out of the log when there is no capture file either', async () => {
    await new MailService().send(message);

    const line = logs.join('\n');
    expect(line).toContain(recipientDigest('learner@example.edu'));
    expect(line).not.toContain('learner@example.edu');
    expect(line).not.toContain('token=');
  });

  it('digests the address the same however it was typed, and short enough to read', () => {
    expect(recipientDigest('Learner@Example.edu ')).toBe(recipientDigest('learner@example.edu'));
    expect(recipientDigest('learner@example.edu')).toMatch(/^[0-9a-f]{8}$/);
    expect(recipientDigest('learner@example.edu')).not.toBe(recipientDigest('other@example.edu'));
  });

  it('warns about none of this once SMTP_HOST is set', () => {
    process.env.SMTP_HOST = 'smtp.example.edu';
    process.env.MAIL_CAPTURE_FILE = path.join(dir, 'mail.jsonl');

    expect(new MailService().mode).toBe('smtp');
    expect(warnings).toEqual([]);
  });
});
