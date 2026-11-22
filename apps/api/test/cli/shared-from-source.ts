import * as path from 'path';

/** The shared package's source entry point. */
const SHARED_SOURCE = path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src', 'index.ts');

/**
 * Make this process resolve `@learnsdlc/shared` to its TypeScript source, as
 * the Jest suite does (`jest.config.js` maps it the same way). Plain Node
 * would load the built `packages/shared/dist`, and a stale build would then
 * make a generator's `--check` disagree with the spec that reads the same
 * source. Call it before anything requires the shared package.
 */
export function readSharedFromSource(): void {
  const Module = require('module') as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
    return resolve.call(this, request === '@learnsdlc/shared' ? SHARED_SOURCE : request, ...rest);
  };
}
