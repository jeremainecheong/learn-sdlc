import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { QuizResultsExportKind, QuizResultsSummary } from '@learnsdlc/shared';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { QuizResultsExportService, quizResultsFilename, type LearningGainView } from './quiz-results-export.service';
import { ID_MAX_LENGTH, SLUG_MAX_LENGTH } from './instructor.dto';

// Re-exported so the route's spec and readers name one list.
export { LEARNING_GAIN_COLUMNS } from './quiz-results-export.service';

/** `?project=&cohort=`: both optional; an absent class reads every class of the caller's. */
export class QuizResultsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  project?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  cohort?: string;
}

/**
 * `?cohort=&project=` for the summary. The class is required;
 * an absent one would read every class of the caller's, and a dashboard is one
 * class's; the project is optional, as on the CSVs.
 */
export class QuizResultsSummaryQuery {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX_LENGTH)
  cohort: string;

  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  project?: string;
}

/**
 * The four quiz-results CSVs, one route each;
 * `QUIZ_RESULTS_EXPORT_KINDS`, in that order.
 *
 * A controller of its own beside `InstructorDetailController` rather than a
 * block inside it, so the routes, their limit and their roles are read off one
 * file and registering or removing them is one line. Same roles, same guard,
 * and the same 5-a-minute limit the two existing class CSVs carry, because
 * each of these is a full-class read too. The headers are theirs, word for
 * word: a CSV body and a file name the service has already validated the
 * project slug for. A class that is not the caller's is the service's 404,
 * raised before any learner is read, so a refused request writes no row.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
export class QuizResultsExportController {
  constructor(private readonly quizResults: QuizResultsExportService) {}

  @RateLimit(5, 60)
  @Get('quiz-results/learners.csv')
  learners(
    @CurrentUser() caller: AuthUser,
    @Query() query: QuizResultsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send('learners', caller, query, res);
  }

  @RateLimit(5, 60)
  @Get('quiz-results/attempts.csv')
  attempts(
    @CurrentUser() caller: AuthUser,
    @Query() query: QuizResultsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send('attempts', caller, query, res);
  }

  @RateLimit(5, 60)
  @Get('quiz-results/questions.csv')
  questions(
    @CurrentUser() caller: AuthUser,
    @Query() query: QuizResultsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send('questions', caller, query, res);
  }

  @RateLimit(5, 60)
  @Get('quiz-results/class.csv')
  classFile(
    @CurrentUser() caller: AuthUser,
    @Query() query: QuizResultsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.send('class', caller, query, res);
  }

  private async send(kind: QuizResultsExportKind, caller: AuthUser, query: QuizResultsQuery, res: Response) {
    const project = query.project || undefined;
    const cohort = query.cohort || undefined;
    const csv = await this.quizResults.export(caller, kind, { project, cohort });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${quizResultsFilename(kind, project)}"`);
    return csv;
  }
}

/**
 * The dashboard's JSON door, on a controller of its own beside the CSVs, so
 * the CSV controller and its "exactly the four routes" guard stay exact.
 * Same base path, same roles, same guard; 20 a minute.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
export class QuizResultsSummaryController {
  constructor(private readonly quizResults: QuizResultsExportService) {}

  /**
   * One class's quiz results as JSON for the dashboard, computed by the same
   * builders as the four files. 20 a minute: a page
   * view is one read, and the CSVs' 5 would trip on two reloads. Same roles,
   * same guard; a class that is not the caller's is the service's 404, raised
   * before any learner is read. A read only.
   */
  @RateLimit(20, 60)
  @Get('quiz-results/summary')
  summary(@CurrentUser() caller: AuthUser, @Query() query: QuizResultsSummaryQuery): Promise<QuizResultsSummary> {
    return this.quizResults.summary(caller, { cohort: query.cohort, project: query.project || undefined });
  }
}

/**
 * The before/after concept-check learning gain, as JSON and as a CSV. Its own
 * controller, so the CSV controller and the summary controller keep exactly
 * the routes their specs pin. Same roles,
 * guard and scoping as those two. Registered through `QUIZ_CONTROLLERS`.
 */
@Controller('instructor')
@Roles('INSTRUCTOR', 'ADMIN')
@UseGuards(RateLimitGuard)
export class QuizLearningGainController {
  constructor(private readonly quizResults: QuizResultsExportService) {}

  /**
   * The before/after learning gain per phase, over the
   * caller's own learners or one class of theirs (`cohort`, optional).
   */
  @RateLimit(20, 60)
  @Get('quiz-results/learning-gain')
  learningGain(@CurrentUser() caller: AuthUser, @Query() query: QuizResultsQuery): Promise<LearningGainView> {
    return this.quizResults.learningGain(caller, {
      cohort: query.cohort || undefined,
      project: query.project || undefined,
    });
  }

  /** The before/after learning gain as a CSV. */
  @RateLimit(5, 60)
  @Get('quiz-results/learning-gain.csv')
  async learningGainCsv(
    @CurrentUser() caller: AuthUser,
    @Query() query: QuizResultsQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csv = await this.quizResults.learningGainCsv(caller, {
      project: query.project || undefined,
      cohort: query.cohort || undefined,
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="quiz-learning-gain.csv"');
    return csv;
  }
}
