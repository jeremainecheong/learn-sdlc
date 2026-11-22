/**
 * The warm-up's own check.
 *
 * Locked, like every check in this project: the exercise is to change the code
 * until the check passes, never to change the check until the code passes.
 *
 * `test` and `assert` are globals the runner provides, and the import has no
 * file extension — the compiled file is what node loads.
 */

import { greeting } from './greeting';

test('the greeting says hello', () => {
  assert.strictEqual(greeting(), 'hello');
});
