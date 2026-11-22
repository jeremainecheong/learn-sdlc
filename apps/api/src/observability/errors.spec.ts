import type { ArgumentsHost } from '@nestjs/common';

jest.mock('@sentry/node', () => ({ init: jest.fn(), captureException: jest.fn() }));

// The module requires the SDK lazily, after isolateModules has returned, so
// the call lands in the main registry's mock: this one, not an isolated copy.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sentry = require('@sentry/node') as { init: jest.Mock; captureException: jest.Mock };

type ErrorsModule = typeof import('./errors');

interface Loaded {
  errors: ErrorsModule;
  /** The module's own @nestjs/common: its instanceof checks only recognise classes from this copy. */
  common: typeof import('@nestjs/common');
  sentry: typeof sentry;
  logError: jest.SpyInstance;
}

/**
 * A fresh copy of the module per test: whether Sentry is attached is
 * module state, and the Logger the module writes through has to be the one
 * from the same registry for the spy to see it.
 */
function load(): Loaded {
  let loaded!: Loaded;
  jest.isolateModules(() => {
    const common = require('@nestjs/common');
    const logError = jest.spyOn(common.Logger.prototype, 'error').mockImplementation(() => undefined);
    loaded = { errors: require('./errors'), common, sentry, logError };
  });
  sentry.init.mockReset();
  sentry.captureException.mockReset();
  return loaded;
}

describe('captureException', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is log-only without SENTRY_DSN and still carries the request id', () => {
    const { errors, sentry, logError } = load();
    expect(errors.initErrorReporting({})).toBe(false);

    errors.captureException(new Error('boom'), { requestId: 'rid-1', kind: 'run', jobId: 'j1' });

    expect(logError).toHaveBeenCalledWith('boom rid=rid-1 kind=run jobId=j1', expect.stringContaining('Error: boom'));
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('wraps non-Error values so a thrown string still gets a stack', () => {
    const { errors, logError } = load();
    errors.captureException('oops');
    expect(logError).toHaveBeenCalledWith('oops', expect.stringContaining('Error: oops'));
  });

  it('attaches Sentry with the release when a DSN is set, and keeps logging', () => {
    const { errors, sentry, logError } = load();
    expect(
      errors.initErrorReporting({ SENTRY_DSN: 'https://k@example.invalid/1', APP_VERSION: '1.2.3', NODE_ENV: 'production' }),
    ).toBe(true);
    expect(sentry.init).toHaveBeenCalledWith({
      dsn: 'https://k@example.invalid/1',
      release: '1.2.3',
      environment: 'production',
      integrations: expect.any(Function),
      beforeSend: expect.any(Function),
      beforeBreadcrumb: expect.any(Function),
      sendDefaultPii: false,
      dataCollection: expect.any(Object),
    });

    const err = new Error('db down');
    errors.captureException(err, { requestId: 'rid-2' });
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      extra: { requestId: 'rid-2' },
      tags: { requestId: 'rid-2' },
    });
    expect(logError).toHaveBeenCalledWith('db down rid=rid-2', expect.any(String));
  });

  it('never throws when the SDK does', () => {
    const { errors, sentry } = load();
    errors.initErrorReporting({ SENTRY_DSN: 'https://k@example.invalid/1' });
    sentry.captureException.mockImplementation(() => {
      throw new Error('sdk exploded');
    });
    expect(() => errors.captureException(new Error('x'))).not.toThrow();
  });

  it('does not export credentials, private work, request bodies or arbitrary error text to Sentry', () => {
    const { errors, sentry } = load();
    errors.initErrorReporting({ SENTRY_DSN: 'https://k@example.invalid/1' });
    const options = sentry.init.mock.calls[0][0];
    expect(options.beforeSend).toEqual(expect.any(Function));
    const secret = 'SYNTHETIC_PRIVATE_MARKER_83';
    const reference = 'a169e3aa-bf39-4ae0-801c-1e5f947d02c4';
    const event = {
      event_id: '8'.repeat(32), timestamp: 1234567, level: 'error',
      request: { url: `https://preview.invalid/api/v1/preview/${secret}/?code=${secret}`, data: { password: secret }, headers: { authorization: `Bearer ${secret}`, cookie: secret } },
      breadcrumbs: [{ message: secret, data: { url: `https://accounts.invalid/?code=${secret}` } }],
      extra: { requestId: reference, method: 'GET', status: 502, path: `/api/v1/preview/${secret}/?code=${secret}`, password: secret, prompt: secret },
      tags: { requestId: reference, arbitrary: secret },
      contexts: { trace: { data: { body: secret } } }, user: { email: `${secret}@example.test` },
      message: secret, logentry: { message: secret, params: [secret] },
      exception: { values: [{ type: 'TypeError', value: secret, mechanism: { data: { password: secret } }, stacktrace: { frames: [{ filename: '/app/dist/observability/errors.js', function: 'captureException', lineno: 72, colno: 3, vars: { password: secret }, context_line: secret, pre_context: [secret] }] } }] },
      sdkProcessingMetadata: { normalizedRequest: { data: secret } },
    };
    const safe = options.beforeSend(event);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.extra).toEqual({ requestId: reference, method: 'GET', status: 502, path: '/api/v1/preview/…' });
    expect(safe.exception.values[0]).toMatchObject({ type: 'TypeError', stacktrace: { frames: [{ filename: 'dist/observability/errors.js', function: 'captureException', lineno: 72, colno: 3 }] } });
    expect(safe.event_id).toBe(event.event_id);
    expect(event.request.data.password).toBe(secret); // Do not mutate another local consumer's error.
  });

  it('disables implicit request, code-context and AI payload collection before capture', () => {
    const { errors, sentry } = load();
    errors.initErrorReporting({ SENTRY_DSN: 'https://k@example.invalid/1' });
    const options = sentry.init.mock.calls[0][0];
    expect(options.integrations).toEqual(expect.any(Function));
    const retained = options.integrations(['RequestData', 'Http', 'LocalVariables', 'ContextLines', 'Console', 'OnUncaughtException', 'OnUnhandledRejection'].map(name => ({ name })));
    expect(retained.map((item: { name: string }) => item.name)).toEqual(['OnUncaughtException', 'OnUnhandledRejection']);
    expect(options.beforeBreadcrumb({ message: 'private draft' })).toBeNull();
    expect(options.dataCollection).toEqual({
      userInfo: false, cookies: false, httpHeaders: { request: false, response: false }, httpBodies: [],
      urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
      databaseQueryData: false, stackFrameVariables: false, frameContextLines: 0,
    });
  });

  it('redacts credential-bearing exception prose, stack lines and context before local logging', () => {
    const { errors, logError } = load();
    const secret = 'SYNTHETIC_LOCAL_SECRET_71';
    const error = new Error(`upstream failed https://user:${secret}@identity.example/callback?code=${secret}&state=${secret}#${secret}; Authorization: Bearer ${secret}; {"refresh_token":"${secret}"}`);
    error.stack = `${error.message}\n    at exchange (/app/dist/auth/cognito.service.js:42:3)`;
    errors.captureException(error, { requestId: 'rid-local', status: 502, path: `/api/v1/preview/${secret}/api/tasks`, password: secret });
    const captured = JSON.stringify(logError.mock.calls);
    expect(captured).not.toContain(secret);
    expect(captured).toContain('upstream failed');
    expect(captured).toContain('identity.example/callback');
    expect(captured).toContain('rid=rid-local');
    expect(captured).toContain('status=502');
    expect(captured).toContain('cognito.service.js:42:3');
    expect(captured).toContain('/api/v1/preview/…');
    expect(error.message).toContain(secret); // The original exception belongs to its caller.
  });

  it('redacts a bare preview capability, session token and key-shaped provider credential', () => {
    const { errors, logError } = load();
    const capability = 'SYNTHETIC_CAPABILITY_72';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.synthetic_signature';
    const key = 'sk-proj-SYNTHETIC_API_CREDENTIAL_73';
    errors.captureException(new Error(`GET /api/v1/preview/${capability}/api failed; token=${jwt}; OPENAI_API_KEY=${key}`));
    const captured = JSON.stringify(logError.mock.calls);
    for (const secret of [capability, jwt, key]) expect(captured).not.toContain(secret);
    expect(captured).toContain('failed');
  });
});

