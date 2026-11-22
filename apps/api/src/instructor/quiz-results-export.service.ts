import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, Equal, FindOptionsWhere, In, IsNull, Not } from 'typeorm';
import {
  PHASE_ORDER,
  QUIZ_SCORE_BANDS,
  quizScoreBand,
  type QuizChecks,
  type QuizLearnerResult,
  type QuizResultsExportKind,
  type QuizResultsSummary,
  type QuizScoreBandKey,
  type QuizTaskSummary,
} from '@learnsdlc/shared';
import { classProjectVersionOf } from '../classroom/cohort-project.service';
import { ContentService } from '../content/content.service';
import {
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  QuizAttemptEntity,
  UserEntity,
} from '../db/entities';
import { scorePaper } from '../feedback/quiz-scoring';
import { quizChecksFor } from '../quiz/quiz.service';
// The before/after concept checks.
import { CONCEPT_AFTER, CONCEPT_BEFORE, CONCEPT_TASK_KEYS, conceptBankFor } from '../quiz/concept/concept';
import { InstructorCaller, assertClassInScope, cohortNamesById, learnerScope } from './cohort-scope';
import { csvCell } from './csv';
import { UUID_PATTERN } from '../db/uuid';

/**
 * The quiz results of the caller's own classes,
 * as four read-only CSVs.
 *
 * **Read only, and only these rows.** One read each of the learners in scope,
 * their enrolments, their phase rows and (ordered, in one statement) the
 * **closed** papers on those phase rows. Nothing here writes, and no quiz
 * grading runs: `score` and `passed` are always the values the grading job
 * stored on the paper, and the per-question `outcome` is `scorePaper`'s word
 * (`right`/`wrong`) over the pinned version's sealed slice, the same function
 * that produced the stored score.
 *
 * **What never appears**, by construction rather than by filter: the key, an
 * explanation, a concept, a stem, an option's text, its authored id or this
 * paper's token for it, the options a learner picked, any uuid, any open paper
 * (`submittedAt IS NULL` is not read at all), any undrawn question, and any
 * learner outside `learnerScope`. Email and display name do appear, exactly as
 * they do in the two existing teacher CSVs, and every cell goes through
 * `csvCell` so a display name cannot become a spreadsheet formula.
 *
 * **The attempt number is `attemptNumberOf`'s rule** (`quiz-attempts.service`),
 * computed in memory from the one ordered read: within its epoch, the papers
 * handed in (closed and not voided) no later than this one, itself included.
 * A voided paper (the one a teacher's reset found open) has no attempt
 * number, no score and no pass: it was never sat.
 */

/** One row per learner × project × quiz task they have handed a paper in on. */
export const QUIZ_LEARNERS_COLUMNS = [
  'email',
  'displayName',
  'class',
  'project',
  'phaseKey',
  'taskKey',
  'attempts used',
  'attempts voided',
  'best score',
  'latest score',
  'passed',
  'first submittedAt',
  'last submittedAt',
] as const;

/** One row per closed paper, voided ones included and marked. */
export const QUIZ_ATTEMPTS_COLUMNS = [
  'email',
  'displayName',
  'class',
  'project',
  'phaseKey',
  'taskKey',
  'epoch',
  'attempt',
  'status',
  'score',
  'passed',
  'startedAt',
  'submittedAt',
  'packVersion',
] as const;

/** One row per handed-in paper × the question it drew. */
export const QUIZ_QUESTIONS_COLUMNS = [
  'email',
  'class',
  'project',
  'taskKey',
  'epoch',
  'attempt',
  'position',
  'questionId',
  'outcome',
] as const;

/** One row per class × project × quiz task × question drawn in that class. */
export const QUIZ_CLASS_COLUMNS = [
  'class',
  'project',
  'taskKey',
  'questionId',
  'times drawn',
  'times right',
  '% right',
  'learners attempted',
  'learners passed',
] as const;

/** What the caller narrowed the files to; both optional. */
export interface QuizResultsRead {
  project?: string;
  cohort?: string;
}

/** What the summary reads: one class, always; a project, optionally. */
export interface QuizResultsSummaryRead {
  cohort: string;
  project?: string;
}

/**
 * One learner's before/after concept-check scores on one
 * phase. `deltaPct` is after − before, and null unless both were taken.
 */
export interface LearningGainLearner {
  learner: string;
  beforePct: number | null;
  afterPct: number | null;
  deltaPct: number | null;
}

