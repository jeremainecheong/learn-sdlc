/**
 * The repository export: a learner's project as a git repository in a zip.
 */

import type { PhaseKey } from '../phases';

/* -------------------------- the repository export --------------------------
 *
 * The archive is loose git objects in a stored zip, written by the API with
 * `node:zlib` and `node:crypto` and no dependency at all. `git gc` in the
 * unzipped folder packs it; nothing in the product needs it packed.
 * ------------------------------------------------------------------------- */

/** The one branch an exported repository has. */
export const REPO_BRANCH = 'main';

/** The most the archive may weigh before the route refuses rather than truncates. */
export const REPO_EXPORT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * How many commits carry no files, said once so the API and the card agree.
 * The same fact the pull request states as "Files are not kept for this
 * revision.", in the words the archive uses.
 */
export const REPO_NO_FILES_LINE =
  'Files: not kept. Only the newest five revisions of a phase keep their files.';

/** `tasktrackr` -> `tasktrackr-repo.zip`. The API sends it and the client names the save. */
export function repoArchiveName(slug: string): string {
  const stem =
    String(slug || 'project')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project';
  return `${stem}-repo.zip`;
}

/** One tag in the exported history: a gate that was passed. */
export interface RepoTagView {
  /** v1 .. v6, the release's own version. */
  name: string;
  phaseKey: PhaseKey;
  phaseTitle: string;
  /** The merge message the learner wrote, or null when they wrote none. */
  message: string | null;
  /** True when the phase was passed by an instructor override rather than by a run. */
  overridden: boolean;
  createdAt: string;
}

/**
 * What the artefacts card says before anything is downloaded, so the button
 * can be honest about an empty repository and a learner knows what they are
 * asking for. Counts only: the archive itself is never assembled to answer
 * this, and no workspace snapshot is read.
 */
export interface RepoSummaryView {
  projectSlug: string;
  projectTitle: string;
  branch: string;
  /** Every commit the export would write, including the two bookends. */
  commits: number;
  /** Commits whose tree is their parent's, because the revision's files were pruned. */
  emptyCommits: number;
  tags: RepoTagView[];
  /** The newest commit's subject and phase, for the card's one line. Null when empty. */
  lastSubject: string | null;
  lastPhaseTitle: string | null;
  lastAt: string | null;
  /** The name the download will be saved under. */
  filename: string;
}

/** What one export actually wrote. Goes to the audit row, never to the client. */
export interface RepoExportResult {
  commits: number;
  tags: number;
  objects: number;
  bytes: number;
}
