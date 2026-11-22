/**
 * The one line a pull request is titled with: what this phase's submission is
 * trying to make true. On the reference project the implementation PR names
 * the file it changes, since that is what the reviewer is reading; a room of
 * its own is titled by one rule in every phase (`ownPrTitle`).
 */
import type { PhaseDetail, PhaseKey } from '@learnsdlc/shared';
import { ownRoomHeadline } from '@/components/workspace/ide/derive';

const HEADLINE: Record<PhaseKey, string> = {
  requirements: 'Write US-4 with criteria a test can check',
  design: 'Decide the model, the contracts and one trade-off',
  implementation: 'Make the code true to the contracts',
  testing: 'One test per criterion, and the planted bugs caught',
  deployment: 'Ship an image that runs through its own entrypoint',
  maintenance: 'Make the change without breaking the contract',
};

/**
 * The Requirements headline for a room that
 * is not the reference project's. "US-4" is the reference story's id; the
 * IDE strip's `headlineFor` reads the same neutral words there.
 */
const NEUTRAL_REQUIREMENTS_HEADLINE = 'Write your story, with criteria a test can check';

const CODE = /\.(py|js|ts|go|rb|java|rs|c|cpp|cs|php)$/i;

/** The file the reviewer is reading, if this phase has one. */
function primaryFile(detail: PhaseDetail): string | null {
  const editable = detail.files.filter((f) => f.editable);
  const code = editable.find((f) => CODE.test(f.path) && !/test/i.test(f.path));
  return (code ?? editable[0])?.path ?? null;
}

/**
 * `reference`: whether the phase's room is still the reference project's
 * (`roomIsReference`). Left out it is true, which draws the reference
 * project's line.
 */
export function prHeadline(detail: PhaseDetail, reference = true): string {
  if (detail.key === 'requirements' && !reference) return NEUTRAL_REQUIREMENTS_HEADLINE;
  // Every other line names the reference project's deliverables (its
  // contracts, its image's entrypoint); a room of its own is titled with what
  // its pack asks, by one rule.
  if (!reference) return ownPrTitle(detail);
  if (detail.key === 'implementation') {
    const file = primaryFile(detail);
    if (file) return `Make ${file.split('/').pop()} true to the contracts`;
  }
  return HEADLINE[detail.key];
}

/** The first sentence of a text's opening paragraph, on one line, without its closing full stop. */
export function firstSentence(text: string | null | undefined): string {
  const opening = (text ?? '').split(/\n[ \t]*\n/)[0].replace(/\s+/g, ' ').trim();
  const sentence = opening.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? opening;
  return sentence.replace(/\.$/, '').trim();
}

/**
 * A room of its own's pull request title, by one rule in every phase: the
 * change request's id and title where the phase works one
 * ("CR-1 Completed tasks are not overdue"), else the first sentence of the
 * phase's own intro without its full stop ("Fill one TODO in the overdue
 * helper so the failing test passes"), else the phase's neutral line. Never a
 * file path, and never the intro's whole opening paragraph, full stop and
 * all.
 */
export function ownPrTitle(detail: Pick<PhaseDetail, 'key' | 'intro'> & Partial<Pick<PhaseDetail, 'change'>>): string {
  const ticket = detail.change?.ticket;
  const title = ticket?.title.trim();
  if (title) return [ticket?.id.trim(), title.replace(/\.$/, '')].filter(Boolean).join(' ');
  return ownRoomHeadline(detail.key, [], firstSentence(detail.intro));
}
