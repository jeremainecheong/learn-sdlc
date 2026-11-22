import type { PhaseRubric } from '@learnsdlc/shared';
import type { ContentFileSpec, PhaseChecks } from './content.types';

/**
 * What the two older-shape phase conversions share (`runbook-legacy.ts`,
 * `change-legacy.ts`): the phase as they read it, what they answer,
 * the one markdown mount swapped for the record it seeds, and the note's one
 * closing stop.
 */

/**
 * An older Deployment or Maintenance phase as its conversion reads it: the
 * mounts with their bytes, the task's checks and rubric, the words the
 * Maintenance ticket is built from, and the criteria whose wording the teacher
 * wrote (`teacherWordedKeys`; none when absent).
 */
export interface LegacyPhaseInput { files: ContentFileSpec[]; checks: PhaseChecks; rubric?: PhaseRubric; title: string; intro: string; taskPanel: string; objectives: string[]; teacherWorded?: ReadonlySet<string> }
/** The converted phase: its mounts (the markdown file replaced by the record), checks, rubric and one sentence saying what moved. */
export interface LegacyPhaseOutput<C> { files: ContentFileSpec[]; checks: C; rubric: PhaseRubric | undefined; note: string }

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/**
 * The phase's mounts with its one markdown file (`markdown`, editable or not)
 * replaced by the starting record its words become (`read`, which answers the
 * serialised record; `valid` holds it to the record's caps). Throws one fixed
 * sentence for any other markdown mount, and one when the file's words would
 * not fit the record (its notes past their cap): never a cut. `from` names
 * the file the record was read from, null when the phase mounted none.
 */
export function markdownToRecord(
  files: readonly ContentFileSpec[],
  spec: { phase: 'Deployment' | 'Maintenance'; markdown: string; record: string; recordName: string; read: (text: string) => string; valid: (record: string) => boolean },
): { files: ContentFileSpec[]; from: string | null } {
  const stray = files.find((f) => isMarkdown(f.path) && f.path !== spec.markdown);
  if (stray) throw new Error(`A ${spec.phase} phase mounts no markdown file: ${stray.path}.`);
  const markdown = files.find((f) => f.path === spec.markdown);
  const kept = files.filter((f) => f.path !== spec.markdown);
  if (!markdown) return { files: kept, from: null };
  const record = spec.read(markdown.content);
  if (!spec.valid(record)) throw new Error(`The words in ${spec.markdown} would not fit in the ${spec.recordName}.`);
  return { files: [...kept, { path: spec.record, content: record, editable: true, language: 'json' }], from: markdown.path };
}

/** A parse's notes as the record's `notes` member: the groups a blank line apart, absent when there are none. */
export const notesMember = (notes: readonly string[]): { notes?: string } => (notes.length ? { notes: notes.join('\n\n') } : {});

/** The conversion's note: what moved, a semicolon apart, with one closing stop even where the last part ends with its own. */
export const conversionNote = (head: string, moved: readonly string[]) => `${head}: ${moved.join('; ')}`.replace(/[.]+$/, '') + '.';
