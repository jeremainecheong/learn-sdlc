import { createHmac } from 'crypto';
import { Injectable } from '@nestjs/common';
import { IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import type { QuizChecks } from '@learnsdlc/shared';
import { config } from '../config';
import { QuizAttemptEntity, type QuizAttemptPaperQuestion } from '../db/entities';
import { InjectRepository } from '../db/inject';

/**
 * Who a paper is drawn for.
 *
 * The four facts the seed is taken over, and they are the four that make one
 * learner's paper theirs: a second learner, a re-pin, a sibling quiz and a
 * retake each draw a different paper, and a reload of the same one draws the
 * same paper again.
 */
export interface PaperDraw {
  userId: string;
  /** The pin this paper is drawn against; a published version is immutable. */
  projectVersionId: string;
  taskKey: string;
  /**
   * Which run of this quiz the paper belongs to: `task_states.resetCount`.
   *
   * A teacher's reset returns a learner's attempts, so attempt 1 of the new
   * epoch must not be the paper they already sat as attempt 1 of the old one.
   * `0` is *nobody has reset this task*.
   */
  epoch: number;
  /** 1-based **within the epoch**, and the number this paper *will* be once it is handed in. */
  attemptNumber: number;
  /**
   * The questions this learner's **last paper** asked, which this draw prefers
   * not to ask again: see `drawPaper`. Absent or empty on a first paper.
   *
   * **Not part of the seed.** It re-orders the one seeded stream rather than
   * seeding a second, so a paper with nothing to prefer against is the paper
   * that was always drawn, and a redraw from the same record is the same
   * paper. `QuizAttemptsService.start` reads it off the record
   * (`lastPaper`), never from anything a caller said.
   */
  previousQuestionIds?: readonly string[];
}

/**
 * The domain separator, so that a quiz seed can never be mistaken for, or
 * collide with: anything else the deployment's secret is asked to sign.
 */
const PAPER_DOMAIN = 'learnsdlc:quiz-paper:v1';

/**
 * The byte the seed's fields are joined with: NUL, which cannot occur inside a
 * user id, a version id, a task key or a decimal number.
 *
 * **Written as an escape, and that is the whole of this constant.** Typed as
 * a literal NUL it would make this file `data` rather than text: `file`
 * reports binary, `git diff` prints *"Binary files differ"* with no lines at
 * all, and a repo-wide grep for a symbol defined here silently finds nothing.
 * `'\u0000'` compiles to the identical byte, so every seed and therefore
 * every paper drawn is the same either way; the spec
 * beside this file pins one seed and one whole draw to say so rather than to
 * hope it.
 */
const PAPER_FIELD_SEPARATOR = '\u0000';

/**
 * The key papers and option tokens are keyed with: QUIZ_SEED_SECRET when it is
 * set, and otherwise the JWT secret, so a deployment that leaves it unset
 * draws every paper and names every option exactly as the JWT secret does.
 */
function quizSeedKey(): string {
  return config.quizSeedSecret || config.jwtSecret;
}

/**
 * The seed a paper is drawn from: `HMAC(serverSecret, userId + projectVersionId
 * + taskKey + attemptNumber)`, never the raw user id.
 *
 * **The raw id would be predictable and this is not.** A learner who knew the
 * rule *"the draw is a function of my id"* could work out their own next paper
 * before they started it, which is a pool that stopped being a pool. With the
 * deployment's secret in front of it, the draw is reproducible on the server:
 * a lost insert redraws the identical paper, and unguessable off it.
 *
 * The fields are joined with a separator that cannot occur inside any of them,
 * so `('ab', 'c')` and `('a', 'bc')` are different messages.
 *
 * **The epoch joins the message only when there has been a reset.** A reset
 * returns the learner's attempts and the numbering starts again, so without it
 * attempt 1 of the new epoch would be the paper they already sat. Epoch `0`:
 * every paper on every task nobody has reset: contributes no token at all,
 * which is what keeps the seed of an un-reset quiz exactly the seed it has
 * always been. The token cannot be confused with a field: a message with an
 * epoch has six parts and a message without one has five, and no field can
 * contain the separator that would let the two line up.
 */
export function paperSeed(draw: PaperDraw): Buffer {
  const message = [
    PAPER_DOMAIN,
    draw.userId,
    draw.projectVersionId,
    draw.taskKey,
    ...(draw.epoch ? [`epoch:${draw.epoch}`] : []),
    String(draw.attemptNumber),
  ].join(PAPER_FIELD_SEPARATOR);
  return createHmac('sha256', quizSeedKey()).update(message).digest();
}

/**
 * The attempt epoch a paper belongs to, read off the task's own row.
 *
 * **One rule, in one place: `task_states.resetCount` IS the attempt epoch.**
 * The teacher's per-task reset already increments that column, so making the
 * epoch a second counter would be two facts that can drift; making it this one
 * means the reset needs no new write and the two can never disagree. A task
 * with no row yet has had no reset, which is epoch `0`, the column's default
 * on every paper drawn on a task nobody has reset.
 *
 * It is a function rather than three copies of `?? 0` because the three
 * services that ask it (the learner's routes, the grader and the teacher's
 * console) must all get the same answer for a task nobody has touched.
 */
export function attemptEpochOf(row: { resetCount: number } | null | undefined): number {
  return row?.resetCount ?? 0;
}

/**
 * A deterministic stream of numbers from one seed.
 *
 * `Math.random` is the wrong tool twice over: it is not reproducible, so a
 * redraw of the same paper would not be the same paper, and it is not keyed, so
 * two learners could be handed the same permutation by luck. This is HMAC in
 * counter mode: the same primitive the seed is taken with, so the file carries
 * one cryptographic dependency and not two.
 */
class SeededStream {
  private counter = 0;
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly seed: Buffer) {}

  /** The next 32-bit value, big-endian, from the stream. */
  private next(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHmac('sha256', this.seed).update(String(this.counter++)).digest();
      this.offset = 0;
    }
    const value = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  /** A value in `0..bound-1`, rejecting the biased tail rather than folding it. */
  belowBound(bound: number): number {
    if (bound <= 1) return 0;
    const limit = Math.floor(0x100000000 / bound) * bound;
    let value = this.next();
    while (value >= limit) value = this.next();
    return value % bound;
  }

  /** Fisher-Yates over a copy, so the caller's array is never reordered. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.belowBound(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * One paper, drawn from the task's sealed pool.
 *
 * Two decisions are written down here rather than left to a reader.
 *
 * **Which questions.** `drawn` absent (or equal to the pool) is the whole
 * pool *in the teacher's declared order*, which is what `QuizChecks.drawn`'s
 * own docstring says. A smaller `drawn` is a seeded subset, and it is still
 * presented in the declared order: the thing a pool varies is *which* questions
 * a retake asks, not the order the teacher thought they read best in.
 *
 * **A retake prefers what the last paper left out.** The publish
 * wall, `quiz-retake-is-a-new-paper`, tells the teacher that a pool larger than
 * the paper makes *"a retake a different paper"*, and an independent draw only
 * keeps that promise on average: pool 3, draw 2 hands a learner the same two
 * questions one retake in three. So the seeded order of the pool is taken
 * unchanged and then **stably partitioned**: the questions the last
 * paper did not ask come first, in their seeded order, and the ones it did ask
 * follow, in theirs. The paper is the front `drawn` of that. It therefore
 * repeats `max(0, 2·drawn − pool)` of the last paper's questions: the fewest
 * any paper of that size can, and which ones it repeats is still the seed's
 * choice, not the teacher's order. With nothing to prefer against the partition
 * is the identity, so every first paper is the paper it always was; and the
 * stream's consumption does not depend on the preference, so the option
 * permutations after it do not move either.
 *
 * "The last paper" is the newest paper the learner had in front of them on
 * this task, read off the record by `QuizAttemptsService.lastPaper`: across a
 * teacher's reset too, because the new run's first paper is the one that must
 * not be the paper the old run ended on.
 *
 * **Which options.** Permuted per question when `shuffleOptions`, and the row
 * records the permutation, which is the only reason it is recorded at all.
 * Scoring never reads it: a learner submits **option ids**, never indices, so a
 * shuffled paper and an unshuffled one score identically on the same picks.
 *
 * The key is not touched. `QuizQuestion.correct` is read by the scorer, off the
 * pinned version's sealed slice, and is never copied onto a row.
 */
export function drawPaper(checks: QuizChecks, draw: PaperDraw): QuizAttemptPaperQuestion[] {
  const stream = new SeededStream(paperSeed(draw));
  const pool = checks.questions;
  const wanted = checks.drawn ?? pool.length;
  let chosen = pool;
  if (wanted < pool.length) {
    const seeded = stream.shuffled(pool.map((question) => question.id));
    const asked = new Set(draw.previousQuestionIds ?? []);
    const ids = [
      ...seeded.filter((id) => !asked.has(id)),
      ...seeded.filter((id) => asked.has(id)),
    ].slice(0, Math.max(0, wanted));
    const drawnIds = new Set(ids);
    chosen = pool.filter((question) => drawnIds.has(question.id));
  }
  return chosen.map((question) => {
    const ids = question.options.map((option) => option.id);
    return { questionId: question.id, optionIds: checks.shuffleOptions ? stream.shuffled(ids) : ids };
  });
}

/** The domain separator for an option token, beside `PAPER_DOMAIN` and for the same reason. */
const OPTION_TOKEN_DOMAIN = 'learnsdlc:quiz-option:v1';

/**
 * The name one option goes by **on one paper**: what the learner reads, sends
 * and is shown back, in place of the id the teacher wrote.
 *
 * **The side channel this closes.** Authored option ids are the order the
 * teacher wrote the options in (`a`, `b`, … in every authoring form), so a
 * paper that shuffled its options and still named them by those ids told the
 * learner the authored order anyway, and a teacher who always writes the
 * right answer first would have leaked the key by position, on every paper,
 * to every learner. A token carries none of that: it is
 * `HMAC(serverSecret, domain + attemptId + questionId + optionId)`, with the
 * same secret and the same field separator the paper seed uses, so it is
 * reproducible on the server and unguessable off it.
 *
 * **Stable for the paper, and for nothing else.** The attempt id is a row's
 * own uuid, so a reload, the offered-back sheet and the marked report all name
 * an option the same way, and no two papers, and no two learners, share a
 * token for anything. The questions keep their authored ids: a question id
 * says which question was asked, never which option answers it.
 *
 * Lowercase hex behind a letter, so it is a valid HTML id and CSS identifier
 * as it stands, and never looks like a number to anything that parses it.
 * Everything behind the wire: the stored sheet, the scorer, the teacher's
 * authoring view and a regrade: works in authored ids; `quiz.service.ts`
 * maps a sheet back at hand-in and `buildQuizReport` maps a report out.
 */
export function optionToken(attemptId: string, questionId: string, optionId: string): string {
  const message = [OPTION_TOKEN_DOMAIN, attemptId, questionId, optionId].join(PAPER_FIELD_SEPARATOR);
  return `o${createHmac('sha256', quizSeedKey()).update(message).digest('hex').slice(0, 24)}`;
}

/**
 * A sheet in authored ids, as this paper's tokens: the learner's own answers
 * named the way the learner was shown the options.
 *
 * The one direction every learner payload needs: the offered-back paper's
 * `selected` and the report's `selected` are both this, over the same paper,
 * so the two can never name the learner's answer differently.
 */
export function sheetInTokens(
  attemptId: string,
  sheet: Record<string, readonly string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(sheet).map(([questionId, picked]) => [
      questionId,
      picked.map((optionId) => optionToken(attemptId, questionId, optionId)),
    ]),
  );
}

