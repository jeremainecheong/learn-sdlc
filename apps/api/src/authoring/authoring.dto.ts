import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ArrayMinSize,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  ARTEFACT_TYPES,
  CRITERION_DESCRIPTION_MAX,
  CRITERION_TITLE_MAX,
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_FACT_ID_PATTERN,
  INTERVIEW_KEYWORDS_MAX,
  INTERVIEW_KEYWORD_MAX,
  INTERVIEW_LINE_MAX,
  INTERVIEW_MAX_FACTS,
  INTERVIEW_MAX_TURNS_CAP,
  INTERVIEW_MAX_TURNS_MIN,
  INTERVIEW_PERSONA_NAME_MAX,
  INTERVIEW_PERSONA_ROLE_MAX,
  INTERVIEW_TOPIC_MAX,
  MIN_TESTS_MAX,
  PHASE_INTRO_MAX,
  PHASE_ORDER,
  PROJECT_TITLE_MAX,
  QUIZ_REVEAL_EXPLANATIONS,
  REPLACE_FILE_CONTENT_MAX,
  TASK_BRIEF_MAX,
  TASK_OBJECTIVES_MAX,
  TASK_OBJECTIVE_MAX,
  TASK_KEY_MAX_LENGTH,
  TASK_TITLE_MAX,
  RUBRIC_CRITERIA_MAX,
  RUBRIC_CRITERION_DESCRIPTION_MAX,
  RUBRIC_CRITERION_KEY_MAX,
  RUBRIC_CRITERION_TITLE_MAX,
  RUN_SHAPES,
  SEALED_ROLE_KINDS,
  DESIGN_CAPS,
  STORY_CAPS,
  RUNBOOK_CAPS,
  CHANGE_CAPS,
} from '@learnsdlc/shared';
import type { ArtefactType, CriterionTag, QuizRevealExplanation, SealedRoleKind, TestRunShapeId } from '@learnsdlc/shared';
import { RUN_LABEL_MAX, RUN_PATH_MAX } from './draft';

/** A project's tagline, as the meta door accepts it. The API alone holds it to this. */
export const PROJECT_TAGLINE_MAX = 200;
/** A project's description, as the meta door accepts it. */
export const PROJECT_DESCRIPTION_MAX = 2000;
/** The notes a teacher publishes a version with. */
export const VERSION_NOTES_MAX = 2000;
/** A run id (`^[a-z][a-z0-9-]{0,15}$`) or a sealed role's name, as the sealed doors accept it. */
const RUN_ID_MAX = 16;

/**
 * The bodies the authoring routes take.
 *
 * They live here rather than in the shared `dto.ts` for the reason the notes
 * DTOs do: that file is shared by every module, and a body used by exactly one
 * controller has no business in it.
 *
 * Every shape here is the *outer* wall (a string is a string, a list is a list,
 * a bound is a bound) and none of it is the rule. The rules a teacher's input
 * actually has to satisfy (a task key a learner's state can follow, a rubric
 * criterion, a pattern that compiles, an artefact type authoring can write) are
 * asked in the service, in the one sentence the contract fixes, because they are
 * answers a teacher reads rather than a shape a parser rejects.
 *
 * `artefactPath` is deliberately not a member of any of them: it is minted at
 * creation, and a room and a reset key on it, so moving one is a delete and a
 * create.
 */

/** One option a teacher writes. `text` is markdown and is learner-visible. */
export class QuizOptionDto {
  @IsString() @MinLength(1) @MaxLength(48) id!: string;

  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}

/**
 * One question, key included.
 *
 * The service is what asks whether the key names options this question holds,
 * whether two questions share an id and whether every option is marked correct;
 * those are sentences a teacher reads. This class is the outer wall, and the
 * bound that matters here is `@ArrayMaxSize(8)` on `options`: the fast tier
 * refuses anything outside 2..8 with a sentence, and the wall keeps a body that
 * never reaches the fast tier from carrying a thousand of them.
 */
export class QuizQuestionDto {
  @IsString() @MinLength(1) @MaxLength(32) id!: string;

  @IsString() @MinLength(1) @MaxLength(4000) stem!: string;

  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  options!: QuizOptionDto[];

