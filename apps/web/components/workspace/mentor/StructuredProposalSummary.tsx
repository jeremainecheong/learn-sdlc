'use client';

import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, STORY_JSON, type FieldChange } from '@learnsdlc/shared';
import { designCompareDocuments, designFieldLabel } from '@/components/workspace/panels/design/designChanges';
import { SECTION_LABEL, sectionOf } from '@/components/workspace/panels/requirements/storyChanges';
import { isRoomRecordPath } from '@/components/workspace/records';
import { recordFieldLabel, recordSlotIds } from './recordFieldLabel';

const kindOf = (change: FieldChange) => (change.before === undefined || change.before === '' ? 'Added' : change.after === undefined || change.after === '' ? 'Removed' : 'Changed');

/** A story path in words: the section, and the criterion or line it falls in. */
function storyFieldLabel(path: string): string {
  const section = sectionOf(path);
  const criterion = /^story\/ac-(\d+)\/(\w+)$/.exec(path);
  if (criterion) return `Acceptance criterion ${criterion[1]}, ${criterion[2]}`;
  const line = /^story\/scope\/(\d+)$/.exec(path);
  if (line) return `Out of scope, line ${line[1]}`;
  return section ? SECTION_LABEL[section] : path.replace(/^story\//, '');
}

/** A runbook or change-request proposal's record group, then a group naming every other file it wrote. */
function recordGroups(files: Record<string, string>, real: FieldChange[]) {
  const label = files[RUNBOOK_JSON] !== undefined ? 'Your runbook' : 'Your change request';
  const ids = recordSlotIds(real);
  const others = Object.keys(files).filter((path) => !isRoomRecordPath(path));
  return [
    ...(real.length ? [{ key: 'record', label, rows: real.map((change) => ({ label: recordFieldLabel(change.path, ids), kind: kindOf(change) })) }] : []),
    ...(others.length ? [{ key: 'files', label: 'Files it also wrote', rows: others.map((path) => ({ label: path, kind: '' })) }] : []),
  ];
}

/**
 * A story, record (runbook or change request) or design proposal that is no
 * longer pending (applied, superseded or made against older work), drawn as
 * the overlay draws it: by its documents' names and the fields it changed,
 * never by a projection path or the raw text of a document. A record
 * proposal also names the other files it wrote.
 *
 * `changes` is measured against the saved work at the moment of the read, so
 * an applied proposal read again (a reload, Saved proposals, a repeat Apply)
 * has nothing left to diff: it says it is applied, not that it changed nothing.
 */
export function StructuredProposalSummary({ files, changes, applied = false }: { files: Record<string, string>; changes: FieldChange[]; applied?: boolean }) {
  const real = changes.filter((change) => (change.before ?? '') !== (change.after ?? ''));
  const record = files[RUNBOOK_JSON] !== undefined || files[CHANGE_REQUEST_JSON] !== undefined;
  const groups = files[STORY_JSON] !== undefined
    ? [{ key: 'story', label: 'Your story', rows: real.map((change) => ({ label: storyFieldLabel(change.path), kind: kindOf(change) })) }]
    : record
      ? recordGroups(files, real)
      : designCompareDocuments(real, { api: true, screens: true }).map((doc) => ({
          key: doc.path, label: doc.label, rows: doc.changes.map((change) => ({ label: designFieldLabel(change.path), kind: kindOf(change) })),
        }));
  // An applied proposal's changes are read against the saved work that now holds it, so they are empty: that
  // means nothing is left to apply, never that the Apply changed nothing.
  if (!groups.length || (!record && !real.length)) return <p className="agentic-review-note" data-testid="agentic-structured-summary">{applied ? "Applied. Your saved work holds this proposal's changes." : 'This proposal changed nothing in your saved work.'}</p>;
  return (
    <div data-testid="agentic-structured-summary">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h4>{group.label}</h4>
          <ul>{group.rows.map((row, index) => <li key={index}>{row.kind ? `${row.kind}: ${row.label}` : row.label}</li>)}</ul>
        </section>
      ))}
    </div>
  );
}
