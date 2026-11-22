'use client';

/**
 * The Upload project door on /teacher/projects.
 *
 * A teacher's own project arrives as a `.zip` in the authoring layout and
 * becomes a **draft** they own: never published by the upload, never shared.
 * The door makes four promises, and the API keeps each one too, this page is
 * the near half of each guarantee, never the whole of it.
 *
 * **The size is shown against the cap before anything is sent.** An archive
 * over the cap is refused here, by the contract's own sentence
 * (`UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE`), and the request is never made.
 *
 * **A refusal is the contract's sentence, verbatim.** The API answers a
 * refused upload with `{ code, sentence, findings }`; this page prints
 * `UPLOAD_REFUSALS[code]` and, per finding, `RUN_SHAPE_REFUSALS[code]`, the
 * same words, taken from the contract rather than from the wire, so a server
 * that one day echoed an entry name could still not put it on the page. The
 * one exception is `NOT_A_PACK`'s `detail`, the loader's text, capped at
 * `UPLOAD_REFUSAL_DETAIL_MAX` and drawn as plain text beneath the fixed
 * sentence. `RUNTIME_OUTSIDE_PROFILE`'s `detail` is drawn the same way: the
 * door's sentence naming the package the profile does not bake.
 *
 * **Nothing of the archive is rendered.** Not its bytes (they go straight from
 * the file to the request body), not its name (the browser's own file control
 * shows that), and not a finding's `where` unless it is shaped like a manifest
 * key.
 *
 * **The draft opens on success**, at the editor's address, where the profile
 * line, the fast report and the executable editor are.
 */
import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ProjectUploadRefusal,
  RunShapeRefusalCode,
  RuntimeProfileView,
  UploadRefusalCode,
} from '@learnsdlc/shared';
import {
  COHORT_IMPORT_MAX_BYTES,
  PHASE_ORDER,
  PROJECT_TITLE_MAX,
  RUN_SHAPE_REFUSALS,
  UPLOAD_REFUSALS,
  UPLOAD_REFUSAL_DETAIL_MAX,
  UPLOAD_WHERE_NAMES,
} from '@learnsdlc/shared';
import { Field } from '@/components/Field';
import { Button, Notice, Section } from '@/components/ui';
import { ApiError, describeError } from '@/lib/api';
import { projectsApi } from '@/lib/api-projects';
import { ReservedRuntimeProfileLine, useRuntimeProfileRead } from '@/components/staff/projects/RuntimeProfileLine';
import { fileToBase64, formatBytes } from '@/components/staff/projects/upload-bytes';
import type { ProjectUploadResultWithWarnings } from '@learnsdlc/shared';
import { UPLOAD_WARNINGS_SENTENCE } from '@learnsdlc/shared';
import { RefusalExplainer, refusalCodeOfSentence } from '@/components/staff/guide/RefusalExplainer';

/**
 * The archive cap when the runtime profile names none: the class import's
 * default, which is also the deployment's import cap unless it was configured.
 */
const UPLOAD_ARCHIVE_CAP_BYTES = COHORT_IMPORT_MAX_BYTES;

/**
 * The archive cap a teacher is told, and an archive over it is refused
 * before it is sent. It is the deployment's configured cap
 * (`RuntimeProfileView.uploadMaxBytes`, the API's `IMPORT_MAX_BYTES`) when the
 * profile read answered one, and the class-import default otherwise.
 */
function uploadArchiveCapBytes(profile: Pick<RuntimeProfileView, 'uploadMaxBytes'> | null | undefined): number {
  const configured = profile?.uploadMaxBytes;
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : UPLOAD_ARCHIVE_CAP_BYTES;
}

/** Where the editor for a draft lives (`draftHref` in ProjectsLibrary, kept local to avoid a cycle). */
function editorHref(projectId: string, versionId: string): string {
  return `/teacher/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`;
}

/**
 * Whether the focus is still inside `box`, or nowhere (the body, or nothing).
 * A focus move the person did not just cause (a network answer) is made only
 * when this holds. ProjectsLibrary guards the upload's door the same way.
 */
function focusStillWith(box: Element | null): boolean {
  const at = document.activeElement;
  return !at || at === document.body || Boolean(box?.contains(at));
}

