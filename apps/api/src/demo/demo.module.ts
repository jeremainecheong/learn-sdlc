import { Module } from '@nestjs/common';
import { DemoController } from './demo.controller';
import { DemoService } from './demo.service';

/**
 * The demo clock. Registered unconditionally; the service is
 * what refuses every request unless this process is a loopback,
 * non-production API started with DEMO_CLOCK=true, so a production build has
 * two dead routes and no behaviour.
 */
@Module({
  controllers: [DemoController],
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
