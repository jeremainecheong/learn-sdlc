'use client';

/**
 * Viewing a learner's work, as an external store.
 *
 * An instructor opens a learner's page, presses *View as Ada*, and every
 * signed-in screen after that draws Ada's work: the dashboard, the phases, the
 * map, the journal, the artefacts and the workspace, her files included.
 *
 * There is no impersonation token and nothing to revoke. The instructor's own
 * bearer token makes ordinary instructor reads, and {@link viewAsPath} is the
 * whole mechanism: while a session is held, {@link request} in `lib/api.ts`
 * sends the six learner reads to their instructor-scoped twins and refuses
 * every write outright. So even a hand-made request cannot save, run or submit
 * as the learner: `WorkflowService.loadOwnedState` refuses a phase that is not
 * the caller's, and no guard had to change for that to be true.
 *
 * The session is module state and is never written to storage. A reload ends
 * it, which is deliberate: a view-as session that survived a reload is a
 * session an instructor could forget they are in. Signing out ends it too,
 * through {@link onSessionEnd}.
 */
import { useSyncExternalStore } from 'react';
import type { ViewAsSession } from '@learnsdlc/shared';
import { onSessionEnd } from './session';

type Listener = () => void;

const listeners = new Set<Listener>();
let session: ViewAsSession | null = null;

function emit(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The learner being viewed, or null. Safe anywhere, including the server. */
export function viewingAs(): ViewAsSession | null {
  return session;
}

/** Nothing on the server: a view-as session is a fact about one open tab. */
function serverSnapshot(): null {
  return null;
}

/**
 * Begin viewing. The caller has already made `POST
 * /instructor/learners/:id/view`, which is what records the audit row.
 */
export function startViewAs(next: ViewAsSession): void {
  session = next;
  emit();
}

/** Stop viewing. Idempotent, so the banner and sign-out can both call it. */
export function stopViewAs(): void {
  if (session === null) return;
  session = null;
  emit();
}

/** The learner being viewed, as React state. */
export function useViewAs(): ViewAsSession | null {
  return useSyncExternalStore(subscribe, viewingAs, serverSnapshot);
}

/**
 * The learner read this path becomes while a session is held, or null when the
 * path is not one of the learner reads that have a twin.
 *
 * The instructor-scoped twins are the only reads that exist
 * (`instructor.controller.ts`, and the review history's teacher door in
 * `submission-feedback.controller.ts`), and a path this does not know is sent
 * as it stands, which for an instructor route is exactly right and for
 * anything else is answered by the API's own scope rules rather than by a
 * rewrite here.
 */
export function viewAsPath(path: string, userId: string): string | null {
  const cut = path.indexOf('?');
  const base = cut === -1 ? path : path.slice(0, cut);
  const query = cut === -1 ? '' : path.slice(cut);
  const scoped = `/instructor/learners/${encodeURIComponent(userId)}`;

  if (base === '/enrollments/mine') return `${scoped}/enrollment${query}`;
  if (base === '/analytics/me') return `${scoped}/analytics${query}`;

  // `/phases/summaries` and `/phases/records` match this too, and on purpose:
  // each has its own twin, declared before the phase route. Without those
  // twins the phase route would read the word as a phase id.
  const phase = /^\/phases\/([^/]+)(\/submissions|\/runs)?$/.exec(base);
  if (phase) return `${scoped}/phases/${phase[1]}${phase[2] ?? ''}${query}`;

  // One task's revisions on a split phase, which every room of such a phase
  // reads. The key arrives already encoded and is sent as it is.
  const task = /^\/phases\/([^/]+)\/tasks\/([^/]+)\/submissions$/.exec(base);
  if (task) return `${scoped}/phases/${task[1]}/tasks/${task[2]}/submissions${query}`;

  // The project map: the learner's board, not the one the teacher's own
  // token would draw for that slug.
  const map = /^\/projects\/([^/]+)\/map$/.exec(base);
  if (map) return `${scoped}/projects/${map[1]}/map${query}`;

  // The review history is a learner-only route, and refused an instructor
  // with "insufficient role": the card a viewing teacher landed on. The
  // teacher's door to the same pages already exists.
  if (base === '/submissions/review-history/pages') {
    return `/submissions/learner-history/${encodeURIComponent(userId)}${query}`;
  }

  const chat = /^\/assistant\/history\/([^/]+)$/.exec(base);
  if (chat) return `${scoped}/assistant/${chat[1]}${query}`;

  return null;
}

/**
 * What a write is answered with while a session is held. It reaches the page
 * as an ordinary `ApiError`, so every page shows it in the notice it already
 * draws for a refusal, and none of them had to learn about view-as.
 */
export function viewAsRefusal(who: ViewAsSession): string {
  return `You are viewing ${firstNameOf(who)}'s work, so nothing can be saved, run or submitted. Stop viewing to work on your own account.`;
}

/** What the viewed learner is called in a sentence: their first name. */
function firstNameOf(who: Pick<ViewAsSession, 'displayName'>): string {
  return who.displayName.trim().split(/\s+/)[0] || who.displayName;
}

/**
 * What the mentor column says while a teacher views a learner's work, in
 * place of a box and two buttons that would look live and then be refused.
 *
 * Both halves are true for a reason of their own: asking the mentor or raising
 * a help flag is a write, which nothing does as the learner; and the learner's
 * mentor conversation is theirs alone (the teacher's twin of that read
 * (`GET /instructor/learners/:id/assistant/:phase`) is refused by design) so
 * the column does not ask for it either.
 */
export function viewAsMentorSentence(who: Pick<ViewAsSession, 'displayName'>): string {
  const first = firstNameOf(who);
  return `You are viewing ${first}'s work, so the mentor and I'm stuck are closed here. Mentor conversations stay private to ${first}.`;
}

onSessionEnd(stopViewAs);
