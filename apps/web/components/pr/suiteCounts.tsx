/**
 * The test cases a run carries, counted the one way the product names them.
 *
 * A submission's run holds both suites, the visible one the learner can read
 * and the hidden one the review adds, and its `total` and `passed` are the two
 * together. A card titled for one suite but counting both would say "28 of 28"
 * where the rubric says hidden 22 of 22 and visible 6 of 6, so every card
 * that counts cases reads them here and says all three: visible, hidden,
 * total. The workspace's feedback card and the review's Checks tab draw the
 * same words from this one place.
 */
import type { FeedbackReport, TestCaseResult } from '@learnsdlc/shared';

type Tests = NonNullable<FeedbackReport['tests']>;

export interface Count {
  passed: number;
  total: number;
}

export interface SuiteCounts {
  visible: Count;
  hidden: Count;
  total: Count;
}

/** The title every card that counts a run's cases carries. */
export const TEST_CASES_TITLE = 'Test cases';

/**
 * Hidden from the cases the runner flagged; the total from the run's own
 * counts; visible as the rest, so the three parts always add up.
 */
export function suiteCounts(tests: Tests): SuiteCounts {
  const hiddenCases = tests.cases.filter((c: TestCaseResult) => c.hidden);
  const hidden = {
    passed: hiddenCases.filter((c) => c.status === 'passed').length,
    total: hiddenCases.length,
  };
  const total = {
    passed: Math.max(tests.passed, 0),
    total: Math.max(tests.total, hidden.total),
  };
  const visible = {
    passed: Math.max(total.passed - hidden.passed, 0),
    total: Math.max(total.total - hidden.total, 0),
  };
  return { visible, hidden, total };
}

/**
 * The parts, as words: "Visible 6 of 6", "Hidden 22 of 22", "Total 28 of 28".
 * A part with no cases is left out; the total is always said.
 */
export function suiteParts(counts: SuiteCounts): { key: 'visible' | 'hidden' | 'total'; text: string }[] {
  const out: { key: 'visible' | 'hidden' | 'total'; text: string }[] = [];
  if (counts.visible.total > 0) out.push({ key: 'visible', text: `Visible ${counts.visible.passed} of ${counts.visible.total}` });
  if (counts.hidden.total > 0) out.push({ key: 'hidden', text: `Hidden ${counts.hidden.passed} of ${counts.hidden.total}` });
  out.push({ key: 'total', text: `Total ${counts.total.passed} of ${counts.total.total}` });
  return out;
}

/**
 * The counts line: each part its own item, so a screen reader reads three
 * values and no separator glyph stands in for a word (the product's copy rule
 * bans the middle dot and the pipe in drawn text).
 */
export function SuiteCountsLine({ counts, className = '' }: { counts: SuiteCounts; className?: string }) {
  return (
    <ul
      className={`${className} flex flex-wrap gap-x-4 gap-y-1 text-[13px] leading-relaxed text-ink2`}
      aria-label="Test case counts"
      data-testid="suite-counts"
    >
      {suiteParts(counts).map((p) => (
        <li key={p.key} data-testid={`suite-count-${p.key}`}>
          {p.text}
        </li>
      ))}
    </ul>
  );
}
