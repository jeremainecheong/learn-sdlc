import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { CONSOLE_RATE_LIMIT, RATE_LIMIT_KEY, RateLimitGuard } from '../auth/rate-limit.guard';
import { CohortsController } from './cohorts.controller';

/**
 * Which class routes are counted, and at what rate. Creating a class mints a
 * join code and writes an audit row, so it is held to the console's rule, the
 * one every other teacher console route carries. Joining keeps its own
 * tighter brake on guessing codes, and the reads are not counted.
 */
describe('CohortsController rate limits', () => {
  const limitOf = (handler: keyof CohortsController) =>
    Reflect.getMetadata(RATE_LIMIT_KEY, CohortsController.prototype[handler]);

  it('counts class creation at the console rate, per teacher', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CohortsController)).toContain(RateLimitGuard);
    expect(limitOf('create')).toEqual({
      max: CONSOLE_RATE_LIMIT.max,
      windowSeconds: CONSOLE_RATE_LIMIT.windowSeconds,
    });
  });

  it('keeps the join brake and leaves the reads and leaving uncounted', () => {
    expect(limitOf('join')).toEqual({ max: 10, windowSeconds: 60 });
    expect(limitOf('list')).toBeUndefined();
    expect(limitOf('classroom')).toBeUndefined();
    expect(limitOf('leave')).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, CohortsController)).toBeUndefined();
  });
});
