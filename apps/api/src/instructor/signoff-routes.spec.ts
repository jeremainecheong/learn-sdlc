import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import {
  AUTHORING_ROUTES,
  AUTHORING_ROUTE_KEYS,
  SIGNOFF_ROUTES,
  SIGNOFF_ROUTE_KEYS,
} from '@learnsdlc/shared';
import { ROLES_KEY } from '../auth/auth.decorators';
import { RATE_LIMIT_KEY } from '../auth/rate-limit.guard';
import { AuthoringController } from '../authoring/authoring.controller';
import { InstructorDetailController } from './instructor.controller';

/** Nest's own numbering for `RequestMethod`, as the decorators write it. */
const METHOD_NAME = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** Every route a controller mounts, as `METHOD /path` → its handler. */
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

const doorOf = (key: keyof typeof SIGNOFF_ROUTES) => `${SIGNOFF_ROUTES[key].method} ${SIGNOFF_ROUTES[key].path}`;

/**
 * The instructor controller has these 24 base routes plus one sign-off route
 * block: exactly the two `SIGNOFF_ROUTES`. Held as a count beside the table,
 * so a third sign-off route, or a moved sign-off route, is red here.
 */
const DOORS_BEFORE_SIGN = 24;

describe('the sign-off routes (SIGN, CUT-1)', () => {
  it('the instructor controller mounts exactly SIGNOFF_ROUTES; none is an AuthoringRouteKey', () => {
    const doors = mounted(InstructorDetailController);
    for (const key of SIGNOFF_ROUTE_KEYS) expect(doors.has(doorOf(key))).toBe(true);
    // Every sign-off-shaped door is one of the table's, and nothing else was added.
    const signoffDoors = [...doors.keys()].filter((door) => /signoff/i.test(door));
    expect(signoffDoors.sort()).toEqual(SIGNOFF_ROUTE_KEYS.map(doorOf).sort());
    expect(doors.size).toBe(DOORS_BEFORE_SIGN + SIGNOFF_ROUTE_KEYS.length);

    // Not an authoring key, by name or by door, and not mounted on the authoring controller.
    for (const key of SIGNOFF_ROUTE_KEYS) {
      expect([key, (AUTHORING_ROUTE_KEYS as readonly string[]).includes(key)]).toEqual([key, false]);
    }
    const authoringDoors = new Set(AUTHORING_ROUTE_KEYS.map((key) => `${AUTHORING_ROUTES[key].method} ${AUTHORING_ROUTES[key].path}`));
    for (const key of SIGNOFF_ROUTE_KEYS) expect(authoringDoors.has(doorOf(key))).toBe(false);
    const authoringMounted = mounted(AuthoringController);
    for (const key of SIGNOFF_ROUTE_KEYS) expect(authoringMounted.has(doorOf(key))).toBe(false);
  });

  it('is staff only, and the bulk door is rate-limited tighter than the console', () => {
    expect(Reflect.getMetadata(ROLES_KEY, InstructorDetailController)).toEqual(['INSTRUCTOR', 'ADMIN']);
    for (const key of SIGNOFF_ROUTE_KEYS) expect([...SIGNOFF_ROUTES[key].roles].sort()).toEqual(['ADMIN', 'INSTRUCTOR']);
    const doors = mounted(InstructorDetailController);
    const bulk = doors.get(doorOf('signoff.bulk'))!;
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, bulk)).toEqual(expect.objectContaining({ max: 10, windowSeconds: 60 }));
  });
});
