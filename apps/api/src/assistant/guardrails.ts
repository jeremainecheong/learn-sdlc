import type { PhaseKey } from '@learnsdlc/shared';
import { usageTimeZone } from '../config/ai';

/**
 * Answer-withholding and scope guardrails for the phase-aware assistant.
 * Pure functions so the behaviour is unit-testable independent of provider.
 */

const MAX_MESSAGE_CHARS = 2000;
const MAX_CODE_BLOCK_LINES = 8;

/** Neutralise role-injection markers and cap length. */
export function sanitizeMessage(raw: string): string {
  const capped = raw.slice(0, MAX_MESSAGE_CHARS);
  return capped.replace(/(^|\n)\s*(system|assistant|developer)\s*:/gi, '$1[$2]:').trim();
}

const SOLUTION_PATTERNS: RegExp[] = [
  // Match the requested object, not an unrelated later verb such as "a
  // question to answer" in a request for a reasoning approach.
  /\b(give|write|show|paste|send|provide|generate|produce)\s+(?:me\s+)?(?:(?:the|a|an|my|your)\s+)?(?:(?:full|complete|entire|whole|final|working)\s+)?(?:(?:python|typescript|javascript|sql|react)\s+)?(?:solution|answer|implementation|code|method bod(?:y|ies))\b/i,
  /\b(do|finish) (it|this|the (task|work|assignment|exercise|phase)) for me\b/i,
  /\b(just|simply) (tell|give) me the (answer|solution|code)\b/i,
  /\bwhat('?s| is) the (answer|solution)\b/i,
  /\bimplement (it|this|the (function|method)s?) for me\b/i,
  // asking the mentor to produce the phase artefact itself
  /\b(write|draft|create|generate|produce|make)\b[^.?!]{0,80}\bfor me\b/i,
  /\b(write|give|draft|create|generate|produce)\b[^.?!]{0,60}\b(complete|entire|whole|full|all (of )?the)\b[^.?!]{0,60}\b(stor(y|ies)|criteria|scope note|design|data model|contract|decision log|runbook|dockerfile|workflow|test suite|tests?)\b/i,
];

export function isSolutionRequest(message: string): boolean {
  return SOLUTION_PATTERNS.some(pattern => {
    // Explicit refusals of a completed answer should reach the real mentor.
    // Inspect each command independently: a negated command must not mask a
    // later affirmative request for the answer in the same message.
    const matches = message.matchAll(new RegExp(pattern.source, `${pattern.flags}g`));
    for (const match of matches) {
      const prefix = message.slice(Math.max(0, (match.index ?? 0) - 70), match.index);
      const negated = /\b(?:do not|don't|never|without|avoid|not)\s+(?:(?:want|ask|asking)\s+(?:you\s+)?to\s+)?(?:(?:just|please|ever|actually)\s+)*$/i.test(prefix);
      if (!negated) return true;
    }
    return false;
  });
}

/** Phase-unique “strong” keywords trigger a redirect on a single hit. */
const STRONG_KEYWORDS: Record<PhaseKey, string[]> = {
  requirements: ['user story', 'acceptance criteria', 'backlog', 'scope statement'],
  design: ['data model', 'api contract', 'architecture diagram', 'design decision'],
  implementation: ['implement the', 'notimplementederror', 'traceback'],
  testing: ['mutant', 'mutation testing', 'assertraises', 'test suite', 'unit test'],
  deployment: ['dockerfile', 'docker image', 'runbook', 'ci pipeline', 'github actions', 'deploy'],
  maintenance: ['change request', 'regression', 'reopen', 'maintainability', 'bug fix', 'backward compatible'],
};

/**
 * Detect a question clearly aimed at a different phase. Conservative: only a
 * strong keyword unique to another phase, with none matching the current one,
 * triggers a redirect.
 */
export function detectOffPhase(message: string, current: PhaseKey): PhaseKey | null {
  const lower = message.toLowerCase();
  const currentHit = STRONG_KEYWORDS[current].some((k) => lower.includes(k));
  if (currentHit) return null;
  for (const [phase, keywords] of Object.entries(STRONG_KEYWORDS) as [PhaseKey, string[]][]) {
    if (phase === current) continue;
    if (keywords.some((k) => lower.includes(k))) return phase;
  }
  return null;
}

/**
 * The markdown a reply may wrap a line in without changing what the line is:
 * a list marker, a blockquote, a heading. The solution written one line per
 * bullet is still the solution, so both filters read past it.
 */
const MARKDOWN_MARKER = /^\s*(?:[-*+>]\s+|#{1,6}\s+|\d+[.)]\s+)+/;

/** A reply line with its markdown dress removed: markers, then inline code ticks. */
const undressed = (raw: string): string => raw.replace(MARKDOWN_MARKER, '').replace(/`/g, '');

/**
 * The lines worth comparing. `markdown` is true for a reply, whose markers and
 * backticks are dress; it is false for a solution file, where a `#` line is a
 * comment and a leading dash is a dash.
 */
const significantLines = (source: string, markdown = false): Set<string> => {
  const lines = new Set<string>();
  for (const raw of source.split('\n')) {
    const line = (markdown ? undressed(raw) : raw).replace(/#.*$/, '').trim();
    if (line.length >= 12 && !line.startsWith('"""') && !line.startsWith('from ') && !line.startsWith('import ')) {
      lines.add(line.replace(/\s+/g, ' '));
    }
  }
  return lines;
};

/**
 * Solution lines a sentence can carry whole. A line with the punctuation of
 * code in it, a call, an assignment, a colon, is not something English
 * writes by accident, so a reply that says "then you write `return
 * _to_task(record)` on the next line" has reproduced it. A bare `return tasks`
 * is English as well as Python and is only ever matched as a whole line.
 */
const carriable = (line: string): boolean => line.length >= 16 && /[()[\]{}=:]/.test(line);

/**
 * Lines a reader would call code rather than prose. Deliberately
 * case-sensitive: a model writing English starts a sentence with a capital,
 * so `Return to the task panel` is prose and `return task` is not.
 */
const CODE_SYNTAX: RegExp[] = [
  /^\s*(?:async\s+)?def\s+\w+\s*\(/,
  /^\s*class\s+\w+\s*[({:]/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/,
  /^\s*(?:const|let|var)\s+\w+\s*=/,
  /^\s*(?:import|from)\s+[\w.{*]/,
  /^\s*(?:return|raise|yield|throw|assert|await|print)\s+\S/,
  // an assignment, but not a comparison: `total = 0` yes, `a == b` no
  /^\s*[\w.'"[\]]+\s*(?:\*\*|[-+*/%|&^])?=[^=]\s*\S/,
  /^\s*(?:if|elif|else|for|while|try|except|finally|with|switch|case)\b[^.!?]*[:{]\s*$/,
  /^\s*[)\]}]+[;,]?\s*$/,
  /^\s*@\w+\s*[(\s]?/,
];

function isCodeShaped(raw: string): boolean {
  const line = raw.replace(/\s+$/, '');
  if (!line.trim()) return false;
  // A heading is prose whatever follows the hashes.
  if (/^\s*#{1,6}\s/.test(line)) return false;
  if (MARKDOWN_MARKER.test(line)) {
    // A nested list item is indented too, and markdown structure is not code,
    // but what the marker carries can be. `- total = 0` and `1. \`def load():\``
    // are code lines wearing a bullet, so the remainder is judged on
    // its syntax alone; the indent rule does not apply to it.
    return CODE_SYNTAX.some((p) => p.test(undressed(line)));
  }
  if (/^(?: {4,}|\t)\S/.test(line)) return true;
  return CODE_SYNTAX.some((p) => p.test(line));
}

/**
 * The longest run of code-shaped lines in the text. A single blank line does
 * not end a run, a function body with a blank line in the middle is still one
 * block of code, but it does not count towards its length either.
 */
function longestCodeRun(text: string): number {
  let longest = 0;
  let run = 0;
  let blanks = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      blanks += 1;
      if (blanks > 1) run = 0;
      continue;
    }
    if (isCodeShaped(line)) {
      run += 1;
      blanks = 0;
      if (run > longest) longest = run;
    } else {
      run = 0;
      blanks = 0;
    }
  }
  return longest;
}

interface RedactionResult {
  content: string;
  redacted: boolean;
}

const FENCED_BLOCK = /```[\w-]*\n([\s\S]*?)```/g;

const WITHHELD_BLOCK_NOTICE = '# … full code withheld — this part is yours to write.';

/**
 * What the learner gets when the reply as a whole was the answer. The fenced
 * rule can keep the first two lines of a block because the block has an
 * outline; an unfenced reply has no such seam, so the whole thing goes.
 */
export const WITHHELD_REPLY_NOTICE =
  'I was writing this out for you rather than with you, so I have withheld it — the code is yours to write. ' +
  'Describe the first line you would try and I will react to that. What has to happen before anything else?';

/**
 * What a withheld *explanation* says.
 *
 * `WITHHELD_REPLY_NOTICE` answers a learner who asked for the answer, and it
 * says so: "I was writing this out for you rather than with you." The explain
 * button writes its own question, the learner asked why a test is red, not
 * for the fix, so that sentence arrives as an accusation about something they
 * never did. This one names the same rule without the accusation, and says
 * what to do next rather than what not to ask for.
 */
export const EXPLAIN_WITHHELD_NOTICE =
  'I could not put this failure into words without writing the fix, so I have not. ' +
  'Read the assertion on the test above, open the file it names, and say what you expected that line to do — ' +
  'I will react to that. This one did not count as a question.';

/**
 * Output filter: replace long code blocks and any block that reproduces the
 * reference solution with a withheld notice. The learner receives the idea,
 * not the answer.
 *
 * Two passes, because a fenced-block regex alone is no defence: a model that
 * answers in plain prose or indents its code the markdown way walks straight
 * past it. The first pass judges each fence, the second
 * judges everything outside them by the same two rules, how much of the
 * reference solution it reproduces, and how much of it is code at all.
 *
 * Both rules read past markdown. A list marker, a blockquote or a pair of
 * backticks does not exempt a line from either, otherwise the solution
 * written one line per bullet would reach the learner whole, and a solution
 * line wrapped in a sentence is matched by containment rather than by
 * whole-line equality.
 */
export function redactSolutions(reply: string, solutionSources: string[]): RedactionResult {
  const solutionSet = new Set<string>();
  for (const src of solutionSources) {
    for (const line of significantLines(src)) solutionSet.add(line);
  }

  // The solution lines a sentence can carry whole, for the containment test.
  const carried = [...solutionSet].filter(carriable);

  const overlap = (text: string): number => {
    let matches = 0;
    for (const line of significantLines(text, true)) {
      if (solutionSet.has(line) || carried.some((sol) => line.includes(sol))) matches += 1;
    }
    return matches;
  };

  // Pass 1 · the fenced blocks. The combined count is the reason a solution
  // split across two short blocks is not a way through either.
  const fencedOverlap = [...reply.matchAll(FENCED_BLOCK)].reduce(
    (sum, match) => sum + overlap(match[1]),
    0,
  );

  let redacted = false;
  const content = reply.replace(FENCED_BLOCK, (block, body: string) => {
    const lines = body.split('\n').filter((l: string) => l.trim().length > 0);
    if (overlap(body) >= 2 || fencedOverlap >= 2 || lines.length > MAX_CODE_BLOCK_LINES) {
      redacted = true;
      // Two lines of an outline, and never the whole block: a one-line block
      // flagged by the combined count would otherwise survive its own redaction.
      const keep = lines.slice(0, Math.min(2, Math.max(0, lines.length - 1)));
      return ['```', ...keep, WITHHELD_BLOCK_NOTICE, '```'].join('\n');
    }
    return block;
  });

  // Pass 2 · everything the fences did not cover.
  const outside = content.replace(FENCED_BLOCK, '\n');
  if (overlap(outside) >= 2 || longestCodeRun(outside) > MAX_CODE_BLOCK_LINES) {
    return { content: WITHHELD_REPLY_NOTICE, redacted: true };
  }

  return { content, redacted };
}

/**
 * Output filter for prose artefacts (tuned against a live model): a
 * reply that contains a FILLED user story, real content, no <placeholders>
 * together with criteria structure is the finished artefact, not a hint,
 * and gets withheld. Placeholder templates ("As a <persona>, …") and
 * abstract Given/When/Then form examples pass; both signals must fire.
 */
export function redactArtifactLikeReply(reply: string): RedactionResult {
  const filledStory = /\bas an? (?!<)[^<\n]{2,60}?, i want (?!<)[^<\n]{8,}/i.test(reply);
  const gwtTriples = (reply.match(/\bgiven\b[^<]{0,220}?\bwhen\b[^<]{0,220}?\bthen\b/gis) || [])
    .length;
  const artifactHeaders = (
    reply.match(/(\*\*|##)\s*(user stor(y|ies)|acceptance criteria|scope note|us-\d)/gi) || []
  ).length;

  const isArtifact =
    (filledStory && (gwtTriples >= 1 || artifactHeaders >= 2)) || // story + criteria
    gwtTriples >= 2 || // two or more concrete criteria written out
    (artifactHeaders >= 2 && gwtTriples >= 1); // structured artefact with a concrete criterion
  if (!isArtifact) {
    return { content: reply, redacted: false };
  }
  return {
    redacted: true,
    content:
      `I drafted more of this than I should have — a finished artefact from me teaches you nothing, so I've withheld it. ` +
      `The shape you need is already in the task panel; write your version and I'll gladly critique it line by line. ` +
      `Which part feels hardest to start?`,
  };
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const field = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Some ICU builds report midnight as hour 24 under hour12: false.
  const wallClock = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );
  // The instant's own milliseconds are not in the formatted parts, so drop
  // them from both sides rather than letting them show up as an offset.
  return wallClock - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Local midnight in `timeZone`, as the absolute instant it happened. */
export function usageDayStart(
  now: Date = new Date(),
  timeZone: string = usageTimeZone(),
): Date {
  const offset = zoneOffsetMs(now, timeZone);
  const local = new Date(now.getTime() + offset);
  const midnightWallClock = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  // Re-read the offset at the candidate instant: on a DST morning the offset
  // at midnight is not the offset now, and the wrong one would put day start
  // an hour inside yesterday.
  const candidate = midnightWallClock - offset;
  const settled = zoneOffsetMs(new Date(candidate), timeZone);
  return new Date(settled === offset ? candidate : midnightWallClock - settled);
}

export function offPhaseReply(target: PhaseKey, currentTitle: string): string {
  const names: Record<PhaseKey, string> = {
    requirements: 'Requirements',
    design: 'Design',
    implementation: 'Implementation',
    testing: 'Testing',
    deployment: 'Deployment',
    maintenance: 'Maintenance',
  };
  return `That question belongs to the **${names[target]}** phase, and the mentor there will pick it up when you arrive — each phase earns the next. Right now you're in **${currentTitle}**, so let's keep the focus here. What part of the current task can I help you think through?`;
}

export function solutionRequestPreamble(): string {
  return `I won't hand over the answer — the whole point of this phase is that the decision stays yours. What I can do is shrink the next step:`;
}
