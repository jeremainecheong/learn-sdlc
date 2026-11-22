'use client';

/**
 * Home's project map: the whole project as the learner has built it so far,
 * one lane per phase, folded so a given story and its criteria are one block,
 * with the locked phases drawn as placeholders. Selecting a block opens its
 * phase's door.
 *
 * The drawing is the folded map the project loader already brings down with
 * the enrolment (`useProject().map`, built by the API from the same
 * `buildProjectMap` in `@learnsdlc/shared`), so Home asks for nothing more.
 * Where that answer is missing (its request failed) the same builder draws
 * the map here from the enrolment and the phase details the page holds.
 *
 * Its states: a skeleton while the project is on its way with neither a map
 * nor a phase detail in hand, an empty state when the project has no phases
 * yet, and nothing at all on a completed project whose map would be empty.
 */
import { useMemo } from 'react';
import type { EnrollmentView, PhaseDetail, ProjectMapData } from '@learnsdlc/shared';
import { Button, EmptyState } from '@/components/ui';
import { ProjectMap } from '@/components/map/ProjectMap';
import { MapCard, MapFiguresRow, mapFigures } from '@/components/map/MapCard';
import { MapSkeleton } from '@/components/map/MapSkeleton';
import { useOpenMapNode } from '@/components/map/door';
import { buildProjectMap } from '@/lib/map';
import { CARD_MAP } from '@/lib/project-map';
import { projectName } from '@/lib/project-name';

/**
 * The map built in the browser when the loader holds none. The details Home
 * holds are summaries, and a summary may lack a part the builder reads (a
 * maintenance phase's task panel, say); a map that cannot be built from them
 * is built from the enrolment alone, which still draws every locked phase,
 * rather than taking the page down with it.
 */
function drawnHere(enrollment: EnrollmentView, details: Record<string, PhaseDetail>): ProjectMapData {
  try {
    return buildProjectMap(enrollment, details, CARD_MAP);
  } catch {
    try {
      return buildProjectMap(enrollment, {}, CARD_MAP);
    } catch {
      return { nodes: [], edges: [] };
    }
  }
}

export function HomeProjectMap({
  enrollment,
  details,
  map,
  pending,
  done,
}: {
  enrollment: EnrollmentView;
  details: Record<string, PhaseDetail>;
  /** The folded map the project loader holds, or null when it has none. */
  map: ProjectMapData | null;
  /** Nothing is in hand to draw from yet, and the project is on its way. */
  pending: boolean;
  /** Every phase of the project has a verified pass. */
  done: boolean;
}) {
  const data = useMemo(() => map ?? drawnHere(enrollment, details), [map, enrollment, details]);
  const open = useOpenMapNode(enrollment, details);

  const phases = enrollment.phases.length;
  const empty = data.nodes.length === 0;
  if (done && empty) return null;

  const name = projectName(enrollment.projectTitle);
  const actions = (
    <Button href="/map" variant="secondary" size="sm" icon="expand" testId="home-project-map-open">
      Open the full map
    </Button>
  );

  return (
    <MapCard
      testId="home-project-map"
      title="Your project map"
      titleId="home-project-map-title"
      purpose={`Everything you have written${name ? ` for ${name}` : ''}, left to right by phase, with the lines between what you promised and what proves it. Select a block to open its phase.`}
      actions={actions}
    >
      {phases === 0 ? (
        <EmptyState
          icon="map"
          title="This project has no phases yet."
          body="The map draws itself once your teacher adds the first phase and you write something in it."
          testId="home-project-map-empty"
        />
      ) : !map && pending ? (
        <MapSkeleton testId="home-project-map-loading" />
      ) : (
        <>
          <MapFiguresRow figures={mapFigures(data, enrollment)} />
          <ProjectMap
            enrollment={enrollment}
            details={details}
            data={data}
            compact
            fullTitles
            showLocked
            legend
            height={280}
            onSelect={open}
          />
        </>
      )}
    </MapCard>
  );
}
