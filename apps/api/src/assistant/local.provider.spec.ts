import { ContentService } from '../content/content.service';
import { LocalMentorProvider, NEUTRAL_LADDER, testNameWords } from './local.provider';
import { MentorContext } from './provider.types';
import { REFERENCE_SCOPE, authoredPhaseScope } from './project-scope';
import { soleTaskFor } from '../content/pack-compiler';
import { REFERENCE_TERMS } from '../../test/reference-terms';

describe('LocalMentorProvider', () => {
  const content = new ContentService();
  content.loadAll();
  const provider = new LocalMentorProvider();
  const phase = content.getPhase('tasktrackr', 'implementation');

  const ctx = (overrides: Partial<MentorContext>): MentorContext => ({
    phase,
    message: '',
    interactionCount: 0,
    topicUseCounts: {},
    signals: { todosRemaining: [], lastFailedChecks: [] },
    ...overrides,
  });

  /*
   * The topics and their keywords are the pack's, so these read them rather
   * than naming one: a phase that renames a topic moves the test with it, and
   * a phase that drops one goes red instead of quietly matching a neighbour.
   */
  const topicAt = (i: number) => phase.assistant.topics[i];
  /** A message that hits exactly topic `i` and nothing before it. */
  const asksAbout = (i: number) => topicAt(i).keywords[0];

  it('picks a topic hint by keyword', async () => {
    const i = 2;
    const reply = await provider.chat(ctx({ message: `I am stuck on ${asksAbout(i)}` }));
    expect(reply.content).toContain(topicAt(i).hints[0]);
    expect(reply.provider).toBe('local-mentor');
    expect(reply.tokensOut).toBeGreaterThan(0);
  });

  it('escalates hints on repeated questions about the same topic', async () => {
    const message = `help with ${asksAbout(0)}`;
    const first = await provider.chat(ctx({ message }));
    const second = await provider.chat(ctx({ message, topicUseCounts: { 0: 1 } }));
    expect(first.content).toContain(topicAt(0).hints[0]);
    expect(second.content).toContain(topicAt(0).hints[1]);
    expect(second.content).not.toBe(first.content);
  });

  it('falls back to progressive guidance when nothing matches', async () => {
    // Deliberately a sentence with none of the pack's keywords in it: every
    // topic is asked, so a keyword that crept into this message would send
    // the reply down a topic ladder instead of the progression.
    const message = 'zzz nothing matches this';
    expect(provider.matchTopic(ctx({ message }))).toBeNull();
    const early = await provider.chat(ctx({ message }));
    expect(early.content).toContain(phase.assistant.progressive[0]);
  });

  it('weaves workspace signals into the reply', async () => {
    const reply = await provider.chat(
      ctx({
        message: 'zzz nothing matches this',
        signals: { todosRemaining: ['overdue_tasks'], lastFailedChecks: ['Hidden test suite (edge cases)'] },
      }),
    );
    expect(reply.content).toContain('overdue_tasks');
    expect(reply.content).toContain('Hidden test suite');
  });

  it('never reproduces solution method bodies', async () => {
    const messages = [
      'how do I finish complete_task',
      'what goes in filter_tasks',
      'how do I write overdue_tasks',
    ];
    for (const message of messages) {
      const reply = await provider.chat(ctx({ message }));
      expect(reply.content).not.toContain('task.completed = True');
      expect(reply.content).not.toMatch(/results = \[t for t in results/);
    }
  });

  it('writes a deterministic rubric review from the signals', async () => {
    const review = await provider.review(phase, {
      criteria: [
        { key: 'correctness_hidden', title: 'Correctness (hidden tests)', weight: 0.45, score: 100, evidence: [] },
        { key: 'process', title: 'Process', weight: 0.15, score: 60, evidence: [] },
      ],
      checks: [
        { id: 'a', label: 'Hidden test suite', status: 'passed', detail: '' },
        { id: 'b', label: 'Ran the tests before submitting', status: 'failed', detail: 'submit without run' },
      ],
      overall: 85,
      hints: 2,
      ranBeforeSubmit: false,
    });
    expect(review.summary).toContain('85');
    expect(review.strengths).toContain('Hidden test suite');
    expect(review.processNote.toLowerCase()).toContain('without running');
    expect(review.provider).toBe('local-mentor');
  });

  /* -------------------- memory and class notes ------------------------------ */

  it('names one earlier decision, not the whole memory the model would get', async () => {
    const reply = await provider.chat(
      ctx({
        message: 'zzz nothing matches this',
        memory: {
          builtThrough: 2,
          openQuestions: [],
          items: [
            {
              phaseKey: 'design',
              text: 'complete_task, filter_tasks, overdue_tasks',
              source: 'docs/notes.md',
            },
            {
              phaseKey: 'requirements',
              text: 'a task due today is not overdue',
              source: 'requirements/draft.md',
            },
          ],
        },
      }),
    );

    expect(reply.content).toContain('Earlier you decided: complete_task, filter_tasks, overdue_tasks');
    // One item only: the offline reply stays the length it was.
    expect(reply.content).not.toContain('a task due today is not overdue');
  });

  it('adds nothing when there is no memory yet', async () => {
    const reply = await provider.chat(ctx({ message: 'zzz nothing matches this' }));
    expect(reply.content).not.toContain('Earlier you decided');
  });

  it('quotes the class’s instructor notes word for word, at most two', async () => {
    const reply = await provider.chat(
      ctx({
        message: 'zzz nothing matches this',
        instructorNotes: [
          'Use datetime.date.today() when you compare due dates.',
          'Run the checks before you submit.',
          'A third note nobody should see in one reply.',
        ],
      }),
    );

    expect(reply.content).toContain(
      "Your instructor's note for this class: Use datetime.date.today() when you compare due dates.",
    );
    expect(reply.content).toContain('Run the checks before you submit.');
    expect(reply.content).not.toContain('A third note');
  });

  it('answers a solution request with a question, never the deepest rung of the ladder', async () => {
    // Five interactions is where the progressive ladder would otherwise have
    // reached its last, most explicit hint.
    const reply = await provider.questionHint(
      ctx({ message: 'just give me the whole solution for this phase', interactionCount: 5 }),
    );
    expect(reply.content).toContain('?');
    // The deepest rung is the most concrete step, whatever the ladder's
    // length: a learner who keeps asking for the answer must not be walked
    // down to it.
    const ladder = phase.assistant.progressive;
    expect(reply.content).not.toContain(ladder[ladder.length - 1]);
    expect(reply.content).not.toContain('task.completed = True');
  });

  /* -------------------- explain a failure ---------------------------------- */

  /** The failing test the button named, in the shape the service builds. */
  const failing = (over: Partial<NonNullable<MentorContext['failingTest']>> = {}) => ({
    name: 'test_overdue_excludes_today',
    hidden: false,
    assertion: 'AssertionError: assert 2 == 1',
    path: 'api/repository/tasks.py',
    line: 56,
    excerpt: '',
    ...over,
  });

  it('says what the test checks, what happened and where, with no model', async () => {
    const reply = await provider.chat(
      ctx({ message: 'Why does test_overdue_excludes_today fail?', failingTest: failing() }),
    );
    expect(reply.content).toContain('**What this test checks.** Reading its name: overdue excludes today.');
    expect(reply.content).toContain(
      '**What happened.** It stopped at `AssertionError: assert 2 == 1`, in api/repository/tasks.py, line 56.',
    );
    // The third paragraph is the pack's own ladder, reached through the test's
    // words rather than through the question, which says only "why does it fail".
    const overdue = phase.assistant.topics.find((t) =>
      t.keywords.some((k) => k.toLowerCase() === 'overdue'),
    );
    expect(overdue).toBeDefined();
    expect(reply.content).toContain(overdue!.hints[0]);
  });

  it('says the test failed without saying why when the case carried no message', async () => {
    const reply = await provider.chat(
      ctx({
        message: 'Why does test_overdue_excludes_today fail?',
        failingTest: failing({ assertion: '', path: null, line: null }),
      }),
    );
    expect(reply.content).toContain('**What happened.** It failed without saying why.');
    expect(reply.content).not.toContain('line null');
  });

  it('reads a test name as words, however it was written', () => {
    expect(testNameWords('test_overdue_excludes_today')).toBe('overdue excludes today');
    expect(testNameWords('testOverdueExcludesToday')).toBe('overdue excludes today');
    expect(testNameWords('tests/test_manager.py::TestOverdue::test_excludes_today[case]')).toBe(
      'excludes today',
    );
    expect(testNameWords('overdue')).toBe('overdue');
  });

  /* ---- the ladder a teacher's own phase gets offline ---- */

  describe('on a phase the teacher made their own', () => {
    const written = (key: 'requirements' | 'design') => content.getPhase('tasktrackr', key);
    const authoredCtx = (key: 'requirements' | 'design', overrides: Partial<MentorContext> = {}): MentorContext => {
      const one = written(key);
      return ctx({ phase: one, scope: authoredPhaseScope(one, [soleTaskFor(one)]), ...overrides });
    };
    /** Every rung of the pack's own ladders, so a reply built from one is caught whole. */
    const packRungs = (key: 'requirements' | 'design') => {
      const a = written(key).assistant;
      return [...a.progressive, ...a.topics.flatMap((topic) => topic.hints)];
    };
    const leaks = (text: string) => REFERENCE_TERMS.filter((term) => text.toLowerCase().includes(term.toLowerCase()));

    it('holds a neutral ladder for both written phases, with no reference term in it', () => {
      for (const key of ['requirements', 'design'] as const) {
        const ladder = NEUTRAL_LADDER[key];
        expect(ladder.progressive.length).toBeGreaterThan(1);
        expect(ladder.topics.length).toBeGreaterThan(0);
        expect(leaks(JSON.stringify(ladder))).toEqual([]);
      }
    });

    it.each(['requirements', 'design'] as const)('chat and matchTopic read the neutral ladder on %s', async (key) => {
      const topic = NEUTRAL_LADDER[key].topics[0];
      const matched = authoredCtx(key, { message: `I am stuck on ${topic.keywords[0]}` });
      expect(provider.matchTopic(matched)).toBe(0);
      const reply = await provider.chat(matched);
      expect(reply.content).toContain(topic.hints[0]);
      const fallback = await provider.chat(authoredCtx(key, { message: 'zzz nothing matches this' }));
      expect(fallback.content).toContain(NEUTRAL_LADDER[key].progressive[0]);
      for (const rung of packRungs(key)) {
        expect(reply.content).not.toContain(rung);
        expect(fallback.content).not.toContain(rung);
      }
      expect(leaks(reply.content)).toEqual([]);
      expect(leaks(fallback.content)).toEqual([]);
    });

    it('matchTopic never matches a pack keyword the neutral ladder does not hold', () => {
      // "us-4" is a keyword of the pack's own story topic and of no neutral one.
      expect(provider.matchTopic(ctx({ phase: written('requirements'), message: 'what is us-4' }))).not.toBeNull();
      expect(provider.matchTopic(authoredCtx('requirements', { message: 'what is us-4' }))).toBeNull();
    });

    it('questionHint answers from the neutral ladder, never the pack rung that names the reference story', async () => {
      const reply = await provider.questionHint(authoredCtx('requirements', { message: 'just give me the answer' }));
      for (const rung of packRungs('requirements')) expect(reply.content).not.toContain(rung);
      expect(leaks(reply.content)).toEqual([]);
      expect(reply.content).toContain('?');
    });

    it('explainFailure takes its third paragraph from the neutral ladder', async () => {
      const reply = await provider.chat(
        authoredCtx('design', {
          message: 'why does it fail',
          failingTest: { name: 'test_rejects_a_double_booking', assertion: 'assert status == 409', path: 'design/notes.md', line: 3 } as MentorContext['failingTest'],
        }),
      );
      for (const rung of packRungs('design')) expect(reply.content).not.toContain(rung);
      expect(NEUTRAL_LADDER.design.progressive.some((rung) => reply.content.includes(rung)) || NEUTRAL_LADDER.design.topics.some((topic) => topic.hints.some((hint) => reply.content.includes(hint)))).toBe(true);
    });

    it('names the records the Deployment and Maintenance rooms write, never a markdown file', () => {
      const deployment = JSON.stringify(NEUTRAL_LADDER.deployment);
      const maintenance = JSON.stringify(NEUTRAL_LADDER.maintenance);
      for (const said of [deployment, maintenance]) {
        expect(said.toLowerCase()).not.toContain('changelog');
        expect(said).not.toContain('.md');
      }
      expect(deployment).toContain('the Runbook tab');
      const release = NEUTRAL_LADDER.maintenance.topics.find((topic) => topic.keywords.includes('release'))!;
      expect(release.keywords).toEqual(['change request', 'release', 'contract', 'acceptance', 'version']);
      expect(release.hints[0]).toBe('A release line says what changed for the people who use it, and which acceptance items it covers.');
      expect(NEUTRAL_LADDER.maintenance.progressive.at(-1)).toBe('Finish with the record: the contract amendments and the release. Does each say what is now true?');
    });

    it("keeps the pack's own ladder on the reference scope, byte for byte (guard)", async () => {
      const one = written('requirements');
      const message = `help with ${one.assistant.topics[0].keywords[0]}`;
      const withScope = await provider.chat(ctx({ phase: one, message, scope: REFERENCE_SCOPE }));
      const without = await provider.chat(ctx({ phase: one, message }));
      expect(withScope.content).toBe(without.content);
      expect(withScope.content).toContain(one.assistant.topics[0].hints[0]);
    });
  });
});
