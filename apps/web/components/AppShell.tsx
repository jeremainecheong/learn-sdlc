'use client';

/**
 * The frame a page that lays out its own body is drawn in.
 *
 * New pages use {@link DocPage} or {@link WorkPage} from '@/components/shell',
 * which own the column width and rhythm as well. This stays for the pages that
 * still bring their own `<main>`: the account, the class code, the admin
 * console and the completion record.
 *
 * Like the other two frames it does not draw the bar or the sidebar (those
 * are mounted once by `app/(app)/layout.tsx`): it only declares what it wants
 * of them and renders the scrolling column its children fill.
 */
import { useShellConfig } from './shell/ShellProvider';
import type { Crumb, NavKey, ShellNav } from './shell/types';

export function AppShell({
  active,
  crumbs,
  rail,
  children,
}: {
  active?: NavKey;
  crumbs?: Crumb[];
  /** Only `paletteGroups` and `notificationsHref` are still read; see DocPage. */
  rail?: ShellNav;
  children: React.ReactNode;
}) {
  useShellConfig({
    crumbs,
    active,
    notificationsHref: rail?.notificationsHref,
    paletteGroups: rail?.paletteGroups,
  });
  return <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>;
}
