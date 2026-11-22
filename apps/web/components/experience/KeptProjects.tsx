'use client';

/**
 * The learner's other projects, and the doors into their record.
 *
 * A platform project set aside for a class's project
 * stays in the learner's record, and the notice on the Start card says so.
 * This is where that record is opened: the printable evidence and the
 * completion record of each project the learner holds besides the one they
 * are on, read by name and read only. Nothing here starts, moves or re-pins
 * anything; the dashboard still opens the project the server resolves.
 */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { ProjectMeta } from '@learnsdlc/shared';
import { keptCompletionHref, keptDossierHref } from '@/lib/record-project';
import { projectName } from '@/lib/project-name';

/** A project's name without the subtitle after its dash. */

export function KeptProjects({ projects, viewing }: { projects: ProjectMeta[]; viewing?: string }) {
  const shown = projects.filter((project) => project.slug !== viewing);
  if (!shown.length) return null;
  return (
    <section className="exp-panel print-hide" data-testid="kept-projects" aria-labelledby="kept-projects-heading">
      <span className="exp-eyebrow">Kept in your record</span>
      <h2 id="kept-projects-heading">Your other projects</h2>
      <p className="exp-caption">
        The work you did on these stays in your record. Your dashboard opens the project you are
        on now, and these open to read and print.
      </p>
      <ul className="exp-list">
        {shown.map((project) => (
          <li key={project.slug} data-testid={`kept-project-${project.slug}`}>
            <div>
              <strong>{projectName(project.title)}</strong>
              <div className="exp-actions">
                <Link className="exp-text-link" href={keptDossierHref(project.slug)}>
                  Printable evidence
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
                <Link className="exp-text-link" href={keptCompletionHref(project.slug)}>
                  Completion record
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
