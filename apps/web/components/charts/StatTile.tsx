'use client';

import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

/**
 * One number with its label. `panel` stands on its own on the page; `flat` is
 * the tinted box that sits inside a section next to its siblings. The value
 * stays in ink unless the tone says the figure is good: colour is a mark, not
 * the typeface.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'accent',
  testId,
  variant = 'panel',
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: IconName;
  tone?: 'accent' | 'good' | 'muted';
  testId?: string;
  variant?: 'panel' | 'flat';
  children?: ReactNode;
}) {
  const iconTint =
    tone === 'good'
      ? 'bg-passtint text-pass'
      : tone === 'muted'
        ? variant === 'flat'
          ? 'bg-surface text-muted'
          : 'bg-raised text-muted'
        : 'bg-tint text-accent';
  const valueTone = tone === 'good' ? 'text-pass' : 'text-ink';
  const frame = variant === 'flat' ? 'rounded-lg bg-raised px-3.5 py-3' : 'panel p-4';

  return (
    <div className={`flex min-w-0 flex-col ${frame}`} data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] font-medium leading-tight text-muted">{label}</p>
        {icon && (
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconTint}`}>
            <Icon name={icon} size={15} />
          </span>
        )}
      </div>
      <p className={`mt-1.5 text-[24px] font-semibold leading-none tracking-[-0.02em] ${valueTone}`}>
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[12px] leading-tight text-muted">{hint}</p>}
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  );
}
