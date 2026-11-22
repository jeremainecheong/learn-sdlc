import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { ChatDto } from '../dto';
import { AssistantService } from './assistant.service';

@Controller('assistant')
@UseGuards(RateLimitGuard)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @RateLimit(20, 60)
  @Post('chat')
  chat(@CurrentUser() user: AuthUser, @Body() dto: ChatDto) {
    return this.assistant.chat(user.id, dto.phaseStateId, dto.message);
  }

  @Get('history/:phaseStateId')
  history(@CurrentUser() user: AuthUser, @Param('phaseStateId') phaseStateId: string) {
    return this.assistant.history(user.id, phaseStateId);
  }
}
