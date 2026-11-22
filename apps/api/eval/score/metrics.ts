/**
 * Fixed-metric arithmetic for the evaluation. Pure: no I/O, no model, no clock.
 * Every function returns null rather than NaN where a denominator is zero, so a
 * report cell reads "n/a" instead of a number nobody measured.
 */

export type Verdict = 'pass' | 'needs_revision';

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * Verdict agreement with the reference. A missing verdict (the product failed
 * closed: provider error or validator rejection) is scored as the product
 * scores it (Needs revision) and is also counted on its own as `noVerdict`.
 * `falsePass` is a reference needs_revision the model passed: the number that
 * protects grading integrity, so the report shows it first.
 */
export function verdictAgreement(rows: ReadonlyArray<{ expected: Verdict; got: Verdict | null }>) {
  let correct = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let falsePass = 0;
  let noVerdict = 0;
  let expectedNr = 0;
  let passTp = 0;
  let passPredicted = 0;
  for (const row of rows) {
    const got: Verdict = row.got ?? 'needs_revision';
    if (row.got === null) noVerdict += 1;
    if (got === row.expected) correct += 1;
    if (row.expected === 'needs_revision') expectedNr += 1;
    if (got === 'needs_revision' && row.expected === 'needs_revision') tp += 1;
    if (got === 'needs_revision' && row.expected === 'pass') fp += 1;
    if (got === 'pass' && row.expected === 'needs_revision') { fn += 1; falsePass += 1; }
    if (got === 'pass') { passPredicted += 1; if (row.expected === 'pass') passTp += 1; }
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : (precision === null || recall === null ? null : 0);
  return {
    n: rows.length,
    accuracy: ratio(correct, rows.length),
    falsePass,
    falsePassRate: ratio(falsePass, expectedNr),
    noVerdict,
    passPrecision: ratio(passTp, passPredicted),
    needsRevision: { precision, recall, f1 },
  };
}

/** Per-criterion F1 of "met", then the unweighted mean across criteria. */
export function macroF1(pairs: ReadonlyArray<{ key: string; expected: boolean; got: boolean }>) {
  const by = new Map<string, { tp: number; fp: number; fn: number; tn: number }>();
  for (const pair of pairs) {
    const cell = by.get(pair.key) ?? { tp: 0, fp: 0, fn: 0, tn: 0 };
    if (pair.expected && pair.got) cell.tp += 1;
    else if (!pair.expected && pair.got) cell.fp += 1;
    else if (pair.expected && !pair.got) cell.fn += 1;
    else cell.tn += 1;
    by.set(pair.key, cell);
  }
  const perKey: Record<string, number> = {};
  for (const [key, c] of by) {
    // A criterion with no positive on either side and every negative agreeing is full agreement.
    if (c.tp + c.fp + c.fn === 0) { perKey[key] = 1; continue; }
    const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
    const r = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
    perKey[key] = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  }
  const values = Object.values(perKey);
  return { perKey, macro: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
}

/** 1-2 low, 3 middle, 4-5 high: the bins the design names for judge self-consistency. */
const scoreBin = (score: number): 'L' | 'M' | 'H' => (score <= 2 ? 'L' : score === 3 ? 'M' : 'H');

/** Cohen's kappa over binned 1-5 scores; null below two pairs. 1 when both raters are constant and equal. */
export function cohenKappa(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) throw new Error('kappa needs paired scores');
  if (a.length < 2) return null;
  const bins = ['L', 'M', 'H'] as const;
  const ba = a.map(scoreBin);
  const bb = b.map(scoreBin);
  const n = a.length;
  const po = ba.filter((x, i) => x === bb[i]).length / n;
  let pe = 0;
  for (const bin of bins) pe += (ba.filter((x) => x === bin).length / n) * (bb.filter((x) => x === bin).length / n);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

const words = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);

/**
 * The harness's regex layer for stakeholder replies, on top of the product's
 * own `redactArtifactLikeReply` (applied by the driver): Given/When/Then lines,
 * a written "As a … I want … so that" story (a template with <placeholders> is
 * not a story), code fences, out-of-character tokens, and the 90-word limit.
 */
export function interviewRegexGuardrails(answer: string) {
  const gwt = /^\s*(?:[-*]\s*)?(?:\*\*)?(Given|When|Then)\b/im.test(answer);
  const storyMatch = /\bAs an? [^.\n]{1,80}?,?\s+I want\b[^.\n]{1,200}?\bso that\b/i.exec(answer);
  const story = Boolean(storyMatch && !/<[^>]+>/.test(storyMatch[0]));
  const codeFence = /```/.test(answer);
  const outOfCharacter = /\bas an ai\b|\blanguage model\b|\bmentor\b|\blearnsdlc\b|\brubric\b/i.test(answer);
  const overLength = words(answer) > 90;
  return { gwt, story, codeFence, outOfCharacter, overLength, words: words(answer), ok: !(gwt || story || codeFence || outOfCharacter || overLength) };
}

/** The mentor reply's shape rules: ≤ 120 words, ends with a question, no fenced block over 2 lines. */
export function mentorShapeGuardrails(reply: string) {
  const overLength = words(reply) > 120;
  const endsWithQuestion = /\?\s*["')\]]*\s*$/.test(reply.trim());
  let longFence = false;
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (let m = fence.exec(reply); m; m = fence.exec(reply)) {
    if (m[1].replace(/\n$/, '').split('\n').length > 2) longFence = true;
  }
  return { overLength, endsWithQuestion, longFence, words: words(reply), ok: !overLength && endsWithQuestion && !longFence };
}
