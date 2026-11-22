import { Injectable } from '@nestjs/common';
import type { AiRubricReview } from '@learnsdlc/shared';
import { PhaseContent } from '../content/content.types';
import { memorySentence } from './memory';
import { isMintedScope } from './project-scope';
import { learnerText } from '../workflow/learner-text';
import {
  AiProvider,
  estimateTokens,
  MentorContext,
  ProviderReply,
  ReviewInput,
} from './provider.types';

/**
 * A test name read as the sentence somebody wrote.
 *
 * Test names are written to be read, that is what they are for, so the one
 * part of a hidden test a learner may always be told is its name, said in
 * words. `test_overdue_excludes_today` and `testOverdueExcludesToday` both
 * become "overdue excludes today"; a pytest id carrying a class or a
 * parametrisation keeps only the case itself.
 */
export function testNameWords(name: string): string {
  const bare = String(name ?? '')
    // "tests/test_manager.py::TestOverdue::test_excludes_today[case]", the
    // case is the last segment, and its parameters are not words.
    .split('::')
    .pop()!
    .replace(/\[.*$/, '')
    .trim();
  const stripped = bare.replace(/^test[_-]?/i, '');
  const words = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return words || bare.toLowerCase();
}

/** A hint ladder the offline mentor climbs: keyword topics, then the progression. */
export interface OfflineLadder {
  topics: readonly { keywords: readonly string[]; hints: readonly string[] }[];
  progressive: readonly string[];
}

/**
 * The offline ladder for a phase a teacher made their own. A pack's own
 * ladder is written about its own story, its
 * record ids, its stakeholder, its report, so on a teacher's task it would
 * coach the reference project's work. These rungs say the same method in
 * words about no project: they name the learner's own brief and backlog, and
 * every one asks rather than tells. An application phase can
 * be a teacher's too, an upload, or an edited copy, so the four application
 * phases have rungs of their own, written about the work of the phase and
 * about no project.
 */
export const NEUTRAL_LADDER: Readonly<Record<'requirements' | 'design' | 'implementation' | 'testing' | 'deployment' | 'maintenance', OfflineLadder>> = {
  requirements: {
    topics: [
      {
        keywords: ['story', 'format', 'as a', 'structure', 'start'],
        hints: [
          "A user story has three parts: a persona, a capability and a benefit — 'As a <who>, I want <what>, so that <why>'. Who in your brief actually needs this, and what decision does it help them make?",
          'Look at how the stories already in your backlog name a persona and a benefit, and give yours the same shape. Which persona from those stories cares most about this capability?',
        ],
      },
      {
        keywords: ['acceptance', 'criteria', 'given', 'when', 'then', 'testable'],
        hints: [
          'Acceptance criteria describe observable behaviour: Given a starting state, When an action happens, Then a checkable outcome. What starting state would prove your capability works?',
          "A criterion is testable when a machine could verify it. 'It is easy to use' is not testable; a named input producing a named result is. Which boundary cases does your story need to pin down?",
        ],
      },
      {
        keywords: ['boundary', 'edge', 'limit', 'empty', 'invalid'],
        hints: [
          'Edge cases sit where a rule changes its answer: the first value that is allowed, the last, and the one just past it. Where does your rule change its answer?',
          'Decide each edge case explicitly in a criterion rather than leaving it to whoever builds it. Which case would two people most likely read differently?',
        ],
      },
      {
        keywords: ['scope', 'exclude', 'out of scope', 'not include'],
        hints: [
          'A scope note says what this story deliberately does not do, so nobody builds it by accident. What is close to your story but belongs to a different one?',
          'Check each exclusion against the brief: is it something the stakeholder asked for later, or never? Which of your exclusions would they be surprised by?',
        ],
      },
      {
        keywords: ['interview', 'stakeholder', 'ask', 'customer'],
        hints: [
          'The interview is where the requirements come from, so ask about behaviour, not about screens. What would you need to know to write your first criterion?',
          'When an answer surprises you, ask for an example of it happening. Which of your criteria still rests on a guess rather than on something you were told?',
        ],
      },
    ],
    progressive: [
      'Start from your brief and the stories already in your backlog: each names a persona, a capability and a benefit. What would the first line of yours be?',
      'Now make it checkable. Write one Given/When/Then criterion for the plainest case your story covers. What does the reader see when it works?',
      'Add the cases at the edges: the smallest, the largest and the invalid input. Which of them does your brief decide, and which do you need to ask about?',
      'Finish with a scope note that names what this story leaves out. Is every criterion something a tester could check without asking you what you meant?',
    ],
  },
  design: {
    topics: [
      {
        keywords: ['data model', 'entity', 'field', 'type', 'table', 'schema', 'column'],
        hints: [
          'Walk through each story your design must serve and ask what it forces the model to store. What falls out of each one, and what type is it?',
          'For every field, decide whether it is required and what it means when it is absent. Which of your fields could be missing, and what should happen then?',
        ],
      },
      {
        keywords: ['relationship', 'join', 'many', 'foreign key', 'reference'],
        hints: [
          'When one thing can belong to several others and each of those holds several of it, a single column cannot hold the link cleanly. Which of your relationships is one-to-many, and which many-to-many?',
          'Name the table or field that carries each relationship, and what happens to it when either side is deleted. Which deletion would leave something pointing at nothing?',
        ],
      },
      {
        keywords: ['contract', 'endpoint', 'api', 'operation', 'request', 'response', 'error', 'status'],
        hints: [
          'An operation in a contract says what it takes, what it returns and every way it can refuse. For each of your operations, what does a caller send, and what comes back?',
          'Every code an operation names should be declared once, with a status and a meaning, so two operations never mean different things by the same word. Which of your operations can refuse, and why?',
        ],
      },
      {
        keywords: ['screen', 'page', 'view', 'empty state', 'title'],
        hints: [
          'A screen contract says what each screen is called and what it shows when there is nothing to show. What does a person see the first time, before any data exists?',
          'Trace each screen back to a story: which requirement does it serve, and which of its words come from that story?',
        ],
      },
      {
        keywords: ['decision', 'trade-off', 'tradeoff', 'why', 'alternative', 'justify'],
        hints: [
          'A design decision names the options you compared, what each costs and why you chose one. Which choice in your design could reasonably have gone the other way?',
          'Tie the decision to a requirement: which story would suffer if you had chosen the other option?',
        ],
      },
    ],
    progressive: [
      'Start from the stories your design must serve. What does each one force the design to store or expose?',
      'Sketch the data model: the entities, their fields and the relationships between them. Which field is required, and which may be absent?',
      'Now write the contract: each operation, what it takes, what it returns and how it refuses. Does every requirement reach at least one operation?',
      'Finish with one decision and its trade-off, tied to a requirement. Could someone reading only your design explain why it is shaped this way?',
    ],
  },
  implementation: {
    topics: [
      {
        // not 'red': a substring match reads it in 'ordered', 'required', 'stored'
        keywords: ['test', 'fail', 'error', 'assert'],
        hints: [
          'A failing test names one behaviour and the value it expected. Which input does it give your code, and what did your code return instead?',
          'Run one failing case on its own and predict its result before you look. Where does your prediction and the output first disagree?',
        ],
      },
      {
        keywords: ['filter', 'order', 'sort', 'boundary', 'edge'],
        hints: [
          'Separate which rows qualify from the order they come back in. Which rule in the brief decides each one?',
          'Try the value exactly on the boundary the brief names. Should it be included, and does your comparison agree?',
        ],
      },
      {
        keywords: ['start', 'stub', 'todo', 'begin', 'where'],
        hints: [
          'Pick the smallest marked gap whose test you can read in full. What is the first thing that function must decide?',
          'Read the gap\'s docstring or comment against the brief. Which sentence tells you what to return for an empty input?',
        ],
      },
    ],
    progressive: [
      'Start from the brief and the visible tests. Which one behaviour can you make true first?',
      'Run the visible tests and read one failure closely: what was expected, and what happened?',
      'Change one thing, then run again. Did the failure you aimed at change, and did anything else break?',
      'Before you submit, reread each rule of the brief. Which test, visible or yours, shows that rule holds?',
    ],
  },
  testing: {
    topics: [
      {
        keywords: ['assert', 'expect', 'check', 'verify'],
        hints: [
          'An assertion compares one observed value with the value a requirement promises. Which value does each of your assertions actually compare?',
          'Would this test still pass if the behaviour it names were broken? What would you change so it could not?',
        ],
      },
      {
        keywords: ['mutant', 'survive', 'bug', 'caught', 'kill'],
        hints: [
          'A surviving planted bug behaves differently from the working application somewhere. Which input would make that difference visible?',
          'Read the requirement the surviving bug touches. Which case of it does no test of yours exercise yet?',
        ],
      },
      {
        keywords: ['coverage', 'requirement', 'map', 'criterion', 'missing'],
        hints: [
          'List the acceptance criteria and, beside each, the test that proves it. Which criterion has no test beside it?',
          'One test per behaviour keeps a failure readable. Which of your tests checks two things at once?',
        ],
      },
    ],
    progressive: [
      'Start from the acceptance criteria. Which behaviour would you test first, and with what input?',
      'Write that test so it passes on the working application. What exact value does it check?',
      'Now imagine one small bug in that behaviour. Would your test fail? If not, what must it check instead?',
      'Before you submit, map every criterion to a test. Which criterion is still unproven?',
    ],
  },
  deployment: {
    topics: [
      {
        keywords: ['dockerfile', 'image', 'entrypoint', 'workdir', 'copy'],
        hints: [
          'An image definition says where the code lives, what is copied in and how the process starts. Which of those three does your file not say yet?',
          'Exec form starts the process directly, so it receives signals. Which form does your entry point use?',
        ],
      },
      {
        // 'port number' and 'listen', not 'port': 'report' and 'support' carry it
        keywords: ['selfcheck', 'smoke', 'health', 'port number', 'listen', 'config'],
        hints: [
          'The selfcheck reads the configuration the service would start with. Which setting would it reject, and why?',
          'Compare what the selfcheck printed with what it should print. Which line differs?',
        ],
      },
      {
        keywords: ['drill', 'incident', 'runbook', 'rollback', 'broke'],
        hints: [
          'A faulted copy breaks one setting. What did the selfcheck say when it failed, and which file does that point to?',
          'A runbook entry in the Runbook tab says what to check, what you expect to see and what to do if you do not. Which entry of yours leaves one of those out?',
        ],
      },
    ],
    progressive: [
      'Start with the image definition. Where does the code live, and how does the process start?',
      'Run the selfcheck and read every line it prints. Does each one say what you expect?',
      'Run the drill and note exactly what failed. Which single setting explains it?',
      'Fill in the Runbook tab from what you observed. Could someone else follow it without asking you?',
    ],
  },
  maintenance: {
    topics: [
      {
        keywords: ['change', 'request', 'requirement', 'new', 'behaviour'],
        hints: [
          'Restate the change request as one rule about inputs and outputs. Which existing behaviour must stay exactly as it was?',
          'Which functions read or write what the change touches? Trace one caller from the request to the result.',
        ],
      },
      {
        keywords: ['regression', 'test', 'break', 'fail', 'existing'],
        hints: [
          'A regression test pins behaviour that already worked. Which existing behaviour is closest to your change, and which test protects it?',
          'Run the existing tests before and after your change. Did any result move that the change request did not ask for?',
        ],
      },
      {
        keywords: ['change request', 'release', 'contract', 'acceptance', 'version'],
        hints: [
          'A release line says what changed for the people who use it, and which acceptance items it covers.',
          'If a published contract describes the changed behaviour, does it still say the truth after your change?',
        ],
      },
    ],
    progressive: [
      'Start from the change request. What is the one new rule, and what must not change?',
      'Find every place the rule applies. Which layers of the application must agree on it?',
      'Make the change in one place, run the tests, then the next. What did each run tell you?',
      'Finish with the record: the contract amendments and the release. Does each say what is now true?',
    ],
  },
};

/** A phase this ladder has no entry for gets the Requirements method, which names no project either. */
const neutralLadderFor = (phaseKey: string): OfflineLadder =>
  (NEUTRAL_LADDER as Record<string, OfflineLadder>)[phaseKey] ?? NEUTRAL_LADDER.requirements;

/**
 * The ladder a turn climbs (every reader of a ladder asks here). Only a scope
 * `project-scope.ts` minted as a teacher's gets the neutral ladder; the
 * reference scope, and a context carrying no scope, climb the pack's own.
 */
export function offlineLadderFor(ctx: Pick<MentorContext, 'phase' | 'scope'>): OfflineLadder {
  return isMintedScope(ctx.scope) && ctx.scope.kind === 'authored' ? neutralLadderFor(ctx.phase.key) : ctx.phase.assistant;
}

/**
 * Deterministic, rule-based Socratic mentor over the phase's hint ladders.
 *
 * The chat path uses it for two things only: `matchTopic`, which counts the
 * learner's earlier questions on the ladder the prompt describes, and
 * `questionHint`, the guarded reply to an outright solution request. Every
 * other chat turn is answered by the model, and with no provider configured
 * the turn is refused rather than answered here. `chat` and `review` answer
 * from the ladders alone; because they are deterministic, specs use them as a
 * stand-in for the model. Hints come from the phase's content bundle, chosen
 * by topic keywords and escalating with repeated use.
 */
@Injectable()
export class LocalMentorProvider implements AiProvider {
  readonly name = 'local-mentor';

  matchTopic(ctx: MentorContext): number | null {
    const message = ctx.message.toLowerCase();
    const topics = offlineLadderFor(ctx).topics;
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      if (topic.keywords.some((k) => message.includes(k.toLowerCase()))) return i;
    }
    return null;
  }

  async chat(ctx: MentorContext): Promise<ProviderReply> {
    // "Why does this test fail?" is a different question from the
    // one the ladders answer, and the offline mentor answers it rather than
    // handing back the next rung with no reference to the failure.
    if (ctx.failingTest) return this.explainFailure(ctx);
    const assistant = offlineLadderFor(ctx);
    let body: string;

    // Adaptive difficulty: a 'challenge'-tier learner starts a step
    // deeper into the progression, the gentlest scaffolding fades away.
    const offset = ctx.difficultyOffset || 0;
    const topicIdx = this.matchTopic(ctx);
    if (topicIdx !== null) {
      const topic = assistant.topics[topicIdx];
      const used = (ctx.topicUseCounts[topicIdx] || 0) + offset;
      // A hint is the teacher's text, so the learner reads it plain, its HTML comments not shown.
      body = learnerText(topic.hints[Math.min(used, topic.hints.length - 1)]);
    } else {
      const step = Math.min(ctx.interactionCount + offset, assistant.progressive.length - 1);
      body = learnerText(assistant.progressive[step]);
    }

    return this.reply(ctx, body);
  }

  /**
   * The offline answer to "why does this test fail?".
   *
   * Everything in it is already stored: the case's name, the first line of its
   * message, the frame it landed in, and the pack's own hint ladder. Nothing
   * is invented and nothing is quoted out of a hidden suite, the name is read
   * as words, which is what test names are written for.
   */
  private explainFailure(ctx: MentorContext): ProviderReply {
    const t = ctx.failingTest!;
    // The ladder is chosen against the test's own words as well as the
    // question, so `test_overdue_excludes_today` reaches the overdue topic even
    // though the question itself says only "why does it fail".
    const probe: MentorContext = {
      ...ctx,
      message: [ctx.message, testNameWords(t.name), t.assertion].join(' '),
    };
    const idx = this.matchTopic(probe);
    const offline = offlineLadderFor(ctx);
    const ladder = idx !== null ? offline.topics[idx].hints : offline.progressive;
    const step = Math.min(
      (ctx.difficultyOffset || 0) +
        (idx !== null ? ctx.topicUseCounts[idx] || 0 : ctx.interactionCount),
      Math.max(0, ladder.length - 1),
    );
    const where = t.path && t.line ? `, in ${t.path}, line ${t.line}` : '';
    const body = [
      `**What this test checks.** Reading its name: ${testNameWords(t.name)}.`,
      t.assertion
        ? `**What happened.** It stopped at \`${t.assertion}\`${where}.`
        : `**What happened.** It failed without saying why${where}.`,
      learnerText(ladder[step] ?? ''),
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    return this.reply(ctx, body);
  }

  /**
   * The reply to an outright "give me the solution". The ladders deepen with
   * every exchange, and the last rung of a progression is the most concrete
   * step, so a learner who keeps asking for the answer must not be walked
   * down to it. This picks the shallowest rung phrased as a question (never
   * the deepest) and, if nothing on the ladder asks one, turns the first rung
   * into one.
   */
  async questionHint(ctx: MentorContext): Promise<ProviderReply> {
    const assistant = offlineLadderFor(ctx);
    const topicIdx = this.matchTopic(ctx);
    const ladder = (topicIdx !== null ? assistant.topics[topicIdx].hints : assistant.progressive).map(learnerText);
    const shallow = ladder.slice(0, Math.max(1, ladder.length - 1));
    const asked = shallow.find((hint) => hint.includes('?'));
    const body = asked ?? `${shallow[0]}\n\nWhich part of that could you attempt on your own first?`;
    return this.reply(ctx, body);
  }

  private reply(ctx: MentorContext, body: string): ProviderReply {
    const extras: string[] = [];
    if (ctx.signals.todosRemaining.length > 0) {
      extras.push(
        `Looking at your workspace: \`${ctx.signals.todosRemaining[0]}\` is still a stub — a good next target.`,
      );
    }
    if (ctx.signals.lastFailedChecks.length > 0) {
      extras.push(
        `Your last submission didn't pass “${ctx.signals.lastFailedChecks[0]}” — worth revisiting once you've thought this through.`,
      );
    }
    // One clause of memory, never the block the model gets: this stand-in's
    // reply stays short, and the newest decision is the one worth naming.
    const remembered = memorySentence(ctx.memory ?? null);
    if (remembered) extras.push(`${remembered}`);
    // The instructor's notes, at most two, so a spec can see that the chat
    // context carried them through.
    for (const note of (ctx.instructorNotes ?? []).slice(0, 2)) {
      const text = note.trim();
      if (text) extras.push(`Your instructor's note for this class: ${text}`);
    }

    const content = [body, ...extras].join('\n\n');
    return {
      content,
      tokensIn: estimateTokens(ctx.message),
      tokensOut: estimateTokens(content),
      provider: this.name,
    };
  }

  async review(phase: PhaseContent, input: ReviewInput): Promise<AiRubricReview> {
    const passedChecks = input.checks.filter((c) => c.status === 'passed');
    const failedChecks = input.checks.filter((c) => c.status === 'failed');
    const weakest = [...input.criteria].sort((a, b) => a.score - b.score)[0];
    const strongest = [...input.criteria].sort((a, b) => b.score - a.score)[0];

    const summary =
      input.overall >= phase.rubric.passThreshold
        ? `Solid ${phase.title.toLowerCase()} work at ${input.overall}/100. ${strongest ? `Strongest on “${strongest.title}” (${strongest.score}).` : ''} ${
            weakest && weakest.score < 100 ? `The next gain is in “${weakest.title}” (${weakest.score}).` : 'Nothing obvious left on the table.'
          }`
        : `Not there yet at ${input.overall}/100 — the gate needs ${phase.rubric.passThreshold}. ${
            weakest ? `Start with “${weakest.title}” (${weakest.score}): that's where the most points are waiting.` : ''
          }`;

    const strengths = passedChecks.slice(0, 3).map((c) => c.label);
    const improvements = failedChecks.length
      ? failedChecks.slice(0, 3).map((c) => `${c.label} — ${c.detail}`)
      : ['Consider edge cases beyond the rubric: what would surprise a user in production?'];

    // "0 mentor hint(s)" is a parenthetical plural the
    // voice rules do not allow, and a count of none reads better as a word.
    const hintCount =
      input.hints === 0 ? 'no mentor hints' : input.hints === 1 ? 'one mentor hint' : `${input.hints} mentor hints`;
    const processNote = input.ranBeforeSubmit
      ? input.hints <= 6
        ? `Healthy process: you ran feedback loops before submitting and used ${hintCount} — the decisions stayed yours.`
        : `You ran checks before submitting — good. But ${input.hints} mentor hints this phase is on the high side; try forming your own answer before asking.`
      : `You submitted without running the checks first. Practitioners run the fast loop early and often — feedback is cheapest before you commit.`;

    return {
      summary: summary.replace(/\s+/g, ' ').trim(),
      strengths,
      improvements,
      processNote,
      provider: this.name,
    };
  }
}
