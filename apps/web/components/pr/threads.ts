/**
 * The reviewer's threads, in the shape the pull request draws them.
 *
 * The derivation itself already exists: `panels/implementation/pr.ts` turns a
 * revision's failing cases and analyzer findings into threads, and closes one
 * when a later revision passes it. This module does the two things that are
 * the page's own: it anchors each thread on a line of the diff, and it gives
 * the thread the second sentence a reviewer would end on: the question the
 * learner has to answer, taken from the contract claim the finding lands on.
 */
import { pluralWord, type ContractClaim, type FeedbackReport } from '@learnsdlc/shared';
import { PERSONA_NAME, PHASE_REVIEWER } from '@/lib/phase';
import type { PhaseKey } from '@learnsdlc/shared';
import {
  buildLedger,
  buildThreads,
  claimSentence,
  type Revision,
  type Thread,
} from '@/components/workspace/panels/implementation/pr';

export interface PrThread extends Thread {
  /** "Senior engineer", the phase's reviewer, who signs the thread. */
  who: string;
  initials: string;
  /** The question the thread leaves with the learner. */
  ask: string;
  /** The contract claim the finding argues with, when there is one. */
  claim: ContractClaim | null;
  /**
   * Which side of the diff the line belongs to. A thread on the revision being
   * read is on the new side; one carried over from the revision before it
   * (the ones a later submission settled) is on the old side, because that is
   * the line the reviewer was looking at.
   */
  side?: 'old' | 'new';
}

const ASK: Record<Thread['kind'], string> = {
  test: 'Change the line, or say in the merge message why the case is wrong.',
  analyzer: 'Fix it here, or say in the merge message why it stays.',
};

/** Claim lines read as one paragraph: stopped, deduplicated, and capped. */
function sentences(lines: string[], max: number): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const text = line.trim().replace(/[.;,]+$/, '');
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    kept.push(`${text}.`);
  }
  const shown = kept.slice(0, max).join(' ');
  const rest = kept.length - max;
  return rest > 0 ? `${shown} And ${rest} more ${pluralWord(rest, 'claim')} on this contract.` : shown;
}

/** The claim whose function the finding sits inside, by name in the source or the message. */
function claimFor(thread: Thread, contract: ContractClaim[]): ContractClaim | null {
  const hay = `${thread.source} ${thread.message} ${thread.snippet ?? ''}`.toLowerCase();
  const named = contract.filter((c) => hay.includes(c.name.toLowerCase()));
  if (named.length === 0) return null;
  // A contradicted claim is the argument; a kept one is only context.
  return (
    named.find((c) => c.verdict === 'contradicted') ??
    named.find((c) => c.verdict === 'broken') ??
    named[0]
  );
}

/**
 * A line of the contract the design left blank: the ledger's `unclaimed` with no
 * text ("The errors line is present but empty", "The design states no boundary"),
 * whichever line it is. A line the design wrote and nothing in the run bore on is
 * `unclaimed` too, with its text: that one is not blank.
 */
const leftBlank = (claim: ContractClaim): boolean => claim.verdict === 'unclaimed' && !claim.text.trim();

/**
 * A claim the code argues with is a thread of its own when nothing else
 * already reports it, anchored on the function the analyzer resolved.
 *
 * The rule: a contract line the design
 * left blank cannot be broken by the code, so on a review that passed it is not
 * a thread, whichever line it is (Errors, Boundary, Ordering, or Inputs and
 * Returns, which a design that passed its check always holds). A contract whose
 * every open line is blank raises no thread there. On TaskTrackr, isOverdue's
 * optional Errors box is empty and its Returns names no boundary, and a passed
 * pull request must not open on an Open "Maintainer" thread, "Errors.
 * Boundary.", above "Pass. Every required criterion has acceptable
 * evidence.". The ledger (the Checks
 * tab) still lists the contract as unclaimed, and the teacher's dossier, which
 * draws these same threads for the pull request, follows the same rule. A
 * contract with a line that is broken, contradicted or written, and every
 * contract on a review that has not passed, is a thread.
 */
