// @vitest-environment jsdom
/**
 * `passCredited`, from the shared view to the quiz room: the learner's quiz
 * room, mounted, reading what the API answered in
 * `apps/api/test/quiz-reveal-contract-wiring.e2e-spec.ts`
 * (`apps/api/test/fixtures/contract-bodies/quiz-reveal.json`, `learnerCredited`).
 *
 * There a teacher signed off a quiz the learner had failed, so the task's row
 * reads passed with no paper behind it, and the room answered
 * `passCredited: true` under the shared `QuizRoomView` name. Here the real
 * `QuizRoom` reads that answer through the real `quizApi.read` and `request`
 * (and the marked paper through `api.getSubmission`), with `fetch` the only
 * seam: the best score is named the teacher's credit and the credited line is
 * drawn. The quiz no one credited, recorded beside it, carries no such key and
 * the room says nothing of a credit.
 */
import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizRoomView } from '@learnsdlc/shared';

vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getToken: () => 'wiring-token',
  getSession: () => ({ id: 'learner', role: 'LEARNER', displayName: 'Learner' }),
  useSession: () => ({ id: 'learner', role: 'LEARNER', displayName: 'Learner' }),
}));

import { CREDIT_WORD, CREDITED_LINE, QuizRoom } from '@/components/workspace/quiz/QuizRoom';

const RECORDING = repoPath('apps/api/test/fixtures/contract-bodies/quiz-reveal.json');
const bodies = JSON.parse(readFileSync(RECORDING, 'utf-8')).bodies as {
  learnerPlain: { verdict: { id: string } };
  learnerCredited: { room: QuizRoomView; uncreditedRoom: QuizRoomView };
};
const credited = bodies.learnerCredited.room;
const uncredited = bodies.learnerCredited.uncreditedRoom;

let serving: QuizRoomView = credited;
const seen: string[] = [];

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  seen.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const path = decodeURIComponent(url.replace(/^.*\/api\/v1/, ''));
      const method = (init?.method ?? 'GET').toUpperCase();
      seen.push(`${method} ${path}`);
      if (method === 'GET' && /\/tasks\/[^/]+\/quiz$/.test(path)) return answer(200, serving);
      // The marked paper the room draws back: the recorded verdict of the sheet
      // the credited room names (the same placeholder id in one recording).
      if (method === 'GET' && path === `/submissions/${bodies.learnerPlain.verdict.id}`) return answer(200, bodies.learnerPlain.verdict);
      return answer(404, { message: `the wiring server has no ${method} ${path}` });
    }),
  );
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = async (room: QuizRoomView) => {
  serving = room;
  await act(async () => {
    root.render(<QuizRoom phaseId="<uuid:phase>" taskKey={room.taskKey} />);
  });
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

describe('passCredited, from the API recording', () => {
  it('the recording holds the shared field on the credited room and not on the other', () => {
    expect(credited.status).toBe('passed');
    expect(credited.passCredited).toBe(true);
    expect(credited.bestScore).toBe(credited.passMark);
    expect('passCredited' in uncredited).toBe(false);
  });

  it('draws the teacher’s credit on the recorded credited room, read through the real quiz client', async () => {
    await mount(credited);
    expect(seen[0]).toBe(`GET /phases/<uuid:phase>/tasks/${credited.taskKey}/quiz`);
    const best = host.querySelector('[data-testid="quiz-best-score"]');
    expect(best?.textContent).toContain(`${Math.round(credited.bestScore!)}%, ${CREDIT_WORD}`);
    expect(host.querySelector('[data-testid="quiz-credited"]')?.textContent).toBe(CREDITED_LINE);
  });

  it('says nothing of a credit on the recorded room no one credited', async () => {
    await mount(uncredited);
    expect(host.querySelector('[data-testid="quiz-header"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="quiz-credited"]')).toBeNull();
    expect(host.textContent).not.toContain(CREDIT_WORD);
  });
});
