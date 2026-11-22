import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { QuizChecks } from '@learnsdlc/shared';
import { config } from '../config';
import { QuizAttemptEntity } from '../db/entities';
import {
  attemptEpochOf,
  drawPaper,
  optionToken,
  paperSeed,
  QuizAttemptsService,
} from './quiz-attempts.service';

/**
 * The one writer of `quiz_attempts`.
 *
 * Two halves. The **draw** is pure and seeded, so a reload re-renders the same
 * paper, a re-score is deterministic, and a learner cannot work out their own
 * next paper from their own id. The **row** is where three devices with three
 * jobs meet: `UQ_quiz_attempts_open` makes a double start idempotent, the
 * explicit `submittedAt` refusal is the replay guard, and the closed-row count
 * is the limit. An earlier draft of the plan asked the index to do all three.
 */

const QUESTIONS: QuizChecks['questions'] = 'abcdefgh'.split('').map((letter, at) => ({
  id: `q-${letter}`,
  stem: `Fixture question ${at + 1}.`,
  options: [
    { id: 'one', text: 'The first' },
    { id: 'two', text: 'The second' },
    { id: 'three', text: 'The third' },
    { id: 'four', text: 'The fourth' },
  ],
  correct: ['one'],
  explanation: `Fixture explanation ${at + 1}.`,
  concept: 'fixtures',
}));

const checks = (over: Partial<QuizChecks> = {}): QuizChecks => ({
  kind: 'quiz',
  questions: QUESTIONS,
  shuffleOptions: false,
  passMark: 60,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
  ...over,
});

const draw = {
  userId: 'u-1',
  projectVersionId: 'v-1',
  taskKey: 'concepts',
  attemptNumber: 1,
  /** Epoch 0 is *no reset has happened*, which is every paper drawn before the recovery existed. */
  epoch: 0,
};