/**
 * The one writer of `quiz_attempts`.
 *
 * Every row in that table is drawn, closed, linked and scored through a method
 * on this class, so *"what can put a paper in the record"* has one answer. The
 * learner's three quiz routes call it, and so does `FeedbackService`, which
 * builds its own instance over the manager it already holds rather than taking
 * another constructor argument: the same reason `taskStates` is a getter
 * there. Two instances over one DataSource are two handles on one table.
 *
 * It declares no Nest module: `quiz.module.ts` provides it, and `DatabaseModule`
 * already provides `QuizAttemptEntity`'s repository.
 *
 * **What is not here.** Nothing on this class knows a pass mark, a rubric or a
 * criterion, and nothing here scores. The sheet is written when it is handed
 * in; the verdict is produced by the submission job, which is what keeps
 * request latency from carrying how many answers were right.
 *
 * **And nothing here deletes a row.** `voidOpen` closes a paper a teacher's
 * reset found open; every other write adds to what is already in the record.
 * A learner's papers are the record an appeal reads.
 *
 * **Every count takes an epoch, and the parameter is required.** A default
 * would be a second answer to *which run of this quiz is being counted*, and
 * the wrong one is the defect the epoch exists to make impossible: a learner
 * whose teacher has reset the task reading their old attempts back as spent.
 * `open` is the one exception, and for a stated reason: see there.
 */
