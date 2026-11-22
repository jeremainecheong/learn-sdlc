import type { PhaseProvenanceView, PhaseSummary, PhaseTaskView, Role } from '@learnsdlc/shared';
import { placeOf } from '@learnsdlc/shared';
import { doorWithTasks, phaseDoorHref } from './routes';
import type { PaletteItem } from './types';

/**
 * The open phases' task lists, keyed by phase id, where the caller holds them.
 *
 * The shell does: `useProject` has fetched a detail for every open phase. Both
 * functions here take it last and optional, so the nav-only shell, which has
 * phase ids and nothing else, answers with the plain phase hrefs.
 *
 * The held detail's provenance rides along as `doorWithTasks`
 * reads it, so an interview-less Requirements phase opens its room.
 */
export type PhaseTaskMap = Record<string, { tasks?: readonly PhaseTaskView[]; provenance?: (Pick<PhaseProvenanceView, 'application'> & Partial<Pick<PhaseProvenanceView, 'interview'>>) | null } | undefined>;

/** Search uses the same destinations as the navigation. */
export function navigationItems(
  role: Role | undefined,
  phase?: PhaseSummary,
  viewingLearner = false,
  details?: PhaseTaskMap,
  /**
   * Whether the learner's project offers any lesson (`anyLessonsOffered`). A
   * caller that does not say gets the full list.
   */
  lessons = true,
): PaletteItem[] {
  const staff = role === 'INSTRUCTOR' || role === 'ADMIN';
  const learning = !staff || viewingLearner;
  return [
    ...(learning ? [
      { label: 'Overview', href: '/dashboard', icon: 'home' as const },
      { label: 'My project', href: phase ? phaseDoorHref(doorWithTasks(phase, details)) : '/dashboard', icon: 'code' as const },
      ...(lessons ? [{ label: 'Learn', detail: 'Optional phase guides', href: '/learn', icon: 'book' as const }] : []),
      { label: 'Progress', detail: 'Reviews, phase evidence and completion', href: '/progress', icon: 'chart' as const, keywords: 'portfolio artefacts history' },
      { label: 'Feedback', href: '/feedback', icon: 'explain' as const, keywords: 'reviews submissions' },
      { label: 'My classroom', href: '/classroom', icon: 'people' as const, keywords: 'join leave class membership' },
    ] : []),
    ...(staff ? [
      { label: 'My classes', href: '/teacher', icon: 'class' as const, keywords: 'teacher learners cohort overview' },
      { label: 'Projects', detail: 'Copy, edit, publish and assign', href: '/teacher/projects', icon: 'layers' as const, keywords: 'authoring library draft publish quiz task' },
    ] : []),
    ...(role === 'ADMIN' ? [{ label: 'Accounts', href: '/admin', icon: 'people' as const }] : []),
    { label: 'My profile', href: '/profile', icon: 'user', keywords: 'avatar name' },
    { label: 'Account settings', href: '/account', icon: 'sliders', keywords: 'password email' },
  ];
}

export function phaseItems(
  phases: PhaseSummary[],
  currentPhaseId?: string,
  details?: PhaseTaskMap,
): PaletteItem[] {
  // A phase's number is its place in the project, which holds the phases its
  // teacher chose.
  return phases.map(phase => ({
    label: `${placeOf({ phases }, phase.key)}. ${phase.title}`,
    place: placeOf({ phases }, phase.key),
    detail: phase.status === 'locked' ? 'Pass the earlier phases to unlock this workspace' : 'Project workspace',
    hint: phase.status === 'locked' ? 'locked' : phase.id === currentPhaseId ? 'current phase' : phase.status === 'passed' ? 'passed' : 'open',
    phaseKey: phase.key,
    disabled: phase.status === 'locked',
    href: phase.status === 'locked' ? undefined : phaseDoorHref(doorWithTasks(phase, details)),
  }));
}
