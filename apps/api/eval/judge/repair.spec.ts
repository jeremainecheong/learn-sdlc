import { repairJudgeJson } from './repair';

/*
 * A judge model (Amazon Nova Lite) can end an absolute judgement one closing
 * brace short when everything else in it is valid. The
 * harness (judge side only, never the product path) appends the missing
 * closers when that alone makes the text parse, and records the adaptation.
 */
describe('repairJudgeJson (harness-side, judges only)', () => {
  it('leaves valid JSON alone and records no adaptation', () => {
    expect(repairJudgeJson('{"winner":"A","justification":"x"}')).toEqual({ value: { winner: 'A', justification: 'x' }, adaptation: null });
  });

  it('appends the closing braces a judge left off, and says how many', () => {
    const text = '{"scores": {"fairness": {"score": 3, "justification": "ok, {not a brace}"}, "usefulness": {"score": 4, "justification": "y"}}';
    const r = repairJudgeJson(text);
    expect(r.adaptation).toBe('closing-brackets-appended:1');
    expect((r.value as { scores: Record<string, { score: number }> }).scores.usefulness.score).toBe(4);
    expect(repairJudgeJson('{"a": [1, {"b": 2}').adaptation).toBe('closing-brackets-appended:2');
  });

  it('strips one json code fence, as the product transport does', () => {
    expect(repairJudgeJson('```json\n{"winner":"tie","justification":"z"}\n```').value).toEqual({ winner: 'tie', justification: 'z' });
  });

  it('refuses anything a closer alone cannot fix: cut mid-string, a preamble, stray text, too many missing', () => {
    expect(() => repairJudgeJson('{"scores": {"a": {"score": 3, "justification": "cut mid')).toThrow();
    expect(() => repairJudgeJson('Here is my judgement: {"winner":"A"}')).toThrow();
    expect(() => repairJudgeJson('{"winner":"A"}} trailing')).toThrow();
    expect(() => repairJudgeJson('{"a":{"b":{"c":{"d":1')).toThrow();
    expect(() => repairJudgeJson('')).toThrow();
  });
});

describe('structuredForJudge and the offline re-parse of recorded judgements', () => {
  const { structuredForJudge, reparseJudgeRecord } = require('./judge') as typeof import('./judge');
  const short = '{"scores": {"fairness": {"score": 3, "justification": "a"}, "usefulness": {"score": 2, "justification": "b"}}';

  it('uses the product parse when it succeeds, repairs only a "not JSON" refusal, and rethrows anything else', async () => {
    await expect(structuredForJudge(async () => ({ value: { ok: 1 } }), () => null)).resolves.toEqual({ value: { ok: 1 }, adaptation: null });
    const notJson = async () => { throw new Error('AI structured response was not JSON'); };
    await expect(structuredForJudge(notJson, () => short)).resolves.toMatchObject({ adaptation: 'closing-brackets-appended:1' });
    await expect(structuredForJudge(notJson, () => 'Sure! {"scores":{}}')).rejects.toThrow('not JSON');
    await expect(structuredForJudge(async () => { throw new Error('budget stop'); }, () => short)).rejects.toThrow('budget stop');
  });

  it('re-parses a recorded absolute judgement from its stored text, without a new call, and marks it', () => {
    const rec = { kind: 'absolute', useCase: 'explanation', failure: 'invalid_judgement', result: null, calls: [{ outcome: 'ok', responseText: short }], modelKey: 'm', caseId: 'c' };
    const out = reparseJudgeRecord(rec as never, 'salt')!;
    expect(out.failure).toBeNull();
    expect((out.result as { scores: Record<string, { score: number }>; adaptation: string }).scores.usefulness.score).toBe(2);
    expect((out.result as { adaptation: string }).adaptation).toBe('closing-brackets-appended:1');
    expect(out.reparsed).toMatchObject({ failureBefore: 'invalid_judgement' });
    expect(reparseJudgeRecord({ ...rec, calls: [{ outcome: 'ok', responseText: 'nope' }] } as never, 'salt')).toBeNull();
    expect(reparseJudgeRecord({ ...rec, failure: null } as never, 'salt')).toBeNull();
  });
});
