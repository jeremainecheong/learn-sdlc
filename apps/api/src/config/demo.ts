/**
 * Whether this process may move its clock at all. Exactly `'true'`: a variable
 * left over from another shell, a `1`, or a `yes` are all somebody who did not
 * mean this. Read at call time, because a spec sets and clears DEMO_CLOCK
 * while the process runs.
 */
export function resolveDemoClockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEMO_CLOCK === 'true';
}