@Injectable()
export class QuizAttemptsService {
  constructor(
    @InjectRepository(QuizAttemptEntity)
    private readonly attempts: Repository<QuizAttemptEntity>,
  ) {}

  /**
   * A paper that was really handed in, on this task, **in this epoch**.
   *
   * Three conditions and each one is a decision. `submittedAt IS NOT NULL` is
   * *closed*, which is `IDX_quiz_attempts_task`'s leading columns plus one
   * column. `voidedAt IS NULL` takes out the paper a reset closed without it
   * ever being sat: closed so it leaves the open index, never handed in, so it
   * can spend nothing. And `epoch` is what makes the teacher's reset a
   * recovery rather than a wipe: the rows of every earlier epoch stay in the
   * record and count towards nothing.
   */
  private closedIn(phaseStateId: string, taskKey: string, epoch: number) {
    return { phaseStateId, taskKey, epoch, submittedAt: Not(IsNull()), voidedAt: IsNull() };
  }

  /**
   * How many papers this learner has **handed in** on this task, this epoch.
   *
   * This is the quiz's own limit and the learner's *attempts used*; it is never
   * `task_states.attempts`, and `task_states.attempts` is never this. Two
   * counters, two questions, each with one reader.
   *
   * `epoch` is required rather than defaulted, and deliberately: a default
   * would be a second answer to *which run of this quiz is being counted*, and
   * the wrong one is exactly the defect this parameter exists to make
   * impossible, a learner whose teacher has reset the task reading their old
   * attempts back as spent.
   */
  async handedIn(phaseStateId: string, taskKey: string, epoch: number): Promise<number> {
    return this.attempts.count({ where: this.closedIn(phaseStateId, taskKey, epoch) });
  }

