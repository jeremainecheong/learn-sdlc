'use client';

import { useSearchParams } from 'next/navigation';
import { unsentMessageKept } from '@/lib/api';
import { Notice } from '@/components/ui';

/**
 * Why the room the learner was working in turned into a sign-in page.
 *
 * A token that expires, a token an instructor revokes, and a sign-out in a
 * second tab all end the same way: `lib/api.ts` clears the session and sends
 * the browser here. Without a word about it, a learner mid-way through phase
 * 3 would simply be looking at a sign-in form with no idea whether they had
 * done something wrong. `next` already carries where they were; this says
 * what happened.
 *
 * A visitor who merely opened a signed-in address without a session gets no
 * notice: nothing ended for them, and telling them their session expired
 * would be a sentence the product cannot keep.
 *
 * The second half speaks about the learner's work: a learner whose hour ended
 * at a Submit click, told only that the session had ended, would read it as
 * the work having gone with it. It names only what the product really keeps,
 * which is narrower than
 * "anything you had typed":
 *
 * - the **files**, always: the workspace holds them against this account and
 *   writes them out on the way here (lib/api-workspace.ts, and the leaving
 *   hook in components/workspace/useVersionedWorkspaceSave.ts);
 * - the **commit message**, when there was one and the browser really kept it
 *   (lib/commit.ts's leaving hook, through lib/pending-action.ts).
 *
 * Nothing else that is typed survives the navigation here (the mentor
 * composer and the explanation draft are component state) so the page does
 * not claim them. The second clause is drawn only when the session that ended
 * in this tab really left a message behind, so it claims nothing for a learner
 * who had typed nothing and nothing in a browser that keeps nothing.
 */
const OPENING = 'Your session ended. Sign in to carry on where you left off.';

/** What is true of every expiry. */
export const SESSION_ENDED = `${OPENING} Your files are kept.`;

/** And of one that ended over an unsent message. */
export const SESSION_ENDED_WITH_MESSAGE = `${OPENING} Your files are kept, and so is the commit message you had not sent.`;

export function SessionEndedNotice() {
  const reason = useSearchParams().get('reason');
  if (reason !== 'expired') return null;
  // Read here rather than in an effect: this component is inside the login
  // page's Suspense boundary and is drawn in the browser, so there is no
  // server render to disagree with, and a sentence that grew a clause after
  // it was on screen would be read out twice by a screen reader.
  return (
    <Notice tone="warn" role="status" testId="session-ended">
      {unsentMessageKept() ? SESSION_ENDED_WITH_MESSAGE : SESSION_ENDED}
    </Notice>
  );
}
