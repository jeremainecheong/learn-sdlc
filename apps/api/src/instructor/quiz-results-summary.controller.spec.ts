import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../app.module';
import { ROLES_KEY } from '../auth/auth.decorators';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../auth/rate-limit.guard';
import { QuizResultsExportController, QuizResultsSummaryController } from './quiz-results-export.controller';

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

const SUMMARY = 'GET /instructor/quiz-results/summary';

describe('QuizResultsSummaryController', () => {
  it('mounts exactly the summary route, 20/60, INSTRUCTOR/ADMIN, behind the rate-limit guard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, QuizResultsSummaryController)).toBe('instructor');
    const doors = mounted(QuizResultsSummaryController);
    expect([...doors.keys()]).toEqual([SUMMARY]);
    const handler = doors.get(SUMMARY)!;
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual(expect.objectContaining({ max: 20, windowSeconds: 60 }));
    expect(Reflect.getMetadata(ROLES_KEY, QuizResultsSummaryController)).toEqual(['INSTRUCTOR', 'ADMIN']);
    // The handler does not widen the class's roles.
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, QuizResultsSummaryController)).toContain(RateLimitGuard);
  });

  it('leaves the quiz-results CSV controller without a summary handler', () => {
    expect(Object.getOwnPropertyNames(QuizResultsExportController.prototype)).not.toContain('summary');
    expect((QuizResultsExportController.prototype as unknown as Record<string, unknown>).summary).toBeUndefined();
    expect([...mounted(QuizResultsExportController).keys()]).not.toContain(SUMMARY);
  });

  it('is registered in AppModule beside the CSV controller', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(QuizResultsExportController);
    expect(controllers).toContain(QuizResultsSummaryController);
  });
});
