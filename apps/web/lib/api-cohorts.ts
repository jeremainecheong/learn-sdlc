'use client';

import type { CohortView } from '@learnsdlc/shared';
import { request } from './api';

export type Cohort = CohortView;

export const cohortsApi = {
  create: (name: string) => request<Cohort>('POST', '/instructor/cohorts', { name }),
  mine: () => request<Cohort[]>('GET', '/instructor/cohorts'),
  join: (code: string) => request<Cohort>('POST', '/enrollments/join', { code }),
};

/** ABCD-EFGH reads better off a slide than ABCDEFGH; the API strips the dash back out. */
export function formatJoinCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
