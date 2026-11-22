/** The sender recovery and verification mail carries when SMTP_FROM names none. */
export const DEFAULT_MAIL_FROM = 'LearnSDLC <no-reply@localhost>';

/** The SMTP port when SMTP_PORT names none: submission with STARTTLS. */
export const DEFAULT_SMTP_PORT = 587;

/** How the API sends mail, read from the environment when MailService is built. */
export interface MailSettings {
  /** SMTP_HOST; unset means no mail is sent (console mode). */
  host: string | undefined;
  from: string;
  /** MAIL_CAPTURE_FILE: where console mode appends each message; null when unset. */
  captureFile: string | null;
  port: number;
  /** SMTP_SECURE when set; otherwise implicit TLS exactly when the port is 465. */
  secure: boolean;
  user: string | undefined;
  pass: string;
}

export function resolveMailSettings(env: NodeJS.ProcessEnv = process.env): MailSettings {
  const port = parseInt(env.SMTP_PORT || String(DEFAULT_SMTP_PORT), 10);
  return {
    host: env.SMTP_HOST,
    from: env.SMTP_FROM || DEFAULT_MAIL_FROM,
    captureFile: env.MAIL_CAPTURE_FILE || null,
    port,
    secure: env.SMTP_SECURE !== undefined ? env.SMTP_SECURE === 'true' : port === 465,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS || '',
  };
}

/**
 * MAIL_PREVIEW_URL: the local inbox a development mail catcher serves, or ''.
 * Read each time it is asked for, so MailService decides per answer whether
 * the value is a local address it may show.
 */
export function resolveMailPreviewUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAIL_PREVIEW_URL || '';
}
