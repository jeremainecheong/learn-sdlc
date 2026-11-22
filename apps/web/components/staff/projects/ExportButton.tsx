'use client';

/**
 * Export, a version back to the on-disk layout.
 *
 * The archive is the project as it would be uploaded, sealed files included,
 * and the API answers it to the project's owner alone. So the bytes go from
 * the response straight to the browser's save, and nothing of them is drawn
 * here; the page says the file was saved and what it carries, and (for a
 * copy) how many inherited sealed files the API left out.
 */
import { useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { projectsApi } from '@/lib/api-projects';
import { saveBlob } from '@/lib/download';
import { refusalOf } from '@/components/staff/projects/refusal';

/** "books-on-a-shelf-1.0.0.zip", kept to the characters a file name can carry. */
export function exportFilename(slug: string, version: string): string {
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const safeVersion = version.replace(/[^0-9.]+/g, '') || 'draft';
  return `${safeSlug}-${safeVersion}.zip`;
}

/**
 * What the page says once the archive is saved. A copy's export leaves out
 * the sealed files the teacher did not
 * write (they came with the project they copied) and the API counts them,
 * so the page says so rather than claiming the archive holds them.
 */
export function savedSentence(name: string, withheld: number | null): string {
  // A count the page could not read (no header, or
  // not a whole number) is never read as 0. The file was saved, so the page
  // says so, and it makes no claim about what the archive holds.
  if (withheld === null || !Number.isSafeInteger(withheld) || withheld < 0) {
    return `Saved ${name}. The page could not read how many sealed files were left out, so open the archive before you share it.`;
  }
  if (withheld === 0) {
    return `Saved ${name}. It holds your sealed tests and solution, so keep it where only you can read it.`;
  }
  const files = withheld === 1 ? '1 sealed file' : `${withheld} sealed files`;
  // The saved file never gains what is written after it, and a fresh copy may
  // hold no sealed file the teacher wrote: so the page says "export again",
  // and claims nothing it cannot know of the archive's sealed contents.
  return (
    `Saved ${name}. ${files} you did not write, inherited from the project you copied, ` +
    `${withheld === 1 ? 'was' : 'were'} left out. To share a whole pack, write your own in the editor and export again. ` +
    'Any sealed file you wrote is in it, so keep it where only you can read it.'
  );
}

/** The refusal when the browser would not take the file: nothing was saved. */
const HAND_OFF_REFUSED =
  'The archive could not be handed to your browser to save, so nothing was saved. Try again in a moment.';

/**
 * The one sentence of help beside the button. True of every
 * version: the export never writes a warm-up (`export.service.ts`, no
 * warmup/ folder and no warmup key), because the upload refuses one.
 */
const EXPORT_WARMUP_HELP = 'An export never carries a warm-up, because the upload would refuse one.';

/** What the last export said: its refusal or its saved sentence, at most one of them. */
export interface ExportOutcome {
  error: string;
  done: string;
}

/**
 * The outcome of an export, in the page's notice pattern: the refusal as an
 * alert, the saved sentence as a status. Nothing is drawn while there is
 * nothing to say.
 */
export function ExportOutcomeNotice({ outcome }: { outcome: ExportOutcome }) {
  if (outcome.error) {
    return (
      <Notice tone="fail" role="alert" testId="project-export-error-box">
        <span data-testid="project-export-error">{outcome.error}</span>
      </Notice>
    );
  }
  if (outcome.done) {
    return (
      <Notice tone="pass" role="status" testId="project-export-done-box">
        <span data-testid="project-export-done">{outcome.done}</span>
      </Notice>
    );
  }
  return null;
}

export function ExportButton({
  projectId,
  versionId,
  slug,
  version,
  onSaved,
  onOutcome,
}: {
  projectId: string;
  versionId: string;
  slug: string;
  version: string;
  /** Told once the browser has taken the file (the rail's Export step). */
  onSaved?: () => void;
  /**
   * Given, the outcome is handed to the page to draw where it moves nothing
   * (the project page draws it under its section tabs) and nothing is
   * drawn here; not given, it is drawn under the button.
   */
  onOutcome?: (outcome: ExportOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ExportOutcome>({ error: '', done: '' });
  const say = (next: ExportOutcome) => {
    setOutcome(next);
    onOutcome?.(next);
  };
  const setError = (error: string) => say({ error, done: '' });
  const setDone = (done: string) => say({ error: '', done });

  const go = async () => {
    setBusy(true);
    say({ error: '', done: '' });
    try {
      const { blob, withheld } = await projectsApi.exportVersion(projectId, versionId);
      const name = exportFilename(slug, version);
      // "Saved" only once the browser has taken the file; a
      // hand-off that throws is the refusal, never the raw error.
      try {
        saveBlob(blob, name);
      } catch {
        setError(HAND_OFF_REFUSED);
        return;
      }
      setDone(savedSentence(name, withheld));
      onSaved?.();
    } catch (err) {
      setError(refusalOf(err, 'This version could not be exported. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div>
        <Button
          size="sm"
          variant="secondary"
          icon="download"
          busy={busy}
          busyLabel="Exporting…"
          testId="project-export"
          onClick={() => void go()}
        >
          Export as an archive
        </Button>
      </div>
      <p className="wrap text-[12.5px] leading-relaxed text-muted" data-testid="project-export-help">
        {EXPORT_WARMUP_HELP}
      </p>
      {!onOutcome && <ExportOutcomeNotice outcome={outcome} />}
    </div>
  );
}
