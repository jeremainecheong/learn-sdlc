import { Controller, Get, Logger, Optional, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from './auth.decorators';
import { GoogleService, GoogleSignInError, STATE_TTL_MS, oauthNonceCookie } from './google.service';
import { RateLimit, RateLimitGuard } from './rate-limit.guard';
import { config, siteUrl } from '../config';
import { CognitoService, cognitoNonceCookie, COGNITO_STATE_TTL_MS } from './cognito.service';
import { escapeHtml } from './html';

/**
 * One cookie off the request, without a parser in front of the whole API.
 * The header is `name=value; name=value`; a value with an `=` in it keeps
 * everything after the first one.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of (header || '').split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * The one page this API serves. A refused callback cannot be a redirect back
 * to the web app (a state we could not verify may name anywhere) and a JSON
 * body would land in a browser as raw text, so the answer is a small page in
 * the product's voice with the one thing to do next on it.
 */
function errorPage(message: string): string {
  const back = `${siteUrl()}/login`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in with Google</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f7f7f6; color: #1b1b1a; }
  main { max-width: 30rem; border: 1.5px solid #d9d8d4; border-radius: 10px;
         background: #fff; padding: 24px 26px; }
  h1 { margin: 0 0 10px; font-size: 19px; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: #56544e; }
  a { display: inline-block; text-decoration: none; font-weight: 600; color: #fff;
      background: #2563eb; border-radius: 8px; padding: 9px 16px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16161a; color: #ecebe6; }
    main { background: #1e1e23; border-color: #33333a; }
    p { color: #a3a099; }
  }
</style>
</head>
<body>
  <main>
    <h1>That sign-in did not go through</h1>
    <p data-testid="google-error">${escapeHtml(message)}</p>
    <a href="${escapeHtml(back)}" data-testid="google-error-back">Back to sign in</a>
  </main>
</body>
</html>
`;
}

/**
 * Sign in with Google.
 *
 * Two routes and a capability probe. Neither route reads a body, and neither
 * is reachable with a session, so both carry the same per-IP brake the
 * password login does: the code exchange costs a call to Google and the
 * callback costs a bcrypt hash on a first sign-in.
 */
@Controller('auth')
@UseGuards(RateLimitGuard)
export class GoogleController {
  private readonly logger = new Logger(GoogleController.name);

  constructor(private readonly google: GoogleService, @Optional() private readonly cognito?: CognitoService) {}

  /** What the sign-in page asks before deciding whether to draw the button. */
  @Public()
  @Get('providers')
  providers() {
    const managed = config.authProvider === 'cognito';
    const ssoProviders = managed ? this.cognito?.providers() ?? [] : [];
    return { google: managed ? ssoProviders.some(item => item.id === 'Google') : this.google.enabled(),
      authProvider: config.authProvider, confirmationRequired: managed, ssoProviders,
      passwordChange: true, accountDeletion: !managed };
  }

  /**
   * Start a sign-in. The nonce that identifies this attempt goes to Google in
   * the URL and stays here in a cookie, so the callback can tell an attempt
   * this browser started from one it was merely handed. HttpOnly puts it out
   * of reach of script, SameSite Lax still rides the top-level navigation
   * Google sends the browser back on, and fifteen minutes is the state's own
   * life: a cookie outliving the state it belongs to proves nothing.
   */
  @Public()
  @RateLimit(config.signInMaxPerAddress, 60)
  @Get('google')
  start(@Query('next') next: string | undefined, @Res() res: Response): void {
    try {
      if (config.authProvider === 'cognito') {
        if (!this.cognito) throw new Error('managed sign-in unavailable');
        const {url,nonce} = this.cognito.beginSignIn('Google',next);
        const cookie = cognitoNonceCookie();
        res.cookie(cookie.name,nonce,{httpOnly:true,sameSite:'lax',secure:cookie.secure,path:'/',maxAge:COGNITO_STATE_TTL_MS});
        res.redirect(302,url);
        return;
      }
      const { url, nonce } = this.google.beginSignIn(next);
      const cookie = oauthNonceCookie();
      res.cookie(cookie.name, nonce, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookie.secure,
        path: '/',
        maxAge: STATE_TTL_MS,
      });
      res.redirect(302, url);
    } catch (err) {
      res.status(400).type('html').send(errorPage(this.reason(err)));
    }
  }

  /**
   * Google sends the browser here. On success the session leaves in the URL
   * fragment: a query string would be written to this API's access log, to the
   * web server's, and to any proxy in between, and a fragment is never sent to
   * a server at all. `next` is not secret, so it travels in the query where the
   * page can read it without touching the fragment.
   */
  @Public()
  @RateLimit(config.signInMaxPerAddress, 60)
  @Get('google/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (config.authProvider === 'cognito') {
      res.status(400).type('html').send(errorPage('Start again using managed sign-in.'));
      return;
    }
    // The person pressed cancel, or Google refused the request outright.
    if (error) {
      res.status(400).type('html').send(errorPage('Google did not complete that sign-in.'));
      return;
    }
    const cookie = oauthNonceCookie();
    try {
      const { auth, returnPath } = await this.google.complete(
        code,
        state,
        readCookie(req.headers.cookie, cookie.name),
      );
      // One attempt, one nonce. Cleared on the way out so the same state
      // cannot be walked twice, and only here: a refused callback is often
      // someone else's forged link arriving in this browser, and that should
      // not cancel the sign-in this person actually started.
      res.clearCookie(cookie.name, {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookie.secure,
        path: '/',
      });
      const query = returnPath ? `?next=${encodeURIComponent(returnPath)}` : '';
      res.redirect(
        302,
        `${siteUrl()}/login/callback${query}#token=${encodeURIComponent(auth.token)}`,
      );
    } catch (err) {
      if (!(err instanceof GoogleSignInError)) {
        this.logger.error(`google callback failed: ${(err as Error).message}`);
      }
      res.status(400).type('html').send(errorPage(this.reason(err)));
    }
  }

  /** A refusal we wrote, or the one sentence anything else is worth saying. */
  private reason(err: unknown): string {
    if (err instanceof GoogleSignInError) return err.message;
    const message = (err as { message?: string })?.message;
    return typeof message === 'string' && message.startsWith('Google sign-in is not configured')
      ? message
      : 'Something went wrong on our side. Try again in a moment.';
  }
}
