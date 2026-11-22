import { EMPTY_RUNBOOK, RUNBOOK_CAPS, RUNBOOK_JSON, incidentIsEmpty, serialiseRunbook, validateRunbookRecord, type Runbook } from '@learnsdlc/shared';
import { collapse } from '../record-markdown/markdown-lines';
import { runbookFromMarkdown } from './runbook-markdown';
import { TASKTRACKR_RUNBOOK_TEMPLATE } from './tasktrackr-runbook-template';

/**
 * The one-time conversion of a learner's Deployment workspace from
 * `RUNBOOK.md` to the runbook record, the helper of migration
 * `1790300000000-S3-DeploymentAndMaintenanceRecords.ts` and of the boot's
 * re-pin, in a folder of its own so TypeORM never loads it as a migration.
 * Pure. The rule: a learner's words are kept or the row is refused and
 * returned exactly as it came.
 *
 * Applied migrations import this module, and so do runtime services (the
 * boot's re-pin and the draft conversion). A change made here for the runtime
 * would also change what an applied migration does on a fresh database, so a
 * conversion that must behave differently belongs in a new migration and a
 * new helper, never in an edit to this one.
 */

/** The S3 runbook migration's receipt, under which the boot pass adds the drafts it converted (`DraftConversionService`). */
export const RUNBOOK_MIGRATION_RECEIPT_KEY = 'runbook-migration.receipt';
/** The older Deployment's learner-written runbook, the one file a workspace is read from when no version names its own. */
export const LEGACY_RUNBOOK_FILE = 'RUNBOOK.md';
export type RecordConversionOutcome = 'kept-record' | 'converted' | 'seeded' | 'untouched' | 'refused';
export interface RecordConversion { workspace: Record<string, string>; outcome: RecordConversionOutcome; reason?: string; notesKept?: boolean; incidentCopied?: boolean }
/**
 * What a version names in its phase: its learner-written markdown (task
 * targets and editable mounts, a mount's text as its template), its read-only
 * markdown mounts, and `starting`, the version's starting record when it
 * mounts one.
 */
export interface LegacyRecordSources { written: { path: string; template?: string }[]; readOnly: string[]; starting?: string }
/** The runbook migration's receipt, in the design migration's shape; the change migration's is the same with no `incidentsCopied`. */
export interface RecordMigrationReceipt {
  at: string;
  counts: Record<RecordConversionOutcome | 'skipped', number>;
  converted: { stateId: string; reason: string }[];
  refused: { stateId: string; reason: string }[];
  skipped: { stateId: string; reason: string }[];
  notesKept: number;
  incidentsCopied?: number;
  drafts?: { at: string; converted: string[]; refused: { versionId: string; reason: string }[] };
  runs: { at: string; counts: Record<string, number> }[];
}

const isMarkdown = (path: unknown): path is string => typeof path === 'string' && /\.(md|markdown)$/i.test(path);
const COMMENTS = /<!--[\s\S]*?-->/g;

type SnapshotLike = {
  content?: { phases?: { key?: unknown; files?: { path?: unknown; content?: unknown; editable?: unknown }[] }[] };
  phases?: { key?: unknown; tasks?: { artefactPath?: unknown; owns?: unknown }[] }[];
};

/**
 * A version's phase read for its learner-written and read-only markdown and
 * its starting record (`record`, the record's path); null when the snapshot
 * cannot be read or has no such phase. The runbook and the change request
 * read their phases through it.
 */
