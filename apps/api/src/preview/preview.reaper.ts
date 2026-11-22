import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PreviewService } from './preview.service';

/** How often the API asks whether anything has run out of time. */
export const PREVIEW_SWEEP_MS = 15_000;

/**
 * The API's half of the reaping.
 *
 * The runner sweeps its own sessions every five seconds and is the one that
 * can actually see a wedged child, a byte budget or a process that exited; this
 * is the other half, and it exists because the runner cannot see an API that
 * has stopped caring. A learner who closes the tab stops polling, and it is
 * this tick that notices the five quiet minutes and takes the capability out
 * of circulation: the runner would eventually stop the child, but the door
 * would go on opening it until it did.
 *
 * Shared ownership survives API replica shutdown. The controller's TTL remains
 * the process limit; durable cleanup reservations survive interrupted starts.
 */
@Injectable()
export class PreviewReaper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreviewReaper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly preview: PreviewService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), PREVIEW_SWEEP_MS);
    // Unref'd so a tick that is merely scheduled never on its own keeps the
    // process alive past a shutdown: the same rule every other timer in this
    // API follows.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Shared sessions belong to the controller and database, not this replica.
   * Stopping one replica only stops its sweep; another replica continues it. */
  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
  }

  /** One sweep, with its own failure swallowed: a reaper that throws stops reaping. */
  async tick(): Promise<void> {
    try {
      const stopped = await this.preview.sweep();
      if (stopped) this.logger.log(`reaped ${stopped} preview session(s) past a cap`);
    } catch (err) {
      this.logger.warn(`preview sweep: ${(err as Error).message}`);
    }
  }
}
