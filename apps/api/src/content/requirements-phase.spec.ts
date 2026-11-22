import { serialiseStory, type Story } from '@learnsdlc/shared';
import { matchFact } from '../assistant/interview.service';
import { buildStoryPartial } from '../feedback/story-report';
import { ContentService } from './content.service';
import type { PhaseContent, StoryChecks, TestsChecks } from './content.types';

/**
 * The warm-up and phase 1, requirements.
 *
 * Two things are being held down here, and only one of them is the gate.
 *
 * The gate is the story floor: the learner's record, `requirements/story.json`,
 * written through the story form, must hold the full sentence, two complete
 * criteria (one happy path, one boundary) and one scope line. The untouched
 * record is red and a worked record is green, so "the learner filled the form
 * in properly" and "the learner clears the floor" are the same sentence.
 *
 * The other thing is the backlog. The phase's provided stories are the source
 * of every `US-n/AC-m` in the pack: the testing phase files each seeded bug
 * against a criterion, and `criterion-verified` refuses a `covers` they do not
 * declare. So the ids are asserted here, from the other end, every verifier
 * phase 4 ships resolves against a criterion phase 1 wrote down, because the
 * failure mode is silent and four phases away.
 */

/* ------------------------ a worked record, as the form saves it ----------- */

const WORKED: Story = {
  id: 'US-4',
  title: 'Overdue report',
  persona: 'person who runs TaskTrackr every morning',
  capability: 'a page listing every task whose due date has already passed',
  benefit: 'I catch what I missed before the day starts',
  criteria: [
    { id: 'AC-1', tag: 'happy', given: 'a list holding a task due before today', when: 'I open the overdue page', then: 'that task is on it with its title, how many whole days late it is, and the list it came from' },
    { id: 'AC-2', tag: 'boundary', given: 'a task due today', when: 'I open the overdue page', then: 'it is not on it, because the day is not over yet' },
    { id: 'AC-3', tag: 'boundary', given: 'a task I completed a week after its due date', when: 'I open the overdue page', then: 'it is not on it' },
  ],
  scopeExclusions: ['reminders', 'emails', 'any notification at all'],
  notes: '',
};

describe('phase 1, requirements', () => {
  let content: ContentService;
  let phase: PhaseContent;
  let checks: StoryChecks;

  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
    phase = content.getPhase('tasktrackr', 'requirements');
    if (phase.checks.kind !== 'story') throw new Error('expected story checks');
    checks = phase.checks;
  });

  const fileOf = (path: string): string => phase.files.find((f) => f.path === path)?.content ?? '';

  /** The floor's verdict on a record: every failing line's id, the record's own check first. */
  const failing = (record: string): string[] =>
    buildStoryPartial(phase.rubric, checks, record).checks.filter((c) => c.status !== 'passed').map((c) => c.id);

  /* ------------------------------- the shape ------------------------------ */

  it('opens the story record alone, editable, and ships no markdown', () => {
    expect(phase.artifactKind).toBe('story');
    expect(checks.record).toBe('requirements/story.json');
    expect(phase.files.map((f) => f.path)).toEqual(['requirements/story.json']);
    expect(phase.files[0].editable).toBe(true);
    expect(phase.canRun).toBe(false);
    // the loader seeds the record with the learner's story id and nothing else
    expect(JSON.parse(fileOf('requirements/story.json'))).toMatchObject({ id: 'US-4', criteria: [], scopeExclusions: [] });
  });

  it('weights three criteria that add to one', () => {
    expect(phase.rubric.criteria.map((c) => c.key)).toEqual([
      'story_structure',
      'acceptance_criteria',
      'scope_clarity',
    ]);
    const total = phase.rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(Math.round(total * 100) / 100).toBe(1);
  });

  it('holds the floor the brief names: two criteria, a happy path and a boundary, one scope line, the sentence', () => {
    expect(checks.floor).toEqual({ minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true });
    expect(checks.learnerStory).toEqual({
      id: 'US-4',
      hints: {
        persona: 'person who runs TaskTrackr every morning',
        capability: 'a report of the tasks that are overdue',
        benefit: 'I catch what I missed before the day starts',
      },
    });
  });

  it('names the boundary case and no file or markdown in the brief and the mentor', () => {
    expect(phase.taskPanel).toMatch(/boundary \(the task due today\)/);
    const words = [phase.taskPanel, phase.assistant.systemPrompt, ...phase.assistant.progressive, ...phase.assistant.topics.flatMap((t) => t.hints)];
    for (const text of words) {
      expect(text).not.toMatch(/markdown|my-story|\.md\b|story\.json|both (synchronized )?views|authoring panel/i);
    }
  });

  /* ------------------------------ the backlog ----------------------------- */

  it('ships four approved stories, with US-4 as the gap', () => {
    expect(checks.providedStories.map((s) => s.id)).toEqual(['US-1', 'US-2', 'US-3', 'US-5']);
    for (const story of checks.providedStories) {
      for (const field of ['title', 'persona', 'capability', 'benefit'] as const) {
        expect([story.id, field, story[field].trim().length > 0]).toEqual([story.id, field, true]);
      }
    }
    expect(checks.providedStories.some((s) => s.id === checks.learnerStory.id)).toBe(false);
  });

  it('numbers each story criteria from AC-1 with no gaps, every clause filled', () => {
    for (const story of checks.providedStories) {
      const criteria = story.criteria ?? [];
      expect([story.id, criteria.length >= 2]).toEqual([story.id, true]);
      expect([story.id, criteria.map((c) => c.id)]).toEqual([story.id, criteria.map((_, i) => `AC-${i + 1}`)]);
      for (const c of criteria) {
        expect([story.id, c.id, !!(c.given.trim() && c.when.trim() && c.then.trim())]).toEqual([story.id, c.id, true]);
      }
    }
  });

  it('declares every criterion the testing phase files a bug against', () => {
    // the mutant table is derived from the backlog, never the other way round,
    // and `criterion-verified` refuses a covers that is not declared here.
    // This is the same rule, from phase 1's side, so an author who renumbers
    // a story finds out here rather than in the checker.
    const testing = content.getPhase('tasktrackr', 'testing');
    if (testing.checks.kind !== 'tests') throw new Error('expected tests checks');
    const tests = testing.checks as TestsChecks;
    const verifiers = [
      ...tests.mutants.map((m) => ({ what: `mutant ${m.name}`, id: m.covers })),
      ...tests.coverageKeywords.map((g) => ({ what: `keywords ${g.criterion}`, id: g.criterionId })),
    ];
    expect(verifiers.length).toBeGreaterThan(0);
    for (const verifier of verifiers) {
      expect([verifier.what, verifier.id]).toEqual([
        verifier.what,
        expect.stringMatching(/^US-\d+\/AC-\d+$/),
      ]);
      const [story, ac] = (verifier.id as string).split('/');
      const declared =
        story === checks.learnerStory.id ||
        !!checks.providedStories.find((s) => s.id === story)?.criteria?.some((c) => c.id === ac);
      expect([verifier.what, verifier.id, declared]).toEqual([verifier.what, verifier.id, true]);
    }
  });

  it('says the project is a web application, not a command line one', () => {
    // the pack is a Python API and a React front end; a mentor that spoke of
    // a command line tool would be the first thing a learner read
    expect(phase.assistant.systemPrompt).toMatch(/web application/i);
    expect(phase.assistant.systemPrompt).not.toMatch(/command line/i);
  });

