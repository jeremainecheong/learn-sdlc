'use client';

/**
 * One sealed file's upload.
 *
 * Choose a file, say its path, send it through `sealed.write`. Nothing of the
 * file is drawn (the browser's own control shows its name) and the answer
 * is handed up as a `SealedFileView`'s three members, whatever else it held.
 * The bytes go from the file into the request body and are dropped there.
 */
import { useId, useRef, useState } from 'react';
import type { SealedFileView, SealedFileWriteBody, SealedRoleKind } from '@learnsdlc/shared';
import { Field } from '@/components/Field';
import { Button, Notice } from '@/components/ui';
import { refusalOf } from '@/components/staff/projects/refusal';
import { fileToBase64 } from '@/components/staff/projects/upload-bytes';

/** A sealed list with one file written: the same path replaced, a new one added. */
export function withSealed(files: readonly SealedFileView[], written: SealedFileView): SealedFileView[] {
  const view: SealedFileView = { path: written.path, sha256: written.sha256, bytes: written.bytes };
  const at = files.findIndex((one) => one.path === view.path);
  if (at < 0) return [...files, view];
  return files.map((one, n) => (n === at ? view : one));
}

/**
 * The path a chosen file is first offered. The seal door refuses a
 * hidden test at a one-segment path (the export files it under `tests/` and
 * could not write it back where the loader reads it), so a hidden test is
 * offered the learner's own test file it replaces, by name, or `tests/<name>`.
 * Every other role is offered the bare name.
 */
function offeredPath(role: SealedRoleKind, name: string, learnerFiles: readonly string[] = []): string {
  if (role !== 'hidden' || name.includes('/')) return name;
  if (learnerFiles.includes(name)) return name;
  const same = learnerFiles.find((one) => one.split('/').pop() === name);
  return same ?? `tests/${name}`;
}

/**
 * One sealed file's upload: choose a file, say its path, send it. Nothing of
 * the file is drawn (the browser's own control shows its name) and the
 * answer is handed up as a `SealedFileView`.
 */
export function SealedUpload({
  group,
  role,
  runId,
  label,
  hint,
  defaultPath = '',
  learnerFiles,
  onWrite,
  onWritten,
}: {
  group: string;
  role: SealedRoleKind;
  runId: string | null;
  label: string;
  hint: string;
  defaultPath?: string;
  /** A tests task's learner test files, which its reference suite may replace by name. */
  learnerFiles?: readonly string[];
  onWrite: (body: SealedFileWriteBody) => Promise<SealedFileView>;
  onWritten: (view: SealedFileView) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [file, setFile] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState(defaultPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const blocked = !file ? 'Choose a file first.' : !path.trim() ? 'Say the path it is written at.' : '';

  const send = async () => {
    if (!file || !path.trim()) return;
    setBusy(true);
    setError('');
    setDone('');
    try {
      const contentBase64 = await fileToBase64(file);
      const answer = await onWrite({ role, runId, path: path.trim(), contentBase64 });
      // Only the three members of a view travel on, whatever the answer held.
      const view: SealedFileView = { path: answer.path, sha256: answer.sha256, bytes: answer.bytes };
      onWritten(view);
      setDone(`Sealed ${view.path}. Only its digest and size are shown from now on.`);
      setFile(null);
      // So the same file can be chosen again, and the control holds nothing it sent.
      if (picker.current) picker.current.value = '';
    } catch (err) {
      setError(refusalOf(err, 'The file could not be sealed. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0">
        <label htmlFor={`${id}-file`} className="block text-[13px] font-medium text-ink">
          {label}
        </label>
        <input
          id={`${id}-file`}
          ref={picker}
          type="file"
          className="field mt-1.5"
          aria-describedby={hintId}
          data-testid={`sealed-${group}-file`}
          onChange={(e) => {
            setError('');
            setDone('');
            const chosen = e.target.files?.[0] ?? null;
            setFile(chosen);
            if (chosen && !path.trim()) setPath(offeredPath(role, chosen.name, learnerFiles));
          }}
        />
        <p id={hintId} className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {hint}
        </p>
      </div>
      <Field
        id={`${id}-path`}
        label="Path it is written at"
        hint={
          role !== 'hidden'
            ? "Relative to the task's folder for this role, with forward slashes."
            : learnerFiles
              ? "Relative to the task's folder for this role, with forward slashes. A reference test sits under a folder, such as tests/, unless it is one of the learner's test files."
              : "Relative to the task's folder for this role, with forward slashes. A hidden test sits under a folder, such as tests/."
        }
        value={path}
        data-testid={`sealed-${group}-path`}
        onChange={(e) => setPath(e.target.value)}
      />
      {error && (
        <Notice tone="fail" role="alert" testId={`sealed-${group}-error-box`}>
          <span data-testid={`sealed-${group}-error`}>{error}</span>
        </Notice>
      )}
      {done && (
        <p className="label-sm" role="status" data-testid={`sealed-${group}-done`}>
          {done}
        </p>
      )}
      <div>
        <Button
          size="sm"
          variant="secondary"
          icon="lock"
          busy={busy}
          busyLabel="Sealing…"
          disabled={Boolean(blocked)}
          reason={blocked || undefined}
          testId={`sealed-${group}-upload`}
          onClick={() => void send()}
        >
          Seal this file
        </Button>
      </div>
    </div>
  );
}
