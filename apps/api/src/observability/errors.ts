import { ArgumentsHost, Catch, HttpException, HttpServer, HttpStatus, Logger } from '@nestjs/common';
import { AbstractHttpAdapter, BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import type { ErrorEvent, StackFrame } from '@sentry/node';

import { loggablePath } from './logger';
import { resolveAppVersion, resolveSentryDsn } from '../config/observability';
import { isUuid } from '../db/uuid';

/**
 * Where errors go, beyond their log line.
 *
 * The log line always exists: every capture is written through the app
 * logger (JSON in production) carrying the request id the client was given,
 * so a learner's "it broke, reference abc-123" can be tied to a stack trace.
 * Sentry is attached on top only when SENTRY_DSN is set; a deployment that
 * never configures it loses nothing it had before.
 */
export interface ErrorContext {
  /** Correlation id of the request the error belongs to; logged as rid=. */
  requestId?: string;
  [key: string]: string | number | boolean | undefined;
}

type SentryModule = typeof import('@sentry/node');

let sentry: SentryModule | null = null;
const logger = new Logger('Errors');

/** Credential-shaped diagnostic text is scrubbed before it reaches local logs. */
function privateDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>;]+/gi, candidate => {
      try {
        const url = new URL(candidate);
        return `${url.origin}${loggablePath(url.pathname)}`;
      } catch { return '[redacted URL]'; }
    })
    .replace(/((?:\/api\/v1)?\/preview\/)[A-Za-z0-9_-]{16,}(?:[/?#][^\s"'<>;)]*)?(?=$|[\s"'<>;)])/g, '$1…')
    .replace(/(\/api\/v1\/[^\s"'<>?]*)\?[^\s"'<>]+/g, '$1')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|client_secret|secret|access_token|refresh_token|id_token|token|session_id|api[-_]?key|openai_api_key|aws_secret_access_key)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted session]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[redacted key]');
}

const PRIVATE_DIAGNOSTIC_MESSAGE = 'Application error; use the reference and stack location for local diagnostics.';
const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'HttpException', 'BadRequestException', 'UnauthorizedException', 'ForbiddenException', 'NotFoundException', 'ConflictException', 'ServiceUnavailableException', 'InternalServerErrorException', 'QueryFailedError', 'SocketRunnerStatus']);

/** Send an explicit diagnostic projection, never SDK-captured request or local variables. */
export function privateSentryEvent(event: ErrorEvent): ErrorEvent {
  const extra: Record<string, string | number> = {};
  for (const key of ['requestId', 'jobId']) {
    const value = event.extra?.[key];
    if (isUuid(value)) extra[key] = value;
  }
  const method = event.extra?.method;
  if (typeof method === 'string' && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) extra.method = method;
  const status = event.extra?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) extra.status = status;
  const path = event.extra?.path;
  if (typeof path === 'string' && path.startsWith('/')) extra.path = loggablePath(path).slice(0, 2048);
  const frames = (items: StackFrame[] | undefined): StackFrame[] => (items ?? []).slice(-50).map(frame => {
    const safe: StackFrame = {};
    // Retain source locations without machine home paths, query strings,
    // source-code excerpts, module metadata or captured local variables.
    const location = frame.filename?.match(/(?:^|\/)((?:apps\/api\/(?:src|dist)|src|dist|node_modules)\/[A-Za-z0-9_./@-]+\.(?:[cm]?js|tsx?))$/);
    if (location) safe.filename = location[1];
    if (typeof frame.function === 'string' && /^[\w.$<> [\]-]{1,120}$/.test(frame.function)) safe.function = frame.function;
    if (Number.isInteger(frame.lineno) && frame.lineno! > 0) safe.lineno = frame.lineno;
    if (Number.isInteger(frame.colno) && frame.colno! >= 0) safe.colno = frame.colno;
    return safe;
  });
  return {
    type: undefined,
    ...(typeof event.event_id === 'string' && /^[0-9a-f]{32}$/i.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}),
    ...(typeof event.release === 'string' && /^[\w.-]{1,128}$/.test(event.release) ? { release: event.release } : {}),
    ...(typeof event.environment === 'string' && /^[\w.-]{1,64}$/.test(event.environment) ? { environment: event.environment } : {}),
    platform: 'node', level: 'error', message: PRIVATE_DIAGNOSTIC_MESSAGE,
    extra,
    ...(extra.requestId ? { tags: { requestId: extra.requestId } } : {}),
    exception: { values: (event.exception?.values ?? []).slice(0, 5).map(value => ({
      type: ERROR_TYPES.has(value.type ?? '') ? value.type : 'Error',
      value: PRIVATE_DIAGNOSTIC_MESSAGE,
      stacktrace: { frames: frames(value.stacktrace?.frames) },
    })) },
  };
}

