import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthUser } from '../auth/auth.decorators';
import { bearerToken } from '../auth/bearer';

/**
 * The door in front of the cohort import body parser (up to IMPORT_MAX_BYTES).
 *
 * The parser for `/instructor/cohorts/import` is express middleware, and
 * express middleware runs before any Nest guard: left on its own it would
 * read and hold a body of up to the import ceiling for anybody at all (no
 * token, a learner's token, a GET with a body) before the guard says 401.
 * A handful of such requests can multiply the process's resident memory.
 *
 * So the parser is only reached by a POST whose bearer token verifies to a
 * member of staff, checked here with the same `authenticate` the guard uses,
 * and every request on the path is counted by address before any of that.
 * The guard still runs afterwards and does its own check; this gate decides
 * nothing about the import itself, only whether the bytes are worth reading.
 */
export interface ImportGateOptions {
  /**
   * Turns a bearer token into the caller, or throws. Null when the process
   * has no auth module at all (a spec mounting the HTTP layer on a throwaway
   * app), in which case nothing gets through.
   */
  authenticate: ((token: string) => Promise<Pick<AuthUser, 'role'>>) | null;
  /** The body parser the gate stands in front of. */
  parse: RequestHandler;
  /** Requests one address may make on the path per window, counted before anything is read. */
  perAddress?: { max: number; windowMs: number };
}

/**
 * Twenty a minute from one address, token or not. The route's own limit is
 * ten a minute per caller once they are known; this one exists for the
 * requests that never become a caller.
 */
export const IMPORT_GATE_PER_ADDRESS = { max: 20, windowMs: 60_000 };

/** Table size at which ended windows are reclaimed on the next request. */
const SWEEP_SIZE = 10_000;

const STAFF: ReadonlySet<string> = new Set(['INSTRUCTOR', 'ADMIN']);

interface Bucket {
  count: number;
  resetAt: number;
}

/** The shape Nest gives its own refusals, so a client reads both the same way. */
function refuse(res: Response, status: number, message: string, error: string): void {
  res.status(status).json({ statusCode: status, message, error });
}

export function importGate(options: ImportGateOptions): RequestHandler {
  const limit = options.perAddress ?? IMPORT_GATE_PER_ADDRESS;
  const buckets = new Map<string, Bucket>();

  const overLimit = (address: string): boolean => {
    const now = Date.now();
    if (buckets.size >= SWEEP_SIZE) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
    }
    let bucket = buckets.get(address);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + limit.windowMs };
      buckets.set(address, bucket);
    }
    bucket.count += 1;
    return bucket.count > limit.max;
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Anything but a POST has no body worth reading: Nest answers the method
    // itself (404), and the bytes are never parsed.
    if (req.method !== 'POST') return next();

    if (overLimit(req.ip || 'anonymous')) {
      return refuse(res, 429, 'rate limit exceeded — slow down', 'Too Many Requests');
    }

    const header = String(req.headers.authorization ?? '');
    const token = bearerToken(header) ?? '';
    if (!token) return refuse(res, 401, 'missing bearer token', 'Unauthorized');
    if (!options.authenticate) return refuse(res, 401, 'invalid or expired token', 'Unauthorized');

    let caller: Pick<AuthUser, 'role'>;
    try {
      caller = await options.authenticate(token);
    } catch (err) {
      return refuse(res, 401, (err as Error)?.message || 'invalid or expired token', 'Unauthorized');
    }
    if (!STAFF.has(caller.role)) return refuse(res, 403, 'insufficient role', 'Forbidden');

    // Express 5 permits async parsers/handlers. Await their unknown return so a
    // rejection still reaches Express while this gate retains Promise<void>.
    await options.parse(req, res, next);
  };
}
