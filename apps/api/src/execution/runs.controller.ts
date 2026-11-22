import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { ExecutionService } from './execution.service';

@Controller('runs')
export class RunsController {
  constructor(private readonly execution: ExecutionService) {}

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.execution.getRun(id, user.id);
  }
}
