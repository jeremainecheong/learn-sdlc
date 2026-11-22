import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { QUIZ_RESULTS_EXPORT_KINDS, type QuizResultsExportKind } from '@learnsdlc/shared';
import { ROLES_KEY } from '../auth/auth.decorators';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../auth/rate-limit.guard';
import { QuizResultsExportController } from './quiz-results-export.controller';
import type { QuizResultsExportService } from './quiz-results-export.service';

/** Nest's own numbering for `RequestMethod`, as the decorators write it. */
const METHOD_NAME = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** Every route the controller mounts, as `METHOD /path` → its handler. */
function mounted(controller: Function): Map<string, Function> {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as Record<string, unknown>;
  const out = new Map<string, Function>();
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name];
    const path = Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined;
    if (path === undefined) continue;
    const method = METHOD_NAME[Reflect.getMetadata(METHOD_METADATA, handler as object) as number];
    out.set(`${method} /${[base, path].filter((part) => part && part !== '/').join('/')}`, handler as Function);
  }
  return out;
}

const door = (kind: QuizResultsExportKind) => `GET /instructor/quiz-results/${kind}.csv`;

describe('QuizResultsExportController (QX, CUT-9)', () => {
  it('mounts exactly the four routes, each rate-limited 5/60, INSTRUCTOR/ADMIN', () => {
    const doors = mounted(QuizResultsExportController);
    expect([...doors.keys()].sort()).toEqual(QUIZ_RESULTS_EXPORT_KINDS.map(door).sort());
    expect(Reflect.getMetadata(ROLES_KEY, QuizResultsExportController)).toEqual(['INSTRUCTOR', 'ADMIN']);
    expect(Reflect.getMetadata(GUARDS_METADATA, QuizResultsExportController)).toContain(RateLimitGuard);
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
      const handler = doors.get(door(kind))!;
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual(expect.objectContaining({ max: 5, windowSeconds: 60 }));
      // No handler widens the class's roles.
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    }
  });

  it('hands each kind to the service and names the file as the existing exports do', async () => {
    const calls: unknown[][] = [];
    const service = {
      export: async (...args: unknown[]) => {
        calls.push(args);
        return 'header\r\n';
      },
    } as unknown as QuizResultsExportService;
    const controller = new QuizResultsExportController(service);
    const caller = { id: 'teacher', role: 'INSTRUCTOR', cohort: 'c' } as never;
    for (const kind of QUIZ_RESULTS_EXPORT_KINDS) {
      const headers: Record<string, string> = {};
      const res = { setHeader: (name: string, value: string) => (headers[name] = value) } as never;
      const handler = (controller as unknown as Record<string, Function>)[
        Object.getOwnPropertyNames(QuizResultsExportController.prototype).find(
          (name) =>
            Reflect.getMetadata(PATH_METADATA, (QuizResultsExportController.prototype as any)[name]) ===
            `quiz-results/${kind}.csv`,
        )!
      ];
      const body = await handler.call(controller, caller, { project: 'payroll', cohort: 'class-one' }, res);
      expect(body).toBe('header\r\n');
      expect(headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(headers['content-disposition']).toBe(`attachment; filename="quiz-${kind}-payroll.csv"`);
    }
    expect(calls.map((args) => args[1])).toEqual([...QUIZ_RESULTS_EXPORT_KINDS]);
    expect(calls.every((args) => JSON.stringify(args[2]) === JSON.stringify({ project: 'payroll', cohort: 'class-one' }))).toBe(true);
  });
});
