/** SENTRY_DSN: where unhandled errors are reported; undefined or '' turns reporting off. */
export function resolveSentryDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SENTRY_DSN;
}

/** APP_VERSION: the build this process runs, or undefined when the image named none. */
export function resolveAppVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.APP_VERSION || undefined;
}

/** METRICS_TOKEN: the bearer token a /metrics scrape must present, or undefined. */
export function resolveMetricsToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.METRICS_TOKEN;
}