/* ----------------------------- the interview ---------------------------- */

  it('settles the three facts a front end made necessary', () => {
    const brief = content.interviewBrief(phase);
    expect(brief).not.toBeNull();
    const ids = brief!.facts.map((f) => f.id);
    expect(ids).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10']);
    expect(brief!.factsExpected).toBeLessThanOrEqual(brief!.facts.length);
    expect(brief!.maxTurns).toBeGreaterThanOrEqual(brief!.factsExpected);

    const answerOf = (id: string) => brief!.facts.find((f) => f.id === id)!.answer;
    expect(answerOf('F8')).toContain('its own page');
    expect(answerOf('F9')).toContain('days');
    // F10 is a refusal in the shape of a fact: the customer declining to
    // design is what hands the learner the API/UI split as their decision
    expect(answerOf('F10')).toContain('your problem');
  });

  it('routes the questions those facts answer to the right one', () => {
    const brief = content.interviewBrief(phase)!;
    const asked = (question: string) => matchFact(brief, question, [])?.id ?? null;
    expect(asked('Should the overdue report be its own page or a filter on the list?')).toBe('F8');
    expect(asked('What does a row of the report show?')).toBe('F9');
    expect(asked('Do you want a new screen or a new endpoint for this?')).toBe('F10');
    // and the ones that were already there still reach their own fact
    expect(asked('Is a task due today overdue?')).toBe('F2');
    expect(asked('Do completed tasks appear in it?')).toBe('F3');
  });

  /* --------------------------------- the gate ----------------------------- */

  it('fails the untouched record on every floor line', () => {
    expect(failing(fileOf('requirements/story.json'))).toEqual([
      'story.sentence',
      'story.criteria.min',
      'story.criteria.tags',
      'story.scope.min',
    ]);
  });

  it('passes a worked record written the way the form writes it', () => {
    expect(failing(serialiseStory(WORKED))).toEqual([]);
  });

  it('fails a story with one criterion and no scope note', () => {
    const thin: Story = { ...WORKED, criteria: [WORKED.criteria[0]], scopeExclusions: [] };
    expect(failing(serialiseStory(thin))).toEqual(['story.criteria.min', 'story.criteria.tags', 'story.scope.min']);
  });

  it('fails a story whose criteria never settle the boundary', () => {
    const noBoundary: Story = { ...WORKED, criteria: WORKED.criteria.map((c) => ({ ...c, tag: 'happy' as const })) };
    expect(failing(serialiseStory(noBoundary))).toEqual(['story.criteria.tags']);
  });
});
