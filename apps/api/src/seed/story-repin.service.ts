import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, Like } from 'typeorm';
import { PHASE_ORDER, PHASE_TITLES, compareProjectVersions, type DrillState, type PhaseKey } from '@learnsdlc/shared';
import { digestOf } from '../content/blob.store';
import type { CompiledSnapshot } from '../content/pack-compiler';
import {
  AuditEventEntity,
  CohortProjectAssignmentEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SettingEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { recordAudit } from '../audit/audit';
import { IN_LIST_BATCH } from '../db/batches';
import { appendRun, readReceipt } from './receipts';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { requirementsGrading } from '../content/requirements-grading';
import { isOlderFormat, isStructured, phaseChecksOf, retiredWrittenPhases, type OlderFormatKey } from '../content/phase-grading';
import { ASSIGNMENT_ACTIVE, ASSIGNMENT_SUPERSEDED } from '../classroom/cohort-project.service';
import { LEGACY_STORY_MARKDOWN, STORY_MIGRATION_RECEIPT_KEY, convertWorkspace } from '../migrations/story-records/story-records';
import { DESIGN_MIGRATION_RECEIPT_KEY, LEGACY_DESIGN_FILES, convertDesignWorkspace, legacyDesignSourcesOf } from '../migrations/design-records/design-records';
import { CHANGE_MIGRATION_RECEIPT_KEY, LEGACY_CHANGELOG_FILE, convertChangeWorkspace, legacyChangeSourcesOf } from '../migrations/change-records/change-records';
import {
  LEGACY_RUNBOOK_FILE, RUNBOOK_MIGRATION_RECEIPT_KEY, convertRunbookWorkspace, drillIncidentOf, legacyRunbookSourcesOf, templateOnlyFiles,
} from '../migrations/runbook-records/runbook-records';

/**
 * Written when a run has finished with nothing left for a later one. A later
 * boot runs again only when a version was published after it (a teacher's
 * converted republish, a new platform release), so the re-pin is one-time per
 * publish rather than once for ever.
 */
export const STORY_REPIN_DONE_KEY = 'story-model.repin.done';

/**
 * One phase whose older form the re-pin converts away from: how a version
 * grades it in the older form and in the structured form, how to tell an
 * older workspace, where its receipt goes, and the conversion itself. Keyed
 * to the four structured phases (`OlderFormatKey`): a phase under any other
 * key is never swept.
 */
export interface StructuredPhaseRule {
  phaseKey: OlderFormatKey;
  /** The version grades this phase in the older form: the markdown kind, a config Deployment with no runbook, a code Maintenance with no change request. */
  older(compiled: CompiledSnapshot | null): boolean;
  /** The version grades this phase's structured form. */
  structured(compiled: CompiledSnapshot | null): boolean;
  /** A workspace key whose presence means the workspace is still in the older format. */
  legacyMarker: string;
  /**
   * Whether the in-place pass reads every state of the phase rather than only
   * those holding `legacyMarker`: a Design record can be in the older shape
   * with no design page beside it, which no key names, so each one is asked
   * (`convertDesignWorkspace` returns `untouched` for a record already in the
   * new shape).
   */
  inPlaceEveryState?: boolean;
  receiptKey: string;
  /** Named in each audit row's `detail.reason`, joined with `; ` when two phases move together. */
  reason: string;
  /**
   * Pure: the workspace converted, or the identical object back with `refused`
   * and the reason. `pinned` is the version the learner's workspace was
   * written under, `head` the version it will be graded by, `state` what else
   * the phase state holds that the conversion reads (the Deployment drill,
   * whose incident goes into the runbook record; the drill itself is never
   * written).
   */
  convert(
    workspace: Record<string, string>,
    pinned: CompiledSnapshot | null,
    head: CompiledSnapshot | null,
    state: { drill: DrillState | null },
  ): { workspace: Record<string, string>; outcome: string; reason?: string };
  /**
   * The learner-written files the pinned version names in this workspace that
   * hold only that version's template (`templateOnlyFiles`). A move whose
   * conversion comes back `untouched` drops them in its savepoint, outcome
   * `template-dropped`: they hold no word of the learner's, and once the
   * learner is on the head, a later in-place run would read them under the
   * head's fallback template, not their own.
   */
  templateOnly?(workspace: Record<string, string>, pinned: CompiledSnapshot | null): string[];
}

/** The version's design page template (`design/my-design.md` in its Design phase), when its snapshot carries one. */
function designTemplateOf(compiled: CompiledSnapshot | null): string | undefined {
  const phase = compiled?.content?.phases?.find((one) => one.key === 'design');
  const page = (Array.isArray(phase?.files) ? phase.files : []).find((file) => file?.path === LEGACY_DESIGN_FILES[0]);
  return typeof page?.content === 'string' ? page.content : undefined;
}

/** The version grades this phase in its older form (`isOlderFormat`). */
const olderOf = (key: OlderFormatKey) => (compiled: CompiledSnapshot | null) => isOlderFormat(key, phaseChecksOf(compiled, key));
/** The version grades this phase's structured form (`isStructured`). */
const structuredOf = (key: OlderFormatKey) => (compiled: CompiledSnapshot | null) => isStructured(key, phaseChecksOf(compiled, key));

/**
 * Requirements, Design, Deployment, then Maintenance. Each conversion is its
 * migration's own (`convertWorkspace` of `migrations/story-records`,
 * `convertDesignWorkspace` of `migrations/design-records`,
 * `convertRunbookWorkspace` of `migrations/runbook-records` and
 * `convertChangeWorkspace` of `migrations/change-records`), which
 * refuses what would cut a learner's words, a file that is not text, an
 * unreadable record, or notes past the cap: the re-pin never cuts what the
 * migration would not.
 */
export const STRUCTURED_PHASE_RULES: readonly StructuredPhaseRule[] = [
  {
    phaseKey: 'requirements', older: olderOf('requirements'), structured: structuredOf('requirements'),
    legacyMarker: LEGACY_STORY_MARKDOWN, receiptKey: STORY_MIGRATION_RECEIPT_KEY, reason: 'requirements story model',
    convert: (workspace, _pinned, head) => convertWorkspace(workspace, { storyId: requirementsGrading(head).storyId }),
  },
  {
    phaseKey: 'design', older: olderOf('design'), structured: structuredOf('design'),
    legacyMarker: LEGACY_DESIGN_FILES[0], inPlaceEveryState: true, receiptKey: DESIGN_MIGRATION_RECEIPT_KEY, reason: 'design record model',
    // The pinned version names the learner's files (its Design task targets and editable mounts) and the read-only ones.
    convert: (workspace, pinned) => convertDesignWorkspace(workspace, { ...legacyDesignSourcesOf(pinned), templateMarkdown: designTemplateOf(pinned) }),
  },
  {
    phaseKey: 'deployment', older: olderOf('deployment'), structured: structuredOf('deployment'),
    legacyMarker: LEGACY_RUNBOOK_FILE, inPlaceEveryState: true, receiptKey: RUNBOOK_MIGRATION_RECEIPT_KEY, reason: 'deployment runbook document',
    // The pinned version names the learner's files; the head's starting runbook is what a template-only workspace with a drill incident is seeded from.
    // The drill's incident is normalised first (`drillIncidentOf`, the migration's own): an unreadable one is none and a field that is not text is empty, never a throw.
    convert: (workspace, pinned, head, state) =>
      convertRunbookWorkspace(workspace, { ...legacyRunbookSourcesOf(pinned), drillIncident: drillIncidentOf(state.drill), headStarting: legacyRunbookSourcesOf(head)?.starting }),
    templateOnly: (workspace, pinned) => templateOnlyFiles(workspace, legacyRunbookSourcesOf(pinned), LEGACY_RUNBOOK_FILE),
  },
  {
    phaseKey: 'maintenance', older: olderOf('maintenance'), structured: structuredOf('maintenance'),
    legacyMarker: LEGACY_CHANGELOG_FILE, inPlaceEveryState: true, receiptKey: CHANGE_MIGRATION_RECEIPT_KEY, reason: 'maintenance change document',
    // A workspace with no CHANGELOG.md keeps the head's starting record: the conversion builds on the version's own scaffold.
    convert: (workspace, pinned, head) => convertChangeWorkspace(workspace, { ...legacyChangeSourcesOf(pinned), starting: legacyChangeSourcesOf(head)?.starting }),
    templateOnly: (workspace, pinned) => templateOnlyFiles(workspace, legacyChangeSourcesOf(pinned), LEGACY_CHANGELOG_FILE),
  },
];

/** What the class panel says a moved assignment's version holds, per phase moved. */
const RECORD_PHRASE: Record<OlderFormatKey, string> = {
  requirements: 'Requirements is a story record',
  design: 'Design is a design record',
  deployment: 'Deployment is a runbook record',
  maintenance: 'Maintenance is a change request record',
};
/**
 * The reason on the assignment row the re-pin writes; the class panel shows it
 * beside the actor. A retired written phase is named as one the head no
 * longer holds in writing.
 */
const assignmentReason = (title: string, rules: readonly StructuredPhaseRule[], retired: readonly PhaseKey[] = []) =>
  `Moved by the platform to the ${title} version whose ${[
    ...rules.map((rule) => RECORD_PHRASE[rule.phaseKey]),
    ...retired.map((key) => `${PHASE_TITLES[key]} is no longer a written phase`),
  ].join(' and whose ')}`;
/** The audit row's `detail.reason` for a retired written phase the move leaves unconverted. */
export const retiredWrittenReason = (key: PhaseKey) => `retired written ${key} phase, its files kept unconverted`;
/** Each audit row's `detail.reason`: the converted phases, then the retired written ones, joined with `; `. */
const reasonOf = (rules: readonly StructuredPhaseRule[], retired: readonly PhaseKey[] = []) =>
  [...rules.map((rule) => rule.reason), ...retired.map(retiredWrittenReason)].join('; ');
/** The outcome an audit row's `conversion` names for a retired written phase: nothing converts it. */
export const RETIRED_WRITTEN_OUTCOME = 'kept-unconverted';
/**
 * The `detail.reason` of the `enrolment.repin` row a retired-only move writes
 * when its row could not be written: such a move converts no phase, so no
 * receipt section holds its refusal, and this row is where it is recorded.
 */
export const RETIRED_MOVE_FAILED = 'the move off the retired written phase failed, so nothing moved';

/** The phase keys a version holds, retired and dropped phases included. */
const phaseKeysOf = (compiled: CompiledSnapshot | null): string[] => (compiled?.content?.phases ?? []).map((one) => one.key);
/** A key's place in LearnSDLC's order; a key outside it sorts last. */
const rankOf = (key: string) => {
  const at = PHASE_ORDER.indexOf(key as PhaseKey);
  return at < 0 ? PHASE_ORDER.length : at;
};
/** The first of these keys in LearnSDLC's order. */
const firstOf = (keys: readonly string[]) => [...keys].sort((a, b) => rankOf(a) - rankOf(b))[0];
/**
 * The first phase on which two versions' sets of phase keys differ, and the
 * sentence the strand's audit row reads: a key the pin holds and
 * the head does not comes first; otherwise a key the head holds and the pin
 * does not. Null when the two hold the same set, whatever their order.
 */
function phaseSetDifference(pinKeys: readonly string[], headKeys: readonly string[]): { key: string; sentence: string } | null {
  const tail = 'so the learner stays on their version, with their work. Learners who start now get the new one.';
  const name = (key: string) => PHASE_TITLES[key as PhaseKey] ?? key;
  const onlyPin = pinKeys.filter((key) => !headKeys.includes(key));
  if (onlyPin.length) {
    const key = firstOf(onlyPin);
    return { key, sentence: `This learner's version holds ${name(key)} and the new one does not, ${tail}` };
  }
  const onlyHead = headKeys.filter((key) => !pinKeys.includes(key));
  if (onlyHead.length) {
    const key = firstOf(onlyHead);
    return { key, sentence: `This learner's version does not hold ${name(key)} and the new one does, ${tail}` };
  }
  return null;
}
/** The strand's sentence for a pin holding `pinKeys` and a head holding `headKeys`; null when the sets agree. */
export function phaseSetSentence(pinKeys: readonly string[], headKeys: readonly string[]): string | null {
  return phaseSetDifference(pinKeys, headKeys)?.sentence ?? null;
}

/** What one run did, summed over every project. Every count is of rows, never of people named. */
export interface StoryRepinResult {
  /**
   * Per project slug, the head's version id: every head grading a structured
   * kind, and every head that frees learners off a retired written phase.
   */
  heads: Record<string, string>;
  /** Enrolments moved from a published version with an older-format phase to their project's head. */
  moved: number;
  /**
   * Enrolments moved from a published version holding a retired written phase
   * (`retiredWrittenPhases`: a markdown phase under a key no structured form
   * keeps, so nothing grades it) to a head that holds none. Nothing converts
   * the written files: they stay in the workspace as they are. A move that
   * also converts a structured phase is counted here and in `moved`.
   */
  movedOffRetired: number;
  /** Workspaces converted to their record, summed over the phases: the moved ones, and those already on a structured version. */
  converted: number;
  /** Active class assignments moved from a version with an older-format phase to the head. */
  assignmentsMoved: number;
  /** Enrolments left for a later run: a submission was queued or running in a phase the move converts. */
  skippedInFlight: number;
  /** Workspaces that could not be converted, and rows whose write failed; their enrolment is not moved. */
  refused: number;
  /**
   * Enrolments pinned to an archived version with an older-format phase or a
   * retired written phase to leave, and the same set of phases as the
   * head's: neither converted nor moved.
   */
  leftOnArchived: number;
  /**
   * Enrolments the re-pin would otherwise consider (move, leave on an
   * archived version, or strand by its other phases) whose version holds a
   * different set of phase keys from the head's, retired and dropped phases
   * included: no path moves an enrolment between versions whose
   * sets of phases differ, so each stays on its version, counted here, with
   * one `enrolment.repin.stranded` audit row per pin and head.
   */
  strandedPhaseSetDiffers: number;
  /**
   * Enrolments on a published version whose phases that the move would not
   * convert do not compile to the head's digests: moving them would change
   * more than the converted phases under an attempt, so they are left for the
   * owner's decision.
   */
  strandedOtherPhasesDiffer: number;
  /** Enrolments and class assignments that would move, waiting because no admin account exists to name as the actor. */
  waitingForAdmin: number;
  /** Workspaces converted, per phase key (`requirements`, `design`, `deployment`, `maintenance`); their sum is `converted`. */
  convertedByPhase: Record<string, number>;
}

type Version = Pick<ProjectVersionEntity, 'id' | 'projectId' | 'version' | 'status' | 'publishedAt'>;
type State = Pick<PhaseStateEntity, 'id' | 'enrollmentId' | 'phaseKey' | 'workspace' | 'workspaceUpdatedAt' | 'drill'>;
type Refusal = { stateId?: string; enrollmentId?: string; cohortId?: string; reason: string };
/** The counts a receipt section carries, in the story-records migration's key order. A retired written phase has no receipt section: its moves are in the audit rows. */
type Counts = Omit<StoryRepinResult, 'convertedByPhase' | 'movedOffRetired'>;
/** What one phase's receipt section gathers over the run. */
type PhaseLedger = { counts: Counts; conversions: Record<string, number>; refusals: Refusal[]; folded: { stateId: string; reason: string }[]; dropped: { stateId: string; reason: string }[] };
type Counter =
  | 'moved' | 'converted' | 'assignmentsMoved' | 'skippedInFlight' | 'refused' | 'leftOnArchived' | 'strandedPhaseSetDiffers' | 'strandedOtherPhasesDiffer' | 'waitingForAdmin';

/** One digest over every phase but those named: its content and its compiled tasks, in order. */
export function phasesDigest(compiled: Pick<CompiledSnapshot, 'content' | 'phases'> | null | undefined, except: readonly string[]): string {
  const tasks = new Map((compiled?.phases ?? []).map((one) => [one.key, one.tasks]));
  return digestOf(
    (compiled?.content?.phases ?? [])
      .filter((phase) => !except.includes(phase.key))
      .map((phase) => ({ phase, tasks: tasks.get(phase.key) ?? null })),
  );
}

/**
 * Moves the learners and classes still on a version whose Requirements,
 * Design, Deployment or Maintenance is in an older format (the markdown kind,
 * a config Deployment with no runbook, a code Maintenance with no change
 * request) onto their project's published head, whose phase grades the
 * structured form instead (a story, a design record, a runbook record, a
 * change request record), and converts each moved learner's workspaces in
 * the same transaction.
 *
 * ## Why at boot and not in the migration
 *
 * The TaskTrackr head it moves them to is imported by the boot
 * (`SeedService.importPlatformContent`), after every migration has run, so
 * the row this points a pin at does not exist yet when the migrations
 * (`1790100000000-S1-StoryRecordsFromMarkdown.ts`,
 * `1790200000000-S2-DesignRecordsFromMarkdown.ts`,
 * `1790300000000-S3-DeploymentAndMaintenanceRecords.ts`) run. And a store the
 * migrations never ran on (schema sync, an adopted SQLite file) must not end
 * with a learner on a structured version and their work still in
 * `my-story.md`, `my-design.md`, `RUNBOOK.md` or `CHANGELOG.md`, which the
 * room, the grader and the mentor do not read. So the conversion of a
 * moved learner happens here, beside the move, never apart from it. It runs
 * after the boot's admin account exists (`SeedService`), the actor every move
 * names.
 *
 * ## The rule, phase by phase
 *
 * The phases are rules (`STRUCTURED_PHASE_RULES`), Requirements, Design,
 * Deployment and Maintenance only. For an enrolment's pin, the set C is the
 * rule phases its pin grades in the older form and its head grades in that
 * rule's structured form, so C depends on the head. Against TaskTrackr's
 * 5.0.0 head, which grades all four structured forms: a 4.0.0 pin grades
 * Deployment and Maintenance in the older form (a config phase with no
 * runbook, a code phase with no change request), so both convert in one
 * savepoint and the digest compares the other four phases; a 3.0.0 pin
 * converts Design, Deployment and Maintenance and is compared on three; a
 * 2.0.1 pin converts all four and is compared on Implementation and Testing.
 * The in-place pass converts a phase only under a version that grades its
 * structured form. The Deployment conversion is handed the state's drill,
 * whose incident goes into the record; the drill itself is never written.
 *
 * Every project is asked, the platform's and every teacher's, and only one
 * whose newest published version grades at least one structured form. A
 * phase's workspace is converted if and only if its enrolment is moved here
 * with that phase in C, or the learner's version (the pin, or for a null pin
 * the head) already grades that phase's structured form. A learner on a
 * version with a story Requirements and a markdown Design keeps
 * `my-design.md`: the markdown Design is what grades them. The migrations
 * convert by the same rule, so a workspace one converted comes back
 * `untouched` here.
 *
 * - **Moved and converted:** a pin on a *published* version with C not empty
 *   whose phases outside C compile to the same digests as the head's
 *   (`phasesDigest`): only the phases in C change under the attempt. Each
 *   workspace in C is converted first; one that cannot be converted (a fold
 *   that would cut, a design page that is not text, a record that cannot be
 *   read, notes past the cap) moves nothing and converts nothing (counted,
 *   with the reason in its phase's receipt). A Deployment or Maintenance that
 *   comes back `untouched` while it still holds a learner-written file equal
 *   to the pinned version's own template has that file dropped in the same
 *   savepoint (`template-dropped`): it holds no word of the learner's, the
 *   head's starting record serves the room, and no later in-place run reads
 *   it again under a template that is not its version's.
 * - **Stranded:** a pin on a published version with C not empty whose other
 *   phases differ from the head (a TaskTrackr 1.0.0 or 2.0.0, a teacher's
 *   version republished with other changes). Never moved, and none of C
 *   converted: counted as `strandedOtherPhasesDiffer`, printed on the boot
 *   line, for the owner to decide.
 * - **Converted in place:** a phase whose learner's version already grades
 *   the structured form and whose workspace is still in the older format: for
 *   Requirements, it holds `my-story.md`; for Design, every state is asked,
 *   because an older-shaped `design.json` with no page beside it (a null pin
 *   whose head became the design head at this boot, after the design-records migration
 *   skipped it) is named by no file; for Deployment and Maintenance, every
 *   state is asked too, because a Deployment with no `RUNBOOK.md` whose drill
 *   holds an incident is seeded with it (`convertRunbookWorkspace`). A workspace already in the new shape
 *   comes back `untouched` and is not written. No pin moves, so no audit
 *   row and no actor is needed: this runs even when no admin exists. Unlike
 *   a move, it does not wait for a submission in flight: the learner's
 *   version and its grading do not change, a queued submission keeps the
 *   snapshot it was made from, and the conversion keeps every word.
 * - **Moved off a retired written phase:** a pin on a published version that
 *   holds a written (markdown) phase under a key no structured form keeps
 *   (`retiredWrittenPhases`: Implementation or Testing, or a Deployment or
 *   Maintenance the head does not grade as a record), of a project whose head
 *   holds none, moves to the head whether or not the head grades a structured
 *   form. Nothing converts the written files: they stay in the workspace as
 *   they are, and the head's phase starts from its own files, a loss the
 *   retirement accepts. The retired phases are left out of the digest comparison
 *   beside C, so the pin is stranded only when another phase differs. Counted
 *   apart (`movedOffRetired`; in `moved` too when C is not empty), with
 *   `retired written <key> phase, its files kept unconverted` in the audit
 *   row's reason and `kept-unconverted` as that phase's conversion outcome. A
 *   head that still holds a retired written phase frees nobody.
 * - **Stranded by its set of phases:** a pin the re-pin would otherwise
 *   consider (C not empty, or a retired written phase to leave: a pin it
 *   would move, leave on an archived version, or strand by its other
 *   phases), archived or published, whose version holds a different set of
 *   phase keys from the head's, retired and dropped phases included. The digest leaves out the phases in C and the retired ones, so
 *   it cannot see a phase the head dropped; this guard, asked first, can (spec
 *   10.3). Never moved and nothing converted: counted as
 *   `strandedPhaseSetDiffers`, printed on the boot line, and one
 *   `enrolment.repin.stranded` row per pin and head, its reason the sentence
 *   naming the first differing phase (`phaseSetSentence`). With no admin the
 *   row waits, and holds the done marker unset until a run writes it. A pin
 *   the re-pin would not consider is never compared, so a learner on any
 *   other version is neither stranded nor audited.
 * - **Left alone:** a pin on an *archived* version with C not empty or a
 *   retired written phase to leave, whose set of phases equals the head's,
 *   counted (one whose set differs is stranded, above).
 * - **Left for a later boot:** a learner with a submission queued or running
 *   in any phase of C, or in a retired written phase the move leaves.
 *   Grading reads the live pin, so moving them would grade an older
 *   workspace with the structured checks. Their submission is never
 *   touched, and the done marker stays unset until a run finds none left. The
 *   check takes no lock and never ages out: it assumes the single API
 *   instance a deployment runs (`docs/production-runbook.md` section 3d).
 *
 * Each row is written under its own savepoint: a row whose write fails is
 * rolled back alone, refused and counted, and the boot goes on. The
 * audit-only rows (a strand's `enrolment.repin.stranded` row, and the
 * refused `enrolment.repin` row of a failed retired-only move) have no
 * savepoint of their own: they share the outer transaction, as the receipts
 * and the done marker do, so a failed insert of one rolls the whole run
 * back and the boot rejects.
 *
 * A failed retired-only move writes one refused `enrolment.repin` row
 * (`detail.refused: true`, reason `RETIRED_MOVE_FAILED`) per failed attempt.
 * The refusal holds the done marker unset, so each boot retries and, while
 * the failure stands, writes another such row: unlike a strand's row it is
 * not deduplicated. A count of moves over `enrolment.repin` rows must leave
 * out `detail.refused = true`.
 *
 * ## Classes
 *
 * An active class assignment on a version of such a project with any rule
 * phase in the older format, or a retired written phase its head does not
 * hold, would keep starting new joiners on a phase nothing grades, so it is
 * moved to the head too, whatever its other phases:
 * no learner's pin moves with it. The row is superseded and an active row on
 * the head inserted, as the class panel's own write does, with a
 * `cohort.project.repin` audit row.
 *
 * ## The pin's promise
 *
 * A pin is a promise that content never moves under an attempt
 * (`EnrollmentEntity.projectVersionId`), so this is the audited migrate that
 * promise names: one `enrolment.repin` row per learner, actor the first
 * admin account, subject the learner, `from`/`to` the versions, `reason`
 * naming the phases moved and `conversion` each phase's outcome. With no
 * published structured head anywhere it writes nothing and marks nothing
 * done; with something to move and no admin, it moves nothing and leaves the
 * marker unset. With nothing to do it writes no marker, so a fresh store's
 * boot writes nothing at all.
 */
@Injectable()
export class StoryRepinService {
  private readonly logger = new Logger(StoryRepinService.name);

  constructor(private readonly dataSource: DataSource) {}

  async run(): Promise<StoryRepinResult | null> {
    return this.dataSource.transaction(async (manager) => {
      const done = await manager.findOneBy(SettingEntity, { key: STORY_REPIN_DONE_KEY });
      if (done && !(await this.publishedSince(manager, done.value))) return null;

      const projects = await manager.find(ProjectEntity, { select: { id: true, slug: true, title: true } });
      const versions: Version[] = await manager.find(ProjectVersionEntity, {
        select: { id: true, projectId: true, version: true, status: true, publishedAt: true },
      });
      const enrolments = await manager.find(EnrollmentEntity, {
        select: { id: true, userId: true, projectSlug: true, projectVersionId: true },
      });
      const assignmentsHeld = await manager.find(CohortProjectAssignmentEntity, { where: { state: ASSIGNMENT_ACTIVE } });

      // Each project's published head; only the snapshots a decision reads are loaded.
      const heads = new Map<string, Version>();
      for (const one of versions.filter((row) => row.status === 'published')) {
        const held = heads.get(one.projectId);
        if (!held || compareProjectVersions(one.version, held.version) > 0) heads.set(one.projectId, one);
      }
      const wanted = new Set<string>([...heads.values()].map((one) => one.id));
      for (const one of enrolments) if (one.projectVersionId) wanted.add(one.projectVersionId);
      for (const one of assignmentsHeld) wanted.add(one.projectVersionId);
      const compiled = new Map<string, CompiledSnapshot | null>(
        wanted.size
          ? (await manager.find(ProjectVersionEntity, { where: { id: In([...wanted]) }, select: { id: true, compiled: true } })).map((row) => [row.id, row.compiled ?? null])
          : [],
      );
      const snapshot = (id: string) => compiled.get(id) ?? null;
      const grades = (id: string, rule: StructuredPhaseRule) => rule.structured(snapshot(id));
      /** C: the rule phases this version grades in the older form where the head grades the structured form. */
      const olderThan = (id: string, headId: string) => STRUCTURED_PHASE_RULES.filter((rule) => rule.older(snapshot(id)) && grades(headId, rule));
      const versionById = new Map(versions.map((one) => [one.id, one]));

      const structuredHeads = projects.filter((project) => {
        const head = heads.get(project.id);
        return head && STRUCTURED_PHASE_RULES.some((rule) => grades(head.id, rule));
      });
      /** The retired written phases this version holds that the head does not: none when the head still holds one, since nothing would grade it there either. */
      const retiredOff = (id: string, headId: string) => (retiredWrittenPhases(snapshot(headId)).length ? [] : retiredWrittenPhases(snapshot(id)));
      // A project whose head holds no retired written phase frees the learners
      // pinned to a version that holds one, whether or not the head grades a
      // structured form.
      const freeingHeads = projects.filter((project) => {
        const head = heads.get(project.id);
        if (!head || structuredHeads.includes(project)) return false;
        const pinnedHere = (id: string | null) => !!id && versionById.get(id)?.projectId === project.id && retiredOff(id, head.id).length > 0;
        return enrolments.some((one) => pinnedHere(one.projectVersionId)) || assignmentsHeld.some((one) => pinnedHere(one.projectVersionId));
      });
      if (!structuredHeads.length && !freeingHeads.length) {
        this.logger.warn('structured re-pin deferred: no project has a published head with a structured Requirements, Design, Deployment or Maintenance, so nobody was moved');
        return null;
      }

      const result: StoryRepinResult = {
        heads: Object.fromEntries([...structuredHeads, ...freeingHeads].map((project) => [project.slug, heads.get(project.id)!.id])),
        moved: 0,
        movedOffRetired: 0,
        converted: 0,
        assignmentsMoved: 0,
        skippedInFlight: 0,
        refused: 0,
        leftOnArchived: 0,
        strandedPhaseSetDiffers: 0,
        strandedOtherPhasesDiffer: 0,
        waitingForAdmin: 0,
        convertedByPhase: Object.fromEntries(STRUCTURED_PHASE_RULES.map((rule) => [rule.phaseKey, 0])),
      };
      // Each phase's own receipt section: its heads, and every count that concerns it.
      const ledgers = new Map<string, PhaseLedger>(
        STRUCTURED_PHASE_RULES.map((rule) => [
          rule.phaseKey,
          {
            counts: {
              heads: Object.fromEntries(structuredHeads.filter((project) => grades(heads.get(project.id)!.id, rule)).map((project) => [project.slug, heads.get(project.id)!.id])),
              moved: 0, converted: 0, assignmentsMoved: 0, skippedInFlight: 0, refused: 0, leftOnArchived: 0, strandedPhaseSetDiffers: 0, strandedOtherPhasesDiffer: 0, waitingForAdmin: 0,
            },
            conversions: {},
            refusals: [],
            folded: [],
            dropped: [],
          },
        ]),
      );
      /** Counts one row into the result once, and into the section of every phase it concerns. */
      const count = (key: Counter, rules: readonly StructuredPhaseRule[], n = 1) => {
        if (!n) return;
        result[key] += n;
        for (const rule of rules) ledgers.get(rule.phaseKey)!.counts[key] += n;
      };

      // Per project with a structured head: who moves, who is stranded, who converts in place, which classes move.
      /** `rules` are the phases converted (C), `retired` the retired written phases left as they are. */
      type Move = { enrolment: EnrollmentEntity; project: ProjectEntity; head: Version; rules: StructuredPhaseRule[]; retired: PhaseKey[] };
      const toMove: Move[] = [];
      /** The pins left on their version because the head holds a different set of phases, each with the sentence its audit row reads. */
      const strands: { enrolment: EnrollmentEntity; project: ProjectEntity; head: Version; from: string; differs: string; sentence: string }[] = [];
      /** Per rule phase, the enrolments converted in place and the version their workspace is graded by. */
      const inPlaceOn = new Map<string, Map<string, string>>(STRUCTURED_PHASE_RULES.map((rule) => [rule.phaseKey, new Map()]));
      const classMoves: { held: CohortProjectAssignmentEntity; project: ProjectEntity; head: Version; rules: StructuredPhaseRule[]; retired: PhaseKey[] }[] = [];
      /** The retired written phases a pin leaves behind, but for those a rule converts (a markdown Deployment or Maintenance). */
      const retiredBeside = (id: string, headId: string, rules: readonly StructuredPhaseRule[]) =>
        retiredOff(id, headId).filter((key) => !rules.some((rule) => rule.phaseKey === key));
      for (const project of [...structuredHeads, ...freeingHeads]) {
        const head = heads.get(project.id)!;
        for (const enrolment of enrolments.filter((one) => one.projectSlug === project.slug)) {
          const pin = enrolment.projectVersionId;
          const pinned = pin ? versionById.get(pin) : undefined;
          const on = pin === null ? head.id : pinned?.projectId === project.id ? pinned.id : null;
          if (!on) continue;
          // Grading integrity: a phase converts in place only under a version that grades its structured kind, of a project with a structured head.
          if (structuredHeads.includes(project)) for (const rule of STRUCTURED_PHASE_RULES) if (grades(on, rule)) inPlaceOn.get(rule.phaseKey)!.set(enrolment.id, on);
          if (pin === null) continue;
          const rules = olderThan(on, head.id);
          const retired = retiredBeside(on, head.id, rules);
          if (!rules.length && !retired.length) continue;
          // No path moves an enrolment between versions whose sets of phase keys differ, retired and
          // dropped phases included: the digest below leaves those phases out, so it cannot see this. Asked only
          // here, after the continue above, so only a pin the re-pin would otherwise consider is compared.
          const differs = phaseSetDifference(phaseKeysOf(snapshot(on)), phaseKeysOf(snapshot(head.id)));
          if (differs) {
            count('strandedPhaseSetDiffers', rules);
            strands.push({ enrolment, project, head, from: on, differs: differs.key, sentence: differs.sentence });
            continue;
          }
          // A retired written phase is left out of the comparison like a converted one: it is what the head changed.
          const keys = [...rules.map((rule) => rule.phaseKey), ...retired];
          if (pinned!.status !== 'published') count('leftOnArchived', rules);
          else if (phasesDigest(snapshot(on), keys) !== phasesDigest(snapshot(head.id), keys)) count('strandedOtherPhasesDiffer', rules);
          else toMove.push({ enrolment, project, head, rules, retired });
        }
        for (const held of assignmentsHeld) {
          const on = versionById.get(held.projectVersionId);
          if (on?.projectId !== project.id) continue;
          const rules = olderThan(on.id, head.id);
          const retired = retiredBeside(on.id, head.id, rules);
          if (rules.length || retired.length) classMoves.push({ held, project, head, rules, retired });
        }
      }

      // The moved learners' workspaces in every phase they convert, whatever
      // they hold; the learners already on a structured version where the
      // older file is still there (Requirements), or every state of the phase
      // (Design, Deployment, Maintenance: `inPlaceEveryState`), each asked and
      // skipped when untouched.
      const moving = await this.statesOf(
        manager,
        toMove.map((one) => one.enrolment.id),
        [...new Set<string>([...STRUCTURED_PHASE_RULES.map((rule) => rule.phaseKey), ...toMove.flatMap((one) => one.retired)])],
      );
      const inPlace: { rule: StructuredPhaseRule; state: State; on: string }[] = [];
      for (const rule of STRUCTURED_PHASE_RULES) {
        const on = inPlaceOn.get(rule.phaseKey)!;
        if (!on.size) continue;
        const select = { id: true, enrollmentId: true, phaseKey: true, workspace: true, workspaceUpdatedAt: true, drill: true } as const;
        const states: State[] = [];
        if (rule.inPlaceEveryState) {
          const ids = [...on.keys()];
          for (let at = 0; at < ids.length; at += IN_LIST_BATCH) {
            states.push(...(await manager.find(PhaseStateEntity, { where: { phaseKey: rule.phaseKey, enrollmentId: In(ids.slice(at, at + IN_LIST_BATCH)) }, select })));
          }
        } else {
          states.push(...(await manager.find(PhaseStateEntity, { where: { phaseKey: rule.phaseKey, workspace: Like(`%"${rule.legacyMarker}"%`) }, select })));
        }
        for (const state of states) {
          if (!on.has(state.enrollmentId)) continue;
          const version = on.get(state.enrollmentId)!;
          // A NULL workspace is not seeded (an instructor reset it), as the deployment-and-maintenance records migration skips it: it is left untouched.
          if (state.workspace === null) continue;
          // Asked first, so a workspace already in the new shape costs no savepoint and no write.
          if (rule.inPlaceEveryState && rule.convert(state.workspace, snapshot(version), snapshot(version), { drill: state.drill ?? null }).outcome === 'untouched') continue;
          inPlace.push({ rule, state, on: version });
        }
      }
      // Every phase the move changes the grading of, the retired written ones included: a submission queued
      // or running on one would be graded under the head's checks once the pin moved.
      const statesMoving = (move: Move) =>
        [...move.rules.map((rule) => rule.phaseKey), ...move.retired].map((key) => moving.get(move.enrolment.id)?.get(key)).filter((state): state is State => !!state);
      const busy = await this.inFlight(manager, toMove.flatMap((move) => statesMoving(move).map((state) => state.id)));
      const isBusy = (move: Move) => statesMoving(move).some((state) => busy.has(state.id));

      /** What one row did, counted into the result only once its savepoint is released. */
      type Converted = { rule: StructuredPhaseRule; stateId: string; outcome: string; reason?: string };
      type Tally = {
        moved: number;
        movedOffRetired: number;
        assignmentsMoved: number;
        converted: Converted[];
        refusal?: { rule: StructuredPhaseRule; refusal: Refusal };
        /** On a refusal, the other phases' state ids in the same row, by phase key: those the refusal held back. */
        blocked?: Map<string, string>;
      };
      /**
       * Converts every phase of one row, all or none: each workspace is
       * converted (pure) first, and only when none is refused is anything
       * written. Returns each phase's outcome, or null when one was refused
       * and the row must not move. On a move (`onMove`), a phase that comes
       * back `untouched` while holding files that are only the pinned
       * version's template has those files dropped (`templateOnly`).
       */
      const convertAll = async (
        row: EntityManager,
        tally: Tally,
        work: { rule: StructuredPhaseRule; state: State | undefined }[],
        pinned: CompiledSnapshot | null,
        head: CompiledSnapshot | null,
        onMove = false,
      ): Promise<Record<string, string> | null> => {
        const convertOne = (rule: StructuredPhaseRule, state: State) => {
          // A NULL workspace is not seeded (an instructor reset it), as the deployment-and-maintenance records migration skips it: it is left untouched.
          if (state.workspace === null) return { workspace: {}, outcome: 'untouched' };
          const workspace = state.workspace;
          const out = rule.convert(workspace, pinned, head, { drill: state.drill ?? null });
          const dropped = onMove && out.outcome === 'untouched' ? (rule.templateOnly?.(workspace, pinned) ?? []) : [];
          if (!dropped.length) return out;
          return {
            workspace: Object.fromEntries(Object.entries(workspace).filter(([path]) => !dropped.includes(path))),
            outcome: 'template-dropped',
            reason: `${dropped.join(', ')} held only the version's template and ${dropped.length === 1 ? 'was' : 'were'} removed`,
          };
        };
        const outs = work.map(({ rule, state }) => ({ rule, state, out: state ? convertOne(rule, state) : null }));
        const refused = outs.find(({ out }) => out?.outcome === 'refused');
        if (refused) {
          tally.refusal = { rule: refused.rule, refusal: { stateId: refused.state!.id, reason: refused.out!.reason as string } };
          tally.blocked = new Map(outs.filter((one) => one !== refused && one.state).map((one) => [one.rule.phaseKey, one.state!.id]));
          return null;
        }
        const outcomes: Record<string, string> = {};
        for (const { rule, state, out } of outs) {
          outcomes[rule.phaseKey] = out?.outcome ?? 'untouched';
          if (!state || !out || out.outcome === 'untouched') continue;
          // Stamped afresh, like the migration: a tab still open on the older
          // file has its next save refused instead of writing over the record.
          // Only the workspace and its stamp are written, never the drill.
          const stamp = new Date(Math.max(Date.now(), (Date.parse(state.workspaceUpdatedAt ?? '') || 0) + 1)).toISOString();
          await row.update(PhaseStateEntity, { id: state.id }, { workspace: out.workspace, workspaceUpdatedAt: stamp });
          tally.converted.push({ rule, stateId: state.id, outcome: out.outcome, ...(out.reason ? { reason: out.reason } : {}) });
        }
        return outcomes;
      };
      /**
       * One row under its own savepoint: a failed write is rolled back alone, refused and counted, and the run
       * goes on. Answers false when the savepoint failed, so a caller whose row no receipt section holds can
       * record why.
       */
      const guarded = async (rules: readonly StructuredPhaseRule[], refusal: Omit<Refusal, 'reason'>, write: (row: EntityManager, tally: Tally) => Promise<void>) => {
        const tally: Tally = { moved: 0, movedOffRetired: 0, assignmentsMoved: 0, converted: [] };
        try {
          await manager.transaction((row) => write(row, tally));
        } catch {
          count('refused', rules);
          for (const rule of rules) ledgers.get(rule.phaseKey)!.refusals.push({ ...refusal, reason: 'the row could not be written; it was rolled back and left as it was' });
          return false;
        }
        count('moved', rules, tally.moved);
        result.movedOffRetired += tally.movedOffRetired;
        count('assignmentsMoved', rules, tally.assignmentsMoved);
        for (const { rule, stateId, outcome, reason } of tally.converted) {
          count('converted', [rule]);
          result.convertedByPhase[rule.phaseKey] += 1;
          const ledger = ledgers.get(rule.phaseKey)!;
          ledger.conversions[outcome] = (ledger.conversions[outcome] ?? 0) + 1;
          if (rule.phaseKey === 'design' && outcome === 'folded') ledger.folded.push({ stateId, reason: reason ?? '' });
          if (outcome === 'template-dropped') ledger.dropped.push({ stateId, reason: reason ?? '' });
        }
        if (tally.refusal) {
          // One row refused, counted in every phase it would have converted: the
          // phase that refused lists why, the others that the learner waits on it.
          const blocking = tally.refusal.rule;
          count('refused', rules);
          ledgers.get(blocking.phaseKey)!.refusals.push(tally.refusal.refusal);
          for (const rule of rules.filter((one) => one !== blocking)) {
            const stateId = tally.blocked?.get(rule.phaseKey);
            ledgers.get(rule.phaseKey)!.refusals.push({
              ...(stateId ? { stateId } : refusal),
              reason: `not moved: the ${PHASE_TITLES[blocking.phaseKey]} workspace in the same move could not be converted, so this one was left as it was`,
            });
          }
        }
        return true;
      };

      for (const { rule, state, on } of inPlace) {
        // In place, the learner's version is both the one they wrote under and the one that grades them.
        await guarded([rule], { stateId: state.id }, async (row, tally) => void (await convertAll(row, tally, [{ rule, state }], snapshot(on), snapshot(on))));
      }

      const ready = toMove.filter((move) => !isBusy(move));
      for (const move of toMove) if (isBusy(move)) count('skippedInFlight', move.rules);
      const waiting = ready.length + classMoves.length;
      const admin = waiting || strands.length
        ? await manager.findOne(UserEntity, { where: { role: 'ADMIN' }, order: { createdAt: 'ASC', id: 'ASC' }, select: { id: true } })
        : null;
      if (waiting && !admin) {
        for (const one of [...ready, ...classMoves]) count('waitingForAdmin', one.rules);
        this.logger.warn(`structured re-pin: ${waiting} enrolment(s) and class assignment(s) wait to move and there is no admin account to name as the actor`);
      }
      const actor = admin?.id;

      /** Retired-only moves whose row could not be written: no receipt section holds them, so the audit row and the boot line say why. */
      let refusedOffRetired = 0;
      for (const { enrolment, project, head, rules, retired } of actor ? ready : []) {
        const fromVersionId = enrolment.projectVersionId as string;
        const states = moving.get(enrolment.id);
        const written = await guarded(rules, { enrollmentId: enrolment.id }, async (row, tally) => {
          const work = rules.map((rule) => ({ rule, state: states?.get(rule.phaseKey) }));
          const conversion = await convertAll(row, tally, work, snapshot(fromVersionId), snapshot(head.id), true);
          if (conversion === null) return;
          // A retired written phase is not converted: its files stay in the workspace as they are.
          for (const key of retired) conversion[key] = RETIRED_WRITTEN_OUTCOME;
          await row.update(EnrollmentEntity, { id: enrolment.id }, { projectVersionId: head.id, packVersion: head.version });
          await recordAudit(row, {
            event: 'enrolment.repin',
            actorUserId: actor as string,
            subjectUserId: enrolment.userId,
            targetId: enrolment.id,
            action: project.slug,
            detail: { from: versionById.get(fromVersionId)?.version, to: head.version, reason: reasonOf(rules, retired), fromVersionId, toVersionId: head.id, conversion },
          });
          if (rules.length) tally.moved += 1;
          if (retired.length) tally.movedOffRetired += 1;
        });
        if (written || rules.length) continue;
        // In the outer transaction, after the savepoint rolled back: the pin is where it was.
        refusedOffRetired += 1;
        await recordAudit(manager, {
          event: 'enrolment.repin',
          actorUserId: actor as string,
          subjectUserId: enrolment.userId,
          targetId: enrolment.id,
          action: project.slug,
          // The row's reason as well as the detail's, so the record of changes shows it on the detail line.
          reason: RETIRED_MOVE_FAILED,
          detail: { from: versionById.get(fromVersionId)?.version, to: head.version, reason: RETIRED_MOVE_FAILED, fromVersionId, toVersionId: head.id, refused: true },
        });
      }

      for (const { held, project, head, rules, retired } of actor ? classMoves : []) {
        await guarded(rules, { cohortId: held.cohortId }, async (row, tally) => {
          // The class panel's own write: supersede, then insert under the
          // one-active-row index, inside this transaction.
          await row.update(CohortProjectAssignmentEntity, { id: held.id, state: ASSIGNMENT_ACTIVE }, { state: ASSIGNMENT_SUPERSEDED });
          await row.save(
            row.create(CohortProjectAssignmentEntity, {
              cohortId: held.cohortId,
              projectVersionId: head.id,
              assignedByUserId: actor as string,
              state: ASSIGNMENT_ACTIVE,
              reason: assignmentReason(project.title, rules, retired),
            }),
          );
          await recordAudit(row, {
            event: 'cohort.project.repin',
            actorUserId: actor as string,
            // The class is not a person: the subject is the actor, as `cohort.project` writes it.
            subjectUserId: actor as string,
            targetId: held.cohortId,
            action: project.slug,
            reason: assignmentReason(project.title, rules, retired),
            detail: { from: versionById.get(held.projectVersionId)?.version, to: head.version, reason: reasonOf(rules, retired), fromVersionId: held.projectVersionId, toVersionId: head.id },
          });
          tally.assignmentsMoved += 1;
        });
      }

      // One `enrolment.repin.stranded` row per pin and head: every such row of the enrolment is read, and
      // one is written only when none names this head. With no admin the row waits, and holds the marker unset.
      let strandRowsWritten = 0;
      let strandRowsWaiting = 0;
      for (const { enrolment, project, head, from, differs, sentence } of strands) {
        const held = await manager.find(AuditEventEntity, { where: { event: 'enrolment.repin.stranded', targetId: enrolment.id }, select: { id: true, detail: true } });
        if (held.some((row) => (row.detail as { toVersionId?: unknown } | null)?.toVersionId === head.id)) continue;
        if (!actor) {
          strandRowsWaiting += 1;
          continue;
        }
        await recordAudit(manager, {
          event: 'enrolment.repin.stranded',
          actorUserId: actor,
          subjectUserId: enrolment.userId,
          targetId: enrolment.id,
          action: project.slug,
          reason: sentence,
          detail: { from: versionById.get(from)?.version, to: head.version, fromVersionId: from, toVersionId: head.id, differs },
        });
        strandRowsWritten += 1;
      }
      if (strandRowsWaiting) {
        this.logger.warn(`structured re-pin: ${strandRowsWaiting} stranded enrolment(s) wait for an admin account to name as the actor of their audit row`);
      }

      // A strand's row written is a change and one waiting is pending: the marker is set only once every row is written.
      const changed = result.moved + result.movedOffRetired + result.converted + result.assignmentsMoved + strandRowsWritten;
      const pending = result.skippedInFlight + result.refused + result.waitingForAdmin + strandRowsWaiting;
      for (const rule of STRUCTURED_PHASE_RULES) {
        const ledger = ledgers.get(rule.phaseKey)!;
        const { counts } = ledger;
        const touched =
          counts.moved + counts.converted + counts.assignmentsMoved + counts.skippedInFlight + counts.refused + counts.waitingForAdmin +
          counts.strandedPhaseSetDiffers + counts.strandedOtherPhasesDiffer;
        if (touched) await this.recordReceipt(manager, rule, ledger);
      }
      // Done only when nothing is left for a later run. Stranded learners are
      // the owner's decision, not a retry, so they do not hold the marker back.
      // A store with nothing to do gets no marker: the next boot asks the same
      // cheap question and finds the same nothing.
      if (changed && !pending) {
        await manager.save(manager.create(SettingEntity, { key: STORY_REPIN_DONE_KEY, value: new Date().toISOString() }));
      }
      this.logger.log(
        `structured re-pin: moved ${result.moved} enrolment(s) from a version whose Requirements, Design, Deployment or Maintenance is in an older format to their project's structured head; ` +
          `moved ${result.movedOffRetired} enrolment(s) off a version holding a written phase LearnSDLC no longer grades, to a head that holds none, their written files kept unconverted; ` +
          `converted ${result.convertedByPhase.requirements} Requirements, ${result.convertedByPhase.design} Design, ${result.convertedByPhase.deployment} Deployment and ${result.convertedByPhase.maintenance} Maintenance workspace(s); moved ${result.assignmentsMoved} class assignment(s); ` +
          `left ${result.skippedInFlight} with a submission in flight in a phase it converts, ` +
          `${result.refused} refused${refusedOffRetired ? ` (${refusedOffRetired} because ${RETIRED_MOVE_FAILED})` : ''}, ` +
          `${result.strandedPhaseSetDiffers} stranded because the head holds a different set of phases, ` +
          `${result.strandedOtherPhasesDiffer} stranded because another phase differs from the head, ` +
          `${result.waitingForAdmin} waiting for an admin account and ${result.leftOnArchived} on an archived version in an older format`,
      );
      return result;
    });
  }

  /** Whether any version was published after the marker was written. */
  private async publishedSince(manager: EntityManager, at: string): Promise<boolean> {
    const count = await manager
      .getRepository(ProjectVersionEntity)
      .createQueryBuilder('version')
      .where('version.status = :status', { status: 'published' })
      .andWhere('version.publishedAt > :at', { at })
      .getCount();
    return count > 0;
  }

  /** Each enrolment's phase states under these phase keys (the rule phases and the retired ones a move leaves), by enrolment id, then phase key. */
  private async statesOf(manager: EntityManager, enrollmentIds: string[], phaseKeys: string[]): Promise<Map<string, Map<string, State>>> {
    if (!enrollmentIds.length) return new Map();
    const states = await manager.find(PhaseStateEntity, {
      where: { phaseKey: In(phaseKeys), enrollmentId: In(enrollmentIds) },
      select: { id: true, enrollmentId: true, phaseKey: true, workspace: true, workspaceUpdatedAt: true, drill: true },
    });
    const byEnrolment = new Map<string, Map<string, State>>();
    for (const state of states) {
      if (!byEnrolment.has(state.enrollmentId)) byEnrolment.set(state.enrollmentId, new Map());
      byEnrolment.get(state.enrollmentId)!.set(state.phaseKey, state);
    }
    return byEnrolment;
  }

  /** The phase states among these with a submission queued or running. */
  private async inFlight(manager: EntityManager, phaseStateIds: string[]): Promise<Set<string>> {
    if (!phaseStateIds.length) return new Set();
    const rows = await manager.find(SubmissionEntity, {
      where: { phaseStateId: In(phaseStateIds), status: In(['queued', 'running']) },
      select: { id: true, phaseStateId: true },
    });
    return new Set(rows.map((row) => row.phaseStateId));
  }

  /**
   * What the runs did for one phase, under `repin` in that phase's migration
   * receipt (created when the migration never ran): running totals of what
   * moved and converted, the latest run's counts of what is still waiting or
   * stranded, and one entry per run with its own counts, the outcome of each
   * conversion and each refusal with its reason. The Design section's runs
   * also list the folded states by id with what moved, as the migration's
   * receipt does, and a run that dropped a template-only file lists those
   * states by id with the files removed (`dropped`).
   */
  private async recordReceipt(manager: EntityManager, rule: StructuredPhaseRule, ledger: PhaseLedger): Promise<void> {
    const receipt = await readReceipt(manager, rule.receiptKey);
    const { counts, conversions, refusals, folded, dropped } = ledger;
    const was = (receipt.repin && typeof receipt.repin === 'object' ? receipt.repin : {}) as Record<string, unknown>;
    const total = (key: 'moved' | 'converted' | 'assignmentsMoved') => (typeof was[key] === 'number' ? (was[key] as number) : 0) + counts[key];
    const at = new Date().toISOString();
    receipt.repin = {
      at,
      heads: counts.heads,
      moved: total('moved'),
      converted: total('converted'),
      assignmentsMoved: total('assignmentsMoved'),
      skippedInFlight: counts.skippedInFlight,
      refused: counts.refused,
      leftOnArchived: counts.leftOnArchived,
      strandedPhaseSetDiffers: counts.strandedPhaseSetDiffers,
      strandedOtherPhasesDiffer: counts.strandedOtherPhasesDiffer,
      waitingForAdmin: counts.waitingForAdmin,
      // At most RECEIPT_RUNS entries, the oldest dropped: a standing refusal keeps the marker unset, so every boot adds one.
      runs: appendRun(was.runs, { at, ...counts, conversions, refusals, ...(rule.phaseKey === 'design' ? { folded } : {}), ...(dropped.length ? { dropped } : {}) }),
    };
    await manager.save(manager.create(SettingEntity, { key: rule.receiptKey, value: JSON.stringify(receipt) }));
  }
}
