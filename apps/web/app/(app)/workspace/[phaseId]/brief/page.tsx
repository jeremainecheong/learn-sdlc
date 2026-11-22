'use client';

/**
 * The case file for one phase: the page every room's Brief link opens, and
 * an address that may be bookmarked. No door opens it: every way into a phase opens the
 * room, whose brief panel holds the same words under "Mission and review
 * criteria". Its button goes to the workspace, the room the door would open.
 *
 * A document page, so the sidebar is the full column and the reading width is
 * the frame's. It draws from the copy the shell already holds (the summary
 * detail has the intro, the objectives, the rubric and the file index, which
 * is everything the brief says), so arriving here from Start costs the one
 * load the shell was making anyway. When the shell holds nothing for the
 * phase (its one-request summary load has no view-as twin, so an instructor
 * viewing as a learner arrives with an empty cache; a cold load that lost
 * that request does too) the page asks for the phase itself, the way every
 * room does.
 */
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { PhaseDetail } from '@learnsdlc/shared';
import { Brief } from '@/components/phases/Brief';
import { PhaseDocumentFrame } from '@/components/workspace/PhaseDocumentFrame';
import { DocPage, roomHref } from '@/components/shell';
import { RetryNotice } from '@/components/shell/AppFrame';
import { Button, EmptyState } from '@/components/ui';
import { api, describeError } from '@/lib/api';
import { useProjectPalette } from '@/lib/palette';
import { useRecoverWhenBack } from '@/lib/poll';
import { railOf } from '@/lib/rail';
import { useProject } from '@/lib/useProject';
import { shortTitle } from '@/components/home/derive';

export default function BriefPage() {
  const { phaseId } = useParams<{ phaseId: string }>();
  const router = useRouter();
  const { enrollment, analytics, details, currentPhase, loading, error, reload } = useProject();
  const paletteGroups = useProjectPalette(enrollment);
  const nav = railOf(enrollment, analytics, currentPhase, paletteGroups);

  const phase = enrollment?.phases.find((p) => p.id === phaseId);

  /* ------------------------------- the phase ------------------------------- */

  // The shell's copy first; the page's own read only when the shell has none
  // once its load is over. The summary view is enough: the intro, the steps,
  // the rubric and the file index are all the brief draws.
  const [fetched, setFetched] = useState<PhaseDetail | null>(null);
  const [fetchError, setFetchError] = useState('');
  const [fetchAttempt, setFetchAttempt] = useState(0);
  const held = details[phaseId];
  const wantsOwnRead = Boolean(enrollment && phase && phase.status !== 'locked' && !held && !loading);
  useEffect(() => {
    if (!wantsOwnRead) return;
    let cancelled = false;
    setFetchError('');
    api
      .phaseSummary(phaseId)
      .then((d) => {
        if (!cancelled) setFetched(d);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(describeError(err, 'The brief did not load.'));
      });
    return () => {
      cancelled = true;
    };
  }, [wantsOwnRead, phaseId, fetchAttempt]);
  const detail = held ?? (fetched && fetched.id === phaseId ? fetched : undefined);
  const retryFetch = useCallback(() => setFetchAttempt((n) => n + 1), []);
  useRecoverWhenBack(Boolean(fetchError) && !detail, retryFetch);

  // A failed load is not an empty page, and it picks itself up.
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(() => {
    setRetrying(true);
    void reload().finally(() => setRetrying(false));
  }, [reload]);
  const failed = Boolean(error) && !enrollment;
  useRecoverWhenBack(failed, retry);

  /* ------------------------------ the workspace ----------------------------- */

  const begin = useCallback(() => {
    if (!phase) return;
    // The detail's provenance, check kind and change request ride along, so a
    // Maintenance opens the room `opensChangeRoom` names without the /change hop.
    router.push(roomHref({ ...phase, provenance: detail?.provenance, artifactKind: detail?.artifactKind, change: detail?.change }));
  }, [phase, detail, router]);

  /* --------------------------------- frame --------------------------------- */

  const project = enrollment ? shortTitle(enrollment.projectTitle) : '';
  const crumbs = [
    ...(project ? [{ label: project, href: '/dashboard', testId: 'back-dashboard' }] : []),
    ...(phase ? [{ label: phase.title, href: `/phases?phase=${phase.key}` }] : []),
    { label: phase && (phase.key === 'requirements' || phase.key === 'design') ? 'Case file' : 'Brief' },
  ];

  const frame = (children: React.ReactNode, tour = false) => phase && detail && phase.status !== 'locked' ? (
    <PhaseDocumentFrame phase={phase} view="brief" crumbs={crumbs} nav={nav} testId="brief-page" title="Project case file">{children}</PhaseDocumentFrame>
  ) : <DocPage crumbs={crumbs} active="work" nav={nav} testId="brief-page">{children}</DocPage>;

  if (failed) {
    return frame(
      <RetryNotice message={error} onRetry={retry} busy={retrying} testId="brief-error" />,
    );
  }

  if (!enrollment && loading) return frame(<BriefSkeleton />);

  if (enrollment && !phase) {
    return frame(
      <EmptyState
        icon="phases"
        title="This phase is not in your project"
        body="The address names a phase this project does not have. The phases page lists the ones it holds."
        action={<Button href="/phases" variant="secondary">Go to the phases</Button>}
        testId="brief-missing"
      />,
    );
  }

  if (!enrollment) {
    return frame(
      <EmptyState
        icon="phases"
        title="No project started yet"
        body="A brief belongs to a phase of a project. Start one from Home."
        action={<Button href="/dashboard" variant="secondary">Go home</Button>}
        testId="brief-missing"
      />,
    );
  }

  if (phase && phase.status === 'locked') {
    return frame(
      <EmptyState
        icon="lock"
        title={`${phase.title} is not open yet`}
        body="It opens when the phase before it passes its gate. The phases page says where you are."
        action={<Button href="/phases" variant="secondary">Go to the phases</Button>}
        testId="brief-locked"
      />,
    );
  }

  if (phase && !detail && fetchError) {
    return frame(<RetryNotice message={fetchError} onRetry={retryFetch} busy={false} testId="brief-error" />);
  }

  if (!phase || !detail) return frame(<BriefSkeleton />);

  return frame(
    <>
      <Brief
        phase={phase}
        detail={detail}
        onBegin={begin}
      />
    </>,
    true,
  );
}

/** The page's shape before data: the head row and five blocks, in the column. */
function BriefSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex min-w-0 flex-col gap-3.5" data-testid="brief-skeleton">
      <span className="sr-only">Loading the brief…</span>
      <div aria-hidden className="flex min-w-0 flex-col gap-3.5">
        <div className="flex items-center gap-3.5">
          <div className="h-14 w-14 rounded-ctl bg-raised" />
          <div className="flex flex-col gap-2">
            <div className="h-3 w-24 rounded-sm bg-raised" />
            <div className="h-6 w-56 rounded-sm bg-raised" />
          </div>
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="panel h-28 w-full max-w-[760px]" />
        ))}
      </div>
    </div>
  );
}
