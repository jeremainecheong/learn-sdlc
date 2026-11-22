'use client';

/**
 * Hands the browser a file to save.
 *
 * The one copy of the object-URL handling, shared by the repo zip, the class
 * export and the account export so they keep one revoke rule: the URL lives
 * until the next frame, because revoking it immediately can beat the download
 * in Safari.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/** The long class export's file name, the one the API's content-disposition gives it. */
export function exportFilename(project?: string): string {
  return `learnsdlc-grades${project ? `-${project}` : ''}.csv`;
}

/** The grade book's name, beside the long export's. One writer, two shapes. */
export function gradebookFilename(project?: string): string {
  return `learnsdlc-gradebook${project ? `-${project}` : ''}.csv`;
}

/**
 * The completion record's file name, for the project it is a record of. It
 * is built from the enrolment's own slug, never the default project's, kept
 * to the characters a file name can safely carry.
 */
export function projectRecordFilename(projectSlug: string): string {
  const safe = projectSlug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `learnsdlc-${safe || 'project'}-project-record.json`;
}