  /**
   * Which attempt **this** paper was, within its own epoch.
   *
   * `handedIn` above answers *how many have been sat by now*, which is the
   * right question for a learner in front of the quiz and the wrong one for a
   * report. A stored report's `attempt` and `attemptsLeft` are facts about the
   * paper, so a regrade months later must read the numbers that were true when
   * that paper was handed in: otherwise a regrade of revision one reads
   * "attempt 3", and because `attemptsLeft === 0` is also the
   * explanation-release door, a regrade could release explanations the
   * original revision withheld.
   *
   * Counted over the papers of this paper's epoch handed in no later than it
   * was. `submittedAt` is an ISO instant with milliseconds in a varchar, which
   * compares as text on both dialects, and an open row is excluded for free
   * because `NULL <= x` is never true. The paper itself is one of them, so the
   * first sheet of an epoch is attempt 1.
   */
  async attemptNumberOf(paper: QuizAttemptEntity): Promise<number> {
    if (!paper.submittedAt) return 0;
    return this.attempts.count({
      where: {
        phaseStateId: paper.phaseStateId,
        taskKey: paper.taskKey,
        epoch: paper.epoch,
        voidedAt: IsNull(),
        submittedAt: LessThanOrEqual(paper.submittedAt),
      },
    });
  }

  /**
   * The paper still open on this task, or null. At most one, by the index.
   *
   * **Not epoch-scoped, and that is the index's shape rather than an
   * oversight.** `UQ_quiz_attempts_open` guarantees *at most one open paper per
   * learner and task*, full stop; scoping it to an epoch would let two open
   * papers exist at once, and scoping only this read would leave the read and
   * the constraint disagreeing: the read would say *no open paper* while the
   * insert behind it was refused. So this mirrors the index, and the invariant
   * that an open paper is always of the current epoch is kept by the reset,
   * which voids the one it finds.
   */
  async open(phaseStateId: string, taskKey: string): Promise<QuizAttemptEntity | null> {
    return this.attempts.findOne({ where: { phaseStateId, taskKey, submittedAt: IsNull() } });
  }

