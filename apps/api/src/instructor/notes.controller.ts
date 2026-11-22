import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { ConsoleRateLimit, RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { StuckService } from '../assistant/stuck.service';
import {
  AnswerStuckDto,
  NotesQuery,
  PatchNoteDto,
  StuckQuery,
  WriteNoteDto,
} from './notes.dto';
import { NotesService } from './notes.service';

/**
 * The staff half of the mentor rooms: who is stuck, and what this class should be
 * told (the notes the mentor quotes, and the points held for the next lecture).
 *
 * Same shape as the rest of the console: `INSTRUCTOR` or `ADMIN`, 60 requests a
 * minute like the other class-wide routes, and every read and write narrowed to
 * the caller's own classes inside the service, where a miss is a 404.
 *
 * The class page's lecture board is built on the four note routes below and
 * relies on `sourceId`; the stuck routes are also pushed over the socket as
 * notifications.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
@ConsoleRateLimit()
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly stuck: StuckService,
  ) {}

  /* -------------------------------- stuck -------------------------------- */

  @Get('stuck')
  list(@CurrentUser() caller: AuthUser, @Query() query: StuckQuery) {
    return this.stuck.list(caller, { project: query.project || undefined, cohortId: query.cohortId || undefined, state: query.state });
  }

  @Post('stuck/:phaseStateId/answer')
  @HttpCode(200)
  answer(
    @CurrentUser() caller: AuthUser,
    @Param('phaseStateId') phaseStateId: string,
    @Body() dto: AnswerStuckDto,
  ) {
    return this.stuck.answer(caller, phaseStateId, dto.answer);
  }

  /* -------------------------------- notes -------------------------------- */

  @Get('notes')
  notesList(@CurrentUser() caller: AuthUser, @Query() query: NotesQuery) {
    return this.notes.list(caller, {
      cohortId: query.cohortId || undefined,
      kind: query.kind,
      phaseKey: query.phaseKey,
    });
  }

  @RateLimit(30, 60)
  @Post('notes')
  write(@CurrentUser() caller: AuthUser, @Body() dto: WriteNoteDto) {
    return this.notes.write(caller, dto);
  }

  @RateLimit(30, 60)
  @Patch('notes/:id')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('id') id: string,
    @Body() dto: PatchNoteDto,
  ) {
    return this.notes.update(caller, id, dto);
  }

  @RateLimit(30, 60)
  @Delete('notes/:id')
  remove(@CurrentUser() caller: AuthUser, @Param('id') id: string) {
    return this.notes.remove(caller, id);
  }
}
