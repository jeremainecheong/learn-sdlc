import { IsIn, IsString, MaxLength } from 'class-validator';

/**
 * What the learner's screen asks about while it waits.
 *
 * `kind` is closed because the queue only has two kinds a person waits on, and
 * an open string here would let a caller probe for handlers that exist. `id`
 * is length-capped for the same reason every id on this API is: an unbounded
 * string on a route that runs before authorisation is a free allocation.
 */
export class QueuePositionQuery {
  @IsIn(['run', 'submission'])
  kind!: 'run' | 'submission';

  @IsString()
  @MaxLength(80)
  id!: string;
}
