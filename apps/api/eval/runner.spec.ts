import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpendGuard } from './budget';
import { newCall, unitStore, type CallRecord } from './capture';
import type { CorpusCase, EvalModel } from './contracts';
import { Ledger, rawPath, unitId } from './ledger';
import { candidateLane, HARNESS_STOP, TRANSIENT_STOP, type RunCtx } from './runner';
import { resetHarnessFault, setHarnessFault } from './transport/aws';

/*
 * Transient infrastructure failures: a unit whose call failed on the network,
 * a 5xx or exhausted throttling is not scored, not counted as an attempt, and
 * is retried on resume; three in a row stop the lane.
 */
const model: EvalModel = {
  key: 'm1', label: 'M', provider: 'bedrock', modelId: 'amazon.nova-micro-v1:0', role: 'candidate', class: 'cloud', licence: '', priceIn: 0.035, priceOut: 0.14,
  maxOutputTokens: 5000, contextTokens: null, hardware: '', access: '', probe: 'ok', additionalModelRequestFields: null, runnable: true, notRunReason: null,
  tier: null, reasoning: { policy: 'none', fields: null, source: 'https://example.invalid/card', note: '' },
};
const kase = (id: string): CorpusCase => ({ id, jobType: 'interview-turn', schemaVersion: 1, source: {}, input: {}, reference: { status: 'labelled' }, tags: { project: 'p' } } as never);

function ctxIn(dir: string): RunCtx {
  return { runId: 'r', runDir: dir, root: dir, mode: 'real', stopUsd: 45, models: [model], cases: [], ledger: new Ledger(dir, 'r'), guard: new SpendGuard(45, 0), scratch: dir, salt: 's', capHit: false };
}

/** A driver that records one call with the given outcome, as the transports would. */
const driveWith = (outcomes: Array<CallRecord['outcome']>) => {
  let i = 0;
  return async () => {
    const u = unitStore.getStore()!;
    const call = { ...newCall('interview.answer', 1), outcome: outcomes[Math.min(i, outcomes.length - 1)] };
    i += 1;
    u.calls.push(call);
    return { useCase: 'interview', delivered: call.outcome === 'ok', failure: call.outcome === 'ok' ? null : 'provider_error', shortCircuit: null, modelOnly: false };
  };
};
const deps = (outcomes: Array<CallRecord['outcome']>) => ({ makeProvider: async () => ({}) as never, drive: driveWith(outcomes) });

describe('candidateLane and transient failures', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-lane-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('does not mark a transient unit done, writes no raw record, and retries it on resume', async () => {
    const ctx = ctxIn(dir);
    const c = kase('c1');
    expect(await candidateLane(ctx, model, [c], 'candidates', deps(['transport']))).toBeNull();
    const u = unitId('r', 'candidates', 'm1', 'interview-turn', 'c1');
    expect(ctx.ledger.status(u)).toEqual({ done: false, failed: false, attempts: 0 });
    expect(ctx.ledger.all().map((l) => l.event)).toEqual(['started', 'failed:transient']);
    expect(fs.existsSync(rawPath(dir, 'm1', 'interview-turn', 'c1'))).toBe(false);
    // resume
    const again = { ...ctxIn(dir) };
    expect(await candidateLane(again, model, [c], 'candidates', deps(['ok']))).toBeNull();
    expect(again.ledger.status(u).done).toBe(true);
    expect(fs.existsSync(rawPath(dir, 'm1', 'interview-turn', 'c1'))).toBe(true);
  });

  it('scores a model failure (not transient) as done', async () => {
    const ctx = ctxIn(dir);
    await candidateLane(ctx, model, [kase('c1')], 'candidates', deps(['invalid']));
    expect(ctx.ledger.status(unitId('r', 'candidates', 'm1', 'interview-turn', 'c1')).done).toBe(true);
  });

  it('stops the lane after three transient units in a row', async () => {
    const ctx = ctxIn(dir);
    const cases = ['c1', 'c2', 'c3', 'c4', 'c5'].map(kase);
    expect(await candidateLane(ctx, model, cases, 'candidates', deps(['server_error']))).toBe(TRANSIENT_STOP);
    expect(ctx.ledger.all().filter((l) => l.event === 'started')).toHaveLength(3);
    expect(ctx.transientStops).toEqual(['candidates:m1']);
  });

  it('stops every lane on a harness fault (reasoning came back): no raw record, not done, not an attempt', async () => {
    const ctx = ctxIn(dir);
    const faulting = { makeProvider: async () => ({}) as never, drive: async () => { const u = unitStore.getStore()!; u.calls.push({ ...newCall('interview.answer', 1), outcome: 'harness_fault' }); setHarnessFault('reasoning returned by a model whose switch is off'); return { useCase: 'interview', delivered: false, failure: 'provider_error', shortCircuit: null, modelOnly: false }; } };
    try {
      expect(await candidateLane(ctx, model, [kase('c1'), kase('c2')], 'candidates', faulting as never)).toBe(HARNESS_STOP);
      expect(ctx.ledger.all().map((l) => l.event)).toEqual(['started', 'failed:harness']);
      expect(ctx.ledger.status(unitId('r', 'candidates', 'm1', 'interview-turn', 'c1'))).toEqual({ done: false, failed: false, attempts: 0 });
      expect(fs.existsSync(rawPath(dir, 'm1', 'interview-turn', 'c1'))).toBe(false);
      // another lane does not start a unit while the fault stands
      expect(await candidateLane(ctxIn(dir), { ...model, key: 'm2' }, [kase('c3')], 'candidates', deps(['ok']))).toBe(HARNESS_STOP);
    } finally {
      resetHarnessFault();
    }
  });
});