/** What the page prints for a refusal: the contract's sentences, nothing else. */
interface ShownUploadRefusal {
  sentence: string;
  findings: { sentence: string; where: string | null }[];
  /**
   * `NOT_A_PACK`'s `detail`, the loader's cleaned-up text, at most
   * `UPLOAD_REFUSAL_DETAIL_MAX` characters, and
   * `RUNTIME_OUTSIDE_PROFILE`'s, the sentence naming the package. Drawn as
   * plain text under the fixed sentence; absent for every other code.
   */
  detail?: string;
}

/** The codes whose `detail` the door prints (the runtime refusal names its package). */
const DETAIL_CODES: ReadonlySet<unknown> = new Set(['NOT_A_PACK', 'RUNTIME_OUTSIDE_PROFILE']);

/**
 * The one piece of server text the door prints: the `detail` of `NOT_A_PACK`
 * or `RUNTIME_OUTSIDE_PROFILE`, as a string, cut to `UPLOAD_REFUSAL_DETAIL_MAX`
 * here too. It is drawn as a text node, so markup in it stays the characters
 * it is. Any other code's detail is dropped.
 */
export function uploadRefusalDetail(code: unknown, detail: unknown): string | undefined {
  if (!DETAIL_CODES.has(code) || typeof detail !== 'string') return undefined;
  const cut = detail.slice(0, UPLOAD_REFUSAL_DETAIL_MAX).trim();
  return cut.length > 0 ? cut : undefined;
}

const own = (table: object, key: unknown): key is string =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/** What a `where` prints in place of a key name the contract does not hold. The API's own fallback reads the same. */
export const WHERE_UNNAMED_KEY = '(a key)';

/**
 * A finding's `where`, only when it is shaped like a manifest key and its
 * indexes (`checks.smoke.commands[0]`). Anything else is dropped, because a
 * where that is not a key could only have come from the archive. A name
 * outside the shared `UPLOAD_WHERE_NAMES` (the set the API prints from too)
 * is a key the archive chose, so it prints as `WHERE_UNNAMED_KEY` and never
 * as itself.
 */
export function safeWhere(where: unknown): string | null {
  if (typeof where !== 'string' || where.length === 0 || where.length > 120) return null;
  // A name (or the API's own fallback), then names after dots and brackets; a
  // bracket holds an index, a phase's position (`#2`) or one of the six phase keys.
  const name = '([A-Za-z][A-Za-z0-9_]*|\\(a key\\))';
  const step = new RegExp(`\\.${name}|(\\[(?:\\d{1,4}|#\\d{1,2}|${PHASE_ORDER.join('|')})\\])`, 'y');
  const first = new RegExp(`^${name}`).exec(where);
  if (!first) return null;
  const shown = (one: string) => (UPLOAD_WHERE_NAMES.has(one) ? one : WHERE_UNNAMED_KEY);
  let out = shown(first[1]);
  step.lastIndex = first[0].length;
  while (step.lastIndex < where.length) {
    const next = step.exec(where);
    if (!next) return null;
    out += next[1] !== undefined ? `.${shown(next[1])}` : next[2];
  }
  return out;
}

/** The title refusal this page makes itself, told apart from the API's by identity. */
const CLIENT_TITLE_REFUSAL: ShownUploadRefusal = Object.freeze({ sentence: UPLOAD_REFUSALS.TITLE_INVALID, findings: [] });

/**
 * The contract's refusal for a failed upload, or null when the answer carries
 * no code the contract knows.
 */
