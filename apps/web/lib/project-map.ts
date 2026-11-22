'use client';

/**
 * The project map, fetched rather than built.
 *
 * The map is a pure function of the enrolment and every open phase's files, so
 * the browser could build it, but that would mean the shell downloading every
 * open phase's whole workspace, the locked reference application included, on
 * the way to Home. For a learner three phases into TaskTrackr that is 133 KB of
 * files to draw 26 KB of graph, against a 60 KB landing budget
 * (e2e/render-cost.spec.ts). `GET /projects/:slug/map` answers with the graph,
 * built by the same `buildProjectMap` from `@learnsdlc/shared`, so what is
 * drawn is the same node for node.
 *
 * Two shapes are wanted and neither can be derived from the other, because
 * folding decides which nodes exist:
 *   - {@link CARD_MAP}, folded: Home's card. It is part of the project load
 *     (`lib/useProject`), so Home draws it in its first commit.
 *   - {@link FULL_MAP}, unfolded: ⌘K, whose Criteria group is twenty rows that
 *     the folded map has as four, and the map page. Nobody presses ⌘K in the
 *     first three seconds of a landing, so it is fetched when the palette is
 *     opened or the map page is visited, and kept for the session after that.
 *
 * Everything here is keyed by project and shape, held for the session, and
 * dropped when the learner or the project changes: the same bargain
 * `lib/records.ts` makes with the journal's records.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { ProjectMapData } from '@learnsdlc/shared';
import { api } from './api';
import { onSessionEnd, ownedByToken } from './session';

export interface MapShape {
  /** Fold given stories with their criteria, and tests under their function. */
  compact?: boolean;
  /** Draw locked phases as one "opens in phase N" placeholder each. Default true. */
  showLocked?: boolean;
}

/** What Home's card draws. */
export const CARD_MAP: MapShape = { compact: true, showLocked: true };
/**
 * What ⌘K reads and what the map page opens on. `showLocked` is true because
 * the palette never lists a placeholder (`projectPalette` asks for no kind a
 * placeholder has) so this one answer serves both, and the map page's default
 * view needs no second request.
 */
export const FULL_MAP: MapShape = { compact: false, showLocked: true };

/** How long a held copy is drawn without asking for a fresh one. */
export const FRESH_MS = 60_000;

interface Entry {
  value: ProjectMapData;
  at: number;
  /** Set by an invalidation: still drawn, no longer trusted. */
  stale?: boolean;
}

const shapeKey = (slug: string, shape: MapShape): string =>
  `${slug}|${shape.compact ? 1 : 0}|${shape.showLocked === false ? 0 : 1}`;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<ProjectMapData>>();

/**
 * Bumped by every invalidation. A fetch already in the air asked its question
 * before the change, so its answer is handed to whoever waits on it but is
 * never written into the cache over a newer one.
 */
let generation = 0;

/** A map belongs to one signed-in learner; a change of token drops the lot. */
const own = ownedByToken(() => {
  cache.clear();
  inflight.clear();
});

/* ------------------------------ the subscription -------------------------- */

let version = 0;
const bumps = new Set<() => void>();

function bump(): void {
  version += 1;
  bumps.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  bumps.add(fn);
  return () => {
    bumps.delete(fn);
  };
}

const isStale = (entry: Entry | undefined): boolean =>
  !entry || entry.stale === true || Date.now() - entry.at > FRESH_MS;

/* --------------------------------- reading -------------------------------- */

/** The copy in memory for this project and shape, or null when there is none. */
export function cachedMap(slug: string | undefined, shape: MapShape): ProjectMapData | null {
  if (!slug) return null;
  own();
  return cache.get(shapeKey(slug, shape))?.value ?? null;
}

/** Write a map somebody else fetched: the project loader's card map. */
export function putMap(slug: string, shape: MapShape, value: ProjectMapData): void {
  own();
  cache.set(shapeKey(slug, shape), { value, at: Date.now() });
  bump();
}

/**
 * Fetch this shape unless a fresh copy is already held. Never rejects: a map
 * that will not load is a section that does not draw, not a page that fails.
 */
export function loadMap(
  slug: string,
  shape: MapShape,
  force = false,
): Promise<ProjectMapData | null> {
  own();
  const key = shapeKey(slug, shape);
  const held = cache.get(key);
  if (held && !force && !isStale(held)) return Promise.resolve(held.value);
  const running = inflight.get(key);
  if (running) return running;
  const mine = generation;
  const p: Promise<ProjectMapData> = api
    .projectMap(slug, shape)
    .then((data) => {
      if (mine === generation) {
        cache.set(key, { value: data, at: Date.now() });
        bump();
      }
      return data;
    })
    .catch(() => held?.value ?? { nodes: [], edges: [] })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/**
 * Ask for the unfolded map, once, because something is about to read it: the
 * palette opening, or the map page mounting. Safe to call on every keystroke:
 * a held copy inside the minute costs nothing.
 */
export function ensureFullMap(slug: string | undefined): void {
  if (!slug) return;
  void loadMap(slug, FULL_MAP);
}

/* ------------------------------- invalidation ----------------------------- */

/**
 * What is held is a phase behind: after a save, a run, a submission or a
 * merge. The copies stay where they are so a page that mounts in the meantime
 * draws them rather than a skeleton; the next reader asks for a fresh one.
 *
 * Nothing is refetched from here on purpose. The map is drawn on two pages out
 * of eight, and a learner who has just submitted is looking at the workspace.
 */
export function staleMaps(): void {
  generation += 1;
  inflight.clear();
  cache.forEach((entry) => {
    entry.stale = true;
  });
  bump();
}

/** A different learner or a different project: what is held is somebody else's. */
export function resetMaps(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
  bump();
}

onSessionEnd(() => {
  generation += 1;
  cache.clear();
  inflight.clear();
});

/* ---------------------------------- hooks --------------------------------- */

/**
 * The map for this project and shape, fetched on mount when `eager` and drawn
 * from memory on every visit after that.
 *
 * It returns null until the first answer lands, which is what a caller draws a
 * skeleton for. Home does not use this: its card map comes down with the
 * project, so the card is in the page's first commit.
 */
export function useProjectMap(
  slug: string | undefined,
  shape: MapShape,
  eager = false,
): ProjectMapData | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const key = slug ? shapeKey(slug, shape) : '';
  useEffect(() => {
    if (!eager || !slug) return;
    void loadMap(slug, shape);
    // `shape` is a literal at every call site; the key is what identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eager, slug, key]);
  return cachedMap(slug, shape);
}
