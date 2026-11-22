'use client';

import type { AdminCohortView, AdminUserView, Role } from '@learnsdlc/shared';
import { request } from './api';

export type AdminUser = AdminUserView;
export type AdminCohort = AdminCohortView;

export interface AdminUserPatch {
  role?: Role;
  cohort?: string;
  disabled?: boolean;
}

export const adminApi = {
  lookup: (email: string) =>
    request<AdminUser>('GET', `/admin/users?email=${encodeURIComponent(email.trim())}`),
  cohorts: () => request<AdminCohort[]>('GET', '/admin/cohorts'),
  update: (id: string, patch: AdminUserPatch) =>
    request<AdminUser>('PATCH', `/admin/users/${encodeURIComponent(id)}`, patch),
  setPassword: (id: string, password: string) =>
    request<{ changed: true }>('POST', `/admin/users/${encodeURIComponent(id)}/password`, {
      password,
    }),
};
