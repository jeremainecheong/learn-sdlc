import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pilotGuard, SpendGuard } from './budget';
import { loadModels } from './contracts';
import { writeJson } from './io';
import { Ledger, rawPath } from './ledger';
import { buildJudgeUnits, judgesOf, PILOT_JUDGE_PLAN } from './judge/judge';
import type { RunCtx } from './runner';

/*
 * The pilot: 3 cases per job type × every slate candidate and the reference;
 * judge A on every pilot cell (judge B for judge A's own outputs), the
 * secondary judges on about half, 10 pairwise cells; all under a pilot cap
 * (US$6 by default) that sits inside the spend stop.
 */

// These read a real evaluation folder's models.json; without EVAL_ROOT they are skipped.
const EVAL_ROOT = process.env.EVAL_ROOT ?? '';
const describeWithSlate = EVAL_ROOT ? describe : describe.skip;
const slate = () => (EVAL_ROOT ? loadModels(EVAL_ROOT) : { models: [], dropped: [], digest: '' });

describeWithSlate('the pilot judge plan', () => {
  let dir: string;
  const { models } = slate();
  const jobs = ['interview-turn', 'mentor-turn', 'review-design', 'agentic-proposal', 'explanation-assessment'];
  const cases = jobs.flatMap((j) => [1, 2, 3].map((n) => ({ id: `${j}-${n}`, jobType: j })))
    .map((c) => ({ ...c, schemaVersion: 1, source: {}, input: {}, reference: {}, tags: { project: 'p' } })) as never[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-pilot-'));
    for (const m of models) for (const c of cases as Array<{ id: string; jobType: string }>) writeJson(rawPath(dir, m.key, c.jobType, c.id), { calls: [] });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = (): RunCtx => ({ runId: 'r', runDir: dir, root: dir, mode: 'stub', stopUsd: 45, models, cases, ledger: new Ledger(dir, 'r'), guard: new SpendGuard(45, 0), scratch: dir, salt: 's', capHit: false });

  it('puts the primary judge on every cell, and no judge on its own outputs', () => {
    const { units } = buildJudgeUnits(ctx(), PILOT_JUDGE_PLAN, judgesOf(models));
    expect(units.filter((u) => u.judge.key === u.model.key)).toEqual([]);
    const primary = units.filter((u) => u.kind === 'absolute' && u.primary);
    expect(primary).toHaveLength(cases.length * 11);
  });

  it('runs the secondary judges on about half of the cases, the same cases for every model', () => {
    const { units } = buildJudgeUnits(ctx(), PILOT_JUDGE_PLAN, judgesOf(models));
    const secCases = new Set(units.filter((u) => u.kind === 'absolute' && !u.primary && u.judge.judgeSlot === 'B').map((u) => u.c.id));
    expect(secCases.size).toBeGreaterThanOrEqual(5);
    expect(secCases.size).toBeLessThanOrEqual(10);
    const forNovaMicro = new Set(units.filter((u) => u.kind === 'absolute' && !u.primary && u.model.key === 'nova-micro' && u.judge.judgeSlot === 'C').map((u) => u.c.id));
    expect([...forNovaMicro].sort()).toEqual([...secCases].sort());
  });

  it('compares exactly 10 cells against the reference, spread over job types and models, by every non-self judge', () => {
    const { units, selfExcluded } = buildJudgeUnits(ctx(), PILOT_JUDGE_PLAN, judgesOf(models));
    const pw = units.filter((u) => u.kind === 'pairwise');
    const cells = new Set(pw.map((u) => `${u.model.key}|${u.c.id}`));
    expect(cells.size).toBe(10);
    expect(pw.some((u) => u.model.role === 'reference')).toBe(false);
    expect(new Set(pw.map((u) => u.c.jobType)).size).toBe(jobs.length);
    expect(new Set(pw.map((u) => u.model.key)).size).toBe(10);
    // each cell by every judge that is not the model; a judge-model's cell has 2 judges, every other cell 3
    const judgeModelCells = [...cells].filter((c) => ['gpt-oss-120b', 'qwen3-32b', 'nova-lite'].includes(c.split('|')[0])).length;
    expect(pw).toHaveLength(3 * 10 - judgeModelCells);
    const excluded = Object.values(selfExcluded).reduce((s, v) => s + v.pairwise, 0);
    expect(excluded).toBe(judgeModelCells);
    expect(units.filter((u) => u.kind === 'rejudge')).toEqual([]);
  });
});

describe('the pilot cap', () => {
  it('stops the pilot at US$6 above what other runs spent, never above the US$45 stop', () => {
    const g = pilotGuard({ stopUsd: 45, spentElsewhere: 0.5, spentThisRun: 1.25, pilotCapUsd: 6 });
    expect(g.cap).toBeCloseTo(6.5, 10);
    expect(g.committed).toBeCloseTo(1.75, 10);
    expect(g.admits(4.75)).toBe(true);
    expect(g.admits(4.76)).toBe(false);
    expect(pilotGuard({ stopUsd: 45, spentElsewhere: 42, spentThisRun: 0, pilotCapUsd: 6 }).cap).toBe(45);
    expect(() => pilotGuard({ stopUsd: 45, spentElsewhere: 0, spentThisRun: 0, pilotCapUsd: 0 })).toThrow();
  });
});

describeWithSlate('the pilot estimate', () => {
  it('prices pairwise on the pilot cells only, not on every model × case', () => {
    const { estimate } = require('./plan') as typeof import('./plan');
    const { models } = slate();
    const sizes = Array.from({ length: 30 }, (_, i) => ({ caseId: `c${i}`, jobType: 'mentor-turn', judged: true, calls: [{ label: 'guided.draft', requestBytes: 3500, maxTokens: 900 }], judgeBytes: 7000, outputBytes: 1400 }));
    const full = estimate(models, sizes, { ...PILOT_JUDGE_PLAN, pairwiseCells: undefined, pairwiseCases: 30 }).est.pairwise;
    const pilot = estimate(models, sizes, PILOT_JUDGE_PLAN).est.pairwise;
    expect(pilot).toBeGreaterThan(0);
    // 10 cells of 30 cases × 10 non-reference models
    expect(pilot / full).toBeCloseTo(10 / 300, 6);
  });
});