/**
 * Attach Sentry when a DSN is configured. Returns whether it did, so the boot
 * line can say where errors go. A second call is a no-op.
 */
export function initErrorReporting(env: NodeJS.ProcessEnv = process.env): boolean {
  if (sentry) return true;
  const dsn = resolveSentryDsn(env);
  if (!dsn) return false;
  // Required lazily: the SDK pulls in OpenTelemetry and costs ~300ms at
  // import, which every test run and every DSN-less deployment would pay for
  // nothing.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@sentry/node') as SentryModule;
  mod.init({
    dsn,
    release: resolveAppVersion(env),
    environment: env.NODE_ENV || 'development',
    // The SDK's default request/HTTP integrations collect OAuth code/state
    // and preview capabilities independently of our safe local access logger.
    // Keep process error capture, with only our allowlisted event projection.
    integrations: (defaults) => defaults.filter(integration => ['InboundFilters', 'FunctionToString', 'OnUncaughtException', 'OnUnhandledRejection'].includes(integration.name)),
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: { request: false, response: false }, httpBodies: [],
      urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
      databaseQueryData: false, stackFrameVariables: false, frameContextLines: 0,
    },
    beforeBreadcrumb: () => null,
    beforeSend: privateSentryEvent,
  });
  sentry = mod;
  return true;
}

/**
 * Record an error where an operator will find it. Never throws: reporting an
 * error must not become a second error on the same path.
 */
export function captureException(err: unknown, context: ErrorContext = {}): void {
  const error = err instanceof Error ? err : new Error(String(err));
  const { requestId, ...rest } = context;
  const fields: string[] = [];
  if (requestId) fields.push(`rid=${privateDiagnosticText(requestId)}`);
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    const sensitive = /password|passwd|secret|token|credential|authorization|cookie|apikey|accesskey/i.test(key.replace(/[^a-z]/gi, ''));
    const safe = sensitive ? '[redacted]' : privateDiagnosticText(key === 'path' ? loggablePath(String(value)) : String(value));
    fields.push(`${key}=${safe}`);
  }
  logger.error([privateDiagnosticText(error.message), ...fields].join(' '), error.stack ? privateDiagnosticText(error.stack) : undefined);

  if (!sentry) return;
  try {
    sentry.captureException(error, {
      extra: context,
      tags: requestId ? { requestId } : undefined,
    });
  } catch {
    // The log line above is the record; a failing SDK must not take the
    // request or the job down with it.
  }
}

type RequestWithId = Request & { requestId?: string };

/**
 * Global exception filter: every 5xx is captured with the request id before
 * the response goes out; 4xx responses are the client's problem and leave
 * exactly as Nest's default filter would send them.
 */
@Catch()
export class UnhandledErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const status = this.statusOf(exception);
    if (status >= 500) {
      const req = host.switchToHttp().getRequest<RequestWithId>();
      captureException(exception, {
        requestId: req?.requestId,
        method: req?.method,
        // The path without its query. A failing OAuth callback is a 5xx like
        // any other, and req.originalUrl on that route carries Google's
        // authorization code; see loggablePath in logger.ts.
        path: req?.originalUrl ? loggablePath(req.originalUrl) : undefined,
        status,
      });
    }
    super.catch(exception, host);
  }

  /**
   * Nest's version of this logs the error itself, without the request id, and
   * would duplicate the line captureException just wrote. Same response body
   * otherwise, plus the request id so the client can quote it.
   */
  handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: AbstractHttpAdapter | HttpServer,
  ): void {
    const req = host.getArgByIndex<RequestWithId | undefined>(0);
    const res = host.getArgByIndex(1);
    const body = this.isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message, requestId: req?.requestId }
      : {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
          requestId: req?.requestId,
        };
    if (!applicationRef.isHeadersSent(res)) applicationRef.reply(res, body, body.statusCode);
    else applicationRef.end(res);
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    if (this.isHttpError(exception)) return exception.statusCode;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
