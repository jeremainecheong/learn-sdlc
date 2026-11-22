import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DemoClockView } from '@learnsdlc/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { config } from '../config';
import { resolveDemoClockEnabled } from '../config/demo';
import {
  advanceBy,
  demoClockView,
  disengage,
  engageAt,
} from './demo-clock';
import { DemoClockSubscriber } from './demo-clock.subscriber';
import { DemoClockDto } from './demo.dto';

export const DEMO_CLOCK_REFUSED_REACHABLE =
  'The demo clock was refused: this API is bound to an address other machines can reach, and a ' +
  'moved clock changes the dates on every row written while it is moved. Bind loopback (unset ' +
  'API_BIND) and start again with DEMO_CLOCK=true.';

/**
 * The clock behind `npm run seed:class`.
 *
 * Three guards, in this order, because they answer three different questions.
 * A production deployment must not admit the route exists at all, so it is a
 * 404 rather than a 403; a deployment that simply did not ask for the clock is
 * the same 404, because "this API has no such route" is the truth there too.
 * Only a laptop that asked for the clock and is nonetheless reachable gets a
 * 403 with a sentence explaining what it would have done, in the shape
 * `SeedService.seedDemoAccounts` uses for its own `refused-reachable`.
 */
@Injectable()
export class DemoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Registered on the live DataSource rather than declared in
   * `database.module.ts`: the subscriber is inert while the clock is not
   * installed, and this way every file the demo clock needs lives in the
   * demo module.
   */
  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    const already = this.dataSource.subscribers.some(
      (subscriber) => subscriber instanceof DemoClockSubscriber,
    );
    if (!already) this.dataSource.subscribers.push(new DemoClockSubscriber());
    this.logger.warn(
      'DEMO_CLOCK=true: POST /api/v1/demo/clock can move this process\'s clock, and every row ' +
        'written while it is moved carries the moved date. Never set this on a deployment ' +
        'anybody else uses.',
    );
  }

  private enabled(): boolean {
    return resolveDemoClockEnabled() && !config.isProduction;
  }

  /**
   * Throws the refusal the caller has earned, or returns.
   *
   * The caller's role is checked here, after the build check and with the
   * same 404, rather than by the roles guard on the controller: a 403 from
   * the guard told any signed-in learner that the route exists.
   */
  private assertAvailable(caller: Pick<AuthUser, 'role'> | undefined): void {
    if (config.isProduction || !resolveDemoClockEnabled() || caller?.role !== 'ADMIN') {
      // Deliberately the plain 404 an unmatched route gets. "The demo clock is
      // disabled" would tell a caller that this build has one, and so would
      // "insufficient role".
      throw new NotFoundException();
    }
    if (!config.bindIsLoopback) {
      throw new ForbiddenException(DEMO_CLOCK_REFUSED_REACHABLE);
    }
  }

  state(caller: Pick<AuthUser, 'role'> | undefined): DemoClockView {
    this.assertAvailable(caller);
    return demoClockView();
  }

  /**
   * Move it. `release` wins over the other two so a caller can always get back
   * to real time in one request, and `at` and `advanceMs` are refused together
   * rather than silently ordered: a script that sends both meant one of them.
   */
  set(caller: Pick<AuthUser, 'role'> | undefined, dto: DemoClockDto): DemoClockView {
    this.assertAvailable(caller);
    if (dto.release) {
      disengage();
      this.logger.log('demo clock released; the process is back on the real clock');
      return demoClockView();
    }
    if (dto.at !== undefined && dto.advanceMs !== undefined) {
      throw new BadRequestException(
        'send either at (an instant to move to) or advanceMs (a span to move forward by), not both',
      );
    }
    if (dto.at !== undefined) {
      const at = new Date(dto.at);
      if (Number.isNaN(at.getTime())) throw new BadRequestException('at is not a date');
      engageAt(at);
    } else if (dto.advanceMs !== undefined) {
      advanceBy(dto.advanceMs);
    } else {
      throw new BadRequestException('send at, advanceMs or release');
    }
    const view = demoClockView();
    this.logger.log(`demo clock now reads ${view.now} (${view.offsetMs} ms ahead of the real clock)`);
    return view;
  }
}
