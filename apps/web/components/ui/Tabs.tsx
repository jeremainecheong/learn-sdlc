'use client';

import { useTabs } from './hooks';

/* ---------------------------------------------------------------------------
   Tabs: the underlined row. One shape wherever a panel has more than one face.
--------------------------------------------------------------------------- */
export function Tabs({
  items,
  value,
  onChange,
  className = '',
  fill = false,
  label,
  panelId,
}: {
  items: { key: string; label: React.ReactNode; testId?: string; count?: number }[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  /** Spread the tabs across the full width, as the IDE's right column does. */
  fill?: boolean;
  /** What this row of tabs is switching between, for a reader. */
  label?: string;
  /**
   * The `id` of the one panel the tabs switch, when the caller draws the panel
   * itself. Pair it with `<div {...tabPanelProps(panelId, ...)}>` so the tab
   * and the panel point at each other.
   */
  panelId?: string;
}) {
  const tabs = useTabs({
    keys: items.map((t) => t.key),
    value,
    onChange,
    controls: panelId,
    // With a panel named, the tab ids are derived from it, so the panel can
    // name the selected tab back without being handed a generated id.
    idBase: panelId,
    label,
  });
  return (
    <div {...tabs.tablistProps} className={`flex gap-1 border-b-1.5 border-edge ${className}`}>
      {items.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            {...tabs.tabProps(t.key)}
            data-testid={t.testId}
            className={`-mb-[1.5px] inline-flex items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
              fill ? 'flex-1' : 'shrink-0'
            } ${on ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
            {t.count !== undefined && <span className="mono text-[11.5px]">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The other half of `Tabs` when the caller draws its own panel: the roles and
 * the id that make the tab above it point at something real. `panelId` is the
 * same string given to `Tabs`; `selectedKey` is the tab currently on.
 */
export function tabPanelProps(panelId: string, selectedKey: string) {
  return {
    role: 'tabpanel' as const,
    id: panelId,
    'aria-labelledby': `${panelId}-tab-${selectedKey}`,
    tabIndex: 0,
  };
}
