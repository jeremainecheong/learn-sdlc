/**
 * The class map the instructor's console draws: phases, nodes, the queue
 * and the lecture points.
 */

import type { PhaseKey } from '../phases';

/* ------------------------------- class map ------------------------------- */

export interface ClassMapNode {
  id: string;
  label: string;
  kind: 'phase' | 'story' | 'contract' | 'function' | 'test' | 'mutant' | 'file' | 'change';
  phase: PhaseKey;
  green: number;
  red: number;
  missing: number;
}

export interface ClassMapPhase {
  key: PhaseKey;
  order: number;
  title: string;
  counts: { locked: number; in_progress: number; submitted: number; passed: number };
  averageScore: number | null;
  /** The middle best score in the phase; what the console prints. */
  medianScore: number | null;
  averageAttempts: number;
  averageHints: number;
  flagged: number;
  nodes: ClassMapNode[];
}

export interface ClassQueueItem {
  userId: string;
  displayName: string;
  email: string;
  phaseKey: PhaseKey;
  reason: string;
  since: string | null;
  /** Submissions in that phase, and the best they scored: the queue's second line. */
  attempts: number;
  bestScore: number | null;
}

export interface LecturePoint {
  title: string;
  detail: string;
  phaseKey: PhaseKey;
  count: number;
}

export interface ClassMapView {
  projectSlug: string;
  totalLearners: number;
  phases: ClassMapPhase[];
  queue: ClassQueueItem[];
  lecturePoints: LecturePoint[];
}
