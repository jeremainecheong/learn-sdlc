import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettingEntity } from '../db/entities';
import { NULL_PIN_RECEIPT_KEY, nullPinLine, pinNullRows, type NullPinResult } from './null-pin';
import { appendRun, readReceipt } from './receipts';

/**
 * The null-pin pass at boot: first in the seed's bootstrap, before
 * the content import, so a null pin is pinned to the version it read before
 * this boot can publish another (`SeedService.onApplicationBootstrap`), and
 * first in the CLI importer for the same reason (`cli/import-pack.ts`).
 *
 * It is not part of the re-pin: the re-pin's early returns never skip it,
 * and it adds nothing to the re-pin's result or its receipts.
 *
 * Every run writes `null-pin.receipt` and prints the boot line, its counts
 * included when they are 0: `pinnedFromNull` is a
 * running total and `pinnedProjects` the running total of each run's project
 * count, `unpinnedNoHead` and `unpinnedProjects` the latest run's, and `runs`
 * the last `RECEIPT_RUNS` runs with their own counts. Counts only: never an
 * enrolment, a learner, a project id or a slug. A pass that cannot finish
 * throws, and the caller stops before its import.
 *
 * The first boot that writes this receipt runs on one API instance, as the
 * re-pin's does: the receipt is read, then inserted, so two first
 * boots side by side would both insert it and the loser's boot would stop on
 * the unique key. Every later boot updates the row it finds.
 */
@Injectable()
export class NullPinService {
  private readonly logger = new Logger(NullPinService.name);

  constructor(private readonly dataSource: DataSource) {}

  async run(): Promise<NullPinResult> {
    const result = await this.dataSource.transaction(async (manager) => {
      const counted = await pinNullRows(manager);
      const was = await readReceipt(manager, NULL_PIN_RECEIPT_KEY);
      const total = (key: 'pinnedFromNull' | 'pinnedProjects') => (typeof was[key] === 'number' ? (was[key] as number) : 0) + counted[key];
      const at = new Date().toISOString();
      const receipt = {
        at,
        pinnedFromNull: total('pinnedFromNull'),
        pinnedProjects: total('pinnedProjects'),
        unpinnedNoHead: counted.unpinnedNoHead,
        unpinnedProjects: counted.unpinnedProjects,
        runs: appendRun(was.runs, { at, ...counted }),
      };
      await manager.save(manager.create(SettingEntity, { key: NULL_PIN_RECEIPT_KEY, value: JSON.stringify(receipt) }));
      return counted;
    });
    this.logger.log(nullPinLine(result));
    return result;
  }
}