  /**
   * The key. `@ArrayUnique()` is the wall's half of one fact: an option named
   * twice is **one** answer to the scorer, which folds `correct` into a set
   * before it compares, so measured as an array the paper would be drawn as a
   * checkbox group, tell the learner to pick every answer that applies, and
   * mark them wrong for doing it. The fast tier's sentence beside it is what a
   * teacher can act on (`quizShapeRefusal`); this is what keeps a body that
   * never reaches the fast tier from carrying the repeat into a compiled
   * slice.
   */
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(48, { each: true })
  correct!: string[];

  @IsString() @MinLength(1) @MaxLength(4000) explanation!: string;

  @IsOptional() @IsString() @MaxLength(200) concept?: string;
}

/**
 * How many goes a learner has, and how long they wait between them.
 *
 * Both fields default to `null`, which is the contract's own word for *no
 * limit* and *no cooldown*, so a body that names neither arrives as the pair
 * the service reads rather than as two `undefined`s it would have to guess at.
 * `transform: true` on the global pipe is what makes the initialisers run.
 */
export class QuizAttemptsDto {
  @IsOptional() @IsInt() @Min(1) @Max(100) max: number | null = null;

  @IsOptional() @IsInt() @Min(0) @Max(86400) cooldownSeconds: number | null = null;
}

/**
 * A quiz, as the teacher's editor posts it.
 *
 * `AddTaskBody.quiz` and `UpdateTaskBody.quiz` are the *only* way a quiz's key
 * enters the deployment, and the global pipe is
 * `whitelist: true, forbidNonWhitelisted: false` (`main.ts`): an undeclared
 * property is **stripped**, silently. So this class is not a nicety: without it
 * `body.quiz` never reaches the service and a teacher's quiz arrives as a task
 * with no questions.
 *
 * The caps are the outer wall the service deliberately does not carry: it
 * bounds `passMark`, `attempts` and `criterion`, because each of those is a
 * sentence, and says nothing about how many questions a pool may hold. 200 is
 * the bound here, which is forty papers' worth of a five-question draw.
 */
export class AuthoredQuizDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionDto)
  questions!: QuizQuestionDto[];

  @IsOptional() @IsInt() @Min(1) @Max(200) drawn?: number;

  @IsOptional() @IsBoolean() shuffleOptions?: boolean;

  @IsOptional() @IsInt() @Min(0) @Max(100) passMark?: number;

  @IsOptional() @ValidateNested() @Type(() => QuizAttemptsDto) attempts?: QuizAttemptsDto;

  @IsOptional() @IsString() @MaxLength(48) criterion?: string;

  /**
   * When an optional quiz releases its explanations.
   * Declared here because the global pipe strips an undeclared property
   * silently: without this line the teacher's choice never reaches the
   * service and the quiz keeps the default rule with nothing refused. The list is
   * the contract's own (`QUIZ_REVEAL_EXPLANATIONS`); a required quiz is
   * refused in the service, by name (`quiz-reveal-optional-only`).
   */
  @IsOptional() @IsIn(QUIZ_REVEAL_EXPLANATIONS) revealExplanation?: QuizRevealExplanation;
}

export class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(PROJECT_TITLE_MAX) title!: string;

  @IsString() @MaxLength(48) slug!: string;

  @IsString() @MaxLength(64) fromVersionId!: string;
}

/**
 * The published version the caller was looking at when they asked for a draft.
 *
 * Required rather than optional, and that is the whole point of it: the draft
 * always opens from the project's published head, and a body that named no
 * version would be a page saying "open a draft from whatever is newest now",
 * which is exactly the silent overwrite the guard exists to refuse. Whether the
 * id *is* the head is the service's question, because the answer is a sentence.
 */
export class CreateDraftVersionDto {
  @IsString() @MaxLength(64) fromVersionId!: string;
}

export class UpdateProjectMetaDto {
  @IsOptional() @IsString() @MaxLength(PROJECT_TITLE_MAX) title?: string;

  @IsOptional() @IsString() @MaxLength(PROJECT_TAGLINE_MAX) tagline?: string;

  @IsOptional() @IsString() @MaxLength(PROJECT_DESCRIPTION_MAX) description?: string;
}

