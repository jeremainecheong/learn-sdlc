'use client';

/**
 * The version's files, grouped by role.
 *
 * **No role control at all**, rather than a disabled one. A row's role is set
 * when the row is created and is never updated (the importer refuses a patch
 * that names `role`) so there is nothing here to disable, and a greyed picker
 * would be a promise that one day it will work.
 *
 * **The seal is decided here from the role**, not from whether `content`
 * arrived. The authoring API is written to send `null` for every row
 * `isAuthoringReadableRole` refuses, and this tree does not take that on
 * trust: a server that one day sends the bytes of a hidden suite still cannot
 * get them onto a teacher's screen.
 */
import { useState } from 'react';
import type { AuthoringFileView, ProjectFileRole } from '@learnsdlc/shared';
import {
  CANONICAL_FILE_NOTICE,
  PROJECT_FILE_ROLES,
  SEALED_FILE_NOTICE,
  isAuthoringReadableRole,
} from '@learnsdlc/shared';
import { Chip, EmptyState } from '@/components/ui';

/**
 * The one sentence the Files tab owes a teacher
 * about their reference solution. Mounting it read-only is legal (a later
 * phase may build on the finished code) and the tab says so rather than
 * leaving a teacher to find their solution in a learner's tree.
 */
export const SOLUTION_MOUNT_SENTENCE =
  'Your reference solution may also appear as a locked file a learner reads, such as the finished code a later phase builds on; it is never a file a learner is asked to edit.';

/**
 * The teacher's half of the learner rooms' hidden App preview. A phase that
 * does not run the reference project's application
 * (`PhaseProvenanceView.application` null, `runsReferenceApplication`) offers
 * no App preview, and the
 * Files tab says so rather than leaving a teacher to find out from a learner.
 */
export const APP_PREVIEW_NOT_OFFERED_SENTENCE =
  'In this release, App preview is not offered for an uploaded application or any other application of your own. Learners get the page preview instead: their page code runs in the browser with sample data, and their API does not run there.';

/** Bytes, the way a person reads them. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The sentence beside a row whose bytes are withheld, or none. */
function noticeFor(role: ProjectFileRole): string | null {
  if (isAuthoringReadableRole(role)) return null;
  return role === 'canonical' ? CANONICAL_FILE_NOTICE : SEALED_FILE_NOTICE;
}

function FileRow({ row }: { row: AuthoringFileView }) {
  const [open, setOpen] = useState(false);
  const notice = noticeFor(row.role);
  const readable = notice === null;
  const bytes = readable ? row.content : null;

  return (
    <li
      className="flex min-w-0 flex-col gap-1.5 border-b-1.5 border-edge px-4 py-3 last:border-b-0"
      data-testid={`project-file-${row.id}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="mono min-w-0 flex-1 truncate text-[12.5px] text-ink">{row.path}</span>
        <Chip tone={readable ? 'neutral' : 'outline'}>{row.role}</Chip>
        <span className="label-sm whitespace-nowrap">{size(row.size)}</span>
        {bytes !== null && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            data-testid={`project-file-open-${row.id}`}
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Hide contents' : 'Show contents'}
          </button>
        )}
      </div>
      {notice && (
        <p className="purpose wrap" data-testid={`project-file-notice-${row.id}`}>
          {notice}
        </p>
      )}
      {open && bytes !== null && (
        <pre
          className="mono m-0 max-h-64 overflow-auto rounded-ctl border-1.5 border-edge bg-raised p-3 text-[12px] leading-[1.5] text-ink"
          data-testid={`project-file-content-${row.id}`}
        >
          {bytes}
        </pre>
      )}
    </li>
  );
}

export function ProjectFiles({
  rows,
  previewOffered = true,
}: {
  rows: AuthoringFileView[];
  /** False when a phase of this version runs an application of the teacher's own. */
  previewOffered?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="file"
        title="No files in this version yet"
        body="A project copied from the library carries the files it was copied from."
        testId="project-files-empty"
      />
    );
  }

  const groups = PROJECT_FILE_ROLES.map((role) => ({
    role,
    rows: rows.filter((row) => row.role === role).sort((a, b) => a.path.localeCompare(b.path)),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="project-files">
      <p className="purpose wrap" data-testid="project-files-solution-mount">
        {SOLUTION_MOUNT_SENTENCE}
      </p>
      {!previewOffered && (
        <p className="purpose wrap" data-testid="project-files-preview-not-offered">
          {APP_PREVIEW_NOT_OFFERED_SENTENCE}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.role} className="min-w-0 rounded-ctl border-1.5 border-edge">
          <h3 className="m-0 border-b-1.5 border-edge px-4 py-2 text-[12px] font-medium text-muted">
            {group.role} ({group.rows.length})
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {group.rows.map((row) => (
              <FileRow key={row.id} row={row} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
