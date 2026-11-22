import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Every command line tool under cli/ answers an unexpected failure (a throw
 * that escaped its main) with one exit code of its own, 70, apart from each
 * tool's documented outcomes, so a script can tell a crash from an answer.
 */
const CLI_CRASH_EXIT = 70;
const API_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Runs one tool from source against a store that cannot be opened: DB_PATH
 * names a directory, so the first database call inside main throws.
 */
function runAgainstUnopenableStore(script: string, args: string[]): { status: number | null; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-crash-'));
  try {
    const out = spawnSync(process.execPath, ['-r', 'ts-node/register', path.join('src', 'cli', script), ...args], {
      cwd: API_ROOT,
      env: { ...process.env, DB_PATH: directory, DATABASE_URL: '', TS_NODE_TRANSPILE_ONLY: 'true' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: out.status, stderr: out.stderr };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('the exit code for an unexpected failure', () => {
  it('runCli prints the message and exits 70 when main throws, and passes a returned code through', async () => {
    const { runCli } = await import('./run');
    const exits: number[] = [];
    const lines: unknown[] = [];
    const exit = (code: number) => {
      exits.push(code);
    };
    await runCli(async () => 2, exit, (line) => lines.push(line));
    await runCli(async () => {
      throw new Error('the store is on fire');
    }, exit, (line) => lines.push(line));
    expect(exits).toEqual([2, CLI_CRASH_EXIT]);
    expect(lines).toEqual(['the store is on fire']);
  });

  it.each([
    { script: 'set-password.ts', args: ['someone@example.com', 'Correct-Horse-9'], documented: 'no such account' },
    { script: 'import-pack.ts', args: ['--pack', '../../content/tasktrackr'], documented: 'bad usage' },
  ])('$script exits 70, not the code it documents as $documented', ({ script, args }) => {
    const result = runAgainstUnopenableStore(script, args);
    expect(result.stderr).toContain('unable to open database file');
    expect(result.status).toBe(CLI_CRASH_EXIT);
  });
});
