import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { BodyKeysGuard } from '../body-keys.guard';
import { QuizHandInDto } from './quiz.dto';
import { QuizService } from './quiz.service';

/**
 * The learner's three quiz doors.
 *
 * `@Controller('phases')` beside `PhasesController` rather than inside it: the
 * three routes below live in one file of their own, and every path they declare
 * carries four segments or more, so none of them shadows (or is shadowed by)
 * `GET :id`, `POST :id/submit` or `POST :id/tasks/:taskKey/submit`.
 *
 * **`BodyKeysGuard` is mounted, and it is not a formality.** The hand-in body
 * is `{ answers: Record<questionId, optionId[]> }`, the free-form map shape
 * the guard exists for. Without it a body naming `__proto__` re-parents the
 * nested object and the answers **silently disappear** from what the service
 * scores, which is an unanswered sheet marked zero and a learner who has no way
 * to tell; one naming `constructor` 500s inside class-transformer instead of
 * refusing with a 400. Guards run ahead of pipes, which is the only point in
 * the request path where the raw parsed body can still be looked at whole.
 *
 * **Nothing here decides anything.** Ownership, the phase gate, which task the
 * key names, the limit, the cooldown, the pin and the sheet are all
 * `QuizService`'s, so there is one place those answers come from and no second
 * that can disagree.
 */
@Controller('phases')
@UseGuards(RateLimitGuard, BodyKeysGuard)
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  /**
   * The phase's two concept checks, `{ phaseKey,
   * before, after }`. The papers themselves use the three routes below with
   * the task keys `concept-before` and `concept-after`.
   */
  @Get(':id/concept-quizzes')
  conceptQuizzes(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.quiz.conceptQuizzes(user.id, id);
  }

  /**
   * The quiz as a learner reads it: the brief, how many questions a paper
   * draws, the pass mark, attempts used and left, any cooldown still running,
   * their best score, and the open paper if there is one.
   *
   * The answer key is on none of it, on any path, at any time. The explanation
   * is not on it either: a learner reads that in their scored report, where the
   * release rule is computed from the attempt row rather than sent as a flag.
   */
  @Get(':id/tasks/:taskKey/quiz')
  room(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.quiz.room(user.id, id, taskKey);
  }

  /**
   * Draw a paper, or hand back the one already open.
   *
   * `200` and not `201`, because a second press creates nothing: while a row
   * has `submittedAt IS NULL` the unique index refuses a second paper and the
   * open one is the answer. The limit is the same rate a Run is, not a
   * Submit's: a learner who reloads their quiz room is not grading anything.
   */
  @RateLimit(30, 60)
  @HttpCode(200)
  @Post(':id/tasks/:taskKey/quiz/attempts')
  start(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
  ) {
    return this.quiz.start(user.id, id, taskKey);
  }

  /**
   * Hand the sheet in, and answer with the revision the room already polls.
   *
   * The same limit the phase and per-task Submit routes carry, because this is
   * that request: the sheet is written, `FeedbackService.submit` is called with
   * the attempt id, and the verdict is produced by the submission job. Nothing
   * new polls.
   *
   * `attemptId` takes no `ParseUUIDPipe`, deliberately. The paper is found by
   * *this learner's own phase state and task*, never by looking the id up, so a
   * malformed id costs nothing and reads exactly as an unknown one: one
   * sentence for every way an attempt id can be wrong, rather than a pipe's
   * 400 that would tell a caller which ids are even shaped like papers.
   */
  @RateLimit(20, 60)
  @Post(':id/tasks/:taskKey/quiz/attempts/:attemptId')
  handIn(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('taskKey') taskKey: string,
    @Param('attemptId') attemptId: string,
    @Body() dto: QuizHandInDto,
  ) {
    return this.quiz.handIn(user.id, id, taskKey, attemptId, dto.answers);
  }
}
