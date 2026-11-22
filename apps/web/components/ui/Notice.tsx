'use client';

import { Icon, type IconName } from '@/components/Icon';

/* ---------------------------------------------------------------------------
   Notice: an inline message with a tone. Fail notices announce themselves.
--------------------------------------------------------------------------- */
export function Notice({
  tone = 'info',
  children,
  testId,
  role,
  className = '',
  icon,
}: {
  tone?: 'info' | 'fail' | 'warn' | 'pass';
  children: React.ReactNode;
  testId?: string;
  role?: React.AriaRole;
  className?: string;
  icon?: IconName | null;
}) {
  const cls =
    tone === 'fail'
      ? 'bg-failtint text-fail border-fail/30'
      : tone === 'warn'
        ? 'bg-warntint text-warn border-warn/30'
        : tone === 'pass'
          ? 'bg-passtint text-pass border-pass/30'
          : 'bg-tint text-accent border-accent/30';
  const glyph: IconName | null =
    icon === null
      ? null
      : (icon ?? (tone === 'fail' ? 'x-circle' : tone === 'warn' ? 'warn' : tone === 'pass' ? 'check-circle' : 'info'));
  return (
    <div
      className={`ui-notice flex items-start gap-2.5 rounded-ctl border-1.5 px-3 py-2.5 text-[13px] leading-[1.45] ${cls} ${className}`}
      data-testid={testId}
      role={role ?? (tone === 'fail' ? 'alert' : tone === 'warn' ? 'status' : undefined)}
    >
      {glyph && <Icon name={glyph} size={16} className="mt-px shrink-0" />}
      <div className="min-w-0 flex-1 wrap">{children}</div>
    </div>
  );
}
