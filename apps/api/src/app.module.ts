import { AgenticService } from './assistant/agentic.service';
import { AgenticController } from './assistant/agentic.controller';
import { SubmissionTeacherFeedbackService } from './instructor/submission-feedback.service';
import { SubmissionTeacherFeedbackController } from './instructor/submission-feedback.controller';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AccountService } from './account/account.service';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { GoogleController } from './auth/google.controller';
import { GoogleService } from './auth/google.service';
import { RecoveryController } from './auth/recovery.controller';
import { RecoveryService } from './auth/recovery.service';
import { CohortsController } from './instructor/cohorts.controller';
import { CohortsService } from './instructor/cohorts.service';
import { InstructorDetailController } from './instructor/instructor.controller';
import { InstructorService } from './instructor/instructor.service';
// Instructor tooling: regrade, the class dates, view as learner.
import { RegradeService } from './instructor/regrade.service';
import { ScheduleService } from './instructor/schedule.service';
import { ViewAsService } from './instructor/view-as.service';
import { MailService } from './mail/mail.service';
import { MetricsController } from './observability/metrics.controller';
import { RetentionService } from './retention/retention.service';
import { AnalyticsService } from './analytics/analytics.service';
import { AssistantService } from './assistant/assistant.service';
import { LocalMentorProvider } from './assistant/local.provider';
import { OpenAiProvider } from './assistant/openai.provider';
import { JwtAuthGuard, RolesGuard } from './auth/auth.guards';
import { RateLimitGuard } from './auth/rate-limit.guard';
import { AuthService } from './auth/auth.service';
import { PasswordWorkService } from './auth/password-work.service';
import { CognitoService } from './auth/cognito.service';
import { CognitoController } from './auth/cognito.controller';
import { IdentityMigrationController } from './identity-migration/identity-migration.controller';
import { IdentityMigrationService } from './identity-migration/identity-migration.service';
import { config } from './config';
import { ContentService } from './content/content.service';
// Teacher-authored projects: the pack on disk becomes rows. Registered
// here rather than behind a ContentModule for the reason PreviewService is:
// the importer leans on ContentService, and a module of its own would resolve a
// second copy of it, reading the whole content directory twice at boot.
import { ProjectImporterService } from './content/importer.service';
import { ProjectRegistryService } from './content/project-registry.service';
import { AccountController } from './account/account.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { AssistantController } from './assistant/assistant.controller';
import { AuthController } from './auth/auth.controller';
import { RunsController } from './execution/runs.controller';
import { SubmissionsController } from './feedback/submissions.controller';
import { HealthController } from './health/health.controller';
import { InstructorOverviewController } from './instructor/instructor-overview.controller';
import { EnrollmentsController } from './workflow/enrollments.controller';
import { PhasesController } from './workflow/phases.controller';
import { ProjectsController } from './workflow/projects.controller';
import { DatabaseModule } from './db/database.module';
import { DemoModule } from './demo/demo.module';
import { EventsGateway } from './events/events.gateway';
import { ExecutionService } from './execution/execution.service';
import { SandboxService } from './execution/sandbox.service';
import { FeedbackService } from './feedback/feedback.service';
import { HealthService } from './health/health.service';
import { JobRecoveryService } from './jobs/job-recovery.service';
import { JobsService } from './jobs/jobs.service';
import { SeedService } from './seed/seed.service';
import { NullPinService } from './seed/null-pin.service';
import { StoryRepinService } from './seed/story-repin.service';
import { WorkflowService } from './workflow/workflow.service';
// Classroom mode: the lab address, the QR, the queue position.
import { LabController } from './classroom/lab.controller';
import { LabService } from './classroom/lab.service';
// Teacher-authored projects: the authoring surface, and the class's
// project. Registered here beside the content services rather than behind a
// module of their own, for the reason the importer note above gives:
// AuthoringService leans on ProjectImporterService and ProjectRegistryService,
// and a module would resolve a second copy of each, including a second
// registry whose `load()` would install a different object than the one the
// running ContentService holds.
//
// Neither declares a lifecycle hook, so neither can move the seed-then-registry
// bootstrap order: that order is arranged by ProjectRegistryService's declared
// dependency on SeedService, not by where anything sits in these arrays.
import { AuthoringController } from './authoring/authoring.controller';
import { AuthoringService } from './authoring/authoring.service';
import { DraftConversionService } from './authoring/draft-conversion.service';
import { UploadService } from './authoring/upload.service';
import { SealedRoleService } from './authoring/sealed-roles';
import { SignoffService } from './instructor/signoff';
import { QuizResultsExportController, QuizResultsSummaryController } from './instructor/quiz-results-export.controller';
import { QuizResultsExportService } from './instructor/quiz-results-export.service';
import { DeepValidationService } from './authoring/deep-validation';
import { ExportService } from './authoring/export.service';
import { CohortProjectController } from './classroom/cohort-project.controller';
import { CohortProjectService } from './classroom/cohort-project.service';
import { QueueController } from './jobs/queue.controller';
import { ExplainService } from './assistant/explain.service';
import { InterviewService } from './assistant/interview.service';
import { MentorController } from './assistant/mentor.controller';
import { StuckService } from './assistant/stuck.service';
import { NotesController } from './instructor/notes.controller';
import { NotesService } from './instructor/notes.service';
import { SolutionController } from './workflow/solution.controller';
import { SolutionService } from './workflow/solution.service';
// A class out as one file, and a class in from one.
import { PortabilityController } from './instructor/portability.controller';
import { PortabilityService } from './instructor/portability.service';
// The live preview: the learner's own application, running.
import { PreviewDoorController } from './preview/preview-proxy.controller';
import { PreviewController } from './preview/preview.controller';
import { PreviewReaper } from './preview/preview.reaper';
import { PreviewService } from './preview/preview.service';
// The bell: what happened, and who needs a look.
import { InstructorNotesController } from './notifications/notes.controller';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { LEARNER_RESOLUTION } from './notifications/learner-resolution';
// Quizzes: the learner's three quiz doors and the one writer of
// `quiz_attempts`. Two lists rather than a module, for the reason
// `quiz.module.ts` states and PreviewService's note below repeats: QuizService
// leans on WorkflowService, ContentService and FeedbackService, none of which
// is exported by a module, so a module of its own would resolve a second copy
// of each.
import { QUIZ_CONTROLLERS, QUIZ_PROVIDERS } from './quiz/quiz.module';

