import type { CohortExportEnrollment } from '@learnsdlc/shared';
import type { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';

/**
 * Which version an imported enrolment is pinned to, and the sentence for one
 * that cannot be held to it. Everything here runs before an import plans a
 * row, and nothing here writes.
 */

/**
 * The pinned version's compiled task list for one phase, or null where there is
 * none to have (teacher-authored projects).
 *
 * The one accessor, never `getTasks(slug, key)`: that is the **head's** list,
 * and composing it with a pinned board is two keyed structures that can
 * disagree in both directions. The catch is the doubt: a phase the resolved
 * version does not declare answers the loader's own 404, and a version this
 * build cannot grade is refused at the same seam. Neither is a shape this build
 * can produce, and neither is a reason to write a phase open.
 */
export function pinnedTasks(
  content: ContentService,
  pin: { projectSlug: string; projectVersionId: string | null },
  key: string,
): CompiledTask[] | null {
  try {
    return content.getTasksForEnrollment(pin, key);
  } catch {
    return null;
  }
}

/**
 * The version string an enrolment is resolved against, and whether the file
 * **asked** for it.
 *
 * `projectVersion` is the version-2 field and is the ask: an enrolment that
 * carries it was pinned on the machine that exported it, so a destination that
 * does not hold that version has nothing honest to pin the work to and says so
 * (`explicit`). `packVersion` is not an ask. It is provenance (the version
 * that stamped the submissions under the enrolment) and it is what a
 * version-1 file, which has no `projectVersion`, is *resolved by*; a
 * version-2 file whose enrolment was never pinned carries it too, with
 * `projectVersion: null`; an enrolment written where the deployment held no
 * version rows for the project, for which `writeEnrollment` stamps the
 * version and writes no pin.
 * So the two cannot share a refusal: reading `packVersion` as an ask would
 * leave the board, the submissions, the releases and the teacher's feedback in
 * the file for every pair of deployments that are not on the same head, which
 * is work this import can carry losslessly. Unresolved,
 * it is pinned to the installed head here and noted (`unpinnedVersions`).
 *
 * A file carrying neither field is pinned to the installed head, never refused
 * for a field it could not have had.
 */
export function versionWanted(
  enrollment: CohortExportEnrollment,
): { version: string | null; explicit: boolean } {
  const pinned = enrollment.projectVersion;
  if (typeof pinned === 'string' && pinned.trim()) {
    return { version: pinned.trim(), explicit: true };
  }
  const stamped = enrollment.packVersion;
  return {
    version:
      typeof stamped === 'string' && stamped.trim() ? stamped.trim() : null,
    explicit: false,
  };
}

/** An enrolment holding a phase key the version it would be pinned to lacks. */
const HOLDS_A_PHASE_ITS_VERSION_DOES_NOT =
  'This enrolment holds a phase its version does not, so it was not imported.';
/** A known project with no published version installed here to pin the work to. */
export const NO_VERSION_HERE =
  "This enrolment's project has no published version here, so it was not imported.";
/** Every key is the version's, and the orders are another version's. */
const NUMBERS_ITS_PHASES_DIFFERENTLY =
  'This enrolment numbers its phases differently from its version here, so it was not imported.';

/**
 * This project's installed head, by id, or null when this machine's registry
 * installed none: the version a null pin resolves to (the registry's head, a
 * published row with a compiled snapshot). A head this build cannot grade
 * leaves nothing to hold the enrolment to: `versionContent` answers null and
 * the enrolment stays in the file with `NO_VERSION_HERE`.
 */
export function installedHead(content: ContentService, slug: string): string | null {
  try {
    return content.resolveForEnrollment({ projectSlug: slug, projectVersionId: null })
      .versionId;
  } catch {
    return content.headVersionIdFor(slug);
  }
}

/**
 * Whether this machine's registry installed the published row `versionId`, so
 * a pin to it reads that version for good. A row with no compiled snapshot is
 * skipped by the registry and resolves to the head, so it is not held. A throw
 * is an installed version this build cannot grade: it is held, and
 * `versionContent` then leaves the enrolment in the file with `NO_VERSION_HERE`.
 */
export function registryHolds(
  content: ContentService,
  slug: string,
  versionId: string,
): boolean {
  try {
    return (
      content.resolveForEnrollment({ projectSlug: slug, projectVersionId: versionId })
        .versionId === versionId
    );
  } catch {
    return true;
  }
}

/**
 * What a pin to `versionId` is served: the version's content, or, for a row
 * this machine publishes but has no snapshot of, the head the reads fall back
 * to. Null when nothing can be read for it (a version this build cannot
 * grade), which leaves nothing to hold the enrolment to.
 */
export function versionContent(
  content: ContentService,
  slug: string,
  versionId: string,
): ProjectContent | null {
  try {
    return content.resolveForEnrollment({ projectSlug: slug, projectVersionId: versionId })
      .content;
  } catch {
    return null;
  }
}

/**
 * Holds an enrolment to the version it would be pinned to, before anything of
 * it is planned. The sentence when it cannot be:
 *
 * - a carried phase, or a release, names a phase key the version lacks;
 * - a carried phase's order is not the version's order for its key, a
 *   release's order is not its key's order there or is no carried phase's, or
 *   the current phase is no phase of the version.
 *
 * It never repairs an enrolment by order: the import writes the file's orders
 * and attaches releases by them, and the board matches states by order, so an
 * enrolment exported from a two-phase version (Implementation 1, Testing 2)
 * written against a six-phase one would read its work as Requirements' and
 * Design's. The shape check before it holds every order to LearnSDLC's six,
 * because it runs before any version is resolved; this holds it to the
 * version's own, so an order above the version's phase count is refused here.
 */
export function enrolmentRefusal(
  enrollment: CohortExportEnrollment,
  version: ProjectContent,
): string | null {
  const orderOf = new Map<string, number>(
    version.phases.map((phase) => [phase.key, phase.order]),
  );
  const phases = enrollment.phases ?? [];
  const releases = enrollment.releases ?? [];
  if (
    phases.some((phase) => !orderOf.has(phase.phaseKey)) ||
    releases.some((release) => !orderOf.has(release.phaseKey))
  ) {
    return HOLDS_A_PHASE_ITS_VERSION_DOES_NOT;
  }
  const carried = new Set(phases.map((phase) => phase.phaseOrder));
  const held = new Set(orderOf.values());
  // What the write stores when the file leaves it out.
  const current = enrollment.currentPhaseOrder ?? 1;
  if (
    phases.some((phase) => orderOf.get(phase.phaseKey) !== phase.phaseOrder) ||
    releases.some(
      (release) =>
        orderOf.get(release.phaseKey) !== release.phaseOrder ||
        !carried.has(release.phaseOrder),
    ) ||
    !held.has(current)
  ) {
    return NUMBERS_ITS_PHASES_DIFFERENTLY;
  }
  return null;
}