/** One phase's learning gain. `n` counts paired learners; the averages use them only. */
export interface LearningGainPhase {
  phaseKey: string;
  title: string;
  n: number;
  beforeAvgPct: number | null;
  afterAvgPct: number | null;
  deltaPct: number | null;
  learners: LearningGainLearner[];
}

export interface LearningGainView {
  phases: LearningGainPhase[];
}

/**
 * The learning-gain CSV, one row per learner × phase. Named in the other quiz
 * files' register (camelCase
 * identifiers and worded measures) so the five files read as one set.
 */
export const LEARNING_GAIN_COLUMNS = ['phaseKey', 'learner', 'before %', 'after %', 'change (points)'] as const;

/** A quiz task the class's assigned version declares. */
interface DeclaredQuiz {
  project: string;
  phaseOrder: number;
  phaseKey: string;
  taskKey: string;
  title: string;
}

/** The file name each kind is saved as; the controller's header and the web button agree on it. */
export function quizResultsFilename(kind: QuizResultsExportKind, project?: string): string {
  return `quiz-${kind}${project ? `-${project}` : ''}.csv`;
}

/** One closed paper, with everything a row of any file needs beside it. */
export interface Paper {
  row: QuizAttemptEntity;
  learner: UserEntity;
  enrollment: EnrollmentEntity;
  state: PhaseStateEntity;
  voided: boolean;
  /** `attemptNumberOf`'s number; null on a voided paper. */
  attempt: number | null;
  /** `scorePaper`'s word per drawn question, in paper order; null when the pinned slice cannot be read. */
  outcomes: ('right' | 'wrong')[] | null;
}

const yesNo = (value: boolean | null | undefined): string => (value === null || value === undefined ? '' : value ? 'yes' : 'no');

const line = (cells: (string | number | boolean | null | undefined)[]): string => cells.map(csvCell).join(',');

const file = (header: readonly string[], rows: string[]): string => [header.join(','), ...rows].join('\r\n') + '\r\n';