export class AddTaskDto {
  @IsString() @MaxLength(TASK_KEY_MAX_LENGTH) taskKey!: string;

  @IsString() @MinLength(1) @MaxLength(TASK_TITLE_MAX) title!: string;

  @IsString() @MinLength(1) @MaxLength(TASK_BRIEF_MAX) brief!: string;

  @IsOptional() @IsIn(ARTEFACT_TYPES) artefactType?: ArtefactType;

  @IsOptional() @IsBoolean() required?: boolean;

  /**
   * Optional because a Requirements or Design phase holding no task of its own
   * takes its story or design task back without one. Every other add is a
   * concept quiz, and the service refuses a body without one, by name
   * (`QUIZ_ONLY_ADD_REFUSAL`).
   */
  @IsOptional() @ValidateNested() @Type(() => AuthoredQuizDto) quiz?: AuthoredQuizDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TASK_OBJECTIVES_MAX)
  @IsString({ each: true })
  @MaxLength(TASK_OBJECTIVE_MAX, { each: true })
  objectives?: string[];
}

/**
 * One criterion's new wording, by the key the task's
 * rubric already holds. A weight and the pass threshold are not members: an
 * inherited task keeps the pack's weights, and the global pipe strips anything
 * undeclared.
 */
export class CriterionWordingDto {
  @IsString() @MaxLength(RUBRIC_CRITERION_KEY_MAX) key!: string;

  @IsString() @MinLength(1) @MaxLength(CRITERION_TITLE_MAX) title!: string;

  @IsString() @MinLength(1) @MaxLength(CRITERION_DESCRIPTION_MAX) description!: string;
}

/* ---- an executable task's editable members ---- */

/** The four test-run shapes: the only `shape` a run body may name. */
const TEST_RUN_SHAPE_IDS: TestRunShapeId[] = RUN_SHAPES.filter((shape) => shape.kind === 'test-run').map(
  (shape) => shape.id as TestRunShapeId,
);

/**
 * One test run as the executable editor saves it (`ExecutableRunBody`). The
 * outer wall only; which runs, shapes and paths a task may hold is the
 * service's (`editedExecutableSlice`), in sentences a teacher can act on.
 */
export class ExecutableRunDto {
  @IsString() @Matches(/^[a-z][a-z0-9-]{0,15}$/) id!: string;

  @IsIn(TEST_RUN_SHAPE_IDS) shape!: TestRunShapeId;

  @IsString() @MinLength(1) @MaxLength(RUN_LABEL_MAX) label!: string;

  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(RUN_PATH_MAX, { each: true }) testPaths!: string[];

  @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(RUN_PATH_MAX, { each: true }) visibleTests!: string[];

  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(RUN_PATH_MAX, { each: true }) learnerTestFiles!: string[];
}

/* ---- a story task's floor, stories and weighted rubric (`StoryChecksBody`, `RubricBody`) ---- */

