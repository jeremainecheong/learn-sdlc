import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { costOf, tokensFromBytes } from './budget';
import { REFERENCE_KEY, type EvalModel } from './contracts';
import { calibrationFrom, estimate, expectedOut, MARGIN, writePlan, type PlannedCase } from './plan';
import { DEFAULT_JUDGE_PLAN } from './judge/judge';

/*
 * The estimator the plan uses: expectedOut, estimate() and writePlan().
 */
const row = (key: string, over: Partial<EvalModel> = {}): EvalModel => ({
  key, label: key, provider: 'bedrock', modelId: `x.${key}`, role: 'candidate', class: 'onprem', licence: '', priceIn: 1, priceOut: 2,
  maxOutputTokens: 4096, contextTokens: null, hardware: '', access: '', probe: 'ok', additionalModelRequestFields: null, runnable: true, notRunReason: null, tier: null, reasoning: { policy: 'none', fields: null, source: 'https://example.invalid', note: '' }, ...over,
});
const cand = row('cand');
const reasoner = row('gpt-oss-20b', { reasoning: { policy: 'minimum', fields: { reasoning_effort: 'low' }, source: 'https://example.invalid', note: '' } });
const ref = row(REFERENCE_KEY, { role: 'reference', provider: 'openai', class: 'cloud' });
const off = row('off', { runnable: false });
// The judges are candidates too: they are judged, never by themselves.
const A = row('ja', { judgeSlot: 'A', priceIn: 0.8, priceOut: 3.2 });
const B = row('jb', { judgeSlot: 'B', priceIn: 0.5, priceOut: 2.5 });

describe('expectedOut', () => {
  it('uses the label expectation, clamped to the product maxTokens and to the model maximum', () => {
    expect(expectedOut(cand, 'agentic.generate', 9000, {})).toBe(2500);
    expect(expectedOut(cand, 'agentic.generate', 1000, {})).toBe(1000);
    expect(expectedOut(row('small', { maxOutputTokens: 800 }), 'agentic.generate', 9000, {})).toBe(800);
    expect(expectedOut(cand, 'no.such.label', 9000, {})).toBe(500);
  });
  it('triples it for models that reason, still clamped', () => {
    expect(expectedOut(reasoner, 'interview.answer', 2200, {})).toBe(360);
    expect(expectedOut(reasoner, 'agentic.generate', 9000, {})).toBe(4096);
  });
  it('prefers a calibrated p90, clamped too', () => {
    expect(expectedOut(reasoner, 'interview.answer', 2200, { 'gpt-oss-20b': { 'interview.answer': 90 } })).toBe(90);
    expect(expectedOut(cand, 'interview.answer', 220, { cand: { 'interview.answer': 5000 } })).toBe(220);
  });
});