// The learner's own project as a git repository. Registered here
// rather than behind a RepoModule for the same reason PortabilityController is:
// this file is the one place a controller is wired, and RepoService leans on
// ContentService, which a second module would resolve a second copy of.
import { RepoController } from './repo/repo.controller';
import { RepoService } from './repo/repo.service';

/**
 * LearnSDLC modular monolith. Bounded contexts live in their directories
 * (auth, content, workflow, execution, assistant, feedback, analytics);
 * one Nest container wires them, and the async backbone (JobsService)
 * keeps slow work off the request path.
 */
@Module({
  imports: [
    DatabaseModule,
    JwtModule.register({
      global: true,
      secret: config.jwtSecret,
      signOptions: { expiresIn: config.jwtExpiresIn },
    }),
    DemoModule,
  ],
  controllers: [
    AgenticController,
    SubmissionTeacherFeedbackController,
    HealthController,
    MetricsController,
    AuthController,
    CognitoController,
    IdentityMigrationController,
    GoogleController,
    RecoveryController,
    AccountController,
    AdminController,
    InstructorDetailController,
    CohortsController,
    ProjectsController,
    EnrollmentsController,
    PhasesController,
    RunsController,
    SubmissionsController,
    AssistantController,
    AnalyticsController,
    InstructorOverviewController,
    MentorController,
    NotesController,
    PortabilityController,
    QueueController,
    LabController,
    // The fifteen authoring doors and the class's three. Both are
    // `@Controller('instructor')` beside the other instructor controllers; no path
    // any of them declares shadows another, because `projects` and
    // `cohorts/:cohortId/project` share no prefix with `learners/:userId`,
    // `cohorts/:cohortId/schedule` or `cohorts/:cohortId/export.json`.
    AuthoringController,
    CohortProjectController,
    NotificationsController,
    InstructorNotesController,
    // The three learner preview routes, and the public door in front
    // of a running app. Registered here rather than behind a PreviewModule
    // because PreviewService leans on WorkflowService, ContentService and
    // SandboxService, and a module of its own would resolve a second copy of
    // each, including a second ContentService reading the whole content
    // directory at boot. DemoModule is a module because it is self-contained;
    // this is not.
    PreviewController,
    PreviewDoorController,
    RepoController,
    // The reference solution, after the gate.
    SolutionController,
    // Quizzes: `GET/POST /phases/:id/tasks/:taskKey/quiz…`. It is a
    // second `@Controller('phases')` beside PhasesController above, which
    // shadows nothing: every path it declares carries four segments or more.
    ...QUIZ_CONTROLLERS,
    // The four read-only quiz-results CSVs
    QuizResultsExportController,
    // The class's quiz results as JSON for the dashboard
    QuizResultsSummaryController,
  ],
  providers: [
    AgenticService,
    SubmissionTeacherFeedbackService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    RateLimitGuard,
    ContentService,
    // SeedService asks it for the packs on disk at every boot.
    ProjectImporterService,
    HealthService,
    JobsService,
    JobRecoveryService,
    EventsGateway,
    AuthService,
    PasswordWorkService,
    CognitoService,
    IdentityMigrationService,
    GoogleService,
    RecoveryService,
    AccountService,
    AdminService,
    InstructorService,
    RegradeService,
    ScheduleService,
    ViewAsService,
    CohortsService,
    MailService,
    SandboxService,
    ExecutionService,
    LocalMentorProvider,
    OpenAiProvider,
    AssistantService,
    FeedbackService,
    WorkflowService,
    AnalyticsService,
    RetentionService,
    // The one-time move of TaskTrackr learners onto the story version, which
    // SeedService runs right after its import (no bootstrap hook of its own).
    StoryRepinService,
    // The null-pin pass, which SeedService runs first, before its import
    // (no bootstrap hook of its own either).
    NullPinService,
    SeedService,
    // Installs the published `compiled` snapshots into ContentService, which
    // does not walk CONTENT_DIR at onModuleInit, so without this provider the catalogue is empty and every
    // request is answered "unknown project". Listed after SeedService because
    // it runs after the seed's import; what *arranges* that is the dependency
    // it declares on SeedService, since Nest orders bootstrap hooks by
    // dependency depth rather than by this array.
    ProjectRegistryService,
    // The teacher's authoring service, listed after the registry
    // because it asks the registry to reload the moment a version is
    // published: again, what arranges that is the constructor argument, not
    // this position. It declares no bootstrap hook of its own, so the
    // seed-then-registry order above is untouched by its presence.
    AuthoringService,
    // Once per kind: teacher drafts stored before the story kind (their
    // Requirements) and before the design kind (their Design), converted and
    // recompiled, each pass with its own marker. Its bootstrap hook runs after
    // the registry's, because it depends on AuthoringService, which depends on
    // the registry.
    DraftConversionService,
    // A teacher's archive to a draft (no bootstrap hook)
    UploadService,
    // The write-only store for sealed files (no bootstrap hook)
    SealedRoleService,
    // The sign-off queue and bulk sign-off (no bootstrap hook)
    SignoffService,
    // The quiz-results export, read only (no bootstrap hook)
    QuizResultsExportService,
    // Deep validation in the sandbox, no model call (no bootstrap hook)
    DeepValidationService,
    // A version back to the on-disk layout, audited (no bootstrap hook)
    ExportService,
    // The writer of `cohort_project_assignments`, whose reader is
    // `WorkflowService.assignedToClass`.
    CohortProjectService,
    InterviewService,
    StuckService,
    NotesService,
    PortabilityService,
    LabService,
    NotificationsService,
    // Which project a learner is in, for the reminder
    // sweep, without a runtime import of the workflow service from it.
    { provide: LEARNER_RESOLUTION, useExisting: WorkflowService },
    PreviewService,
    PreviewReaper,
    RepoService,
    SolutionService,
    ExplainService,
    // The learner's quiz service, and the one writer of
    // `quiz_attempts` beside it. Listed after FeedbackService and
    // WorkflowService for readability only; what arranges the wiring is the
    // constructor arguments, not this position.
    ...QUIZ_PROVIDERS,
  ],
})
export class AppModule {}
