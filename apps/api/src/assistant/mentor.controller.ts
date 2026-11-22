import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { ExplainTestDto, InterviewAskDto, RaiseStuckDto, LessonMentorDto } from './mentor.dto';
import { ExplainService } from './explain.service';
import { InterviewService } from './interview.service';
import { StuckService } from './stuck.service';
import { AssistantService } from './assistant.service';

/**
 * The learner's mentor rooms: the customer interview and the stuck flag.
 *
 * Both hang off `/phases/:id` because both are things a learner does inside one
 * phase, and both go through `WorkflowService.loadOwnedState` in the service,
 * the one ownership check the product has, rather than a second one written
 * here. A locked phase, or somebody else's, is refused there.
 */
@Controller('phases')
@UseGuards(RateLimitGuard)
export class MentorController {
  constructor(
    private readonly interview: InterviewService,
    private readonly stuck: StuckService,
    // "Explain this failing test", a mentor turn the product types
    // on the learner's behalf, so it hangs off the same phase as the rest.
    private readonly explain: ExplainService,
    private readonly assistant: AssistantService,
  ) {}

  @Get(':id/lesson/mentor')
  lessonHistory(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.assistant.lessonHistory(user.id, id); }

  @RateLimit(20, 60)
  @HttpCode(200)
  @Post(':id/lesson/mentor')
  lessonChat(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LessonMentorDto) { return this.assistant.chat(user.id, id, dto.message, { lesson: true }); }

  @Get(':id/interview')
  interviewState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.interview.state(user.id, id);
  }

  /** The same limit as a chat turn: it is the same kind of spend. */
  @RateLimit(20, 60)
  @HttpCode(200)
  @Post(':id/interview/ask')
  ask(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: InterviewAskDto,
    @Req() req?: Request & { requestId?: string },
  ) {
    return this.interview.ask(user.id, id, dto.question, req?.requestId);
  }

  @Get(':id/stuck')
  myFlag(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.stuck.mine(user.id, id);
  }

  /**
   * Five in five minutes. Raising a flag pages a person rather than a machine,
   * and a limit above what somebody can plausibly need only buys them a way to
   * fill their instructor's screen.
   */
  @RateLimit(5, 300)
  @HttpCode(200)
  @Post(':id/stuck')
  raise(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RaiseStuckDto) {
    return this.stuck.raise(user.id, id, dto.question, dto.tried ?? '');
  }

  @RateLimit(10, 60)
  @HttpCode(200)
  @Post(':id/stuck/clear')
  clear(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.stuck.clear(user.id, id);
  }

  /**
   * Ten in a minute. Half a chat turn's allowance: an explanation
   * is a heavier question than a typed one, and nobody presses this button ten
   * times a minute for a reason a limit should help with.
   */
  @RateLimit(10, 60)
  @HttpCode(200)
  @Post(':id/explain-test')
  explainTest(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ExplainTestDto,
  ) {
    return this.explain.explainFailingTest(user.id, id, dto);
  }
}