export function legacyRecordSourcesOf(compiled: unknown, phaseKey: string, record: string): LegacyRecordSources | null {
  let snapshot: SnapshotLike | null;
  try {
    snapshot = (typeof compiled === 'string' ? JSON.parse(compiled) : compiled) as SnapshotLike | null;
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== 'object') return null;
  const phase = Array.isArray(snapshot.content?.phases) ? snapshot.content.phases.find((one) => one?.key === phaseKey) : undefined;
  if (!phase) return null;
  const written = new Map<string, { path: string; template?: string }>();
  const tasks = (Array.isArray(snapshot.phases) ? snapshot.phases : []).find((one) => one?.key === phaseKey)?.tasks;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const path of [task?.artefactPath, ...(Array.isArray(task?.owns) ? task.owns : [])]) if (isMarkdown(path) && !written.has(path)) written.set(path, { path });
  }
  const readOnly: string[] = [];
  let starting: string | undefined;
  for (const file of Array.isArray(phase.files) ? phase.files : []) {
    if (file?.path === record && typeof file.content === 'string') starting = file.content;
    if (!isMarkdown(file?.path)) continue;
    if (file.editable === true) written.set(file.path, { path: file.path, ...(typeof file.content === 'string' ? { template: file.content } : {}) });
    else if (!written.has(file.path)) readOnly.push(file.path);
  }
  return { written: [...written.values()], readOnly, ...(starting !== undefined ? { starting } : {}) };
}

/** The pinned version's Deployment read for its learner-written and read-only markdown, and its starting record. */
export function legacyRunbookSourcesOf(compiled: unknown): LegacyRecordSources | null {
  return legacyRecordSourcesOf(compiled, 'deployment', RUNBOOK_JSON);
}

/**
 * The learner-written files a conversion reads: the version's, or, when it
 * names none (no version to read, or a version that grades the record and so
 * mounts no markdown), `file`, unless the version mounts `file` read-only:
 * then it is the version's, never the learner's, and nothing is read (the
 * same guard as design-records.ts).
 */
export function writtenOrDefault(written: LegacyRecordSources['written'] | undefined, file: string, readOnly?: readonly string[]): LegacyRecordSources['written'] {
  return written?.length ? written : readOnly?.includes(file) ? [] : [{ path: file }];
}

/**
 * The template a learner-written file is read against: its
 * mount's text; else, for the default file only, `override` or TaskTrackr
 * 4.0.0's frozen one; else the empty template, every word the learner's.
 */
export function templateFor(file: { path: string; template?: string }, defaultFile: string, override: string | undefined, frozen: string): string {
  return file.template ?? (file.path === defaultFile ? override ?? frozen : '');
}

/** A drill's incident: three fields of text. */
export type DrillIncident = { rootCause: string; fix: string; actionItem: string };

/**
 * The incident a stored drill holds, normalised: the drill as the column's
 * text (the migration reads it raw) or already parsed (the entity reads it
 * through `simple-json`); null when it holds none or is not readable, and a
 * field that is not text reads as empty. A malformed incident is never handed
 * to the conversion, which reads the three fields as text.
 */
export function drillIncidentOf(drill: unknown): DrillIncident | null {
  let parsed: unknown = drill;
  if (typeof drill === 'string') {
    try {
      parsed = JSON.parse(drill) as unknown;
    } catch {
      return null;
    }
  }
  const incident = parsed && typeof parsed === 'object' ? (parsed as { incident?: unknown }).incident : null;
  if (!incident || typeof incident !== 'object' || Array.isArray(incident)) return null;
  const fields = incident as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return { rootCause: text(fields.rootCause), fix: text(fields.fix), actionItem: text(fields.actionItem) };
}

export const refusedConversion = (workspace: Record<string, string>, reason: string): RecordConversion => ({ workspace, outcome: 'refused', reason });

/** `text` with the comments `template` holds verbatim (whitespace collapsed) taken out, and every other comment kept as its words. */
function ownWords(text: string, template: string | undefined): string {
  const theirs = new Set((template?.match(COMMENTS) ?? []).map(collapse));
  return text.replace(COMMENTS, (comment) => (theirs.has(collapse(comment)) ? '' : comment.slice(4, -3).trim())).trim();
}

/** Whether `text`'s words equal `template`'s, whitespace collapsed and the template's own comments aside (the rule design-records.ts applies): it holds no word of the learner's. */
function equalsTemplate(text: string, template: string): boolean {
  return collapse(ownWords(text, template)) === collapse(ownWords(template, template));
}

/**
 * Every other learner-written file's words, for notes under a header naming
 * the file: a comment of the learner's is kept, the template's comments are
 * not, and a file whose words equal its template's, whitespace collapsed, is
 * untouched and adds nothing (the rule design-records.ts applies).
 */
