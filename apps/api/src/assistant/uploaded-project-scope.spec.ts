import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { DRAFT_FIRST_VERSION, LEARNER_PICKS } from '@learnsdlc/shared';
import type { InterviewBrief, PhaseContent, ProjectContent } from '../content/content.types';
import { ContentService } from '../content/content.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectImporterService, mintTeacherSlug } from '../content/importer.service';
import { compilePack, type CompiledTask } from '../content/pack-compiler';
import { isReferenceInterview } from '../content/reference-content';
import { UploadService } from '../authoring/upload.service';
import {
  composeAgentChatAssessment,
  composeAgentChatGeneration,
  composeAgenticIntentAssessment,
  composeAgenticProposeGeneration,
} from './agentic.service';
import { composeInterviewReviewMessages } from './interview-review';
import {
  composeChatMessages,
  composeGuidedRepairMessages,
  composeGuidedReviewMessages,
  composeInterviewMessages,
  composeInterviewRepairMessages,
  composeReviewMessages,
  type ChatMessage,
} from './openai.provider';
import { REFERENCE_SCOPE, phaseScopeOf, taskScopeOf } from './project-scope';
import type { MentorContext, ReviewInput } from './provider.types';
import { REFERENCE_TERMS, referenceTermsIn } from '../../test/reference-terms';
import { zipDirectory } from '../../test/fixtures/upload-packs/archive';
import { uploadPack } from '../../test/fixtures/paths';

/*
 * An uploaded project's model requests carry nothing of TaskTrackr, and the facts
 * the starter's sealed interview holds reach only the stakeholder and its reviewers.
 *
 * The draft is the starter archive (`test/fixtures/upload-packs/starter/`),
 * zipped and sent through the real upload door, which runs the loader at the
 * door and again in the importer; the content
 * the importer would store is captured at its write and compiled exactly as
 * `writeTeacherDraft` compiles it. The starter is read from disk on every run
 * (its criteria may change), so nothing below pins its bytes. The MC-* labels
 * below name the describe blocks that hold each property.
 *
 * - MC-T1: the mentor (chat, lesson, Guided review and repair), the reviewer
 *   (every task of every phase), the interview (answer, repair, review) and
 *   the Agentic calls (intent assessment and propose generation, plus the chat
 *   pair) composed for the starter draft carry no TaskTrackr token and no
 *   token of TaskTrackr's stakeholder.
 * - MC-T2: every fact answer of the starter's `interview.json` is in the interview's messages and in the
 *   Requirements reviewer's (the starter's task brief names the stakeholder),
 *   and in no mentor, Agentic or other phase's review message.
 * - MC-T4 (on the starter's own interview): no answer recites the story
 *   line or a criterion.
 * - Negative controls: each detector, fed a composition with the leak planted
 *   through test-only inputs (never by editing source), reports it.
 *
 * Pure: no database, no AI, no server.
 */

/* ---------------------------------- the repo --------------------------------- */

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'content', 'tasktrackr', 'project.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('repository root not found');
    dir = up;
  }
  return dir;
}
const REPO = repoRoot();
const STARTER = uploadPack('starter');
const TASKTRACKR = path.join(REPO, 'content', 'tasktrackr');
const TITLE = 'Shelf starter';

/** Every text file of a pack directory, joined: what the teacher's archive itself says. */
function textOf(root: string): string {
  const out: string[] = [];
  const visit = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else out.push(child, fs.readFileSync(path.join(root, child), 'utf8'));
    }
  };
  visit('');
  return out.join('\n');
}

/* ------------------------------ the TaskTrackr side ----------------------------- */

const content = new ContentService();
const tasktrackr = content.loadProject(new DirectoryPackSource(TASKTRACKR));
const ttRequirements = tasktrackr.phases.find((phase) => phase.key === 'requirements')!;
const TT_BRIEF = ttRequirements.interview!;

/**
 * The strict list, read from TaskTrackr itself: its name and slug, and every
 * word of its stakeholder's name (the persona token). Matched case-insensitively
 * as whole words, so a word that merely contains one is not a hit.
 */
