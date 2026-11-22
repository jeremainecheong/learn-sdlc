import {
  DESIGN_CAPS,
  DESIGN_JSON,
  EMPTY_DESIGN,
  foldLegacyDesign,
  isLegacyDesignShape,
  serialiseDesign,
  validateDesignRecord,
  type Design,
} from '@learnsdlc/shared';
import { TASKTRACKR_DESIGN_TEMPLATE } from './tasktrackr-design-template';

/**
 * The one-time conversion of a learner's Design workspace from the older
 * design page and board record to the design record. The migration's own
 * helper (`1790200000000-S2-DesignRecordsFromMarkdown.ts`), in a folder of its
 * own so TypeORM never loads it as a migration. Pure; nothing is dropped in
 * silence: a row it cannot convert comes back exactly as it was, with the reason.
 *
 * Applied migrations import this module, and so do runtime services (the
 * boot's re-pin and the draft conversion). A change made here for the runtime
 * would also change what an applied migration does on a fresh database, so a
 * conversion that must behave differently belongs in a new migration and a
 * new helper, never in an edit to this one.
 */
export const DESIGN_MIGRATION_RECEIPT_KEY = 'design-migration.receipt';
/**
 * The files TaskTrackr's older Design mounted: the design page, the
 * architecture document and the provided stories. With no version to read,
 * the design page is the learner's and the other two are read-only mounts.
 */
export const LEGACY_DESIGN_FILES = ['design/my-design.md', 'design/architecture.md', 'requirements/provided-stories.md'] as const;
export const NOTES_HEADER = 'Kept from the design page, outside the board:';
/** The header over any other learner-written file's words in notes: it names the file. */
export const notesHeaderFor = (path: string) => (path === LEGACY_DESIGN_FILES[0] ? NOTES_HEADER : `Kept from ${path}:`);
/**
 * Paths a written Design task was given when no version can be read
 * (`design/my-design-<key>.md` for a design document
 * before the stem moved, `docs/design-<key>.md` since, `docs/design/<key>.md`
 * for a document): still the learner's own words.
 */
const MINTED_WRITTEN = [/^design\/my-design-[^/]+\.md$/, /^docs\/design-[^/]+\.md$/, /^docs\/design\/[^/]+\.md$/];
const isMarkdown = (path: unknown): path is string => typeof path === 'string' && /\.(md|markdown)$/i.test(path);
/** The reason a folded state carries when the fold moved nothing elsewhere (a lowercase tradeoff, no title): the receipt still lists it. */
export const FOLDED_WHOLE = "the board's older record was read into the schema field for field";
const MD = LEGACY_DESIGN_FILES[0];
/** Frozen from the room's board writer: the region it owned in the design page, markers included. */
const REGION = /<!--\s*learnsdlc:design-board:start\s*-->[\s\S]*?<!--\s*learnsdlc:design-board:end\s*-->/g;
const COMMENTS = /<!--[\s\S]*?-->/g;
const UNREADABLE = 'the design record could not be read, so it was not changed';
const NOTES_FULL = 'the text outside the board in the design page would not fit in notes, so it was not changed';
const notesFull = (paths: string[]) =>
  paths.length === 1 && paths[0] === LEGACY_DESIGN_FILES[0] ? NOTES_FULL : `the words in ${paths.join(', ')} would not fit in notes, so it was not changed`;
const PAGE_NOT_TEXT = 'the design page is not text, so it was not changed';
const notText = (path: string) => (path === LEGACY_DESIGN_FILES[0] ? PAGE_NOT_TEXT : `${path} is not text, so it was not changed`);
/** The migration never cuts a learner's words: a fold that would is refused, naming its own cuts. */
const wouldCut = (cut: string[]) => `the board's older record would lose words in the fold (${cut.join('; ')}), so it was not changed`;
const notConverted = (error: string) => `the design record could not be converted (${error}), so it was not changed`;

