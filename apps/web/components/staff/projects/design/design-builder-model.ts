/**
 * The Design builder's pure half: which task it edits, the design body the
 * server holds, what Copy from Requirements copies, which steps are done, and
 * the starting point said in words. Nothing here touches React, the network
 * or the DOM.
 */
import {
  API_CONTRACT_JSON,
  DESIGN_CAPS,
  DESIGN_JSON,
  EMPTY_API_CONTRACT,
  EMPTY_SCREEN_CONTRACT,
  LEARNER_PICKS,
  SCREEN_CONTRACT_JSON,
  andList,
  apiEndpoints,
  designContractOffRefusal,
  fileNotMountedRefusal,
  readDesignRecord,
  screenRows,
  type DesignChecksBody,
  type DesignStory,
  type DesignSwitches,
  type DraftPhaseView,
  type DraftTaskView,
  type TaskMutationResult,
  type UpdateTaskBody,
} from '@learnsdlc/shared';
import { WEIGHT_TOLERANCE } from '../requirements/builder-model';
import { storySentence } from '@/components/workspace/panels/requirements/storySentence';

/**
 * The line the builder shows on a task still in the older format; the teacher
 * guide quotes it. It names the saves that convert the task (each sends the
 * design body): a Background save and a sign-off mark alone never do.
 */
export const DESIGN_CONVERTING_STEPS = 'the stories, the learner’s design, the floor or the criteria';
export const DESIGN_OLDER_FORMAT_NOTICE = `This task is in the older format. Saving ${DESIGN_CONVERTING_STEPS} converts it.`;
export const DESIGN_OLDER_FORMAT_NOTICE_READONLY = 'This task is in the older format.';

/** A copied text held to the stories' cap, so a copy never sends what the door refuses. */
const cut = (text: string) => (text.length > DESIGN_CAPS.storyText ? `${text.slice(0, DESIGN_CAPS.storyText - 1)}…` : text);
/** The story's sentence from the one composer, or '' until all three parts are written. */
const sentence = (persona?: string, capability?: string, benefit?: string) =>
  storySentence({ persona: persona ?? '', capability: capability ?? '', benefit: benefit ?? '' });

/**
 * The task the builder edits on this phase, or null where the editor keeps
 * its generic panels: the Design phase's one written task (a concept quiz
 * beside it keeps its own row), when the payload carries its design view. A
 * task in the older format carries one too (the read-time view), so it opens
 * here already converted. On an editable draft only a task a teacher may
 * write opens here.
 */
export function designBuilderTask(phase: DraftPhaseView, editable: boolean): DraftTaskView | null {
  if (phase.key !== 'design') return null;
  const work = phase.tasks.filter((one) => one.checkKind !== 'quiz' && !one.quiz);
  if (work.length !== 1 || !work[0].design) return null;
  return work[0].authorable || !editable ? work[0] : null;
}

/** The task's three switches, stories and floor as a body (the converted defaults on the older format). */
export function designBodyOf(task: DraftTaskView): DesignChecksBody {
  const d = task.design!;
  return {
    contracts: { ...d.contracts },
    sequence: d.sequence,
    stories: d.stories.map((s) => ({ ...s })),
    floor: { ...d.floor },
  };
}

/** The design body the server holds on this task, or null on one still in the older format (or none). */
export function savedDesignBody(task: DraftTaskView | undefined): DesignChecksBody | null {
  return task?.design && !task.designOlderFormat ? designBodyOf(task) : null;
}

/**
 * The stories to design for, copied from the draft's Requirements phase: the
 * provided stories, then the learner's story titled from its capability hint
 * (skipped when the learner picks the id, as there is no id to list). At most
 * 12 are copied; `left` names the ids that did not fit. Null when the draft
 * has no Requirements story task.
 */
export function copyFromRequirements(draft: { phases: DraftPhaseView[] }): { stories: DesignStory[]; left: string[] } | null {
  const requirements = draft.phases.find((one) => one.key === 'requirements');
  const story = requirements?.tasks.find((one) => one.story)?.story;
  if (!story) return null;
  const all: DesignStory[] = story.providedStories.map((s) => ({
    id: s.id,
    title: cut(s.title),
    line: cut(sentence(s.persona, s.capability, s.benefit) || s.title),
  }));
  if (story.learnerStory.id !== LEARNER_PICKS) {
    const h = story.learnerStory.hints;
    all.push({
      id: story.learnerStory.id,
      title: cut(h.capability?.trim() || "The learner's story"),
      line: cut(sentence(h.persona, h.capability, h.benefit) || 'The story the learner writes in Requirements.'),
    });
  }
  return { stories: all.slice(0, DESIGN_CAPS.stories), left: all.slice(DESIGN_CAPS.stories).map((s) => s.id) };
}

/** Which of the six steps the server holds as done. */
export function designStepsDone(phase: DraftPhaseView, task: DraftTaskView): boolean[] {
  const criteria = task.rubric?.criteria ?? [];
  const sum = criteria.reduce((total, one) => total + one.weight, 0);
  const converted = Boolean(task.design) && !task.designOlderFormat;
  return [
    phase.intro.trim().length > 0,
    (task.design?.stories.length ?? 0) > 0,
    Boolean(task.title.trim() && task.brief.trim()),
    converted,
    converted,
    criteria.length > 0 && Math.abs(sum - 1) <= WEIGHT_TOLERANCE,
  ];
}

