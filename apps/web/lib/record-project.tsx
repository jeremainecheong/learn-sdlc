'use client';

/**
 * The learner's record pages, for a project the shell is not drawn around.
 *
 * A platform project a learner started is set aside when their class works
 * another one: the row is never deleted, its pin never
 * moves, and the learner is told "your work on it stays in your record". The
 * shell opens only the project the server resolves (rightly, since that is
 * the one they work on) so without this nothing in the learner's web could
 * open the record they were promised: the printable evidence and the
 * completion record read the shell's enrolment and nothing else.
 *
 * So the two record pages take `?project=<slug>`. A slug is honoured only when
 * it is one of the learner's **other** projects (`keptProjects`): an entry of
 * their own catalogue after the first, which the server lists because they
 * hold a row in it. Anything else (the current project, an unknown slug, any
 * member of staff) reads the shell's copy. The kept project
 * is read by name (`/enrollments/mine?project=`, `/phases/summaries?project=`)
 * and never becomes the shell's project: nothing is enrolled, nothing is
 * written, and the dashboard still opens the project the learner is in.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { EnrollmentView, PhaseDetail, ProjectMeta } from '@learnsdlc/shared';
import { api, describeError } from './api';
import { rememberTaskScopes } from './records';
import { useSession } from './session';
import { useProject } from './useProject';

/**
 * The projects in a learner's record that the shell is not drawn around.
 *
 * A learner's catalogue leads with the project the server resolves for them,
 * and lists after it every other project they hold an enrolment in: a
 * platform project set aside for their class's (marked `setAside`), or a
 * teacher's project from a class they have left. Staff read every published
 * project, so nothing in theirs is "kept".
 */
export function keptProjects(
  projects: ProjectMeta[] | undefined,
  slug: string | undefined,
  role: string | undefined,
): ProjectMeta[] {
  if (role !== 'LEARNER' || !projects?.length) return [];
  return projects.slice(1).filter((project) => project.slug !== slug);
}

/** The printable evidence and the completion record of a kept project. */
export const keptDossierHref = (slug: string) => `/dossier?project=${encodeURIComponent(slug)}`;
export const keptCompletionHref = (slug: string) => `/completion?project=${encodeURIComponent(slug)}`;

export interface RecordProject {
  enrollment: EnrollmentView | null;
  details: Record<string, PhaseDetail>;
  slug: string;
  loading: boolean;
  revalidating: boolean;
  error: string;
  reload: () => void | Promise<void>;
  /** The kept project the page is reading by name, or null for the shell's own. */
  kept: ProjectMeta | null;
  /** Every other project in the learner's record, for the links between them. */
  others: ProjectMeta[];
}

interface Read {
  slug: string;
  enrollment: EnrollmentView | null;
  details: Record<string, PhaseDetail>;
  error: string;
}

export function useRecordProject(): RecordProject {
  const shell = useProject();
  const user = useSession();
  const query = useSearchParams();
  const asked = query?.get('project') ?? '';
  const others = keptProjects(shell.projects, shell.slug, user?.role);
  const kept = asked ? (others.find((project) => project.slug === asked) ?? null) : null;
  const keptSlug = kept?.slug ?? '';
  const [read, setRead] = useState<Read | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!keptSlug) return;
    let live = true;
    void (async () => {
      try {
        const [found, loaded] = await Promise.all([
          api.myEnrollment(keptSlug),
          api.phaseSummaries(keptSlug),
        ]);
        const details: Record<string, PhaseDetail> = {};
        for (const detail of loaded) if (detail) details[detail.id] = detail;
        // The same statement the shell's own load makes: a split
        // phase's revisions are read per task, never on the phase-wide route.
        rememberTaskScopes(Object.values(details));
        const enrollment = found && (found as { id?: string }).id ? (found as EnrollmentView) : null;
        if (live) setRead({ slug: keptSlug, enrollment, details, error: '' });
      } catch (err) {
        if (live)
          setRead({
            slug: keptSlug,
            enrollment: null,
            details: {},
            error: describeError(err, 'The record of that project could not be read. Try again.'),
          });
      }
    })();
    return () => {
      live = false;
    };
  }, [keptSlug, revision]);

  if (!kept) {
    return {
      enrollment: shell.enrollment ?? null,
      details: shell.details ?? {},
      slug: shell.slug ?? '',
      loading: Boolean(shell.loading),
      revalidating: Boolean(shell.revalidating),
      error: shell.error ?? '',
      reload: shell.reload,
      kept: null,
      others,
    };
  }
  const ready = read?.slug === keptSlug ? read : null;
  return {
    enrollment: ready?.enrollment ?? null,
    details: ready?.details ?? {},
    slug: keptSlug,
    loading: !ready,
    revalidating: false,
    error: ready?.error ?? '',
    reload: () => setRevision((value) => value + 1),
    kept,
    others,
  };
}
