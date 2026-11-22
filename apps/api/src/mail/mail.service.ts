import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { resolveMailPreviewUrl, resolveMailSettings } from '../config/mail';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailMode = 'smtp' | 'console';
export interface MailDelivery {
  available: boolean;
  mode: 'email' | 'local_inbox' | 'local_file' | 'unavailable';
  inboxUrl?: string;
}

/**
 * The first eight hex characters of the address's sha256, lower-cased and
 * trimmed first so one person's two spellings match. What console mode logs
 * in place of the address itself.
 */
export function recipientDigest(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 8);
}

/**
 * Outbound mail. With SMTP_HOST set, nodemailer over SMTP; without it, the
 * message is not sent and the log records only that it was not, naming the
 * subject and a short digest of the recipient (never the address itself).
 *
 * The body stays out of the log on purpose. A reset link is a one-hour
 * credential for somebody's account, and console mode is the class path, not
 * only the development one: without this, every learner's link scrolled past
 * on the instructor's screen and sat in whatever collects that output.
 * MAIL_CAPTURE_FILE below is where a message's text goes instead, and the
 * boot warning names it.
 *
 * The SMTP settings are read here rather than from config.ts because this
 * service is their only consumer: SMTP_HOST, SMTP_PORT (587), SMTP_SECURE
 * (implicit TLS; defaults to true only on port 465, matching nodemailer's own
 * guidance), SMTP_USER / SMTP_PASS (auth is only attempted when a user is
 * given) and SMTP_FROM.
 *
 * MAIL_CAPTURE_FILE is where console mode puts the message itself: every
 * message is appended to that path as one JSON line:
 * {"to","subject","text","sentAt"}, so e2e/mail.ts can read a reset or
 * verification link back out of a real round trip, and so an instructor
 * running without SMTP has one file to look in rather than a log to scroll.
 * The file is created (parent directory included) on the first message and
 * only ever appended to; playwright.config.ts sets the variable and clears
 * the file between runs, and scripts/start.sh points it at data/mail.log.
 * Treat it as a mailbox: it holds live credentials. With SMTP_HOST set it is
 * ignored outright: a message that was actually sent is copied nowhere.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  readonly mode: MailMode;
  private readonly from: string;
  private readonly transporter: Transporter | null;
  /** Console mode with MAIL_CAPTURE_FILE set; null otherwise. See the class comment. */
  private readonly captureFile: string | null;

  /** Public capability only; never disclose transport credentials or file paths. */
  delivery(): MailDelivery {
    if (!this.transporter) return { available: Boolean(this.captureFile), mode: this.captureFile ? 'local_file' : 'unavailable' };
    // A preview inbox is an explicit local-development setting. Never turn an
    // arbitrary configured string into a public link or expose a remote inbox.
    try {
      const url = new URL(resolveMailPreviewUrl());
      if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password) {
        return { available: true, mode: 'local_inbox', inboxUrl: url.origin };
      }
    } catch { /* Regular SMTP has no public preview. */ }
    return { available: true, mode: 'email' };
  }

  constructor() {
    const settings = resolveMailSettings();
    const host = settings.host;
    this.from = settings.from;

    if (!host) {
      this.mode = 'console';
      this.transporter = null;
      this.captureFile = settings.captureFile;
      // Warned in every environment, not only production. The deployment that
      // needs to hear this is the laptop hosting a section, and it sets no
      // NODE_ENV: a production-only warning would never fire on the one path
      // where real people are waiting for real links.
      this.logger.warn(
        this.captureFile
          ? `SMTP_HOST is not set: recovery and verification mail is not sent. Each message is ` +
              `appended to ${this.captureFile}, which holds live one-hour links — read the newest ` +
              'line for an address, and keep the file as private as a mailbox.'
          : 'SMTP_HOST is not set: recovery and verification mail is not sent, and no link is ' +
              'recorded anywhere. Set SMTP_HOST to send it, or MAIL_CAPTURE_FILE to a path you ' +
              'can read the links out of; nobody can reset a password until one of the two is set.',
      );
      return;
    }

    const { port, secure, user } = settings;
    this.mode = 'smtp';
    this.captureFile = null;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: settings.pass } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      // A digest of the recipient and the subject, never the body: the body
      // carries the token, and the address is a learner's personal data on a
      // log the class host ships elsewhere. The digest is enough to match
      // two lines to one person, and MAIL_CAPTURE_FILE holds the address.
      this.logger.log(
        `mail not sent (SMTP_HOST unset) recipient=${recipientDigest(message.to)} subject=${JSON.stringify(message.subject)}` +
          (this.captureFile ? ` body=${this.captureFile}` : ' body=dropped (set MAIL_CAPTURE_FILE)'),
      );
      if (this.captureFile) await this.capture(this.captureFile, message);
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...message });
  }

  /**
   * One JSON line per message, appended (never written over) so a run's
   * messages accumulate in order and the reader can take the newest for an
   * address. The directory is made on every call because the harness clears
   * it between runs.
   */
  private async capture(file: string, message: MailMessage): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      to: message.to,
      subject: message.subject,
      text: message.text,
      sentAt: new Date().toISOString(),
    });
    await fs.promises.appendFile(file, `${line}\n`, { mode: 0o600 });
  }
}
