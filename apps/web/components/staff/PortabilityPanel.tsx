'use client';

/**
 * Move this class to another machine.
 *
 * A class travels as one JSON file. The half of this panel that matters is the
 * dry run: an import cannot be undone, so before anything is written the
 * instructor is shown every learner in the file, what would happen to each of
 * them, and what would be skipped and why.
 *
 * Submitted file snapshots are optional because they can be large. Private
 * mentor conversations are always excluded from instructor exports.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CohortExportDocument,
  CohortExportInclude,
  CohortImportLearnerOutcome,
  CohortImportResult,
} from '@learnsdlc/shared';
import { COHORT_IMPORT_MAX_BYTES, pluralWord } from '@learnsdlc/shared';
import { ApiError, describeError } from '@/lib/api';
import { cohortsApi, formatJoinCode, type Cohort } from '@/lib/api-cohorts';
import { saveBlob } from '@/lib/api-instructor';
import { describeBytes, portabilityApi, readExportFile } from '@/lib/api-portability';
import { Button, Chip, Detail, Divider, EmptyState, Notice, Section } from '@/components/ui';
import { usePresentationView } from '@/components/experience/presentation-view';

const PURPOSE =
  'A class travels as one file: the roster, submitted work and recorded verdicts. Private mentor ' +
  'conversations are excluded. Import the file on another local installation to copy the class.';

/** The outcome word, as a chip, so a list of twenty is scannable. */
function OutcomeChip({ outcome }: { outcome: CohortImportLearnerOutcome['outcome'] }) {
  if (outcome === 'created') return <Chip tone="accent">A new account</Chip>;
  if (outcome === 'matched') return <Chip tone="pass">Already here</Chip>;
  return <Chip tone="warn">Skipped</Chip>;
}

