'use client';

/**
 * The one row shape every list in this panel uses: a status square, a title,
 * a detail line under it and a right-aligned result. Anything extra (a select,
 * a chip strip) sits under the detail line so the row still reads as a
 * sentence at 390px. The row and its column headings are the maintenance
 * room's, which are the same shape; only the sub-heading is this room's own.
 */
import type { ReactNode } from 'react';

export { ListHead, ListRow } from '../maintenance/Rows';

/** A heading for a block inside a section whose body draws its own rows. */
export function SubHead({ title, purpose }: { title: ReactNode; purpose?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-4">
      <h3 className="group-title">{title}</h3>
      {purpose && <p className="purpose wrap">{purpose}</p>}
    </div>
  );
}