export function otherWrittenWords(workspace: Record<string, string>, written: LegacyRecordSources['written'], main: string | undefined): { path: string; words: string }[] {
  return written
    .filter((f) => f.path !== main && workspace[f.path] !== undefined)
    .map((f) => ({ path: f.path, template: f.template, words: ownWords(workspace[f.path], f.template) }))
    .filter((f) => f.words.length > 0 && (f.template === undefined || !equalsTemplate(workspace[f.path], f.template)))
    .map(({ path, words }) => ({ path, words }));
}

/**
 * The learner-written files a version names in this workspace whose text
 * equals the version's own template for them (its mount's text, by
 * `equalsTemplate`), in the version's order. A file with no mount text, one
 * that is not text, and one holding any word of the learner's are never
 * listed. The re-pin drops these when it moves a learner whose conversion
 * left the workspace untouched, so no later run reads the file again under a
 * template that is not its version's.
 */
export function templateOnlyFiles(workspace: Record<string, string>, sources: Partial<LegacyRecordSources> | null, defaultFile: string): string[] {
  return writtenOrDefault(sources?.written, defaultFile, sources?.readOnly)
    .filter((f) => f.template !== undefined && typeof workspace[f.path] === 'string' && equalsTemplate(workspace[f.path], f.template))
    .map((f) => f.path);
}

/** The parsed lists of an older file, as notes under the file's section names, for a workspace whose record is kept. */
function listsAsNotes(runbook: Runbook, file: string, drillIncident: boolean): string[] {
  const groups: [string, string[]][] = [
    ['Environment', runbook.environment.map((one) => [one.name, one.purpose].filter(Boolean).join(': '))],
    ['Health', runbook.health.map((one) => one.how)],
    ['Rollback', runbook.rollback.map((one) => one.step)],
    ['Data', runbook.data.map((one) => one.what)],
    // a drill's incident filled the parse's incident, and the learner's lines are already in its notes
    ['Incident', drillIncident ? [] : ([['Root cause', runbook.incident.rootCause], ['Fix', runbook.incident.fix], ['Action item', runbook.incident.actionItem]] as const)
      .filter(([, text]) => text).map(([label, text]) => `${label}: ${text}`)],
  ];
  return groups.filter(([, lines]) => lines.length).map(([header, lines]) => `Kept from ${file}, ${header}:\n${lines.join('\n')}`);
}

/**
 * One Deployment workspace, converted. `converted` reads the learner's
 * `RUNBOOK.md` (the template's own lines dropped) into a new record;
 * `kept-record` keeps a valid record already there, the older file's words
 * going to its notes and never over its lists, and its own incident (the
 * drill's fills only an empty one); `seeded` is the one exception
 * to "nothing the learner wrote is untouched": a drill holding an incident
 * writes the head's starting record (`headStarting`) with that incident
 * where no record was.
 * `untouched` leaves the workspace exactly as it came. Every other
 * learner-written markdown file the version names is kept in notes under its
 * own header; the learner-written and read-only markdown files go.
 */
