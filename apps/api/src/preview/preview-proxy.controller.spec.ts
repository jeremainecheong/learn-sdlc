import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { configureApp } from '../main';
import { SandboxService } from '../execution/sandbox.service';
import { PreviewDoorController } from './preview-proxy.controller';
import { PreviewService } from './preview.service';

/**
 * The door, mounted through the real `configureApp`.
 *
 * Through the real one because half of what is being asserted is about
 * middleware this controller does not own: helmet sets `X-Frame-Options:
 * SAMEORIGIN` for the whole API, which is exactly the header that would stop
 * the workspace from framing a preview, and `enableCors` is an allow list of
 * the web origins that would refuse the opaque-origin frame's preflight. A
 * controller test with a bare Nest module would pass with both of those still
 * broken.
 */

const silent: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

const HTML =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>TaskTrackr</title>' +
  '</head><body><div id="root" data-app="tasktrackr"></div><script src="app.js"></script></body></html>\n';

const GOOD = 'a-capability-nobody-can-guess';

/** A session register with one live session, and the calls the door made. */
const preview = {
  resolved: [] as string[],
  resolve(capability: string) {
    preview.resolved.push(capability);
    return capability === GOOD ? ({ id: 'api-1', runnerId: 'run-1' } as never) : null;
  },
  runnerIdOf(session: { runnerId: string }) {
    return session.runnerId;
  },
};

/** A runner that answers the two routes the door uses. */
const sandbox = {
  proxied: [] as { method: string; path: string; body: string; headers: Record<string, string> }[],
  assets: [] as string[],
  async proxyApp(
    _id: string,
    method: string,
    at: string,
    headers: Record<string, string>,
    body?: Buffer,
  ) {
    sandbox.proxied.push({ method, path: at, body: (body || Buffer.alloc(0)).toString('utf-8'), headers });
    return {
      status: 201,
      headers: { 'content-type': 'application/json', 'set-cookie': 'session=nope' },
      body: Buffer.from('{"id":1}'),
      truncated: false,
    };
  },
  async assetApp(_id: string, at: string) {
    sandbox.assets.push(at);
    if (at === 'app.js') {
      const bytes = Buffer.from('console.log(1)\n');
      return { status: 200, contentType: 'text/javascript; charset=utf-8', bytes, get body() { return bytes.toString('utf-8'); } };
    }
    const bytes = Buffer.from(HTML, 'utf-8');
    return { status: 200, contentType: 'text/html; charset=utf-8', bytes, get body() { return bytes.toString('utf-8'); } };
  },
};

