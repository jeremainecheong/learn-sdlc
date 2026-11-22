import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsObject, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { AgenticService } from './agentic.service';

/** The longest learner prompt or chat message an Agentic route accepts. */
const AGENTIC_MESSAGE_MAX_CHARS = 8000;
/** The longest explanation of a proposal the explanation route accepts. */
const AGENTIC_EXPLANATION_MAX_CHARS = 12000;

class PromptDto { @IsString() @Length(1, AGENTIC_MESSAGE_MAX_CHARS) prompt!: string; }
class HashDto { @IsString() @Length(64, 64) proposalHash!: string; }
class ExplanationDto extends HashDto {
  @IsString() @Length(1, AGENTIC_EXPLANATION_MAX_CHARS) explanation!: string;
  @IsOptional() @IsUUID() requestId?: string;
  @IsOptional() @IsUUID() parentTurnId?: string;
}
class EditDto extends HashDto { @IsObject() files!: Record<string, string>; }
class ChatDto {
  @IsUUID() requestId!: string;
  @IsString() @Length(1, AGENTIC_MESSAGE_MAX_CHARS) @Matches(/\S/) message!: string;
  @IsOptional() @IsUUID() parentTurnId?: string;
  @IsOptional() @IsUUID() proposalId?: string;
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/) proposalHash?: string;
}
class TurnsQueryDto { @IsOptional() @IsUUID() cursor?: string; }

@Controller('phases/:id/agent')
@UseGuards(RateLimitGuard)
export class AgenticController {
  constructor(private readonly agent: AgenticService) {}
  @Get('proposals') list(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.agent.list(user.id, id); }
  @Get('proposals/:proposalId') proposal(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('proposalId') proposalId: string) { return this.agent.proposal(user.id, id, proposalId); }
  @Get('turns') turns(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() query: TurnsQueryDto) { return this.agent.turns(user.id, id, query.cursor); }
  @Get('turns/:requestId') turn(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('requestId') requestId: string) { return this.agent.turn(user.id, id, requestId); }
  @Post('chat') @HttpCode(200) @RateLimit(8, 60)
  chat(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ChatDto) { return this.agent.chat(user.id, id, dto); }
  @Post('propose') @HttpCode(200) @RateLimit(8, 60)
  propose(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PromptDto) { return this.agent.propose(user.id, id, dto.prompt); }
  @Post('proposals/:proposalId/explain') @HttpCode(200) @RateLimit(10, 60)
  explain(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('proposalId') proposalId: string, @Body() dto: ExplanationDto) {
    return dto.requestId
      ? this.agent.explainTurn(user.id, id, proposalId, dto.proposalHash, dto.explanation, dto.requestId, dto.parentTurnId)
      : this.agent.explain(user.id, id, proposalId, dto.proposalHash, dto.explanation);
  }
  @Post('proposals/:proposalId/edit') @HttpCode(200) @RateLimit(20, 60)
  edit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('proposalId') proposalId: string, @Body() dto: EditDto) { return this.agent.edit(user.id, id, proposalId, dto.proposalHash, dto.files); }
  @Post('proposals/:proposalId/apply') @HttpCode(200) @RateLimit(10, 60)
  apply(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('proposalId') proposalId: string, @Body() dto: HashDto) { return this.agent.apply(user.id, id, proposalId, dto.proposalHash); }
}