const STRICT_TOKENS: readonly string[] = [
  'TaskTrackr',
  tasktrackr.slug,
  ...TT_BRIEF.persona.name.split(/\s+/).filter((word) => word.length >= 3),
].filter((token, at, all) => all.findIndex((one) => one.toLowerCase() === token.toLowerCase()) === at);

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strictHits = (text: string): string[] =>
  STRICT_TOKENS.filter((token) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(token)}([^A-Za-z0-9]|$)`, 'i').test(text));

/**
 * The broad list (`test/reference-terms.ts`, the reviewer-scoping suites'
 * own): a TaskTrackr fact the starter archive did not itself say. The starter
 * legitimately names its own backlog file (the one its Design phase mounts)
 * and Flask, so those are allowed by the archive's text, exactly as those
 * suites allow a task's own words.
 */
const STARTER_TEXT = textOf(STARTER);
const broadHits = (text: string): string[] => referenceTermsIn(text, STARTER_TEXT);

const all = (messages: ChatMessage[] | Array<{ role: string; content: string }>): string =>
  messages.map((message) => message.content).join('\n');

/** A fact answer as any composer may carry it: raw, or inside a JSON string. */
const forms = (answer: string): string[] => [...new Set([answer, JSON.stringify(answer).slice(1, -1)])];
const answersIn = (text: string, answers: readonly string[]): string[] =>
  answers.filter((answer) => forms(answer).some((form) => text.includes(form)));

/* ----------------------------- the starter draft ----------------------------- */

interface Draft {
  project: ProjectContent;
  tasksOf: Map<string, CompiledTask[]>;
  brief: InterviewBrief;
  answers: string[];
}

/** The starter, uploaded through the real door; the content the importer would write, compiled as it compiles it. */
async function uploadStarter(): Promise<Draft> {
  const importer = new ProjectImporterService(content, { transaction: jest.fn(async () => { throw new Error('no database here'); }) } as unknown as DataSource);
  const written: ProjectContent[] = [];
  jest.spyOn(importer as unknown as { writeTeacherDraft: (l: ProjectContent) => Promise<unknown> }, 'writeTeacherDraft').mockImplementation(async (loaded: ProjectContent) => {
    written.push(loaded);
    return { projectId: 'p', versionId: 'v', slug: 'shelf-starter', report: { ok: true } as never, packDigest: 'd' };
  });
  const upload = new UploadService(importer, content, {} as DataSource, 8 * 1024 * 1024);
  const result = await upload.upload({ id: 'owner' } as never, { title: TITLE, archiveBase64: zipDirectory(STARTER).toString('base64') });
  // The starter ships its interview, a story phase and its Deployment and Maintenance records, in the folder
  // layout with every brief plain: the door converts nothing and says nothing.
  expect(Object.keys(result)).not.toContain('interview');
  expect(result.warnings).toBeUndefined();
  expect(written).toHaveLength(1);
  // writeTeacherDraft's own first lines: the minted slug, the title, the draft version, then compilePack.
  const project: ProjectContent = { ...written[0], slug: mintTeacherSlug(TITLE, new Set()), title: TITLE, version: DRAFT_FIRST_VERSION };
  const snapshot = compilePack(project);
  const tasksOf = new Map(snapshot.phases.map((one) => [one.key, one.tasks]));
  const brief = project.phases.find((phase) => phase.key === 'requirements')!.interview!;
  return { project, tasksOf, brief, answers: brief.facts.map((fact) => fact.answer) };
}

/* ------------------------------- the compositions ------------------------------ */

const QUESTION = 'Where should I start with this task?';
const CANDIDATE = 'Start from the brief. Which single sentence in it names the case you are least sure about?';

const editable = (phase: PhaseContent): Record<string, string> =>
  Object.fromEntries(phase.files.filter((file) => file.editable).map((file) => [file.path, file.content]));

const mentorCtx = (phase: PhaseContent, tasks: CompiledTask[], over: Partial<MentorContext> = {}): MentorContext =>
  ({
    phase,
    message: QUESTION,
    workspace: editable(phase),
    history: [],
    interactionCount: 0,
    topicUseCounts: {},
    signals: { todosRemaining: [], lastFailedChecks: [] },
    scope: phaseScopeOf(phase, tasks),
    ...over,
  }) as MentorContext;

const reviewInput = (phase: PhaseContent, task: CompiledTask, tasks: CompiledTask[], over: Partial<ReviewInput> = {}): ReviewInput =>
  ({
    workspace: editable(phase),
    criteria: task.rubric.criteria.map((one) => ({ key: one.key, title: one.title, weight: one.weight, score: 0, evidence: [] })),
    checks: [],
    overall: 0,
    hints: 0,
    ranBeforeSubmit: false,
    task,
    phaseTasks: tasks,
    ...over,
  }) as ReviewInput;

/** Every mentor request one phase can send: chat, lesson chat, Guided review and Guided repair. */
function mentorTexts(phase: PhaseContent, tasks: CompiledTask[], over: Partial<MentorContext> = {}): Record<string, string> {
  const ctx = mentorCtx(phase, tasks, over);
  const lesson = mentorCtx(phase, tasks, { scope: phaseScopeOf(phase, tasks, { lesson: true }), ...over });
  return {
    chat: all(composeChatMessages(ctx)),
    lesson: all(composeChatMessages(lesson)),
    'guided.review': all(composeGuidedReviewMessages(ctx, CANDIDATE)),
    'guided.repair': all(composeGuidedRepairMessages(ctx, CANDIDATE, ['grounded'])),
  };
}

/** Both Agentic calls (intent assessment, propose generation in both modes) and the Agentic chat pair. */
function agenticTexts(phase: PhaseContent, tasks: CompiledTask[], scope = phaseScopeOf(phase, tasks)): Record<string, string> {
  return {
    'agentic.intent': composeAgenticIntentAssessment(phase, scope),
    'agentic.propose.files': composeAgenticProposeGeneration(phase, 'files', scope),
    'agentic.propose.edits': composeAgenticProposeGeneration(phase, 'edits', scope),
    'agentic.chat.classify': composeAgentChatAssessment(phase, scope),
    'agentic.chat.files': composeAgentChatGeneration(phase, 'files', scope),
    'agentic.chat.edits': composeAgentChatGeneration(phase, 'edits', scope),
  };
}

/** One review per task of the phase, keyed by task. */
function reviewTexts(phase: PhaseContent, tasks: CompiledTask[]): Record<string, string> {
  return Object.fromEntries(tasks.map((task) => [`review.${task.taskKey}`, all(composeReviewMessages(phase, reviewInput(phase, task, tasks)))]));
}

/** Every interview request: the answer (fresh, half-settled), its repair, and its output review. */
function interviewTexts(brief: InterviewBrief, title: string): Record<string, string> {
  const half = brief.facts.slice(0, Math.ceil(brief.facts.length / 2)).map((fact) => fact.id);
  const question = 'What does free to borrow mean at the desk?';
  return {
    'interview.answer': all(composeInterviewMessages(brief, title, question, [])),
    'interview.answer.settled': all(composeInterviewMessages(brief, title, question, half)),
    'interview.repair': all(composeInterviewRepairMessages(brief, title, question, half, { answer: 'It depends.', facts: [], failedChecks: ['grounded'] })),
    'interview.review': all(composeInterviewReviewMessages({ answer: 'It depends.', question, claimedFactIds: [], brief })),
  };
}

/* ------------------------------------ specs ------------------------------------ */

let draft: Draft;

beforeAll(async () => {
  draft = await uploadStarter();
});

describe('the starter draft is a teacher project, on every arm', () => {
  it('carries an interview whose stakeholder the Requirements brief names, and takes the authored arm', () => {
    expect(isReferenceInterview(draft.brief)).toBe(false);
    expect(draft.brief.facts.length).toBeGreaterThan(0);
    const requirements = draft.project.phases.find((phase) => phase.key === 'requirements')!;
    const [task] = draft.tasksOf.get('requirements')!;
    expect(task.brief.toLowerCase()).toContain(draft.brief.persona.name.toLowerCase());
    expect(taskScopeOf(requirements, task, draft.tasksOf.get('requirements')).kind).toBe('authored');
  });

  it('every phase resolves the authored scope for the mentor, the Agentic calls and every task reviewer', () => {
    expect(draft.project.phases.map((phase) => phase.key)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
    for (const phase of draft.project.phases) {
      const tasks = draft.tasksOf.get(phase.key)!;
      expect(phaseScopeOf(phase, tasks).kind).toBe('authored');
      for (const task of tasks) expect(taskScopeOf(phase, task, tasks).kind).toBe('authored');
    }
  });

  it('the strict token list is TaskTrackr and its stakeholder, read from the reference pack', () => {
    expect(STRICT_TOKENS.map((token) => token.toLowerCase())).toEqual(expect.arrayContaining(['tasktrackr', 'dana', 'osei']));
    expect(REFERENCE_TERMS).toEqual(expect.arrayContaining(['TaskTrackr', 'Dana', 'Osei']));
  });
});

describe('no TaskTrackr or TaskTrackr-persona token in any request the starter draft composes', () => {
  const families = (): Array<[string, Record<string, string>]> => {
    const out: Array<[string, Record<string, string>]> = [];
    for (const phase of draft.project.phases) {
      const tasks = draft.tasksOf.get(phase.key)!;
      out.push([`${phase.key} mentor`, mentorTexts(phase, tasks)]);
      out.push([`${phase.key} review`, reviewTexts(phase, tasks)]);
      out.push([`${phase.key} agentic`, agenticTexts(phase, tasks)]);
    }
    out.push(['requirements interview', interviewTexts(draft.brief, TITLE)]);
    return out;
  };

  it.each(['mentor', 'review', 'agentic', 'interview'])('%s: strict tokens (TaskTrackr, its slug, its stakeholder\'s name)', (family) => {
    const hits: string[] = [];
    let composed = 0;
    for (const [label, texts] of families().filter(([label]) => label.endsWith(family))) {
      for (const [call, text] of Object.entries(texts)) {
        composed += 1;
        for (const token of strictHits(text)) hits.push(`${label} ${call}: ${token}`);
      }
    }
    expect(composed).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  /**
   * MC-F1: the authored Requirements reviewer's room line
   * (`authoredRoomContext` → `storyDeskText`, openai.provider.ts) names
   * `requirements/story.json` as maintained only when the phase mounts it.
   * The starter is a story phase and mounts it, as its own phase.json
   * declares, so the broad list has no hit left to declare.
   */
  const DECLARED: Readonly<Record<string, readonly string[]>> = {};

  it.each(['mentor', 'review', 'agentic', 'interview'])('%s: the reference-term list, less what the starter archive itself says', (family) => {
    const hits: string[] = [];
    for (const [label, texts] of families().filter(([label]) => label.endsWith(family))) {
      for (const [call, text] of Object.entries(texts)) {
        const declared = DECLARED[label] ?? [];
        for (const term of broadHits(text)) if (!declared.includes(term)) hits.push(`${label} ${call}: ${term}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the starter's story phase mounts its record, and its review names the learner's SH-5, never TaskTrackr's US-4", () => {
    const phase = draft.project.phases.find((one) => one.key === 'requirements')!;
    const starterMountsRecord = phase.files.some((file) => file.path === 'requirements/story.json');
    expect(starterMountsRecord).toBe(true);
    for (const text of Object.values(reviewTexts(phase, draft.tasksOf.get('requirements')!))) {
      // The record is the Requirements room's own file: the story task is room
      // work, and its reviewer is told the story desk.
      expect(text).toContain('Current Requirements learner interface: Stakeholder interview, then My backlog, a Jira-style desk.');
      expect(text).toContain('Use My backlog, open the story in Edit story, edit the relevant form fields, then choose Save story.');
      expect(text).not.toContain('the workspace editor');
      expect(text).toContain('story.json has story id SH-5');
      expect(text).not.toContain('US-4');
      expect(broadHits(text)).toEqual([]);
    }
  });

  it('when the learner picks the story id, the record rule names no story id at all', () => {
    const phase = draft.project.phases.find((one) => one.key === 'requirements')!;
    if (phase.checks.kind !== 'story') throw new Error('the starter Requirements phase is not a story phase');
    const picks: PhaseContent = { ...phase, checks: { ...phase.checks, learnerStory: { id: LEARNER_PICKS, hints: {} } } };
    const provided = phase.checks.providedStories.map((one) => one.id);
    expect(provided.length).toBeGreaterThan(0);
    for (const text of Object.values(reviewTexts(picks, draft.tasksOf.get('requirements')!))) {
      const rule = text.split('\n').find((line) => line.startsWith('Requirements representation rule:'))!;
      expect(rule).toContain("story.json holds the learner's chosen story id");
      expect(rule).not.toContain('US-4');
      for (const id of [...provided, 'SH-5']) expect(rule).not.toContain(id);
    }
  });
});