export function PortabilityPanel({ preferCohortId }: { preferCohortId?: string | null }) {
  // While the screen is shared: no address and no join code is drawn.
  const [presenting] = usePresentationView();
  const [cohorts, setCohorts] = useState<Cohort[] | null>(null);
  const [cohortId, setCohortId] = useState('');
  const [includes, setIncludes] = useState<Record<CohortExportInclude, boolean>>({
    snapshots: false,
    messages: false,
  });
  const [exporting, setExporting] = useState(false);
  const [tooBig, setTooBig] = useState('');
  const [maxImportBytes, setMaxImportBytes] = useState(COHORT_IMPORT_MAX_BYTES);

  // Named `incoming` rather than `document`: a state variable called document
  // shadows the global one for the whole component.
  const [incoming, setIncoming] = useState<CohortExportDocument | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<CohortImportResult | null>(null);
  const [result, setResult] = useState<CohortImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const [needsForce, setNeedsForce] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadCohorts = useCallback(() => {
    cohortsApi
      .mine()
      .then((list) => {
        if (!alive.current) return;
        setCohorts(list);
        const wanted = list.find((c) => c.id === preferCohortId) ?? list[list.length - 1];
        if (wanted) setCohortId((current) => current || wanted.id);
      })
      .catch((err) => {
        if (!alive.current) return;
        setCohorts([]);
        setError(describeError(err, 'Your classes could not be loaded. Try again in a moment.'));
      });
  }, [preferCohortId]);

  useEffect(loadCohorts, [loadCohorts]);

  const chosen = cohorts?.find((cohort) => cohort.id === cohortId) ?? null;

  const runExport = async () => {
    if (!chosen) return;
    setExporting(true);
    setError('');
    setTooBig('');
    try {
      const asked = (Object.keys(includes) as CohortExportInclude[]).filter((key) => includes[key]);
      const file = await portabilityApi.exportCohort(chosen.id, chosen.name, asked);
      setMaxImportBytes(file.maxImportBytes);
      saveBlob(file.blob, file.filename);
      if (file.blob.size > file.maxImportBytes) {
        setTooBig(
          `This file is ${describeBytes(file.blob.size)}, larger than the ${describeBytes(
            file.maxImportBytes,
          )} an import accepts. Export it without the revision files to move it; the verdicts and ` +
            'the scores are all still in it.',
        );
      }
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The export failed. Try again in a moment.'));
    } finally {
      if (alive.current) setExporting(false);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    setPreview(null);
    setResult(null);
    setNeedsForce(false);
    setError('');
    setIncoming(null);
    setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > maxImportBytes) {
      setError(
        `That file is ${describeBytes(file.size)}. An import accepts up to ${describeBytes(
          maxImportBytes,
        )}. Export the class without the revision files.`,
      );
      return;
    }
    const read = await readExportFile(file);
    if (!alive.current) return;
    if ('error' in read) setError(read.error);
    else setIncoming(read.document);
  };

  const run = async (mode: 'preview' | 'import', force = false) => {
    if (!incoming) return;
    setBusy(mode);
    setError('');
    try {
      const answer = await portabilityApi.importCohort(incoming, {
        dryRun: mode === 'preview',
        force,
      });
      if (!alive.current) return;
      if (mode === 'preview') {
        setPreview(answer);
        setNeedsForce(Boolean(answer.alreadyImportedAt));
      } else {
        setResult(answer);
        setPreview(null);
        setNeedsForce(false);
        loadCohorts();
      }
    } catch (err) {
      if (!alive.current) return;
      // 409 is not a failure, it is a question: this file has been imported
      // here before, and importing it again makes a second copy.
      if (err instanceof ApiError && err.status === 409) setNeedsForce(true);
      setError(describeError(err, 'The import failed and nothing was changed.'));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const outcomes = preview?.learners ?? [];
  const noClasses = cohorts !== null && cohorts.length === 0;

  return (
    <Section title="Move this class to another machine" purpose={PURPOSE} testId="portability-panel">
      {error && (
        <Notice tone="fail" role="alert" testId="portability-error">
          {error}
        </Notice>
      )}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        {/* Take one out. */}
        <div className="flex min-w-0 flex-col gap-3">
          {noClasses ? (
            <EmptyState
              icon="class"
              title="You have no classes yet"
              body="Make one in the card above, or import one."
              testId="portability-no-class"
            />
          ) : (
            <>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="label">Class</span>
                <select
                  className="field h-[34px] py-0 text-[13px]"
                  value={cohortId}
                  onChange={(e) => setCohortId(e.target.value)}
                  data-testid="export-cohort-select"
                >
                  {(cohorts ?? []).map((cohort) => (
                    <option key={cohort.id} value={cohort.id}>
                      {cohort.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-start gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={includes.snapshots}
                  onChange={(e) => setIncludes((was) => ({ ...was, snapshots: e.target.checked }))}
                  data-testid="export-include-snapshots"
                />
                <span className="wrap">
                  Include the files behind every revision
                  <span className="label-sm block">Larger, usually not needed.</span>
                </span>
              </label>
              <p className="label-sm">Private mentor conversations are excluded from class exports.</p>

              <div>
                <Button
                  icon="download"
                  onClick={runExport}
                  busy={exporting}
                  busyLabel="Writing the file"
                  disabled={!chosen}
                  testId="export-cohort"
                  // The class's own name rides in the label; on a phone it
                  // wraps inside the button instead of past the panel's edge.
                  className="max-w-full !whitespace-normal"
                >
                  Export {chosen ? chosen.name : 'this class'}
                </Button>
              </div>
              {tooBig && (
                <Notice tone="warn" testId="export-too-big">
                  {tooBig}
                </Notice>
              )}
            </>
          )}
        </div>

        {/* Bring one in. */}
        <div className="flex min-w-0 flex-col gap-3">
          <Divider className="lg:hidden" />
          <p className="text-[13.5px] font-semibold text-ink">Bring a class in</p>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="label">Class export</span>
            <input
              type="file"
              accept="application/json,.json"
              className="field h-auto py-1.5 text-[13px]"
              onChange={(e) => void chooseFile(e.target.files?.[0])}
              data-testid="import-file"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => void run('preview')}
              busy={busy === 'preview'}
              busyLabel="Reading the file"
              disabled={!incoming || busy !== null}
              testId="import-preview"
            >
              Check what this would do
            </Button>
            <Button
              icon="upload"
              onClick={() => void run('import')}
              busy={busy === 'import'}
              busyLabel="Importing"
              disabled={!incoming || busy !== null}
              testId="import-run"
            >
              Import
            </Button>
            {needsForce && (
              <Button
                variant="danger"
                onClick={() => void run('import', true)}
                busy={busy === 'import'}
                disabled={!incoming || busy !== null}
                testId="import-force"
              >
                Import anyway
              </Button>
            )}
          </div>
          {fileName && !incoming && !error && (
            <p className="label-sm" data-testid="import-file-name">
              Reading {fileName}
            </p>
          )}
        </div>
      </div>

      {/* The dry run, and then the result. A live region: a screen reader hears
          the answer without the focus moving off the button that asked. */}
      <div role="status" className="flex min-w-0 flex-col gap-3">
        {preview && (
          <div className="flex min-w-0 flex-col gap-3" data-testid="import-preview-list">
            <Notice tone="info" icon="info">
              This file holds {preview.source.name}
              {preview.source.host ? ` from ${preview.source.host}` : ''}. It would make a new class
              here with a fresh join code. Nothing already on this machine is changed.
            </Notice>
            {preview.alreadyImportedAt && (
              <Notice tone="warn" testId="import-already">
                This file has been imported here before. Importing it again makes a second copy of
                the class.
              </Notice>
            )}
            <p className="text-[13.5px] font-semibold text-ink">
              {outcomes.length} {pluralWord(outcomes.length, 'learner')}
            </p>
            <ul className="m-0 flex list-none flex-col p-0">
              {outcomes.map((row) => (
                <li
                  key={row.email}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t-1.5 border-edge py-2 first:border-t-0"
                >
                  <span className="text-[13.5px] font-semibold text-ink wrap">{row.displayName}</span>
                  {!presenting && <span className="label-sm">{row.email}</span>}
                  <OutcomeChip outcome={row.outcome} />
                  {row.note && <span className="w-full text-[12.5px] text-ink2 wrap">{row.note}</span>}
                  {row.outcome === 'created' && (
                    <span className="w-full text-[12.5px] text-ink2 wrap">
                      A new account. They will need to set a password with “Forgot your password?”.
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <div className="min-w-0 overflow-x-auto">
              <div className="flex min-w-[620px] gap-4" data-testid="import-written">
                <Detail label="Enrolments">{preview.written.enrollments}</Detail>
                <Detail label="Phases">{preview.written.phaseStates}</Detail>
                {/* The task rows, in the order the data model writes them: after
                    the phase they belong to, before the revisions. `taskStates`
                    is optional on the wire because a version-2 file carries no
                    task rows, and a blank cell would read as a question rather
                    than as the answer none. */}
                <Detail label="Tasks">{preview.written.taskStates ?? 0}</Detail>
                <Detail label="Revisions">{preview.written.submissions}</Detail>
                <Detail label="Mentor messages">{preview.written.messages}</Detail>
                <Detail label="Releases">{preview.written.releases}</Detail>
              </div>
            </div>
            <p className="purpose">
              Not in this file: passwords, and the trail from the other machine, which stays in the
              file rather than becoming rows here
              {preview.includes.includes('snapshots') ? '' : ', and the files behind every revision'}
              {preview.includes.includes('messages') ? '' : ', and what the learners typed to the mentor'}
              .
            </p>
          </div>
        )}

        {result?.cohort && (
          <div className="flex min-w-0 flex-col gap-2" data-testid="import-result">
            <Notice tone="pass">
              {result.cohort.name} was imported. {result.cohort.memberCount} learner
              {result.cohort.memberCount === 1 ? ' is' : 's are'} in it;{' '}
              {result.createdAccounts.length === 0
                ? 'no new account was needed'
                : result.createdAccounts.length === 1
                  ? '1 account was created and needs a password'
                  : `${result.createdAccounts.length} accounts were created and need a password`}
              . The join code is{' '}
              {presenting ? 'on the class page' : <span className="mono">{formatJoinCode(result.cohort.joinCode)}</span>}.
            </Notice>
            {result.createdAccounts.length > 0 && !presenting && (
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="import-created-accounts">
                {result.createdAccounts.map((email) => (
                  <li key={email} className="mono text-[12.5px] text-ink2">
                    {email}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
