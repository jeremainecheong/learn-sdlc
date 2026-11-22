'use client';

/**
 * A testing task's mutants, in the editor.
 *
 * A mutant is a deliberately broken copy of a file of the reference
 * implementation. A learner's suite passes the testing phase only by killing
 * every one, and deep validation proves first that the reference tests do.
 * Each is sealed like a hidden test: chosen, sent, and drawn from then on as a
 * path, a digest and a size.
 *
 * Without this editor a testing task's mutants change only by uploading the
 * project again.
 */
import { useState } from 'react';
import type { SealedFileView, SealedFileWriteBody } from '@learnsdlc/shared';
import { SealedFileRows } from '@/components/staff/projects/ExecutableTask';
import { SealedUpload, withSealed } from '@/components/staff/projects/SealedUpload';

export function MutantsEditor({
  mutants,
  busy = false,
  onWriteSealed,
  onSealed,
}: {
  mutants: readonly SealedFileView[];
  busy?: boolean;
  onWriteSealed: (body: SealedFileWriteBody) => Promise<SealedFileView>;
  onSealed?: () => void;
}) {
  const [rows, setRows] = useState<SealedFileView[]>(() => mutants.map((one) => ({ ...one })));
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 rounded-ctl border-1.5 border-edge p-3" disabled={busy}>
      <legend className="px-1 text-[13px] font-semibold text-ink">Mutants (sealed)</legend>
      <p className="label-sm wrap">
        Each mutant is a broken copy of one implementation file, written as its name, a slash and the file, such as
        off-by-one/shelf.py. A learner&rsquo;s suite must make every one fail.
      </p>
      <SealedFileRows files={rows} group="mutant" empty="No mutant yet." />
      <SealedUpload
        group="mutant"
        role="mutant"
        runId={null}
        label="Add or replace a mutant file"
        hint="Deep validation proves the reference tests kill it before you can publish. Sealed: only its digest and size are shown after this."
        onWrite={onWriteSealed}
        onWritten={(view) => {
          setRows((was) => withSealed(was, view));
          onSealed?.();
        }}
      />
    </fieldset>
  );
}
