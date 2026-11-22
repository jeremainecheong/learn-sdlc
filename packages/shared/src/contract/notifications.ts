/**
 * Notifications: what the bell shows and the event that announces one.
 */

import type { PhaseKey } from '../phases';

/* ------------------------------ notifications ----------------------------- */

/**
 * What a notification is about. The `class.` kinds are the instructor's side
 * of the bell, who needs a look, and everything else is the learner's.
 */
export type NotificationKind =
  | 'gate.passed'
  | 'review.posted'
  | 'deadline.near'
  | 'drill.unresolved'
  | 'stuck.answered'
  | 'instructor.note'
  | 'class.stuck'
  | 'class.integrity'
  | 'class.help';

/** Which bell a row belongs in: a learner's own plan, or an instructor's class. */
export type NotificationAudience = 'learner' | 'instructor';

/**
 * One row in the bell. The sentence is written by the API when the row is
 * made, not assembled in the browser: the same event has to read identically
 * in the panel, in a log line and in an instructor's audit trail, and a
 * client-side template is how those three drift apart.
 */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  audience: NotificationAudience;
  /** The sentence. Sentence case, no pipes or middle dots. */
  title: string;
  /** The second line: the score, the file, the reason. Null when the title says it all. */
  detail: string | null;
  /** Where the row goes. Always an in-app path, never an absolute URL. */
  href: string;
  /** The phase this is about, for the mark on the row. Null for class-wide rows. */
  phaseKey: PhaseKey | null;
  /** Who caused it, when that is a person: an instructor's note. */
  actorName: string | null;
  /** Null while unread. A read row is never returned by the list route. */
  readAt: string | null;
  createdAt: string;
}

/**
 * What the bell asks for. `unread` is the true count for this caller whether
 * or not it fits in `items`, so the badge is never the length of a page.
 */
export interface NotificationListView {
  items: NotificationView[];
  unread: number;
}

/** Pushed to the owning user the moment a notification is created. */
export interface NotificationEvent {
  notification: NotificationView;
  /** The caller's unread count after this one, so the badge needs no second request. */
  unread: number;
}
