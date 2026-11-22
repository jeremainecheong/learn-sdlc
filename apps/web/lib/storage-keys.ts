/**
 * Browser storage keys that more than one module reads, and the rule the keys
 * below follow: `lsdlc_<name>` in lower case with underscores, and a colon
 * before a part that varies (an id, a version).
 *
 * A browser can still hold a value under the dotted spelling these keys were
 * written with before the rule (`learnsdlc.<name>`). Every reader goes through
 * {@link readStoredValue}, which moves such a value to the key it reads now,
 * once, so a draft or a remembered step is not lost.
 */

/** The profile form's unsaved draft, in sessionStorage. */
export const PROFILE_DRAFT_KEY = 'lsdlc_profile_draft';

/** The address a new account registered with, waiting for its confirmation, in sessionStorage. */
export const REGISTRATION_EMAIL_KEY = 'lsdlc_registration_email';

/** A class code read from an invitation, waiting for the account that signs in, in sessionStorage. */
export const CLASS_CODE_KEY = 'lsdlc_class_code';

/** The account id that claimed the waiting class code, in sessionStorage. */
export const CLASS_CODE_FOR_KEY = 'lsdlc_class_code_for';

/** A step of the teacher guide's rail done for one version, in localStorage. */
export type GuideMark = 'previewed' | 'exported';

/** The key of one guide mark: one per step and per version. */
export const guideMarkKey = (mark: GuideMark, versionId: string) => `lsdlc_guide_${mark}:${versionId}`;

/** The dotted spelling a browser may still hold for each key above. */
export const DOTTED_KEY: Readonly<Record<string, string>> = Object.freeze({
  [PROFILE_DRAFT_KEY]: 'learnsdlc.profile-draft.v1',
  [REGISTRATION_EMAIL_KEY]: 'learnsdlc.registration-email',
  [CLASS_CODE_KEY]: 'learnsdlc.pendingClass',
  [CLASS_CODE_FOR_KEY]: 'learnsdlc.pendingClass.for',
});

/** The dotted spelling of one guide mark's key. */
export const dottedGuideMarkKey = (mark: GuideMark, versionId: string) => `learnsdlc.guide.${mark}.${versionId}`;

/**
 * Moves a value held under `from` to `key`, once: the value is written to
 * `key` unless `key` already holds one, and `from` is removed either way.
 * Throws whatever the storage throws, so a caller's own guard for a refused
 * storage covers it.
 */
function carryStoredValue(storage: Storage, key: string, from: string | undefined): void {
  if (!from || from === key) return;
  const held = storage.getItem(from);
  if (held === null) return;
  if (storage.getItem(key) === null) storage.setItem(key, held);
  storage.removeItem(from);
}

/**
 * The value held for `key`, after carrying a value held under `from` over to
 * it. A storage that is full refuses the move, and the value is then read
 * where it still is, under `from`, so it is not lost; a later read moves it.
 * Throws whatever a read throws, so a caller's own guard for a refused
 * storage covers it.
 */
export function readStoredValue(storage: Storage, key: string, from: string | undefined): string | null {
  try {
    carryStoredValue(storage, key, from);
  } catch {
    // The move was refused; the value stays under `from` and is read there.
  }
  return storage.getItem(key) ?? (from ? storage.getItem(from) : null);
}
