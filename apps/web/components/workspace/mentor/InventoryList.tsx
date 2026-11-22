'use client';

import { MISSING_NOTE, inventoryText, type InventoryLine } from './proposalInventory';

/**
 * One line per file a proposal holds and per document its request named that
 * it does not: "Design record (design/design.json): changed, 17
 * changes", "API contract (shared/contract/api.json): unchanged". A changed
 * line is a button when `onOpen` is given, opening the before/after comparison
 * at that file; a missing line says how to ask for the file. `withPath` is
 * false on a card that is no longer pending, which names the room's documents
 * by name alone, as its field summary does.
 */
export function InventoryList({ lines, withPath = true, applied = false, onOpen, disabled = false, className, testId, label = 'Files in this proposal' }: {
  lines: readonly InventoryLine[];
  /** The list's accessible name: a list of only the files a request asked for and the proposal lacks names itself so. */
  label?: string;
  withPath?: boolean;
  /** The receipt of an Apply: a file it saved without counting says so rather than pointing at a comparison. */
  applied?: boolean;
  onOpen?: (path: string) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  return <ul className={className} data-testid={testId} aria-label={label}>
    {lines.map(line => <li key={`${line.status}:${line.path}`} data-inventory-path={line.path} data-inventory-status={line.status}>
      {onOpen && (line.status === 'changed' || line.status === 'new')
        ? <button type="button" className="underline" disabled={disabled} onClick={() => onOpen(line.path)}>{inventoryText(line, withPath, applied)}</button>
        : <span>{inventoryText(line, withPath, applied)}</span>}
      {line.status === 'missing' && <small>{MISSING_NOTE}</small>}
    </li>)}
  </ul>;
}
