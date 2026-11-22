'use client';

import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Info, Maximize2, Minimize2, X } from 'lucide-react';
import './chat-surface.css';

type ReadingPosition = { element: HTMLElement; anchor?: Element; offset: number; top: number; bottom: boolean };
/** A surrounding workspace can retain the explicitly opened conversation when
 * a viewport change would otherwise hide its default side panel. */
export const ChatExpansionContext = createContext<(() => void) | null>(null);
function readingPositions(panel: HTMLElement): ReadingPosition[] {
  return Array.from(panel.querySelectorAll<HTMLElement>('[role="log"], .agentic-panel')).filter(element => element.clientHeight > 0).map(element => {
    const rect = element.getBoundingClientRect();
    const anchor = Array.from(element.children).find(child => child.getBoundingClientRect().bottom > rect.top + 1);
    return { element, anchor, offset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0, top: element.scrollTop, bottom: element.scrollHeight - element.scrollTop - element.clientHeight < 32 };
  });
}

/** Keep Tab within the active dialog; nested native dialogs own their keys. */
export function wrapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab' || (event.target instanceof Element && event.target.closest('dialog') !== event.currentTarget)) return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]'))
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

/** A nonmodal chat panel can enter the browser's modal top layer without
 * remounting its conversation, composer, or proposal editor. */
export function ChatSurface({ name, identity, details, children, className = '', testId, headerTestId, onClose }: {
  name: string;
  identity: ReactNode;
  details?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  headerTestId?: string;
  onClose?: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const onExpand = useContext(ChatExpansionContext);
  const expandButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const positions = useRef<{ compact?: ReadingPosition[]; expanded?: ReadingPosition[] }>({});
  const restore = useRef<ReadingPosition[]>([]);
  useLayoutEffect(() => {
    for (const saved of restore.current) {
      if (!saved.element.isConnected) continue;
      if (saved.bottom) saved.element.scrollTop = saved.element.scrollHeight;
      else if (saved.anchor?.isConnected) saved.element.scrollTop += saved.anchor.getBoundingClientRect().top - saved.element.getBoundingClientRect().top - saved.offset;
      else saved.element.scrollTop = saved.top;
    }
    restore.current = [];
  }, [expanded]);

  const resize = (next: boolean) => {
    const node = panel.current;
    if (!node) return;
    if (next) onExpand?.();
    const current = readingPositions(node);
    positions.current[expanded ? 'expanded' : 'compact'] = current;
    restore.current = positions.current[next ? 'expanded' : 'compact'] ?? current;
    // close/show changes native modality in place. React keeps the same tree,
    // so an in-flight reply and local unsent edits retain their owner.
    node.close();
    if (next) node.showModal();
    else node.show();
    setExpanded(next);
    expandButton.current?.focus({ preventScroll: true });
  };

  return <dialog
    open
    ref={panel}
    className={`chat-surface ${className}`}
    data-testid={testId}
    data-chat-expanded={expanded}
    aria-label={`${name} conversation`}
    aria-modal={expanded || undefined}
    onKeyDown={event => {
      if (!expanded || (event.target instanceof Element && event.target.closest('dialog') !== event.currentTarget)) return;
      if (event.key === 'Escape') event.stopPropagation();
      wrapDialogFocus(event);
    }}
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); resize(false); }}
  >
    <header className="chat-toolbar" data-testid={headerTestId}>
      <div className="chat-identity">{identity}</div>
      <div className="chat-toolbar-actions">
        {details && <button type="button" data-testid="chat-details-toggle" aria-label={`About ${name}`} title={`About ${name}`} aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}><Info size={17} aria-hidden="true" /></button>}
        <button type="button" ref={expandButton} data-testid="chat-expand" aria-label={`${expanded ? 'Restore' : 'Expand'} ${name} conversation`} title={expanded ? 'Return to the workspace' : 'Expand conversation'} aria-expanded={expanded} onClick={() => resize(!expanded)}>
          {expanded ? <Minimize2 size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
        </button>
        {onClose && <button type="button" aria-label="Close mentor" title="Close mentor" onClick={() => { if (expanded) resize(false); onClose(); }}><X size={17} aria-hidden="true" /></button>}
      </div>
    </header>
    {detailsOpen && <div id={detailsId} className="chat-details" data-testid="chat-details">{details}</div>}
    {children}
  </dialog>;
}