@Module({
  controllers: [PreviewDoorController],
  providers: [
    { provide: PreviewService, useValue: preview },
    { provide: SandboxService, useValue: sandbox },
  ],
})
class DoorModule {}

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function call(
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
  body?: string,
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('the live preview door', () => {
  let app: INestApplication;
  let port = 0;
  const at = (rest: string) => `/api/v1/preview/${GOOD}${rest}`;

  beforeAll(async () => {
    app = await NestFactory.create(DoorModule, { logger: false });
    configureApp(app, silent);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    preview.resolved = [];
    sandbox.proxied = [];
    sandbox.assets = [];
  });

  it.each(['', '/'])('serves the pack’s own document at root %j with a base tag pointing back at itself', async suffix => {
    const res = await call(port, 'GET', at(suffix));

    expect(res.status).toBe(200);
    const html = res.body.toString('utf-8');
    // The one rewrite the door makes. Without it the front end's relative
    // `api/lists` goes to the web origin and the frame is blank with no error.
    expect(html).toContain(`<base href="/api/v1/preview/${GOOD}/">`);
    expect(html.indexOf('<base')).toBeLessThan(html.indexOf('<title>'));
    // And it is still the pack's own page, marker and all.
    expect(html).toContain('data-app="tasktrackr"');
  });

  it('drops the frame-busting header the rest of the API needs, and names the ancestor instead', async () => {
    const res = await call(port, 'GET', at('/'));

    // helmet sets SAMEORIGIN globally; the workspace is a different origin.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain('frame-ancestors http://localhost:3000');
    // The same restrictions in a new tab as in the panel.
    expect(res.headers['content-security-policy']).toContain(
      'sandbox allow-scripts allow-forms allow-modals',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers the opaque frame’s preflight, which the API’s own allow list refuses', async () => {
    const res = await call(port, 'OPTIONS', at('/api/lists'), {
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    });

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('null');
    expect(res.headers['access-control-allow-headers']).toBe('content-type');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    // `null` and credentials together would let any sandboxed page anywhere
    // call this API as somebody.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each<[string, string, number]>([
    ['GET', '/', 200],
    ['GET', '/app.js', 200],
    ['GET', '/api/lists', 201],
    ['POST', '/api/lists', 201],
  ])('does not inherit credentialed global CORS on a valid preview %s %s', async (method, path, status) => {
    for (const origin of ['null', 'http://localhost:3000']) {
      const res = await call(port, method, at(path), { origin, 'content-type': 'application/json' }, method === 'POST' ? '{"name":"Today"}' : undefined);
      expect(res.status).toBe(status);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      if (path.startsWith('/api/')) expect(res.headers['access-control-allow-origin']).toBe('null');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('proxies a write to the learner’s own API, body and all, and strips the cookie', async () => {
    const res = await call(
      port,
      'POST',
      at('/api/lists?dry=1'),
      { 'content-type': 'application/json', origin: 'null' },
      '{"name":"Today"}',
    );

    expect(res.status).toBe(201);
    expect(sandbox.proxied[0].method).toBe('POST');
    // The query travels with it: the overdue report is a query parameter.
    expect(sandbox.proxied[0].path).toBe('/api/lists?dry=1');
    expect(sandbox.proxied[0].body).toBe('{"name":"Today"}');
    expect(res.headers['access-control-allow-origin']).toBe('null');
    // The runner strips Set-Cookie and so does the door: a preview may not set
    // a cookie on this API's origin, which is where the learner's own session is.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('serves a file out of the built front end, unrewritten', async () => {
    const res = await call(port, 'GET', at('/app.js'));

    expect(res.status).toBe(200);
    expect(sandbox.assets).toEqual(['app.js']);
    expect(res.body.toString('utf-8')).toBe('console.log(1)\n');
    expect(res.headers['content-type']).toContain('text/javascript');
  });

  it('preserves decoded nested asset segments through the Express wildcard', async () => {
    const res = await call(port, 'GET', at('/assets/diagram%20draft.svg'));
    expect(res.status).toBe(200);
    expect(sandbox.assets).toEqual(['assets/diagram draft.svg']);
    expect(sandbox.proxied).toHaveLength(0);
  });

  /**
   * Found in a browser, not by reading. The frame runs without
   * `allow-same-origin`, so the document inside it has an **opaque** origin,
   * and helmet's `Cross-Origin-Resource-Policy: same-origin` then refuses to
   * hand that document the bundle this very route just served it. Chrome:
   * the HTML loads, because a navigation is exempt, and `app.js` fails with
   * `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`: a session the panel calls
   * ready, over a blank page.
   */
  it('lets the opaque frame load the bundle it was just served', async () => {
    for (const path of ['/', '/app.js']) {
      const res = await call(port, 'GET', at(path));
      expect(`${path} ${res.headers['cross-origin-resource-policy']}`).toBe(
        `${path} cross-origin`,
      );
    }
  });

  it('answers an unknown capability 404 and never 403', async () => {
    const res = await call(port, 'GET', '/api/v1/preview/not-a-real-capability/');

    // A 403 would tell whoever is guessing that the session exists.
    expect(res.status).toBe(404);
    expect(res.body.toString('utf-8')).not.toContain('not-a-real-capability');
  });

  it('serves the app’s own document without a trailing slash too', async () => {
    const res = await call(port, 'GET', `/api/v1/preview/${GOOD}`);

    expect(res.status).toBe(200);
    expect(res.body.toString('utf-8')).toContain('<base href=');
  });
});