export type DesignConversionOutcome = 'kept-record' | 'folded' | 'seeded' | 'untouched' | 'refused';
/** `reason` is set for a refused state (why it was left as it was) and for a folded one (what moved), so the receipt lists both by state id. */
export interface DesignConversion { workspace: Record<string, string>; outcome: DesignConversionOutcome; reason?: string; notesKept?: boolean }
/** The migration's receipt, in the story migration's shape (`story-migration.receipt`, story-records.ts), for Design. */
export interface DesignMigrationReceipt {
  at: string;
  /** Every converted state counted by its outcome, and every skipped one. */
  counts: Record<DesignConversionOutcome | 'skipped', number>;
  /** Each folded state, with what moved. */
  folded: { stateId: string; reason: string }[];
  /** Each refused state, with why it was left as it was. */
  refused: { stateId: string; reason: string }[];
  /** Each state whose version does not grade the design kind, with its sentence. */
  skipped: { stateId: string; reason: string }[];
  /** States whose design page words were kept in notes. */
  notesKept: number;
  /** Every run, the ones that converted nothing included: its time and its counts. */
  runs: { at: string; counts: Record<DesignConversionOutcome | 'skipped', number> }[];
}

/**
 * Where a version's older Design put the learner's words and its own: the
 * markdown its Design tasks write (their targets) and the markdown it mounted
 * editable are the learner's (`template` is the mount's own text, so an
 * untouched copy keeps nothing); the markdown it mounted read-only is the
 * version's, and is removed.
 */
export interface LegacyDesignSources {
  written: { path: string; template?: string }[];
  readOnly: string[];
}

type SnapshotLike = {
  content?: { phases?: { key?: unknown; files?: { path?: unknown; content?: unknown; editable?: unknown }[] }[] };
  phases?: { key?: unknown; tasks?: { artefactPath?: unknown; owns?: unknown }[] }[];
};

/**
 * The pinned version's Design read for `LegacyDesignSources`, from its
 * compiled snapshot (the object, or the text a migration reads); null when it
 * holds no markdown at all (a design-kind version), so the conversion falls
 * back to the older defaults.
 */
export function legacyDesignSourcesOf(compiled: unknown): LegacyDesignSources | null {
  let snapshot: SnapshotLike | null = null;
  try {
    snapshot = (typeof compiled === 'string' ? JSON.parse(compiled) : compiled) as SnapshotLike | null;
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== 'object') return null;
  const phase = Array.isArray(snapshot.content?.phases) ? snapshot.content.phases.find((one) => one?.key === 'design') : undefined;
  const tasks = (Array.isArray(snapshot.phases) ? snapshot.phases : []).find((one) => one?.key === 'design')?.tasks;
  const written = new Map<string, { path: string; template?: string }>();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const path of [task?.artefactPath, ...(Array.isArray(task?.owns) ? task.owns : [])]) if (isMarkdown(path) && !written.has(path)) written.set(path, { path });
  }
  const readOnly: string[] = [];
  for (const file of Array.isArray(phase?.files) ? phase.files : []) {
    if (!isMarkdown(file?.path)) continue;
    if (file.editable === true) written.set(file.path, { path: file.path, ...(typeof file.content === 'string' ? { template: file.content } : {}) });
    else if (!written.has(file.path)) readOnly.push(file.path);
  }
  return written.size || readOnly.length ? { written: [...written.values()], readOnly } : null;
}

/**
 * The design page's own words: every HTML comment gone, trimmed, and the
 * board's region gone too when the record it was drawn from is kept (with no
 * record, the region is the only copy of the board, so its text stays).
 */
const pageWords = (text: string, withRegion: boolean) => (withRegion ? text : text.replace(REGION, '')).replace(COMMENTS, '').trim();
/** The same, with every run of whitespace one space, to compare with the template. */
const normal = (text: string, withRegion: boolean) => pageWords(text, withRegion).replace(/\s+/g, ' ');

/**
 * One workspace, converted. The record is validated first and folded only
 * when it is invalid or carries the board's older keys (the shared reader's
 * rule, `readDesignRecord`): `kept-record` keeps a valid record, `folded`
 * reads the board's older one through `foldLegacyDesign` and says what moved,
 * `seeded` starts the empty record where there was none. `untouched` is a
 * workspace with none of the older files and a record (if any) already in the
 * schema. Every learner-written file's own words (`writtenFiles`: the
 * pinned version's task targets and editable mounts when `options` carries
 * them, `legacyDesignSourcesOf`; the design page and the paths a written task
 * mints otherwise), comments stripped and the board's region too unless there
 * is no record (it is then the board's only copy), go to `notes` under a
 * header naming the file (`NOTES_HEADER` for the design page), unless they
 * are the file's template. A row is `refused` and returned as it came when
 * its record cannot be read, its fold would cut anything (the notes cap or a
 * board limit: the migration never cuts a learner's words), its fold or its
 * notes fail the validator, or a learner-written file is not text. A
 * converted workspace loses its learner-written files (their words are in
 * notes), the read-only mounts the version names, and TaskTrackr's two older
 * read-only documents.
 */
