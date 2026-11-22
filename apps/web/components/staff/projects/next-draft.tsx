/**
 * What a version that is not editable says about itself, and the door to the
 * project's next draft: the reason a version is read-only, whether a project is
 * withdrawn, the box `NextDraft` draws and the sentence the page announces when
 * the door changes. Every refusal is the contract's own sentence.
 */
import type { AuthoredProjectSummary, DraftVersionView } from '@learnsdlc/shared';
import {
  draftAlreadyOpenRefusal,
  draftOnlyRefusal,
  nextDraftVersion,
  nothingPublishedRefusal,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
} from '@learnsdlc/shared';
import { Button, Notice } from '@/components/ui';
import { draftHref } from '@/components/staff/projects/ProjectsLibrary';
import type { AuthoredVersionRow } from '@/lib/api-projects';

/** Why this version cannot be edited, in the contract's own words, or null. */
export function readOnlyReason(view: DraftVersionView): string | null {
  if (view.editable) return null;
  if (view.status !== 'draft') return draftOnlyRefusal(view.version, view.status);
  if (view.platformOwned) return platformProjectCopyOnlyRefusal(view.title);
  return projectNotYoursRefusal();
}

/**
 * Withdrawn: the project holds versions and every one of them is archived.
 *
 * This is the API's own predicate (`createDraftVersion` in
 * `apps/api/src/authoring/authoring.service.ts`), read off the version rows the
 * same envelope carries. It is needed because withdrawing archives *every* row,
 * the open draft included, so a withdrawn project reports a null
 * `publishedVersion` and a null `draftVersion` exactly as a project that has
 * never published does, and the two states have different true sentences.
 */
export function isWithdrawn(versions: readonly AuthoredVersionRow[]): boolean {
  return versions.length > 0 && versions.every((one) => one.status === 'archived');
}

/**
 * The door to the next draft, and the five states it is not a door in.
 *
 * The contract's order of checks is the order here, so a teacher meets one
 * wording for one refusal whether they meet it before the call or after it:
 * the platform's project is copy-only, a project that is not theirs is not
 * theirs, a draft already open is opened rather than minted again, and a
 * project with nothing published has nothing to open from. Each is the door's
 * own sentence, drawn before the click rather than fetched by it, a control
 * that can only be refused is not a control.
 *
 * The withdrawn project is the one exception, and it is the API that makes it
 * one. Its refusal, `withdrawnProjectRefusal`, is written beside the route in
 * `apps/api/src/authoring/authoring.service.ts` rather than in the contract this
 * file imports from, so there are three things this page could do and only one
 * of them is honest: print `nothingPublishedRefusal`, which says two false
 * things to a teacher whose project published and was withdrawn; write a second
 * wording of the API's sentence here, which is the drift every other refusal on
 * this page is drawn from the contract to avoid; or say what the versions say
 * (that they are all archived) and let the door answer for itself. Were that
 * sentence in `packages/shared`, this branch could print it like its four
 * siblings and drop the control.
 */
const WITHDRAWN_SENTENCE =
  'Every version of this project is archived. Ask for a new draft and this project answers in its own words.';

