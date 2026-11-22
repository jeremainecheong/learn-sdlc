import 'reflect-metadata';
import { Module, UnauthorizedException } from '@nestjs/common';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { configureApp } from '../main';
import { importGate } from './import-gate';
import { bearer } from '../../test/support/http';

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** One request with a body, the way curl sends it. */
function send(
  port: number,
  path: string,
  method: string,
  body: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** A body big enough that reading it is the cost the gate exists to avoid. */
const BIG = JSON.stringify({ n: 1, pad: 'x'.repeat(600_000) });

/**
 * The door in front of the import parser: the body is read only for a POST
 * whose token verifies to a member of staff.
 */
describe('importGate', () => {
  let server: http.Server;
  let port = 0;
  let verify: jest.Mock;
  let authenticate: jest.Mock;

  beforeEach(async () => {
    verify = jest.fn();
    authenticate = jest.fn(async (token: string) => {
      if (token === 'instructor') return { role: 'INSTRUCTOR' };
      if (token === 'learner') return { role: 'LEARNER' };
      throw new UnauthorizedException('invalid or expired token');
    });
    const app = express();
    app.use(
      '/import',
      importGate({
        authenticate,
        parse: express.json({ limit: '1mb', verify }),
        perAddress: { max: 5, windowMs: 60_000 },
      }),
    );
    app.post('/import', (req, res) => res.json({ got: (req.body as { n: number }).n }));
    app.use((_req, res) => res.status(404).json({ statusCode: 404 }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses a request with no token before a byte of the body is parsed', async () => {
    const reply = await send(port, '/import', 'POST', BIG);
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ statusCode: 401, message: 'missing bearer token', error: 'Unauthorized' });
    expect(verify).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('refuses a token that does not verify, in the words the guard would use', async () => {
    const reply = await send(port, '/import', 'POST', BIG, bearer('stale'));
    expect(reply.status).toBe(401);
    expect(reply.body.message).toBe('invalid or expired token');
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses a learner's token before parsing, with the guard's 403", async () => {
    const reply = await send(port, '/import', 'POST', BIG, bearer('learner'));
    expect(reply.status).toBe(403);
    expect(reply.body).toEqual({ statusCode: 403, message: 'insufficient role', error: 'Forbidden' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('lets an instructor through to the parser and the handler', async () => {
    const reply = await send(port, '/import', 'POST', BIG, bearer('instructor'));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ got: 1 });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('forwards an authorized async parser failure through Express error handling', async () => {
    const parserFailure = new Error('test-only parser failure');
    const parse = jest.fn(async () => { throw parserFailure; });
    const onError = jest.fn();
    const app = express();
    app.use('/import', importGate({ authenticate, parse }));
    app.post('/import', (_req, res) => res.json({ reached: true }));
    app.use(((error, _req, res, _next) => {
      onError(error);
      res.status(500).json({ statusCode: 500, message: 'parser failed' });
    }) as express.ErrorRequestHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const reply = await send((server.address() as AddressInfo).port, '/import', 'POST', '{}', bearer('instructor'));
      expect(reply).toEqual({ status: 500, body: { statusCode: 500, message: 'parser failed' } });
      expect(authenticate).toHaveBeenCalledWith('instructor');
      expect(parse).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(parserFailure);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never parses a body on any method but POST', async () => {
    const reply = await send(port, '/import', 'GET', BIG, bearer('instructor'));
    expect(reply.status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('counts every POST by address before looking at the token', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await send(port, '/import', 'POST', '{}')).status).toBe(401);
    }
    // The sixth is refused as too many, whoever sent it, even a real instructor.
    const sixth = await send(port, '/import', 'POST', '{}', bearer('instructor'));
    expect(sixth.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('lets nothing through when the process has no auth module', async () => {
    const app = express();
    app.use('/import', importGate({ authenticate: null, parse: express.json({ verify }) }));
    app.post('/import', (_req, res) => res.json({ reached: true }));
    const bare = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => bare.once('listening', resolve));
    try {
      const reply = await send(
        (bare.address() as AddressInfo).port,
        '/import',
        'POST',
        '{}',
        bearer('instructor'),
      );
      expect(reply.status).toBe(401);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

const silent: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

@Module({})
class BareModule {}

/**
 * The gate as `configureApp` mounts it: in front of the import parser, on the
 * real path. A body over the 4 MB default but under the import ceiling, sent
 * with no token, is answered 401 rather than parsed; a 413 here would mean
 * the parser ran first.
 */
describe('the import path as main.ts wires it', () => {
  let app: INestApplication;
  let port = 0;

  beforeAll(async () => {
    app = await NestFactory.create(BareModule, { logger: false });
    configureApp(app, silent);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses an anonymous import before parsing it, whatever its size', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024) });
    const reply = await send(port, '/api/v1/instructor/cohorts/import', 'POST', body);
    expect(reply.status).toBe(401);
    expect(reply.body.message).toBe('missing bearer token');
  });

  it('does not read a body sent with any other method', async () => {
    const reply = await send(port, '/api/v1/instructor/cohorts/import', 'GET', '{"a":1}');
    expect(reply.status).toBe(404);
  });
});
