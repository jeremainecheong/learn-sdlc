import { EntityManager, In } from 'typeorm';
import type { DossierJournalRow, DossierPhase } from '@learnsdlc/shared';
import {
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
} from '../db/entities';
import { isoOrNull } from '../db/timestamps';

/**
 * The dossier's timeline, as a module of its own.
 *
 * It has two readers: the instructor's dossier and the repository export,
 * which writes the same rows into `docs/journal.md`. One behaviour, two
 * readers, and a jest test can reach it without standing up an instructor.
 */

/**
 * The run cap is the timeline's own: a term of runs is thousands of rows and
 * none of them is the record; the revisions are.
 */
const DOSSIER_RUN_CAP = 200;


/**
 * The timeline, newest first, as rows rather than as components.
 *
 * The mentor rows are the whole privacy line of this feature. They are built
 * from a query that selects the id, the phase and the time and nothing else,
 * so the text of a learner's question is not read out of the database on
 * this path at all: an instructor gets the count, and the reliance index the
 * console already gives them.
 */
export async function buildDossierJournal(
  manager: EntityManager,
  states: PhaseStateEntity[],
  phases: DossierPhase[],
  releases: ReleaseRecordEntity[],
  options: { submittedOnly?: boolean } = {},
): Promise<DossierJournalRow[]> {
  const rows: DossierJournalRow[] = [];
  const stateIds = states.map((state) => state.id);
  const titleOf = new Map(
    phases.map((phase) => [phase.phaseStateId, phase.title]),
  );
  const keyOf = new Map(states.map((state) => [state.id, state.phaseKey]));

  for (const phase of phases) {
    for (const revision of phase.revisions) {
      const report = revision.report;
      const score = report ? Math.round(report.overall) : null;
      rows.push({
        at: revision.createdAt,
        phaseKey: phase.key,
        kind: 'submission',
        title: `Revision ${revision.attempt ?? 1} of ${phase.title}`,
        detail: revision.commitMessage || 'No message',
        result:
          report == null
            ? revision.status === 'failed'
              ? 'Did not grade'
              : 'In review'
            : report.assessmentMode === 'strict_binary'
              ? report.passed
                ? 'Pass'
                : 'Needs revision'
              : report.passed
                ? `Historical Pass with ${score}`
                : `Historical score ${score} of ${report.passThreshold}`,
      });
    }
    if (phase.hints > 0) {
      rows.push({
        at:
          phase.passedAt ??
          phase.revisions[phase.revisions.length - 1]?.createdAt ??
          '',
        phaseKey: phase.key,
        kind: 'hint',
        // Counted, never quoted: an instructor's copy carries how often the
        // learner asked and the reliance index drawn from it, and none of
        // what was said. The learner's own copy quotes their questions,
        // because they are theirs.
        title: 'Asked the mentor',
        detail: '',
        result: `${phase.hints} ${phase.hints === 1 ? 'question' : 'questions'}`,
      });
    }
    const drill = phase.drill;
    if (drill) {
      rows.push({
        at: drill.pagedAt,
        phaseKey: phase.key,
        kind: 'drill',
        title: 'Paged for the incident drill',
        detail: drill.fault,
        result: 'Red',
      });
      if (drill.resolvedAt) {
        rows.push({
          at: drill.resolvedAt,
          phaseKey: phase.key,
          kind: 'drill',
          title: 'Closed the incident',
          detail: drill.incident?.rootCause ?? '',
          result: 'Green',
        });
      }
    }
  }

  // A decision the learner accepted is an event on the timeline. The record
  // lives in the phase's own workspace (design/design.json), so this is the
  // only place it can be read without a second query; the journal page is
  // handed phase summaries.
  for (const state of states) {
    const design = state.workspace?.['design/design.json'];
    if (!design) continue;
    let doc: { decisions?: Record<string, unknown>[] } = {};
    try {
      doc = JSON.parse(design) as typeof doc;
    } catch {
      // A learner can break this file by hand in the code pane. A broken
      // record is not an event, and it is not an error either.
      continue;
    }
    for (const decision of doc.decisions ?? []) {
      const at =
        typeof decision.decidedAt === 'string' ? decision.decidedAt : '';
      const choice =
        typeof decision.choice === 'string' ? decision.choice.trim() : '';
      // Only an accepted record with a date of its own is an event: one with
      // no `decidedAt` was never decided, and `now` would be a lie.
      if (decision.status !== 'accepted' || !at || !choice) continue;
      rows.push({
        at,
        phaseKey: state.phaseKey,
        kind: 'decision',
        title: `Decided ${String(decision.id)}: ${choice}`,
        detail:
          typeof decision.rationale === 'string' ? decision.rationale : '',
        result: 'Accepted',
      });
    }
  }

  for (const release of releases) {
    rows.push({
      at: isoOrNull(release.createdAt) ?? '',
      phaseKey: release.phaseKey,
      kind: 'release',
      title: `Merged ${titleOf.get(release.phaseStateId) ?? release.phaseKey} as ${release.version}`,
      detail: release.notes ?? '',
      result: 'Merged',
    });
  }

  if (stateIds.length && !options.submittedOnly) {
    const runs = await manager.find(ExecutionRunEntity, {
      where: { phaseStateId: In(stateIds), kind: 'run' },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: DOSSIER_RUN_CAP,
    });
    for (const run of runs) {
      const tests = run.result?.tests;
      rows.push({
        at: isoOrNull(run.createdAt) ?? '',
        phaseKey: keyOf.get(run.phaseStateId) ?? 'requirements',
        kind: 'run',
        title: tests
          ? `Visible suite: ${tests.passed} of ${tests.total}`
          : 'Ran the checks',
        detail: '',
        result: tests
          ? tests.failed === 0 && tests.errored === 0
            ? 'Passed'
            : 'Failed'
          : run.result?.ok
            ? 'Passed'
            : 'Failed',
      });
    }
  }

  return rows.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
}