describe('the paper a learner is drawn', () => {
  it('is the whole pool, in the teacher’s order, when the quiz draws no subset', () => {
    const paper = drawPaper(checks(), draw);
    expect(paper.map((one) => one.questionId)).toEqual(QUESTIONS.map((one) => one.id));
    // `drawn` equal to the pool is the same statement said twice.
    expect(drawPaper(checks({ drawn: QUESTIONS.length }), draw)).toEqual(paper);
  });

  it('draws a subset of the size the teacher asked for, still in their order', () => {
    const paper = drawPaper(checks({ drawn: 3 }), draw);
    expect(paper).toHaveLength(3);
    const ids = paper.map((one) => one.questionId);
    expect(new Set(ids).size).toBe(3);
    // The thing a pool varies is WHICH questions a retake asks, not the order
    // the teacher thought they read best in.
    const declared = QUESTIONS.map((one) => one.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(declared);
  });

  it('is the same paper every time it is drawn for the same attempt', () => {
    // A lost insert redraws the identical paper, which is what makes the row
    // and the seed two statements of one fact rather than two papers.
    expect(drawPaper(checks({ drawn: 4, shuffleOptions: true }), draw)).toEqual(
      drawPaper(checks({ drawn: 4, shuffleOptions: true }), draw),
    );
  });

  it('is a different paper for a retake, another learner and another pin', () => {
    const first = drawPaper(checks({ drawn: 4 }), draw);
    const retake = drawPaper(checks({ drawn: 4 }), { ...draw, attemptNumber: 2 });
    const other = drawPaper(checks({ drawn: 4 }), { ...draw, userId: 'u-2' });
    const repinned = drawPaper(checks({ drawn: 4 }), { ...draw, projectVersionId: 'v-2' });
    const ids = (paper: typeof first) => paper.map((one) => one.questionId).join(',');
    expect(new Set([ids(first), ids(retake), ids(other), ids(repinned)]).size).toBeGreaterThan(1);
  });

  it('permutes the options only when the teacher asked for it', () => {
    const declared = QUESTIONS[0].options.map((one) => one.id);
    expect(drawPaper(checks(), draw)[0].optionIds).toEqual(declared);

    const shuffled = drawPaper(checks({ shuffleOptions: true }), draw);
    // Every option, and only the options: a permutation, never a subset.
    for (const [at, question] of QUESTIONS.entries()) {
      expect([...shuffled[at].optionIds].sort()).toEqual(
        question.options.map((one) => one.id).sort(),
      );
    }
    expect(shuffled.some((one) => one.optionIds.join(',') !== declared.join(','))).toBe(true);
  });

  it('carries no key and no explanation onto the row', () => {
    // A learner's export walks this table. The key is read by the scorer, off
    // the pinned version's sealed slice, and is copied nowhere.
    const wire = JSON.stringify(drawPaper(checks({ shuffleOptions: true }), draw));
    expect(wire).not.toContain('Fixture explanation');
    expect(wire).not.toMatch(/"correct"\s*:/);
    expect(wire).not.toContain('Fixture question');
  });

  it('separates the fields it is seeded over, so two joins are two seeds', () => {
    // Without a separator that cannot occur in any field, ('ab','c') and
    // ('a','bc') would be one message and two different papers would be one.
    expect(paperSeed({ ...draw, taskKey: 'ab', projectVersionId: 'c' })).not.toEqual(
      paperSeed({ ...draw, taskKey: 'a', projectVersionId: 'bc' }),
    );
  });

  it('keys papers and option tokens with QUIZ_SEED_SECRET when it is set, and with the JWT secret when it is not', () => {
    const held = config.quizSeedSecret;
    const pinned = '6dcee39ed3f6607c06ca96c409a06f96040bfe95bffeb35313b7c35b2250d2d8';
    try {
      config.quizSeedSecret = '';
      expect(paperSeed(draw).toString('hex')).toBe(pinned);
      const tokenUnderJwt = optionToken('att-1', 'q-a', 'one');

      config.quizSeedSecret = 'a-quiz-seed-secret-of-its-own';
      expect(paperSeed(draw).toString('hex')).not.toBe(pinned);
      expect(optionToken('att-1', 'q-a', 'one')).not.toBe(tokenUnderJwt);

      // Naming the JWT secret outright draws exactly the papers the default draws.
      config.quizSeedSecret = config.jwtSecret;
      expect(paperSeed(draw).toString('hex')).toBe(pinned);
      expect(optionToken('att-1', 'q-a', 'one')).toBe(tokenUnderJwt);
    } finally {
      config.quizSeedSecret = held;
    }
  });

  it('draws the paper it has always drawn: the separator is an escape, not a new byte', () => {
    // **A characterisation pin.** The domain separator is written as the
    // escape `'\u0000'`, not a literal NUL byte typed into the source: a raw
    // NUL makes the file binary to `file`, `git diff` and grep. The escape
    // compiles to the identical byte, and the way to say "identical" rather
    // than "similar" is to pin the seed and one whole draw as recorded with
    // the raw byte.
    //
    // `config.jwtSecret` is `test-secret` under `setup-env.js`, so this hash is
    // reproducible and is not a hostage to the environment.
    expect(paperSeed(draw).toString('hex')).toBe(
      '6dcee39ed3f6607c06ca96c409a06f96040bfe95bffeb35313b7c35b2250d2d8',
    );
    expect(drawPaper(checks({ drawn: 4, shuffleOptions: true }), draw)).toEqual([
      { questionId: 'q-c', optionIds: ['three', 'one', 'two', 'four'] },
      { questionId: 'q-d', optionIds: ['one', 'four', 'two', 'three'] },
      { questionId: 'q-f', optionIds: ['four', 'one', 'three', 'two'] },
      { questionId: 'q-g', optionIds: ['three', 'one', 'four', 'two'] },
    ]);
  });

  it('is a fresh paper on a new epoch, although the attempt number starts again', () => {
    // The recovery's whole point: a teacher's reset gives the learner their
    // attempts back, and attempt 1 of the new epoch must not be the paper they
    // already sat as attempt 1 of the old one. The epoch is in the seed for
    // exactly that, and it joins the message only when it is non-zero, so
    // every paper on a task nobody has reset draws as it always did.
    const before = drawPaper(checks({ drawn: 4, shuffleOptions: true }), draw);
    const after = drawPaper(checks({ drawn: 4, shuffleOptions: true }), { ...draw, epoch: 1 });
    expect(after).not.toEqual(before);
    expect(after.map((one) => one.questionId)).toEqual(['q-a', 'q-c', 'q-d', 'q-e']);
    // And it is still a redraw of one paper, not a random one: the same epoch
    // and the same attempt number are the same paper however often it is asked.
    expect(drawPaper(checks({ drawn: 4, shuffleOptions: true }), { ...draw, epoch: 1 })).toEqual(
      after,
    );
  });

  /* ------------ the retake prefers what the last paper left out ----------- */

  it('draws a first paper exactly as it always has, with no last paper to prefer', () => {
    // The preference is a re-ordering of the SAME seeded stream, so a learner
    // sitting a quiz for the first time (every paper TaskTrackr has ever
    // drawn, and every characterisation pin above) draws what it always drew.
    expect(
      drawPaper(checks({ drawn: 4, shuffleOptions: true }), { ...draw, previousQuestionIds: [] }),
    ).toEqual(drawPaper(checks({ drawn: 4, shuffleOptions: true }), draw));
  });

  it('prefers the questions the learner’s last paper did not ask', () => {
    // The publish wall promises that a retake is a different paper; an
    // independent draw only promises it on average. Eight in the pool and
    // three drawn leaves five unasked, so a retake that fills from the rest of
    // the pool first repeats nothing at all.
    const asked = drawPaper(checks({ drawn: 3 }), draw).map((one) => one.questionId);
    const retake = drawPaper(checks({ drawn: 3 }), {
      ...draw,
      attemptNumber: 2,
      previousQuestionIds: asked,
    });
    expect(retake.map((one) => one.questionId).filter((id) => asked.includes(id))).toEqual([]);
  });

  it('fills from the last paper only once the rest of the pool is spent', () => {
    // `quiz-retake-is-a-new-paper` requires only `drawn < questions.length`, so
    // pool == drawn + 1 is the tightest quiz a teacher can publish: exactly one
    // question the last paper did not ask. The retake asks it and fills the
    // rest from the last paper, never the same paper twice, which is what an
    // independent draw could not promise (pool 3, draw 2 was 1 in 3).
    const tight = checks({ questions: QUESTIONS.slice(0, 4), drawn: 3 });
    for (let attemptNumber = 2; attemptNumber <= 12; attemptNumber += 1) {
      const previous = drawPaper(tight, { ...draw, attemptNumber: attemptNumber - 1 }).map(
        (one) => one.questionId,
      );
      const ids = drawPaper(tight, { ...draw, attemptNumber, previousQuestionIds: previous }).map(
        (one) => one.questionId,
      );
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect(ids).not.toEqual(previous);
      // One question the last paper did not ask, every time.
      expect(ids.filter((id) => !previous.includes(id))).toHaveLength(1);
    }
  });

  it('is the same retake every time it is drawn, so a regrade redraws it', () => {
    const previousQuestionIds = ['q-a', 'q-c'];
    const one = drawPaper(checks({ drawn: 3, shuffleOptions: true }), {
      ...draw,
      attemptNumber: 2,
      previousQuestionIds,
    });
    expect(
      drawPaper(checks({ drawn: 3, shuffleOptions: true }), {
        ...draw,
        attemptNumber: 2,
        previousQuestionIds,
      }),
    ).toEqual(one);
    // Deterministic, and still a preference: neither of the two it was told to
    // avoid is on it.
    expect(one.map((paper) => paper.questionId).some((id) => previousQuestionIds.includes(id))).toBe(
      false,
    );
  });

  it('has nothing to prefer when the quiz draws its whole pool', () => {
    // An optional quiz with no subset (and a quiz with no limit) asks every
    // question the teacher wrote, whatever the last paper asked.
    const whole = drawPaper(checks(), {
      ...draw,
      attemptNumber: 4,
      previousQuestionIds: QUESTIONS.map((one) => one.id),
    });
    expect(whole.map((one) => one.questionId)).toEqual(QUESTIONS.map((one) => one.id));
  });

  /* ------------------ the option tokens a paper is read in ---------------- */

  it('gives one paper’s option its own token, and the same one every time', () => {
    // The learner reads and sends a token, never the id the teacher wrote, so
    // a teacher who always writes the right answer first leaks nothing by
    // position. It is stable for the paper it belongs to: a reload, a redraw
    // and the marked report all have to name the same option.
    expect(optionToken('att-1', 'q-a', 'one')).toBe(optionToken('att-1', 'q-a', 'one'));
    // and it says nothing the authored id said
    expect(optionToken('att-1', 'q-a', 'one')).not.toContain('one');

    const tokens = [
      optionToken('att-1', 'q-a', 'one'),
      optionToken('att-1', 'q-a', 'two'),
      // another paper, another question, and the same authored id
      optionToken('att-2', 'q-a', 'one'),
      optionToken('att-1', 'q-b', 'one'),
    ];
    expect(new Set(tokens).size).toBe(4);
  });

  it('separates the fields a token is taken over, so two joins are two tokens', () => {
    expect(optionToken('a', 'b', 'cd')).not.toBe(optionToken('a', 'bc', 'd'));
    expect(optionToken('ab', 'c', 'd')).not.toBe(optionToken('a', 'bc', 'd'));
  });

  it('reads the epoch off the task row, and calls a task nobody has reset epoch zero', () => {
    // One rule, in one place: `task_states.resetCount` IS the attempt epoch.
    // A task with no row yet has had no reset, which is epoch 0.
    expect(attemptEpochOf(null)).toBe(0);
    expect(attemptEpochOf(undefined)).toBe(0);
    expect(attemptEpochOf({ resetCount: 0 })).toBe(0);
    expect(attemptEpochOf({ resetCount: 3 })).toBe(3);
  });
});

describe('the row a paper lives on', () => {
  let dataSource: DataSource;
  let rows: Repository<QuizAttemptEntity>;
  let service: QuizAttemptsService;

  const input = {
    phaseStateId: 'ps-1',
    userId: 'u-1',
    taskKey: 'concepts',
    projectVersionId: 'v-1',
    epoch: 0,
    checks: checks(),
  };

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    rows = dataSource.getRepository(QuizAttemptEntity);
    service = new QuizAttemptsService(rows);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('is idempotent to start: a second start is the same paper, not a second one', async () => {
    const first = await service.start(input);
    const second = await service.start(input);
    expect(second.id).toBe(first.id);
    expect(await rows.count()).toBe(1);
    expect(first.submittedAt).toBeNull();
    expect(first.answers).toBeNull();
    expect(first.score).toBeNull();
    expect(first.startedAt).toEqual(expect.any(String));
  });

  it('counts the limit on closed rows, and an open paper spends nothing', async () => {
    const open = await service.start(input);
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(0);
    expect((await service.open('ps-1', 'concepts'))?.id).toBe(open.id);

    expect(await service.handIn(open.id, { 'q-a': ['one'] })).toBe(true);
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(1);
    expect(await service.open('ps-1', 'concepts')).toBeNull();
    // A closed row constrains nothing, so the next paper really can be drawn.
    const second = await service.start(input);
    expect(second.id).not.toBe(open.id);
    expect(await rows.count()).toBe(2);
  });

  it('closes a paper once: a second hand-in writes nothing', async () => {
    const open = await service.start(input);
    await service.handIn(open.id, { 'q-a': ['one'] });
    const closed = await rows.findOneByOrFail({ id: open.id });

    expect(await service.handIn(open.id, { 'q-a': ['two'] })).toBe(false);
    const after = await rows.findOneByOrFail({ id: open.id });
    // The sheet in the record is the sheet that was handed in.
    expect(after.answers).toEqual({ 'q-a': ['one'] });
    expect(after.submittedAt).toBe(closed.submittedAt);
  });

  it('names its revision once, and carries the verdict back onto the paper', async () => {
    const open = await service.start(input);
    await service.handIn(open.id, { 'q-a': ['one'] });
    await service.link(open.id, 's-1');
    // Once: a second link cannot re-point a paper at another revision.
    await service.link(open.id, 's-2');
    expect((await rows.findOneByOrFail({ id: open.id })).submissionId).toBe('s-1');

    await service.record('s-1', 80, true);
    expect(await rows.findOneByOrFail({ id: open.id })).toMatchObject({ score: 80, passed: true });
  });

  it('keeps one learner’s papers off another’s, and one task’s off another’s', async () => {
    await service.start(input);
    await service.start({ ...input, taskKey: 'other-quiz' });
    await service.start({ ...input, phaseStateId: 'ps-2' });
    expect(await rows.count()).toBe(3);
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(0);
    expect((await service.open('ps-1', 'other-quiz'))?.taskKey).toBe('other-quiz');
  });

  it('hands back the newest closed paper, which is the one the grader scores', async () => {
    for (const at of [1, 2, 3]) {
      const open = await service.start(input);
      await service.handIn(open.id, { 'q-a': ['one'] });
      await rows.update(
        { id: open.id },
        { submittedAt: new Date(Date.UTC(2026, 8, 21, 0, 0, at)).toISOString() },
      );
    }
    const latest = await service.latestHandedIn('ps-1', 'concepts', 0);
    expect(latest?.submittedAt).toBe('2026-09-21T00:00:03.000Z');
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(3);
  });

  /* ------------------------ the recovery: an epoch ----------------------- */

  it('closes the open paper as void, and never as a paper that was sat', async () => {
    const open = await service.start(input);
    const voided = await service.voidOpen('ps-1', 'concepts');
    expect(voided).toBe(open.id);

    // The history row stays (a learner's papers are never deleted) but it
    // leaves the open index so a new one can be drawn, and it is not a sheet:
    // no answers, no score, no verdict, no revision.
    const row = await rows.findOneByOrFail({ id: open.id });
    expect(row.submittedAt).toEqual(expect.any(String));
    expect(row.voidedAt).toBe(row.submittedAt);
    expect(row.answers).toBeNull();
    expect(row.score).toBeNull();
    expect(row.passed).toBeNull();
    expect(row.submissionId).toBeNull();

    // And it counts as nothing, in its own epoch as much as in the next one:
    // a paper the learner never handed in cannot spend an attempt.
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(0);
    expect(await service.latestHandedIn('ps-1', 'concepts', 0)).toBeNull();
    expect(await service.open('ps-1', 'concepts')).toBeNull();
    // Nothing to void twice.
    expect(await service.voidOpen('ps-1', 'concepts')).toBeNull();
  });

  it('counts and reads only the epoch it is asked about', async () => {
    // A pool larger than the paper, because that is the only shape on which
    // "a fresh draw" has any content, and it is the shape a required quiz is
    // obliged to have: `quiz-retake-is-a-new-paper` refuses to publish a
    // required quiz that draws its whole bank every time.
    const pooled = { ...input, checks: checks({ drawn: 4, shuffleOptions: true }) };
    for (const at of [1, 2, 3]) {
      const open = await service.start(pooled);
      await service.handIn(open.id, { 'q-a': ['two'] });
      await rows.update(
        { id: open.id },
        { submittedAt: new Date(Date.UTC(2026, 8, 21, 0, 0, at)).toISOString() },
      );
    }
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(3);

    // The teacher resets. The rows stay; the epoch moves.
    expect(await service.handedIn('ps-1', 'concepts', 1)).toBe(0);
    expect(await service.latestHandedIn('ps-1', 'concepts', 1)).toBeNull();

    const fresh = await service.start({ ...pooled, epoch: 1 });
    expect(fresh.epoch).toBe(1);
    // A fresh draw, not the paper they already sat as attempt 1.
    const sat = await rows.find({ order: { startedAt: 'ASC' } });
    expect(fresh.paper).not.toEqual(sat[0].paper);
    await service.handIn(fresh.id, { 'q-a': ['one'] });

    expect(await service.handedIn('ps-1', 'concepts', 1)).toBe(1);
    // The old epoch is untouched: history is never deleted and never rewritten.
    expect(await service.handedIn('ps-1', 'concepts', 0)).toBe(3);
    expect(await rows.count()).toBe(4);
  });

  it('numbers a paper as of the sheet it was handed in with, not as of now', async () => {
    // What a regrade reads. `attempt` and `attemptsLeft` on a stored report
    // must be the numbers that were true when the paper was handed in:
    // otherwise a regrade of revision one reads "attempt 3", and because
    // `attemptsLeft === 0` is also the explanation-release door, a regrade
    // could release explanations the original revision withheld.
    const sat: string[] = [];
    for (const at of [1, 2, 3]) {
      const open = await service.start(input);
      await service.handIn(open.id, { 'q-a': ['two'] });
      await rows.update(
        { id: open.id },
        { submittedAt: new Date(Date.UTC(2026, 8, 21, 0, 0, at)).toISOString() },
      );
      sat.push(open.id);
    }
    const papers = await Promise.all(sat.map((id) => rows.findOneByOrFail({ id })));
    expect(await Promise.all(papers.map((one) => service.attemptNumberOf(one)))).toEqual([1, 2, 3]);

    // And the numbering starts again on the next epoch, because that is what a
    // returned attempt means.
    const after = await service.start({ ...input, epoch: 1 });
    await service.handIn(after.id, { 'q-a': ['one'] });
    expect(await service.attemptNumberOf(await rows.findOneByOrFail({ id: after.id }))).toBe(1);
  });

  it('draws a new paper when the open one belongs to an epoch that has ended', async () => {
    // Belt and braces against the one row the reset could not reach. An epoch
    // that has ended cannot hold an open paper (`voidOpen` is what closes it
    // inside the reset's own transaction) so a row here is closed the same
    // way rather than handed to a learner whose attempts it would not count.
    const stale = await service.start(input);
    const drawn = await service.start({ ...input, epoch: 1 });

    expect(drawn.id).not.toBe(stale.id);
    expect(drawn.epoch).toBe(1);
    expect((await rows.findOneByOrFail({ id: stale.id })).voidedAt).toEqual(expect.any(String));
    expect(await rows.count()).toBe(2);
  });

  it('draws a retake from the questions the learner’s last paper did not ask', async () => {
    // The preference is read off the record rather than recomputed, so it is
    // the paper the learner really sat that a retake avoids, and it survives
    // a reload, a redraw and a restart of the process.
    const slice = checks({ drawn: 6 });
    const first = await service.start({ ...input, checks: slice });
    await service.handIn(first.id, {});
    const retake = await service.start({ ...input, checks: slice });

    const asked = new Set(first.paper.map((one) => one.questionId));
    const ids = retake.paper.map((one) => one.questionId);
    expect(ids).toHaveLength(6);
    // Eight in the pool and six asked leaves two: both of them are on the
    // retake, and the other four are the fewest it could repeat.
    expect(ids.filter((id) => !asked.has(id))).toHaveLength(2);
    expect(ids.filter((id) => asked.has(id))).toHaveLength(4);
  });

  it('redraws the identical retake from the same record, so nothing about it is luck', async () => {
    // The preference is read off the record and the order is the seed's, so
    // the same record draws the same retake, which is what lets a lost insert
    // redraw the paper the learner was already reading.
    const slice = checks({ drawn: 5, shuffleOptions: true });
    const first = await service.start({ ...input, checks: slice });
    await service.handIn(first.id, {});
    const retake = await service.start({ ...input, checks: slice });
    await rows.delete({ id: retake.id });
    const again = await service.start({ ...input, checks: slice });
    expect(again.id).not.toBe(retake.id);
    expect(again.paper).toEqual(retake.paper);
    expect(new Set(retake.paper.map((one) => one.questionId))).not.toEqual(
      new Set(first.paper.map((one) => one.questionId)),
    );
  });

  it('names one last paper even when two were closed in the same millisecond', async () => {
    // A learner cannot do this; a fixture can. The order must still be the
    // record's and not the database's whim, or a redraw could prefer against
    // a different paper and draw a different retake.
    const at = '2026-09-21T00:00:01.000Z';
    for (let n = 0; n < 2; n += 1) {
      const open = await service.start(input);
      await service.handIn(open.id, {});
      await rows.update({ id: open.id }, { startedAt: at, submittedAt: at });
    }
    const ids = (await rows.find()).map((one) => one.id).sort();
    for (let n = 0; n < 5; n += 1) {
      expect((await service.lastPaper('ps-1', 'concepts', 0))?.id).toBe(ids[1]);
    }
    // and an open paper is not a last paper: it is the current one
    await service.start(input);
    expect((await service.lastPaper('ps-1', 'concepts', 0))?.id).toBe(ids[1]);
  });

  it('prefers what the paper before a teacher’s reset did not ask, on the new run’s first paper', async () => {
    // A reset returns the learner's attempts and starts the numbering again,
    // so the new run's FIRST paper is the one that must not repeat the last
    // paper of the run that ended.
    const slice = checks({ drawn: 6 });
    const before = await service.start({ ...input, checks: slice });
    await service.handIn(before.id, {});
    const after = await service.start({ ...input, epoch: 1, checks: slice });

    const asked = new Set(before.paper.map((one) => one.questionId));
    expect(after.paper.map((one) => one.questionId).filter((id) => !asked.has(id))).toHaveLength(2);
  });

  it('prefers against a paper a reset voided, which the learner had already read', async () => {
    // A voided paper was open when the teacher reset the task: the learner had
    // it in front of them, so the new run's first paper avoids it like any
    // other last paper. It counts towards no limit either way.
    const slice = checks({ drawn: 6 });
    const read = await service.start({ ...input, checks: slice });
    await service.voidOpen('ps-1', 'concepts');
    const after = await service.start({ ...input, epoch: 1, checks: slice });

    const asked = new Set(read.paper.map((one) => one.questionId));
    expect(after.paper.map((one) => one.questionId).filter((id) => !asked.has(id))).toHaveLength(2);
  });

  it('counts a voided paper as the last paper, so the next run never re-serves what was read', async () => {
    // The case above draws 6 of 8, where a draw that ignored the voided paper
    // would still hold both unasked questions more often than not. Four of
    // eight leaves no room for luck: the preferred paper is exactly the four
    // the learner was not reading when the teacher reset, and a draw that
    // passed over the voided row would share a question with it in 69 of 70
    // draws, and here, with this seed, it does.
    const slice = checks({ drawn: 4 });
    const read = await service.start({ ...input, checks: slice });
    expect(await service.voidOpen('ps-1', 'concepts')).toBe(read.id);
    expect((await service.lastPaper('ps-1', 'concepts', 1))?.id).toBe(read.id);
    const after = await service.start({ ...input, epoch: 1, checks: slice });

    const asked = new Set(read.paper.map((one) => one.questionId));
    const now = after.paper.map((one) => one.questionId);
    expect(now).toHaveLength(4);
    expect(now.filter((id) => asked.has(id))).toEqual([]);
  });
});
