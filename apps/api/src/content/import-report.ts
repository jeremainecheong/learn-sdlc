import { describeCompilerDrift } from './content.service';
import type { ProjectContent } from './content.types';
import type { ImportResult } from './importer.service';

/*
 * What an import says: the boot's one line per pack, the first-publish pin
 * line, and the held-slug refusal and skip a platform import answers when a
 * teacher's project holds the pack's slug.
 */

/** The `import-pack` command's refusal for a pack whose slug a teacher's project holds. */
export function heldSlugRefusal(slug: string): string {
  return (
    `"${slug}": a teacher's project holds this slug, so the platform pack was not imported. ` +
    'Give the pack another slug and import it again.'
  );
}

/** The boot's one line for a pack skipped because a teacher's project holds its slug. */
export function heldSlugBootLine(slug: string): string {
  return `"${slug}": skipped; a teacher's project holds this slug, so the platform pack was not imported`;
}

/** What a platform import skipped for a held slug answers: the pack's name and nothing of the row. */
export function heldSlugResult(project: ProjectContent): ImportResult {
  return Object.freeze({
    outcome: 'skipped-held' as const,
    slug: project.slug,
    version: project.version,
    projectId: '',
    projectVersionId: '',
    contentDigest: '',
    sandboxBudget: 0,
    blobsWritten: 0,
    fileRows: 0,
    phaseRows: 0,
    compilerDrift: null,
  });
}

/** One line per pack, in the boot log's shape. */
export function describeImport(result: ImportResult): string {
  if (result.outcome === 'skipped-held') return heldSlugBootLine(result.slug);
  if (result.outcome === 'unchanged') {
    const same = `"${result.slug}" is at ${result.version}, already published from the same bytes`;
    // The drift rides on the line the operator is already reading, rather than
    // on a warning they would have to go looking for.
    return result.compilerDrift ? `${same}. ${describeCompilerDrift(result.compilerDrift)}` : same;
  }
  const what = result.outcome === 'draft-replaced' ? 'replaced the draft of' : 'imported';
  return (
    `${what} "${result.slug}" ${result.version} and published it: ${result.phaseRows} phases, ` +
    `${result.fileRows} files, ${result.blobsWritten} new blobs, ` +
    `${result.sandboxBudget} microVMs for one full pass`
  );
}

/** The line for the null rows an import pinned at its project's first publish, counts only; null when it pinned none. */
export function describeFirstPublishPins(result: ImportResult): string | null {
  if (result.outcome === 'skipped-held') return null;
  return result.pinnedFromNull ? `null pin: pinned ${result.pinnedFromNull} enrolment(s) waiting on this project's first version` : null;
}
