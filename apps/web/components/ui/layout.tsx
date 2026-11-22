'use client';

import Link from 'next/link';
import type { PhaseKey } from '@learnsdlc/shared';
import { Icon, type IconName } from '@/components/Icon';
import { phaseHue, phaseTint, type StatusState } from '@/lib/phase';
import { prefetchable } from './navigation';

/* ---------------------------------------------------------------------------
   Panel: surface, 1.5px edge, 10px radius.
--------------------------------------------------------------------------- */
export function Panel({
  children,
  className = '',
  testId,
  as: Tag = 'div',
  id,
}: {
  children?: React.ReactNode;
  className?: string;
  testId?: string;
  as?: 'div' | 'section' | 'article' | 'aside' | 'nav' | 'li' | 'form';
  id?: string;
}) {
  return (
    <Tag id={id} data-testid={testId} className={`panel min-w-0 ${className}`}>
      {children}
    </Tag>
  );
}

/* ---------------------------------------------------------------------------
   Section: a panel with a titled header. Title (14px semibold), a one-line
   purpose (13px muted) and a right slot. With icon + hue the header becomes a
   phase-tinted strip carrying a 32px icon tile.
--------------------------------------------------------------------------- */
export function Section({
  title,
  purpose,
  right,
  icon,
  hue,
  children,
  className = '',
  pad = true,
  testId,
  id,
  as = 'section',
}: {
  title: React.ReactNode;
  purpose?: React.ReactNode;
  right?: React.ReactNode;
  icon?: IconName;
  hue?: PhaseKey;
  children?: React.ReactNode;
  className?: string;
  /** Pad the body. Turn off for tables and lists that draw their own rows. */
  pad?: boolean;
  testId?: string;
  id?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  const strip = Boolean(icon);
  const tintStyle = strip ? { background: hue ? phaseTint(hue) : 'rgb(var(--c-tint))' } : undefined;
  const iconStyle = { color: hue ? phaseHue(hue) : 'rgb(var(--c-accent))' };
  return (
    <Panel as={as} className={`flex flex-col overflow-hidden ${className}`} testId={testId} id={id}>
      {/* The right slot wraps under the title when the two do not fit on one
          line (a phone, a long class name in a select), instead of running
          past the panel's overflow-hidden edge (/teacher's class select at
          390, for example). */}
      <header
        className={`flex flex-wrap items-start gap-3 ${strip ? 'border-b-1.5 border-edge px-4 py-3' : 'px-4 pt-4'}`}
        style={tintStyle}
      >
        {strip && icon && (
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl border-1.5 border-edge bg-surface"
            style={iconStyle}
          >
            <Icon name={icon} size={17} strokeWidth={1.7} />
          </span>
        )}
        <div className="flex min-w-[min(100%,12rem)] flex-1 flex-col gap-0.5">
          <h2 className="h3 wrap">{title}</h2>
          {purpose && <p className="purpose wrap">{purpose}</p>}
        </div>
        {right && <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2" data-section-right="">{right}</div>}
      </header>
      {/* One rhythm for every section body: children stack with a 4-unit gap,
          so pages never hand-space the blocks inside a section. */}
      <div className={`flex min-w-0 flex-1 flex-col gap-4 ${pad ? 'px-4 pb-4 pt-3' : strip ? '' : 'pt-3'}`}>
        {children}
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   EmptyState: a dashed box that says what would be here and how to get it.
--------------------------------------------------------------------------- */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className = '',
  testId,
}: {
  icon?: IconName;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={`flex flex-col items-start gap-2 rounded-ctl border-1.5 border-dashed border-edge2 px-4 py-4 ${className}`}
      data-testid={testId}
    >
      <div className="flex items-start gap-2.5">
        {icon && (
          <span className="mt-px inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted">
            <Icon name={icon} size={17} />
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[13.5px] font-semibold text-ink wrap">{title}</p>
          {body && <p className="purpose wrap">{body}</p>}
        </div>
      </div>
      {action && <div className={icon ? 'pl-[34px]' : ''}>{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Steps: ordered work, reason first. State drives the numeral tile.
--------------------------------------------------------------------------- */
export function Steps({
  items,
  className = '',
  testId,
}: {
  items: { title: React.ReactNode; detail?: React.ReactNode; state?: StatusState; meta?: React.ReactNode; href?: string }[];
  className?: string;
  testId?: string;
}) {
  return (
    <ol className={`m-0 flex list-none flex-col p-0 ${className}`} data-testid={testId}>
      {items.map((it, i) => {
        const st = it.state ?? 'todo';
        const tile =
          st === 'pass' || st === 'done'
            ? 'bg-pass text-onstatus'
            : st === 'fail'
              ? 'bg-fail text-onstatus'
              : st === 'warn'
                ? 'bg-warn text-onstatus'
                : st === 'now'
                  ? 'border-1.5 border-accent text-accent'
                  : 'border-1.5 border-edge2 text-muted';
        const body = (
          <>
            <span
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-chip text-[12px] font-bold tabular-nums ${tile}`}
              aria-hidden
            >
              {st === 'pass' || st === 'done' ? <Icon name="check" size={13} strokeWidth={2.4} /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={`wrap text-[13.5px] font-semibold ${
                  st === 'pass' || st === 'done' ? 'text-muted line-through' : 'text-ink'
                }`}
              >
                {it.title}
              </span>
              {it.detail && <span className="wrap text-[12.5px] leading-[1.4] text-ink2">{it.detail}</span>}
            </span>
            {it.meta && (
              <span className="mono wrap col-start-2 pt-0.5 text-[11.5px] text-muted sm:col-start-auto sm:text-right">
                {it.meta}
              </span>
            )}
          </>
        );
        const cls = 'grid grid-cols-[26px_1fr] gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[26px_1fr_auto]';
        return (
          <li key={i} className={`border-t-1.5 border-edge first:border-t-0`}>
            {it.href ? (
              <Link
                href={it.href}
                prefetch={prefetchable(it.href) ? undefined : false}
                className={`${cls} rounded-ctl hover:bg-raised`}
              >
                {body}
              </Link>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------------------
   Small helpers pages reach for often.
--------------------------------------------------------------------------- */

/** A hairline row separator inside a panel. */
export function Divider({ className = '' }: { className?: string }) {
  return <hr className={`m-0 border-0 border-t-1.5 border-edge ${className}`} />;
}

/** A tiny label + value pair, for detail lines. */
export function Detail({ label, children, className = '' }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className}`}>
      <span className="label-sm font-medium">{label}</span>
      <span className="wrap text-[13px] text-ink">{children}</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   SectionHead: a title, the one line saying what the list under it is for,
   and a right slot. Section uses it; lists inside a panel reach for it too.
--------------------------------------------------------------------------- */
export function SectionHead({
  title,
  purpose,
  right,
  className = '',
}: {
  title: React.ReactNode;
  purpose?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${className}`}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="h3 wrap">{title}</span>
        {purpose && <span className="purpose wrap">{purpose}</span>}
      </div>
      {right && <span className="flex shrink-0 items-center gap-2">{right}</span>}
    </div>
  );
}
