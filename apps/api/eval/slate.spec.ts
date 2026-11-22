import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertReasoningOffFields } from './provider/bedrock-settings';
import { SpendGuard } from './budget';
import { loadModels, REASONING_SWITCHES, type EvalModel } from './contracts';
import { writeJson } from './io';
import { Ledger, rawPath } from './ledger';
import { buildJudgeUnits, DEFAULT_JUDGE_PLAN, judgesOf, primaryJudgeFor } from './judge/judge';
import { TIER, tierOf } from './judge/tiers';
import { judgeReliability, scorecards, type JudgeRecord } from './report/analysis';
import type { RunCtx } from './runner';

/*
 * How the slate is read:
 *  - the candidate set and the judge set come from models.json `slate`;
 *  - three small judges (A gpt-oss-120b, B Qwen3 32B, C Nova Lite), all also
 *    candidates, so a judge never scores or compares its own outputs;
 *  - a documented reasoning switch per Bedrock model.
 */

// These read a real evaluation folder's models.json; without EVAL_ROOT they are skipped.
const EVAL_ROOT = process.env.EVAL_ROOT ?? '';
const describeWithSlate = EVAL_ROOT ? describe : describe.skip;
const slate = () => (EVAL_ROOT ? loadModels(EVAL_ROOT) : { models: [], dropped: [], digest: '' });

describeWithSlate('loadModels reads the slate from models.json', () => {
  const { models, dropped } = slate();
  const keys = models.map((m) => m.key).sort();

  it('takes the 10 candidates and the reference, nothing else', () => {
    expect(keys).toEqual([
      'gpt-oss-120b', 'gpt-oss-20b', 'gpt56-luna', 'llama4-scout', 'ministral-3-14b', 'ministral-3-8b',
      'nova-2-lite', 'nova-lite', 'nova-micro', 'qwen3-32b', 'qwen3-coder-30b',
    ]);
    expect(models.filter((m) => m.role === 'candidate')).toHaveLength(10);
    expect(models.filter((m) => m.role === 'reference').map((m) => m.key)).toEqual(['gpt56-luna']);
    for (const gone of ['Mistral Large 3 (675B MoE)', 'DeepSeek-V3.2', 'Llama 4 Maverick 17B-128E Instruct', 'Llama 3.3 70B Instruct', 'Qwen3 Next 80B-A3B Instruct', 'Amazon Nova Pro', 'Qwen3 VL 235B-A22B Instruct', 'Claude Haiku 4.5']) {
      expect(dropped).toContain(gone);
    }
  });

  it('names the three judges from the slate: A gpt-oss-120b, B Qwen3 32B, C Nova Lite, each also a candidate', () => {
    const judges = judgesOf(models);
    expect(judges.map((j) => [j.judgeSlot, j.key])).toEqual([['A', 'gpt-oss-120b'], ['B', 'qwen3-32b'], ['C', 'nova-lite']]);
    for (const j of judges) expect(j.role).toBe('candidate');
  });

  it('tiers the on-prem candidates by the hardware they take (one GPU)', () => {
    const tier = (k: string) => models.find((m) => m.key === k)!.tier;
    expect(['ministral-3-8b', 'ministral-3-14b', 'gpt-oss-20b'].map(tier)).toEqual([1, 1, 1]);
    expect(['qwen3-coder-30b', 'qwen3-32b', 'gpt-oss-120b', 'llama4-scout'].map(tier)).toEqual([2, 2, 2, 2]);
    expect(['nova-micro', 'nova-lite', 'nova-2-lite', 'gpt56-luna'].map(tier)).toEqual([null, null, null, null]);
    expect(models.filter((m) => m.class === 'onprem').map((m) => m.key).sort()).toEqual(['gpt-oss-120b', 'gpt-oss-20b', 'llama4-scout', 'ministral-3-14b', 'ministral-3-8b', 'qwen3-32b', 'qwen3-coder-30b']);
  });

  it('sends the documented reasoning switch per model, and only allow-listed fields', () => {
    const r = (k: string) => models.find((m) => m.key === k)!.reasoning;
    expect(r('qwen3-32b')).toMatchObject({ policy: 'off', fields: { enable_thinking: false } });
    expect(r('nova-2-lite')).toMatchObject({ policy: 'off', fields: { reasoningConfig: { type: 'disabled' } } });
    expect(r('gpt-oss-120b')).toMatchObject({ policy: 'minimum', fields: { reasoning_effort: 'low' } });
    expect(r('gpt-oss-20b')).toMatchObject({ policy: 'minimum', fields: { reasoning_effort: 'low' } });
    for (const k of ['ministral-3-8b', 'ministral-3-14b', 'qwen3-coder-30b', 'llama4-scout', 'nova-micro', 'nova-lite']) expect(r(k)).toMatchObject({ policy: 'none', fields: null });
    for (const m of models) {
      expect(m.additionalModelRequestFields).toEqual(m.reasoning.fields);
      if (m.reasoning.fields) expect(() => assertReasoningOffFields(m.reasoning.fields!)).not.toThrow();
      expect(m.reasoning.source).toMatch(/^https:\/\//);
    }
  });
});

describeWithSlate('loadModels refuses a slate it cannot honour', () => {
  let dir: string;
  const real = (EVAL_ROOT ? JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, 'models.json'), 'utf8')) : []) as Array<Record<string, any>>;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-slate-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const withRows = (rows: unknown) => { fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(rows)); return dir; };

  it('drops a row moved out of the slate', () => {
    const rows = real.map((r) => (r.family === 'Ministral 3 8B' ? { ...r, slate: 'dropped-for-size' } : r));
    expect(loadModels(withRows(rows)).models.map((m) => m.key)).not.toContain('ministral-3-8b');
  });
  it('refuses a judge row that names no slot, or two judges in one slot', () => {
    const noSlot = real.map((r) => (r.family === 'Amazon Nova Lite' ? { ...r, slateNote: 'cloud small' } : r));
    expect(() => loadModels(withRows(noSlot))).toThrow(/judge slot/);
    const twice = real.map((r) => (r.family === 'Amazon Nova Lite' ? { ...r, slateNote: 'ALSO judge A' } : r));
    expect(() => loadModels(withRows(twice))).toThrow(/judge slot/);
  });
  it('refuses a slate row whose reasoning switch was never verified', () => {
    const rows = real.map((r) => (r.family === 'Mixtral 8x7B Instruct' ? { ...r, slate: 'candidate' } : r));
    expect(() => loadModels(withRows(rows))).toThrow(/reasoning switch/);
  });
  it('keeps every switch in the registry inside the product allow-list', () => {
    for (const s of Object.values(REASONING_SWITCHES)) if (s.fields) expect(() => assertReasoningOffFields(s.fields!)).not.toThrow();
  });
});