// Every cap is `STORY_CAPS`, the one set the upload door (`validateStoryChecks`) reads too.
class AcceptanceCriterionDto { @IsString() @MaxLength(STORY_CAPS.criterionId) id!: string; @IsString() @MaxLength(STORY_CAPS.criterionSentence) given!: string; @IsString() @MaxLength(STORY_CAPS.criterionSentence) when!: string; @IsString() @MaxLength(STORY_CAPS.criterionSentence) then!: string; @IsIn(['happy', 'boundary', 'error']) tag!: CriterionTag; }
class ProvidedStoryDto { @IsString() @MaxLength(STORY_CAPS.storyId) id!: string; @IsString() @MaxLength(STORY_CAPS.storyTitle) title!: string; @IsString() @MaxLength(STORY_CAPS.sentencePart) persona!: string; @IsString() @MaxLength(STORY_CAPS.sentencePart) capability!: string; @IsString() @MaxLength(STORY_CAPS.sentencePart) benefit!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(STORY_CAPS.listItems) @ValidateNested({ each: true }) @Type(() => AcceptanceCriterionDto) criteria?: AcceptanceCriterionDto[]; }
class StoryHintsDto { @IsOptional() @IsString() @MaxLength(STORY_CAPS.sentencePart) persona?: string; @IsOptional() @IsString() @MaxLength(STORY_CAPS.sentencePart) capability?: string; @IsOptional() @IsString() @MaxLength(STORY_CAPS.sentencePart) benefit?: string; }
class LearnerStoryDto { @IsString() @MaxLength(STORY_CAPS.storyId) id!: string; @ValidateNested() @Type(() => StoryHintsDto) hints!: StoryHintsDto; }
class StoryFloorDto { @IsInt() @Min(STORY_CAPS.minCriteria[0]) @Max(STORY_CAPS.minCriteria[1]) minCriteria!: number; @IsArray() @IsIn(['happy', 'boundary', 'error'], { each: true }) requiredTags!: CriterionTag[]; @IsInt() @Min(STORY_CAPS.minExclusions[0]) @Max(STORY_CAPS.minExclusions[1]) minExclusions!: number; @IsBoolean() requireSentence!: boolean; }
/** The outer wall; the loader's own rules (`validateStoryChecks`) run in the service. */
export class StoryChecksDto { @IsArray() @ArrayMaxSize(STORY_CAPS.providedStories) @ValidateNested({ each: true }) @Type(() => ProvidedStoryDto) providedStories!: ProvidedStoryDto[]; @ValidateNested() @Type(() => LearnerStoryDto) learnerStory!: LearnerStoryDto; @ValidateNested() @Type(() => StoryFloorDto) floor!: StoryFloorDto; }
/* ---- a design task's switches, stories and floor (`DesignChecksBody`); every cap is `DESIGN_CAPS` ---- */

class DesignStoryDto { @IsString() @MaxLength(DESIGN_CAPS.storyId) id!: string; @IsString() @MaxLength(DESIGN_CAPS.storyText) title!: string; @IsString() @MaxLength(DESIGN_CAPS.storyText) line!: string; }
class DesignContractsDto { @IsBoolean() api!: boolean; @IsBoolean() screens!: boolean; }
class DesignFloorDto {
  @IsInt() @Min(DESIGN_CAPS.minEntities[0]) @Max(DESIGN_CAPS.minEntities[1]) minEntities!: number;
  @IsInt() @Min(DESIGN_CAPS.minRelations[0]) @Max(DESIGN_CAPS.minRelations[1]) minRelations!: number;
  @IsInt() @Min(DESIGN_CAPS.minOperations[0]) @Max(DESIGN_CAPS.minOperations[1]) minOperations!: number;
  @IsBoolean() operationShape!: boolean;
  @IsInt() @Min(DESIGN_CAPS.minDecisions[0]) @Max(DESIGN_CAPS.minDecisions[1]) minDecisions!: number;
  @IsBoolean() decisionShape!: boolean;
  @IsBoolean() traceEveryStory!: boolean;
  @IsInt() @Min(DESIGN_CAPS.minEndpoints[0]) @Max(DESIGN_CAPS.minEndpoints[1]) minEndpoints!: number;
  @IsBoolean() requireErrorCatalogue!: boolean;
  @IsInt() @Min(DESIGN_CAPS.minScreens[0]) @Max(DESIGN_CAPS.minScreens[1]) minScreens!: number;
  @IsBoolean() screenShape!: boolean;
}
/**
 * The outer wall; the loader's own rules (`validateDesignChecks`) run in the
 * service. `sequence` sits beside `contracts` and is required, so a builder
 * save always says whether the diagram is part of the artefact.
 */
export class DesignChecksDto {
  @ValidateNested() @Type(() => DesignContractsDto) contracts!: DesignContractsDto;
  @IsBoolean() sequence!: boolean;
  @IsArray() @ArrayMaxSize(DESIGN_CAPS.stories) @ValidateNested({ each: true }) @Type(() => DesignStoryDto) stories!: DesignStoryDto[];
  @ValidateNested() @Type(() => DesignFloorDto) floor!: DesignFloorDto;
}

/* ---- Deployment's runbook floor and Maintenance's ticket and change request; every cap is RUNBOOK_CAPS or CHANGE_CAPS ---- */

