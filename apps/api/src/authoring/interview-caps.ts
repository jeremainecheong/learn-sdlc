import { posix } from 'path';
import {
  INTERVIEW_KEYWORDS_MAX,
  INTERVIEW_KEYWORD_MAX,
  INTERVIEW_LINE_MAX,
  INTERVIEW_PERSONA_NAME_MAX,
  INTERVIEW_PERSONA_ROLE_MAX,
  phaseKeyOfFolder,
} from '@learnsdlc/shared';
import { MAX_TEACHER_BRIEF_CHARS } from '../assistant/fence-markers';
import { interviewBriefChars } from '../assistant/openai.provider';
import type { InterviewBrief, ProjectContent } from '../content/content.types';
import type { PackSource } from '../content/pack-source';

/**
 * The interview door's caps for a brief the loader has already accepted, the
 * one definition of them.
 *
 * `interview.replace` holds a teacher's brief to the loader's rules and then to
 * these caps (`checkedInterview`, in `authoring-bodies.ts`). A hand-written
 * `interview.json` in an upload would otherwise meet only the loader's, so a
 * brief the editor would refuse could arrive by archive. The upload door and
 * the teacher-draft import ask it through `refuseInterviewOverCaps`. The boot
 * import never does, so the platform pack and the content specs are
 * unaffected.
 *
 * Every field within its cap can still add up to more than one prompt carries
 * whole, and past it the brief would be cut mid-fact. The written-out length
 * counts JSON the teacher never typed, so that refusal names the overshoot:
 * every character cut from an answer or keyword shortens the written-out brief
 * by at least one.
 *
 * Pure: no database, no AI, no clock.
 */

/** The door's sentence for the first cap `brief` is over, in the door's order, or null when it is within all of them. */
export function interviewDoorRefusal(brief: InterviewBrief): string | null {
  const over = (value: string, what: string, max: number): string | null =>
    value.length > max ? `${what} is at most ${max} characters, and this one is ${value.length}.` : null;
  const lines =
    over(brief.persona.name, "The interview persona's name", INTERVIEW_PERSONA_NAME_MAX) ??
    over(brief.persona.role, "The interview persona's role", INTERVIEW_PERSONA_ROLE_MAX) ??
    over(brief.opening, "The interview's opening", INTERVIEW_LINE_MAX) ??
    over(brief.unknownReply, "The interview's reply to an unknown question", INTERVIEW_LINE_MAX) ??
    over(brief.refusal, "The interview's refusal", INTERVIEW_LINE_MAX);
  if (lines) return lines;
  for (const fact of brief.facts) {
    if (fact.keywords.length > INTERVIEW_KEYWORDS_MAX) {
      return `The interview's fact "${fact.id}" has ${fact.keywords.length} keywords, and a fact takes at most ${INTERVIEW_KEYWORDS_MAX}.`;
    }
    for (const keyword of fact.keywords) {
      if (keyword.trim().length === 0) {
        return `The interview's fact "${fact.id}" has a blank keyword, which would match every question a learner asks.`;
      }
      const long = over(keyword, `A keyword of the interview's fact "${fact.id}"`, INTERVIEW_KEYWORD_MAX);
      if (long) return long;
    }
  }
  const extra = interviewBriefChars(brief) - MAX_TEACHER_BRIEF_CHARS;
  if (extra > 0) {
    return `The interview is ${extra} character${extra === 1 ? '' : 's'} longer than one stakeholder can hold; shorten its answers or keywords by at least that much, or keep fewer facts.`;
  }
  return null;
}

/**
 * A hand-written brief's refusal for the upload, naming where it is written:
 * the file its phase.json `interview` names, or the phase.json itself for an
 * inline brief. Null when the brief is within every cap.
 */
export function handWrittenInterviewRefusal(brief: InterviewBrief, phaseDir: PackSource, rel: string): string | null {
  const said = interviewDoorRefusal(brief);
  return said ? `${handWrittenInterviewAt(phaseDir, rel)}: ${said}` : null;
}

/**
 * Throws a plain `Error` naming where the brief is written (the upload door
 * files it as PACK_INVALID) when the Requirements phase's hand-written
 * interview is over one of the interview door's caps. The Requirements folder
 * is found the loader's way: in the folder layout, the folder under
 * `phases/` its name keys, whose interview is `interview.json`; in the pointer
 * layout, `project.json` `phases[]`, then each `phase.json`'s `key`, never a
 * folder name.
 */
export function refuseInterviewOverCaps(loaded: ProjectContent, source: PackSource): void {
  const brief = loaded.phases.find((one) => one.key === 'requirements')?.interview;
  if (!brief) return;
  let project: Record<string, unknown>;
  try {
    project = JSON.parse(source.read('project.json')) as Record<string, unknown>;
  } catch {
    return;
  }
  if (project && typeof project === 'object' && !Object.prototype.hasOwnProperty.call(project, 'phases')) {
    // The folder layout: the Requirements folder is the one its name keys, and its interview is interview.json.
    const said = interviewDoorRefusal(brief);
    if (!said) return;
    let folder: string | undefined;
    try {
      folder = source.entries('phases').find((one) => one.isDirectory && phaseKeyOfFolder(one.name) === 'requirements')?.name;
    } catch {
      folder = undefined;
    }
    throw new Error(`${folder === undefined ? 'interview.json' : `phases/${folder}/interview.json`}: ${said}`);
  }
  const phases = project?.phases;
  for (const rel of Array.isArray(phases) ? phases : []) {
    if (typeof rel !== 'string') continue;
    let dir: PackSource;
    try {
      dir = source.child(rel);
      if ((JSON.parse(dir.read('phase.json')) as { key?: unknown }).key !== 'requirements') continue;
    } catch {
      continue;
    }
    const said = handWrittenInterviewRefusal(brief, dir, rel.replace(/^\.\/+/, '').replace(/\/+$/, ''));
    if (said) throw new Error(said);
    return;
  }
}

/** Where the Requirements phase.json at `rel` keeps its interview, pack-relative (the loader's `readFileValue` reading). */
function handWrittenInterviewAt(phaseDir: PackSource, rel: string): string {
  const fallback = `${rel}/phase.json`;
  try {
    const value = (JSON.parse(phaseDir.read('phase.json')) as { interview?: unknown }).interview;
    const named =
      value && typeof value === 'object' && typeof (value as { source?: unknown }).source === 'string'
        ? (value as { source: string }).source
        : typeof value === 'string' && phaseDir.exists(value)
          ? value
          : null;
    return named ? posix.normalize(`${rel}/${named}`) : fallback;
  } catch {
    return fallback;
  }
}