describeWithSlate('judge units: a judge never scores or compares its own outputs', () => {
  let dir: string;
  const { models } = slate();
  const cases = [
    { id: 'i1', jobType: 'interview-turn' }, { id: 'm1', jobType: 'mentor-turn' }, { id: 'r1', jobType: 'review-design' },
    { id: 'p1', jobType: 'agentic-proposal' }, { id: 'e1', jobType: 'explanation-assessment' },
  ].map((c) => ({ ...c, schemaVersion: 1, source: {}, input: {}, reference: {}, tags: { project: 'p' } })) as never[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-judge-'));
    for (const m of models) for (const c of cases as Array<{ id: string; jobType: string }>) writeJson(rawPath(dir, m.key, c.jobType, c.id), { calls: [] });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = (): RunCtx => ({ runId: 'r', runDir: dir, root: dir, mode: 'stub', stopUsd: 45, models, cases, ledger: new Ledger(dir, 'r'), guard: new SpendGuard(45, 0), scratch: dir, salt: 's', capHit: false });

  it('builds no unit whose judge is the model under test, and counts what it excluded', () => {
    const { units, selfExcluded } = buildJudgeUnits(ctx(), DEFAULT_JUDGE_PLAN, judgesOf(models));
    expect(units.length).toBeGreaterThan(0);
    expect(units.filter((u) => u.judge.key === u.model.key)).toEqual([]);
    // absolute: every non-self judge on every judged case; 3 judge-models × 5 cases excluded once each
    const abs = units.filter((u) => u.kind === 'absolute');
    expect(abs).toHaveLength(5 * (11 * 3 - 3));
    expect(selfExcluded['gpt-oss-120b'].absolute).toBe(5);
    expect(selfExcluded['qwen3-32b'].absolute).toBe(5);
    expect(selfExcluded['nova-lite'].absolute).toBe(5);
    // pairwise: every candidate but the reference, by each non-self judge
    const pw = units.filter((u) => u.kind === 'pairwise');
    expect(pw).toHaveLength(5 * (10 * 3 - 3));
    expect(selfExcluded['gpt-oss-120b'].pairwise).toBe(5);
    expect(units.filter((u) => u.kind === 'rejudge').every((u) => u.judge.key !== u.model.key)).toBe(true);
  });

  it('gives each model a primary judge that is not itself: judge A, or judge B for judge A\'s own outputs', () => {
    const judges = judgesOf(models);
    const by = (k: string) => models.find((m) => m.key === k)!;
    expect(primaryJudgeFor(by('nova-micro'), judges)!.key).toBe('gpt-oss-120b');
    expect(primaryJudgeFor(by('gpt-oss-120b'), judges)!.key).toBe('qwen3-32b');
    expect(primaryJudgeFor(by('qwen3-32b'), judges)!.key).toBe('gpt-oss-120b');
    const { units } = buildJudgeUnits(ctx(), DEFAULT_JUDGE_PLAN, judges);
    const primaryOf = (k: string) => units.filter((u) => u.kind === 'absolute' && u.model.key === k && u.primary).map((u) => u.judge.key);
    expect([...new Set(primaryOf('gpt-oss-120b'))]).toEqual(['qwen3-32b']);
    expect([...new Set(primaryOf('nova-lite'))]).toEqual(['gpt-oss-120b']);
  });

  it('keeps the protected tier for each model\'s primary judge on chat and explanation', () => {
    const { units } = buildJudgeUnits(ctx(), DEFAULT_JUDGE_PLAN, judgesOf(models));
    const u = units.find((x) => x.kind === 'absolute' && x.model.key === 'gpt-oss-120b' && x.c.id === 'm1' && x.primary)!;
    expect(tierOf(u)).toBe(TIER.protectedChat);
    const sec = units.find((x) => x.kind === 'absolute' && x.model.key === 'nova-micro' && x.c.id === 'm1' && !x.primary)!;
    expect(tierOf(sec)).toBe(TIER.secondary);
  });
});

describeWithSlate('scores: a cell is the mean of the judges that are not the model under test', () => {
  const m = (key: string, slot?: 'A' | 'B' | 'C') => ({ key, role: 'candidate', judgeSlot: slot, class: 'cloud' }) as unknown as EvalModel;
  const models = [m('ja', 'A'), m('jb', 'B'), m('jc', 'C'), m('x')];
  const unit = (modelKey: string) => ({ modelKey, useCase: 'mentor', caseId: 'c1', jobType: 'mentor-turn', delivered: true, m: {}, outcomes: {}, failures: {}, costUsd: 0, calls: 1, jsonCalls: 0 }) as never;
  const rec = (judge: string, slot: 'A' | 'B' | 'C', modelKey: string, score: number, kind: JudgeRecord['kind'] = 'absolute'): JudgeRecord => ({
    judge, judgeSlot: slot, kind, modelKey, caseId: 'c1', jobType: 'mentor-turn', useCase: 'mentor', failure: null, costUsd: 0,
    result: { scores: { tone: { score, justification: 'x' }, actionability: { score, justification: 'x' } } },
  });

  it('averages the non-self judges and ignores (and counts) a self-judgement if one ever appears', () => {
    const judgements = [rec('ja', 'A', 'x', 5), rec('jb', 'B', 'x', 3), rec('jc', 'C', 'x', 1), rec('jb', 'B', 'ja', 4), rec('jc', 'C', 'ja', 2), rec('ja', 'A', 'ja', 5)];
    const cards = scorecards([unit('x'), unit('ja')], judgements, models);
    const x = cards.find((c) => c.modelKey === 'x')!;
    expect(x.judgeMean).toBeCloseTo(3, 9);
    expect(x.judgeBy).toEqual({ A: 5, B: 3, C: 1 });
    const ja = cards.find((c) => c.modelKey === 'ja')!;
    expect(ja.judgeMean).toBeCloseTo(3, 9);
    expect(ja.judgeBy.A).toBeNull();
    expect(ja.selfJudgedIgnored).toBe(1);
  });

  it('reports pairwise inter-judge kappa for every pair of judges, and self-consistency per judge', () => {
    const judgements = [rec('ja', 'A', 'x', 5), rec('jb', 'B', 'x', 5), rec('jc', 'C', 'x', 1), rec('ja', 'A', 'x', 5, 'rejudge')];
    const rel = judgeReliability(judgements);
    expect(Object.keys(rel.interJudge).sort()).toEqual(['A-B', 'A-C', 'B-C']);
    expect(rel.interJudge['A-B'].pairs).toBe(2);
    expect(rel.interJudge['A-B'].meanAbsDiff).toBe(0);
    expect(rel.interJudge['A-C'].meanAbsDiff).toBe(4);
    expect(rel.selfConsistency.A.pairs).toBe(2);
    expect(rel.flaggedOver1).toContain('x|c1');
  });
});
