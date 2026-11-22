/** Trusted, bounded messages between the API and its password workers. */
export const PASSWORD_BCRYPT_ROUNDS = 12;
export const PASSWORD_WORKERS = 2;
export const PASSWORD_PENDING_BYTES = 16 * 1024 * 1024;
export const PASSWORD_INPUT_BYTES = 4 * 1024 * 1024;

export type PasswordRequest =
  | { type: 'hash'; id: string; password: string }
  | { type: 'compare'; id: string; password: string; encoded: string };

export type PasswordReply =
  | { type: 'ready' }
  | { type: 'result'; id: string; value: string | boolean }
  | { type: 'failed'; id: string };
