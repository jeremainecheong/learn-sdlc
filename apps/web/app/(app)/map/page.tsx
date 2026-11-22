'use client';

/**
 * The map page: the whole project drawn full size, unfolded, every criterion
 * and every test its own block, the locked phases as placeholders. Home's
 * "Open the full map" leads here; selecting a block opens its phase's door,
 * as it does on Home.
 *
 * The drawing is the unfolded map `GET /projects/:slug/map` answers, the one
 * ⌘K already asks for (`FULL_MAP` in lib/project-map), so a learner who has
 * opened the palette has it in memory and the page draws at once. `loadMap`
 * never rejects: a failed request answers an empty map, which on a project
 * with phases can only be a failure, so the page says so and offers a retry.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProjectMapData } from '@learnsdlc/shared';
import { DocPage } from '@/components/shell/DocPage';
import { EmptyProject, ExperiencePage } from '@/components/experience/shared';
import { Button, EmptyState, Notice } from '@/components/ui';
import { ProjectMap } from '@/components/map/ProjectMap';
import { MapCard, MapFiguresRow, mapFigures } from '@/components/map/MapCard';
import { MapSkeleton } from '@/components/map/MapSkeleton';
import { useOpenMapNode } from '@/components/map/door';
import { FULL_MAP, loadMap, useProjectMap } from '@/lib/project-map';
import { projectName } from '@/lib/project-name';
import { useProject } from '@/lib/useProject';

export default function MapPage() {
  const { enrollment, details, slug, loading } = useProject();
  const mapSlug = enrollment ? slug : undefined;
  // The copy in memory, kept current by the map cache's own subscription.
  const held = useProjectMap(mapSlug, FULL_MAP);
  // What this page's own request answered: a failure is an empty map that the
  // cache never holds, so it is read from the answer rather than the cache.
  const [answer, setAnswer] = useState<ProjectMapData | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (!mapSlug) return;
    let live = true;
    void loadMap(mapSlug, FULL_MAP).then((d) => {
      if (live) setAnswer(d);
    });
    return () => {
      live = false;
    };
  }, [mapSlug]);
  const retry = useCallback(() => {
    if (!mapSlug) return;
    setRetrying(true);
    void loadMap(mapSlug, FULL_MAP, true).then((d) => {
      setAnswer(d);
      setRetrying(false);
    });
  }, [mapSlug]);

  const open = useOpenMapNode(enrollment, details);

  const name = projectName(enrollment?.projectTitle);
  const phases = enrollment?.phases.length ?? 0;
  const data = held ?? answer;
  const failed = !held && answer !== null && answer.nodes.length === 0 && phases > 0;

  // A learner with no project, and a project that failed to load (which
  // `useProject` reports as no enrolment with an error), see the product's one
  // start panel, as /artefacts and /progress do: it starts the first phase,
  // or says the sentence the API gave and offers Retry project.
  if (!loading && !enrollment) {
    return (
      <ExperiencePage title="Project map" eyebrow="Everything you build, one lane per phase" active="map">
        <EmptyProject />
      </ExperiencePage>
    );
  }

  let body: React.ReactNode;
  if (loading || (phases > 0 && !data)) {
    body = <MapSkeleton testId="project-map-loading" />;
  } else if (phases === 0) {
    body = (
      <EmptyState
        icon="map"
        title="This project has no phases yet."
        body="The map draws itself once your teacher adds the first phase and you write something in it."
        testId="project-map-empty"
      />
    );
  } else if (failed) {
    body = (
      <Notice tone="fail" testId="project-map-error">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span>The map could not be loaded. Check your connection, then try again.</span>
          <Button variant="secondary" size="sm" icon="refresh" onClick={retry} busy={retrying} busyLabel="Trying again">
            Try again
          </Button>
        </span>
      </Notice>
    );
  } else if (data && enrollment) {
    body = (
      <>
        <MapFiguresRow figures={mapFigures(data, enrollment)} />
        <ProjectMap
          enrollment={enrollment}
          details={details}
          data={data}
          fullTitles
          showLocked
          legend
          height={520}
          minWidth={960}
          onSelect={open}
        />
      </>
    );
  }

  return (
    <DocPage
      crumbs={[{ label: name || 'Overview', href: '/dashboard' }, { label: 'Project map' }]}
      active="map"
      title="Project map"
      purpose={`Everything you have written${name ? ` for ${name}` : ''}, one lane per phase, with a line from each promise to what builds it and what proves it. Select a block to open its phase.`}
      testId="project-map-page"
      titleTestId="map-title"
      right={
        <Button href="/dashboard" variant="secondary" size="sm" icon="arrow-left">
          Back to the overview
        </Button>
      }
    >
      <MapCard>{body}</MapCard>
    </DocPage>
  );
}
