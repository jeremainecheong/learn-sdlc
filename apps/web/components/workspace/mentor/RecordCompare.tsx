/**
 * A runbook or change-request proposal compared: the props of the
 * record subject, the changed-line count a file's rail entry shows, and the
 * record's pane (its changed fields, BEFORE grey and AFTER green). The dialog
 * itself is `RecordDialog` in `ProposalCompare.tsx`, built on the shared
 * `CompareFrame` (a modal dialog: Escape and cancel close it, focus goes back,
 * the Side by side and Flip switch, the rail). No floor status is drawn.
 */
import type { FieldChange } from '@learnsdlc/shared';
import { fileDiff } from '@/components/pr/diff';
import type { CompareGateProps } from './ProposalCompare';
import { recordFieldLabel, recordSlotIds } from './recordFieldLabel';

export interface RecordCompareProps extends CompareGateProps {
  subject: 'record';
  label: 'Runbook' | 'Change request';
  changes: FieldChange[];
  carried: string[];
  files: { path: string; before?: string; after: string }[];
  /** The saved record the changes are numbered by, so a field is named by its item's id. */
  saved?: string;
}

/**
 * The lines a file's change touches, counted once each: in every
 * run of changed lines of the line diff, the larger of what it removes and what
 * it adds, so a line edited in place is one line, not one removed and one
 * added ("2 lines" for a one-line change), four lines added are four, and two
 * lines removed with nothing in their place are two. The same `fileDiff` the
 * file's own "n removed, n added" line reads, so a trailing newline is not a
 * line of its own. The rail, the card's file list and the overlay's file list
 * all count by this one rule.
 */
export function changedLineCount(before: string | undefined, after: string): number {
  if (before === after) return 0;
  const diff = fileDiff('', before, after);
  let total = 0;
  for (const hunk of diff.hunks) {
    let removed = 0;
    let added = 0;
    for (const line of hunk.lines) {
      if (line.kind === '-') removed += 1;
      else if (line.kind === '+') added += 1;
      else { total += Math.max(removed, added); removed = 0; added = 0; }
    }
    total += Math.max(removed, added);
  }
  return total;
}

/** One side of the record's changed fields, each named in words: BEFORE in the tool's greys, AFTER in the pass green. */
export function RecordFields({ changes, tone, saved }: { changes: FieldChange[]; tone: 'before' | 'after'; saved?: string }) {
  const ids = recordSlotIds(changes, saved);
  return (
    <dl className="apv-fields">
      {changes.map((change) => (
        <div key={change.path} className="apv-row">
          <dt className="label-sm">{recordFieldLabel(change.path, ids)}</dt>
          <dd className={`field apv-ro ${tone === 'after' ? 'apv-changed' : 'apv-was'}`} data-testid={`record-compare-${tone}-${change.path}`}>{(tone === 'after' ? change.after : change.before) ?? ''}</dd>
        </div>
      ))}
    </dl>
  );
}
