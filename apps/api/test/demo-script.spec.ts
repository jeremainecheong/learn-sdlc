import * as fs from 'fs';
import * as path from 'path';
import { resolveRunMigrations, resolveRunnerMode, resolveSchemaSync } from '../src/config';

/**
 * scripts/demo.sh is the one command a class starts the product with, and the
 * boot rules it depends on live in config.ts, setup.sh and start.sh rather than
 * in the script. Nothing else would notice the two drifting apart: the script
 * has no compiler, and a resolver that changed its mind about a default would
 * make the demo quietly wrong rather than red.
 *
 * So this reads the script as text and asserts the promises it makes about the
 * environment it boots, next to the resolvers that read that environment.
 */
const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Lines with the comments taken out, so a rule is never satisfied by prose about it. */
const code = (source: string): string[] =>
  source
    .split('\n')
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .filter((line) => line.trim() !== '');

describe('the demo command', () => {
  const demo = read('scripts/demo.sh');
  const selftest = read('scripts/demo-selftest.sh');
  const demoCode = code(demo);
  const rootPackage = JSON.parse(read('package.json'));
  const apiPackage = JSON.parse(read('apps/api/package.json'));

  it('is what npm run demo and npm run demo:check run, and both are executable', () => {
    expect(rootPackage.scripts.demo).toBe('bash scripts/demo.sh');
    expect(rootPackage.scripts['demo:check']).toBe('bash scripts/demo-selftest.sh');
    expect(fs.statSync(path.join(ROOT, 'scripts/demo.sh')).mode & 0o111).toBeGreaterThan(0);
    expect(fs.statSync(path.join(ROOT, 'scripts/demo-selftest.sh')).mode & 0o111).toBeGreaterThan(0);
  });

  it('migrates the store rather than letting the schema be inferred', () => {
    expect(demoCode.some((line) => /^\s*export RUN_MIGRATIONS=true\s*$/.test(line))).toBe(true);

    // That is the whole rule: this is what the variable means, and asking for
    // migrations is what turns schema auto-sync off.
    expect(resolveRunMigrations({ RUN_MIGRATIONS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveSchemaSync({ RUN_MIGRATIONS: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('runs the migration step through the API workspace, before anything starts', () => {
    expect(apiPackage.scripts['db:migrate']).toBe('node dist/cli/migrate.js');
    expect(apiPackage.scripts['db:migrate:dev']).toBe('ts-node src/cli/migrate.ts');
    const migrateAt = demo.indexOf('MIGRATE_SCRIPT');
    const startAt = demo.indexOf('bash scripts/start.sh');
    expect(migrateAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(migrateAt);
  });

  it('never widens the bind, and never assigns API_BIND at all', () => {
    for (const line of demoCode) {
      expect(line).not.toMatch(/(^|\s)(export\s+)?API_BIND=/);
    }
    // It refuses one it was handed instead, and names where the answer is.
    expect(demo).toContain('read \\"Hosting a class\\" in the README');
  });

  it('leaves the runner and the secret to the scripts that own them', () => {
    for (const line of demoCode) {
      // RUNNER_MODE unset resolves to the socket runner, which start.sh
      // starts. Setting it to local here would run learner code as a child of
      // the API, sharing its uid and its environment.
      expect(line).not.toMatch(/(^|\s)(export\s+)?RUNNER_MODE=/);
      // A demo JWT secret in a script is a published secret everywhere.
      expect(line).not.toMatch(/(^|\s)(export\s+)?JWT_SECRET=/);
    }
    expect(resolveRunnerMode({} as NodeJS.ProcessEnv)).toBe('socket');
  });

  it('delegates to setup.sh and start.sh rather than doing their work again', () => {
    expect(demo).toContain('bash scripts/setup.sh');
    expect(demo).toContain('bash scripts/start.sh');
    // start.sh owns the runner lifecycle, the loopback refusal, the demo
    // accounts and the mail capture file; a second npm run start here would be
    // a second answer to "what stops the runner".
    for (const line of demoCode) {
      expect(line).not.toMatch(/npm run\s+(start|dev)\b/);
    }
  });

  it('takes its two ports from WEB_PORT and API_PORT, defaulting to 3000 and 4000', () => {
    for (const script of [demo, selftest, read('scripts/start.sh')]) {
      expect(script).toMatch(/WEB_PORT="\$\{WEB_PORT:-3000\}"/);
      expect(script).toMatch(/API_PORT="?\$\{API_PORT:-4000\}"?/);
    }
    // The browser bundle's API address is baked in at build time, so the web
    // build has to be told the same port the API is about to answer on.
    expect(demo).toContain('export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-$API_URL}"');
    expect(demo).toContain('export WEB_ORIGIN="${WEB_ORIGIN:-$WEB_URL}"');
  });

  it('takes the servers down however it ends, not only on ctrl+c', () => {
    // Without it, a --class run whose seed stops on a rate limit ends the
    // script under set -e with the API, the web server and the runner still
    // up, holding both ports with nothing watching them. The EXIT trap is what
    // makes every way out of this script the same way out.
    expect(demo).toContain('trap cleanup_on_exit EXIT');
    expect(demo).toContain('trap stop INT TERM');
    // and the class seed is a warning rather than the end of the demo
    expect(demo).toMatch(/if ! API_URL="\$API_URL\/api\/v1" npm run --silent seed:class; then/);
  });

  it('checks that ctrl+c left nothing running', () => {
    // The failure this guards against is signalling the pid rather than the
    // process group: next start survives it and holds the web port.
    expect(selftest).toContain('kill -INT -"$DEMO_PID"');
    expect(selftest).toContain('is still held after the interrupt');
    expect(selftest).toContain('the sandbox runner is still answering');
  });

  it('runs against scratch data, so a check never touches a class\'s database', () => {
    expect(selftest).toMatch(/export DB_PATH="\$SCRATCH\//);
    expect(selftest).toMatch(/export MAIL_CAPTURE_FILE="\$SCRATCH\//);
    expect(selftest).toMatch(/export RUNNER_SOCKET=/);
    expect(selftest).toContain('rm -rf "$SCRATCH"');
  });
});
