import { DataSource, EntityManager } from 'typeorm';
import { UserEntity } from '../db/entities';
import { PreviewSessionEntity } from './preview-session.entity';
import { rowLock } from '../db/atomic';

const SQLITE_WRITERS = new WeakMap<DataSource, Promise<unknown>>();
const RESERVATION_LOCK = 73482916;

/** The same short DB reservation serializes capacity/ownership on every API.
 * No runner/network operation runs inside this transaction. PostgreSQL is the
 * deployed authority; SQLite's one-connection test/local adapter queues writes. */
export class PreviewSessionStore {
  constructor(private readonly source: DataSource) {}

  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const run = () => this.source.transaction(async manager => {
      if (this.source.options.type === 'postgres') await manager.query('SELECT pg_advisory_xact_lock($1)', [RESERVATION_LOCK]);
      return work(manager);
    });
    if (this.source.options.type === 'postgres') return run();
    const previous = SQLITE_WRITERS.get(this.source) ?? Promise.resolve();
    const next = previous.then(run, run);
    SQLITE_WRITERS.set(this.source, next.then(() => undefined, () => undefined));
    return next;
  }

  all(): Promise<PreviewSessionEntity[]> {
    return this.source.getRepository(PreviewSessionEntity).find({ order: { createdAt: 'DESC', id: 'DESC' } });
  }

  get(id: string): Promise<PreviewSessionEntity | null> {
    return this.source.getRepository(PreviewSessionEntity).findOneBy({ id });
  }

  async current(row: PreviewSessionEntity, manager = this.source.manager): Promise<boolean> {
    const user = await manager.findOne(UserEntity, {
      where: { id: row.userId }, select: ['id', 'tokenVersion', 'disabledAt'],
      ...(manager.queryRunner?.isTransactionActive ? rowLock(this.source, 'pessimistic_read') : {}),
    });
    return !!user && !user.disabledAt && user.tokenVersion === row.tokenVersion;
  }

  async change(id: string, mutate: (row: PreviewSessionEntity, manager: EntityManager) => Promise<boolean> | boolean): Promise<PreviewSessionEntity | null> {
    return this.transaction(async manager => {
      const row = await manager.findOneBy(PreviewSessionEntity, { id });
      if (!row || !await mutate(row, manager)) return row;
      row.revision += 1;
      return manager.save(PreviewSessionEntity, row);
    });
  }
}
