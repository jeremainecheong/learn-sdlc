"use client";

/**
 * The learner's own dossier, assembled in the browser.
 *
 * Nothing here is fetched. `useProject()` already holds the enrolment and
 * every phase's detail, `lib/records.ts` already holds the submissions, runs
 * and mentor exchanges, and the one extra request the page makes is the merged
 * revision's snapshot per phase: the document is assembled here rather than
 * asked of the API, because everything in it is already on this machine. (The
 * repository download is the exception: the API builds it, because a history
 * of every submission is not on this machine.)
 *
 * It derives nothing that already exists. The journal is `buildJournal`, the
 * one the journal page draws; the revisions are the ones the pull request
 * draws. The output is the same `LearnerDossier` the instructor's route
 * returns, so `<Dossier>` renders one shape and the two copies cannot drift.
 *
 * The single difference between the two is `audience`, and it decides one
 * thing: a learner's own copy quotes their mentor questions, because they are
 * theirs; an instructor's carries the count and no text.
 */
import type {
  DossierJournalRow,
  DossierPhase,
  EnrollmentView,
  LearnerDossier,
  PhaseDetail,
  SubmissionView,
  UserProfile,
} from "@learnsdlc/shared";
import type { PhaseRecords } from "@/lib/records";
import { buildJournal } from "@/components/journal/derive";
import { allPassed } from "@/lib/subset";
import type { CreditTask, PassKind, WithPassKind } from "@/lib/pass-kind";

/**
 * The merged revision's files, keyed by submission id. `null` is a revision
 * whose snapshot retention has pruned: a real answer, not a missing one.
 */
export type SnapshotMap = Record<string, Record<string, string> | null>;

/** The revision the phase was merged on: the newest one that passed. */
export function mergedRevision(
  submissions: SubmissionView[],
): SubmissionView | null {
  for (let i = submissions.length - 1; i >= 0; i -= 1) {
    if (submissions[i].verifiedPass === true) return submissions[i];
  }
  for (let i = submissions.length - 1; i >= 0; i -= 1) {
    if (submissions[i].passed === true) return submissions[i];
  }
  return null;
}

/** The submitted revision represented by the document's file listing. */
export function evidenceRevision(
  submissions: SubmissionView[],
): SubmissionView | null {
  return (
    mergedRevision(submissions) ?? submissions[submissions.length - 1] ?? null
  );
}

export function buildDossier(
  enrollment: EnrollmentView,
  details: Record<string, PhaseDetail>,
  records: Record<string, PhaseRecords>,
  snapshots: SnapshotMap,
  user: UserProfile | null,
  now = new Date(),
): LearnerDossier {
  // The board's phases carry `passKind` (this API's additive field).
  const ordered: (EnrollmentView["phases"][number] & WithPassKind)[] = [...enrollment.phases].sort((a, b) => a.order - b.order);
  const releases = enrollment.releases ?? [];

  const phases: (DossierPhase & { passKind?: PassKind; creditTasks?: CreditTask[] })[] = ordered.map((phase) => {
    const detail = details[phase.id];
    const records_ = records[phase.id];
    const revisions = records_?.submissions ?? [];
    const merged = mergedRevision(revisions);
    const evidence = evidenceRevision(revisions);
    const snapshot = evidence ? snapshots[evidence.id] : undefined;
    const editable = (detail?.files ?? []).filter((file) => file.editable);
    // A file listing represents one submitted snapshot. Missing source never
    // falls back to the current workspace or the content pack's starter files.
    const files =
      phase.status === "locked" || !snapshot
        ? []
        : Object.entries(snapshot).map(([path, content]) => ({
            path,
            content,
            language:
              editable.find((file) => file.path === path)?.language ?? "text",
          }));
    return {
      phaseStateId: phase.id,
      key: phase.key,
      order: phase.order,
      title: phase.title,
      status: phase.status,
      bestScore: phase.bestScore,
      attempts: phase.attempts,
      hints: (records_?.chat ?? []).filter((message) => message.role === "user")
        .length,
      passedAt: phase.passedAt,
      // The board's word on what kind of pass this is (reviewed, or a
      // teacher's credit alone), so the printed record says credit as credit.
      ...(phase.passKind ? { passKind: phase.passKind } : {}),
      // On a credit, the tasks the gate still wants.
      ...(phase.creditTasks ? { creditTasks: phase.creditTasks } : {}),
      files,
      revisions,
      merged,
      mergeMessage:
        releases.find((r) => r.phaseKey === phase.key)?.notes ??
        phase.reflection,
      drill: null,
      links: [],
      // Whether this learner has read the pack's
      // answer for the phase.
      solutionReadAt: detail?.solution?.readAt ?? null,
      // A design phase's stories, for the contradictions at merge, from the
      // phase spec of the version the enrolment holds: `PhaseDetail.design`
      // is that spec's own view (`phaseDetailDesign(phase.checks)`), the spec
      // the teacher's copy reads in `learnerDossier`, so both print the same.
      ...(detail?.design ? { designStories: detail.design.stories.map((story) => ({ ...story })), designContracts: { ...detail.design.contracts } } : {}),
      // A Maintenance's ticket, for section 9, from the same spec view
      // (`PhaseDetail.change`), as the teacher's copy reads `checks.ticket`.
      ...(detail?.change ? { changeTicket: { ...detail.change.ticket, acceptance: detail.change.ticket.acceptance.map((line) => ({ ...line })) } } : {}),
    };
  });

  const scored = phases
    .map((p) => p.bestScore)
    .filter((score): score is number => score != null);
  const journal: DossierJournalRow[] = buildJournal(
    enrollment,
    details,
    records,
  ).map((event) => ({
    at: event.at,
    phaseKey: event.phaseKey,
    kind: event.kind,
    title: event.title,
    detail: event.detail,
    result: event.result ?? null,
  }));

  return {
    audience: "learner",
    userId: user?.id ?? "",
    displayName: user?.displayName ?? "",
    email: user?.email ?? "",
    // The learner has no route that names their class: `/instructor/cohorts`
    // is staff-only and `UserProfile` carries the id, not the name. The cover
    // prints the class line only when there is a name for it, so a learner's
    // own copy simply does not carry that line.
    cohortName: null,
    projectSlug: enrollment.projectSlug,
    projectTitle: enrollment.projectTitle,
    // The enrolment carries it: without it the document's provenance block
    // would say "Not recorded" about a version the API holds.
    packVersion: enrollment.packVersion ?? null,
    startedAt: enrollment.startedAt,
    // Every phase of this project passed, each with a verified
    // revision: an imported status alone certifies nothing.
    completedAt:
      allPassed(phases) &&
      phases.every((p) => p.revisions.some((row) => row.verifiedPass === true))
        ? enrollment.completedAt
        : null,
    phasesPassed: phases.filter(
      (p) =>
        p.status === "passed" &&
        p.revisions.some((row) => row.verifiedPass === true),
    ).length,
    totalPhases: phases.length,
    averageScore: scored.length
      ? Math.round(
          scored.reduce((sum, score) => sum + score, 0) / scored.length,
        )
      : null,
    phases,
    releases,
    journal,
    generatedAt: now.toISOString(),
  };
}
