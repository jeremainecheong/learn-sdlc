'use client';

import Link from 'next/link';
import { Icon } from '@/components/Icon';

/**
 * Should Next prefetch this destination?
 *
 * Prefetching every link leaves many requests still in flight, and aborted,
 * when the learner navigates, and the aborted ones are workspace rooms: the
 * heaviest route in the product, always one press away, and one that loads its
 * own data on arrival anyway.
 * The sidebar's own rows already opt out; this is the same answer for every
 * link a page draws.
 */
export function prefetchable(href: string | undefined): boolean {
  return !(href ?? '').startsWith('/workspace/');
}

/* ---------------------------------------------------------------------------
   Breadcrumbs
--------------------------------------------------------------------------- */
export function Breadcrumbs({
  items,
  className = '',
}: {
  items: { label: React.ReactNode; href?: string }[];
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={`min-w-0 ${className}`}>
      <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1 p-0 text-[13.5px] font-medium text-ink2">
        {items.map((it, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && <Icon name="chevron-right" size={12} className="text-dim" />}
              {it.href && !last ? (
                <Link href={it.href} className="wrap rounded-sm hover:text-ink">
                  {it.label}
                </Link>
              ) : (
                <span className={`wrap ${last ? 'text-ink' : ''}`} aria-current={last ? 'page' : undefined}>
                  {it.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
