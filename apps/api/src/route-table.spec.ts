import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from './app.module';

/**
 * Every route the application module mounts, as `METHOD /path`, read from the
 * controllers' own decorators: the module's controllers and those of every
 * module it imports. The global `/api/v1` prefix is left off.
 */
function mountedRoutes(): string[] {
  const seen = new Set<unknown>();
  const controllers: Function[] = [];
  const walk = (mod: unknown): void => {
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    const target = (mod as { module?: unknown }).module ?? mod;
    controllers.push(...((Reflect.getMetadata('controllers', target as object) ?? []) as Function[]));
    for (const imported of (Reflect.getMetadata('imports', target as object) ?? []) as unknown[]) walk(imported);
  };
  walk(AppModule);
  const trim = (part: unknown) => String(part ?? '').replace(/^\/+|\/+$/g, '');
  const routes: string[] = [];
  for (const controller of controllers) {
    const bases = ([] as unknown[]).concat(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const paths = Reflect.getMetadata(PATH_METADATA, handler);
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (paths === undefined || method === undefined) continue;
      for (const base of bases) {
        for (const sub of ([] as unknown[]).concat(paths)) {
          routes.push(`${RequestMethod[method]} /${[trim(base), trim(sub)].filter(Boolean).join('/')}`);
        }
      }
    }
  }
  return routes.sort();
}

describe('the routes the application module mounts', () => {
  const routes = mountedRoutes();

  it('reads a real route table', () => {
    expect(routes).toContain('GET /phases/:id');
    expect(routes.length).toBeGreaterThan(100);
  });

  it('serves no warm-up route: a pack’s warm-up is compiled and stored, and nothing hands it to a learner', () => {
    expect(routes.filter((route) => / \/warmup(\/|$)/.test(route))).toEqual([]);
  });

  it('serves no estimate, retrospective, estimating record or class retrospective route', () => {
    const reflection = /^\w+ \/(phases\/:id\/(estimate|retro)|reflection\/record|instructor\/class-retro)$/;
    expect(routes.filter((route) => reflection.test(route))).toEqual([]);
    // the merge reflection is a different route, written when a learner advances, and it stays
    expect(routes).toContain('POST /phases/:id/reflect');
  });
});
