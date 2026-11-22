import 'reflect-metadata';
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'net';
import * as http from 'http';
import * as zlib from 'zlib';
import { configureApp } from './main';
import { LoginDto } from './dto';
import { PreviewStatusQuery } from './preview/preview.dto';
import request from 'supertest';

/**
 * Responses of the shape and size the app actually serves. All three are the
 * same dozen key names repeated a hundred times over short values, which is
 * the whole argument for compressing them: measured, the submissions list was
 * 51.1 KB and 1.4 KB gzipped, the instructor overview 17.2 KB and 1.9 KB, and
 * a learner's detail 40.6 KB and 4.3 KB. Thirty learners opening the app moved
 * 10.2 MB over a shared classroom network.
 */
const submissions = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `2f6a1c${String(i).padStart(4, '0')}-4a1b-4c2d-9e3f-8a7b6c5d4e3f`,
    phaseStateId: `9b2c3d4e-${String(i).padStart(4, '0')}-4f5a-8b9c-0d1e2f3a4b5c`,
    status: i % 3 === 0 ? 'passed' : 'failed',
    score: 60 + (i % 40),
    attempt: (i % 5) + 1,
    createdAt: new Date(Date.UTC(2026, 8, 3, 9, i % 60)).toISOString(),
    report:
      '## Automated checks\n\nThe visible tests ran and three of five passed. ' +
      'The failing cases are in `tests/test_tasks.py`, line 42 and line 58.\n',
    rubric: [
      { criterion: 'acceptance criteria covered', score: 3, of: 4 },
      { criterion: 'edge cases considered', score: 2, of: 4 },
      { criterion: 'readable structure', score: 4, of: 4 },
    ],
  }));

const learners = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    userId: `7c1d2e3f-${String(i).padStart(4, '0')}-4a5b-8c9d-0e1f2a3b4c5d`,
    displayName: `Learner ${i}`,
    email: `learner-${i}@uni.test`,
    cohort: 'class-2026',
    phase: (i % 5) + 1,
    bestScore: 55 + (i % 45),
    hintsUsed: i % 7,
    lastActiveAt: new Date(Date.UTC(2026, 8, 3, 9, i % 60)).toISOString(),
  }));

/** The three requests a learner's first load makes, at the measured sizes. */
@Controller()
class ConsoleProbe {
  @Get('query-probe')
  query(@Query() query: PreviewStatusQuery) { return query; }

  @Post('body-probe')
  body(@Body() body: LoginDto) { return { email: body.email }; }

  @Get('submissions')
  list() {
    return { submissions: submissions(100) };
  }

  @Get('instructor/overview')
  overview() {
    return { cohort: 'class-2026', learners: learners(50) };
  }

  @Get('instructor/learners/detail')
  detail() {
    return { learner: learners(1)[0], submissions: submissions(80) };
  }
}

@Module({ controllers: [ConsoleProbe] })
class ProbeModule {}

const silent: LoggerService = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  verbose: () => undefined,
};

/** The three paths, under the global prefix configureApp sets. */
const FIRST_LOAD = [
  '/api/v1/submissions',
  '/api/v1/instructor/overview',
  '/api/v1/instructor/learners/detail',
];

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Bytes on the wire: Node's client does not decompress for us. */
  bytes: number;
  body: Buffer;
}

/** One request, counted the way the network counts it. */
function fetchRaw(
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: body.length, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const gzip = { 'accept-encoding': 'gzip' };

describe('the HTTP layer main.ts installs', () => {
  let app: INestApplication;
  let port = 0;
  const path = FIRST_LOAD[0];

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    configureApp(app, silent);
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it('bounds and sanitizes malformed credential migration bodies before diagnostics', async () => {
    const marker = 'private-password-fixture-never-log';
    const malformed = await request(app.getHttpServer())
      .post('/api/v1/auth/cognito/migrate').set('Content-Type', 'application/json').send(marker);
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).toBe('identity migration request refused');
    expect(malformed.text).not.toContain(marker);
    const oversized = await request(app.getHttpServer())
      .post('/api/v1/auth/cognito/migrate').send({ password: marker.repeat(200) });
    expect(oversized.status).toBe(413);
    expect(oversized.text).not.toContain(marker);
  });

  it('compresses a response for a browser that asked for it', async () => {
    const plain = await fetchRaw(port, path);
    const zipped = await fetchRaw(port, path, gzip);

    expect(plain.status).toBe(200);
    expect(zipped.status).toBe(200);
    expect(zipped.headers['content-encoding']).toBe('gzip');
    // The saving is the reason this middleware exists, not a rounding error.
    expect(zipped.bytes).toBeLessThan(plain.bytes / 5);
  });

  it('sends back exactly what it would have sent uncompressed', async () => {
    const plain = await fetchRaw(port, path);
    const zipped = await fetchRaw(port, path, gzip);
    const inflated = zlib.gunzipSync(zipped.body).toString('utf8');
    expect(inflated).toBe(plain.body.toString('utf8'));
    expect(JSON.parse(inflated).submissions).toHaveLength(100);
  });

  it('leaves a client that did not ask for compression alone', async () => {
    const plain = await fetchRaw(port, path);
    expect(plain.headers['content-encoding']).toBeUndefined();
  });

  it('keeps a class of thirty opening the app under two megabytes', async () => {
    const budget = 2 * 1024 * 1024;
    let compressed = 0;
    let uncompressed = 0;
    for (let learner = 0; learner < 30; learner++) {
      for (const route of FIRST_LOAD) {
        compressed += (await fetchRaw(port, route, gzip)).bytes;
      }
    }
    for (const route of FIRST_LOAD) uncompressed += (await fetchRaw(port, route)).bytes * 30;

    // The assertion only means something if the same requests would have blown
    // the budget without the middleware, so state that half too.
    expect(uncompressed).toBeGreaterThan(budget);
    expect(compressed).toBeLessThan(budget);
  });

  it('still sets the headers the rest of the app relies on', async () => {
    // configureApp is the single description of the HTTP layer, so this is
    // the spec that notices when one of its middlewares goes missing.
    const res = await fetchRaw(port, path, gzip);
    expect(res.status).toBe(200);
    // requestLogging: the correlation id a learner can quote at an instructor.
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    // helmet.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps scalar query conversion and rejects repeated or invalid cursor values', async () => {
    const http = app.getHttpServer();
    await request(http).get('/api/v1/query-probe?cursor=12').expect(200, { cursor: 12 });
    await request(http).get('/api/v1/query-probe?cursor=1&cursor=2').expect(400);
    await request(http).get('/api/v1/query-probe?cursor=-1').expect(400);
  });

  it('still validates absent and malformed JSON bodies instead of invoking a handler with invalid input', async () => {
    const http = app.getHttpServer();
    await request(http).post('/api/v1/body-probe').expect(400);
    await request(http).post('/api/v1/body-probe').type('json').send('{"email":').expect(400);
    await request(http).post('/api/v1/body-probe').send({ email: 'probe@example.test', password: 'test-only', unexpected: 'discard' }).expect(201, { email: 'probe@example.test' });
  });

  it('preserves explicitly configured form-body parsing and the JSON validation contract', async () => {
    await request(app.getHttpServer()).post('/api/v1/body-probe').type('form').send({ email: 'probe@example.test', password: 'test-only' }).expect(201, { email: 'probe@example.test' });
  });
});
