'use client';

/**
 * The action a session ended under, and the words that went with it.
 *
 * The one-hour session of a managed deployment can end at a Submit click, and
 * the click would be lost without a sentence to say so. Two independent things
 * stand in the way. The request answers 401 and `lib/api.ts` takes the browser
 * to the sign-in page, so no `catch` in the room is ever going to draw
 * anything; and the commit message, held in `lib/commit.ts`'s module-level
 * Map, is cleared by the session's own enders before the navigation. This
 * record is what crosses that gap: it names what the learner was doing and
 * carries what they had typed, so the shell can say so when they are back.
 *
 * It is bound by exactly the rules `lib/api-workspace.ts` already applies to an
 * unsaved file, and for the same reason: a lab computer is shared:
 *
 * - one key per phase, under `lsdlc_pending_<phaseId>`;
 * - stamped with the account that wrote it, and deleted on read when the
 *   account at the keyboard is a different one;
 * - forgotten after a day;
 * - swept by `forgetWorkspaceStorage` and `forgetOtherLearnersWorkspaceStorage`,
 *   and by a deliberate sign-out;
 * - every read and write inside a `try`, because a locked-down browser answers
 *   `setItem` with a throw or a silent no-op.
 *
 * Two rules it does **not** share with a workspace draft, both deliberate:
 *
 * 1. A read while nobody is signed in returns null and **leaves the record
 *    alone**. The signed-out gap between the 401 and the next sign-in is the
 *    only reason this record exists; a read there must not be what destroys it.
 * 2. A draft is never recorded as a submission. Only a real attempt writes
 *    `kind: 'submit'`; words stashed on the way out are `kind: 'draft'`.
 *    Telling a learner a submission was lost when they had merely typed a
 *    sentence would be the product saying something untrue.
 *
 * Nothing here holds a token or any other credential: the only things written
 * are a phase id, a label the product chose, and prose the learner typed.
 *
 * It also says when a record appears or goes, through
 * {@link onPendingActionsChanged}. The shell draws a sentence about the
 * submission that was not recorded, and the shell is mounted once for the whole
 * tab: without a way to hear that the submission has since been recorded, that
 * sentence stays on screen after the learner has submitted again: false while
 * it is drawn, and an invitation to submit twice. A `storage` event is not
 * enough, because the browser does not fire one in the tab that wrote.
 */
import { getSession } from './session';

/** One key per phase. Exported so the workspace's sweeps can include it. */
export const PENDING_PREFIX = 'lsdlc_pending_';
/** Older than this and there is no telling whether the learner still wants it. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What the learner was doing.
 *
 * `'submit'` is written only around a real submission, so it alone may produce
 * a sentence about a submission that was not recorded. `'draft'` is words held
 * for a field, and claims nothing was attempted.
 */
export type PendingActionKind = 'submit' | 'draft';

export interface PendingAction {
  at: number;
  /** Whose action this was. It is only ever replayed under the account that wrote it. */
  by: string;
  kind: PendingActionKind;
  phaseId: string;
  /** The action in the product's words, written to read inside a sentence. */
  label: string;
  /** What the learner had typed, when there was anything. */
  text?: string;
}

/** What a stashed draft calls itself, when nothing was attempted. */
export const PENDING_DRAFT_LABEL = 'your message';

const KINDS: readonly string[] = ['submit', 'draft'];

const keyFor = (phaseId: string) => `${PENDING_PREFIX}${phaseId}`;

const watchers = new Set<() => void>();

/**
 * Hear about a record being written or forgotten in this tab. Returns the
 * unregister function.
 *
 * Only the deliberate writes announce: a record dropped inside a read because
 * it is stale or belongs to another account does not, because a read is
 * allowed to happen while something is rendering and a notification there
 * would be a render that causes a render.
 */
