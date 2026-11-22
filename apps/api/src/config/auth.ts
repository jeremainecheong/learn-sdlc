import type { JwtSignOptions } from '@nestjs/jwt';
import { API_PREFIX, DEFAULT_API_PORT } from './http';
import { nonNegativeInt, positiveInt } from './parse';

/** Selecting managed identity is explicit and incomplete configuration cannot fall back. */
export function resolveCognitoConfig(env = process.env) {
  const authProvider = env.AUTH_PROVIDER || 'local';
  if (authProvider !== 'local' && authProvider !== 'cognito') {
    throw new Error('AUTH_PROVIDER must be local or cognito');
  }
  const cognitoUserPoolId = (env.COGNITO_USER_POOL_ID || '').trim();
  const cognitoClientId = (env.COGNITO_CLIENT_ID || '').trim();
  const cognitoDomain = (env.COGNITO_DOMAIN || '').trim().replace(/\/$/, '');
  const cognitoRedirectUrl = (env.COGNITO_REDIRECT_URL || '').trim();
  const cognitoProviders = [...new Set((env.COGNITO_PROVIDERS || '').split(',').map((s) => s.trim()).filter(Boolean))];
  const cognitoMigrationSecret = env.COGNITO_MIGRATION_SECRET || '';
  if (authProvider === 'cognito') {
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(cognitoUserPoolId)) {
      throw new Error('COGNITO_USER_POOL_ID must name the intended AWS user pool');
    }
    if (!/^[a-z0-9]{1,128}$/.test(cognitoClientId)) throw new Error('COGNITO_CLIENT_ID is required');
    let domain: URL;
    let redirect: URL;
    try {
      domain = new URL(cognitoDomain);
      redirect = new URL(cognitoRedirectUrl);
    } catch { throw new Error('COGNITO_DOMAIN and COGNITO_REDIRECT_URL must be absolute URLs'); }
    if (domain.protocol !== 'https:' || domain.username || domain.password || domain.port ||
        domain.pathname !== '/' || domain.search || domain.hash) {
      throw new Error('COGNITO_DOMAIN must be an HTTPS origin');
    }
    const localRedirect = redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname);
    if ((!localRedirect && redirect.protocol !== 'https:') || redirect.username || redirect.password ||
        redirect.search || redirect.hash || redirect.pathname !== `${API_PREFIX}/auth/sso/callback`) {
      throw new Error('COGNITO_REDIRECT_URL must be the exact HTTPS SSO callback (HTTP only on localhost)');
    }
    if (cognitoProviders.some((provider) => !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(provider))) {
      throw new Error('COGNITO_PROVIDERS must contain configured provider names');
    }
    if (cognitoMigrationSecret && !/^[a-f0-9]{64}$/.test(cognitoMigrationSecret)) {
      throw new Error('COGNITO_MIGRATION_SECRET must be a 32-byte lowercase hexadecimal key');
    }
  }
  return { authProvider: authProvider as 'local' | 'cognito', cognitoUserPoolId,
    cognitoClientId, cognitoDomain, cognitoRedirectUrl, cognitoProviders, cognitoMigrationSecret };
}

/** Password CPU work is bounded independently of request/AI rate limits. */
export function resolvePasswordWork(env = process.env) {
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum || Number(raw) > maximum) {
      throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
    }
    return Number(raw);
  };
  return {
    passwordWorkQueueLimit: integer('PASSWORD_WORK_QUEUE_LIMIT', 64, 1, 128),
    passwordWorkTimeoutMs: integer('PASSWORD_WORK_TIMEOUT_MS', 30_000, 1_000, 60_000),
    passwordWorkIdleMs: integer('PASSWORD_WORK_IDLE_MS', 30_000, 1_000, 60_000),
  };
}

