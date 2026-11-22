import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource, EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { DEFAULT_FIRST_SWEEP_DELAY_MS, resolveFirstSweepDelayMs } from '../config/retention';
import { AiCacheEntity, TaskResetEntity } from '../db/entities';
import { DAY_MS } from '../db/timestamps';

/**
 * How long a cached mentor reply is worth keeping. The cache is keyed by the
 * question and the workspace it was asked against, so a term-old entry is one
 * nobody will ask for again; it is a cache, and a miss costs a model call.
 */
export const AI_CACHE_MAX_AGE_DAYS = 30;

/**
 * How many copies a learner's reset keeps whole per task state. Older copies
 * keep their row and lose their bytes: `files` becomes `{}`, because the column
 * is NOT NULL. No surface restores from a copy, so an emptied copy misleads no
 * reader.
 */
export const RESET_COPIES_KEPT = 3;

/** Once a day, counted from the first sweep after a start ({@link BOOT_SWEEP_DELAY_MS}). */
export const SWEEP_INTERVAL_MS = DAY_MS;

/**
 * How long after a start the first sweep waits unless
 * RETENTION_FIRST_SWEEP_DELAY_MS says otherwise. See
 * DEFAULT_FIRST_SWEEP_DELAY_MS in config/retention.ts for why.
 */
export const BOOT_SWEEP_DELAY_MS = DEFAULT_FIRST_SWEEP_DELAY_MS;

/** What one sweep reclaimed. */
export interface SweepResult {
  /** Cache entries deleted. */
  cacheEntries: number;
  /** Learner reset copies whose bytes were emptied (`files = '{}'`); rows are kept. */
  resetCopies: number;
}

/** Expire replaceable AI caches while preserving all submitted evidence indefinitely.
 * Runs {@link BOOT_SWEEP_DELAY_MS} after a start (or RETENTION_FIRST_SWEEP_DELAY_MS)
 * and daily after that; a process that stops sooner never sweeps.
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionService.name);
  private bootTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dataSource: DataSource) {}

  /** The first sweep waits {@link BOOT_SWEEP_DELAY_MS} unless configured otherwise, then one runs every {@link SWEEP_INTERVAL_MS}. */
  onApplicationBootstrap(): void {
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      void this.sweepAndLog();
      this.timer = setInterval(() => {
        void this.sweepAndLog();
      }, SWEEP_INTERVAL_MS);
      this.timer.unref?.();
    }, resolveFirstSweepDelayMs());
    // Never the reason the process stays up: a sweep that has not come round
    // yet must not hold a CLI or a test run open.
    this.bootTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The whole deployment: both tables, and a line saying what went. */
  async sweepAndLog(): Promise<SweepResult> {
    try {
      const result = await this.sweep();
      if (result.cacheEntries || result.resetCopies) {
        this.logger.log(
          `retention sweep: preserved all submission evidence; deleted ${result.cacheEntries} mentor cache ` +
            `entr${result.cacheEntries === 1 ? 'y' : 'ies'} older than ${AI_CACHE_MAX_AGE_DAYS} days; ` +
            `emptied ${result.resetCopies} reset cop${result.resetCopies === 1 ? 'y' : 'ies'} ` +
            `beyond the newest ${RESET_COPIES_KEPT} per task`,
        );
      }
      return result;
    } catch (error) {
      // A sweep is housekeeping. It must never be the reason a class cannot
      // start, so it is logged and the next one tries again.
      this.logger.warn(`retention sweep failed, will try again later: ${(error as Error).message}`);
      return { cacheEntries: 0, resetCopies: 0 };
    }
  }

  async sweep(now = new Date()): Promise<SweepResult> {
    return {
      cacheEntries: await this.pruneAiCache(now),
      resetCopies: await this.pruneResetCopies(),
    };
  }

  /**
   * Bound the learner reset copies by bytes. Every
   * `task_resets` row outside the newest {@link RESET_COPIES_KEPT} per
   * `taskStateId` (ordered `createdAt DESC, id DESC`; the writer mints UUIDv7
   * ids, so the order is total on sqlite's one-second clock) and not already
   * empty gets `files = '{}'`. No row is deleted.
   *
   * **No boot-time writer.** The sweep does not run at boot by default (the
   * first waits {@link BOOT_SWEEP_DELAY_MS}), because a deployment step may
   * compare every table before and after a start. With
   * no `task_resets` row this issues one read and no write; with rows, only a
   * row beyond the newest three that still holds bytes is written, so a second
   * sweep writes nothing.
   */
  async pruneResetCopies(): Promise<number> {
    const manager = this.dataSource.manager;
    const table = manager.connection.getMetadata(TaskResetEntity).tableName;
    const any = await manager.query(`SELECT 1 AS one FROM "${table}" LIMIT 1`);
    if (!any.length) return 0;
    const stale: { id: string }[] = await manager.query(
      `SELECT "id" FROM (SELECT "id", "files", ROW_NUMBER() OVER (PARTITION BY "taskStateId" ` +
        `ORDER BY "createdAt" DESC, "id" DESC) AS "rank" FROM "${table}") ranked ` +
        `WHERE ranked."rank" > ${RESET_COPIES_KEPT} AND ranked."files" <> '{}'`,
    );
    if (!stale.length) return 0;
    let emptied = 0;
    for (let i = 0; i < stale.length; i += 500) {
      const ids = stale.slice(i, i + 500).map((row) => row.id);
      const result = await manager
        .createQueryBuilder()
        .update(TaskResetEntity)
        .set({ files: {} })
        .where('id IN (:...ids)', { ids })
        .andWhere(`files <> '{}'`)
        .execute();
      emptied += result.affected ?? 0;
    }
    return emptied;
  }

  /** Cached replies older than the window. A miss is a model call, not a loss. */
  private async pruneAiCache(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - AI_CACHE_MAX_AGE_DAYS * DAY_MS);
    const manager = this.dataSource.manager;
    const result = await manager
      .createQueryBuilder()
      .delete()
      .from(AiCacheEntity)
      .where('createdAt < :cutoff', { cutoff: storedDate(manager, AiCacheEntity, 'createdAt', cutoff) })
      .execute();
    return result.affected ?? 0;
  }
}

/**
 * A `Date` in the form the driver put in the column. Postgres keeps a
 * timestamp and takes the date itself; sqlite keeps `YYYY-MM-DD HH:MM:SS.mmm`
 * in UTC, and comparing an ISO string against that compares text with a `T`
 * and a `Z` in it against text without.
 */
function storedDate(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
  property: string,
  value: Date,
): unknown {
  const column = manager.connection.getMetadata(entity).findColumnWithPropertyName(property)!;
  return manager.connection.driver.preparePersistentValue(value, column);
}