export function convertRunbookWorkspace(
  workspace: Record<string, string>,
  options: Partial<LegacyRecordSources> & { template?: string; drillIncident?: DrillIncident | null; headStarting?: string } = {},
): RecordConversion {
  const written = writtenOrDefault(options.written, LEGACY_RUNBOOK_FILE, options.readOnly);
  const removed = new Set([...written.map((f) => f.path), ...(options.readOnly ?? [])]);
  const held = [...removed].filter((path) => workspace[path] !== undefined);
  for (const path of held) if (typeof workspace[path] !== 'string') return refusedConversion(workspace, `${path} is not text, so it was not changed`);
  const recordText = workspace[RUNBOOK_JSON];
  const record = recordText === undefined ? null : validateRunbookRecord(recordText).runbook;
  if (recordText !== undefined && !record) return refusedConversion(workspace, 'the runbook record could not be read, so it was not changed');
  // The drill's incident is read first: a workspace with no RUNBOOK.md and no record, whose drill holds an incident, is
  // still seeded; once it holds a record, a second run leaves it untouched.
  const incident = options.drillIncident && [options.drillIncident.rootCause, options.drillIncident.fix, options.drillIncident.actionItem].some((t) => t.trim()) ? options.drillIncident : null;
  if (!held.length && (!incident || record)) return { workspace, outcome: 'untouched' };
  const main = written.find((f) => f.path === LEGACY_RUNBOOK_FILE) ?? written[0];
  const parse = main && workspace[main.path] !== undefined
    ? runbookFromMarkdown(workspace[main.path], { file: main.path, template: templateFor(main, LEGACY_RUNBOOK_FILE, options.template, TASKTRACKR_RUNBOOK_TEMPLATE), drillIncident: incident })
    : null;
  const others = otherWrittenWords(workspace, written, main?.path);
  const learner = (parse?.learnerLines ?? 0) > 0 || others.length > 0;
  const next: Record<string, string> = Object.fromEntries(Object.entries(workspace).filter(([path]) => !removed.has(path)));
  // Spec 5.2: once a record holds the incident, it is the record's; the drill's stored one only fills a missing record or an empty incident.
  const copied = !!incident && (!record || incidentIsEmpty(record.incident));
  if (!learner) {
    // untouched means untouched: the older file stays and the version's starting record serves the room
    if (!incident) return { workspace, outcome: 'untouched' };
    if (record) {
      // a record already there is kept; the files that held nothing of the learner's go
      if (copied) next[RUNBOOK_JSON] = serialiseRunbook({ ...record, incident: { ...incident } });
      return {
        workspace: next,
        outcome: 'kept-record',
        reason: `${held.join(', ')} held nothing of the learner's and ${held.length === 1 ? 'was' : 'were'} removed, and the record was kept${copied ? ' with the drill\'s incident' : ''}`,
        ...(copied ? { incidentCopied: true } : {}),
      };
    }
    // the one exception: a drill holding an incident seeds the head's starting record with it
    const base = validateRunbookRecord(options.headStarting ?? '').runbook ?? EMPTY_RUNBOOK;
    next[RUNBOOK_JSON] = serialiseRunbook({ ...base, incident: { ...incident } });
    return { workspace: next, outcome: 'seeded', incidentCopied: true };
  }
  // A kept record's lists are the learner's newer work: the older file's list items go to notes, never over them.
  const listed = record && parse ? listsAsNotes(parse.runbook, main.path, !!incident) : [];
  const notes = [record?.notes ?? '', ...(parse?.notes ?? []), ...listed, ...others.map((f) => `Kept from ${f.path}:\n${f.words}`)].filter((t) => t.trim()).join('\n\n');
  const paths = [...(parse ? [main.path] : []), ...others.map((f) => f.path)];
  if (notes.length > RUNBOOK_CAPS.fieldChars) return refusedConversion(workspace, `the words in ${paths.join(', ')} would not fit in the runbook record, so it was not changed`);
  const base: Runbook = record ?? parse?.runbook ?? EMPTY_RUNBOOK;
  const converted: Runbook = { ...base, ...(copied && incident ? { incident: { ...incident } } : {}) };
  const checked = validateRunbookRecord(serialiseRunbook({ ...converted, ...(notes ? { notes } : {}) }));
  if (!checked.runbook) return refusedConversion(workspace, `the converted record failed the validator (${checked.error}), so it was not changed`);
  next[RUNBOOK_JSON] = serialiseRunbook(checked.runbook);
  const moved = parse && !record ? (['environment', 'health', 'rollback', 'data'] as const).map((list) => `${list} ${parse.runbook[list].length}`).join(', ') : 'notes only';
  return {
    workspace: next,
    outcome: record ? 'kept-record' : 'converted',
    reason: `${paths.join(', ')} moved into the record (${moved}${parse?.notes.length ? `, ${parse.notes.length} group(s) in notes` : ''})`,
    ...(notes ? { notesKept: true } : {}),
    ...(copied ? { incidentCopied: true } : {}),
  };
}