/** Preserve jsonwebtoken's duration grammar and validation at the env boundary. */
export function resolveJwtExpiresIn(env = process.env): NonNullable<JwtSignOptions['expiresIn']> {
  // Nest's newer types constrain strings to the ms duration template. Environment
  // values remain runtime input: do not coerce numeric strings into seconds or
  // silently replace invalid values; jsonwebtoken rejects them when signing.
  return (env.JWT_EXPIRES_IN || '7d') as NonNullable<JwtSignOptions['expiresIn']>;
}

/**
 * Secrets that are published, and therefore not secrets: the placeholders
 * that appear in this repository's files and documents, and whatever
 * .env.example carries, because scripts/setup.sh copies that file to .env and
 * docker-compose.yml reads it. A value printed in a public repository signs an
 * admin token just as well as a real one. scripts/lib/common.sh keeps the same
 * list (published_jwt_secret), so setup.sh replaces any of these in .env. The
 * length floor is the rest of the answer: a short secret is brute-forceable
 * whether or not anyone has published it.
 */
export const PLACEHOLDER_JWT_SECRETS: ReadonlySet<string> = new Set([
  'dev-secret-change-me-in-production',
  'change-me-in-production',
  'changeme',
  'change-me',
  'secret',
  'jwt-secret',
  'please-change-me',
  // The browser suite (playwright.config.ts) and the CI jobs that start the
  // API on loopback pass this one. It is printed in those files, so it is
  // refused wherever a real secret is required.
  'local-test-only-jwt-secret-refused-in-production',
]);
const MIN_JWT_SECRET_BYTES = 32;

/**
 * Why the secret held in the variable `name` cannot be used on a deployment
 * other people reach, or null. A key that HMACs or signs anything a learner
 * sees must be neither a shipped placeholder nor shorter than 32 bytes.
 */
export function secretProblem(name: string, secret: string | undefined): string | null {
  const value = (secret || '').trim();
  if (!value) return `${name} is not set`;
  if (PLACEHOLDER_JWT_SECRETS.has(value.toLowerCase())) {
    return `${name} is one of the placeholders this repository ships`;
  }
  if (Buffer.byteLength(value, 'utf8') < MIN_JWT_SECRET_BYTES) {
    return `${name} is shorter than ${MIN_JWT_SECRET_BYTES} bytes`;
  }
  return null;
}

/** Why this JWT secret cannot be used on a deployment other people reach, or null. */
export function jwtSecretProblem(secret: string | undefined): string | null {
  return secretProblem('JWT_SECRET', secret);
}

/**
 * Which addresses Google sign-in will accept, lower-cased and without the
 * leading "@". Empty means any address Google will vouch for, which is the
 * right default for a public deployment and the wrong one for a school: a
 * single institution sets ALLOWED_EMAIL_DOMAINS=uni.example.edu and nobody else's
 * Google account can walk in.
 */
export function resolveAllowedEmailDomains(env = process.env): string[] {
  return (env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * The address Google sends the browser back to. It has to match a redirect
 * URI registered on the OAuth client character for character, so it is
 * settable outright; the default is this API's own public origin, which is
 * right for development (:4000) and for the e2e ports (:4100) without anyone
 * setting anything.
 */
export function resolveGoogleRedirectUrl(env = process.env): string {
  if (env.GOOGLE_REDIRECT_URL) return env.GOOGLE_REDIRECT_URL.trim();
  const port = nonNegativeInt(env.API_PORT) ?? DEFAULT_API_PORT;
  const origin = (env.API_PUBLIC_URL || `http://localhost:${port}`)
    .trim()
    .replace(/\/$/, '');
  return `${origin}${API_PREFIX}/auth/google/callback`;
}

/**
 * Sign-in attempts one address may make per minute across every account.
 *
 * A class arrives through one venue NAT, so this is a room-sized number rather
 * than a person-sized one; the per-account limit beside it in
 * `auth/auth.controller.ts` is what stops a password being guessed. Lower it only where
 * every learner has their own address.
 */
export function resolveSignInMaxPerAddress(env = process.env): number {
  return positiveInt(env.SIGNIN_MAX_PER_ADDRESS) ?? 200;
}
