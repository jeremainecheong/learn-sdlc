import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './database.module';

/**
 * Standalone DataSource for the TypeORM CLI (migration generate/run/revert).
 * Reads the same configuration as the running app, so a migration is always
 * generated against the schema the app would actually use.
 *
 *   npm run migration:generate -w @learnsdlc/api -- src/migrations/Name
 *   npm run migration:run -w @learnsdlc/api
 */
export default new DataSource(buildDataSourceOptions());