export function convertDesignWorkspace(
  workspace: Record<string, string>,
  options: { templateMarkdown?: string } & Partial<LegacyDesignSources> = {},
): DesignConversion {
  const written = writtenFiles(workspace, options);
  const removed = new Set([...written.map((file) => file.path), ...LEGACY_DESIGN_FILES, ...(options.readOnly ?? [])]);
  const older = [...removed].some((path) => workspace[path] !== undefined);
  for (const { path } of written) if (workspace[path] !== undefined && typeof workspace[path] !== 'string') return { workspace, outcome: 'refused', reason: notText(path) };
  const recordText = workspace[DESIGN_JSON];
  let design: Design;
  let outcome: DesignConversionOutcome;
  let moved: string[] = [];
  if (recordText === undefined) {
    if (!older) return { workspace, outcome: 'untouched' };
    design = EMPTY_DESIGN;
    outcome = 'seeded';
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(recordText);
    } catch {
      return { workspace, outcome: 'refused', reason: UNREADABLE };
    }
    const valid = validateDesignRecord(recordText);
    if (valid.design && !isLegacyDesignShape(parsed)) {
      if (!older) return { workspace, outcome: 'untouched' };
      design = valid.design;
      outcome = 'kept-record';
    } else {
      const fold = foldLegacyDesign(parsed);
      if (!fold) return { workspace, outcome: 'refused', reason: UNREADABLE };
      if (fold.cut.length) return { workspace, outcome: 'refused', reason: wouldCut(fold.cut) };
      const checked = validateDesignRecord(serialiseDesign(fold.design));
      if (!checked.design) return { workspace, outcome: 'refused', reason: notConverted(checked.error) };
      design = checked.design;
      moved = fold.folded;
      outcome = 'folded';
    }
  }

  const withRegion = recordText === undefined;
  const kept: string[] = [];
  const keptFrom: string[] = [];
  for (const { path, template } of written) {
    const markdown = workspace[path];
    if (markdown === undefined) continue;
    const words = pageWords(markdown, withRegion);
    if (words && (template === undefined || normal(markdown, withRegion) !== normal(template, withRegion))) {
      kept.push(`${notesHeaderFor(path)}\n${words}`);
      keptFrom.push(path);
    }
  }
  let notesKept = false;
  if (kept.length) {
    const notes = [design.notes ?? '', ...kept].filter((part) => part.trim()).join('\n\n');
    if (notes.length > DESIGN_CAPS.fieldChars) return { workspace, outcome: 'refused', reason: notesFull(keptFrom) };
    design = { ...design, notes };
    notesKept = true;
  }
  const checked = validateDesignRecord(serialiseDesign(design));
  if (!checked.design) return { workspace, outcome: 'refused', reason: notConverted(checked.error) };

  const next: Record<string, string> = {};
  for (const [path, text] of Object.entries(workspace)) if (!removed.has(path)) next[path] = text;
  next[DESIGN_JSON] = serialiseDesign(checked.design);
  const reason = outcome === 'folded' ? { reason: moved.length ? moved.join('; ') : FOLDED_WHOLE } : {};
  return { workspace: next, outcome, ...reason, ...(notesKept ? { notesKept } : {}) };
}

/**
 * The learner-written files, the design page first: the pinned version's own
 * list when it was read, then the design page and any path a written task
 * mints (`MINTED_WRITTEN`) that the workspace holds and the version did not
 * name read-only. The design page's template is the version's (or
 * TaskTrackr's when none was read); any other file's is its mount's text.
 */
function writtenFiles(workspace: Record<string, string>, options: { templateMarkdown?: string } & Partial<LegacyDesignSources>) {
  const readOnly = new Set(options.readOnly ?? []);
  const files = new Map<string, { path: string; template?: string }>();
  for (const file of options.written ?? []) files.set(file.path, file);
  for (const path of Object.keys(workspace).sort()) {
    if (!files.has(path) && !readOnly.has(path) && (path === MD || MINTED_WRITTEN.some((shape) => shape.test(path)))) files.set(path, { path });
  }
  const page = files.get(MD);
  if (page) files.set(MD, { path: MD, template: options.templateMarkdown ?? page.template ?? TASKTRACKR_DESIGN_TEMPLATE });
  return [...files.values()].sort((a, b) => Number(b.path === MD) - Number(a.path === MD));
}