class RunbookFloorDto {
  @IsInt() @Min(RUNBOOK_CAPS.minEnvironment[0]) @Max(RUNBOOK_CAPS.minEnvironment[1]) minEnvironment!: number;
  @IsInt() @Min(RUNBOOK_CAPS.minHealth[0]) @Max(RUNBOOK_CAPS.minHealth[1]) minHealth!: number;
  @IsInt() @Min(RUNBOOK_CAPS.minRollback[0]) @Max(RUNBOOK_CAPS.minRollback[1]) minRollback!: number;
  @IsInt() @Min(RUNBOOK_CAPS.minData[0]) @Max(RUNBOOK_CAPS.minData[1]) minData!: number;
  @IsBoolean() requireIncident!: boolean;
}
/** The outer wall; the loader's own rules (`validateRunbookChecks`) run in the service. */
export class RunbookChecksDto { @ValidateNested() @Type(() => RunbookFloorDto) floor!: RunbookFloorDto; }

class AcceptanceLineDto { @IsString() @MaxLength(CHANGE_CAPS.acceptanceId) id!: string; @IsString() @MaxLength(CHANGE_CAPS.acceptanceLine) line!: string; }
/** The outer wall; `validateChangeTicket` runs in the service. */
export class ChangeTicketDto {
  @IsString() @MaxLength(CHANGE_CAPS.ticketId) id!: string;
  @IsString() @MaxLength(CHANGE_CAPS.ticketTitle) title!: string;
  @IsString() @MaxLength(CHANGE_CAPS.ticketSummary) summary!: string;
  @IsArray() @ArrayMaxSize(CHANGE_CAPS.acceptance) @ValidateNested({ each: true }) @Type(() => AcceptanceLineDto) acceptance!: AcceptanceLineDto[];
}
class ChangeFloorDto {
  @IsInt() @Min(CHANGE_CAPS.minImpact[0]) @Max(CHANGE_CAPS.minImpact[1]) minImpact!: number;
  @IsInt() @Min(CHANGE_CAPS.minContract[0]) @Max(CHANGE_CAPS.minContract[1]) minContract!: number;
  @IsInt() @Min(CHANGE_CAPS.minTests[0]) @Max(CHANGE_CAPS.minTests[1]) minTests!: number;
  @IsBoolean() requireRelease!: boolean;
  @IsBoolean() traceEveryAcceptance!: boolean;
}
/** The outer wall; the loader's own rules (`validateChangeChecks`) run in the service. */
export class ChangeChecksDto { @IsBoolean() contract!: boolean; @ValidateNested() @Type(() => ChangeFloorDto) floor!: ChangeFloorDto; }

class RubricCriterionDto { @IsString() @MaxLength(RUBRIC_CRITERION_KEY_MAX) key!: string; @IsString() @MaxLength(RUBRIC_CRITERION_TITLE_MAX) title!: string; @IsString() @MaxLength(RUBRIC_CRITERION_DESCRIPTION_MAX) description!: string; @IsNumber() @Min(0) @Max(1) weight!: number; }
/** The weights summing to 1 and the keys being unique are checked by `rubricFromBody` (authoring-bodies.ts). */
export class RubricDto { @IsInt() @Min(1) @Max(100) passThreshold!: number; @IsArray() @ArrayMaxSize(RUBRIC_CRITERIA_MAX) @ValidateNested({ each: true }) @Type(() => RubricCriterionDto) criteria!: RubricCriterionDto[]; }

