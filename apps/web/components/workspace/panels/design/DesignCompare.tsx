'use client';

import type { ReactNode } from 'react';
import type { FieldChange } from '@learnsdlc/shared';
import { designFieldLabel, designValueText, itemOfPath, type DesignCompareDocument } from './designChanges';

/**
 * One column of the Agentic before/after overlay for a design proposal: the
 * changed fields of one document, read-only, grouped by the item they belong
 * to. Each entry is drawn whole from its own two sides (the change set already
 * matched the items by id), so a removed item reads as removed and an added
 * one as new, and nothing is paired by its number.
 */

type Tone = 'before' | 'after';

/** The words a mark says on each side: what will happen, and what did. */
const MARK: Record<Tone, { changed: string; added: string; removed: string; ghost: string }> = {
  before: { changed: 'Will change', added: '', removed: 'Will be removed', ghost: 'not in your design yet' },
  after: { changed: 'Changed', added: 'New', removed: 'Removed', ghost: 'removed by this proposal' },
};

function Mark({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip ${tone === 'after' ? 'apv-chip-new' : 'apv-chip-was'}`}>{children}</span>;
}

/** The changes in their order, grouped by the item each belongs to. */
function byItem(changes: FieldChange[]): { item: string; changes: FieldChange[] }[] {
  const groups: { item: string; changes: FieldChange[] }[] = [];
  for (const change of changes) {
    const item = itemOfPath(change.path);
    const group = groups.find((g) => g.item === item);
    if (group) group.changes.push(change);
    else groups.push({ item, changes: [change] });
  }
  return groups;
}

export function DesignCompare({ document, tone }: { document: DesignCompareDocument; tone: Tone }) {
  const words = MARK[tone];
  return <>
    {byItem(document.changes).map((group) => (
      <div className="apv-section" key={group.item}>
        {/* An item's heading only where it has fields; a part with one value ('Notes') is its own row. */}
        {group.changes.some((c) => c.path !== group.item) && <div className="apv-sec-head"><span className="label-sm font-medium">{designFieldLabel(group.item)}</span></div>}
        {group.changes.map((change) => {
          const value = designValueText(change, tone);
          const mark = change.before === undefined
            ? words.added
            : change.after === undefined
              ? words.removed
              : words.changed;
          const shade = value === undefined ? 'apv-row-ghost' : tone === 'after' ? 'apv-changed' : 'apv-was';
          return <div className="apv-row" key={change.path}>
            <div className="apv-sec-head"><span className="label-sm">{designFieldLabel(change.path)}</span>{mark && <Mark tone={tone}>{mark}</Mark>}</div>
            <div className={`field apv-ro ${shade}`}>{value === undefined ? <span className="apv-muted">{words.ghost}</span> : value}</div>
          </div>;
        })}
      </div>
    ))}
  </>;
}
