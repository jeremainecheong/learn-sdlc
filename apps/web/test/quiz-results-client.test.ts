// @vitest-environment jsdom
/**
 * The two client calls the quiz-results page makes.
 *
 * - `quizResultsSummary(cohortId, project?)`: the one JSON read
 *   (`GET /instructor/quiz-results/summary`), the class always sent, the
 *   project only when named, both encoded; the same bearer token and the same
 *   refusals as every other instructor read.
 * - `exportClassQuizResults(kind, cohortId)`: one of the four CSV
 *   routes narrowed to the class with `?cohort=`, through the same CSV fetch as
 *   the class page's every-class download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleText } from './support/source-text';
import { QUIZ_RESULTS_EXPORT_KINDS } from '@learnsdlc/shared';
import { API_URL, ApiError } from '@/lib/api';
import { instructorApi } from '@/lib/api-instructor';
import { clearSession, setAuthSession } from '@/lib/session';
import { quizFixture } from './fixtures/quiz-results';

let calls: { url: string; init?: RequestInit }[] = [];
let reply: () => Response;

beforeEach(() => {
  calls = [];
  reply = () => new Response(JSON.stringify(quizFixture()), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return reply();
    }),
  );
  setAuthSession('quiz-client-token', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher' } as never);
});
afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
});

const authHeader = (init?: RequestInit) => {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('authorization');
  const record = headers as Record<string, string>;
  return record.authorization ?? record.Authorization ?? null;
};

describe('quizResultsSummary', () => {
  it('asks for the one class, encoded, and answers the summary as sent', async () => {
    const summary = await instructorApi.quizResultsSummary('class two/x');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/instructor/quiz-results/summary?cohort=class%20two%2Fx`);
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
    expect(authHeader(calls[0].init)).toBe('Bearer quiz-client-token');
    expect(summary).toEqual(quizFixture());
  });

  it('adds the project only when one is named, encoded after the class', async () => {
    await instructorApi.quizResultsSummary('class-one', 'my project&x');
    expect(calls[0].url).toBe(
      `${API_URL}/api/v1/instructor/quiz-results/summary?cohort=class-one&project=my%20project%26x`,
    );
  });

  it('a refusal is an ApiError carrying the status and the server message', async () => {
    reply = () => new Response(JSON.stringify({ message: 'Not found.' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const caught = await instructorApi.quizResultsSummary('someone-elses').catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe('Not found.');
  });
});

describe('exportClassQuizResults', () => {
  it.each(QUIZ_RESULTS_EXPORT_KINDS)('the %s file for the one class, through the existing CSV route', async (kind) => {
    reply = () => new Response('email,class\r\n', { status: 200, headers: { 'content-type': 'text/csv' } });
    const blob = await instructorApi.exportClassQuizResults(kind, 'class two/x');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_URL}/api/v1/instructor/quiz-results/${kind}.csv?cohort=class%20two%2Fx`);
    expect(authHeader(calls[0].init)).toBe('Bearer quiz-client-token');
    expect(blob.size).toBe('email,class\r\n'.length);
  });

  it('a refused file is an ApiError, nothing saved', async () => {
    reply = () => new Response(JSON.stringify({ message: 'Too many requests.' }), { status: 429, headers: { 'content-type': 'application/json' } });
    const caught = await instructorApi.exportClassQuizResults('class', 'class-one').catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(429);
  });

  it('the every-class download is unchanged: no cohort on exportQuizResults', async () => {
    reply = () => new Response('x', { status: 200 });
    await instructorApi.exportQuizResults('learners');
    expect(calls[0].url).toBe(`${API_URL}/api/v1/instructor/quiz-results/learners.csv`);
  });
});

describe('the client names no project', () => {
  it('no project slug literal in the two new calls', () => {
    const source = moduleText('instructorApi');
    const start = source.indexOf('quizResultsSummary:');
    const end = source.indexOf('exportClassQuizResults:');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const added = source.slice(start, source.indexOf('};', end));
    expect(added).not.toMatch(/tasktrackr/i);
    expect(added).not.toMatch(/project=['"`a-z]/i);
  });
});