  /**
   * Close an open paper without it ever having been sat: the teacher's reset.
   *
   * **The one write that ends a paper with no sheet.** A reset starts a new
   * attempt epoch, and a paper open at that moment belongs to the epoch that
   * just ended: leaving it open would hold `UQ_quiz_attempts_open` against the
   * learner's first new paper, and leaving it startable would let a sheet from
   * before the reset be handed in after it. So it is closed: `submittedAt`, so
   * the row leaves the index, and marked `voidedAt`, so that it is never
   * scored, never counted, never linked to a revision and never handed back by
   * `latestHandedIn`. A stale hand-in of it then meets the same single refusal
   * sentence every other wrong attempt id meets, which is what keeps the
   * refusal from being an oracle.
   *
   * The row itself stays. A learner's papers are the record and nothing here
   * deletes one.
   *
   * Returns the id it closed, so the audit row can name it, or null when there
   * was nothing open.
   */
  async voidOpen(phaseStateId: string, taskKey: string): Promise<string | null> {
    const held = await this.open(phaseStateId, taskKey);
    if (!held) return null;
    return (await this.voidPaper(held.id)) ? held.id : null;
  }

  /** Scoped to a row that is still open, so a hand-in landing first wins. */
  private async voidPaper(attemptId: string): Promise<boolean> {
    const at = new Date().toISOString();
    const written = await this.attempts.update(
      { id: attemptId, submittedAt: IsNull() },
      { submittedAt: at, voidedAt: at },
    );
    return !!written.affected;
  }

  /**
   * The newest paper this learner has handed in on this task.
   *
   * Ordered on `submittedAt` first: it is an ISO instant with milliseconds,
   * where `createdAt` is a timestamp two rows can share inside one sqlite
   * second. This is the row the grader scores, and `FeedbackService.submit`
   * refuses a hand-in that does not name it, so the paper that was verified
   * and the paper that is scored are one row by construction.
   *
   * Scoped to the epoch, like the count beside it: after a reset the newest
   * sheet of the run that ended is not a paper anything is still deciding
   * about, and a stale hand-in naming it must be refused rather than marked.
   */
  async latestHandedIn(
    phaseStateId: string,
    taskKey: string,
    epoch: number,
  ): Promise<QuizAttemptEntity | null> {
    // `startedAt` second: a learner's papers on one task are strictly one
    // after another, so of two sheets closed inside one millisecond the later
    // paper is the one started later, which `createdAt`, a timestamp two rows
    // can share inside one sqlite second, cannot say.
    return this.attempts.findOne({
      where: this.closedIn(phaseStateId, taskKey, epoch),
      order: { submittedAt: 'DESC', startedAt: 'DESC', createdAt: 'DESC' },
    });
  }

