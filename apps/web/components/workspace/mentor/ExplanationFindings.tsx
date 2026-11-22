'use client';

import { andList } from '@learnsdlc/shared';
import './ExplanationFindings.css';

/**
 * Which of the learner's own sentences the explanation review looked at.
 *
 * A refusal of one line, "a cited claim conflicts with the current proposal
 * or recorded workflow", gives no way to tell which sentence it meant.
 * The API ships the answer: `dimensions[].learnerEvidence` holds the
 * learner's own sentences, verbatim, selected by the model from server-extracted
 * excerpts and re-validated against the stored answer before the record is
 * kept. Showing them back leaks nothing and fabricates nothing.
 *
 * Two rules this component does not bend:
 *
 * - `reasoning` is never drawn. The server may send a fixed presentation sentence there, but
 *   private model rationales can collectively supply a replacement answer, and
 *   no learner-facing surface may render one.
 * - Nothing here changes what the learner may do. It reports a decision already
 *   taken and stored; Apply stays gated on the assessment itself.
 *
 * Everything is narrowed at runtime from `unknown`, because a stored assessment
 * from an older server carries no dimensions at all, and a newer server may
 * name a finding this build has never heard of. Either way this renders what it
 * can and nothing else.
 */

export const DIMENSION_LABEL = {
  effects: 'What the change does',
  constraints: 'Why it meets the request',
  verification: 'What is and is not verified',
  consistency: 'Whether the claims match the proposal',
} as const;

/**
 * The order the server assesses in, independent of the array's own order
 * (`UNDERSTANDING_DIMENSIONS` in the API's explanation-assessment.ts). Every
 * place that names the four checks names them by {@link DIMENSION_LABEL} in
 * this order, the overlay's one-line row as well as
 * the mentor's list, so one verdict is never read under two sets of names.
 */
export const DIMENSION_ORDER = ['effects', 'constraints', 'verification', 'consistency'] as const;

/**
 * The finding vocabulary this build knows, in the learner's terms. It is a
 * lookup and not a closed union on purpose: a newer server may name a finding
 * in its own words, and a label it supplies is what the learner reads, unchanged.
 */
const FINDING_LABEL: Record<string, string> = {
  supported: 'Supported',
  missing: 'Not explained yet',
  contradicted: 'Conflicts with the proposal or a record',
  unsupported: 'Not visible to this review',
  assessment_override: 'Asks to bypass this review',
};

/**
 * `missing` over a sentence the review quoted is not "nothing was
 * said": the learner said something under this check, and it did not satisfy
 * it. The chip then says what is asked for. Only the verdict's own fields are
 * read (the finding and whether it quoted a sentence).
 */
export const MISSING_WITH_QUOTE = 'Needs more';

