'use client';

/**
 * A class's dates and the class-wide regrade, on the teacher portal.
 *
 * `SchedulePanel` (a release date and a due date per phase) and `RegradePanel`
 * (re-run a phase for every learner after a content fix) are drawn here
 * because `/instructor` redirects to `/teacher`; without this a teacher could
 * not set a class's dates or regrade a phase from any page the sidebar
 * reaches.
 *
 * Both are about ONE project: dates are stored per (class, project) and a
 * regrade is filed under a project. The projects offered are the ones this
 * view's learners are working and, on a class's own page, the project the
 * class was given, so a class whose learners have not started yet can still
 * be dated. Where there are several, the teacher picks one.
 *
 * A class nobody has started offers the phases its assignment names
 * (`CohortProjectAssignmentView.phases`), whoever owns the version. An
 * assignment that names none (a version with no phase rows here, or a
 * response without the list) offers nothing to date until a learner starts the
 * project: LearnSDLC's six never stand in for a project's own phases.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PhaseKey } from '@learnsdlc/shared';
import { PHASE_TITLES } from '@learnsdlc/shared';
import { instructorApi } from '@/lib/api-instructor';
import { RegradePanel } from '@/components/staff/RegradePanel';
import { SchedulePanel } from '@/components/staff/SchedulePanel';

/** A project the panels can be about, with the phase titles its learners read. */
export interface ClassLeverProject {
  slug: string;
  title: string;
  phases: { key: PhaseKey; title: string }[];
}

/** The phases a project nobody has started holds, by the product's own titles. */
const phasesOf = (keys: readonly PhaseKey[]) => keys.map((key) => ({ key, title: PHASE_TITLES[key] }));

export function ClassLevers({
  cohortId,
  assignmentRound = 0,
  projects,
  onRegraded,
  onOpenProject,
}: {
  /** The class on screen, on a class's own page; absent on the view across classes. */
  cohortId?: string;
  /** Moves when the class is given another version on this page, so its assignment is read again. */
  assignmentRound?: number;
  /** The projects this view's learners are working, in the order they appear. */
  projects: ClassLeverProject[];
  onRegraded?: () => void;
  /** Opens the class page's Project tab, where a project is given (drawn only on a class's own page). */
  onOpenProject?: () => void;
}) {
  const [assigned, setAssigned] = useState<ClassLeverProject | null>(null);
  useEffect(() => {
    setAssigned(null);
    if (!cohortId) return;
    let alive = true;
    instructorApi
      .classProject(cohortId)
      .then((view) => {
        // The version the class is on, and the phases its assignment names.
        const keys = view.active?.phases;
        if (alive && view.active && keys?.length) setAssigned({ slug: view.active.projectSlug, title: view.active.projectTitle, phases: phasesOf(keys) });
      })
      // A class whose assignment cannot be read still has its learners' projects.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cohortId, assignmentRound]);

  const options = useMemo(() => {
    const seen = new Map<string, ClassLeverProject>();
    for (const project of [...(assigned ? [assigned] : []), ...projects]) {
      const held = seen.get(project.slug);
      // A learner's own phases, where one has started the project, are the
      // ones they read; the assigned version's stand in until then.
      if (!held) seen.set(project.slug, project);
      else if (held === assigned) seen.set(project.slug, { ...held, phases: project.phases });
    }
    return [...seen.values()];
  }, [assigned, projects]);

  const [chosen, setChosen] = useState('');
  const project = options.find((one) => one.slug === chosen) ?? options[0];

  return (
    <section className="exp-stack" data-testid="class-levers" aria-label="Dates and regrades">
      <header className="exp-section-heading">
        <div>
          <span className="exp-eyebrow">For the whole class</span>
          <h2>Dates and regrades</h2>
          <p>Set when each phase opens and is due, or re-run a phase for every learner after a content fix.</p>
        </div>
        {options.length > 1 && (
          <label className="exp-field">
            Project
            <select
              value={project?.slug ?? ''}
              data-testid="class-levers-project"
              onChange={(event) => setChosen(event.target.value)}
            >
              {options.map((one) => (
                <option key={one.slug} value={one.slug}>
                  {one.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {project ? (
        <>
          <SchedulePanel
            key={`schedule-${project.slug}`}
            projectSlug={project.slug}
            phases={project.phases}
            preferCohortId={cohortId}
          />
          <RegradePanel
            key={`regrade-${project.slug}`}
            projectSlug={project.slug}
            phases={project.phases}
            onFinished={onRegraded}
          />
        </>
      ) : (
        // A card like the other tabs' panels, not a caption on the page's ground.
        <div className="exp-panel exp-levers-empty" data-testid="class-levers-empty-card">
          <p data-testid="class-levers-empty">
            Dates and regrades are set per project. They appear here once this class is given a project or a
            learner starts one.
          </p>
          {onOpenProject && (
            <div className="exp-actions">
              <button type="button" className="exp-button" data-testid="class-levers-open-project" onClick={onOpenProject}>
                Give this class a project
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
