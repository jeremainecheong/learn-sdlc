import type { Provider, Type } from '@nestjs/common';
import { QuizAttemptsService } from './quiz-attempts.service';
import { QuizLearningGainController } from '../instructor/quiz-results-export.controller';
import { QuizController } from './quiz.controller';
import { QuizService } from './quiz.service';

/**
 * How the quiz context is wired.
 *
 * **It is deliberately not a `@Module`**, and the reason is the one
 * `app.module.ts` already gives four times over. `QuizService` leans on
 * `WorkflowService`, `ContentService` and `FeedbackService`, and none of the
 * three is exported by a module: they are registered directly in `AppModule`
 * beside the content services. A `QuizModule` that listed them as its own
 * providers would resolve a **second copy of each**, including a second
 * `ContentService`, whose installed-version maps are the pinned snapshot every
 * learner is served from and whose `load()` would then have to be run twice to
 * agree with the one the running app holds. That is the exact hazard
 * `PreviewController`, `RepoController`, `PortabilityController` and the
 * authoring services are each registered in `AppModule` to avoid.
 *
 * So this file is the **list** rather than the container: one import line in
 * `app.module.ts` spreads both arrays into the two it already has, and the quiz
 * routes are wired exactly where every other controller in this monolith is.
 *
 * It is also where `QuizAttemptsService` is registered. That class: the one
 * writer of `quiz_attempts`: deliberately declares no module, so that the
 * service and its registration cannot be created twice and
 * collide. `DatabaseModule` is `@Global` and already provides
 * `QuizAttemptEntity`'s repository, so nothing else is needed for it to
 * resolve. `FeedbackService` builds its own instance over the manager it
 * already holds rather than taking another constructor argument; two
 * instances over one `DataSource` are two handles on one table, and every write
 * to that table still goes through a method on that class.
 */
// The teacher's learning-gain routes ride here so AppModule needs no line of its own for them.
export const QUIZ_CONTROLLERS: Type[] = [QuizController, QuizLearningGainController];

export const QUIZ_PROVIDERS: Provider[] = [QuizService, QuizAttemptsService];