export function uploadRefusalOf(err: unknown): ShownUploadRefusal | null {
  const raw = err instanceof ApiError ? (err.body as Record<string, unknown> | undefined) : undefined;
  // The refusal is the body itself, or (where a framework wraps an object
  // response) its `message`.
  const body = (
    raw && typeof raw === 'object' && !own(UPLOAD_REFUSALS, raw.code) && raw.message && typeof raw.message === 'object'
      ? raw.message
      : raw
  ) as Partial<ProjectUploadRefusal> | undefined;
  if (!body || typeof body !== 'object' || !own(UPLOAD_REFUSALS, body.code)) return null;
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const detail = uploadRefusalDetail(body.code, body.detail);
  return {
    sentence: UPLOAD_REFUSALS[body.code as UploadRefusalCode],
    findings: findings.flatMap((finding) =>
      finding && own(RUN_SHAPE_REFUSALS, finding.code)
        ? [{ sentence: RUN_SHAPE_REFUSALS[finding.code as RunShapeRefusalCode], where: safeWhere(finding.where) }]
        : [],
    ),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** What a 429 from the upload door says (its pace, not the archive). */
const UPLOAD_PACE_REFUSAL =
  'Too many uploads in the last minute, so this one was not read and nothing was imported. Wait a minute, then upload the archive again.';

/**
 * A failure with no contract code, said without the server's text: an answer
 * to an upload is the one place a server's words might carry the archive's.
 * Only sentences written before the archive is read pass through: no answer
 * at all, a timeout, a session that ended, a role refused.
 */
export function uploadFailureSentence(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE;
    // No answer in time: the server may still be importing, so a second upload
    // could make a second draft.
    if (err.status === 0) {
      return 'The server did not answer in time, so the upload may still finish. Reload this page and look for the draft in your projects before you upload the archive again.';
    }
    // A session that ended, a role refused before the body is read: neither
    // sentence can hold a byte of the archive.
    if (err.status === 401 || err.status === 403) return err.message;
    // The door's pace (`@RateLimit(5, 60)`), refused before
    // the archive is read, so the sentence never blames the archive.
    if (err.status === 429) return UPLOAD_PACE_REFUSAL;
    // An answer with no code says
    // nothing about the archive, so neither does this sentence; the neutral
    // UPLOAD_REFUSAL_FALLBACK under it says what to try next.
    return 'The upload did not finish, and nothing was imported.';
  }
  return describeError(err, 'The upload could not be sent, and nothing was imported. Try again in a moment.');
}

export function UploadProject({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  /** An upload was accepted and the page stays, so the list can show the new draft. */
  onUploaded?: () => void;
}) {
  const router = useRouter();
  const profileRead = useRuntimeProfileRead(projectsApi.runtimeProfile);
  const profile = profileRead.profile;
  const fileId = useId();
  const sizeId = `${fileId}-size`;
  const formatId = `${fileId}-format`;
  const refusalRef = useRef<HTMLDivElement>(null);

  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [ownError, setOwnError] = useState('');
  const [refusal, setRefusal] = useState<ShownUploadRefusal | null>(null);
  // An accepted upload that changed something on the way in.
  const [changed, setChanged] = useState<ProjectUploadResultWithWarnings | null>(null);

  const cap = uploadArchiveCapBytes(profile);
  const overCap = file !== null && file.size > cap;
  const shown: ShownUploadRefusal | null = overCap
    ? { sentence: UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE, findings: [] }
    : refusal;

  const sizeLine =
    file === null
      ? `No archive chosen yet. The upload limit is ${formatBytes(cap)}.`
      : `${formatBytes(file.size)} of the ${formatBytes(cap)} upload limit.`;

  const blocked = file === null ? 'Choose an archive to upload.' : overCap ? UPLOAD_REFUSALS.ARCHIVE_TOO_LARGE : '';

  // The refusal takes the focus only from the upload form (its own section,
  // the Upload as a draft button included) or from nowhere, judged in the
  // frame the focus would move in. A refusal from the network can land while
  // the teacher types in the copy form beside this one; the caret stays there,
  // and the refusal's role="alert" still announces it.
  const focusRefusal = () => {
    requestAnimationFrame(() => {
      const box = refusalRef.current;
      if (box && focusStillWith(box.closest('[data-testid="projects-upload"]'))) box.focus();
    });
  };

  const submit = async () => {
    const wanted = title.trim();
    setRefusal(null);
    setChanged(null);
    if (!wanted) {
      setOwnError('Give the project a title. The project takes its name from the title, never from the archive.');
      return;
    }
    if (wanted.length > PROJECT_TITLE_MAX) {
      setOwnError('');
      setRefusal(CLIENT_TITLE_REFUSAL);
      focusRefusal();
      return;
    }
    if (!file || overCap) return;
    setOwnError('');
    setBusy(true);
    try {
      const archiveBase64 = await fileToBase64(file);
      const made: ProjectUploadResultWithWarnings = await projectsApi.upload({ title: wanted, archiveBase64 });
      // The warnings are not persisted, so what the upload changed (an older
      // Requirements phase converted to the story kind) is said here, once,
      // before the draft opens.
      if (made.warnings?.length) {
        setChanged(made);
        onUploaded?.();
      } else router.push(editorHref(made.projectId, made.versionId));
    } catch (err) {
      setRefusal(uploadRefusalOf(err) ?? { sentence: uploadFailureSentence(err), findings: [] });
      focusRefusal();
    } finally {
      setBusy(false);
    }
  };

  // The accepted upload replaces the form, so it cannot be sent twice.
  if (changed?.warnings?.length) {
    return (
      <Section title="Upload a project" testId="projects-upload">
        <Notice tone="info" icon="info" role="status" testId="projects-upload-warnings">
          <span className="block font-semibold">{UPLOAD_WARNINGS_SENTENCE}</span>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {changed.warnings.map((line, at) => (
              <li key={at} className="wrap" data-testid={`projects-upload-warning-${at}`}>
                {line}
              </li>
            ))}
          </ul>
        </Notice>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button size="sm" href={editorHref(changed.projectId, changed.versionId)} testId="projects-upload-open-draft">
            Open the draft
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} testId="projects-upload-done">
            Close
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Upload a project"
      purpose="A project of your own, as a zip archive in the authoring layout. It becomes a draft only you can see, and nothing reaches a class until you publish a version and assign it."
      testId="projects-upload"
    >
      <Notice tone="info" icon="info" testId="projects-upload-profile-box">
        {/* The line's place is held from the first frame, so its arrival moves neither Title nor the buttons. */}
        <ReservedRuntimeProfileLine read={profileRead} testId="projects-upload-profile" />
        <span className="mt-1 block text-[12.5px] text-ink2">
          An archive that asks for anything outside this profile is refused, and so is one whose runs ask
          for more time or memory than a learner&rsquo;s run gets.
        </span>
      </Notice>

      {shown && (
        <div ref={refusalRef} tabIndex={-1} role="alert" data-testid="projects-upload-refusal" className="outline-none">
          <Notice tone="fail" role="presentation">
            <span className="block" data-testid="projects-upload-refusal-sentence">
              {shown.sentence}
            </span>
            {shown.detail && (
              // The loader's detail, one text node, never markup.
              <span className="mono mt-1 block wrap text-[12px] text-ink2" data-testid="projects-upload-refusal-detail">
                {shown.detail}
              </span>
            )}
            {shown.findings.length > 0 && (
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                {shown.findings.map((finding, at) => (
                  <li key={at} className="wrap" data-testid={`projects-upload-finding-${at}`}>
                    {finding.sentence}
                    {finding.where && (
                      <>
                        {' Found at '}
                        <span className="mono">{finding.where}</span>
                        {'.'}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        </div>
      )}

      {/* Under the fixed sentence, never inside it. */}
      {shown && <RefusalExplainer code={refusalCodeOfSentence(shown.sentence)} />}
      {ownError && (
        <Notice tone="fail" role="alert" testId="projects-upload-error">
          {ownError}
        </Notice>
      )}

      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" disabled={busy}>
        <legend className="mb-1 p-0 text-[13px] font-semibold text-ink">The project and its archive</legend>
        <Field
          id={`${fileId}-title`}
          label="Title"
          hint="What a class sees. The project's web name is made from it, never from the archive."
          value={title}
          data-testid="projects-upload-title"
          onChange={(e) => {
            setOwnError('');
            // The title this page refused is gone once it changes.
            setRefusal((was) => (was === CLIENT_TITLE_REFUSAL ? null : was));
            setTitle(e.target.value);
          }}
        />
        <div className="min-w-0">
          <label htmlFor={fileId} className="block text-[13px] font-medium text-ink">
            Project archive
          </label>
          <input
            id={fileId}
            type="file"
            accept=".zip,application/zip"
            className="field mt-1.5"
            aria-describedby={`${formatId} ${sizeId}`}
            aria-invalid={overCap || undefined}
            data-testid="projects-upload-file"
            onChange={(e) => {
              setRefusal(null);
              setFile(e.target.files?.[0] ?? null);
            }}
          />
          <p id={formatId} className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            A zip of the authoring layout: one folder per phase, with at most one work task in each of
            Implementation, Testing, Deployment and Maintenance.
          </p>
          <p
            id={sizeId}
            className={`mt-1 text-[12.5px] tabular-nums ${overCap ? 'text-fail' : 'text-ink2'}`}
            data-testid="projects-upload-size"
          >
            {sizeLine}
          </p>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          onClick={() => void submit()}
          busy={busy}
          busyLabel="Uploading…"
          disabled={Boolean(blocked)}
          reason={blocked || undefined}
          testId="projects-upload-submit"
        >
          Upload as a draft
        </Button>
        <Button variant="ghost" onClick={onClose} testId="projects-upload-cancel">
          Cancel
        </Button>
        <span className="label-sm">The draft opens as 0.1.0 when the upload is accepted.</span>
      </div>
      {busy && <div className="skeleton h-1.5 w-full" aria-hidden="true" />}
    </Section>
  );
}
