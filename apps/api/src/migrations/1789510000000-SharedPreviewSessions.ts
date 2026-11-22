import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/** Additive only: existing coursework and historical execution records are untouched.
 * Deploy after draining old process-local previews. Old sessions have no durable
 * capability hash to migrate, so their URLs must expire before the new API starts. */
export class SharedPreviewSessions1789510000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const postgres = runner.connection.options.type === 'postgres';
    await runner.createTable(new Table({
      name: 'preview_sessions',
      columns: [
        { name: 'id', type: 'varchar', length: '24', isPrimary: true },
        { name: 'userId', type: 'varchar' },
        { name: 'phaseStateId', type: 'varchar' },
        { name: 'tokenVersion', type: 'integer' },
        { name: 'runnerId', type: 'varchar', isNullable: true },
        { name: 'capabilityHash', type: 'varchar', length: '64' },
        { name: 'status', type: 'varchar', length: '16' },
        { name: 'cleanupPending', type: 'boolean', default: postgres ? 'false' : '0' },
        { name: 'revision', type: 'integer', default: 0 },
        { name: 'state', type: 'text' },
        { name: 'createdAt', type: postgres ? 'timestamp' : 'datetime', default: postgres ? 'now()' : "datetime('now')" },
      ],
    }));
    await runner.createIndices('preview_sessions', [
      new TableIndex({ name: 'IDX_preview_sessions_owner_phase', columnNames: ['userId', 'phaseStateId'] }),
      new TableIndex({ name: 'IDX_preview_sessions_status', columnNames: ['status', 'cleanupPending'] }),
      new TableIndex({ name: 'UQ_preview_sessions_capability', columnNames: ['capabilityHash'], isUnique: true }),
    ]);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Reverting an app release may leave this additive table intact. Explicit
    // migration reversal must never erase live ownership or unresolved cleanup.
    const [row] = await runner.query('SELECT COUNT(*) AS n FROM "preview_sessions"');
    if (Number(row.n) !== 0) throw new Error('Drain previews and resolve retained preview records before reversing SharedPreviewSessions.');
    await runner.dropTable('preview_sessions');
  }
}
