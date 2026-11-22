import { resolve } from 'path';
import { repoPath } from './paths';

/**
 * The one door from a web test to the API's test fixtures.
 *
 * The contract wiring tests replay what the API answered
 * (`apps/api/test/fixtures/contract-exchanges/*.json`) and rebuild the bytes the API
 * was sent (`contract-exchanges/archives.ts`, `contract-exchanges/sealed-files.ts`,
 * `upload-packs/markers.ts`). Those have to stay the API's own files: a copy
 * here could drift from the recording and the wiring test would still pass.
 *
 * They are loaded at run time, never with an `import ... from` the type
 * checker follows: a static import would have the web's type check
 * (tsconfig.test.json) compile the API's fixture sources under the web's
 * compiler options. The tests type check against the shapes declared in
 * `contract-fixture-types.ts` instead.
 */
export const API_TEST_FIXTURES = repoPath('apps/api/test/fixtures');

/** Load one of the API's fixture modules (path relative to `apps/api/test/fixtures`). */
export function loadApiFixture<T>(relative: string): Promise<T> {
  return import(/* @vite-ignore */ resolve(API_TEST_FIXTURES, relative)) as Promise<T>;
}