describe('estimate', () => {
  const sizes: PlannedCase[] = [
    { caseId: 'i1', jobType: 'interview-turn', judged: true, calls: [{ label: 'interview.answer', requestBytes: 3500, maxTokens: 220 }], judgeBytes: 7000, outputBytes: 700 },
    { caseId: 'm1', jobType: 'mentor-turn', judged: true, calls: [{ label: 'guided.draft', requestBytes: 7000, maxTokens: 400 }], judgeBytes: 7000, outputBytes: 700 },
    { caseId: 'e1', jobType: 'explanation-assessment', judged: true, calls: [{ label: 'agentic.explanation', requestBytes: 3500, maxTokens: 4500 }], judgeBytes: 3500, outputBytes: 350 },
    { caseId: 'r1', jobType: 'review-design', judged: true, calls: [{ label: 'grading.review', requestBytes: 35_000, maxTokens: 4000 }], judgeBytes: 14_000, outputBytes: 1400 },
    { caseId: 'p1', jobType: 'agentic-proposal', judged: true, calls: [{ label: 'agentic.classify', requestBytes: 3500, maxTokens: 3000 }], judgeBytes: 3500, outputBytes: 350 },
    { caseId: 'x1', jobType: 'interview-turn', judged: false, calls: [{ label: 'interview.review', requestBytes: 3500, maxTokens: 2200 }], judgeBytes: 3500, outputBytes: 350 },
  ];
  const models = [cand, reasoner, ref, off, A, B];

  it('prices the candidates with the margin, per runnable model only', () => {
    const { perModel, est } = estimate(models, sizes, DEFAULT_JUDGE_PLAN);
    expect(Object.keys(perModel).sort()).toEqual(['cand', 'gpt-oss-20b', 'gpt56-luna', 'ja', 'jb']);
    const tin = sizes.reduce((s, x) => s + x.calls.reduce((a, c) => a + tokensFromBytes(c.requestBytes), 0), 0);
    const tout = sizes.reduce((s, x) => s + x.calls.reduce((a, c) => a + expectedOut(cand, c.label, c.maxTokens, {}), 0), 0);
    expect(perModel.cand.usd).toBeCloseTo(costOf(cand, tin, tout) * MARGIN, 9);
    expect(est.candidates).toBeCloseTo(Object.values(perModel).reduce((s, v) => s + v.usd, 0), 9);
  });

  it('buckets each model\'s primary judge by use-case and prices the other non-self judges as secondary, with the margin', () => {
    const { est } = estimate(models, sizes, DEFAULT_JUDGE_PLAN);
    const ca = (bytes: number) => costOf(A, tokensFromBytes(bytes), 450) * MARGIN;
    const cb = (bytes: number) => costOf(B, tokensFromBytes(bytes), 450) * MARGIN;
    // primary: A for cand, gpt-oss-20b, the reference and B; B for A's own outputs
    const p = (bytes: number) => 4 * ca(bytes) + cb(bytes);
    expect(est.primary.chat).toBeCloseTo(p(7000) + p(7000), 9);
    expect(est.primary.explanation).toBeCloseTo(p(3500), 9);
    expect(est.primary.review).toBeCloseTo(p(14_000), 9);
    expect(est.primary.proposal).toBeCloseTo(p(3500), 9);
    // secondary: B for cand, gpt-oss-20b and the reference; A and B have no third judge here
    const s = (bytes: number) => 3 * cb(bytes);
    expect(est.secondary).toBeCloseTo(s(7000) * 2 + s(3500) * 2 + s(14_000), 9);
    expect(est.rejudge).toBeCloseTo((est.primary.chat + est.primary.explanation + est.primary.review + est.primary.proposal + est.secondary) * 0.1, 9);
  });

  it('scales pairwise by pairwiseCases / judged cases, two orders, every model but the reference, by every non-self judge, with the margin', () => {
    const { est } = estimate(models, sizes, { ...DEFAULT_JUDGE_PLAN, pairwiseCases: 2 });
    const judged = sizes.filter((s) => s.judged);
    const pa = judged.reduce((s, x) => s + 2 * costOf(A, tokensFromBytes(x.judgeBytes + x.outputBytes), 250), 0);
    const pb = judged.reduce((s, x) => s + 2 * costOf(B, tokensFromBytes(x.judgeBytes + x.outputBytes), 250), 0);
    // cand and gpt-oss-20b by A and B; A by B; B by A
    expect(est.pairwise).toBeCloseTo((3 * pa + 3 * pb) * (2 / judged.length) * MARGIN, 9);
  });

  it('uses a calibrated judge output when the pilot measured one', () => {
    const plain = estimate(models, sizes, DEFAULT_JUDGE_PLAN).est;
    const cal = estimate(models, sizes, DEFAULT_JUDGE_PLAN, { ja: { 'structured.other': 900, pairwise: 500 } }).est;
    expect(cal.primary.chat).toBeGreaterThan(plain.primary.chat);
    expect(cal.pairwise).toBeGreaterThan(plain.pairwise);
  });
});

describe('calibrationFrom', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cal-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('reads the judges too, absolute and pairwise apart', () => {
    const put = (p: string, v: unknown) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), JSON.stringify(v)); };
    put('raw/cand/interview-turn/c1.json', { calls: [{ label: 'interview.answer', tokensOut: 100 }] });
    put('judge/judge-a/absolute/cand/c1.json', { calls: [{ label: 'structured.other', tokensOut: 300 }] });
    put('judge/judge-a/rejudge/cand/c1.json', { calls: [{ label: 'structured.other', tokensOut: 300 }] });
    put('judge/judge-a/pairwise/cand/c1.json', { calls: [{ label: 'structured.other', tokensOut: 120 }, { label: 'structured.other', tokensOut: 140 }] });
    const cal = calibrationFrom(dir);
    expect(cal.cand['interview.answer']).toBe(100);
    expect(cal['judge-a']['structured.other']).toBe(300);
    expect(cal['judge-a'].pairwise).toBeGreaterThanOrEqual(120);
    expect(cal['judge-a'].pairwise).toBeLessThanOrEqual(140);
  });
});

