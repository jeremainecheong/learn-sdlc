'use client';

import { useRef, type ReactNode, type RefObject } from 'react';
import { useDialogFocus } from '@/components/ui';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

/** The native top layer escapes the glass header's containing block and the
 * pinned sidebar. Both the panel and its backdrop belong to the viewport. */
export function ShellDialog({ open, onClose, label, children, className = '', testId, id, anchor, returnFocus }: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  id?: string;
  anchor?: RefObject<HTMLElement | null>;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const outsideDown = useRef(false);
  const trap = useDialogFocus(ref, open);
  useIsoLayoutEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const previous = returnFocus?.current ?? anchor?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    node.showModal();
    const position = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      node.style.setProperty('--shell-viewport-height', `${height}px`);
      const button = anchor?.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const top = Math.min(rect.bottom + 8, Math.max(12, height - 160));
      node.style.top = `${top}px`;
      node.style.left = `${Math.max(12, Math.min(rect.right - node.getBoundingClientRect().width, width - node.getBoundingClientRect().width - 12))}px`;
      node.style.maxHeight = `${Math.max(80, height - top - 12)}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      node.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open, anchor, returnFocus]);
  if (!open) return null;
  const outside = (x: number, y: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    return bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom);
  };
  return <dialog ref={ref} id={id} className={`shell-dialog ${anchor ? 'shell-dialog-anchored' : ''} ${className}`} data-testid={testId}
    aria-label={label} aria-modal="true"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { trap.onKeyDown(event); if (event.key === 'Escape') event.stopPropagation(); }}
    onPointerDown={event => { outsideDown.current = Boolean(event.target === event.currentTarget && outside(event.clientX, event.clientY)); }}
    onClick={event => { if (outsideDown.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose(); outsideDown.current = false; }}>
    {children}
  </dialog>;
}