/** A label this build has no word for is shown as the word that arrived. */
const LABEL_CHARS = 80;
function labelFor(finding: string, supplied: string | null, quoted = false): string | null {
  if (supplied) return supplied.slice(0, LABEL_CHARS);
  if (finding === 'missing' && quoted) return MISSING_WITH_QUOTE;
  const known = FINDING_LABEL[finding];
  if (known) return known;
  const words = finding.replace(/[_-]+/g, ' ').trim().slice(0, LABEL_CHARS);
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

export type DimensionKey = keyof typeof DIMENSION_LABEL;

export interface Finding {
  key: DimensionKey;
  met: boolean;
  /** The server's own finding value, or null when none arrived. */
  finding: string | null;
  /** What is drawn for that finding, or null when there is nothing to draw. */
  label: string | null;
  /** The learner's cited sentences, verbatim. */
  quotes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

/**
 * Every dimension the review reported, in the order it assesses them, whether
 * or not it cited a sentence: what the overlay's one-line summary of the four
 * dimensions reads. Empty for an assessment from before dimensions.
 */
export function assessmentDimensions(assessment: unknown): Finding[] {
  if (!isRecord(assessment) || !Array.isArray(assessment.dimensions)) return [];
  const rows = assessment.dimensions;
  const findings: Finding[] = [];
  for (const key of DIMENSION_ORDER) {
    const item = rows.find(row => isRecord(row) && row.key === key);
    if (!isRecord(item)) continue;
    const finding = text(item.finding);
    const quotes = Array.isArray(item.learnerEvidence)
      ? item.learnerEvidence.filter((quote): quote is string => typeof quote === 'string' && quote.trim().length > 0)
      : [];
    findings.push({ key, met: item.met === true, finding, label: labelFor(finding ?? '', text(item.label), quotes.length > 0), quotes });
  }
  return findings;
}

/** The cited sentences per dimension, or nothing at all when none were cited. */
export function explanationFindings(assessment: unknown): Finding[] {
  const findings = assessmentDimensions(assessment);
  return findings.some(finding => finding.quotes.length > 0) ? findings : [];
}

/** The sentence said under a finding the review could not see, quoting the label on screen. */
export const unsupportedNote = (label: string) => `“${label}” means the review had no record of what the sentence is about. It does not mean the sentence is false.`;

/** One quote as the list draws it: under the first check that cites it, with every other check that cites it named beside it. */
export interface DrawnQuote { quote: string; also: DimensionKey[] }

/**
 * Where two checks quote the identical sentence, it is drawn once,
 * under the first check (in {@link DIMENSION_ORDER}) that cites it, with the
 * other checks named beside it; a later check that cites it says so in one line
 * instead of drawing it again. Display only: what each check returned is
 * unchanged, and a check that cites nothing new keeps its own chip.
 */
export function groupQuotes(findings: readonly Finding[]): { drawn: Map<DimensionKey, DrawnQuote[]>; repeated: Map<DimensionKey, { under: DimensionKey[]; count: number }> } {
  const firstAt = new Map<string, DimensionKey>();
  const citers = new Map<string, DimensionKey[]>();
  for (const finding of findings) {
    for (const quote of new Set(finding.quotes)) {
      if (!firstAt.has(quote)) firstAt.set(quote, finding.key);
      citers.set(quote, [...(citers.get(quote) ?? []), finding.key]);
    }
  }
  const drawn = new Map<DimensionKey, DrawnQuote[]>();
  const repeated = new Map<DimensionKey, { under: DimensionKey[]; count: number }>();
  for (const finding of findings) {
    const own: DrawnQuote[] = [];
    const earlier: DimensionKey[] = [];
    let count = 0;
    for (const quote of new Set(finding.quotes)) {
      const first = firstAt.get(quote)!;
      if (first === finding.key) { own.push({ quote, also: (citers.get(quote) ?? []).filter(key => key !== finding.key) }); continue; }
      count += 1;
      if (!earlier.includes(first)) earlier.push(first);
    }
    drawn.set(finding.key, own);
    repeated.set(finding.key, { under: earlier, count });
  }
  return { drawn, repeated };
}

/** "A", "A and B", "A, B and C", by the checks' long names. */
const named = (keys: readonly DimensionKey[]) => {
  const words = keys.map(key => DIMENSION_LABEL[key]);
  return andList(words);
};

export function ExplanationFindings({ assessment }: { assessment: unknown }) {
  const findings = explanationFindings(assessment);
  if (findings.length === 0) return null;
  const { drawn, repeated } = groupQuotes(findings);
  // The explainer quotes the label that is actually on screen, so it stays true
  // when a newer server names this finding in its own words.
  const invisible = findings.find(finding => finding.finding === 'unsupported' && finding.label);
  return <div className="agentic-findings" data-testid="explanation-findings">
    <p>These are the sentences from your own explanation that the review looked at.</p>
    <div className="agentic-findings-scroll" tabIndex={0} role="region" aria-label="Sentences this review cited">
      <dl>
        {findings.map(finding => <div key={finding.key} data-finding={finding.finding ?? ''} data-met={finding.met}>
          <dt>{DIMENSION_LABEL[finding.key]}</dt>
          <dd>
            {finding.label && <span className="agentic-finding-label">{finding.label}</span>}
            {(drawn.get(finding.key) ?? []).map(({ quote, also }, index) => <div key={index} className="agentic-finding-quote">
              <blockquote>{quote}</blockquote>
              {also.length > 0 && <small data-testid="finding-quote-also">{`Also cited for ${named(also)}.`}</small>}
            </div>)}
            {(repeated.get(finding.key)?.count ?? 0) > 0 && <p className="agentic-finding-repeat" data-testid="finding-quote-repeat">{`${(drawn.get(finding.key) ?? []).length ? 'Also cites' : 'Cites'} ${repeated.get(finding.key)!.count === 1 ? 'the sentence' : 'the sentences'} under ${named(repeated.get(finding.key)!.under)}.`}</p>}
          </dd>
        </div>)}
      </dl>
    </div>
    {invisible?.label && <p>{unsupportedNote(invisible.label)}</p>}
  </div>;
}