/** Everything a task may be edited to. No `artefactPath`, and no `required`. */
export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(TASK_TITLE_MAX) title?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(TASK_BRIEF_MAX) brief?: string;

  @IsOptional() @IsIn(ARTEFACT_TYPES) artefactType?: ArtefactType;

  /** Absent means *unchanged*. */
  @IsOptional() @ValidateNested() @Type(() => AuthoredQuizDto) quiz?: AuthoredQuizDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TASK_OBJECTIVES_MAX)
  @IsString({ each: true })
  @MaxLength(TASK_OBJECTIVE_MAX, { each: true })
  objectives?: string[];

  /** New wording for criteria the task already has. Absent means unchanged. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RUBRIC_CRITERIA_MAX)
  @ValidateNested({ each: true })
  @Type(() => CriterionWordingDto)
  criteria?: CriterionWordingDto[];

  // `UpdateExecutableTaskBody`'s members, declared so the global whitelist
  // pipe does not strip them. Only a code or tests task
  // reads them; every other task refuses them in the service.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(RUN_PATH_MAX, { each: true })
  owns?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ExecutableRunDto)
  runs?: ExecutableRunDto[];

  /** A tests task's smallest suite; null on a code task (absent means unchanged). */
  @IsOptional() @IsInt() @Min(1) @Max(MIN_TESTS_MAX) minTests?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  coverageKeywords?: string[];

  // Whether a learner's pass of this task
  // waits for the teacher's countersignature. Absent means unchanged.
  @IsOptional() @IsBoolean() signOff?: boolean;

  // A story task's edit (`UpdateTaskBody.story`, `.rubric`). Absent means unchanged.
  @IsOptional() @ValidateNested() @Type(() => StoryChecksDto) story?: StoryChecksDto;

  // A design task's edit (`UpdateTaskBody.design`). Absent means unchanged.
  @IsOptional() @ValidateNested() @Type(() => DesignChecksDto) design?: DesignChecksDto;

  // Deployment's runbook floor (`UpdateTaskBody.runbook`), Maintenance's ticket and change request. Absent means unchanged.
  @IsOptional() @ValidateNested() @Type(() => RunbookChecksDto) runbook?: RunbookChecksDto;
  @IsOptional() @ValidateNested() @Type(() => ChangeTicketDto) ticket?: ChangeTicketDto;
  @IsOptional() @ValidateNested() @Type(() => ChangeChecksDto) change?: ChangeChecksDto;

  @IsOptional() @ValidateNested() @Type(() => RubricDto) rubric?: RubricDto;
}

/* ---- the doors that make a copy the teacher's own ---- */

/**
 * `phases.update`: the intro alone. The title is not a member (a phase's
 * title stays as the project has it) and the pipe strips it.
 */
export class UpdatePhaseDto {
  @IsString() @MinLength(1) @MaxLength(PHASE_INTRO_MAX) intro!: string;
}

/** The stakeholder, at the caps the authored interview prints them through. */
export class InterviewPersonaDto {
  @IsString() @MinLength(1) @MaxLength(INTERVIEW_PERSONA_NAME_MAX) name!: string;

  @IsString() @MinLength(1) @MaxLength(INTERVIEW_PERSONA_ROLE_MAX) role!: string;
}

/** One fact, at the content loader's own caps: the door and the loader refuse the same brief. */
export class InterviewFactDto {
  @IsString() @Matches(INTERVIEW_FACT_ID_PATTERN) id!: string;

  @IsString() @MinLength(1) @MaxLength(INTERVIEW_TOPIC_MAX) topic!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INTERVIEW_KEYWORDS_MAX)
  @IsString({ each: true })
  @MaxLength(INTERVIEW_KEYWORD_MAX, { each: true })
  keywords!: string[];

  @IsString() @MinLength(1) @MaxLength(INTERVIEW_ANSWER_MAX) answer!: string;
}

/**
 * `interview.replace`: the whole brief, as the loader reads one. The rules a
 * brief has to satisfy (`factsExpected` within the facts, ids unique, no
 * blank string) are the service's, in the loader's own words; these are the
 * outer wall.
 */
export class InterviewDto {
  @ValidateNested() @Type(() => InterviewPersonaDto) persona!: InterviewPersonaDto;

  @IsString() @MinLength(1) @MaxLength(INTERVIEW_LINE_MAX) opening!: string;

  @IsString() @MinLength(1) @MaxLength(INTERVIEW_LINE_MAX) unknownReply!: string;

  @IsString() @MinLength(1) @MaxLength(INTERVIEW_LINE_MAX) refusal!: string;

  @IsInt() @Min(INTERVIEW_MAX_TURNS_MIN) @Max(INTERVIEW_MAX_TURNS_CAP) maxTurns!: number;

  @IsInt() @Min(1) @Max(INTERVIEW_MAX_FACTS) factsExpected!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INTERVIEW_MAX_FACTS)
  @ValidateNested({ each: true })
  @Type(() => InterviewFactDto)
  facts!: InterviewFactDto[];
}