describe('writePlan', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-plan-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big: PlannedCase[] = Array.from({ length: 40 }, (_, i) => ({
    caseId: `r${i}`, jobType: i % 2 ? 'review-design' : 'mentor-turn', judged: true,
    calls: [{ label: 'grading.review', requestBytes: 70_000, maxTokens: 4000 }], judgeBytes: 100_000, outputBytes: 4000,
  }));

  it('plans against the room left after earlier spend and records each cut', () => {
    const all = estimate([cand, ref, A, B], big, DEFAULT_JUDGE_PLAN).est;
    expect(all.secondary).toBeGreaterThan(0);
    const full = all.candidates + all.primary.chat + all.primary.explanation + all.primary.review + all.primary.proposal + all.secondary + all.pairwise + all.rejudge;
    const spent = 45 - full + all.pairwise / 2; // the room is short by about half the pairwise
    expect(spent).toBeGreaterThan(0);
    const plan = writePlan(dir, [cand, ref, A, B], big, 45, spent, {}, null);
    expect(plan.roomUsd).toBeCloseTo(45 - spent, 3);
    expect(plan.cuts.map((c) => c.stage)).toEqual(['pairwise']);
    expect(plan.judgePlan.pairwise).toBe(false);
    expect(plan.fits).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')).alreadySpentUsd).toBeCloseTo(spent, 3);
  });

  it('says it does not fit when even the third cut is not enough', () => {
    const plan = writePlan(dir, [cand, ref, A, B], big, 45, 44.9, {}, null);
    expect(plan.cuts.map((c) => c.stage)).toEqual(['pairwise', 'secondary-judges', 'primary-review-proposal']);
    expect(plan.fits).toBe(false);
  });
});

describe('refuseUnfitOrStalePlan (the CLI gate before a paid run)', () => {
  const { refuseUnfitOrStalePlan } = require('./plan');
  it('refuses a plan that does not fit', () => {
    expect(() => refuseUnfitOrStalePlan({ fits: false, alreadySpentUsd: 0, stopUsd: 45 }, 0, 45)).toThrow(/does not fit/);
  });
  it('refuses a plan made before other spend moved (the pilot), and a changed stop', () => {
    expect(() => refuseUnfitOrStalePlan({ fits: true, alreadySpentUsd: 0, stopUsd: 45 }, 2.1, 45)).toThrow(/re-plan/);
    expect(() => refuseUnfitOrStalePlan({ fits: true, alreadySpentUsd: 2.0, stopUsd: 45 }, 2.1, 30)).toThrow(/re-plan/);
  });
  it('refuses a plan written by an older estimator', () => {
    expect(() => refuseUnfitOrStalePlan({ version: 'eval-plan-v1', fits: true, alreadySpentUsd: 0, stopUsd: 45 }, 0, 45)).toThrow(/older estimator/);
  });
  it('accepts a fitting, current plan', () => {
    expect(() => refuseUnfitOrStalePlan({ fits: true, alreadySpentUsd: 2.0, stopUsd: 45 }, 2.1, 45)).not.toThrow();
  });
});

describe('refuseWithoutReasoningProbe (every switch is probed before any paid call)', () => {
  const { refuseWithoutReasoningProbe } = require('./plan');
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-rprobe-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const qwen = row('qwen3-32b', { reasoning: { policy: 'off', fields: { enable_thinking: false }, source: 'https://example.invalid', note: '' } });
  const models = [qwen, row('nova-micro'), ref];
  const put = (v: unknown) => fs.writeFileSync(path.join(dir, 'reasoning-probe.json'), JSON.stringify(v));
  it('refuses with no probe, a stub probe, a failed model or a switch that changed since', () => {
    expect(() => refuseWithoutReasoningProbe(dir, models)).toThrow(/probe/);
    put({ mode: 'stub', models: { 'qwen3-32b': { ok: true, fields: '{"enable_thinking":false}' }, 'nova-micro': { ok: true, fields: null } } });
    expect(() => refuseWithoutReasoningProbe(dir, models)).toThrow(/stub/);
    put({ mode: 'real', models: { 'qwen3-32b': { ok: false, fields: '{"enable_thinking":false}' }, 'nova-micro': { ok: true, fields: null } } });
    expect(() => refuseWithoutReasoningProbe(dir, models)).toThrow(/qwen3-32b/);
    put({ mode: 'real', models: { 'qwen3-32b': { ok: true, fields: null }, 'nova-micro': { ok: true, fields: null } } });
    expect(() => refuseWithoutReasoningProbe(dir, models)).toThrow(/re-probe/);
  });
  it('accepts a real probe that passed every Bedrock model with the switches it will be sent (the reference is not probed)', () => {
    put({ mode: 'real', models: { 'qwen3-32b': { ok: true, fields: '{"enable_thinking":false}' }, 'nova-micro': { ok: true, fields: null } } });
    expect(() => refuseWithoutReasoningProbe(dir, models)).not.toThrow();
  });
});
