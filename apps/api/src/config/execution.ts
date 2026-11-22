/**
 * PREBAKE_PROBE=true runs the runner's start-up probe under NODE_ENV=test as
 * well. Tests skip it otherwise, because it spawns the real runner.
 */
export function resolvePrebakeProbeInTests(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PREBAKE_PROBE === 'true';
}

/**
 * The credentials the Lambda client signs with when AWS_ENDPOINT_URL points
 * at a local emulator. The emulator accepts any pair, so 'test' stands in for
 * an unset key.
 */
export function resolveLocalAwsCredentials(env: NodeJS.ProcessEnv = process.env): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || 'test',
  };
}

/** RUNNER_STARTUP_OWNER_ID: the owner id the start-up probe runs as, or undefined for a fresh one. */
export function resolveStartupOwnerId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RUNNER_STARTUP_OWNER_ID;
}