describe('the interview facts reach the stakeholder and the Requirements reviewer only', () => {
  it('every answer is in every interview request (answer, repair, review)', () => {
    for (const [call, text] of Object.entries(interviewTexts(draft.brief, TITLE))) {
      expect([call, answersIn(text, draft.answers)]).toEqual([call, draft.answers]);
    }
  });

  it('every answer is in the Requirements review (its brief names the stakeholder)', () => {
    const phase = draft.project.phases.find((one) => one.key === 'requirements')!;
    const texts = reviewTexts(phase, draft.tasksOf.get('requirements')!);
    expect(Object.keys(texts).length).toBeGreaterThan(0);
    for (const [call, text] of Object.entries(texts)) expect([call, answersIn(text, draft.answers)]).toEqual([call, draft.answers]);
  });

  it("no answer is in any phase's mentor request (chat, lesson, Guided review, Guided repair)", () => {
    const hits: string[] = [];
    for (const phase of draft.project.phases) {
      for (const [call, text] of Object.entries(mentorTexts(phase, draft.tasksOf.get(phase.key)!))) {
        for (const answer of answersIn(text, draft.answers)) hits.push(`${phase.key} ${call}: ${answer}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no answer is in any phase's Agentic request", () => {
    const hits: string[] = [];
    for (const phase of draft.project.phases) {
      for (const [call, text] of Object.entries(agenticTexts(phase, draft.tasksOf.get(phase.key)!))) {
        for (const answer of answersIn(text, draft.answers)) hits.push(`${phase.key} ${call}: ${answer}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no answer is in any review outside Requirements', () => {
    const hits: string[] = [];
    for (const phase of draft.project.phases.filter((one) => one.key !== 'requirements')) {
      for (const [call, text] of Object.entries(reviewTexts(phase, draft.tasksOf.get(phase.key)!))) {
        for (const answer of answersIn(text, draft.answers)) hits.push(`${phase.key} ${call}: ${answer}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("the starter's own interview.json: no answer recites the story or a criterion", () => {
  it('no answer starts with "As a", none holds given..when..then in sequence', () => {
    for (const fact of draft.brief.facts) {
      expect(fact.answer).not.toMatch(/^\s*as an?\b/i);
      expect(fact.answer).not.toMatch(/\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i);
    }
  });
});

/* ------------------------------- negative controls ------------------------------- */

describe('negative controls: each detector reports a leak planted through test-only inputs', () => {
  const requirements = (): PhaseContent => draft.project.phases.find((phase) => phase.key === 'requirements')!;
  const design = (): PhaseContent => draft.project.phases.find((phase) => phase.key === 'design')!;

  it('a TaskTrackr token in the mentor: a task brief that names TaskTrackr\'s stakeholder is caught', () => {
    const phase = requirements();
    const tasks = draft.tasksOf.get('requirements')!.map((task) => ({ ...task, brief: `${task.brief}\nAsk ${TT_BRIEF.persona.name} about it.` }));
    const hits = Object.values(mentorTexts(phase, tasks)).flatMap(strictHits);
    expect(hits).toEqual(expect.arrayContaining(TT_BRIEF.persona.name.split(/\s+/)));
  });

  it('a TaskTrackr token in the mentor: the starter phase forced onto the reference scope is caught (strict and broad)', () => {
    const phase = requirements();
    const text = all(composeChatMessages(mentorCtx(phase, draft.tasksOf.get('requirements')!, { scope: REFERENCE_SCOPE })));
    expect(strictHits(text).length).toBeGreaterThan(0);
    expect(broadHits(text)).toEqual(expect.arrayContaining(['US-4']));
  });

  it('a TaskTrackr token in a review: the starter task forced onto the reference reviewer is caught', () => {
    const phase = design();
    const tasks = draft.tasksOf.get('design')!;
    const text = all(composeReviewMessages(phase, reviewInput(phase, tasks[0], tasks, { scope: REFERENCE_SCOPE } as Partial<ReviewInput>)));
    // the reference reviewer names TaskTrackr and its overdue boundary (its Design operation scope, which named completeTask, is gone since 4.0.0)
    expect(broadHits(text)).toEqual(expect.arrayContaining(['TaskTrackr', 'overdue']));
  });

  it('a TaskTrackr token in Agentic: both Agentic calls on the reference scope are caught', () => {
    const phase = requirements();
    const texts = agenticTexts(phase, draft.tasksOf.get('requirements')!, REFERENCE_SCOPE);
    expect(strictHits(texts['agentic.intent'])).toEqual(['TaskTrackr']);
    expect(strictHits(texts['agentic.propose.files'])).toEqual(['TaskTrackr']);
  });

  it("a TaskTrackr token in the interview: TaskTrackr's own brief is caught", () => {
    const texts = interviewTexts(TT_BRIEF, TITLE);
    expect(strictHits(texts['interview.answer'])).toEqual(expect.arrayContaining(TT_BRIEF.persona.name.split(/\s+/)));
  });

  it('an interview fact in the mentor: a fact answer planted in an instructor note is caught', () => {
    const phase = requirements();
    const planted = draft.answers[draft.answers.length - 1];
    const texts = mentorTexts(phase, draft.tasksOf.get('requirements')!, { instructorNotes: [planted] });
    expect(answersIn(texts.chat, draft.answers)).toEqual([planted]);
  });

  it('an interview fact in the mentor: a fact answer planted in the workspace (a JSON-escaped carrier) is caught', () => {
    const phase = design();
    const planted = draft.answers[0];
    const texts = mentorTexts(phase, draft.tasksOf.get('design')!, { workspace: { 'design/notes.md': `"${planted}"` } });
    expect(answersIn(texts.chat, draft.answers)).toEqual([planted]);
  });

  it('an interview fact in Agentic: a fact answer planted in a task brief is caught', () => {
    const phase = requirements();
    const planted = draft.answers[0];
    const tasks = draft.tasksOf.get('requirements')!.map((task) => ({ ...task, brief: `${task.brief}\n${planted}` }));
    expect(answersIn(agenticTexts(phase, tasks)['agentic.intent'], draft.answers)).toEqual([planted]);
  });

  it('an interview fact in a review: the Requirements reviewer is not given the facts when its brief does not name the stakeholder', () => {
    const phase = requirements();
    const name = draft.brief.persona.name;
    const tasks = draft.tasksOf.get('requirements')!.map((task) => ({ ...task, brief: task.brief.split(new RegExp(escapeRe(name), 'gi')).join('the customer') }));
    const text = all(composeReviewMessages(phase, reviewInput(phase, tasks[0], tasks)));
    expect(answersIn(text, draft.answers)).toEqual([]);
  });

  it('an interview fact in the interview: a brief with its facts taken out carries no answer', () => {
    const emptied = { ...draft.brief, facts: draft.brief.facts.map((fact) => ({ ...fact, answer: 'withheld' })) };
    expect(answersIn(interviewTexts(emptied, TITLE)['interview.answer'], draft.answers)).toEqual([]);
  });

  it('a recital: a recited story line and a recited criterion are both caught', () => {
    const recited = ['As a member, I want to see free books, so that I can borrow one.', 'Given two books, When I ask, Then two are listed.'];
    expect(recited.filter((answer) => /^\s*as an?\b/i.test(answer))).toHaveLength(1);
    expect(recited.filter((answer) => /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i.test(answer))).toHaveLength(1);
  });
});
