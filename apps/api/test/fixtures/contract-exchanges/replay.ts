import { createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Exchange } from './recorder';

/**
 * A tiny HTTP server that answers the web's requests with
 * what the API answered when the recording was made.
 *
 * The web wiring tests mount the real component with the real `lib/api-*`
 * client and leave `fetch` alone; the client's base URL is pointed at this
 * server, which binds `127.0.0.1:0` (an ephemeral port, never a named one).
 *
 * Matching is by method and path, ids included: the web reads its ids out of
 * the recorded bodies (`<uuid:3>` and so on), so the path it builds is the
 * recorded path with the same placeholders, percent-encoded. When one method
 * and path were recorded more than once, the exchanges whose query and then
 * whose request body equal what the web sent are preferred (a batch with a
 * short reason is not answered by the accepted batch's 200), and among those
 * the answers are served in order and the last one repeats. A request
 * nothing was recorded for is answered 404 and listed in `misses`, so a test
 * can say what the page asked for that the API was never asked.
 *
 * Every request is kept in `seen`, body parsed, so a test can compare what the
 * web sent with the body the API accepted.
 */
export interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export interface Replay {
  url: string;
  seen: Seen[];
  misses: string[];
  /** Replace the answers for one method and path, served afresh in order (a vacuity proof breaks a body). */
  answer(method: string, path: string, answers: Array<Pick<Exchange, 'status' | 'body' | 'headers'>>): void;
  close(): Promise<void>;
}

const keyOf = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

/** A digest placeholder as the recorder writes it (`<sha256:3>`). */
const DIGEST_PLACEHOLDER = /^<sha256:\d+>$/;

/**
 * The recording with each `<sha256:N>` placeholder swapped for a real-looking
 * 64-hex digest (the sha256 of the placeholder itself, so the same placeholder
 * is always the same digest). Made at replay time and never written: the
 * recordings on disk keep their placeholders.
 *
 * A web test replays this so that what the page does with a digest is
 * observable. A placeholder is short and holds no hex, so "the page draws the
 * full digest", "only a prefix" and "no digest at all" cannot be told apart
 * on it, and a check that the page holds no 64-hex string can never fail.
 */
export function withSyntheticDigests<T>(value: T): T {
  const walk = (one: unknown): unknown => {
    if (typeof one === 'string') {
      return DIGEST_PLACEHOLDER.test(one) ? createHash('sha256').update(one).digest('hex') : one;
    }
    if (Array.isArray(one)) return one.map(walk);
    if (one && typeof one === 'object') {
      return Object.fromEntries(Object.entries(one as Record<string, unknown>).map(([key, inner]) => [key, walk(inner)]));
    }
    return one;
  };
  return walk(value) as T;
}

/** JSON with object keys sorted, so two equal bodies compare equal whatever their key order. */
function canonical(value: unknown): string {
  const walk = (one: unknown): unknown =>
    Array.isArray(one)
      ? one.map(walk)
      : one && typeof one === 'object'
        ? Object.fromEntries(Object.keys(one as object).sort().map((key) => [key, walk((one as Record<string, unknown>)[key])]))
        : one;
  return JSON.stringify(walk(value ?? null));
}

type Answer = Pick<Exchange, 'status' | 'body' | 'headers'> & Partial<Pick<Exchange, 'query' | 'requestBody'>>;

export async function startReplay(exchanges: readonly Exchange[]): Promise<Replay> {
  const queues = new Map<string, Answer[]>();
  for (const one of exchanges) {
    const key = keyOf(one.method, one.path);
    queues.set(key, [...(queues.get(key) ?? []), one]);
  }
  const served = new Map<Answer, number>();
  const seen: Seen[] = [];
  const misses: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = decodeURIComponent(url.pathname).replace(/^\/api\/v1/, '');
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const method = (req.method ?? 'GET').toUpperCase();
      seen.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: req.headers.authorization,
      });
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
        'access-control-expose-headers': 'content-disposition',
      };
      if (method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const key = keyOf(method, path);
      const answers = queues.get(key);
      if (!answers?.length) {
        misses.push(key);
        res.writeHead(404, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 404, message: 'Not recorded.' }));
        return;
      }
      const query = canonical(Object.fromEntries(url.searchParams));
      const byQuery = answers.filter((one) => one.query === undefined || canonical(one.query) === query);
      const pool1 = byQuery.length ? byQuery : answers;
      const byBody = pool1.filter((one) => one.requestBody !== undefined && canonical(one.requestBody) === canonical(body));
      const pool = byBody.length ? byBody : pool1;
      const answer = pool.find((one) => !served.has(one)) ?? pool[pool.length - 1];
      served.set(answer, (served.get(answer) ?? 0) + 1);
      const text = answer.body as { contentType?: string; text?: string } | null;
      if (text && typeof text === 'object' && typeof text.contentType === 'string' && typeof text.text === 'string') {
        res.writeHead(answer.status, { ...cors, ...(answer.headers ?? {}), 'content-type': text.contentType });
        res.end(text.text);
        return;
      }
      res.writeHead(answer.status, { ...cors, ...(answer.headers ?? {}), 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    misses,
    answer(method, path, next) {
      // Fresh copies, so an answer served in an earlier test is served again.
      queues.set(keyOf(method, path), next.map((one) => ({ ...one })));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