function contractThreads(report: FeedbackReport, covered: Set<string>): Thread[] {
  const functions = report.staticAnalysis?.functions ?? [];
  // One thread per contract, not per claim: a reviewer arguing about
  // filter_tasks says it once, with every claim it broke.
  const groups = buildLedger((report.contract ?? []).filter((c) => c.verdict !== 'kept'));
  const passed = report.passed === true;
  const out: Thread[] = [];
  for (const group of groups) {
    if (covered.has(group.name)) continue;
    if (passed && group.claims.every(leftBlank)) continue;
    const fn = functions.find((f) => f.name === group.name || f.name.endsWith(`.${group.name}`));
    out.push({
      key: `contract:${group.name}`,
      kind: 'analyzer',
      source: group.name,
      path: fn?.path ?? '',
      line: fn?.line ?? 0,
      message: sentences(group.claims.map(claimSentence), 3),
      state: 'open',
      resolvedIn: null,
      severity: group.verdict === 'unclaimed' ? 'warning' : 'error',
    });
  }
  return out;
}

/**
 * Every thread on a revision: what failed, what the analyzer said, and what
 * the design contract says about it. Resolved threads stay: a reader wants to
 * see the argument that a later submission settled.
 */
export function prThreads(
  phaseKey: PhaseKey,
  revision: Revision | null,
  later: Revision[],
): PrThread[] {
  if (!revision?.report) return [];
  const report = revision.report;
  const contract = report.contract ?? [];
  const base = buildThreads(revision, later);
  const covered = new Set<string>();
  const who = PERSONA_NAME[phaseKey];
  const initials = PHASE_REVIEWER[phaseKey].initials;

  const dressed = base.map((t) => {
    const claim = claimFor(t, contract);
    if (claim) covered.add(claim.name);
    return {
      ...t,
      who,
      initials,
      claim,
      ask: claim
        ? `Which do you want: the contract changed, or the code? Say which in the merge message.`
        : ASK[t.kind],
    };
  });

  const extra = contractThreads(report, covered).map((t) => ({
    ...t,
    who,
    initials,
    claim: contract.find((c) => c.name === t.source && c.verdict !== 'kept') ?? null,
    ask: 'Which do you want: the contract changed, or the code? Say which in the merge message.',
  }));

  return [...dressed, ...extra];
}

/**
 * What the revision before this one was arguing about, and this one settled.
 *
 * A pull request keeps its argument: the reviewer's point does not disappear
 * because the next submission answered it, it gets a "Resolved in submission n"
 * chip and stays where it was made. Those lines belong to the base of the diff,
 * so the threads are marked `old` and the diff anchors them on that gutter.
 */
export function carriedThreads(
  phaseKey: PhaseKey,
  previous: Revision | null,
  head: Revision | null,
): PrThread[] {
  if (!previous || !head) return [];
  // One per line. Ten hidden cases stopped by the same `raise
  // NotImplementedError` were one argument, and the revision that answered it
  // answered all ten; ten identical resolved cards would bury the open ones.
  const seen = new Set<string>();
  const out: PrThread[] = [];
  for (const t of prThreads(phaseKey, previous, [head])) {
    if (t.state !== 'resolved') continue;
    const where = `${t.path}:${t.line}`;
    if (seen.has(where)) continue;
    seen.add(where);
    out.push({ ...t, side: 'old' });
  }
  return out;
}

/** Threads on one file, oldest line first, the order the diff draws them in. */
export function threadsOn(threads: PrThread[], path: string): PrThread[] {
  return threads.filter((t) => t.path === path && t.line > 0).sort((a, b) => a.line - b.line);
}

/** "2 threads, both open" / "3 threads, 1 open" / "no threads". */
export function threadSummary(threads: PrThread[], closed = false): string {
  const open = closed ? 0 : threads.filter((t) => t.state === 'open').length;
  if (threads.length === 0) return 'No threads';
  const noun = `${threads.length} ${pluralWord(threads.length, 'thread')}`;
  if (open === 0) return `${noun}, ${threads.length === 1 ? 'resolved' : 'all resolved'}`;
  if (open === threads.length) {
    return `${noun}, ${threads.length === 1 ? 'open' : threads.length === 2 ? 'both open' : 'all open'}`;
  }
  return `${noun}, ${open} open`;
}