/** `files.replace`: which file the phase already mounts, and its new bytes. No role, no editability. */
export class ReplaceFileDto {
  @IsString() @MinLength(1) @MaxLength(300) path!: string;

  /** Required unless `reset` is sent; the editor's `writtenText` (authoring-bodies.ts) refuses a missing one on every other file. */
  @ValidateIf((o: ReplaceFileDto) => o.reset === undefined) @IsString() @MaxLength(REPLACE_FILE_CONTENT_MAX) content?: string;

  /** A design task's document, or a starting runbook or change request, put back as the version the draft was opened from holds it. */
  @IsOptional() @IsIn(['source']) reset?: 'source';
}

/** Requiredness is its own route, because it is its own teacher decision. */
export class SetTaskRequiredDto {
  @IsBoolean() required!: boolean;
}

/** The whole ordering: every key the phase holds, once each, in the order wanted. */
export class ReorderTasksDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  taskKeys!: string[];
}

export class PublishVersionDto {
  @IsString() @MaxLength(32) version!: string;

  @IsOptional() @IsString() @MaxLength(VERSION_NOTES_MAX) notes?: string;
}

/** The six phase keys, as the routes accept them in a path segment. */
export const PHASE_KEYS = PHASE_ORDER;

/* ---------------- upload, sealed-file and profile bodies ---------------- */

/**
 * `projects.upload`: the title the project takes and the archive, base64 in
 * JSON (the contract's `ProjectUploadRequest`). The archive's size is the upload service's to refuse by
 * sentence (`UploadService`), against the one cap `main.ts`'s parser shares,
 * so it carries no length decorator here that could answer first in other
 * words. The title likewise: the upload service refuses an empty, long or
 * non-text title as `UPLOAD_TITLE_INVALID`, in its own sentence, so the door
 * only lets the member through the whitelist.
 */
export class ProjectUploadDto {
  @Allow() title!: string;

  @IsString() archiveBase64!: string;
}

/**
 * The longest `contentBase64` a sealed file the sealed-role service accepts
 * can arrive as: its character cap at four UTF-8 bytes each, in base64, plus
 * a line break every 76 characters (the service's strict decoder strips
 * whitespace). Anything longer is refused at the door before a byte is decoded.
 */
export const SEALED_BASE64_MAX = (() => {
  const encoded = 4 * Math.ceil((4 * REPLACE_FILE_CONTENT_MAX) / 3);
  return encoded + 2 * Math.ceil(encoded / 76);
})();

/** `sealed.write` (the contract's `SealedFileWriteBody`): one sealed file, written whole. */
export class SealedFileWriteDto {
  @IsIn(SEALED_ROLE_KINDS) role!: SealedRoleKind;

  /**
   * The run the file belongs to: handed to the sealed-role service, which
   * refuses a run that is not the one the overlay grades the file in. Null or
   * absent leaves the placement to that service.
   */
  @IsOptional() @IsString() @MaxLength(RUN_ID_MAX) runId?: string | null;

  @IsString() @MinLength(1) @MaxLength(RUN_PATH_MAX) path!: string;

  @IsString() @MaxLength(SEALED_BASE64_MAX) contentBase64!: string;
}

/**
 * `sealed.read`'s query (the contract's `SealedFileReadQuery`). Optional at the door on
 * purpose: who may read is asked before what is asked for, so an ADMIN or
 * another teacher gets 403 / 404 whatever the query says, and the sealed-role service refuses a
 * missing or unknown role or path by its own sentence after that.
 */
export class SealedFileReadQueryDto {
  @IsOptional() @IsString() @MaxLength(RUN_ID_MAX) role?: SealedRoleKind;

  @IsOptional() @IsString() @MaxLength(RUN_PATH_MAX) path?: string;

  @IsOptional() @IsString() @MaxLength(RUN_ID_MAX) runId?: string;
}

/** `deepValidation.start` (the contract's `DeepValidationStartBody`): the count the teacher was shown. */
export class DeepValidationStartDto {
  @IsInt() @Min(0) @Max(1000) acknowledgedMicroVMs!: number;
}
