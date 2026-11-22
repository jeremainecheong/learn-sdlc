import { IsObject } from 'class-validator';

/* -------------------------------------------------------------------------
 * What a learner sends, and what a learner reads.
 *
 * The body a learner posts is declared here, because it is this controller's
 * and nothing else parses it. The three **response** shapes are the shared
 * package's and are re-exported at the foot of this file: they have two
 * readers, these routes and the quiz room's own client, and one contract
 * written twice is a contract that can drift.
 *
 * The seal is structural rather than filtered. `QuizPaperQuestion` has no
 * field a key or an explanation could travel in, so *"the answer key is not on
 * this route"* is a statement about the type and not about the care taken at a
 * call site. See `QuizQuestion` in the shared package for the three-tier rule
 * these types are the top tier of.
 * ------------------------------------------------------------------------- */

/**
 * The sheet a learner hands in: their question ids, and for each the option
 * **tokens** they picked, the per-paper names the paper served the options by
 * (`optionToken`), never the ids the teacher wrote. `QuizService` maps them
 * back to authored ids before anything is stored or scored.
 *
 * `@IsObject()` is the same declaration the workspace save's `files` map
 * carries, and for the same reason: the keys are the learner's own question
 * ids and no DTO can enumerate them. It is also why `BodyKeysGuard` is mounted
 * on this controller: a free-form map is exactly the shape a `__proto__` key
 * disappears into.
 *
 * What the decorator cannot say is that every **value** is a list of option
 * ids, so `QuizService` says it, against the paper that was actually drawn: a
 * sheet is checked against a learner's own paper or not at all.
 */
export class QuizHandInDto {
  @IsObject()
  answers: Record<string, string[]>;
}

/*
 * The three response shapes live in `packages/shared`.
 *
 * Declared here and again in the quiz room's own client, written to agree by
 * hand, each side's specs would hold its own copy and nothing would hold the
 * pair, so a field renamed on either side would be `undefined` in the room
 * with both suites green. They are re-exported rather than re-declared,
 * so this file is still the place a reader of these routes looks, and the
 * declaration they find is the one the room imports too.
 */
export type { QuizOpenPaper, QuizPaperQuestion } from '@learnsdlc/shared';

/*
 * The room. `passCredited` is part of the shared `QuizRoomView`, so there is
 * no local intersection and this is the one declaration the route and the
 * room both read.
 */
export type { QuizRoomView } from '@learnsdlc/shared';
