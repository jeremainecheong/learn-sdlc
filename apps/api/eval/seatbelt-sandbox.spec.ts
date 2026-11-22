import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seatbeltAvailable, seatbeltPreflight, seatbeltProfile } from './seatbelt-sandbox';
import { repoRoot } from './io';

/*
 * The Seatbelt fence for model-written code. An allow-by-default profile
 * would let a job read the user's home (credentials, the checkout's .env) and
 * exec osascript/open, which act outside the sandbox; the preflight names
 * each of those holes.
 */
describe('seatbeltProfile', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sb-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('denies exec except the pinned interpreters and the runner runtime, and denies LaunchServices and Apple Events', () => {
    const p = seatbeltProfile(dir);
    expect(p).toMatch(/\(deny process-exec\)/);
    expect(p).toMatch(/\(allow process-exec \(literal "[^"]*python3\.11"\) \(literal "[^"]*bin\/node"\) \(subpath "[^"]*apps\/api\/runner\/runtime"\)\)/);
    expect(p).toMatch(/\(deny lsopen\)/);
    expect(p).toMatch(/\(deny appleevent-send\)/);
  });

  it('denies reading the home folder except the two toolchains, with the credential denies last', () => {
    const p = seatbeltProfile(dir);
    const lines = p.split('\n');
    const homeDeny = lines.findIndex((l) => l === `(deny file-read-data (subpath ${JSON.stringify(os.homedir())}))`);
    // The two toolchains are whichever Python and Node the harness runs (EVAL_PYTHON, EVAL_NODE_BIN).
    const toolAllow = lines.findIndex((l) => l.startsWith('(allow file-read-data (subpath '));
    const credDeny = lines.findIndex((l) => l.startsWith('(deny file-read*') && l.includes('.aws'));
    expect(homeDeny).toBeGreaterThan(0);
    expect(toolAllow).toBeGreaterThan(homeDeny);
    expect(credDeny).toBeGreaterThan(toolAllow);
  });
});

const maybe = seatbeltAvailable() ? describe : describe.skip;
maybe('seatbeltPreflight (a live canary under sandbox-exec)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sbp-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passes with the real profile: home unreadable, osascript/open refused, network refused, python and node run', async () => {
    const result = await seatbeltPreflight(dir, { fresh: true });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.checks).sort()).toEqual(['childNodeRuns', 'homeRead', 'netConnect', 'nodeRuns', 'openExec', 'osascriptExec', 'pythonRuns', 'realTreeRead']);
  }, 60_000);

  it('fails, naming each hole, under an allow-by-default profile', async () => {
    const weak = (jobDir: string) => ['(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)', `(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(jobDir))}))`].join('\n');
    const result = await seatbeltPreflight(dir, { fresh: true, profile: weak });
    expect(result.ok).toBe(false);
    // realTreeRead can only be caught where the checkout has a .env to read.
    const holes = ['homeRead', 'osascriptExec', 'openExec', ...(fs.existsSync(path.join(repoRoot(), '.env')) ? ['realTreeRead'] : [])];
    expect(result.failures).toEqual(expect.arrayContaining(holes));
  }, 60_000);
});
