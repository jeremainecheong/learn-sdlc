import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Ledger, unitId } from './ledger';

/* Resume semantics of the run log. */
describe('Ledger', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ledger-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const base = { stage: 'candidates', model: 'm', jobType: 'review-design', case: 'c1' };

  it('marks done units, and survives a reopen', async () => {
    const l = new Ledger(dir, 'r');
    const u = unitId('r', 'candidates', 'm', 'review-design', 'c1');
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'done', costUsd: 0.1 });
    const again = new Ledger(dir, 'r');
    expect(again.status(u)).toEqual({ done: true, failed: false, attempts: 1 });
    expect(again.spent()).toBeCloseTo(0.1, 9);
  });

  it('counts an orphaned start at its worst case and allows exactly one retry', async () => {
    const l = new Ledger(dir, 'r');
    const u = unitId('r', 'candidates', 'm', 'review-design', 'c1');
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    expect(l.spent()).toBeCloseTo(0.5, 9);
    expect(l.status(u).attempts).toBe(1);
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    expect(l.status(u).attempts).toBe(2);
    expect(l.spent()).toBeCloseTo(1.0, 9);
  });

  it('does not count a budget stop or an expired login as an attempt', async () => {
    const l = new Ledger(dir, 'r');
    const u = unitId('r', 'candidates', 'm', 'review-design', 'c1');
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'stopped_at_cap', costUsd: 0.02 });
    expect(l.status(u)).toEqual({ done: false, failed: false, attempts: 0 });
    expect(l.spent()).toBeCloseTo(0.02, 9);
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'failed:credentials', costUsd: 0 });
    expect(l.status(u).attempts).toBe(0);
  });

  it('does not count a transient failure or a runtime cut as an attempt', async () => {
    const l = new Ledger(dir, 'r');
    const u = unitId('r', 'candidates', 'm', 'review-design', 'c1');
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'failed:transient', costUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'started', costUsd: 0, worstUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'failed:transient', costUsd: 0.5 });
    await l.append({ ...base, unit: u, event: 'cut_at_runtime', costUsd: 0 });
    expect(l.status(u)).toEqual({ done: false, failed: false, attempts: 0 });
    expect(l.spent()).toBeCloseTo(1.0, 9);
    expect(l.byStage().candidates.transient).toBe(2);
    expect(l.byStage().candidates.cutAtRuntime).toBe(1);
  });

  it('ignores a torn last line from a crash', () => {
    fs.writeFileSync(path.join(dir, 'ledger.jsonl'), '{"unit":"x","event":"done","costUsd":0.1}\n{"unit":"y","ev');
    const l = new Ledger(dir, 'r');
    expect(l.all()).toHaveLength(1);
  });
});
