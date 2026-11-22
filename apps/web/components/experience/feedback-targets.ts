import type { ArtifactKind, PhaseSummary } from '@learnsdlc/shared';
import { roomHref } from '@/components/shell/routes';

/** `artifactKind`, where the caller knows it, lets a review in flight name what it runs. */
export type FeedbackPhase = Pick<PhaseSummary, 'id' | 'key' | 'status'> & { artifactKind?: ArtifactKind };

/** Use retained file names as the allowlist; never turn arbitrary reviewer prose into a URL. */
export function feedbackFileReferences(text: string, paths: string[]): string[] {
  return paths.filter(path => {
    if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f]/.test(path) || path.split('/').some(part => part === '.' || part === '..') || /^[a-z][a-z\d+.-]*:/i.test(path)) return false;
    let at = text.indexOf(path);
    while (at !== -1) {
      const before = at === 0 ? '' : text[at - 1];
      const after = text[at + path.length] ?? '';
      const periodEndsSentence = after === '.' && !/[\w/.-]/.test(text[at + path.length + 1] ?? '');
      if ((!before || /[\s`'"([{]/.test(before)) && (!after || /[\s`'"\])},:;]/.test(after) || periodEndsSentence)) return true;
      at = text.indexOf(path, at + path.length);
    }
    return false;
  });
}

/** Requirements revisions start in the backlog, where the learner can edit the story. */
export function feedbackRevisionHref(phase: FeedbackPhase, file?: string): string {
  if (phase.status === 'locked') return '/phases';
  const base = `/workspace/${encodeURIComponent(phase.id)}`;
  if (file) return `${base}${phase.key === 'requirements' ? '/issue' : ''}?${new URLSearchParams({ file })}`;
  if (phase.key === 'requirements') return `${base}/issue`;
  return roomHref(phase);
}

export function submittedFileAnchor(submissionId: string, path: string): string {
  return `submitted-file-${encodeURIComponent(submissionId)}-${encodeURIComponent(path)}`;
}
