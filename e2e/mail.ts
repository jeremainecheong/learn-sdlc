import * as fs from 'fs';
import * as path from 'path';

/**
 * Outbound mail, as the browser suite sees it.
 *
 * The API under the harness runs without SMTP_HOST, so MailService writes
 * every message to its log, which a browser cannot read. playwright.config.ts
 * therefore also sets MAIL_CAPTURE_FILE, a test hook in
 * apps/api/src/mail/mail.service.ts that appends one JSON line per message
 * ({"to","subject","text","sentAt"}) to this path. The config removes the file
 * when it loads, so a run only ever sees its own mail.
 *
 * Under test-results/ because Playwright owns and gitignores that directory
 * and clears it before the servers start.
 */
export const MAIL_CAPTURE_FILE = path.resolve(__dirname, '..', 'test-results', 'mail-capture.jsonl');

export interface CapturedMail {
  to: string;
  subject: string;
  text: string;
  sentAt: string;
}

/**
 * The two links RecoveryService mails, each on its own line of the text body:
 * `${SITE_URL}/reset?token=…` and `${SITE_URL}/verify?token=…`.
 */
export type RecoveryLinkKind = 'reset' | 'verify';

/** Everything captured so far, oldest first. No file yet means nothing has been sent. */
export function readCapturedMail(): CapturedMail[] {
  let raw: string;
  try {
    raw = fs.readFileSync(MAIL_CAPTURE_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // Only whole lines: a read that lands mid-append must not choke on the tail.
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  return complete
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedMail);
}

/** The first URL in the message body that carries `/<kind>?token=`, or null. */
export function recoveryLink(message: CapturedMail, kind: RecoveryLinkKind): string | null {
  const urls = message.text.match(/https?:\/\/\S+/g) ?? [];
  return urls.find((url) => url.includes(`/${kind}?token=`)) ?? null;
}

/** The link in the newest message to `email` of the given kind, or null while none has arrived. */
export function newestRecoveryLink(email: string, kind: RecoveryLinkKind): string | null {
  const wanted = email.trim().toLowerCase();
  const mine = readCapturedMail().filter((m) => m.to.trim().toLowerCase() === wanted);
  for (let i = mine.length - 1; i >= 0; i--) {
    const link = recoveryLink(mine[i], kind);
    if (link) return link;
  }
  return null;
}

/**
 * Waits for a reset or verification link to be mailed to `email` and returns
 * it. The mail is handed off after the HTTP response, forgot() deliberately
 * does not await it, so this polls up to a deadline rather than reading once.
 */
export async function waitForRecoveryLink(
  email: string,
  kind: RecoveryLinkKind,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const link = newestRecoveryLink(email, kind);
    if (link) return link;
    if (Date.now() >= deadline) {
      throw new Error(
        `no ${kind} link was mailed to ${email} within ${timeoutMs}ms (capture file: ${MAIL_CAPTURE_FILE})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