export function NextDraft({
  summary,
  withdrawn,
  version,
  versionId,
  projectId,
  busy,
  error,
  onOpen,
}: {
  /** The project around this version, or null while it is being read. */
  summary: AuthoredProjectSummary | null;
  /** Whether every version of it is archived, from the same envelope. */
  withdrawn: boolean;
  /** The version on screen, which need not be the published head. */
  version: string;
  versionId: string;
  projectId: string;
  busy: boolean;
  /** The door's refusal, or the read's, word for word. */
  error: string;
  onOpen: (fromVersionId: string) => void;
}) {
  const said = error ? (
    <Notice tone="fail" role="alert" testId="project-new-draft-error">
      {error}
    </Notice>
  ) : null;

  if (summary === null) {
    return (
      said ?? (
        <p className="purpose" role="status" data-testid="project-next-draft-loading">
          Reading what this project has published.
        </p>
      )
    );
  }

  if (summary.platformOwned) {
    return (
      <Notice tone="info" testId="project-next-draft-platform-box">
        <span data-testid="project-next-draft-platform">
          {platformProjectCopyOnlyRefusal(summary.title)}
        </span>
      </Notice>
    );
  }

  if (!summary.mine) {
    return (
      <Notice tone="info" testId="project-next-draft-not-yours-box">
        <span data-testid="project-next-draft-not-yours">{projectNotYoursRefusal()}</span>
      </Notice>
    );
  }

  if (summary.draftVersion && summary.draftVersionId) {
    return (
      <>
        <p className="purpose wrap">{draftAlreadyOpenRefusal(summary.draftVersion)}</p>
        <div>
          <Button
            size="sm"
            variant="secondary"
            href={draftHref(projectId, summary.draftVersionId)}
            testId="project-next-draft-open"
          >
            {`Open draft ${summary.draftVersion}`}
          </Button>
        </div>
      </>
    );
  }

  if (!summary.publishedVersion || !summary.publishedVersionId) {
    if (withdrawn) {
      return (
        <>
          {said}
          <p className="purpose wrap" data-testid="project-next-draft-withdrawn">
            {WITHDRAWN_SENTENCE}
          </p>
          <div>
            <Button
              busy={busy}
              busyLabel="Asking…"
              variant="secondary"
              testId="project-new-draft-archived"
              onClick={() => onOpen(versionId)}
            >
              Ask for a new draft
            </Button>
          </div>
        </>
      );
    }
    return (
      <Notice tone="info" testId="project-next-draft-nothing-box">
        <span data-testid="project-next-draft-nothing">{nothingPublishedRefusal(summary.title)}</span>
      </Notice>
    );
  }

  const head = summary.publishedVersion;
  const onHead = summary.publishedVersionId === versionId;
  const opening = nextDraftVersion(head);
  return (
    <>
      {said}
      <p className="purpose wrap" data-testid="project-next-draft-note">
        {onHead
          ? `Version ${head} stays frozen exactly as it is, and every class keeps the version it was assigned. The new draft opens from ${head} as ${opening}, and nothing reaches a class until you publish it and assign it.`
          : `Version ${version} stays frozen exactly as it is, and so does ${head}, which is the newest version this project has published. A draft opens from the newest one, so this one opens from ${head} as ${opening}. Every class keeps the version it was assigned.`}
      </p>
      <div>
        <Button
          busy={busy}
          busyLabel="Opening the draft…"
          testId="project-new-draft"
          onClick={() => onOpen(summary.publishedVersionId as string)}
        >
          {`New draft from ${head}`}
        </Button>
      </div>
    </>
  );
}

/**
 * What the door has just become, for the region the rest of the page speaks
 * through.
 *
 * It is the same refusals and the same offer `NextDraft` draws, in the same
 * order, because two sentences for one state is two states to a teacher who
 * cannot see the box. Nothing here is a paraphrase: each refusal is the
 * contract's own, and the offer names the head and the number the draft opens
 * at, which is what the box says in longer form. A withdrawn project says what
 * the box says, for the same reason the box says it.
 */
export function nextDraftAnnouncement(
  summary: AuthoredProjectSummary,
  withdrawn: boolean,
): string {
  if (summary.platformOwned) return platformProjectCopyOnlyRefusal(summary.title);
  if (!summary.mine) return projectNotYoursRefusal();
  if (summary.draftVersion && summary.draftVersionId) {
    return draftAlreadyOpenRefusal(summary.draftVersion);
  }
  if (!summary.publishedVersion || !summary.publishedVersionId) {
    if (withdrawn) {
      return WITHDRAWN_SENTENCE;
    }
    return nothingPublishedRefusal(summary.title);
  }
  return `Version ${summary.publishedVersion} is the newest version this project has published. A new draft would open as ${nextDraftVersion(summary.publishedVersion)}.`;
}
