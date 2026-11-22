'use client';

import { Fragment, type ReactNode } from 'react';
import { andList } from '@learnsdlc/shared';
import { MAX_FIELD_ROWS, type ChangeAnalysis, type FieldChange, type StructuralDiff } from './proposalChange';
import './ProposalChangeSummary.css';

/**
 * The text with a break offered (<wbr>) after each of `after`, and
 * nowhere else, so a narrow column breaks a field's key at its dots and
 * underscores and a value after its slashes, colons and dots, never inside a
 * word. The text itself is unchanged: `textContent` reads the same.
 */
export function breakAfter(text: string, after: string): ReactNode {
  const parts = text.split(new RegExp(`(?<=[${after.replace(/[\]\\^-]/g, '\\$&')}])`));
  return parts.length === 1 ? text : parts.map((part, index) => <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>);
}
const KEY_BREAKS = '._';
const VALUE_BREAKS = '/:.';

/** Long values are here for orientation, not to be read in full. */
const VALUE_CHARS = 120;
const shorten = (value: string | undefined) =>
  value === undefined ? '' : value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS)}…` : value;

type FieldKind = 'added' | 'removed' | 'changed' | 'moved';
const KIND_LABEL: Record<FieldKind, string> = { added: 'Added', removed: 'Removed', changed: 'Changed', moved: 'Moved' };

const countPhrase = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What was measured, named as what it is: fields, entries, positions. */
function fieldSentence(structural: StructuralDiff): string {
  const parts: string[] = [];
  if (structural.added.length) parts.push(`${countPhrase(structural.added.length, 'field', 'fields')} added`);
  if (structural.removed.length) parts.push(`${countPhrase(structural.removed.length, 'field', 'fields')} removed`);
  if (structural.changed.length) parts.push(`${countPhrase(structural.changed.length, 'field', 'fields')} changed`);
  if (structural.moved.length) parts.push(`${countPhrase(structural.moved.length, 'entry', 'entries')} moved`);
  return `Compared field by field: ${andList(parts)}.`;
}

/** The rows of one group, capped, with the value column already written out. */
function rowsOf(kind: FieldKind, changes: FieldChange[]) {
  return changes.slice(0, MAX_FIELD_ROWS).map((change, index) => ({
    id: `${kind}:${index}:${change.path}`,
    kind,
    path: change.path === '' ? 'the whole document' : change.path,
    value: kind === 'moved' ? `${change.before} → ${change.after}`
      : kind === 'changed' ? `${shorten(change.before)} → ${shorten(change.after)}`
        : shorten(kind === 'added' ? change.after : change.before),
  }));
}

/**
 * One file's meaning summary, beside the line diff rather than instead of it.
 *
 * The line table above is unchanged and is still counted by a recorded
 * harness, so nothing here is drawn inside `.agentic-diff-scroll` and no row
 * here carries `data-change`.
 *
 * It says nothing at all when there is nothing measured to say: an unchanged
 * file, which the comparison does not measure and passes as `null`, a file with
 * no saved copy to be a reformatting of, or an ordinary text edit whose line
 * diff is already the clearest thing on screen. When a cap was
 * hit the partial lists are withheld rather than drawn under a heading that
 * would read as complete: a field list that silently omits a field is the
 * failure this component exists to prevent.
 */
export function ProposalChangeSummary({ analysis }: { analysis: ChangeAnalysis | null }) {
  if (analysis === null) return null;
  const { path, adds, dels, lineChurn, meaning, meaningKind, structural, jsonParse, churnFlag } = analysis;
  if (lineChurn === 0) return null;
  if (structural === null && meaningKind === 'unmeasured') return null;
  const lines = countPhrase(dels, 'line', 'lines');
  if (structural?.truncated) {
    return <p className="agentic-change-summary">This file is too large to compare field by field, so only the line diff is shown.</p>;
  }
  if (jsonParse === 'saved-only') {
    return <p className="agentic-change-summary">The proposed file is not valid JSON, so only the line diff is shown.</p>;
  }
  if (jsonParse === 'proposed-only') {
    return <p className="agentic-change-summary">The saved file is not valid JSON, so only the line diff is shown.</p>;
  }
  if (jsonParse === 'neither') {
    return <p className="agentic-change-summary">Neither copy is valid JSON, so only the line diff is shown.</p>;
  }
  if (structural === null) {
    if (!churnFlag) return null;
    return <p className="agentic-change-summary">
      {meaning === 0
        ? `${lines} removed and ${adds} added, and no word differs. Only the layout changed.`
        : `${lines} removed and ${adds} added, but only ${countPhrase(meaning, 'word occurrence', 'word occurrences')} ${meaning === 1 ? 'differs' : 'differ'}. The rest is re-layout.`}
    </p>;
  }
  const empty = structural.count === 0;
  const groups: Array<[FieldKind, FieldChange[]]> = [
    ['added', structural.added], ['removed', structural.removed], ['changed', structural.changed], ['moved', structural.moved],
  ];
  const rows = groups.flatMap(([kind, changes]) => rowsOf(kind, changes));
  const hidden = structural.count - rows.length;
  return <div className="agentic-change-summary">
    <p>{empty
      ? `Compared field by field: no JSON field differs. ${lines} removed and ${adds} added, so only the file’s layout changed.`
      : fieldSentence(structural)}</p>
    {churnFlag && !empty && <p>{`${lines} removed and ${adds} added to make ${countPhrase(meaning, 'difference', 'differences')}. Read the field list, not the line diff.`}</p>}
    {/* Two numbers for one entry have to say what they count. These are ranks
        among the entries in both copies, not positions in the file: a removal
        above an entry and an insertion below it leave its position alone while
        its order among its neighbours changes. */}
    {structural.moved.length > 0 && <p>Moved entries are numbered by their order among the entries kept in both copies.</p>}
    {rows.length > 0 && <div className="agentic-structural-scroll" tabIndex={0} role="region" aria-label={`Fields that differ: ${path}`}>
      <table>
        <thead><tr><th scope="col">Change</th><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
        <tbody>
          {rows.map(row => <tr key={row.id} data-field-change={row.kind}>
            <th scope="row">{KIND_LABEL[row.kind]}</th>
            <td className="agentic-field-key">{breakAfter(row.path, KEY_BREAKS)}</td>
            <td><code>{breakAfter(row.value, VALUE_BREAKS)}</code></td>
          </tr>)}
        </tbody>
      </table>
      {hidden > 0 && <p className="agentic-structural-more">{`…and ${countPhrase(hidden, 'more field', 'more fields')}.`}</p>}
    </div>}
  </div>;
}