@Injectable()
export class QuizResultsExportService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
  ) {}

  /** One of the four files, for the caller's classes (or the one named). */
  async export(caller: InstructorCaller, kind: QuizResultsExportKind, read: QuizResultsRead = {}): Promise<string> {
    const { papers, classNames } = await this.read(caller, read);
    switch (kind) {
      case 'learners':
        return this.learnersFile(papers, classNames);
      case 'attempts':
        return this.attemptsFile(papers, classNames);
      case 'questions':
        return this.questionsFile(papers, classNames);
      case 'class':
        return this.classFile(papers, classNames);
      default:
        throw new NotFoundException('no such quiz-results file');
    }
  }

  /**
   * One class's quiz results as numbers for the
   * dashboard, from the same read and the same two builders the four files
   * use, so a chart and a CSV cannot disagree.
   *
   * The class is required: an empty one would read every class of the
   * caller's. `read()` refuses a class that is not the caller's with its 404
   * before any learner is read, and a typo'd project with the catalogue's.
   * Nothing is written, nothing is graded: every number is a count or a score
   * the grading job already stored. No stem, option, key or explanation is
   * read into the result: questions are named by id, as in the class file.
   */
  async summary(caller: InstructorCaller, read: QuizResultsSummaryRead): Promise<QuizResultsSummary> {
    const cohort = typeof read?.cohort === 'string' ? read.cohort : '';
    if (cohort.trim() === '') throw new BadRequestException('name the class to summarise');
    const project = read.project || undefined;
    const { papers, classNames, learners } = await this.read(caller, { cohort, project });
    const className = (await this.classNames([cohort])).get(cohort) ?? null;

    const records = learnerRecords(papers);
    const keyOf = (one: { project: string; phaseKey: string; taskKey: string }) =>
      [one.project, one.phaseKey, one.taskKey].join('\u0000');
    const bestScores = new Map<string, number[]>();
    // A stored score that is not a finite number is a blank here, as the CSV's
    // empty cell is (quizScoreBand throws on NaN; grading never stores one).
    const finite = (score: number | null) => (typeof score === 'number' && Number.isFinite(score) ? score : null);
    for (const record of records) {
      const best = finite(record.bestScore);
      if (best === null) continue;
      const key = keyOf({ project: record.enrollment.projectSlug, phaseKey: record.state.phaseKey, taskKey: record.taskKey });
      bestScores.set(key, [...(bestScores.get(key) ?? []), best]);
    }

    const declared = new Map((await this.declaredQuizzes(cohort, project)).map((quiz) => [keyOf(quiz), quiz]));
    const quizzes: (QuizTaskSummary & { phaseOrder: number })[] = [];
    for (const tally of classTallies(papers, classNames)) {
      if (tally.cohort !== cohort) continue;
      const key = keyOf(tally);
      const own = declared.get(key);
      declared.delete(key);
      quizzes.push({
        phaseOrder: tally.phaseOrder,
        ...taskSummary(tally, bestScores.get(key) ?? []),
        title: own ? own.title : this.titleOf(tally.project, tally.versionId, tally.phaseKey, tally.taskKey),
        declared: Boolean(own),
      });
    }
    // A quiz the class's version declares and nobody has handed in: zeros.
    for (const quiz of declared.values()) {
      quizzes.push({
        phaseOrder: quiz.phaseOrder,
        ...taskSummary({ ...quiz, attempts: 0, learnersAttempted: 0, learnersPassed: 0, questions: [] }, []),
        title: quiz.title,
        declared: true,
      });
    }
    // quiz-class.csv's order within one class: project, phase order, task key.
    quizzes.sort(
      (a, b) => a.project.localeCompare(b.project) || a.phaseOrder - b.phaseOrder || a.taskKey.localeCompare(b.taskKey),
    );

    return {
      cohortId: cohort,
      className,
      learnersInClass: learners.length,
      quizzes: quizzes.map(({ phaseOrder: _order, ...quiz }) => quiz),
      learners: records.map(
        (record): QuizLearnerResult => ({
          email: record.learner.email,
          displayName: record.learner.displayName,
          project: record.enrollment.projectSlug,
          phaseKey: record.state.phaseKey,
          taskKey: record.taskKey,
          attemptsUsed: record.attemptsUsed,
          attemptsVoided: record.attemptsVoided,
          bestScore: finite(record.bestScore),
          latestScore: finite(record.latestScore),
          passed: record.passed,
        }),
      ),
    };
  }

  /**
   * The quiz tasks on the class's version, read only. Which version is
   * CohortProjectService's answer (`classProjectVersionOf`): the
   * active assignment row's version, else the default project's head as the
   * catalogue serves it. Then the version's project slug and the compiled
   * tasks the catalogue holds for that version. Anything unreadable declares
   * nothing, and the summary falls back to the quizzes papers name.
   */
  private async declaredQuizzes(cohort: string, project: string | undefined): Promise<DeclaredQuiz[]> {
    const manager = this.dataSource.manager;
    const held = await classProjectVersionOf(manager, cohort);
    if (!held) return [];
    let pin: { projectSlug: string; projectVersionId: string } | null = null;
    if (held.from === 'assignment') {
      if (!UUID_PATTERN.test(held.projectVersionId)) return [];
      // Never the whole row: `compiled` is a megabyte of JSON per version.
      const version = await manager.findOne(ProjectVersionEntity, {
        where: { id: held.projectVersionId },
        select: { id: true, projectId: true },
      });
      if (!version) return [];
      const owner = await manager.findOne(ProjectEntity, { where: { id: version.projectId }, select: { id: true, slug: true } });
      if (!owner) return [];
      pin = { projectSlug: owner.slug, projectVersionId: version.id };
    } else {
      // The first flagged project the catalogue serves, at its head.
      for (const slug of held.projectSlugs) {
        const head = this.content.headVersionIdFor(slug);
        if (head) {
          pin = { projectSlug: slug, projectVersionId: head };
          break;
        }
      }
    }
    if (!pin || (project && pin.projectSlug !== project)) return [];
    try {
      const resolved = this.content.resolveForEnrollment(pin);
      // Only that version: a pin the deployment no longer holds resolves the head.
      if (resolved.versionId !== pin.projectVersionId) return [];
      const out: DeclaredQuiz[] = [];
      for (const phase of resolved.content.phases) {
        for (const task of this.content.getTasksForEnrollment(pin, phase.key)) {
          if (task.artefactType !== 'quiz') continue;
          out.push({ project: pin.projectSlug, phaseOrder: phase.order, phaseKey: phase.key, taskKey: task.taskKey, title: task.title });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** A task's title on the version its papers were pinned to; null when that version cannot be read. */
  private titleOf(slug: string, versionId: string, phaseKey: string, taskKey: string): string | null {
    try {
      const pin = { projectSlug: slug, projectVersionId: versionId };
      if (this.content.resolveForEnrollment(pin).versionId !== versionId) return null;
      return this.content.getTasksForEnrollment(pin, phaseKey).find((one) => one.taskKey === taskKey)?.title ?? null;
    } catch {
      return null;
    }
  }

  /* -------------------------------- the read ------------------------------- */

  /**
   * The before/after learning gain of the caller's own
   * learners (or one class of theirs), per phase. Reads only concept-check
   * papers that were handed in and not voided; the newest of each slot counts.
   * The learner is named as the summary's table names them (display name).
   */
  async learningGain(caller: InstructorCaller, read: QuizResultsRead = {}): Promise<LearningGainView> {
    const { papers } = await this.read(caller, read, 'concept');
    interface Slot { at: string; startedAt: string; pct: number }
    interface Pair { learner: UserEntity; before: Slot | null; after: Slot | null }
    const byPhase = new Map<string, Map<string, Pair>>();
    for (const paper of papers) {
      if (paper.voided) continue;
      const score = paper.row.score;
      if (typeof score !== 'number' || !Number.isFinite(score)) continue;
      const phaseKey = paper.state.phaseKey;
      const learners = byPhase.get(phaseKey) ?? new Map<string, Pair>();
      byPhase.set(phaseKey, learners);
      const pair = learners.get(paper.learner.id) ?? { learner: paper.learner, before: null, after: null };
      learners.set(paper.learner.id, pair);
      const slot = paper.row.taskKey === CONCEPT_BEFORE ? 'before' : paper.row.taskKey === CONCEPT_AFTER ? 'after' : null;
      if (!slot) continue;
      const at = paper.row.submittedAt as string;
      const held = pair[slot];
      if (!held || at > held.at) pair[slot] = { at, startedAt: String(paper.row.startedAt ?? at), pct: Math.round(score) };
    }
    // A before paper handed in once the after paper was already started is not
    // a pre-measure: it is dropped, so that learner reads as unpaired.
    for (const learners of byPhase.values()) {
      for (const pair of learners.values()) {
        if (pair.before && pair.after && pair.before.at >= pair.after.startedAt) pair.before = null;
      }
    }
    const average = (values: number[]) =>
      values.length ? oneDecimal(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    return {
      phases: PHASE_ORDER.map((phaseKey): LearningGainPhase => {
        const pairs = [...(byPhase.get(phaseKey)?.values() ?? [])].filter((pair) => pair.before || pair.after);
        const learners = pairs
          .map((pair) => ({ pair, name: pair.learner.displayName || pair.learner.email }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.pair.learner.email.localeCompare(b.pair.learner.email))
          .map(({ pair, name }): LearningGainLearner => {
            const beforePct = pair.before?.pct ?? null;
            const afterPct = pair.after?.pct ?? null;
            return {
              learner: name,
              beforePct,
              afterPct,
              deltaPct: beforePct !== null && afterPct !== null ? afterPct - beforePct : null,
            };
          });
        const paired = learners.filter((one) => one.deltaPct !== null);
        const beforeAvgPct = average(paired.map((one) => one.beforePct as number));
        const afterAvgPct = average(paired.map((one) => one.afterPct as number));
        return {
          phaseKey,
          title: conceptBankFor(phaseKey)?.title ?? phaseKey,
          n: paired.length,
          beforeAvgPct,
          afterAvgPct,
          deltaPct: beforeAvgPct !== null && afterAvgPct !== null ? oneDecimal(afterAvgPct - beforeAvgPct) : null,
          learners,
        };
      }),
    };
  }

  /** The learning gain as a CSV; every cell through `csvCell`. */
  async learningGainCsv(caller: InstructorCaller, read: QuizResultsRead = {}): Promise<string> {
    const gain = await this.learningGain(caller, read);
    const rows: string[] = [];
    for (const phase of gain.phases) {
      for (const one of phase.learners) {
        rows.push(line([phase.phaseKey, one.learner, one.beforePct, one.afterPct, one.deltaPct]));
      }
    }
    return file(LEARNING_GAIN_COLUMNS, rows);
  }

  private async read(
    caller: InstructorCaller,
    read: QuizResultsRead,
    // 'pack' (every other reader) never sees a
    // concept-check paper; 'concept' reads only those, for the learning gain.
    papersOf: 'pack' | 'concept' = 'pack',
  ): Promise<{ papers: Paper[]; classNames: Map<string, string>; learners: UserEntity[] }> {
    // Fail loudly on a typo'd slug, as the two existing exports do: an empty
    // file looks like a class that sat nothing.
    if (read.project) this.content.getProject(read.project);
    const manager = this.dataSource.manager;
    const scope = await learnerScope(manager, caller);
    const where: FindOptionsWhere<UserEntity> = { ...scope };
    if (read.cohort !== undefined && read.cohort !== '') {
      await assertClassInScope(manager, caller, scope, read.cohort);
      where.cohort = Equal(read.cohort);
    }

    const learners = await manager.find(UserEntity, { where, order: { email: 'ASC' } });
    const byUser = new Map(learners.map((learner) => [learner.id, learner]));
    const enrollments = learners.length
      ? await manager.find(EnrollmentEntity, {
          where: { userId: In([...byUser.keys()]), ...(read.project ? { projectSlug: read.project } : {}) },
        })
      : [];
    const byEnrollment = new Map(enrollments.map((enrollment) => [enrollment.id, enrollment]));
    const states = enrollments.length
      ? await manager.find(PhaseStateEntity, { where: { enrollmentId: In([...byEnrollment.keys()]) } })
      : [];
    const byState = new Map(states.map((state) => [state.id, state]));
    // THE one ordered read of the papers: closed ones only, so an open paper
    // is never in memory, let alone in a file.
    const rows = states.length
      ? await manager.find(QuizAttemptEntity, {
          where: {
            phaseStateId: In([...byState.keys()]),
            submittedAt: Not(IsNull()),
            taskKey: papersOf === 'concept' ? In([...CONCEPT_TASK_KEYS]) : Not(In([...CONCEPT_TASK_KEYS])),
          },
          order: { phaseStateId: 'ASC', taskKey: 'ASC', epoch: 'ASC', submittedAt: 'ASC', id: 'ASC' },
        })
      : [];

    const papers: Paper[] = [];
    const checks = new Map<string, QuizChecks | null>();
    for (const row of rows) {
      const state = byState.get(row.phaseStateId);
      const enrollment = state ? byEnrollment.get(state.enrollmentId) : undefined;
      const learner = enrollment ? byUser.get(enrollment.userId) : undefined;
      // The scope is the phase row's enrolment's learner; a paper whose row
      // names somebody else is not this learner's paper and is not read.
      if (!state || !enrollment || !learner || row.userId !== learner.id) continue;
      const voided = row.voidedAt !== null && row.voidedAt !== undefined;
      papers.push({
        row,
        learner,
        enrollment,
        state,
        voided,
        attempt: null,
        outcomes: voided || papersOf === 'concept' ? null : this.outcomesOf(row, enrollment, state, checks),
      });
    }
    numberAttempts(papers);
    const classNames = await this.classNames([...new Set(learners.map((learner) => learner.cohort))]);
    return { papers, classNames, learners };
  }

  /** `scorePaper`'s per-question word over the paper's own pinned version, or null. */
  private outcomesOf(
    row: QuizAttemptEntity,
    enrollment: EnrollmentEntity,
    state: PhaseStateEntity,
    cache: Map<string, QuizChecks | null>,
  ): ('right' | 'wrong')[] | null {
    const key = [enrollment.projectSlug, row.projectVersionId, state.phaseKey, row.taskKey].join('\u0000');
    if (!cache.has(key)) cache.set(key, this.checksFor(enrollment.projectSlug, row.projectVersionId, state.phaseKey, row.taskKey));
    const checks = cache.get(key);
    if (!checks) return null;
    try {
      return scorePaper(checks, row.paper ?? [], row.answers ?? {}).questions.map((question) => question.outcome);
    } catch {
      // A paper asking a question its pinned version no longer declares: no
      // word is honest, so the paper has no question rows.
      return null;
    }
  }

  /**
   * The quiz slice of the version the paper names. Only that version: a pin
   * the deployment no longer holds resolves the head, and marking a paper
   * against another version's key would be a guess.
   */
  private checksFor(slug: string, versionId: string, phaseKey: string, taskKey: string): QuizChecks | null {
    try {
      const pin = { projectSlug: slug, projectVersionId: versionId };
      if (this.content.resolveForEnrollment(pin).versionId !== versionId) return null;
      const phase = this.content.getPhaseForEnrollment(pin, phaseKey);
      const task = this.content.getTasksForEnrollment(pin, phaseKey).find((one) => one.taskKey === taskKey);
      return task ? quizChecksFor(phase, task) : null;
    } catch {
      return null;
    }
  }

  /** Class names; a learner in no class, or a class without a name, reads blank rather than as an id. */
  private async classNames(cohorts: string[]): Promise<Map<string, string>> {
    return cohortNamesById(this.dataSource.manager, cohorts.filter((id) => UUID_PATTERN.test(id)));
  }

  /* ------------------------------- the files ------------------------------- */

  private learnersFile(papers: Paper[], classNames: Map<string, string>): string {
    const rows = learnerRecords(papers).map((record) =>
      line([
        record.learner.email,
        record.learner.displayName,
        classNames.get(record.learner.cohort) ?? '',
        record.enrollment.projectSlug,
        record.state.phaseKey,
        record.taskKey,
        record.attemptsUsed,
        record.attemptsVoided,
        record.bestScore ?? '',
        record.latestScore ?? '',
        yesNo(record.passed),
        record.firstSubmittedAt,
        record.lastSubmittedAt,
      ]),
    );
    return file(QUIZ_LEARNERS_COLUMNS, rows);
  }

  private attemptsFile(papers: Paper[], classNames: Map<string, string>): string {
    const rows = [...papers].sort(byPaper).map((paper) =>
      line([
        paper.learner.email,
        paper.learner.displayName,
        classNames.get(paper.learner.cohort) ?? '',
        paper.enrollment.projectSlug,
        paper.state.phaseKey,
        paper.row.taskKey,
        paper.row.epoch,
        paper.voided ? '' : paper.attempt,
        paper.voided ? 'voided' : 'submitted',
        paper.voided ? '' : paper.row.score,
        paper.voided ? '' : yesNo(paper.row.passed),
        paper.row.startedAt,
        paper.row.submittedAt,
        paper.row.packVersion,
      ]),
    );
    return file(QUIZ_ATTEMPTS_COLUMNS, rows);
  }

  private questionsFile(papers: Paper[], classNames: Map<string, string>): string {
    const rows: string[] = [];
    for (const paper of [...papers].sort(byPaper)) {
      if (paper.voided || !paper.outcomes) continue;
      paper.row.paper.forEach((drawn, at) => {
        rows.push(
          line([
            paper.learner.email,
            classNames.get(paper.learner.cohort) ?? '',
            paper.enrollment.projectSlug,
            paper.row.taskKey,
            paper.row.epoch,
            paper.attempt,
            at + 1,
            drawn.questionId,
            paper.outcomes![at],
          ]),
        );
      });
    }
    return file(QUIZ_QUESTIONS_COLUMNS, rows);
  }

  private classFile(papers: Paper[], classNames: Map<string, string>): string {
    const rows: string[] = [];
    for (const tally of classTallies(papers, classNames)) {
      for (const question of tally.questions) {
        rows.push(
          line([
            classNames.get(tally.cohort) ?? '',
            tally.project,
            tally.taskKey,
            question.questionId,
            question.drawn,
            question.right,
            // Blank, never 0, for a question with no draw to divide by.
            question.percentRight ?? '',
            tally.learnersAttempted,
            tally.learnersPassed,
          ]),
        );
      }
    }
    return file(QUIZ_CLASS_COLUMNS, rows);
  }
}

/* --------------------- the two builders ------------------------------------- */

/**
 * One row of quiz-learners.csv before it is a row: a learner × project × quiz
 * task they handed a paper in on. The learners file and the class summary both
 * read these, so a number on the dashboard and a cell of the file are one value.
 */
export interface QuizLearnerRecord {
  /** The group's first paper in read order: what the file's sort reads. */
  first: Paper;
  learner: UserEntity;
  enrollment: EnrollmentEntity;
  state: PhaseStateEntity;
  taskKey: string;
  /** Handed-in papers: closed and not voided. */
  attemptsUsed: number;
  attemptsVoided: number;
  /** The highest stored score among the handed-in papers; null when none was scored. */
  bestScore: number | null;
  /** The newest handed-in paper's stored score; null while its verdict has not landed. */
  latestScore: number | null;
  /** The latest run's (epoch's) stored pass: true, false, or null when no paper of it was graded. */
  passed: boolean | null;
  firstSubmittedAt: QuizAttemptEntity['submittedAt'];
  lastSubmittedAt: QuizAttemptEntity['submittedAt'];
}

/**
 * What quiz-learners.csv computes per learner × task, in the file's order
 * (email, project, phase order, task key). Pure: it reads the papers only.
 */
export function learnerRecords(papers: Paper[]): QuizLearnerRecord[] {
  const groups = new Map<string, Paper[]>();
  for (const paper of papers) {
    const key = `${paper.state.id}\u0000${paper.row.taskKey}`;
    const group = groups.get(key) ?? [];
    group.push(paper);
    groups.set(key, group);
  }
  const records: QuizLearnerRecord[] = [];
  for (const group of groups.values()) {
    const handedIn = group.filter((paper) => !paper.voided);
    // A learner whose only closed papers were voided has handed nothing in.
    if (!handedIn.length) continue;
    const first = group[0];
    const scores = handedIn.map((paper) => paper.row.score).filter((score): score is number => typeof score === 'number');
    const newest = handedIn.reduce((a, b) => (newerThan(b, a) ? b : a));
    const oldest = handedIn.reduce((a, b) => (newerThan(a, b) ? b : a));
    // `passed` is the latest run's: a reset starts a new epoch and withdraws
    // the pass, so a pass from before it is not a pass the board holds.
    const latestEpoch = Math.max(...handedIn.map((paper) => paper.row.epoch));
    const run = handedIn.filter((paper) => paper.row.epoch === latestEpoch);
    const passed = run.some((paper) => paper.row.passed === true)
      ? true
      : run.some((paper) => paper.row.passed === false)
        ? false
        : null;
    records.push({
      first,
      learner: first.learner,
      enrollment: first.enrollment,
      state: first.state,
      taskKey: first.row.taskKey,
      attemptsUsed: handedIn.length,
      attemptsVoided: group.length - handedIn.length,
      bestScore: scores.length ? Math.max(...scores) : null,
      latestScore: newest.row.score ?? null,
      passed,
      firstSubmittedAt: oldest.row.submittedAt,
      lastSubmittedAt: newest.row.submittedAt,
    });
  }
  records.sort((a, b) => byLearnerTask(a.first, b.first));
  return records;
}

/** One class × project × quiz task, as quiz-class.csv tallies it. */
export interface QuizClassTally {
  cohort: string;
  project: string;
  phaseOrder: number;
  phaseKey: string;
  taskKey: string;
  /** The version the task's first handed-in paper here was pinned to (for its title). */
  versionId: string;
  /** Handed-in papers, voided excluded. */
  attempts: number;
  /** One per question drawn here, in the file's order; `percentRight` null where the file is blank. */
  questions: { questionId: string; drawn: number; right: number; percentRight: number | null }[];
  /** Learners with a handed-in paper. */
  learnersAttempted: number;
  /** Learners whose latest run holds a pass: the learners file's `passed`, so the two files agree. */
  learnersPassed: number;
}

/**
 * What quiz-class.csv computes per class × project × quiz task, in the file's
 * order (class name, class, project, phase order, task key). Pure.
 */
export function classTallies(papers: Paper[], classNames: Map<string, string>): QuizClassTally[] {
  interface Tally {
    cohort: string;
    project: string;
    phaseOrder: number;
    phaseKey: string;
    taskKey: string;
    versionId: string;
    attempts: number;
    questions: Map<string, { drawn: number; right: number }>;
    /**
     * Per learner who handed a paper in: their latest run (epoch) and whether
     * it holds a pass; the learner file's `passed`, so the two files agree.
     */
    runs: Map<string, { epoch: number; passed: boolean }>;
  }
  const tallies = new Map<string, Tally>();
  for (const paper of papers) {
    if (paper.voided) continue;
    const key = [paper.learner.cohort, paper.enrollment.projectSlug, paper.state.phaseKey, paper.row.taskKey].join('\u0000');
    let tally = tallies.get(key);
    if (!tally) {
      tally = {
        cohort: paper.learner.cohort,
        project: paper.enrollment.projectSlug,
        phaseOrder: paper.state.phaseOrder,
        phaseKey: paper.state.phaseKey,
        taskKey: paper.row.taskKey,
        versionId: paper.row.projectVersionId,
        attempts: 0,
        questions: new Map(),
        runs: new Map(),
      };
      tallies.set(key, tally);
    }
    tally.attempts += 1;
    const run = tally.runs.get(paper.learner.id);
    const passed = paper.row.passed === true;
    if (!run || paper.row.epoch > run.epoch) tally.runs.set(paper.learner.id, { epoch: paper.row.epoch, passed });
    else if (paper.row.epoch === run.epoch && passed) run.passed = true;
    if (!paper.outcomes) continue;
    paper.row.paper.forEach((drawn, at) => {
      const counts = tally!.questions.get(drawn.questionId) ?? { drawn: 0, right: 0 };
      counts.drawn += 1;
      if (paper.outcomes![at] === 'right') counts.right += 1;
      tally!.questions.set(drawn.questionId, counts);
    });
  }
  const ordered = [...tallies.values()].sort(
    (a, b) =>
      (classNames.get(a.cohort) ?? '').localeCompare(classNames.get(b.cohort) ?? '') ||
      a.cohort.localeCompare(b.cohort) ||
      a.project.localeCompare(b.project) ||
      a.phaseOrder - b.phaseOrder ||
      a.taskKey.localeCompare(b.taskKey),
  );
  return ordered.map((tally) => ({
    cohort: tally.cohort,
    project: tally.project,
    phaseOrder: tally.phaseOrder,
    phaseKey: tally.phaseKey,
    taskKey: tally.taskKey,
    versionId: tally.versionId,
    attempts: tally.attempts,
    questions: [...tally.questions.keys()]
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((questionId) => {
        const counts = tally.questions.get(questionId)!;
        return {
          questionId,
          drawn: counts.drawn,
          right: counts.right,
          percentRight: counts.drawn ? Math.round((100 * counts.right) / counts.drawn) : null,
        };
      }),
    learnersAttempted: tally.runs.size,
    learnersPassed: [...tally.runs.values()].filter((run) => run.passed).length,
  }));
}

/** One decimal, as the dashboard states a score. */
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

/**
 * A quiz's numbers from its class tally and its attempting learners' best
 * stored scores. Title and declared are the caller's.
 */
function taskSummary(
  tally: Pick<QuizClassTally, 'project' | 'phaseKey' | 'taskKey' | 'attempts' | 'learnersAttempted' | 'learnersPassed' | 'questions'>,
  best: number[],
): Omit<QuizTaskSummary, 'title' | 'declared'> {
  const sorted = [...best].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const counts = new Map<QuizScoreBandKey, number>();
  for (const score of sorted) counts.set(quizScoreBand(score), (counts.get(quizScoreBand(score)) ?? 0) + 1);
  return {
    project: tally.project,
    phaseKey: tally.phaseKey,
    taskKey: tally.taskKey,
    attempts: tally.attempts,
    learnersAttempted: tally.learnersAttempted,
    learnersPassed: tally.learnersPassed,
    learnersNotYetPassed: tally.learnersAttempted - tally.learnersPassed,
    passRate: tally.learnersAttempted ? Math.round((100 * tally.learnersPassed) / tally.learnersAttempted) : null,
    meanBestScore: sorted.length ? oneDecimal(sorted.reduce((sum, score) => sum + score, 0) / sorted.length) : null,
    medianBestScore: sorted.length
      ? oneDecimal(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
      : null,
    bestScoreBands: QUIZ_SCORE_BANDS.map((band) => ({ band: band.key, learners: counts.get(band.key) ?? 0 })),
    questions: tally.questions.map((question) => ({ ...question })),
  };
}

/**
 * `attemptNumberOf`, in memory: per phase row, task and epoch, the papers
 * handed in (not voided) whose `submittedAt` is no later than this one's,
 * itself included. `submittedAt` is an ISO instant compared as text, which is
 * how both dialects compare it in that query.
 */
function numberAttempts(papers: Paper[]): void {
  const runs = new Map<string, string[]>();
  for (const paper of papers) {
    if (paper.voided) continue;
    const key = [paper.row.phaseStateId, paper.row.taskKey, paper.row.epoch].join('\u0000');
    const run = runs.get(key) ?? [];
    run.push(paper.row.submittedAt as string);
    runs.set(key, run);
  }
  for (const paper of papers) {
    if (paper.voided) continue;
    const run = runs.get([paper.row.phaseStateId, paper.row.taskKey, paper.row.epoch].join('\u0000'))!;
    const at = paper.row.submittedAt as string;
    paper.attempt = run.filter((stamp) => stamp <= at).length;
  }
}

/** Is `a` handed in after `b`: a later epoch, then a later instant. */
function newerThan(a: Paper, b: Paper): boolean {
  if (a.row.epoch !== b.row.epoch) return a.row.epoch > b.row.epoch;
  return (a.row.submittedAt as string) > (b.row.submittedAt as string);
}

/** Email, project, phase order, task key: the learner file's order, and the head of every other's. */
function byLearnerTask(a: Paper, b: Paper): number {
  return (
    a.learner.email.localeCompare(b.learner.email) ||
    a.enrollment.projectSlug.localeCompare(b.enrollment.projectSlug) ||
    a.state.phaseOrder - b.state.phaseOrder ||
    a.row.taskKey.localeCompare(b.row.taskKey)
  );
}

/** The learner order, then epoch, then the moment the paper closed. */
function byPaper(a: Paper, b: Paper): number {
  const head = byLearnerTask(a, b);
  if (head) return head;
  if (a.row.epoch !== b.row.epoch) return a.row.epoch - b.row.epoch;
  const at = (a.row.submittedAt as string).localeCompare(b.row.submittedAt as string);
  return at || a.row.id.localeCompare(b.row.id);
}
