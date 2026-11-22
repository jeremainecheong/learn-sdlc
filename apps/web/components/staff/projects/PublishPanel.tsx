'use client';

/**
 * Publishing, which is the one door in this surface that cannot be undone.
 *
 * **The control is off while the draft would be refused, and it says why.** A
 * live button that answers with a refusal teaches a teacher that the page does
 * not know what the server will do. So Publish is disabled until a report says
 * `publishable`, and the report's own `blocking` sentences (the server's
 * words, in check order) are printed beside it.
 *
 * **It asks before it goes through.** A published version never changes: the
 * class assigned to it works the same phases until someone assigns another
 * version, and nothing a teacher does afterwards can alter what a learner is
 * already inside. That is worth one confirm.
 *
 * **A warning is said, never enforced.** `warnings` are the editor's own
 * sentences about the draft (a starting record a learner passes by changing
 * nothing): drawn above Publish, and Publish stays as the report leaves it.
 *
 * **Once published here, the receipt is the panel.** The version and
 * notes fields and the Publish button would only stand greyed under it, so
 * they go; the receipt says what a full pass boots, in the Validate tab's unit
 * (microVMs), and links to My classes, where a class's Project tab assigns it.
 * The pressed "Publish 1.0.0" goes with the form, so focus moves to the
 * receipt as it appears rather than falling to the page's body.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ValidationReport } from '@learnsdlc/shared';
import { PROJECT_VERSION_PATTERN, isProjectVersion } from '@learnsdlc/shared';
import { Field } from '@/components/Field';
import { Button, Notice, Section } from '@/components/ui';

export function PublishPanel({
  draftVersion,
  report,
  editable,
  readOnlyReason,
  publishing,
  error,
  published,
  onPublish,
  warnings = [],
}: {
  /** The draft's own version, for the line that says what is being frozen. */
  draftVersion: string;
  report: ValidationReport | null;
  editable: boolean;
  /**
   * Why this version cannot be written to, in the contract's own sentence, or
   * null while it can. It is asked for rather than guessed: "published",
   * "the platform's" and "not yours" are three different facts, and telling a
   * teacher who has just published that the version is not theirs would be
   * the wrong one of the three.
   */
  readOnlyReason: string | null;
  publishing: boolean;
  /** The API's refusal, read back word for word. */
  error: string;
  /** What the last publish produced, or null. */
  published: { version: string; publishedAt: string; sandboxBudget: number } | null;
  onPublish: (version: string, notes: string) => void;
  /** Sentences drawn above Publish as warnings; they never refuse it. */
  warnings?: string[];
}) {
  const [version, setVersion] = useState('1.0.0');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [own, setOwn] = useState('');
  const receipt = useRef<HTMLDivElement>(null);
  /** Whether the receipt was drawn at the last commit: focus moves only as it appears. */
  const receiptShown = useRef(published !== null);
  useEffect(() => {
    const appeared = published !== null && !receiptShown.current;
    receiptShown.current = published !== null;
    if (!appeared) return;
    // The confirm button that was pressed is gone with the form. Focus goes to
    // the receipt unless the teacher has already put it somewhere else.
    const at = document.activeElement;
    const panel = receipt.current?.closest('[data-testid="project-publish-panel"]');
    if (!at || at === document.body || panel?.contains(at)) receipt.current?.focus();
  }, [published]);

  // Order matters: a published version is not waiting on validation, and a
  // draft that fails a check is not waiting on ownership.
  const blocked = !editable
    ? (readOnlyReason ?? 'This version is not yours to publish.')
    : report === null
      ? 'Validate this draft first. Publish re-runs every check and refuses on any failure, so there is nothing to gain by skipping it.'
      : !report.publishable
        ? report.failed === 1
          ? '1 check fails. Publish would refuse for the reason below.'
          : `${report.failed} checks fail. Publish would refuse for the reasons below.`
        : '';

  const open = () => {
    if (!isProjectVersion(version.trim())) {
      setOwn(
        'A version is three numbers with dots between them, like 1.0.0, and it has to be newer than every version this project has published.',
      );
      return;
    }
    setOwn('');
    setConfirming(true);
  };

  const shown = own || error;
  // Once the version is published the question has been answered, so the box
  // goes: left up, it would say "Publishing freezes draft 1.0.0 as version
  // 1.0.0" beside the receipt, about a draft that no longer exists.
  const asking = confirming && editable && published === null;

  return (
    <Section
      title="Publish"
      purpose="Freeze this draft at a version. A class is assigned a version, and a published version never changes."
      testId="project-publish-panel"
    >
      {shown && (
        <Notice tone="fail" role="alert" testId="project-publish-error">
          {shown}
        </Notice>
      )}

      {published && (
        <div ref={receipt} tabIndex={-1} className="outline-none">
        <Notice tone="pass" role="status" testId="project-published">
          {`Version ${published.version} is published. One full pass boots ${published.sandboxBudget === 1 ? '1 microVM' : `${published.sandboxBudget} microVMs`}. `}
          {'Assign it to a class on that class\'s Project tab, from '}
          <Link href="/teacher" className="font-medium underline" data-testid="project-published-classes">
            My classes
          </Link>
          .
        </Notice>
        </div>
      )}

      {report !== null && !report.publishable && (
        <div className="min-w-0" data-testid="project-publish-blocking">
          <span className="label-sm font-medium">Why publish would refuse</span>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
            {report.blocking.map((sentence, at) => (
              <li key={at} className="wrap text-[13px] leading-[1.45] text-fail">
                {sentence}
              </li>
            ))}
          </ul>
        </div>
      )}

      {published === null && (
      <div className="flex min-w-0 flex-col gap-3">
        <Field
          id="project-publish-version"
          label="Version"
          hint="Three numbers with dots between them, newer than every version this project has published."
          value={version}
          pattern={PROJECT_VERSION_PATTERN.source}
          disabled={!editable}
          data-testid="project-publish-version"
          onChange={(e) => {
            setOwn('');
            setConfirming(false);
            setVersion(e.target.value);
          }}
        />
        <div className="min-w-0">
          <label htmlFor="project-publish-notes" className="block text-[13px] font-medium text-ink">
            Notes
          </label>
          <textarea
            id="project-publish-notes"
            className="field mt-1.5 min-h-[72px]"
            data-testid="project-publish-notes"
            value={notes}
            disabled={!editable}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            What changed in this version. Read by you and by whoever assigns it, never by a learner.
          </p>
        </div>
      </div>
      )}

      {editable && warnings.length > 0 && (
        <Notice tone="warn" role="status" testId="project-publish-warnings">
          <span className="block font-medium">Before you publish</span>
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0">
            {warnings.map((sentence) => (
              <li key={sentence} className="wrap text-[13px] leading-[1.45]">
                {sentence}
              </li>
            ))}
          </ul>
        </Notice>
      )}

      {asking ? (
        <div className="flex min-w-0 flex-col gap-2.5">
          <Notice tone="warn" role="status">
            <span data-testid="project-publish-confirm">
              {`Publishing freezes draft ${draftVersion} as version ${version.trim()}. A published version never changes: a class assigned to it works this project exactly as it stands now, and further edits go into a new draft.`}
            </span>
          </Notice>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              busy={publishing}
              busyLabel="Publishing…"
              testId="project-publish-confirm-yes"
              onClick={() => onPublish(version.trim(), notes)}
            >
              {`Publish ${version.trim()}`}
            </Button>
            <Button variant="ghost" testId="project-publish-confirm-no" onClick={() => setConfirming(false)}>
              Keep it a draft
            </Button>
          </div>
        </div>
      ) : published === null && (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            disabled={Boolean(blocked)}
            reason={blocked || undefined}
            testId="project-publish"
            onClick={open}
          >
            Publish this version
          </Button>
          {blocked && (
            <span className="label-sm" data-testid="project-publish-reason">
              {blocked}
            </span>
          )}
        </div>
      )}
    </Section>
  );
}
