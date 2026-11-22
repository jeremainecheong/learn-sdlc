'use client';

/**
 * What the page tells the shell.
 *
 * The bar and the sidebar are drawn once, in `app/(app)/layout.tsx`, above the
 * router, so they survive every navigation and nothing about them is rebuilt
 * when the page under them changes. That leaves the few things a page does
 * decide: which breadcrumbs the bar shows, which nav entry is lit, and the
 * extra rows this page offers to the palette. The sidebar's width is not on
 * that list (it is the learner's, kept in lib/sidebar.ts) because a page
 * that set it would make walking between two pages a snap of furniture.
 *
 * A page *declares* those in a layout effect rather than rendering them, so
 * the shell has them before the browser paints the new page. Everything else
 * the chrome needs (the phases, the current phase, the bell's count) is
 * derived from the project provider inside the shell, so a page never passes
 * it and it can never blink out between two pages that disagree.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';
import type { Crumb, NavKey, PaletteGroup } from './types';

/** Everything a page may say about the shell it is drawn in. */
export interface ShellConfig {
  /** Breadcrumbs in the top bar. The last one is the page and is not a link. */
  crumbs?: Crumb[];
  /** Which sidebar entry is lit. Defaults to the route. */
  active?: NavKey;
  /** Where the bell panel's foot link goes. Defaults to the current phase. */
  notificationsHref?: string;
  /** This page's palette rows: criteria, code, tests, artefacts. */
  paletteGroups?: PaletteGroup[];
}

interface ShellState {
  crumbs: Crumb[];
  active?: NavKey;
  notificationsHref?: string;
  /** Changes when the declared palette rows change, so the palette re-reads. */
  paletteSig: string;
}

const EMPTY: ShellState = { crumbs: [], paletteSig: '' };

interface ShellApi extends ShellState {
  declare: (id: string, config: ShellConfig) => void;
  release: (id: string) => void;
  /** The declared rows as they stand right now, callbacks and all. */
  groups: () => PaletteGroup[];
}

const ShellContext = createContext<ShellApi | null>(null);

/** Two declarations draw the same bar when these read the same. */
const crumbSig = (crumbs?: Crumb[]): string =>
  (crumbs ?? []).map((c) => `${c.label}/${c.href ?? ''}/${c.testId ?? ''}`).join(' > ');

/**
 * Palette rows carry callbacks, which are new objects on every render, so they
 * cannot be compared by identity. The labels are what the reader sees, so they
 * are what decides whether the list changed; the rows themselves are read
 * fresh from the ref at render time, so no callback is ever stale.
 */
const groupSig = (groups?: PaletteGroup[]): string =>
  (groups ?? []).map((g) => `${g.label}:${g.items.map((i) => i.label).join(',')}`).join('|');

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ShellState>(EMPTY);
  const groupsRef = useRef<PaletteGroup[]>([]);
  // Which page's declaration is on the screen. A page only clears the shell if
  // its own declaration is still the one showing: when one page replaces
  // another React unmounts the old one in the same commit that mounts the new,
  // and the loser must not wipe the winner's crumbs.
  const claim = useRef<string | null>(null);

  const declare = useCallback((id: string, config: ShellConfig) => {
    claim.current = id;
    groupsRef.current = config.paletteGroups ?? [];
    const next: ShellState = {
      crumbs: config.crumbs ?? [],
      active: config.active,
      notificationsHref: config.notificationsHref,
      paletteSig: groupSig(config.paletteGroups),
    };
    setState((was) =>
      was.active === next.active &&
      was.notificationsHref === next.notificationsHref &&
      was.paletteSig === next.paletteSig &&
      crumbSig(was.crumbs) === crumbSig(next.crumbs)
        ? was
        : next,
    );
  }, []);

  // Leaving clears what belonged to the page: its crumbs, its palette rows,
  // its bell link. `active` is dropped rather than kept: the route is a better
  // guess than the last page's answer.
  const release = useCallback((id: string) => {
    if (claim.current !== id) return;
    claim.current = null;
    groupsRef.current = [];
    setState((was) =>
      was.crumbs.length === 0 && !was.active && !was.notificationsHref && !was.paletteSig
        ? was
        : EMPTY,
    );
  }, []);

  const groups = useCallback(() => groupsRef.current, []);

  const value = useMemo<ShellApi>(
    () => ({ ...state, declare, release, groups }),
    [state, declare, release, groups],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

function useShellApi(): ShellApi | null {
  return useContext(ShellContext);
}

/** What the chrome should draw. Safe outside the provider: it draws the default. */
export function useShell(): ShellState {
  const api = useShellApi();
  return api ?? EMPTY;
}

/**
 * The palette rows the page has declared. Read through the provider's ref, so
 * the callbacks are this render's rather than the ones the signature was taken
 * from; the signature is what makes the palette re-render when they change.
 */
export function useDeclaredGroups(): PaletteGroup[] {
  const api = useShellApi();
  const sig = api?.paletteSig ?? '';
  // `sig` is the trigger; `groups()` is the value.
  return useMemo(() => api?.groups() ?? [], [api, sig]);
}

/**
 * Declare this page's shell. It runs before paint on every render (the
 * comparison is inside the provider, so re-declaring the same thing costs
 * nothing) and clears the declaration when the page unmounts.
 *
 * Outside a {@link ShellProvider} it is a no-op, so a component that renders
 * both inside and outside the signed-in shell still works.
 */
export function useShellConfig(config: ShellConfig): void {
  const api = useShellApi();
  const id = useId();
  const declare = api?.declare;
  const release = api?.release;

  useIsoLayoutEffect(() => {
    declare?.(id, config);
  });

  useEffect(
    () => () => {
      release?.(id);
    },
    [release, id],
  );
}
