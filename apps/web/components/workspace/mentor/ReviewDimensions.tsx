'use client';

import { Fragment, useState } from 'react';
import { DIMENSION_LABEL, DIMENSION_ORDER, assessmentDimensions, unsupportedNote, type DimensionKey, type Finding } from './ExplanationFindings';
import { revealTarget, type InventoryLine, type RevealTarget } from './proposalInventory';

/**
 * The four dimensions in one line, by the long names the mentor's list uses,
 * in the order the checks run (`DIMENSION_ORDER`), so the overlay and the
 * mentor name one verdict one way.
 */
const ROW_ORDER: readonly DimensionKey[] = DIMENSION_ORDER;

/**
 * The explanation review's four dimensions as one compact row above the
 * overlay's explanation field, "What the change does: supported; Why it meets the request: not yet; …",
 * each a toggle for its detail, with the first one not met open: its full name,
 * the finding's label, the learner's own cited sentences and, when those name a
 * file of the proposal or a line, "Show the change", which brings that change
 * into view in the comparison above.
 *
 * It reports a review already stored and decides nothing: Apply is gated where
 * it always was. It writes nothing into the explanation field and suggests no
 * sentence; `reasoning` is never read (see ExplanationFindings).
 */
export function ReviewDimensions({ assessment, inventory, onShowChange }: {
  assessment: unknown;
  inventory: readonly Pick<InventoryLine, 'path' | 'label' | 'status'>[];
  onShowChange?: (target: RevealTarget) => void;
}) {
  const found = assessmentDimensions(assessment);
  const rows = ROW_ORDER.map(key => found.find(row => row.key === key)).filter((row): row is Finding => Boolean(row));
  const firstOpen = rows.find(row => !row.met)?.key ?? null;
  // The learner's own choice of what is open, kept per review: a new review opens its own first failed dimension.
  const signature = rows.map(row => `${row.key}:${row.met}:${row.finding ?? ''}`).join(',');
  const [choice, setChoice] = useState<{ signature: string; key: DimensionKey | null } | null>(null);
  const open = choice?.signature === signature ? choice.key : firstOpen;
  if (!rows.length) return null;
  const shown = rows.find(row => row.key === open);
  const target = shown && !shown.met ? revealTarget([...shown.quotes, shown.label ?? ''], inventory) : null;
  return <div className="apv-dims" data-testid="apv-review-dimensions">
    <p className="apv-dims-row" role="group" aria-label="The explanation review, dimension by dimension">
      {rows.map((row, index) => <Fragment key={row.key}>
        {index > 0 && <span aria-hidden="true">; </span>}
        <button type="button" className={`apv-dim ${row.met ? 'apv-dim-met' : 'apv-dim-open'}`} aria-expanded={open === row.key} data-dimension={row.key}
          onClick={() => setChoice({ signature, key: open === row.key ? null : row.key })}>
          {`${DIMENSION_LABEL[row.key]}: ${row.met ? 'supported' : 'not yet'}`}
        </button>
      </Fragment>)}
    </p>
    {shown && <div className="apv-dim-detail" data-testid="apv-dimension-detail" data-dimension={shown.key}>
      <p><strong>{DIMENSION_LABEL[shown.key]}</strong>{shown.label && <> <span className="apv-finding-label">{shown.label}</span></>}</p>
      {shown.quotes.length > 0
        ? <><p>{shown.quotes.length === 1 ? 'The sentence from your own explanation that the review looked at:' : 'The sentences from your own explanation that the review looked at:'}</p>{shown.quotes.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}</>
        : <p>The review cited no sentence of yours for this.</p>}
      {shown.finding === 'unsupported' && shown.label && <p>{unsupportedNote(shown.label)}</p>}
      {target && onShowChange && <button type="button" className="btn-secondary btn-sm" onClick={() => onShowChange(target)}>Show the change</button>}
    </div>}
  </div>;
}
