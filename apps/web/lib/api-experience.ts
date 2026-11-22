'use client';

import type {
  CohortView,
  SubmissionView,
  UserProfile,
} from '@learnsdlc/shared';
import { request } from './api';

export interface TeacherFeedback {
  id: string;
  submissionId: string;
  phaseStateId: string;
  userId: string;
  cohortId: string;
  authorUserId: string;
  authorName: string;
  action: 'comment' | 'acknowledge' | 'request_revision';
  text: string;
  createdAt: string;
}

/** The teacher's sign-off of one revision. No name, email or id. */
export interface SubmissionSignOff {
  signedOff: boolean;
  reason: string | null;
  signedOffAt: string | null;
}

export type SubmissionHistoryItem = Pick<
  SubmissionView,
  'id' | 'status' | 'passed' | 'createdAt' | 'commitMessage' | 'attempt'
> & {
  phaseStateId: string;
  verifiedPass: boolean;
  /** The review failed to produce an assessment, independently of its stored passed flag. */
  reviewUnavailable?: boolean;
};
interface HistoryPage {
  items: SubmissionHistoryItem[];
  nextCursor: string | null;
  total: number;
}

async function allHistory(path: string): Promise<SubmissionHistoryItem[]> {
  const rows = new Map<string, SubmissionHistoryItem>();
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const page: HistoryPage = await request(
      'GET',
      `${path}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    );
    page.items.forEach((item) => rows.set(item.id, item));
    after = page.nextCursor;
    if (after && cursors.has(after))
      throw new Error(
        'The review history cursor did not advance. Please refresh.',
      );
    if (after) cursors.add(after);
  } while (after);
  const attempts = new Map<string, number>();
  return [...rows.values()].map((row) => {
    const attempt = (attempts.get(row.phaseStateId) ?? 0) + 1;
    attempts.set(row.phaseStateId, attempt);
    return { ...row, attempt };
  });
}

export const experienceApi = {
  saveProfile: (fields: {
    baseVersion: number;
    displayName: string;
    avatar: number;
    bio: string;
    goals: string;
  }) => request<UserProfile>('PATCH', '/account/profile', fields),
  classroom: async () => {
    const result = await request<{ classroom: CohortView | null }>(
      'GET',
      '/enrollments/classroom',
    );
    if (!Object.prototype.hasOwnProperty.call(result, 'classroom'))
      throw new Error(
        'The class membership response was incomplete. Please refresh.',
      );
    return result.classroom;
  },
  leave: () => request<{ left: true }>('POST', '/enrollments/leave'),
  teacherFeedback: (id: string) =>
    request<TeacherFeedback[]>(
      'GET',
      `/submissions/${encodeURIComponent(id)}/teacher-feedback`,
    ),
  writeFeedback: (
    id: string,
    data: Pick<TeacherFeedback, 'action' | 'text'> & { requestId: string },
  ) =>
    request<TeacherFeedback>(
      'POST',
      `/submissions/${encodeURIComponent(id)}/teacher-feedback`,
      data,
    ),
  /** Whether the teacher signed this revision off, and why. */
  submissionSignOff: (id: string) =>
    request<SubmissionSignOff>(
      'GET',
      `/submissions/${encodeURIComponent(id)}/sign-off`,
    ),
  teacherEvidence: (id: string) =>
    request<SubmissionView>(
      'GET',
      `/submissions/${encodeURIComponent(id)}/teacher-evidence`,
    ),
  history: (project: string) =>
    allHistory(
      `/submissions/review-history/pages?project=${encodeURIComponent(project)}`,
    ),
  /**
   * One learner's review history, for the teacher reading it.
   *
   * The project is the **learner's**, not the reader's, so the browser names
   * none: pinning the query to the shipped slug would answer for the wrong
   * project the moment a class is assigned another one. With no
   * `?project` the API resolves the learner it was asked about
   * (`submission-feedback.service.ts`), which is the only place that can.
   */
  teacherSubmissions: (userId: string, phaseId: string) =>
    allHistory(
      `/submissions/learner-history/${encodeURIComponent(userId)}?phaseId=${encodeURIComponent(phaseId)}`,
    ),
};
