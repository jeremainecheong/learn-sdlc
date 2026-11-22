import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpendGuard } from './budget';
import type { CorpusCase, EvalModel } from './contracts';
import { deriveAll, derivedPath, derivePlan } from './derive';
import { Ledger, unitId } from './ledger';
import { candidateLane, type RunCtx } from './runner';
import { starterFixtureState, STARTER_FIXTURE, STARTER_STATE_FILE } from './world';

/*
 * What keeps a run's inputs fixed: derive never
 * overwrites the frozen derived inputs without --force; a unit that started
 * twice and never finished is failed and never retried; the Shelf starter
 * fixture a run composes against is identified by digest and state.
 */
const kase = (id: string, jobType = 'mentor-turn'): CorpusCase => ({ id, jobType, schemaVersion: 1, source: {}, input: {}, reference: { status: 'labelled' }, tags: { project: 'p' } } as never);

describe('derive and the frozen corpus-derived/ folder', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-derive-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('plans only the missing files, and counts the frozen ones it will not touch', () => {
    const a = kase('a'); const b = kase('b'); const other = kase('x', 'interview-turn');
    fs.mkdirSync(path.dirname(derivedPath(root, a)), { recursive: true });
    fs.writeFileSync(derivedPath(root, a), '{"frozen":true}\n');
    expect(derivePlan(root, [a, b, other])).toEqual({ todo: [b], frozen: 1 });
    expect(derivePlan(root, [a, b, other], { force: true })).toEqual({ todo: [a, b], frozen: 0 });
    expect(derivePlan(root, [a, b], { only: ['a'] })).toEqual({ todo: [], frozen: 1 });
  });

  it('refuses to overwrite a frozen file without --force, and runs nothing when nothing is missing', async () => {
    const a = kase('a');
    fs.mkdirSync(path.dirname(derivedPath(root, a)), { recursive: true });
    fs.writeFileSync(derivedPath(root, a), '{"frozen":true}\n');
    const before = fs.statSync(derivedPath(root, a)).mtimeMs;
    const started = Date.now();
    const summary = await deriveAll(root, [a], path.join(root, 'scratch'));
    expect(summary).toMatchObject({ frozen: 1, mentor: 0, explanation: 0 });
    expect(fs.readFileSync(derivedPath(root, a), 'utf8')).toBe('{"frozen":true}\n');
    expect(fs.statSync(derivedPath(root, a)).mtimeMs).toBe(before);
    // No Seatbelt canary ran (it takes seconds): nothing was owed.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(fs.existsSync(path.join(root, 'scratch'))).toBe(false);
  });
});

describe('ledger resume: a unit that failed twice is not retried', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-twice-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model: EvalModel = {
    key: 'm1', label: 'M', provider: 'bedrock', modelId: 'amazon.nova-micro-v1:0', role: 'candidate', class: 'cloud', licence: '', priceIn: 0.035, priceOut: 0.14,
    maxOutputTokens: 5000, contextTokens: null, hardware: '', access: '', probe: 'ok', additionalModelRequestFields: null, runnable: true, notRunReason: null,
    tier: null, reasoning: { policy: 'none', fields: null, source: 'https://example.invalid/card', note: '' },
  };
  const ctxIn = (): RunCtx => ({ runId: 'r', runDir: dir, root: dir, mode: 'real', stopUsd: 45, models: [model], cases: [], ledger: new Ledger(dir, 'r'), guard: new SpendGuard(45, 0), scratch: dir, salt: 's', capHit: false });

  it('retries an orphan once, then marks a second orphan failed and never calls the model again', async () => {
    const c = kase('c1', 'interview-turn');
    const u = unitId('r', 'candidates', 'm1', 'interview-turn', 'c1');
    const base = { unit: u, stage: 'candidates', model: 'm1', jobType: 'interview-turn', case: 'c1' };
    const first = ctxIn();
    await first.ledger.append({ ...base, event: 'started', costUsd: 0, worstUsd: 0.25 }); // killed mid-unit
    await first.ledger.append({ ...base, event: 'started', costUsd: 0, worstUsd: 0.25 }); // the one retry, killed again
    let calls = 0;
    const deps = { makeProvider: async () => ({}) as never, drive: async () => { calls += 1; throw new Error('must not be called'); } };
    const resumed = ctxIn();
    expect(resumed.ledger.status(u)).toEqual({ done: false, failed: false, attempts: 2 });
    expect(resumed.ledger.spent()).toBeCloseTo(0.5, 9); // both orphans at their worst case
    expect(await candidateLane(resumed, model, [c], 'candidates', deps as never)).toBeNull();
    expect(calls).toBe(0);
    expect(resumed.ledger.status(u).failed).toBe(true);
    expect(resumed.ledger.all().map((l) => l.event)).toEqual(['started', 'started', 'failed']);
    // and on the next resume nothing more is written
    const again = ctxIn();
    expect(await candidateLane(again, model, [c], 'candidates', deps as never)).toBeNull();
    expect(again.ledger.all()).toHaveLength(3);
  });
});

describe('starterFixtureState (which Shelf starter a run composes against)', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-starter-'));
    fs.mkdirSync(path.join(repo, STARTER_FIXTURE, 'phases', '02-design'), { recursive: true });
    fs.writeFileSync(path.join(repo, STARTER_FIXTURE, 'phases', '02-design', 'task.md'), '# Design\n');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('digests paths and bytes, and changes when the design brief changes', () => {
    const a = starterFixtureState(repo);
    expect(a).toMatchObject({ state: 'unknown', files: 1 });
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(repo, STARTER_FIXTURE, 'phases', '02-design', 'task.md'), '# Design, drawn on the board\n');
    expect(starterFixtureState(repo).sha256).not.toBe(a.sha256);
  });

  it('reads the label in the starter state file', () => {
    fs.writeFileSync(path.join(repo, STARTER_STATE_FILE), 'recorded-copy\n');
    expect(starterFixtureState(repo).state).toBe('recorded-copy');
  });
});

describe('every file the harness writes is privacy-scanned (kinds logged, text never printed)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-scan-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('logs the finding kinds of a written record in its run folder, and nothing for a clean one', () => {
    const io = require('./io') as typeof import('./io');
    const run = path.join(root, 'runs', 'dry-x');
    io.writeJson(path.join(run, 'raw', 'm', 'interview-turn', 'c1.json'), { responseText: 'write to someone@example.com', requestSha256: `${'1'.repeat(12)}${'a'.repeat(52)}` });
    io.writeJson(path.join(run, 'raw', 'm', 'interview-turn', 'c2.json'), { responseText: 'a clean answer', costUsd: 0.000012345678 });
    io.appendLine(path.join(run, 'ledger.jsonl'), JSON.stringify({ unit: 'u', costUsd: 0.000012345678 }));
    const log = fs.readFileSync(path.join(run, io.PRIVACY_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ file: path.join('raw', 'm', 'interview-turn', 'c1.json'), kinds: ['email'] });
    expect(JSON.stringify(log)).not.toContain('someone@example.com');
    expect(fs.statSync(path.join(run, io.PRIVACY_LOG)).mode & 0o777).toBe(0o600);
  });
});
