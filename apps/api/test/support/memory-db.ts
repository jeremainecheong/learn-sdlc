import { DataSource } from 'typeorm';
import { serialiseSqliteTransactions } from '../../src/db/database.module';
import { ALL_ENTITIES } from '../../src/db/entities';

export interface MemoryDataSourceOptions {
  /**
   * Queue transactions one after another, as the application's own SQLite
   * connection does (`serialiseSqliteTransactions`). Off by default, which is
   * a plain TypeORM DataSource.
   */
  serialised?: boolean;
}

/**
 * An initialised in-memory SQLite DataSource with every entity's table
 * created from the entity definitions (no migrations). The caller destroys
 * it when done.
 */
export async function memoryDataSource({ serialised = false }: MemoryDataSourceOptions = {}): Promise<DataSource> {
  const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: ALL_ENTITIES, synchronize: true });
  await dataSource.initialize();
  return serialised ? serialiseSqliteTransactions(dataSource) : dataSource;
}
