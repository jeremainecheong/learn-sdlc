import type { EntitySubscriberInterface, InsertEvent, UpdateEvent } from 'typeorm';
import { demoNow, isDemoClockInstalled } from './demo-clock';

/**
 * The half of the demo clock that `globalThis.Date` cannot reach.
 *
 * A `@CreateDateColumn` is not written by JavaScript: TypeORM sends no value
 * for it and the column default fires in the database, so a patched `Date`
 * moves `phase_states.passedAt` (a `varchar` written with
 * `new Date().toISOString()`) and leaves `submissions.createdAt` on today.
 * Setting the property before the insert is what makes the two agree, because
 * `createValuesExpression` uses whatever value it finds.
 *
 * It only ever fills a column that is still undefined, so a caller that names
 * its own date (a migration, a restore, a fixture) keeps it. And it is inert
 * unless the clock is installed, so registering it costs an ordinary boot one
 * boolean per insert.
 */
export class DemoClockSubscriber implements EntitySubscriberInterface {
  beforeInsert(event: InsertEvent<Record<string, unknown>>): void {
    if (!isDemoClockInstalled()) return;
    const entity = event.entity as Record<string, unknown> | undefined;
    if (!entity) return;
    for (const column of event.metadata.columns) {
      if (!column.isCreateDate && !column.isUpdateDate) continue;
      if (entity[column.propertyName] !== undefined) continue;
      entity[column.propertyName] = demoNow();
    }
  }

  beforeUpdate(event: UpdateEvent<Record<string, unknown>>): void {
    if (!isDemoClockInstalled()) return;
    const entity = event.entity as Record<string, unknown> | undefined;
    if (!entity || !event.metadata) return;
    for (const column of event.metadata.columns) {
      if (!column.isUpdateDate) continue;
      entity[column.propertyName] = demoNow();
    }
  }
}
