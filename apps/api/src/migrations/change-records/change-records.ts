import {
  CHANGE_CAPS, CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, validateChangeRequestRecord, type ChangeRequest,
} from '@learnsdlc/shared';
import { changeFromChangelog } from './changelog-markdown';
import { TASKTRACKR_CHANGELOG_TEMPLATE } from './tasktrackr-changelog-template';
import {
  legacyRecordSourcesOf, otherWrittenWords, refusedConversion, templateFor, writtenOrDefault, type LegacyRecordSources, type RecordConversion,
} from '../runbook-records/runbook-records';

/**
 * The one-time conversion of a learner's Maintenance workspace from
 * `CHANGELOG.md` to the change request record, the runbook's frame for
 * Maintenance: the helper of migration
 * `1790300000000-S3-DeploymentAndMaintenanceRecords.ts` and of the boot's
 * re-pin, in a folder of its own so TypeORM never loads it as a migration.
 * Pure. The rule: a learner's words are kept or the row is refused and
 * returned exactly as it came. There is no `seeded` outcome: the drill is
 * Deployment's.
 *
 * Applied migrations import this module, and so do runtime services (the
 * boot's re-pin and the draft conversion). A change made here for the runtime
 * would also change what an applied migration does on a fresh database, so a
 * conversion that must behave differently belongs in a new migration and a
 * new helper, never in an edit to this one.
 */

/** The S3 change migration's receipt, under which the boot pass adds the drafts it converted (`DraftConversionService`). */
export const CHANGE_MIGRATION_RECEIPT_KEY = 'change-migration.receipt';
/** The older Maintenance's learner-written changelog, the one file a workspace is read from when no version names its own. */
export const LEGACY_CHANGELOG_FILE = 'CHANGELOG.md';

/** The pinned version's Maintenance read for its learner-written and read-only markdown, and its starting change request. */
export function legacyChangeSourcesOf(compiled: unknown): LegacyRecordSources | null {
  return legacyRecordSourcesOf(compiled, 'maintenance', CHANGE_REQUEST_JSON);
}

/**
 * One Maintenance workspace, converted. `converted` builds on the version's
 * starting record (`starting`, else the empty one) with the learner's newest
 * entry as its release: the change lines, and the version and summary only
 * when the parse found them; `kept-record` keeps a valid record already there
 * and its release as it is, the older file's release lines going to its notes
 * under "Kept from CHANGELOG.md, Release <version>:". Everything else the
 * learner wrote outside the newest entry is in notes. `untouched` leaves the
 * workspace exactly as it came.
 */
export function convertChangeWorkspace(
  workspace: Record<string, string>,
  options: Partial<LegacyRecordSources> & { template?: string; acceptanceIds?: readonly string[] } = {},
): RecordConversion {
  const written = writtenOrDefault(options.written, LEGACY_CHANGELOG_FILE, options.readOnly);
  const removed = new Set([...written.map((f) => f.path), ...(options.readOnly ?? [])]);
  const held = [...removed].filter((path) => workspace[path] !== undefined);
  for (const path of held) if (typeof workspace[path] !== 'string') return refusedConversion(workspace, `${path} is not text, so it was not changed`);
  const ids = options.acceptanceIds ?? null;
  const recordText = workspace[CHANGE_REQUEST_JSON];
  const record = recordText === undefined ? null : validateChangeRequestRecord(recordText, ids).change;
  if (recordText !== undefined && !record) return refusedConversion(workspace, 'the change request record could not be read, so it was not changed');
  if (!held.length) return { workspace, outcome: 'untouched' };
  const main = written.find((f) => f.path === LEGACY_CHANGELOG_FILE) ?? written[0];
  const parse = main && workspace[main.path] !== undefined
    ? changeFromChangelog(workspace[main.path], { file: main.path, template: templateFor(main, LEGACY_CHANGELOG_FILE, options.template, TASKTRACKR_CHANGELOG_TEMPLATE) })
    : null;
  const others = otherWrittenWords(workspace, written, main?.path);
  const fromFile = !!main && !!parse && parse.learnerLines > 0;
  // untouched means untouched: the older file stays and the version's starting record serves the room
  if (!fromFile && !others.length) return { workspace, outcome: 'untouched' };
  const release = fromFile ? parse.change.release : null;
  // A kept record's release is the learner's newer work: the older file's release lines go to notes, never over it.
  const listed = record && release && (release.summary || release.changes.length)
    ? [`Kept from ${main.path}, Release ${release.version}:\n${[release.summary, ...release.changes.map((one) => one.line)].filter(Boolean).join('\n')}`]
    : [];
  const notes = [record?.notes ?? '', ...(fromFile ? parse.notes : []), ...listed, ...others.map((f) => `Kept from ${f.path}:\n${f.words}`)].filter((t) => t.trim()).join('\n\n');
  const paths = [...(fromFile ? [main.path] : []), ...others.map((f) => f.path)];
  if (notes.length > CHANGE_CAPS.fieldChars) return refusedConversion(workspace, `the words in ${paths.join(', ')} would not fit in the change request record, so it was not changed`);
  const base: ChangeRequest = record ?? (options.starting !== undefined ? validateChangeRequestRecord(options.starting, ids).change : null) ?? EMPTY_CHANGE_REQUEST;
  const converted: ChangeRequest = record || !release
    ? base
    : {
        ...base,
        release: {
          ...base.release,
          ...(release.version ? { version: release.version } : {}),
          ...(release.summary ? { summary: release.summary } : {}),
          ...(release.changes.length ? { changes: release.changes } : {}),
        },
      };
  const checked = validateChangeRequestRecord(serialiseChangeRequest({ ...converted, ...(notes ? { notes } : {}) }), ids);
  if (!checked.change) return refusedConversion(workspace, `the converted record failed the validator (${checked.error}), so it was not changed`);
  const next: Record<string, string> = Object.fromEntries(Object.entries(workspace).filter(([path]) => !removed.has(path)));
  next[CHANGE_REQUEST_JSON] = serialiseChangeRequest(checked.change);
  const moved = release && !record ? `release lines ${release.changes.length}` : 'notes only';
  return {
    workspace: next,
    outcome: record ? 'kept-record' : 'converted',
    reason: `${paths.join(', ')} moved into the record (${moved}${fromFile && parse.notes.length ? `, ${parse.notes.length} group(s) in notes` : ''})`,
    ...(notes ? { notesKept: true } : {}),
  };
}
