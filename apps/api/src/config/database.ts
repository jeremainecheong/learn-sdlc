/** The sqlite file the API uses when DB_PATH names none, relative to the working directory. */
export const DEFAULT_DB_PATH = 'data/learnsdlc.sqlite';

/**
 * Whether this process applies versioned migrations at boot. Production
 * defaults to yes, but an explicit RUN_MIGRATIONS=false is honoured so that
 * replicas can leave the one-shot migration step to the deploy (runbook §6).
 * Turning migrations off never turns schema auto-sync on: see schemaSync.
 */
export function resolveRunMigrations(env = process.env): boolean {
  if (env.RUN_MIGRATIONS === 'true') return true;
  if (env.RUN_MIGRATIONS === 'false') return false;
  return env.NODE_ENV === 'production';
}

/**
 * TypeORM's `synchronize` infers DDL from the entities and will drop or
 * rewrite a column on a model change. That is a convenience for an empty
 * development database and a data-loss bug against real learner data, so it
 * is on only outside production and only when migrations are not in use.
 */
export function resolveSchemaSync(env = process.env): boolean {
  return env.NODE_ENV !== 'production' && !resolveRunMigrations(env);
}