describe('UnhandledErrorFilter', () => {
  afterEach(() => jest.restoreAllMocks());

  function fakeHost(req: Record<string, unknown>) {
    const res = { headersSent: false };
    const host = {
      switchToHttp: () => ({ getRequest: () => req }),
      getArgByIndex: (i: number) => (i === 0 ? req : res),
    } as unknown as ArgumentsHost;
    return { host, res };
  }

  function build() {
    const loaded = load();
    const adapter = { isHeadersSent: jest.fn(() => false), reply: jest.fn(), end: jest.fn() };
    const filter = new loaded.errors.UnhandledErrorFilter(adapter as never);
    return { ...loaded, adapter, filter };
  }

  it('answers an unknown error with 500 + the request id, and logs rid=', () => {
    const { filter, adapter, logError } = build();
    const { host, res } = fakeHost({ requestId: 'rid-9', method: 'POST', originalUrl: '/api/v1/runs' });

    filter.catch(new TypeError('cannot read x of undefined'), host);

    expect(adapter.reply).toHaveBeenCalledWith(
      res,
      { statusCode: 500, message: 'Internal server error', requestId: 'rid-9' },
      500,
    );
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toBe(
      'cannot read x of undefined rid=rid-9 method=POST path=/api/v1/runs status=500',
    );
  });

  it('captures a deliberate 5xx HttpException but keeps its response body', () => {
    const { filter, adapter, logError, common } = build();
    const { host, res } = fakeHost({ requestId: 'rid-5', method: 'GET', originalUrl: '/x' });
    const exception = new common.InternalServerErrorException('grading backend unavailable');

    filter.catch(exception, host);

    expect(adapter.reply).toHaveBeenCalledWith(res, exception.getResponse(), 500);
    expect(logError.mock.calls[0][0]).toContain('rid=rid-5');
  });

  // The query-string leak by its second route. The access log in logger.ts
  // drops the query; this filter is the other place a request's URL leaves the
  // process, and a callback that 500s is exactly when an operator looks.
  it('drops the query before the 5xx reaches the log and the aggregator', () => {
    const { filter, logError } = build();
    const { host } = fakeHost({
      requestId: 'rid-oauth',
      method: 'GET',
      originalUrl: '/api/v1/auth/google/callback?code=4/0AY-secret&state=n1',
    });

    filter.catch(new TypeError('token exchange blew up'), host);

    const line = logError.mock.calls[0][0] as string;
    expect(line).toContain('path=/api/v1/auth/google/callback ');
    expect(line).not.toContain('code=');
    expect(line).not.toContain('4/0AY-secret');
  });

  it('passes a 4xx through untouched and unlogged', () => {
    const { filter, adapter, logError, common } = build();
    const { host, res } = fakeHost({ requestId: 'rid-4', method: 'GET', originalUrl: '/x' });
    const exception = new common.NotFoundException('run not found');

    filter.catch(exception, host);

    expect(adapter.reply).toHaveBeenCalledWith(res, exception.getResponse(), 404);
    expect(logError).not.toHaveBeenCalled();
  });
});