export function onPendingActionsChanged(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

function announce(): void {
  watchers.forEach((fn) => fn());
}

/** The account a record would belong to right now, or null when nobody is signed in. */
const owner = (): string | null => getSession()?.id ?? null;

function drop(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // nothing was kept, so there is nothing to remove
  }
}

/** Every key this module owns, or an empty list where storage refuses to say. */
function ownKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PENDING_PREFIX)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

/** A record as stored, or null when the string is not one. */
function parse(raw: string | null): PendingAction | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingAction;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    if (typeof parsed.by !== 'string' || !parsed.by) return null;
    if (typeof parsed.phaseId !== 'string' || !parsed.phaseId) return null;
    if (typeof parsed.label !== 'string' || !parsed.label) return null;
    if (!KINDS.includes(parsed.kind)) return null;
    if (parsed.text !== undefined && typeof parsed.text !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * One key's record, or null with the key dropped wherever it can never be
 * used: too old, the wrong shape, or written by another account. A read while
 * nobody is signed in is not one of those cases: see rule 1 above.
 */
function readAt(key: string): PendingAction | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  const record = parse(raw);
  if (!record) {
    if (raw !== null) drop(key);
    return null;
  }
  if (Date.now() - record.at > PENDING_TTL_MS) {
    drop(key);
    return null;
  }
  const me = owner();
  if (!me) return null;
  if (record.by !== me) {
    drop(key);
    return null;
  }
  return record;
}

/** Hold what the learner was doing. No session, no record: there is nobody to replay it for. */
export function rememberPendingAction(action: Omit<PendingAction, 'at' | 'by'>): void {
  if (typeof window === 'undefined') return;
  const me = owner();
  if (!me) return;
  const record: PendingAction = { ...action, at: Date.now(), by: me };
  try {
    window.localStorage.setItem(keyFor(action.phaseId), JSON.stringify(record));
  } catch {
    // A browser that keeps nothing cannot be given a safety net. The words are
    // still in the field for as long as this document lives.
  }
  announce();
}

/**
 * Keep what is typed beside whatever is already pending for this phase.
 *
 * An attempt that is already recorded keeps its kind and its label: the
 * submission really was interrupted, and this only fills in the sentence that
 * went with it. Anything else is a draft, and says so.
 *
 * Returns whether the words can really be read back. A locked-down browser
 * answers `setItem` with a throw *or* a silent no-op, so the only honest
 * answer comes from reading: a caller that goes on to tell the learner their
 * message is waiting has to know it is.
 */
export function rememberPendingText(phaseId: string, text: string): boolean {
  if (!text) return false;
  const existing = readPendingAction(phaseId);
  rememberPendingAction({
    kind: existing?.kind ?? 'draft',
    phaseId,
    label: existing?.label ?? PENDING_DRAFT_LABEL,
    text,
  });
  return readPendingAction(phaseId)?.text === text;
}

/** The pending action for a phase, or null when there is nothing this account can use. */
export function readPendingAction(phaseId: string): PendingAction | null {
  return readAt(keyFor(phaseId));
}

/**
 * Every pending action this account can use, the attempted submissions first
 * and the newest of either kind before the older. The shell's notice names the
 * first, so this order is what decides which sentence a learner reads.
 */
export function readPendingActions(): PendingAction[] {
  if (typeof window === 'undefined') return [];
  const found = ownKeys()
    .map((key) => readAt(key))
    .filter((record): record is PendingAction => record !== null);
  return found.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'submit' ? -1 : 1;
    return b.at - a.at;
  });
}

/** The one pending action worth saying something about, or null. */
export function readAnyPendingAction(): PendingAction | null {
  return readPendingActions()[0] ?? null;
}

export function forgetPendingAction(phaseId: string): void {
  if (typeof window === 'undefined') return;
  drop(keyFor(phaseId));
  announce();
}

/** Everything, for a deliberate sign-out. */
export function forgetAllPendingActions(): void {
  if (typeof window === 'undefined') return;
  ownKeys().forEach(drop);
  announce();
}
