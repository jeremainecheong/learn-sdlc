import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/auth.decorators';
import { config } from '../config';
import { AuditEventEntity } from '../db/entities';
import { DemoService } from './demo.service';
import {
  advanceBy,
  demoNow,
  demoOffsetMs,
  disengage,
  engageAt,
  isDemoClockInstalled,
  realNow,
} from './demo-clock';
import { DemoClockSubscriber } from './demo-clock.subscriber';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The two halves of the clock, proved apart.
 *
 * The patch on `globalThis.Date` moves everything JavaScript writes. It does
 * not move a `@CreateDateColumn`, because TypeORM sends no value for one and
 * the column default fires in sqlite, so the first test here inserts the same
 * row twice, once with the subscriber registered and once without, and the
 * difference between the two dates is the subscriber's whole contribution.
 */
describe('the demo clock', () => {
  const RealDate = Date;
  /** Far enough from any real run that a stray real date is unmistakable. */
  const AUGUST = new Date('2026-08-10T09:30:00.000Z');

  afterEach(() => {
    disengage();
  });

  it('reports the moved time to everything that reads Date', () => {
    engageAt(AUGUST);
    expect(new Date().toISOString().slice(0, 7)).toBe('2026-08');
    expect(demoNow().toISOString().slice(0, 7)).toBe('2026-08');
    // Within a second of what was asked for: the offset is fixed at engage
    // time and the clock keeps running from there.
    expect(Math.abs(Date.now() - AUGUST.getTime())).toBeLessThan(1000);
  });

  it('leaves a date somebody handed it alone', () => {
    engageAt(AUGUST);
    // A clock that reinterpreted an argument would break every ISO string the
    // services parse back out of a varchar column.
    expect(new Date('2024-01-02T03:04:05.000Z').toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(Date.parse('2024-01-02T03:04:05.000Z')).toBe(1704164645000);
  });

  it('winds back for a term that started five weeks ago', () => {
    const fiveWeeks = 35 * 86_400_000;
    engageAt(new Date(realNow() - fiveWeeks));
    expect(realNow() - Date.now()).toBeGreaterThan(fiveWeeks - 1000);
    expect(demoOffsetMs()).toBeLessThan(0);
  });

  it('only ever moves forward on a span', () => {
    engageAt(new Date(realNow() - 86_400_000));
    const before = demoOffsetMs();
    advanceBy(-86_400_000);
    // A replay walks a term forward; a negative step would write a submission
    // before the phase that holds it.
    expect(demoOffsetMs()).toBe(before);
    advanceBy(3_600_000);
    expect(demoOffsetMs()).toBe(before + 3_600_000);
  });

  it('answers instanceof for a date the real constructor made', () => {
    const madeBefore = new Date('2024-01-02T03:04:05.000Z');
    engageAt(AUGUST);
    // TypeORM converts a Date to the string sqlite stores behind exactly this
    // check (DateUtils.mixedDateToUtcDatetimeString), and skips anything that
    // is not one, so a patch that failed it bound a raw object and the insert
    // died with "SQLite3 can only bind numbers, strings, bigints, buffers, and
    // null".
    expect(madeBefore instanceof Date).toBe(true);
    expect(new Date() instanceof Date).toBe(true);
    expect(demoNow() instanceof Date).toBe(true);
    expect(({} as unknown) instanceof Date).toBe(false);
  });

  it('puts the original constructor back on disengage', () => {
    engageAt(AUGUST);
    expect(isDemoClockInstalled()).toBe(true);
    expect(globalThis.Date).not.toBe(RealDate);

    disengage();

    expect(isDemoClockInstalled()).toBe(false);
    expect(globalThis.Date).toBe(RealDate);
    expect(Math.abs(Date.now() - realNow())).toBeLessThan(50);
  });

  describe('and the createDate columns the patch cannot reach', () => {
    let db: DataSource;

    const insertAudit = async (): Promise<Date> => {
      const row = await db.manager.save(
        db.manager.create(AuditEventEntity, {
          event: 'cohort.create',
          actorUserId: 'actor',
          subjectUserId: 'subject',
          targetId: null,
          action: 'a class',
          reason: null,
          detail: null,
        }),
      );
      const reloaded = await db.manager.findOneByOrFail(AuditEventEntity, { id: row.id });
      // sqlite hands back "YYYY-MM-DD HH:MM:SS" for a column default and a Date
      // for a value TypeORM sent; both go through the string form.
      const raw = reloaded.createdAt as unknown;
      return raw instanceof Date ? raw : new Date(`${String(raw).replace(' ', 'T')}Z`);
    };

    beforeEach(async () => {
      db = await memoryDataSource();
    });

    afterEach(async () => {
      if (db?.isInitialized) await db.destroy();
    });

    it('stays on today without the subscriber, and moves with it', async () => {
      engageAt(AUGUST);

      const withoutSubscriber = await insertAudit();
      // The column default fired in sqlite, so this row is dated by the
      // machine's own clock however far the patched Date has moved.
      expect(Math.abs(withoutSubscriber.getTime() - realNow())).toBeLessThan(5000);

      db.subscribers.push(new DemoClockSubscriber());
      const withSubscriber = await insertAudit();

      expect(withSubscriber.toISOString().slice(0, 7)).toBe('2026-08');
      expect(Math.abs(withSubscriber.getTime() - AUGUST.getTime())).toBeLessThan(5000);
    });

    it('is inert while the clock is not engaged', async () => {
      db.subscribers.push(new DemoClockSubscriber());
      const stamped = await insertAudit();
      expect(Math.abs(stamped.getTime() - realNow())).toBeLessThan(5000);
    });
  });
});

/**
 * Who the route admits it exists to. `@Roles('ADMIN')` on the controller would
 * answer 403 "insufficient role" to every learner on every build, which tells
 * them this API has a demo clock; so the service answers the same plain 404 to
 * a non-admin as it does to a build that never asked for the clock.
 */
describe('the demo clock route', () => {
  const learner = { role: 'LEARNER' } as AuthUser;
  const instructor = { role: 'INSTRUCTOR' } as AuthUser;
  const admin = { role: 'ADMIN' } as AuthUser;
  const savedFlag = process.env.DEMO_CLOCK;
  const service = () => new DemoService({ subscribers: [] } as unknown as DataSource);

  afterEach(() => {
    disengage();
    if (savedFlag === undefined) delete process.env.DEMO_CLOCK;
    else process.env.DEMO_CLOCK = savedFlag;
  });

  it('is a plain 404 to everyone on a build without the clock, the admin included', () => {
    delete process.env.DEMO_CLOCK;
    for (const caller of [learner, instructor, admin, undefined]) {
      expect(() => service().state(caller)).toThrow(NotFoundException);
      expect(() => service().set(caller, { advanceMs: 1000 })).toThrow(NotFoundException);
    }
  });

  it('is the same 404, never a 403, to a learner or instructor on a build with the clock', () => {
    process.env.DEMO_CLOCK = 'true';
    expect(config.isProduction).toBe(false);
    for (const caller of [learner, instructor, undefined]) {
      expect(() => service().state(caller)).toThrow(NotFoundException);
      expect(() => service().set(caller, { advanceMs: 1000 })).toThrow(NotFoundException);
      expect(() => service().state(caller)).not.toThrow(ForbiddenException);
    }
  });

  it('answers the admin on a loopback build with the clock', () => {
    process.env.DEMO_CLOCK = 'true';
    if (!config.bindIsLoopback) {
      // A reachable bind is the one case the service says out loud, in a 403.
      expect(() => service().state(admin)).toThrow(ForbiddenException);
      return;
    }
    expect(service().state(admin).offsetMs).toBe(0);
    expect(service().set(admin, { advanceMs: 60_000 }).offsetMs).toBeGreaterThanOrEqual(60_000);
  });
});
