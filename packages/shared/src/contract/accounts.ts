/**
 * Accounts: the roles, the signed-in user's profile, the sign-in
 * responses, and what the admin console shows about accounts and classes.
 */

export type Role = 'LEARNER' | 'INSTRUCTOR' | 'ADMIN';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatar?: number;
  bio?: string;
  goals?: string;
  onboardingCompleted?: boolean;
  profileVersion?: number;
  role: Role;
  cohort: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export type RegisterResponse = AuthResponse | {
  confirmationRequired: true;
  email: string;
};

/**
 * Which ways in this deployment has, so the sign-in page can offer only the
 * ones that will work. Google sign-in is configuration, not a build flag.
 */
export interface AuthProviders {
  google: boolean;
  authProvider?: 'local' | 'cognito';
  confirmationRequired?: boolean;
  ssoProviders?: Array<{ id: string; label: string }>;
  passwordChange?: boolean;
  accountDeletion?: boolean;
}

/* ---------------------------------- admin -------------------------------- */

/** What the admin console shows about an account. Never the hash, never the token version. */
export interface AdminUserView {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  cohort: string;
  /** Resolved from the cohorts table; null for 'default' or a cohort since deleted. */
  cohortName: string | null;
  disabledAt: string | null;
  createdAt: string;
}

export interface AdminCohortView {
  id: string;
  name: string;
  joinCode: string;
  ownerUserId: string;
  ownerEmail: string | null;
  memberCount: number;
}
