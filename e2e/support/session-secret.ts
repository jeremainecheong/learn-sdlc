/**
 * The session secret every API the browser suite starts is given: the
 * config's own and any a spec spawns beside it. The API refuses to start
 * without a JWT_SECRET. This one is for the suite only: it is printed here, so
 * the API refuses it wherever a real secret is needed (PLACEHOLDER_JWT_SECRETS,
 * apps/api/src/config/auth.ts), and it is accepted on the suite's loopback bind.
 * apps/api/test/local-secrets.spec.ts reads this line and checks every start.
 */
export const E2E_JWT_SECRET = 'local-test-only-jwt-secret-refused-in-production';
