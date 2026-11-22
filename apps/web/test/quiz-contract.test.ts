import { repoPath } from './support/paths';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * The learner's three quiz doors, held against the controller that answers
 * them (the room's own contract).
 *
 * The response *shapes* live in `packages/shared`, so both sides hold the
 * same pair. The three *URLs* do not: the room builds them in `lib/api-quiz.ts`
 * and the API declares them again in `quiz.controller.ts`, and each side's
 * suite pins its own literals: `quiz-room.test.tsx` against a mocked
 * `request`, `quiz.controller.spec.ts` and `quiz-journey.e2e-spec.ts` against
 * a mounted application. Rename a segment on one side, update that side's
 * literals, and both suites stay green while the room 404s.
 *
 * So the room builds its paths from one table, and the case below reads the
 * doors the controller actually mounts and asserts the two lists are the same
 * list. It is the guarantee `AUTHORING_ROUTES` already gives the teacher's
 * surface, where the table lives in `packages/shared` and both sides import it.
 * That is where this table belongs too; while it lives on the client, this
 * cross-check buys the same red build.
 */

const held = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/lib/api', () => ({ request: held.request }));

const { QUIZ_ROUTES, QUIZ_ROUTE_KEYS, quizApi, quizPath } = await import('@/lib/api-quiz');

const { conceptApi } = await import('@/lib/api-concept');

/** The concept-check status the quiz controller also mounts. */
const CONCEPT_STATUS_DOOR = 'GET /phases/:id/concept-quizzes';

/* ------------------------- what the API really mounts --------------------- */

const CONTROLLER = repoPath('apps/api/src/quiz/quiz.controller.ts');

/**
 * The source with its comments taken out.
 *
 * The controller's own doc comment writes `@Controller('phases')` in prose to
 * explain why it sits beside `PhasesController`. A door is something the file
 * mounts, not something it mentions, so prose is removed before anything is
 * read out of it.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Every `METHOD /path` the quiz controller mounts, read from its decorators. */
const mountedDoors = (): string[] => {
  const source = withoutComments(readFileSync(CONTROLLER, 'utf8'));
  const prefix = /@Controller\(\s*'([^']*)'\s*\)/.exec(source)?.[1];
  // Not an assumption: a controller that stopped declaring a prefix would
  // silently move all three doors up a level.
  expect(prefix).toBe('phases');
  const doors: string[] = [];
  for (const match of source.matchAll(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g)) {
    const tail = match[2].trim().replace(/^['"]|['"]$/g, '');
    doors.push(`${match[1].toUpperCase()} /${[prefix, tail].filter(Boolean).join('/')}`);
  }
  return doors;
};

/** A door with its parameter *names* blanked, leaving the wire it describes. */
const wire = (door: string): string => door.replace(/:[A-Za-z][A-Za-z0-9]*/g, ':param');

describe('the learner’s quiz routes are one list, not two', () => {
  it('builds exactly the doors the quiz controller mounts', () => {
    const client = QUIZ_ROUTE_KEYS.map((key) => `${QUIZ_ROUTES[key].method} ${QUIZ_ROUTES[key].path}`);
    // The controller also answers the phase's concept-check status,
    // which the concept client (not the quiz room's table) knocks on.
    const api = mountedDoors().filter((door) => door !== CONCEPT_STATUS_DOOR);

    // Three on each side, and the same three. Renaming `quiz`, `attempts` or a
    // segment's position on either side alone turns this red; renaming a
    // parameter, which the wire never carries, does not.
    expect(api).toHaveLength(3);
    expect(client.map(wire).sort()).toEqual(api.map(wire).sort());
  });

  it('mounts one door more, the concept-check status, and it is the one the concept client asks', async () => {
    // Four doors in all, the fourth being the status read.
    const doors = mountedDoors();
    expect(doors).toHaveLength(4);
    expect(doors).toContain(CONCEPT_STATUS_DOOR);

    // The concept client builds the same wire.
    held.request.mockReset();
    held.request.mockResolvedValueOnce({});
    await conceptApi.status('PHASE');
    expect(held.request).toHaveBeenCalledTimes(1);
    const [method, path] = held.request.mock.calls[0] as [string, string];
    expect(wire(`${method} ${path.replace('/PHASE/', '/:id/')}`)).toBe(wire(CONCEPT_STATUS_DOOR));
  });

  it('keeps the three paths the deployed learner knocks on', () => {
    // Written out once, so the table above is readable as a wire and not only
    // as a comparison against another file.
    expect(QUIZ_ROUTES.room.path).toBe('/phases/:id/tasks/:taskKey/quiz');
    expect(QUIZ_ROUTES.start.path).toBe('/phases/:id/tasks/:taskKey/quiz/attempts');
    expect(QUIZ_ROUTES.handIn.path).toBe('/phases/:id/tasks/:taskKey/quiz/attempts/:attemptId');
    expect(QUIZ_ROUTES.room.method).toBe('GET');
    expect(QUIZ_ROUTES.start.method).toBe('POST');
    expect(QUIZ_ROUTES.handIn.method).toBe('POST');
  });
});

describe('quizPath fills a door in', () => {
  it('percent-encodes every id, so an id carrying a slash opens no path of its own', () => {
    expect(quizPath('handIn', { id: 'p 4', taskKey: 'a/b', attemptId: 'a1' })).toBe(
      '/phases/p%204/tasks/a%2Fb/quiz/attempts/a1',
    );
  });

  it('refuses a path with a placeholder still in it', () => {
    // A request that can only be refused, refused here instead, naming what is
    // missing rather than meeting a 404 whose body says nothing.
    expect(() => quizPath('room', { id: 'p4' })).toThrow(/taskKey/);
    expect(() => quizPath('room', { id: '', taskKey: 'concepts' })).toThrow(/id/);
  });
});

describe('the quiz client calls its own table', () => {
  it('reads, starts and hands in on the table’s method and path', async () => {
    held.request.mockResolvedValue({});

    await quizApi.read('p4', 'concepts');
    expect(held.request).toHaveBeenLastCalledWith('GET', '/phases/p4/tasks/concepts/quiz');

    await quizApi.start('p4', 'concepts');
    expect(held.request).toHaveBeenLastCalledWith('POST', '/phases/p4/tasks/concepts/quiz/attempts');

    await quizApi.handIn('p4', 'concepts', 'a1', { boundary: ['o1'] });
    expect(held.request).toHaveBeenLastCalledWith(
      'POST',
      '/phases/p4/tasks/concepts/quiz/attempts/a1',
      { answers: { boundary: ['o1'] } },
    );
  });
});
