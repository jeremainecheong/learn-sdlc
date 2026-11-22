import {
  API_CONTRACT_JSON,
  DEFAULT_DESIGN_FLOOR,
  DEFAULT_DESIGN_SEQUENCE,
  DESIGN_JSON,
  EMPTY_DESIGN,
  SCREEN_CONTRACT_JSON,
  foldLegacyDesign,
  isLegacyDesignShape,
  serialiseDesign,
  validateDesignRecord,
  type PhaseRubric,
} from '@learnsdlc/shared';
import { validateDesignChecks } from './content.service';
import type { ContentFileSpec, DesignChecks } from './content.types';
import type { OlderWrittenChecks } from './older-written';
import { count, foldRuleSentences, leftOutNote, ruleLabel } from './rule-sentences';

const isMarkdown = (path: string) => /\.md$/i.test(path);

/**
 * The starting record of a markdown Design, as the design kind keeps it.
 * Validated first: a record can be valid and still carry a key of the board's
 * older shape (the validator would drop it unread), so it is folded only when
 * it is invalid or older in shape. A valid record whose fold the validator
 * then refuses is kept as it validates (its older keys dropped, the note says
 * so), never emptied. One that neither reading accepts starts empty, and the
 * note says why.
 */
function startingRecord(text: string): { content: string; note: string | null } {
  const valid = validateDesignRecord(text);
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (valid.design && !isLegacyDesignShape(parsed)) return { content: serialiseDesign(valid.design), note: null };
  const folded = foldLegacyDesign(parsed);
  const refolded = folded ? validateDesignRecord(serialiseDesign(folded.design)) : null;
  if (folded && refolded?.design) {
    return {
      content: serialiseDesign(refolded.design),
      note: folded.folded.length ? `the board's record was folded (${folded.folded.join('; ')})` : null,
    };
  }
  if (valid.design) {
    return {
      content: serialiseDesign(valid.design),
      note: `the board's older keys could not be folded (${refolded?.error ?? 'not a record'}), so the record was kept as it validates`,
    };
  }
  return {
    content: serialiseDesign(EMPTY_DESIGN),
    note: `the starting record could not be read (${valid.error}), so it starts empty`,
  };
}

/**
 * Reads a Design phase written before the design kind (markdown targets,
 * regex rules, a mounted backlog and architecture document) into design
 * checks with the default floor. Pure; the result is held to
 * `validateDesignChecks`, so a converted phase is one the loader accepts.
 *
 * Every markdown file is dropped; the record is kept, folded or replaced by
 * the empty one (`startingRecord`); a contract is switched on exactly when
 * the phase mounts it, and each kept contract is editable JSON, as the record
 * is (a design task grades what the learner writes, so a read-only contract
 * would be a bar nobody could clear); the sequence diagram is off (a markdown
 * Design never graded one); stories start empty.
 *
 * Each rule's label becomes a sentence of the description of the criterion it
 * scored (key, title and weight kept), whole sentences only, up to the
 * editor's cap (`RUBRIC_CRITERION_DESCRIPTION_MAX`), and a sentence that does
 * not fit is named in the note. A criterion whose wording the teacher wrote
 * (`teacherWorded`, the keys `teacherWordedKeys` finds) keeps that wording in
 * front, and its sentences follow it within the same cap. No converted
 * description is longer than the cap: a longer one (the teacher's wording
 * may be up to `CRITERION_DESCRIPTION_MAX`) is cut at its last sentence end
 * within it (`cutDescription`), its rule sentences are left out, and the
 * note names the cut. A
 * criterion no rule scored keeps its own description, and that includes one
 * only the word floor scored: a design has no word floor, so the floor is
 * dropped rather than written as a sentence nobody is held to. `note` says
 * all of it in one line.
 */
export function designChecksFromLegacyMarkdown(
  files: ContentFileSpec[],
  rawChecks: unknown,
  rubric: PhaseRubric | undefined,
  teacherWorded: ReadonlySet<string> = new Set(),
): { checks: DesignChecks; files: ContentFileSpec[]; rubric: PhaseRubric | undefined; note: string } {
  const raw = (rawChecks ?? {}) as Partial<Pick<OlderWrittenChecks, 'rules' | 'minWords' | 'minWordsCriterion'>>;
  // a rule that is not an object says nothing a sentence could carry
  const rules = Array.isArray(raw.rules) ? raw.rules.filter((rule) => !!rule && typeof rule === 'object') : [];
  const notes: string[] = [];
  const dropped = files.filter((f) => isMarkdown(f.path)).length;
  const kept: ContentFileSpec[] = [];
  for (const f of files) {
    if (isMarkdown(f.path)) continue;
    // a kept contract is graded and the learner writes it, as the record is,
    // so a read-only mount becomes editable JSON; any other file stays as mounted
    if (f.path === API_CONTRACT_JSON || f.path === SCREEN_CONTRACT_JSON) {
      kept.push({ ...f, editable: true, language: 'json' });
      continue;
    }
    if (f.path !== DESIGN_JSON) {
      kept.push(f);
      continue;
    }
    const record = startingRecord(f.content);
    kept.push({ ...f, content: record.content, editable: true, language: 'json' });
    if (record.note) notes.push(record.note);
  }
  const contracts = { api: kept.some((f) => f.path === API_CONTRACT_JSON), screens: kept.some((f) => f.path === SCREEN_CONTRACT_JSON) };

  const folded = foldRuleSentences(rubric, rules, teacherWorded);
  notes.push(...folded.notes);
  if (raw.minWords !== undefined || raw.minWordsCriterion) {
    const floor = raw.minWords !== undefined ? `the ${raw.minWords}-word floor` : 'the word floor';
    // a criterion some rule's label became a sentence of is not one only the floor scored
    const labelled = new Set(rules.filter((rule) => ruleLabel(rule)).map((rule) => rule.criterion));
    const only = rubric?.criteria.find((c) => c.key === raw.minWordsCriterion && !labelled.has(c.key));
    notes.push(`${floor} dropped (a design has no word floor)${only ? `, so "${only.title}", which only it scored, keeps its own description` : ''}`);
  }
  const left = leftOutNote(folded.left);
  if (left) notes.push(left);

  const checks = validateDesignChecks(
    { kind: 'design', contracts, sequence: DEFAULT_DESIGN_SEQUENCE, stories: [], floor: DEFAULT_DESIGN_FLOOR },
    'design',
  );
  const note =
    `Design converted from markdown: ${count(rules.length, 'rule became a criterion sentence', 'rules became criterion sentences')}, ` +
    `the API contract ${contracts.api ? 'on' : 'off'}, the screen contract ${contracts.screens ? 'on' : 'off'}, the sequence diagram off, ` +
    'the default floor, no stories listed yet (add them, or copy them from Requirements, in the builder); ' +
    // one closing stop, even where the last note (the left-out sentences) ends with its own
    `${count(dropped, 'markdown file', 'markdown files')} dropped${notes.length ? `; ${notes.join('; ')}` : ''}`.replace(/[.]+$/, '') + '.';
  return { checks, files: kept, rubric: folded.rubric, note };
}
