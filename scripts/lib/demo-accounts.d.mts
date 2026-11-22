// The types of scripts/lib/demo-accounts.mjs, for the TypeScript that imports
// it (e2e/passing-work.ts, which the browser specs take the staff accounts from).

export declare const DEMO_INSTRUCTOR_EMAIL: string;
export declare const DEMO_ADMIN_EMAIL: string;
export declare const DEMO_INSTRUCTOR_DEFAULT_PASSWORD: string;
export declare const DEMO_ADMIN_DEFAULT_PASSWORD: string;
/** The native demo's instructor. SEED_PASSWORD, when set, is both accounts' password. */
export declare const DEMO_INSTRUCTOR: Readonly<{ email: string; password: string }>;
/** The native demo's administrator, on the same SEED_PASSWORD rule. */
export declare const DEMO_ADMIN: Readonly<{ email: string; password: string }>;
/** The .env.verify key that holds the local Compose stack's instructor password. */
export declare const STACK_INSTRUCTOR_PASSWORD_KEY: string;
/** The local Compose stack's instructor, on the password generated for this machine (from .env.verify). */
export declare function stackInstructor(
  env: Record<string, string>,
): Readonly<{ email: string; password: string; displayName: string }>;
