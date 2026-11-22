import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * The three property names JSON is allowed to carry but an object is not
 * allowed to be given. `JSON.parse` keeps every one of them as an own key:
 * `{"__proto__":{}}` parses to an object whose *own* property is called
 * `__proto__`, and the validation pipe then hands the body to
 * class-transformer, which walks every key of every nested object and falls
 * over on `constructor` (a 500 with a request id instead of the 400 the
 * service would have given), while a `__proto__` key re-parents the nested
 * object and quietly disappears from what the service is given.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** How deep a body is walked. Nothing this API takes nests further than four. */
const MAX_DEPTH = 32;

export const BODY_KEY_REFUSED = 'a field in this request has a name that cannot be used';

/**
 * The first forbidden key found anywhere in `value`, as a dotted path, or
 * null. Arrays are walked; anything that is not a plain object or an array is
 * a leaf.
 */
export function findForbiddenKey(value: unknown, depth = 0, prefix = ''): string | null {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenKey(value[i], depth + 1, `${prefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) return path;
    const hit = findForbiddenKey((value as Record<string, unknown>)[key], depth + 1, path);
    if (hit) return hit;
  }
  return null;
}

/**
 * Refuses a body that names `__proto__`, `constructor` or `prototype` as a
 * key, at any depth, with a 400: before the validation pipe walks it. Guards
 * run ahead of pipes, which is the only place in the request path where the
 * raw parsed body can still be looked at whole.
 *
 * Mounted on the controllers whose DTOs carry a free-form object (the two
 * workspace saves take `files: Record<path, text>`), which is where the pipe
 * has nothing of its own to say about the keys.
 */
@Injectable()
export class BodyKeysGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ body?: unknown }>();
    const hit = findForbiddenKey(request.body);
    if (hit) throw new BadRequestException(BODY_KEY_REFUSED);
    return true;
  }
}
