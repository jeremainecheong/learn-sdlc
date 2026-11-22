'use client';

/**
 * What ⌘K finds on a document page.
 *
 * The palette in the design is not a list of routes: typing "overdue" answers
 * with the two criteria about overdue tasks, the function that has to satisfy
 * them, the contract that describes it and the hidden tests that are failing:
 * each with its outcome on the right. All of that is already on the project
 * map, so the groups are read off the map rather than derived a second time.
 *
 * The workspace builds its own groups from the phase it has open (the files it
 * can jump the editor to, the cases the last verdict ran); this is the version
 * for every page that has the project but no editor.
 */
import { useMemo } from 'react';
import type { EnrollmentView, ProjectMapData } from '@learnsdlc/shared';
import type { PaletteGroup, PaletteItem } from '@/components/shell/types';
import { briefHref } from '@/components/shell/routes';
import { FULL_MAP, useProjectMap } from './project-map';
import {
  fileReference,
  stateLabel,
  type MapNode,
  type MapNodeKind,
} from './map';

/** The right-aligned word: what pressing Enter on this row would do or show. */
function hintFor(node: MapNode): string {
  if (node.kind === 'criterion' || node.kind === 'test') {
    if (node.state === 'pass') return 'passing';
    if (node.state === 'fail') return 'failing';
    if (node.state === 'warn') return 'needs a decision';
    return node.kind === 'test' ? 'explain' : 'not yet';
  }
  if (node.kind === 'function') return 'open file';
  return 'open';
}

/**
 * Every node of these kinds, uncapped on purpose: the palette caps each group
 * for the eye AFTER the query has been applied (`Palette.visibleGroups`). A
 * cap here (of twelve, say) would leave a five-story backlog's criteria group
 * all US-1 and US-2, and typing "overdue" would find nothing.
 */
function rowsFor(
  nodes: MapNode[],
  kinds: MapNodeKind[],
  icon: PaletteItem['icon'],
): PaletteItem[] {
  return nodes
    .filter((n) => kinds.includes(n.kind) && n.kind !== 'placeholder')
    .map((n) => ({
      label: n.label,
      detail: n.sub || fileReference(n.file, n.line) || stateLabel(n.state, n.kind),
      hint: hintFor(n),
      icon,
      href: n.href,
      // The row shows one line; it answers to everything the node knows about
      // itself: its own id, the file it lives in, its kind. A criterion's
      // detail is its story, so without the file in the keywords a search for
      // the file's name would find nothing outside the IDE.
      keywords: [n.id, n.file, n.kind, n.sub].filter(Boolean).join(' '),
    }));
}

/**
 * Criteria / Code / Tests / Artefacts, in that order.
 * Groups with nothing in them are dropped rather than shown empty.
 *
 * The map is handed in rather than built here. It has to
 * be the UNFOLDED one: folding turns a story's four criteria into one block, so
 * typing "overdue" against a folded map finds a heading instead of the two
 * criteria about overdue tasks. Locked placeholders in it cost nothing:
 * `rowsFor` asks for no kind a placeholder has, and drops them again by name.
 */
export function projectPalette(
  enrollment: EnrollmentView | null,
  map: ProjectMapData | null,
): PaletteGroup[] {
  if (!enrollment || !map) return [];
  const nodes = map.nodes;
  return [
    { label: 'Criteria', items: rowsFor(nodes, ['criterion', 'story'], 'requirements') },
    {
      label: 'Code',
      items: [
        ...rowsFor(nodes, ['function'], 'code'),
        ...rowsFor(nodes, ['contract', 'decision'], 'design'),
      ],
    },
    { label: 'Tests', items: rowsFor(nodes, ['test', 'bug'], 'testing') },
    { label: 'Artefacts', items: rowsFor(nodes, ['file', 'change'], 'artefacts') },
  ].filter((g) => g.items.length > 0);
}

/**
 * {@link projectPalette}, memoised for a page that re-renders on every
 * keystroke, over whatever unfolded map is in memory.
 *
 * It never fetches: the rows are worth one request and nobody presses ⌘K in the
 * first seconds of a landing, so the request is made when the palette is opened
 * (`components/shell/Palette.tsx`) and the answer is kept for the session. Until
 * then the palette holds its phases and links, as it does for a learner with no
 * project at all.
 */
export function useProjectPalette(enrollment: EnrollmentView | null): PaletteGroup[] {
  const map = useProjectMap(enrollment?.projectSlug, FULL_MAP);
  return useMemo(
    () => [...briefPalette(enrollment), ...projectPalette(enrollment, map)],
    [enrollment, map],
  );
}

/**
 * The brief of the phase in hand: the way back to what this
 * stage is, what to do and how it is judged, from any page. It needs no map,
 * so it is there before the map is, and it is its own group so the map's
 * rows keep their own contract.
 */
export function briefPalette(enrollment: EnrollmentView | null): PaletteGroup[] {
  if (!enrollment || enrollment.completed) return [];
  const current = enrollment.phases.find((p) => p.order === enrollment.currentPhaseOrder);
  if (!current) return [];
  return [
    {
      label: 'This phase',
      items: [
        {
          label: `Brief: ${current.title}`,
          detail: 'What this stage is, what to do, how it is judged',
          hint: 'read',
          icon: 'doc',
          href: briefHref(current),
          keywords: 'brief stage what to do how it is judged begin',
        },
      ],
    },
  ];
}