  /**
   * The paper one revision was handed in as, by the column that names it.
   *
   * `latestHandedIn` above answers *which sheet is newest*, which is the right
   * question for a grader that has no revision in hand and the wrong one for a
   * grader that has. A regrade arrives months later, through `gradeSnapshot`
   * and not through `submit`, so neither of the refusals that make *newest*
   * and *this revision's* the same row on the live path is standing in front
   * of it. `submissionId` is written before the job is enqueued and is unique
   * to the revision, so this is the question asked directly.
   */
  async forSubmission(submissionId: string): Promise<QuizAttemptEntity | null> {
    return this.attempts.findOne({ where: { submissionId } });
  }

  /**
   * The last paper this learner had in front of them on this task: what the
   * next draw prefers not to ask again (`drawPaper`).
   *
   * **Closed rows of this epoch or an earlier one, newest first.** Within an
   * epoch that is the paper the retake follows. On the first paper of a new
   * epoch it is the paper the run a teacher reset ended on, and that is the
   * one that matters most, because a run that ended with its attempts spent
   * has just released that paper's explanations.
   *
   * **A voided paper counts, deliberately.** It was open when the reset closed
   * it, so the learner had already read its questions; it spends no attempt
   * and is never scored, but a new run that re-asked it would be the same
   * paper they were just looking at. An open paper is not a last paper: it is
   * the current one, and `start` hands it back rather than drawing.
   *
   * Epoch first in the order, because epochs only ever move forward; then
   * `submittedAt`, an ISO instant with milliseconds, as `latestHandedIn`
   * orders, and `startedAt` beside it, because a learner's papers on one task
   * are strictly one after another (`UQ_quiz_attempts_open`). Two papers
   * closed inside one millisecond are a fixture's artefact rather than a
   * learner's, but the order must not be the database's whim even then: the
   * id is the last key, so the same record always names the same last paper
   * and a redraw from it is the same paper.
   */
  async lastPaper(
    phaseStateId: string,
    taskKey: string,
    epoch: number,
  ): Promise<QuizAttemptEntity | null> {
    return this.attempts.findOne({
      where: { phaseStateId, taskKey, epoch: LessThanOrEqual(epoch), submittedAt: Not(IsNull()) },
      order: { epoch: 'DESC', submittedAt: 'DESC', startedAt: 'DESC', createdAt: 'DESC', id: 'DESC' },
    });
  }

  /**
   * Start a paper, idempotently.
   *
   * A double-start is not a second paper: while a row has `submittedAt IS
   * NULL`, `UQ_quiz_attempts_open` refuses a second insert, so the open row is
   * handed back and the learner reads the questions they were already reading.
   * The read above it answers the same thing without waiting for the database
   * to say so; the constraint is what makes it true under a race.
   *
   * **An open paper of an epoch that has ended is not handed back.** The reset
   * voids the one it finds, inside its own transaction, so this is belt and
   * braces rather than a case anybody can reach, but the row it would hand
   * back is a paper drawn against a run the teacher has closed, and counting
   * against nothing. It is closed the same way the reset would have closed it,
   * and a fresh paper is drawn.
   */
  async start(input: {
    phaseStateId: string;
    userId: string;
    taskKey: string;
    projectVersionId: string;
    packVersion?: string | null;
    /** The task's current attempt epoch: `attemptEpochOf(task row)`. */
    epoch: number;
    checks: QuizChecks;
  }): Promise<QuizAttemptEntity> {
    const held = await this.open(input.phaseStateId, input.taskKey);
    if (held) {
      if (held.epoch === input.epoch) return held;
      await this.voidPaper(held.id);
    }

    const attemptNumber =
      (await this.handedIn(input.phaseStateId, input.taskKey, input.epoch)) + 1;
    // Read off the record, after the stale paper above has been closed, so a
    // paper a reset left open is avoided like any other last paper, and a
    // redraw from the same record is the same paper.
    const last = await this.lastPaper(input.phaseStateId, input.taskKey, input.epoch);
    const paper = drawPaper(input.checks, {
      userId: input.userId,
      projectVersionId: input.projectVersionId,
      taskKey: input.taskKey,
      epoch: input.epoch,
      attemptNumber,
      previousQuestionIds: last?.paper.map((one) => one.questionId) ?? [],
    });
    try {
      return await this.attempts.save(
        this.attempts.create({
          phaseStateId: input.phaseStateId,
          userId: input.userId,
          taskKey: input.taskKey,
          epoch: input.epoch,
          voidedAt: null,
          projectVersionId: input.projectVersionId,
          packVersion: input.packVersion ?? null,
          paper,
          answers: null,
          score: null,
          passed: null,
          startedAt: new Date().toISOString(),
          submittedAt: null,
          submissionId: null,
        }),
      );
    } catch (err) {
      // The index decided the race. The winner's paper is the paper.
      const winner = await this.open(input.phaseStateId, input.taskKey);
      if (!winner) throw err;
      return winner;
    }
  }

