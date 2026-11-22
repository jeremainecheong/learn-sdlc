import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { BODY_KEY_REFUSED, BodyKeysGuard, findForbiddenKey } from './body-keys.guard';

const contextFor = (body: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ body }) }),
  }) as unknown as ExecutionContext;

/**
 * Unguarded, a `files` map whose key is `constructor` answers 500 from inside
 * the validation pipe, and one whose key is `__proto__` vanishes before the
 * service sees it. The guard makes both a 400, caught before the pipe.
 */
describe('BodyKeysGuard', () => {
  const guard = new BodyKeysGuard();

  it('lets an ordinary workspace save through', () => {
    expect(
      guard.canActivate(
        contextFor({ files: { 'requirements/draft.md': 'x', 'a/b.py': '' }, baseVersion: 'v' }),
      ),
    ).toBe(true);
  });

  it('lets a body with no object at all through', () => {
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
    expect(guard.canActivate(contextFor('text'))).toBe(true);
    expect(guard.canActivate(contextFor(null))).toBe(true);
  });

  it('refuses a nested constructor key with a 400, never a 500', () => {
    expect(() => guard.canActivate(contextFor({ files: { constructor: 'x' } }))).toThrow(
      BadRequestException,
    );
    expect(() => guard.canActivate(contextFor({ files: { constructor: 'x' } }))).toThrow(
      BODY_KEY_REFUSED,
    );
  });

  it('refuses a __proto__ key that JSON.parse kept as an own property', () => {
    const body = JSON.parse('{"files":{"__proto__":{"polluted":1},"requirements/draft.md":"x"}}');
    expect(() => guard.canActivate(contextFor(body))).toThrow(BadRequestException);
  });

  it('refuses the keys at the top level and inside a list too', () => {
    expect(() => guard.canActivate(contextFor(JSON.parse('{"prototype":1}')))).toThrow(
      BadRequestException,
    );
    expect(() =>
      guard.canActivate(contextFor({ links: [{ from: 'a', to: { constructor: 1 } }] })),
    ).toThrow(BadRequestException);
  });

  it('names the path of the first offending key', () => {
    expect(findForbiddenKey({ files: { constructor: 'x' } })).toBe('files.constructor');
    expect(findForbiddenKey({ links: [{}, { __proto__: 1 }] })).toBeNull(); // literal: not an own key
    expect(findForbiddenKey(JSON.parse('{"links":[{},{"__proto__":1}]}'))).toBe('links[1].__proto__');
    expect(findForbiddenKey({ a: { b: { c: 'fine' } } })).toBeNull();
  });
});