/** What stops the stories saving, in one sentence, or ''. */
export function storiesProblem(stories: readonly DesignStory[]): string {
  if (stories.length > DESIGN_CAPS.stories) return `At most ${DESIGN_CAPS.stories} stories.`;
  for (const [at, story] of stories.entries()) {
    if (![story.id, story.title, story.line].every((one) => one.trim())) {
      return `Give story ${at + 1} an id, a title and a line.`;
    }
    if (story.id.length > DESIGN_CAPS.storyId) return `A story id is at most ${DESIGN_CAPS.storyId} characters; ${story.id} is longer.`;
  }
  const seen = new Set<string>();
  for (const story of stories) {
    if (seen.has(story.id)) return `Two stories share the id ${story.id}.`;
    seen.add(story.id);
  }
  return '';
}

/** The learner-facing sentence of the switches: what the learner writes, the ones that are off left out. */
export function switchesSentence(switches: DesignSwitches): string {
  const parts = [
    'the design record',
    ...(switches.contracts.api ? ['the API contract'] : []),
    ...(switches.contracts.screens ? ['the screen contract'] : []),
    ...(switches.sequence ? ['the sequence diagram'] : []),
  ];
  return `The learner writes ${andList(parts)}.`;
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The starting point in words, read from the phase's documents with the
 * shared readers: the record's counts, then each contract that is on. No
 * file name and no markdown.
 */
export function startingPointSentence(files: readonly { path: string; content: string | null }[], switches: DesignSwitches): string {
  const text = (path: string) => files.find((one) => one.path === path)?.content ?? undefined;
  const record = readDesignRecord(text(DESIGN_JSON) ?? '').design;
  const parts = record
    ? [
        record.entities.length ? counted(record.entities.length, 'entity', 'entities') : '',
        record.relations.length ? counted(record.relations.length, 'relation', 'relations') : '',
        record.operations.length ? counted(record.operations.length, 'operation', 'operations') : '',
        record.decisions.length ? counted(record.decisions.length, 'decision', 'decisions') : '',
      ].filter(Boolean)
    : [];
  const contracts = [
    switches.contracts.api && text(API_CONTRACT_JSON) !== undefined
      ? `the API contract ${counted(apiEndpoints(text(API_CONTRACT_JSON)).length, 'endpoint', 'endpoints')}`
      : '',
    switches.contracts.screens && text(SCREEN_CONTRACT_JSON) !== undefined
      ? `the screen contract ${counted(screenRows(text(SCREEN_CONTRACT_JSON)).length, 'screen', 'screens')}`
      : '',
  ].filter(Boolean);
  if (!parts.length && !contracts.length) return 'The starting point is an empty design.';
  return `The starting point holds ${parts.length ? andList(parts) : 'an empty design record'}${contracts.map((one) => `; ${one}`).join('')}.`;
}

/** The same document, read as JSON, so a seed re-spaced by an edit undone still reads as the seed. */
function sameDocument(text: string, seed: string): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(JSON.parse(seed));
  } catch {
    return false;
  }
}

/**
 * The line that asks before a contract is switched off, or null when there
 * is nothing to lose: the server removes a switched-off contract's starting
 * document, so one holding more than the empty seed is asked about first,
 * with what it holds. `held` is the document's bytes, undefined where none
 * is mounted, or null while step 4 has not read the documents (still being
 * read, or the read failed): then it asks anyway, without a count.
 */
export function switchOffConfirm(contract: 'api' | 'screens', held: string | undefined | null): string | null {
  if (held === null) return `Switching the ${contract === 'api' ? 'API' : 'screen'} contract off removes its starting document.`;
  if (held === undefined || sameDocument(held, contract === 'api' ? EMPTY_API_CONTRACT : EMPTY_SCREEN_CONTRACT)) return null;
  const what =
    contract === 'api'
      ? `the API contract off removes its starting document (${counted(apiEndpoints(held).length, 'endpoint', 'endpoints')})`
      : `the screen contract off removes its starting document (${counted(screenRows(held).length, 'screen', 'screens')})`;
  return `Switching ${what}. Switching it back on starts it empty.`;
}

/** Said in step 4 for an edit to a contract whose switch is off: it is not sent. */
export function contractOffSentence(path: string): string {
  return `The ${path === API_CONTRACT_JSON ? 'API' : 'screen'} contract is switched off; turn it on in step 3 to edit its starting point.`;
}

/**
 * Whether the files door refused a contract's bytes because its switch is
 * off: the row still mounted with the switch off, or the row the switch-off
 * already removed (an edit sent while step 3's save was out).
 */
export function isContractOffRefusal(path: string, message: string, phaseTitle: string): boolean {
  if (path !== API_CONTRACT_JSON && path !== SCREEN_CONTRACT_JSON) return false;
  return (
    message === designContractOffRefusal(path === API_CONTRACT_JSON ? 'API' : 'screen') ||
    message === fileNotMountedRefusal(path, phaseTitle)
  );
}

/**
 * A save that writes the task through the builder's one queue: given the
 * design body the server holds when its turn comes (null on a task still in
 * the older format), the body to send.
 */
export type DesignTaskWrite = (build: (held: DesignChecksBody | null) => UpdateTaskBody) => Promise<TaskMutationResult>;