  /**
   * Close a paper: the sheet, and the instant it was handed in.
   *
   * Narrow, and scoped to a row that is still open, so a replayed request
   * cannot overwrite a sheet that is already in the record: the route's own
   * `submittedAt IS NOT NULL` refusal says so first, and this is the write that
   * cannot be talked out of it. `update` and never `save`: the paper drawn at
   * start is not this request's to rewrite. A paper a reset voided is closed,
   * so this is also what keeps a stale sheet from landing on it.
   */
  async handIn(attemptId: string, answers: Record<string, string[]>): Promise<boolean> {
    const written = await this.attempts.update(
      { id: attemptId, submittedAt: IsNull() },
      { answers, submittedAt: new Date().toISOString() },
    );
    return !!written.affected;
  }

  /**
   * The revision this sheet was handed in as.
   *
   * Written before the grading job is enqueued, so a paper in the record always
   * names the submission that carries its verdict, and a row that names none
   * is a sheet whose submit never got as far as the queue.
   */
  async link(attemptId: string, submissionId: string): Promise<void> {
    await this.attempts.update({ id: attemptId, submissionId: IsNull() }, { submissionId });
  }

  /**
   * Take the link back, for a revision that never reached the queue.
   *
   * The counterpart of the refunded attempt beside it: a queue that answered 503
   * left the learner with no verdict, and a paper still naming that submission
   * would be a sheet nobody can hand in again and an attempt they spent on an
   * outage they did not cause. Scoped to the submission it names, so a
   * redelivery cannot unlink a paper that really was graded.
   */
  async unlink(attemptId: string, submissionId: string): Promise<void> {
    await this.attempts.update({ id: attemptId, submissionId }, { submissionId: null });
  }

  /**
   * The verdict, back on the paper it was earned on.
   *
   * Keyed on the submission rather than on the attempt id, because this is
   * written from the grading job, where the submission is the thing in hand.
   * `score` and `passed` are the same two numbers the submission carries; they
   * are here so that a learner's export (which walks `quiz_attempts`) reads
   * as a list of papers with results rather than a list of papers.
   */
  async record(submissionId: string, score: number, passed: boolean): Promise<void> {
    await this.attempts.update({ submissionId }, { score, passed });
  }

  /**
   * Close a concept-check paper with its sheet and its
   * mark in one write. A concept check has no submission and no grading job, so
   * the mark is computed in the request and written here, scoped to a row that
   * is still open, so a replayed hand-in cannot overwrite a sheet in the record.
   */
  async handInScored(
    attemptId: string,
    answers: Record<string, string[]>,
    score: number,
    passed: boolean,
  ): Promise<boolean> {
    const written = await this.attempts.update(
      { id: attemptId, submittedAt: IsNull() },
      { answers, score, passed, submittedAt: new Date().toISOString() },
    );
    return !!written.affected;
  }

  /** A paper by id, for the concept hand-in's read-back. */
  async byId(attemptId: string): Promise<QuizAttemptEntity | null> {
    return this.attempts.findOne({ where: { id: attemptId } });
  }
}
