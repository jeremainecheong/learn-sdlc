import type { TeacherFeedback } from '@/lib/api-experience';

export interface TeacherDraftScope {
  learnerId: string;
  phaseId: string;
  submissionId: string;
}
interface TeacherFeedbackDraft {
  text: string;
  action: TeacherFeedback['action'];
  busy: boolean;
  error: string;
  saved: boolean;
  requestId: string;
  requestContent: string;
  savedNote?: TeacherFeedback;
}
export const EMPTY_TEACHER_DRAFT: TeacherFeedbackDraft = Object.freeze({
  text: '', action: 'comment', busy: false, error: '', saved: false,
  requestId: '', requestContent: '',
});
export const teacherDraftKey = (scope: TeacherDraftScope) =>
  JSON.stringify([scope.learnerId, scope.phaseId, scope.submissionId]);

/** One portal's memory only: never local storage, server persistence or a shared singleton. */
export function createTeacherDraftStore(currentOwner: () => string | null) {
  const drafts = new Map<string, TeacherFeedbackDraft>();
  const listeners = new Set<() => void>();
  let owner = currentOwner(), epoch = 0;
  const syncOwner = () => {
    const current = currentOwner();
    if (current !== owner) { owner = current; drafts.clear(); epoch += 1; }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(key: string) { syncOwner(); return drafts.get(key) ?? EMPTY_TEACHER_DRAFT; },
    epoch() { syncOwner(); return epoch; },
    update(key: string, change: (draft: TeacherFeedbackDraft) => TeacherFeedbackDraft, expectedEpoch?: number) {
      syncOwner();
      if (expectedEpoch !== undefined && epoch !== expectedEpoch) return false;
      drafts.set(key, change(drafts.get(key) ?? EMPTY_TEACHER_DRAFT));
      listeners.forEach(listener => listener());
      return true;
    },
    clear() { drafts.clear(); owner = currentOwner(); epoch += 1; listeners.forEach(listener => listener()); },
  };
}
export type TeacherDraftStore = ReturnType<typeof createTeacherDraftStore>;
