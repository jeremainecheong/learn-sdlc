import { ConsoleLogger, LoggerService } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@learnsdlc/shared';
import { observeHttpRequest } from './metrics';
import { isUuid } from '../db/uuid';

/**
 * One-line JSON logs in production so a log aggregator can index them, and
 * human-readable logs in development. Every request carries a correlation id
 * (honouring an upstream X-Request-Id) which is echoed back to the client, so
 * a user-reported failure can be traced to its log lines.
 */
export class JsonLogger implements LoggerService {
  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      context: context || undefined,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      trace: trace || undefined,
    });
    if (level === 'error' || level === 'fatal') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }
}

export function buildLogger(format: string): LoggerService {
  return format === 'json' ? new JsonLogger() : new ConsoleLogger();
}

/**
 * The health controller's own routes (`/api/v1/health`, `/api/v1/health/live`,
 * `/api/v1/health/ready`), with the global prefix optional so a proxy that
 * strips it is still matched. Exact paths, not a substring test: matching any
 * URL containing '/health' also swallowed POST
 * /api/v1/phases/:id/drill/health (the learner's incident drill probe, a real
 * request path), and hid every successful one from the log.
 */
const HEALTH_ROUTES = new Set(['/health', '/health/live', '/health/ready']);

/**
 * The part of a request URL that is safe to write down: everything before the
 * first `?`.
 *
 * The Google callback arrives as `/api/v1/auth/google/callback?code=...&state=...`,
 * and `google.controller.ts` moves the session it mints into the URL fragment
 * precisely because a query string is the part that gets logged. Logging
 * `originalUrl` put the authorization code straight back into the access log,
 * which the runbook tells an operator to ship to an aggregator. The codes are
 * single-use and PKCE-bound, so this was a replay race rather than a takeover,
 * but a secret in a log is a secret in every copy of that log.
 *
 * The whole query goes, not the parameters that happen to be sensitive now:
 * a denylist of names is one new parameter away from leaking again, and
 * nothing in the log line needs the query. The path still names the resource
 * and `rid=` still ties the line to the error body the learner was shown, so a
 * reported failure can still be traced from it.
 */
export function loggablePath(originalUrl: string): string {
  const query = originalUrl.indexOf('?');
  const path = query === -1 ? originalUrl : originalUrl.slice(0, query);
  return path.replace(PREVIEW_CAPABILITY, '$1/preview/…');
}

/**
 * The live preview door, `/api/v1/preview/<capability>/…`.
 *
 * The capability is the whole authorisation for a learner's running
 * application: whoever holds the string can open the app for as long as the
 * session lives. It travels in the path because the frame is opaque-origin and
 * its own fetches carry neither a cookie nor a header, which puts a live
 * credential in the one part of a request this function exists to keep out of
 * the logs, and the door is the busiest route in the product while a preview
 * is open, so it is in every access line and every error report until it is
 * taken out here.
 *
 * The whole segment goes, not a prefix of it, and the route survives so a log
 * still shows that the preview was being used and how it answered. The prefix
 * is optional for the same reason it is in HEALTH_ROUTES: a proxy may strip it.
 */
const PREVIEW_CAPABILITY = /^(\/api\/v1)?\/preview\/[^/?#]+.*$/;

/** True for the health controller's probes, which are high-frequency and uninteresting unless they fail. */
export function isHealthProbe(originalUrl: string): boolean {
  const path = loggablePath(originalUrl).replace(/\/+$/, '') || '/';
  return HEALTH_ROUTES.has(path) || HEALTH_ROUTES.has(path.replace(/^\/api\/v1/, ''));
}

/** Correlation is diagnostic only. Never reflect arbitrary caller text into logs/headers. */
export function requestCorrelationId(value?: unknown): string {
  return isUuid(value)
    ? value.toLowerCase() : randomUUID();
}

/** Attach a correlation id to every request and log its outcome and latency. */
export function requestLogging(logger: LoggerService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = requestCorrelationId(req.headers[REQUEST_ID_HEADER]);
    (req as Request & { requestId: string }).requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // The matched pattern (/api/v1/phases/:id), never the raw URL: one
      // series per route, not one per learner id or per scanner probe.
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      observeHttpRequest(req.method, route, res.statusCode, ms / 1000);
      if (isHealthProbe(req.originalUrl) && res.statusCode < 400) return;
      // The path only. See loggablePath: the OAuth callback's query carries an
      // authorization code, and this line is the access log.
      const line = `${req.method} ${loggablePath(req.originalUrl)} ${res.statusCode} ${ms.toFixed(1)}ms rid=${requestId}`;
      if (res.statusCode >= 500) logger.error(line, undefined, 'HTTP');
      else if (res.statusCode >= 400) logger.warn(line, 'HTTP');
      else logger.log(line, 'HTTP');
    });
    next();
  };
}
