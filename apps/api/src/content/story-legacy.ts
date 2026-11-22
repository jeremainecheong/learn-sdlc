import {
  DEFAULT_STORY_FLOOR,
  STORY_CAPS,
  STORY_JSON,
  type ProvidedStory,
  type StoryChecksSpec,
} from '@learnsdlc/shared';
import { validateStoryChecks } from './content.service';
import type { ContentFileSpec } from './content.types';
import type { OlderWrittenChecks } from './older-written';

const PROVIDED = 'requirements/provided-stories.md';
const OWN = 'requirements/my-story.md';
/** The 2.x learner story file a legacy Requirements task grades, for the doors that look for one. */
export const LEGACY_OWN_STORY = OWN;

/** `# US-4 …` or `## US-1 — Add a task *(approved, api)*`: the id, then whatever title follows. */
const HEADING = /^#{1,2}\s+([A-Z][A-Z0-9]*-\d+)\b\s*[·:—-]?\s*(.*?)\s*$/m;
/** The standard sentence, written as prose: "As a busy learner, I want …, so that …." */
const SENTENCE = /\bAs an? (.+?),? I want (.+?),?\s+so that (.+?)(?:\.(?:\s|$)|$)/i;
/** The older bold-label layout: `**As a** busy learner`. */
const LABEL = (label: string, block: string) =>
  new RegExp(`\\*\\*${label}\\*\\*\\s*:?\\s*(.+)`, 'i').exec(block)?.[1]?.trim() ?? '';

/** A criterion's id at the start of its line, however it is dressed: `AC-1:`, `**AC-1:**`, `**US-1/AC-1** —`, a table cell. */
const AC_LABEL = String.raw`(?:\*\*)?(?:[A-Z][A-Z0-9]*-\d+\/)?AC-\d+[ \t]*[:.)]?[ \t]*(?:\*\*)?[ \t]*[:.)—–|-]?[ \t]*`;

/**
 * A block that writes acceptance criteria: an `**AC-n**` label anywhere, or a
 * clause that opens a line (after any list marker, table pipe, criterion id or
 * bold) with Given and goes on to when and then. A story sentence that merely
 * contains the three words is not one.
 */
const CRITERIA = new RegExp(
  String.raw`\*\*AC-\d+\*\*|^[ \t]*(?:[-*+]|\d+[.)]|\|)?[ \t]*(?:${AC_LABEL})?(?:\*\*)?given\b[\s\S]*?\bwhen\b[\s\S]*?\bthen\b`,
  'im',
);

/** A title without the italic status note the backlog hangs off it, e.g. `*(approved, api)*`. */
const cleanTitle = (title: string) => title.replace(/\s*\*\([^)]*\)\*\s*$/, '').trim();
const flatten = (text: string) => text.replace(/\s+/g, ' ').trim();

function storyFrom(id: string, title: string, block: string): { story: ProvidedStory; defaulted: boolean } {
  const body = flatten(block.split('\n').slice(1).join('\n'));
  const prose = SENTENCE.exec(body);
  let persona = prose?.[1]?.trim() || LABEL('As an?', block);
  let capability = prose?.[2]?.trim() || LABEL('I want', block);
  let benefit = prose?.[3]?.trim() || LABEL('So that', block);
  const defaulted = !persona || !capability || !benefit;
  if (!persona) persona = 'user';
  if (!capability) capability = title;
  if (!benefit) benefit = /^(.+?\.)(?:\s|$)/.exec(body)?.[1] || title;
  return { story: { id, title, persona, capability, benefit }, defaulted };
}

/**
 * Reads a pre-story-kind Requirements phase (provided-stories.md + my-story.md
 * + regex rules) into story checks with the default floor. The result is held
 * to `validateStoryChecks`, so a converted phase is one the loader would accept
 * as written; a refusal throws naming the rule it broke.
 */
export function storyChecksFromLegacyMarkdown(
  files: ContentFileSpec[],
  rawChecks: unknown,
): { checks: StoryChecksSpec; files: ContentFileSpec[]; note: string } {
  const provided = files.find((f) => f.path === PROVIDED)?.content ?? '';
  const own = files.find((f) => f.path === OWN)?.content ?? '';
  const ownId = HEADING.exec(own)?.[1] ?? 'US-4';

  const found: ProvidedStory[] = [];
  const defaulted: string[] = [];
  const withCriteria: string[] = [];
  for (const block of provided.split(/^(?=#{1,2}\s)/m)) {
    const m = HEADING.exec(block);
    if (!m || m.index !== 0) continue;
    // the backlog keeps a placeholder heading for the learner's own story; it is not a provided one
    if (m[1] === ownId) continue;
    const title = cleanTitle(m[2]) || m[1];
    const one = storyFrom(m[1], title, block);
    found.push(one.story);
    if (one.defaulted) defaulted.push(m[1]);
    if (CRITERIA.test(block.split('\n').slice(1).join('\n'))) withCriteria.push(m[1]);
  }
  const providedStories = found.slice(0, STORY_CAPS.providedStories);
  const truncated = found.length - providedStories.length;

  const targets = (rawChecks as Partial<Pick<OlderWrittenChecks, 'targets'>>)?.targets ?? [];
  const kept = files.filter((f) => f.path !== PROVIDED && f.path !== OWN && !targets.includes(f.path));

  let checks: StoryChecksSpec;
  try {
    checks = validateStoryChecks({
      kind: 'story',
      record: STORY_JSON,
      providedStories,
      learnerStory: { id: ownId, hints: {} },
      floor: { ...DEFAULT_STORY_FLOOR },
    });
  } catch (err) {
    throw new Error('legacy requirements could not be converted: ' + (err as Error).message);
  }

  const notes = [
    `Requirements converted from markdown: ${providedStories.length} provided stories, learner story ${ownId}, default floor; ${targets.length} rule targets dropped`,
  ];
  if (truncated > 0) notes.push(`${truncated} provided stories beyond the cap of ${STORY_CAPS.providedStories} dropped`);
  if (defaulted.length) notes.push(`default persona, capability or benefit filled for ${defaulted.join(', ')}`);
  // the adapter reads each story's sentence, never its criteria: say so, so the
  // teacher re-enters them rather than finding the worked examples gone
  const convertedIds = new Set(providedStories.map((story) => story.id));
  const dropped = withCriteria.filter((id) => convertedIds.has(id));
  const criteriaNote = dropped.length
    ? `. The acceptance criteria written under ${dropped.join(', ')} were not converted; add them to those provided stories in the story builder.`
    : '';
  return { checks, files: kept, note: notes.join('; ') + criteriaNote };
}
