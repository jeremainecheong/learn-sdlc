import { IsBoolean, IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DAY_MS } from '../db/timestamps';

/**
 * How far a single call may move the clock: a little over a year. The seed
 * winds back five weeks and steps forward through a term, so anything larger
 * is a typo (a `Date.now()` passed as a span, most likely), and a typo that
 * lands the whole class in 2078 is worth refusing at the door.
 */
export const DEMO_CLOCK_MAX_ADVANCE_MS = 400 * DAY_MS;

export class DemoClockDto {
  /** Absolute instant to move to, ISO 8601. Mutually exclusive with advanceMs. */
  @IsOptional()
  @IsISO8601()
  at?: string;

  /** Milliseconds to move forward. Never negative: the clock does not go back. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(DEMO_CLOCK_MAX_ADVANCE_MS)
  advanceMs?: number;

  /** Put the real clock back. */
  @IsOptional()
  @IsBoolean()
  release?: boolean;
}
