import type { UserProfile } from '@learnsdlc/shared';
import { onSessionEnd } from '@/lib/session';
import { DOTTED_KEY, PROFILE_DRAFT_KEY, readStoredValue } from '@/lib/storage-keys';

export { PROFILE_DRAFT_KEY };
type ProfileFields = Pick<UserProfile, 'displayName'> & { avatar: number; bio: string; goals: string };
/**
 * A draft's `displayName` is absent when
 * the name in the form was blank after trimming. Such a name cannot be saved,
 * so it is never restored over the saved one; the other fields still are.
 */
type DraftFields = Omit<ProfileFields, 'displayName'> & { displayName?: string };
type ProfileDraft = { owner: string; baseVersion: number; fields: DraftFields };
let memory: ProfileDraft | null = null;

export function profileFields(user: UserProfile): ProfileFields {
  return { displayName: user.displayName, avatar: user.avatar ?? 0, bio: user.bio ?? '', goals: user.goals ?? '' };
}
function valid(value: unknown): value is ProfileDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ProfileDraft, fields = draft.fields;
  return typeof draft.owner === 'string' && Number.isSafeInteger(draft.baseVersion) && draft.baseVersion >= 0
    && !!fields && (fields.displayName === undefined || (typeof fields.displayName === 'string' && fields.displayName.length <= 60))
    && typeof fields.bio === 'string' && fields.bio.length <= 1000
    && typeof fields.goals === 'string' && fields.goals.length <= 1000
    && Number.isInteger(fields.avatar) && fields.avatar >= 0 && fields.avatar <= 5;
}
/** Removes the stored draft under both spellings: a full storage can leave it under the dotted one. */
function forgetStoredDraft(): void {
  sessionStorage.removeItem(PROFILE_DRAFT_KEY);
  sessionStorage.removeItem(DOTTED_KEY[PROFILE_DRAFT_KEY]);
}
export function clearProfileDraft(owner?: string): void {
  if (!owner || memory?.owner === owner) memory = null;
  try {
    const raw = readStoredValue(sessionStorage, PROFILE_DRAFT_KEY, DOTTED_KEY[PROFILE_DRAFT_KEY]);
    if (!owner || !raw || JSON.parse(raw)?.owner === owner) forgetStoredDraft();
  } catch { /* Refused storage does not prevent editing or signing out. */ }
}
export function readProfileDraft(owner: string): ProfileDraft | null {
  try {
    const raw = readStoredValue(sessionStorage, PROFILE_DRAFT_KEY, DOTTED_KEY[PROFILE_DRAFT_KEY]);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && valid(saved) && saved.owner === owner) return memory = withoutBlankName(saved);
    if (raw) forgetStoredDraft();
  } catch { /* The in-memory draft can still survive client navigation. */ }
  if (memory?.owner !== owner) memory = null;
  return memory;
}
/**
 * A draft whose name is blank after trimming, without that name: bio, goals
 * and portrait survive, and the page takes the name from the saved profile.
 */
function withoutBlankName(draft: ProfileDraft): ProfileDraft {
  if (draft.fields.displayName === undefined || draft.fields.displayName.trim()) return draft;
  const { avatar, bio, goals } = draft.fields;
  return { ...draft, fields: { avatar, bio, goals } };
}
/**
 * False means refresh cannot be promised; the UI warns before leaving. A blank
 * name is stored as no name rather than not stored: skipping the write
 * would leave the draft from one keystroke earlier to come back on reload.
 */
export function writeProfileDraft(input: ProfileDraft): boolean {
  const draft = withoutBlankName(input);
  memory = draft;
  try {
    sessionStorage.setItem(PROFILE_DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch { return false; }
}
onSessionEnd(() => clearProfileDraft());
