import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as path from 'path';
import {
  API_CONTRACT_JSON,
  CHANGE_REQUEST_JSON,
  CRITERION_TAGS,
  DEFAULT_DESIGN_CONTRACTS,
  DEFAULT_DESIGN_FLOOR,
  DEFAULT_DESIGN_SEQUENCE,
  DEFAULT_STORY_FLOOR,
  DESIGN_CAPS,
  DESIGN_OLDER_FORMAT_REFUSAL,
  DESIGN_JSON,
  EMPTY_API_CONTRACT,
  EMPTY_CHANGE_REQUEST,
  EMPTY_DESIGN,
  EMPTY_RUNBOOK,
  EMPTY_SCREEN_CONTRACT,
  EMPTY_STORY,
  EXECUTABLE_SPLIT_NOT_READY,
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_FACT_ID_PATTERN,
  INTERVIEW_MAX_FACTS,
  INTERVIEW_MAX_TURNS_CAP,
  INTERVIEW_TOPIC_MAX,
  LEARNER_PICKS,
  ONLY_DEPLOYMENT_RUNBOOK,
  ONLY_MAINTENANCE_CHANGE,
  PHASE_ORDER,
  PHASE_TITLES,
  REQUIREMENTS_OLDER_FORMAT_REFUSAL,
  RUNBOOK_JSON,
  SCREEN_CONTRACT_JSON,
  STORY_CAPS,
  STORY_JSON,
  compareProjectVersions,
  designDocumentError,
  mountedSwitchedOffContract,
  designDocumentPaths,
  serialiseChangeRequest,
  serialiseDesign,
  serialiseRunbook,
  serialiseStory,
  sortedMounts,
  validateChangeTicket,
  retiredWrittenPhaseUploadRefusal,
  rubricCapBreaches,
} from '@learnsdlc/shared';
import type {
  ArtifactKind,
  LearnerStorySpec,
  PhaseKey,
  PhaseRubric,
  ProvidedStory,
  RunHarness,
  RunLanguage,
  StoryFloor,
  WorkspaceFile,
} from '@learnsdlc/shared';
import { config } from '../config';
import {
  BuildSpec,
  CodeChecks,
  ConfigChecks,
  ContentFileSpec,
  CoverageKeywordSpec,
  DesignChecks,
  DrillSpec,
  FileRule,
  InterviewBrief,
  InterviewFact,
  MutantSpec,
  PhaseChecks,
  PhaseContent,
  PhaseInputs,
  PhaseRun,
  PreviewSpec,
  ProjectContent,
  RuntimeSpec,
  StoryChecks,
} from './content.types';
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from './pack-compiler';
import { PackSource, directoryPacksIn, readRunnerFile } from './pack-source';
import { LayoutWalkRefusal } from './pack-source';
import { derivePack, folderInputs, isFolderLayout, LAYOUT_SENTENCES, LayoutRefusal } from './folder-layout';
import {
  validateRunbookChecks, validateChangeChecks, startingRunbookProblem, startingChangeProblem,
  recordCriteriaOf,
} from './checks-validation';
import { scoredKeysFor, scorerSourceFor } from './rubric-scoring';
import { servablePhase } from './servable-phase';
// story-legacy, design-legacy, runbook-legacy and change-legacy import their
// validators from this module; the cycle is safe because each side calls the
// other only from inside a function.
import { changeChecksFromLegacy } from './change-legacy';
import { designChecksFromLegacyMarkdown } from './design-legacy';
import { runbookChecksFromLegacy } from './runbook-legacy';
import { storyChecksFromLegacyMarkdown } from './story-legacy';
import { loadWarmup } from './warmup.loader';
import { HARNESSES_FOR, RUN_HARNESSES, RUN_LANGUAGES } from './run-languages';
import { VERSION_PATTERN, optString, req, reqString, reqStringArray } from './validate';

/**
 * The kinds a phase may declare as its own `artifactKind` at boot.
 *
 * ONE OF THE SITES THE COMPILER IS SILENT ABOUT. It is
 * a `readonly ArtifactKind[]`, so a fifth member of the type does not move it
 * and nothing errors; it simply goes stale, and a phase declaring `"quiz"` is
 * refused at boot with *"not one of story, design, code, tests, config"*: a
 * sentence about a list that is wrong rather than about a shape that is. The
 * older `markdown` kind is not among them: only the Requirements and Design
 * conversions read it, and `loadPhase` reads it as a string.
 *
 * Exported so the spec that pins it reads the list the loader reads, rather
 * than a second copy of it.
 */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'story',
  'design',
  'code',
  'tests',
  'config',
  'quiz',
];

/** Interpreters a pack's smoke commands may name, matching the sandbox runner. */
const SMOKE_INTERPRETERS = new Set(['python', 'python3', 'node']);

/* ------------------------------ run languages ---------------------------- */

/**
 * A run id: it is the `step` stamped on every merged case and the group label
 * in the Tests pane, so it is short, stable and quotable in a mutant's meta.
 */
const RUN_ID = /^[a-z][a-z0-9-]{0,15}$/;

/** The run a phase that declares none is given, so every reader has a list. */
const DEFAULT_RUN_ID = 'main';
const DEFAULT_RUN_LABEL = 'Tests';

/** A pip requirement pinned exactly: a range makes what a learner runs a date. */
const PIP_PIN = /^[a-z0-9][a-z0-9._-]*==[0-9][0-9A-Za-z.+-]*$/;
/** An npm version pinned exactly: no `^`, no `~`, no range. */
const SEMVER_PIN = VERSION_PATTERN;

/** An environment key a pack may set on its preview service. */
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * Environment the runner computes itself. A pack that set one of these would
 * either be quietly overridden or would point the jail's own library path at
 * something it shipped, so naming one is a boot error rather than a surprise.
 */
const RESERVED_ENV = new Set([
  'PATH',
  'PYTHONDONTWRITEBYTECODE',
  'PYTHONHASHSEED',
  'HOME',
  'TASKTRACKR_DATA',
  'LEARNSDLC_NOW',
  'LSDLC_PYLIB',
  'NODE_PATH',
  'ESBUILD_BIN',
]);

/** Interpreters a pack's preview commands may name: the smoke rule, again. */
const PREVIEW_INTERPRETERS = new Set(['python3', 'node']);

/**
 * The half of a `checks.runs[]` entry every kind shares, read before the
 * phase's own kind fills in the files it runs.
 */
interface RunHeader {
  id: string;
  language: RunLanguage;
  harness: RunHarness;
  hiddenHarness: RunHarness;
  label: string;
  transform: boolean;
  /** The authored entry, so the kind can read the keys only it knows. */
  spec: Record<string, unknown>;
}

/** True when `entry` names one of `candidates`, or a directory holding one. */
function covers(entry: string, candidates: string[]): boolean {
  return candidates.some((c) => c === entry || c.startsWith(`${entry}/`));
}

/** The harness a language runs under when the pack names none. */
function defaultHarness(language: RunLanguage): RunHarness {
  return language === 'python' ? 'unittest' : 'js';
}

/** A path a pack may name: relative, and inside the workspace. */
function reqWorkspacePath(value: unknown, field: string): string {
  const at = reqString(value, field);
  const normalized = path.normalize(at);
  req(
    !path.isAbsolute(at) && !normalized.startsWith('..') && normalized !== '.',
    `${field} ("${at}") must be a relative path inside the workspace`,
  );
  return at;
}

/**
 * One `NAME = { ... }` literal out of a Python module, as the set of strings
 * it names. Version strings are dropped, so a `{"esbuild": "0.24.2"}` mapping
 * reads as the tool name it allows.
 */
function pythonNameSet(source: string, name: string): Set<string> | null {
  const declared = new RegExp(`^${name}\\s*[:=]`, 'm').exec(source);
  if (!declared) return null;
  const open = source.indexOf('{', declared.index);
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const body = source.slice(open + 1, close);
  return new Set(
    [...body.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]).filter((v) => !/^\d/.test(v)),
  );
}

/**
 * The runner's own package allowlist (`ALLOWED_PYTHON`, `ALLOWED_NODE`,
 * `ALLOWED_TOOLS` in `apps/api/runner/runtime_manifest.py`).
 *
 * The allowlist lives in the runner rather than in the pack on purpose: a pack
 * declares what it needs pre-baked, but adding a dependency to the jail is a
 * code change with a review, not a content edit. Null when the manifest is not
 * on this tree yet: the pre-bake is then missing too, and the run says so
 * with the sentence that names `npm run prebake` rather than the loader
 * refusing to boot over a file the runner owns.
 */
const allowlistCache = new Map<string, Set<string> | null>();
function runnerAllowlist(name: string): Set<string> | null {
  const at = path.join(config.runnerDir, 'runtime_manifest.py');
  const key = `${at}:${name}`;
  if (!allowlistCache.has(key)) {
    const source = readRunnerFile(config.runnerDir, 'runtime_manifest.py') ?? '';
    allowlistCache.set(key, source ? pythonNameSet(source, name) : null);
  }
  return allowlistCache.get(key) ?? null;
}

/**
 * An interview fact id: short, and safe to print in a data-testid.
 *
 * The interview's caps are the shared contract's own constants
 * (`INTERVIEW_FACT_ID_PATTERN`, `INTERVIEW_MAX_FACTS` (a
 * customer with more than twenty things to say is a document, not an
 * interview), `INTERVIEW_MAX_TURNS_CAP` (nobody has forty questions, and a cap
 * the pack cannot exceed keeps the room finite), `INTERVIEW_TOPIC_MAX` and
 * `INTERVIEW_ANSWER_MAX`), so the loader and the authoring door cannot drift
 * apart. The content golden pins the loader's output.
 */
const INTERVIEW_FACT_ID = INTERVIEW_FACT_ID_PATTERN;

/** A pack version (`VERSION_PATTERN`) is short enough to store beside every enrolment and submission. */
const VERSION_MAX_LENGTH = 32;

/** A markdown file's path, `.md` or `.markdown` in any case: what a Design, Deployment or Maintenance phase never mounts. */
const MARKDOWN_PATH = /\.(md|markdown)$/i;

/**
 * The record the loader writes for a story phase that ships none: an empty
 * story seeded with the learner's story id, unless the learner picks it. The
 * export leaves out a record that is still this, so the upload seeds it again.
 */
export function seededStoryRecord(checks: StoryChecks): string {
  return serialiseStory({ ...EMPTY_STORY, id: checks.learnerStory.id === LEARNER_PICKS ? '' : checks.learnerStory.id });
}

/**
 * The loader's rules for `checks.kind: "story"`, as one pure function: the
 * pack loader and the task editor both call it, so both refuse exactly the
 * same checks in exactly the same words. Missing floor fields take
 * `DEFAULT_STORY_FLOOR`'s values; a missing learner story is `US-4` with no
 * hints; a missing `record` is `STORY_JSON`.
 *
 * `phaseKey` is the phase the checks belong to, when the caller knows it:
 * only Requirements may be a story phase.
 *
 * Every cap is the editor DTO's (`STORY_CAPS`, which `StoryChecksDto` reads),
 * so a pack can hold nothing the editor would refuse. Throws an `Error` with
 * one fixed sentence naming the field, as every other pack rule does; the
 * upload door carries it as NOT_A_PACK's detail.
 */
export function validateStoryChecks(spec: unknown, phaseKey?: PhaseKey): StoryChecks {
  req(spec && typeof spec === 'object' && !Array.isArray(spec), 'checks must be an object');
  req(phaseKey === undefined || phaseKey === 'requirements', 'Only the Requirements phase can use the story kind.');
  const raw = spec as Record<string, unknown>;
  req(raw.record === undefined || raw.record === STORY_JSON, `The story record is always ${STORY_JSON}.`);
  const floorRaw = (raw.floor ?? {}) as Record<string, unknown>;
  const floor = {
    minCriteria: floorRaw.minCriteria ?? DEFAULT_STORY_FLOOR.minCriteria,
    requiredTags: floorRaw.requiredTags ?? DEFAULT_STORY_FLOOR.requiredTags,
    minExclusions: floorRaw.minExclusions ?? DEFAULT_STORY_FLOOR.minExclusions,
    requireSentence: floorRaw.requireSentence ?? DEFAULT_STORY_FLOOR.requireSentence,
  } as StoryFloor;
  req(
    Number.isInteger(floor.minCriteria) &&
      floor.minCriteria >= STORY_CAPS.minCriteria[0] &&
      floor.minCriteria <= STORY_CAPS.minCriteria[1],
    `floor.minCriteria must be between ${STORY_CAPS.minCriteria[0]} and ${STORY_CAPS.minCriteria[1]}`,
  );
  req(
    Number.isInteger(floor.minExclusions) &&
      floor.minExclusions >= STORY_CAPS.minExclusions[0] &&
      floor.minExclusions <= STORY_CAPS.minExclusions[1],
    `floor.minExclusions must be between ${STORY_CAPS.minExclusions[0]} and ${STORY_CAPS.minExclusions[1]}`,
  );
  req(
    Array.isArray(floor.requiredTags) &&
      floor.requiredTags.every((t) => CRITERION_TAGS.some((k) => k.value === t)),
    'floor.requiredTags must be happy, boundary or error',
  );
  req(typeof floor.requireSentence === 'boolean', 'floor.requireSentence must be true or false');
  req(raw.providedStories === undefined || Array.isArray(raw.providedStories), 'providedStories must be a list.');
  const providedStories = (raw.providedStories ?? []) as ProvidedStory[];
  req(
    providedStories.length <= STORY_CAPS.providedStories,
    `at most ${STORY_CAPS.providedStories} providedStories`,
  );
  const PART_CAP = { title: STORY_CAPS.storyTitle, persona: STORY_CAPS.sentencePart, capability: STORY_CAPS.sentencePart, benefit: STORY_CAPS.sentencePart } as const;
  for (const s of providedStories) {
    req(s && typeof s === 'object' && !Array.isArray(s), 'Each provided story must be an object.');
    for (const f of ['id', 'title', 'persona', 'capability', 'benefit'] as const) {
      req(typeof s[f] === 'string' && s[f].trim().length > 0, `providedStories.${f} is required`);
    }
    req(s.id.length <= STORY_CAPS.storyId, `A provided story id is longer than ${STORY_CAPS.storyId} characters.`);
    for (const f of ['title', 'persona', 'capability', 'benefit'] as const) {
      req(s[f].length <= PART_CAP[f], `Provided story ${s.id} has a ${f} longer than ${PART_CAP[f]} characters.`);
    }
    // a worked example with a blank clause teaches the very gap the floor
    // refuses in the learner's own story, so it is refused here, fail-closed
    const criteria = (s as { criteria?: unknown }).criteria;
    req(criteria === undefined || Array.isArray(criteria), `providedStories.criteria of ${s.id} must be a list`);
    req(((criteria ?? []) as unknown[]).length <= STORY_CAPS.listItems, `Provided story ${s.id} has more than ${STORY_CAPS.listItems} criteria.`);
    for (const c of (criteria ?? []) as unknown[]) {
      req(c && typeof c === 'object' && !Array.isArray(c), `Provided story ${s.id} has a criterion that is not an object.`);
      const clause = c as Record<string, unknown>;
      req(
        typeof clause.id === 'string' && clause.id.trim().length > 0 && clause.id.length <= STORY_CAPS.criterionId,
        `Provided story ${s.id} has a criterion id that is empty or longer than ${STORY_CAPS.criterionId} characters.`,
      );
      req(CRITERION_TAGS.some((k) => k.value === clause.tag), `Provided story ${s.id} has a criterion whose tag is not happy, boundary or error.`);
      req(
        (['given', 'when', 'then'] as const).every((k) => typeof clause[k] === 'string' && (clause[k] as string).trim().length > 0),
        `Provided story ${s.id} has a criterion with an empty Given, When or Then.`,
      );
      req(
        (['given', 'when', 'then'] as const).every((k) => (clause[k] as string).length <= STORY_CAPS.criterionSentence),
        `Provided story ${s.id} has a criterion clause longer than ${STORY_CAPS.criterionSentence} characters.`,
      );
    }
  }
  req(
    new Set(providedStories.map((s) => s.id)).size === providedStories.length,
    'providedStories ids must be unique',
  );
  const learner = (raw.learnerStory ?? { id: 'US-4', hints: {} }) as LearnerStorySpec;
  req(learner && typeof learner === 'object' && !Array.isArray(learner), 'learnerStory must be an object.');
  req(typeof learner.id === 'string' && learner.id.trim().length > 0, 'learnerStory.id is required');
  req(learner.id.length <= STORY_CAPS.storyId, `learnerStory.id is longer than ${STORY_CAPS.storyId} characters.`);
  req(
    !providedStories.some((s) => s.id === learner.id),
    'learnerStory.id must not be a provided story',
  );
  const rawHints = (learner.hints ?? {}) as Record<string, unknown>;
  req(rawHints && typeof rawHints === 'object' && !Array.isArray(rawHints), 'learnerStory.hints must be an object of text hints.');
  for (const f of ['persona', 'capability', 'benefit'] as const) {
    req(rawHints[f] === undefined || typeof rawHints[f] === 'string', `learnerStory.hints.${f} must be text.`);
    req(((rawHints[f] as string | undefined) ?? '').length <= STORY_CAPS.sentencePart, `learnerStory.hints.${f} is longer than ${STORY_CAPS.sentencePart} characters.`);
  }
  const hints = {
    persona: rawHints.persona as string | undefined,
    capability: rawHints.capability as string | undefined,
    benefit: rawHints.benefit as string | undefined,
  };
  return {
    kind: 'story',
    record: STORY_JSON,
    providedStories,
    learnerStory: { id: learner.id, hints },
    floor,
  };
}

/** The record the loader writes for a design phase that ships none: the empty design. */
export function seededDesignRecord(): string {
  return serialiseDesign(EMPTY_DESIGN);
}

/** What a design document starts as when nothing ships it: the empty record, the empty API contract, the empty screen contract. */
export function seededDesignDocument(at: string): string {
  return at === DESIGN_JSON ? seededDesignRecord() : at === API_CONTRACT_JSON ? EMPTY_API_CONTRACT : EMPTY_SCREEN_CONTRACT;
}

/**
 * Mount, seeded, each design document the checks switch on and the files do
 * not hold: the record first, the contracts after it, api then screens. The
 * pack loader and a teacher's draft compile both seed through this, so a
 * draft whose record row is missing compiles to what a pack shipping none loads to.
 */
export function seedDesignDocuments(files: ContentFileSpec[], checks: DesignChecks): void {
  for (const at of designDocumentPaths(checks.contracts)) {
    if (files.some((one) => one.path === at)) continue;
    const file: ContentFileSpec = { path: at, content: seededDesignDocument(at), editable: true, language: 'json' };
    if (at === DESIGN_JSON) files.unshift(file);
    else files.push(file);
  }
  // the record is the first document whether it was seeded or shipped
  const record = files.findIndex((one) => one.path === DESIGN_JSON);
  if (record > 0) files.unshift(...files.splice(record, 1));
}

const DESIGN_FLOOR_RANGES = ['minEntities', 'minRelations', 'minOperations', 'minDecisions', 'minEndpoints', 'minScreens'] as const;
const DESIGN_FLOOR_TOGGLES = ['operationShape', 'decisionShape', 'traceEveryStory', 'requireErrorCatalogue', 'screenShape'] as const;

/**
 * The loader's rules for `checks.kind: "design"`, one pure function: the pack
 * loader, the task editor and the upload door all call it, so all three refuse
 * the same checks in the same words, at the caps `DESIGN_CAPS` holds. Missing
 * fields take the defaults (the sequence diagram off); unknown keys are
 * dropped. `phaseKey`, when the caller knows it: only Design may be a design
 * phase. Throws an `Error` with one fixed sentence naming the field.
 */
export function validateDesignChecks(spec: unknown, phaseKey?: PhaseKey): DesignChecks {
  req(spec && typeof spec === 'object' && !Array.isArray(spec), 'checks must be an object');
  req(phaseKey === undefined || phaseKey === 'design', 'Only the Design phase can use the design kind.');
  const raw = spec as Record<string, unknown>;
  req(raw.record === undefined || raw.record === DESIGN_JSON, `The design record is always ${DESIGN_JSON}.`);
  const c = (raw.contracts ?? {}) as Record<string, unknown>;
  req(c && typeof c === 'object' && !Array.isArray(c), 'contracts must be an object.');
  const contracts = { api: c.api ?? DEFAULT_DESIGN_CONTRACTS.api, screens: c.screens ?? DEFAULT_DESIGN_CONTRACTS.screens };
  req(
    typeof contracts.api === 'boolean' && typeof contracts.screens === 'boolean',
    'contracts.api and contracts.screens must be true or false.',
  );
  // the sequence diagram is off unless the teacher switches it on (spec section 4)
  const sequence = raw.sequence ?? DEFAULT_DESIGN_SEQUENCE;
  req(typeof sequence === 'boolean', 'sequence must be true or false.');
  req(raw.stories === undefined || Array.isArray(raw.stories), 'stories must be a list.');
  const list = (raw.stories ?? []) as unknown[];
  req(list.length <= DESIGN_CAPS.stories, `at most ${DESIGN_CAPS.stories} stories`);
  const stories = list.map((s) => {
    req(s && typeof s === 'object' && !Array.isArray(s), 'Each story must be an object.');
    const o = s as Record<string, unknown>;
    for (const f of ['id', 'title', 'line'] as const) {
      req(typeof o[f] === 'string' && (o[f] as string).trim().length > 0, `stories.${f} is required`);
    }
    req((o.id as string).length <= DESIGN_CAPS.storyId, `A story id is longer than ${DESIGN_CAPS.storyId} characters.`);
    req(
      (o.title as string).length <= DESIGN_CAPS.storyText && (o.line as string).length <= DESIGN_CAPS.storyText,
      `Story ${o.id as string} has a title or line longer than ${DESIGN_CAPS.storyText} characters.`,
    );
    return { id: o.id as string, title: o.title as string, line: o.line as string };
  });
  req(new Set(stories.map((s) => s.id)).size === stories.length, 'stories ids must be unique');
  const f = (raw.floor ?? {}) as Record<string, unknown>;
  req(f && typeof f === 'object' && !Array.isArray(f), 'floor must be an object.');
  const floor = { ...DEFAULT_DESIGN_FLOOR };
  for (const key of DESIGN_FLOOR_RANGES) {
    const value = f[key] ?? DEFAULT_DESIGN_FLOOR[key];
    const [lo, hi] = DESIGN_CAPS[key];
    req(
      Number.isInteger(value) && (value as number) >= lo && (value as number) <= hi,
      `floor.${key} must be between ${lo} and ${hi}`,
    );
    floor[key] = value as number;
  }
  for (const key of DESIGN_FLOOR_TOGGLES) {
    const value = f[key] ?? DEFAULT_DESIGN_FLOOR[key];
    req(typeof value === 'boolean', `floor.${key} must be true or false`);
    floor[key] = value as boolean;
  }
  return { kind: 'design', record: DESIGN_JSON, contracts: contracts as DesignChecks['contracts'], sequence: sequence as boolean, stories, floor };
}

/**
 * The content loader's interview rules, as one pure function. The loader calls it on a pack's brief and the authoring
 * door calls it on a teacher's, so both refuse exactly the same briefs in
 * exactly the same words, and both keep what they return: a new object with
 * only the loader's fields, every string **as sent** once it is not blank (the
 * loader never trims), so a teacher who re-saves the interview they copied
 * stores it byte for byte.
 *
 * Throws an `Error` naming the field, as every other pack rule does.
 */
export function validateInterviewBrief(spec: unknown): InterviewBrief {
  req(spec && typeof spec === 'object' && !Array.isArray(spec), 'interview must be an object');
  const raw = spec as Record<string, unknown>;

  const persona = (raw.persona || {}) as Record<string, unknown>;
  const brief: InterviewBrief = {
    persona: {
      name: reqString(persona.name, 'interview.persona.name'),
      role: reqString(persona.role, 'interview.persona.role'),
    },
    opening: reqString(raw.opening, 'interview.opening'),
    unknownReply: reqString(raw.unknownReply, 'interview.unknownReply'),
    refusal: reqString(raw.refusal, 'interview.refusal'),
    maxTurns: 0,
    factsExpected: 0,
    facts: interviewFactsOf(raw.facts),
  };

  req(
    Number.isInteger(raw.maxTurns) &&
      (raw.maxTurns as number) >= 1 &&
      (raw.maxTurns as number) <= INTERVIEW_MAX_TURNS_CAP,
    `interview.maxTurns must be an integer 1..${INTERVIEW_MAX_TURNS_CAP}`,
  );
  brief.maxTurns = raw.maxTurns as number;

  req(
    Number.isInteger(raw.factsExpected) &&
      (raw.factsExpected as number) >= 1 &&
      (raw.factsExpected as number) <= brief.facts.length,
    `interview.factsExpected must be an integer between 1 and the ${brief.facts.length} facts declared`,
  );
  brief.factsExpected = raw.factsExpected as number;
  return brief;
}

function interviewFactsOf(raw: unknown): InterviewFact[] {
  req(Array.isArray(raw) && raw.length > 0, 'interview.facts must be a non-empty array');
  const rows = raw as Record<string, unknown>[];
  req(
    rows.length <= INTERVIEW_MAX_FACTS,
    `interview.facts must hold at most ${INTERVIEW_MAX_FACTS} facts`,
  );
  const seen = new Set<string>();
  return rows.map((fact, i) => {
    const at = `interview.facts[${i}]`;
    req(fact && typeof fact === 'object', `${at} must be an object`);
    const id = reqString(fact.id, `${at}.id`);
    req(INTERVIEW_FACT_ID.test(id), `${at}.id ("${id}") must match ${INTERVIEW_FACT_ID}`);
    req(!seen.has(id), `${at}: duplicate fact id "${id}"`);
    seen.add(id);
    const topic = reqString(fact.topic, `${at}.topic`);
    req(topic.length <= INTERVIEW_TOPIC_MAX, `${at}.topic must be at most ${INTERVIEW_TOPIC_MAX} characters`);
    const keywords = reqStringArray(fact.keywords, `${at}.keywords`);
    req(keywords.length > 0, `${at}.keywords must not be empty`);
    const answer = reqString(fact.answer, `${at}.answer`);
    req(answer.length <= INTERVIEW_ANSWER_MAX, `${at}.answer must be at most ${INTERVIEW_ANSWER_MAX} characters`);
    return { id, topic, keywords, answer };
  });
}

/*
 * Validation (`validate.ts`) covers the keys the loader reads; keys a pack has
 * not adopted yet are simply absent, never invalid.
 */

/** A platform pack's Deployment and Maintenance carry their records; an upload converts an older shape at the door instead. */
export function requireRecords(project: ProjectContent): void {
  for (const phase of project.phases) {
    req(!(phase.key === 'deployment' && phase.checks.kind === 'config' && !phase.checks.runbook), `${project.slug}: A Deployment phase of the config kind carries checks.runbook.`);
    req(!(phase.key === 'maintenance' && phase.checks.kind === 'code' && !phase.checks.change), `${project.slug}: A Maintenance phase of the code kind carries checks.ticket and checks.change.`);
  }
}

/** How `loadProject` reads a teacher's own pack. The platform's packs pass none of it. */
export interface LoadProjectOptions {
  /**
   * A Requirements phase written before the story kind (a markdown backlog,
   * the learner's markdown story file and regex rules) loads as a story phase
   * with the default floor. Only the teacher upload door, the teacher-draft import
   * and the export's read-back (which reads an archive as the upload door does)
   * ask for it; false by default.
   */
  convertLegacyRequirements?: boolean;
  /**
   * A Design phase written before the design kind (markdown targets, regex
   * rules, a mounted backlog and design document) loads as a design phase
   * with the default floor, its rules as criterion sentences, a contract on
   * exactly when the phase mounts it and the sequence diagram off. Only the
   * teacher upload door, the teacher-draft import and the export's read-back
   * (which reads an archive as the upload door does) ask for it; false by
   * default.
   */
  convertLegacyDesign?: boolean;
  /**
   * A config Deployment written before the runbook record (rules over a
   * mounted RUNBOOK.md, its brief in task.md) loads with a runbook: RUNBOOK.md
   * the starting record, its runbook rules as criterion sentences, its brief
   * inline. Only the teacher upload door, the teacher-draft import
   * and the export's read-back (which reads an archive as the upload door
   * does) ask for it; the platform loader never does.
   */
  convertLegacyRunbook?: boolean;
  /**
   * A code Maintenance written before the change request (no ticket, no
   * change, perhaps a mounted CHANGELOG.md) loads with a ticket built from its
   * brief and a change request, CHANGELOG.md the starting record, its brief
   * inline. Only the teacher upload door, the teacher-draft import
   * and the export's read-back (which reads an archive as the upload door
   * does) ask for it; the platform loader never does.
   */
  convertLegacyChange?: boolean;
  /** Each conversion's note is pushed here, so the upload can tell the teacher. */
  warnings?: string[];
  /**
   * Who hands the loader a folder-layout pack: `'upload'` for the
   * door's two loads and the export's read-back, which read a teacher's
   * archive and keep its `quizzes/` for the quiz door; `'platform'`, the
   * default, for every pack the platform ships, where a `quizzes/` folder is
   * refused.
   */
  origin?: 'platform' | 'upload';
}

/**
 * What an enrolment has to say for its content to be resolved.
 *
 * The two columns every one of the enrolment-scoped resolution sites already
 * holds, and nothing else: the slug every other table keys on, and the pin.
 * It is a structural type rather than `EnrollmentEntity` so that this module
 * stays free of the database layer, and so that a caller holding a phase state's
 * parent enrolment can pass it without a cast.
 */
export interface EnrollmentPin {
  projectSlug: string;
  /** `project_versions.id`, or null for a row made before projects had versions. */
  projectVersionId: string | null;
}

/** One published version, as `ProjectRegistryService` hands it over. */
export interface RegisteredVersion {
  /** `project_versions.id`: what `enrollments.projectVersionId` names. */
  versionId: string;
  /** The version's `compiled.content`: exactly what the loader built at boot. */
  content: ProjectContent;
  /**
   * `compiled.compiler`: which build's compile rules produced the snapshot.
   *
   * The empty string for a row written before the identity was recorded, which
   * *is* a drift: a snapshot this build did not compile. Absent is a
   * different thing and is not a drift: a spec that installs content by hand
   * has no stored snapshot and no build to name, so there is nothing to
   * compare. `ProjectRegistryService` always states it.
   */
  compiler?: string;
  /**
   * `compiled.phases`: the task list each phase of this version compiled to.
   *
   * Every question the task grain asks (which keys gate a phase, which task a
   * submission is about, which rules it owns) is a question about this list.
   * Carrying it here is what makes the list a learner is served the list the
   * version they hold was **published** with, rather than one synthesised at
   * read time over content that may have moved.
   *
   * Absent for a caller with no stored snapshot to hand over (a spec that
   * installs content by hand, a directory walk), and an absent list resolves
   * the phase's sole task, which is exactly what a phase declaring no tasks
   * compiles to.
   */
  phases?: CompiledPhaseTasks[];
}

/**
 * A registered version holding a phase this build cannot grade: more than one
 * task in a phase whose work is executed, unless exactly one task does all of
 * that executable work.
 *
 * This build serves several tasks in a phase only where the work is
 * **written**, or where one task owns all of the executable work. The compiler
 * refuses to publish anything else, but a compiled snapshot is
 * immutable and is installed verbatim, `installVersions` records a compiler
 * mismatch as a warning and installs the version anyway, and the rule is not
 * reflected in `COMPILER_IDENTITY`, so there is no drift signal either. Composed, a compile-only wall has no statement at all against a
 * snapshot that arrives from somewhere else: a rolling upgrade, the revert of
 * one, or a restore from a later build's backup.
 *
 * What that would cost is not a spend but a score: the executable builders keep
 * reading `phase.checks` verbatim, so both tasks would be graded
 * against the whole phase's suite and each task's `bestScore` would carry the
 * sibling's work into the phase's roll-up.
 *
 * So the fact is recorded here at install, where an operator reads it at boot,
 * and the version is refused at the one seam an enrolment resolves through.
 * Nothing this build can produce takes that shape; this is the statement that
 * says so.
 */
export interface UnservableVersion {
  /** `project_versions.id`, which is what an enrolment's pin names. */
  versionId: string;
  slug: string;
  version: string;
  /** The first phase of the version that cannot be graded. */
  phaseKey: string;
  /** How many tasks it holds. */
  tasks: number;
}

/**
 * One unservable version, in the sentence the boot log and the refusal share.
 *
 * The wall refuses a *shape*, not a *count*, so the clause that names the
 * reason names the two arms a snapshot may take: written work all the way
 * down, or one task doing the executable work. The phase, the count,
 * `EXECUTABLE_SPLIT_NOT_READY` and the operator's two remedies are what an
 * operator reads.
 */
export function describeUnservableVersion(one: UnservableVersion): string {
  return (
    `${one.slug} ${one.version} holds the phase "${one.phaseKey}" with ${one.tasks} tasks, and ` +
    'that phase neither grades written work alone nor leaves exactly one task doing its ' +
    `executable work. ${EXECUTABLE_SPLIT_NOT_READY} This build cannot ` +
    'grade it — it would grade every task against the whole phase, scoring one task’s work ' +
    'into another’s — so the version is refused rather than served. Deploy a build that can ' +
    'grade it, or publish a version this one can.'
  );
}

/**
 * One phase of a resolved project, with the loader's 404 for an unknown key.
 *
 * Written once because three accessors ask it (`getPhase` of the head,
 * `getPhaseForEnrollment` of the pin and `getTasksForEnrollment` before it
 * looks a task list up), and the sentence a learner's browser and the harness
 * both read must be the same one in all three.
 */
function phaseOf(project: ProjectContent, key: string): PhaseContent {
  const phase = project.phases.find((one) => one.key === key);
  if (!phase) throw new NotFoundException(`unknown phase: ${key}`);
  return phase;
}

/**
 * A registered version whose snapshot this build's compiler did not produce.
 *
 * It is not an error and it is not repaired: a published version is immutable
 * and an enrolment pinned to it resolves the snapshot it was published with,
 * which is the whole reason the pin works. What it is, is a fact an operator
 * has to be able to see, so it is read out of the registry by the readiness
 * report and printed by the import CLI, rather than being a warning in a log
 * nobody is tailing. The fix is always the same: bump the pack's version and
 * import it, which publishes this build's compile of it beside the old one.
 */
export interface CompilerDrift {
  slug: string;
  version: string;
  /** The identity stored with the snapshot. */
  compiledBy: string;
  /** `COMPILER_IDENTITY` of the code that is running. */
  thisBuild: string;
}

/** One drift, in the sentence the readiness detail, the CLI and the log all print. */
export function describeCompilerDrift(drift: CompilerDrift): string {
  return (
    `${drift.slug} ${drift.version} was compiled by ${drift.compiledBy} and this build is ` +
    `${drift.thisBuild}. It is served exactly as it was published, because a published version ` +
    "is immutable and an enrolment pinned to it resolves what it started on — bump the pack's " +
    "version to publish this build's compile of it."
  );
}

/**
 * Loads reference-project bundles into memory through a `PackSource`.
 * Content is data, not code: files, rubrics, prompts and check rules. The
 * same directory format is the authoring format for new projects.
 *
 * Every read goes through the source rather than through `fs`: what
 * a pack *declares* is this file's business, and *where its bytes are* is the
 * source's. The directory-backed source is what boot and the importer use, and
 * it is the only one there is, so the loader's own refusal sentences,
 * overlay rules and path arithmetic are the same whatever the source, which is
 * what `content-golden.spec.ts` is there to prove.
 */
@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);
  /** The published head of each project, by slug: what a request naming one answers. */
  private projects = new Map<string, ProjectContent>();
  /**
   * Every published version the registry installed, by `project_versions.id`,
   * which is exactly what `enrollments.projectVersionId` names, so an
   * enrolment's pin is one map read rather than a query.
   *
   * Empty until `installVersions` runs. `loadAll()` deliberately leaves it
   * empty: a directory has no version rows, so a pin cannot resolve against one
   * and the fallback below is the honest answer.
   */
  private versions = new Map<string, ProjectContent>();
  /**
   * The compiled task list of each installed version, by `project_versions.id`
   * and then by phase key.
   *
   * Keyed on the **same** id as `versions` above and read through the **same**
   * resolution, never looked up on its own: an accessor that resolved a task
   * list independently would, on either of the two pin faults below, find
   * nothing for the pin and fall back to a sole task synthesised over the
   * *head's* phase: a head declaring three required tasks answering the single
   * required key `''`, the phase opening on one verdict and the answer door
   * behind it. One resolution is what makes that doubt fall shut.
   *
   * A version with no entry here is a version this deployment stored no tasks
   * for, and its phases answer their sole task.
   */
  private versionTasks = new Map<string, Map<string, CompiledTask[]>>();
  /** Which version id is each slug's head, so an enrolment can be pinned at enrol. */
  private heads = new Map<string, string>();
  /** Installed versions this build cannot grade, by version id. */
  private unservable = new Map<string, UnservableVersion>();
  /** Pins already warned about, so a broken row is one line rather than a flood. */
  private readonly warnedPins = new Set<string>();
  /** Installed versions whose snapshot this build's compiler did not produce. */
  private drift: CompilerDrift[] = [];

  /**
   * The directory walk, and no lifecycle hook calls it.
   *
   * Calling it from `onModuleInit` would make `CONTENT_DIR` the runtime's
   * source of content and a redeploy the way a content fix reaches production.
   * Instead `ProjectRegistryService` installs the published `compiled`
   * snapshots once the seed's import has run, and from then on every answer
   * this service gives comes out of a map that was read out of
   * `project_versions`. `ContentService` reads no file at runtime.
   *
   * `loadAll` itself stays, and is public on purpose: the importer reads a
   * pack through it, and so do the validator CLI and the digest CLI, all of
   * which mean to read a directory. A unit spec that wants content without a
   * database calls it too, which is the fixture style every spec in this
   * repository already uses.
   */
  loadAll(): void {
    const root = config.contentDir;
    const sources = directoryPacksIn(root);
    if (sources === null) {
      throw new Error(`content directory not found: ${root}`);
    }
    for (const source of sources) {
      const project = this.loadProject(source);
      // The platform pack loader sets neither conversion flag: its packs must already carry both records.
      requireRecords(project);
      this.projects.set(project.slug, project);
      this.logger.log(`loaded project "${project.slug}" with ${project.phases.length} phases`);
    }
    if (this.projects.size === 0) {
      throw new Error(`no projects found under ${root}`);
    }
  }

  /**
   * Install the published versions the registry read out of the database: the
   * whole set, replacing whatever was held before.
   *
   * It is the whole set rather than one version at a time so that a reload is
   * atomic from a reader's point of view: a version withdrawn between two boots
   * stops resolving on the same statement that installs the new head, and no
   * intermediate state answers half a catalogue.
   *
   * The head of a project is its **newest** published version, compared field
   * by field as numbers (`compareProjectVersions`), never by the order the rows
   * arrived and never by comparing the strings: `'2.0.10' > '2.0.9'` is false
   * between strings, so a head resolved that way would serve 2.0.9 to every new
   * enrolment for ever.
   *
   * It is also where the compiler drift is decided, because this is the one
   * place that sees every snapshot the process will serve: a version that
   * states a compiler other than this build's is recorded and read back by
   * `compilerDrift()`. Nothing is recompiled: a published version is
   * immutable and that is what the pin rests on.
   */
  installVersions(versions: RegisteredVersion[]): void {
    if (versions.length === 0) {
      throw new Error('no published project version to install: nothing would answer a learner');
    }
    const byId = new Map<string, ProjectContent>();
    const heads = new Map<string, string>();
    const drift: CompilerDrift[] = [];
    const tasksById = new Map<string, Map<string, CompiledTask[]>>();
    const unservable = new Map<string, UnservableVersion>();
    for (const { versionId, content, compiler, phases } of versions) {
      if (compiler !== undefined && compiler !== COMPILER_IDENTITY) {
        drift.push({
          slug: content.slug,
          version: content.version,
          compiledBy: compiler || 'a build that recorded no compiler identity',
          thisBuild: COMPILER_IDENTITY,
        });
      }
      const clash = byId.get(versionId);
      if (clash) {
        throw new Error(
          `two published versions share the id ${versionId} (${clash.slug} ${clash.version} and ${content.slug} ${content.version})`,
        );
      }
      byId.set(versionId, content);
      if (phases) {
        tasksById.set(
          versionId,
          new Map<string, CompiledTask[]>(phases.map((one) => [one.key, one.tasks])),
        );
        const cannotGrade = phases.find((one) => !servablePhase(content, one));
        if (cannotGrade) {
          unservable.set(versionId, {
            versionId,
            slug: content.slug,
            version: content.version,
            phaseKey: cannotGrade.key,
            tasks: cannotGrade.tasks.length,
          });
        }
      }
      const head = heads.get(content.slug);
      const holding = head ? (byId.get(head) as ProjectContent) : null;
      if (!holding || compareProjectVersions(content.version, holding.version) > 0) {
        heads.set(content.slug, versionId);
      }
    }
    this.versions = byId;
    this.versionTasks = tasksById;
    this.heads = heads;
    // Sorted by slug, because the catalogue's order is read as an answer:
    // `listProjects()[0]` is the tie-break a class's schedule and the class
    // map take when the caller has no project of their own. The
    // rows arrive from an unordered SELECT, which no database promises to
    // repeat and whose heap order moves under UPDATE and VACUUM, so ordering
    // them here is what keeps that tie-break a fact about the content rather
    // than about the storage, the way a directory walk sorted by directory
    // name is stable across boots.
    this.projects = new Map(
      [...heads.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([slug, versionId]) => [slug, byId.get(versionId) as ProjectContent]),
    );
    this.warnedPins.clear();
    this.drift = drift;
    this.unservable = unservable;
    for (const project of this.projects.values()) {
      this.logger.log(
        `registered project "${project.slug}" at ${project.version} with ${project.phases.length} phases`,
      );
    }
    for (const one of drift) {
      this.logger.warn(describeCompilerDrift(one));
    }
    for (const one of unservable.values()) {
      this.logger.warn(describeUnservableVersion(one));
    }
  }

  /**
   * The installed versions this build cannot grade.
   *
   * A copy, for the reason `compilerDrift()` copies: a caller that could push
   * onto it could invent a refusal.
   */
  unservableVersions(): UnservableVersion[] {
    return [...this.unservable.values()].map((one) => ({ ...one }));
  }

  /**
   * The installed versions this build's compiler did not produce, which is
   * what `GET /readiness` reports and what the import CLI prints.
   *
   * A copy, because a caller that could push onto it could invent a drift.
   */
  compilerDrift(): CompilerDrift[] {
    return this.drift.map((one) => ({ ...one }));
  }

  /**
   * One pack, from one source. Public because the importer reads a pack
   * through the same loader the directory walk uses, so every validation a
   * pack is held to runs against the import, which is the
   * property that makes the compiled snapshot trustworthy.
   */
  loadProject(source: PackSource, options: LoadProjectOptions = {}): ProjectContent {
    const meta = JSON.parse(source.read('project.json'));
    reqString(meta.slug, `${source.name}/project.json: slug`);
    reqString(meta.language, `${source.name}/project.json: language`);
    const version = this.loadVersion(meta.version, source.name);
    // Every pack is in the folder layout: its folders are its manifest (spec
    // 7.2). A project.json that still lists phases is refused at boot; an
    // older archive is converted once at the upload door (7.5), never here.
    req(isFolderLayout(meta), `${source.name}/${LAYOUT_SENTENCES.listsPhases}`);
    return this.loadFolderProject(source, meta, version, options);
  }

  /**
   * The folder path of `loadProject`: the phases, mounts, sealed files and
   * checks `derivePack` reads from the folders, each phase loaded through
   * `folderInputs`, and its mounts sorted by workspace path once the story,
   * design and record seeding is done. A refusal of the layout passes
   * through in its own words, which already name the folder; every other
   * error is prefixed with the pack and the phase folder.
   */
  private loadFolderProject(source: PackSource, meta: any, version: string, options: LoadProjectOptions): ProjectContent {
    const languages = this.loadLanguages(meta, source.name);
    const named = (err: unknown, at: string): Error =>
      err instanceof LayoutRefusal || err instanceof LayoutWalkRefusal ? err : new Error(`${source.name}/${at}${(err as Error).message}`);
    let derived;
    try {
      derived = derivePack(source, { origin: options.origin ?? 'platform' });
    } catch (err) {
      throw named(err, '');
    }
    const phases: PhaseContent[] = derived.phases.map((one) => {
      try {
        const phase = this.loadPhase({ ...one.spec, key: one.key, order: one.order }, folderInputs(one), { language: meta.language, languages }, options);
        phase.files = sortedMounts(phase.files);
        return phase;
      } catch (err) {
        throw named(err, `${one.folder}: `);
      }
    });
    return this.projectOf(source, meta, version, languages, phases, derived.warmup ? 'warmup' : undefined);
  }

  /** The project around its loaded phases: the warm-up, the build, the runtime and the preview, for either layout. */
  private projectOf(
    source: PackSource,
    meta: any,
    version: string,
    languages: RunLanguage[],
    phases: PhaseContent[],
    warmupDir: unknown,
  ): ProjectContent {
    const warmup = loadWarmup(source.location, warmupDir, meta.language, languages);
    const build = this.loadBuild(meta.build, source.name);
    const runtime = this.loadRuntime(meta.runtime, source.name);
    const preview = this.loadPreview(meta.preview, source.name, phases);
    const previewable = phases.filter((p) => p.canPreview);
    req(
      previewable.length === 0 || preview !== undefined,
      `${source.name}/project.json: ${previewable
        .map((p) => p.key)
        .join(', ')} declares canPreview, but the pack declares no preview block, so Run app would have nothing to start`,
    );
    const project: ProjectContent = {
      slug: meta.slug,
      version,
      title: meta.title,
      tagline: meta.tagline,
      description: meta.description,
      language: meta.language,
      languages,
      phases,
    };
    if (build) project.build = build;
    if (runtime) project.runtime = runtime;
    if (preview) project.preview = preview;
    if (warmup) project.warmup = warmup;
    return project;
  }

  /**
   * `project.json.languages`, optional: every language any phase of this pack
   * runs. A pack that declares none runs in its own `language`, which is every
   * pack that predates a two-language phase.
   *
   * It exists so that `checks.runs[].language` can be held against something
   * the pack declared out loud: a run that reaches a harness the project never
   * named is a boot error rather than a job the runner refuses at grading time.
   */
  private loadLanguages(meta: Record<string, unknown>, packName: string): RunLanguage[] {
    const at = `${packName}/project.json: languages`;
    const language = meta.language as string;
    req(
      RUN_LANGUAGES.includes(language as RunLanguage),
      `${packName}/project.json: language "${language}" is not one of ${RUN_LANGUAGES.join(', ')}`,
    );
    if (meta.languages === undefined || meta.languages === null) return [language as RunLanguage];
    const declared = reqStringArray(meta.languages, at);
    req(declared.length > 0, `${at} must not be empty`);
    for (const value of declared) {
      req(
        RUN_LANGUAGES.includes(value as RunLanguage),
        `${at}: "${value}" is not one of ${RUN_LANGUAGES.join(', ')}`,
      );
    }
    req(
      declared.includes(language),
      `${at} must include the pack's own language "${language}"`,
    );
    return declared as RunLanguage[];
  }

  /**
   * `project.json.build`, optional: how the pack's front end is produced.
   *
   * `tool` is an enum of one so that a pack names a tool the runner already
   * knows rather than an argv: content can declare what it needs built, never
   * a command the sandbox should run.
   */
  private loadBuild(raw: unknown, packName: string): BuildSpec | undefined {
    if (raw === undefined || raw === null) return undefined;
    const at = `${packName}/project.json: build`;
    req(raw && typeof raw === 'object' && !Array.isArray(raw), `${at} must be an object`);
    const spec = raw as Record<string, unknown>;
    req(
      spec.tool === 'esbuild',
      `${at}.tool must be "esbuild": a pack names a tool the runner knows, never a command`,
    );
    const jsx = spec.jsx === undefined ? 'automatic' : spec.jsx;
    req(
      jsx === 'automatic' || jsx === 'transform',
      `${at}.jsx must be "automatic" or "transform"`,
    );
    return {
      tool: 'esbuild',
      entry: reqWorkspacePath(spec.entry, `${at}.entry`),
      outfile: reqWorkspacePath(spec.outfile, `${at}.outfile`),
      jsx: jsx as BuildSpec['jsx'],
    };
  }

  /**
   * `project.json.runtime`, optional: what the pack needs pre-baked into the
   * runner's read-only dependency layer.
   *
   * Every version is pinned exactly, because the runner bakes one set of bytes
   * and a range would make what a learner runs depend on the day the image was
   * built. Every name is held against the runner's own allowlist: a pack
   * declares what it needs, but putting a new package inside the jail is a
   * code change with a review.
   */
  private loadRuntime(raw: unknown, packName: string): RuntimeSpec | undefined {
    if (raw === undefined || raw === null) return undefined;
    const at = `${packName}/project.json: runtime`;
    req(raw && typeof raw === 'object' && !Array.isArray(raw), `${at} must be an object`);
    const spec = raw as Record<string, unknown>;
    const out: RuntimeSpec = {};

    if (spec.python !== undefined && spec.python !== null) {
      const python = spec.python as Record<string, unknown>;
      req(typeof python === 'object' && !Array.isArray(python), `${at}.python must be an object`);
      const version = reqString(python.version, `${at}.python.version`);
      const packages = reqStringArray(python.packages, `${at}.python.packages`);
      req(packages.length > 0, `${at}.python.packages must not be empty`);
      const allowed = runnerAllowlist('ALLOWED_PYTHON');
      for (const pin of packages) {
        req(
          PIP_PIN.test(pin),
          `${at}.python.packages: "${pin}" must be pinned exactly, as name==version`,
        );
        const name = pin.split('==')[0];
        req(
          !allowed || allowed.has(name),
          `${at}.python.packages: "${name}" is not on the runner's allowlist (ALLOWED_PYTHON in runner/runtime_manifest.py) — a pack may not add a package to the sandbox by editing content`,
        );
      }
      out.python = { version, packages };
    }

    if (spec.node !== undefined && spec.node !== null) {
      const node = spec.node as Record<string, unknown>;
      req(typeof node === 'object' && !Array.isArray(node), `${at}.node must be an object`);
      const version = reqString(node.version, `${at}.node.version`);
      const packages = this.loadPinnedMap(node.packages, `${at}.node.packages`, 'ALLOWED_NODE');
      req(Object.keys(packages).length > 0, `${at}.node.packages must not be empty`);
      const tools = this.loadPinnedMap(node.tools, `${at}.node.tools`, 'ALLOWED_TOOLS');
      out.node = { version, packages, tools };
    }

    req(
      out.python !== undefined || out.node !== undefined,
      `${at} must declare python, node or both`,
    );
    return out;
  }

  /** A `{ name: exact-version }` map, every name on the runner's allowlist. */
  private loadPinnedMap(
    raw: unknown,
    at: string,
    allowlist: string,
  ): Record<string, string> {
    if (raw === undefined || raw === null) return {};
    req(
      typeof raw === 'object' && !Array.isArray(raw),
      `${at} must be an object of name: version`,
    );
    const allowed = runnerAllowlist(allowlist);
    const out: Record<string, string> = {};
    for (const [name, version] of Object.entries(raw as Record<string, unknown>)) {
      const pin = reqString(version, `${at}["${name}"]`);
      req(
        SEMVER_PIN.test(pin),
        `${at}["${name}"] ("${pin}") must be an exact version, with no ^, ~ or range`,
      );
      req(
        !allowed || allowed.has(name),
        `${at}: "${name}" is not on the runner's allowlist (${allowlist} in runner/runtime_manifest.py) — a pack may not add a package to the sandbox by editing content`,
      );
      out[name] = pin;
    }
    return out;
  }

  /**
   * `project.json.preview`, optional: what "Run app" starts.
   *
   * The command is validated exactly as a smoke command is, an interpreter
   * the runner knows and a script the phase itself ships, so a pack can
   * declare a long-running service without ever naming an argv the sandbox
   * would take on trust.
   */
  private loadPreview(
    raw: unknown,
    packName: string,
    phases: PhaseContent[],
  ): PreviewSpec | undefined {
    if (raw === undefined || raw === null) return undefined;
    const at = `${packName}/project.json: preview`;
    req(raw && typeof raw === 'object' && !Array.isArray(raw), `${at} must be an object`);
    const spec = raw as Record<string, unknown>;

    // the phases that can actually start it, so the message names the phase
    // whose workspace is missing the file
    const scope = phases.filter((p) => p.canPreview);
    const previewable = scope.length > 0 ? scope : phases;

    const service = (spec.service || {}) as Record<string, unknown>;
    req(
      service && typeof service === 'object' && !Array.isArray(service),
      `${at}.service must be an object`,
    );
    const command = this.loadPreviewCommand(service.command, `${at}.service.command`, previewable);
    const portEnv = reqString(service.portEnv, `${at}.service.portEnv`);
    req(
      ENV_KEY.test(portEnv),
      `${at}.service.portEnv ("${portEnv}") must match ${ENV_KEY}`,
    );
    const health = reqString(service.health, `${at}.service.health`);
    req(
      health.startsWith('/'),
      `${at}.service.health ("${health}") must start with "/": it is the path the runner polls until the app answers`,
    );

    const web = (spec.web || {}) as Record<string, unknown>;
    req(web && typeof web === 'object' && !Array.isArray(web), `${at}.web must be an object`);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries((spec.env || {}) as Record<string, unknown>)) {
      req(ENV_KEY.test(key), `${at}.env: "${key}" must match ${ENV_KEY}`);
      req(
        !RESERVED_ENV.has(key) && key !== portEnv,
        `${at}.env: "${key}" is set by the runner itself, so a pack cannot also set it`,
      );
      env[key] = reqString(value, `${at}.env["${key}"]`);
    }

    const out: PreviewSpec = {
      service: { command, portEnv, health },
      web: {
        root: reqWorkspacePath(web.root, `${at}.web.root`),
        html: reqWorkspacePath(web.html, `${at}.web.html`),
      },
      env,
    };
    if (spec.seed !== undefined && spec.seed !== null) {
      out.seed = this.loadPreviewCommand(spec.seed, `${at}.seed`, previewable);
    }
    return out;
  }

  /**
   * A Design phase's learner documents are the record and each contract the
   * teacher switched on. No markdown, no brief file, no contract that is off;
   * the ones a pack does not ship are seeded empty, the record first and the
   * contracts after it, api then screens. Each must be editable (the learner
   * writes it) and valid as it ships. Any other file a pack mounts that is not
   * markdown (a JSON reference, an image) is mounted as it ships.
   */
  private loadDesignDocuments(spec: { taskFile?: unknown; taskPanel?: unknown }, files: ContentFileSpec[], checks: DesignChecks): void {
    req(typeof spec.taskPanel === 'string' && !spec.taskFile, 'A Design phase keeps its brief in taskPanel, not in a file.');
    for (const file of files) req(!MARKDOWN_PATH.test(file.path), `A Design phase mounts no markdown file: ${file.path}.`);
    const off = mountedSwitchedOffContract(files.map((file) => file.path), checks.contracts);
    req(!off, `${off} is mounted, but that contract is switched off.`);
    seedDesignDocuments(files, checks);
    for (const at of designDocumentPaths(checks.contracts)) {
      const file = files.find((one) => one.path === at)!;
      req(file.editable, `${at} must be editable: the learner writes it.`);
      const problem = designDocumentError(at, file.content);
      req(!problem, `${at}: ${problem}`);
    }
  }

  /**
   * A Deployment with a runbook or a Maintenance with a change request: the
   * brief inline, no markdown mounted, the record mounted editable (the empty
   * record when the pack ships none) and valid as it ships.
   */
  private loadRecordFiles(
    spec: { taskFile?: unknown; taskPanel?: unknown },
    files: ContentFileSpec[],
    title: 'Deployment' | 'Maintenance',
    record: string,
    seed: string,
    problem: (text: string) => string | null,
  ): void {
    req(typeof spec.taskPanel === 'string' && !spec.taskFile, `${title} keeps its brief in taskPanel, not in a file.`);
    for (const file of files) req(!MARKDOWN_PATH.test(file.path), `A ${title} phase mounts no markdown file: ${file.path}.`);
    if (!files.some((one) => one.path === record)) files.push({ path: record, content: seed, editable: true, language: 'json' });
    const file = files.find((one) => one.path === record)!;
    req(file.editable, `${record} must be editable: the learner writes it.`);
    const error = problem(file.content);
    req(!error, `${record}: ${error}`);
  }

  /** An interpreter the runner knows, and a script the previewing phases ship. */
  private loadPreviewCommand(raw: unknown, at: string, phases: PhaseContent[]): string[] {
    req(
      Array.isArray(raw) && raw.every((a) => typeof a === 'string' && a.length > 0),
      `${at} must be an array of non-empty strings`,
    );
    const argv = raw as string[];
    req(argv.length >= 2, `${at} must name an interpreter and a script`);
    req(
      PREVIEW_INTERPRETERS.has(argv[0]),
      `${at}: "${argv[0]}" is not one of ${Array.from(PREVIEW_INTERPRETERS).join(', ')}`,
    );
    for (const phase of phases) {
      req(
        phase.files.some((f) => f.path === argv[1]),
        `${at}: "${argv[1]}" is not a file the ${phase.key} phase ships, so the preview would start a file that is not in the workspace`,
      );
    }
    return argv;
  }

  /**
   * `project.json.version`, required: the pack version stamped on every
   * enrolment and every graded submission, so a regrade after a rubric or
   * hidden-suite change can tell which pack produced a score. Nothing bumps it
   * automatically: an author who changes a phase list, a rubric or a hidden
   * suite bumps it.
   */
  private loadVersion(raw: unknown, packName: string): string {
    const at = `${packName}/project.json: version`;
    const version = reqString(raw, at);
    req(
      version.length <= VERSION_MAX_LENGTH,
      `${at} must be at most ${VERSION_MAX_LENGTH} characters`,
    );
    req(
      VERSION_PATTERN.test(version),
      `${at} ("${version}") must be MAJOR.MINOR.PATCH, optionally with a -prerelease or +build suffix`,
    );
    return version;
  }

  private loadPhase(
    spec: any,
    inputs: PhaseInputs,
    project: { language: string; languages: RunLanguage[] },
    options: LoadProjectOptions = {},
  ): PhaseContent {
    const key = reqString(spec.key, 'key') as PhaseKey;
    req(PHASE_ORDER.includes(key), `key "${key}" is not one of ${PHASE_ORDER.join(', ')}`);
    req(
      Number.isInteger(spec.order) && spec.order >= 1 && spec.order <= PHASE_ORDER.length,
      `order must be an integer 1..${PHASE_ORDER.length}`,
    );
    // the older written kind is read as a string: only a converted Requirements or Design may declare it
    const declaredKind: string = reqString(spec.artifactKind, 'artifactKind');
    const knownKind = (): void => req(
      ARTIFACT_KINDS.includes(declaredKind as ArtifactKind),
      `artifactKind "${declaredKind}" is not one of ${ARTIFACT_KINDS.join(', ')}`,
    );
    if (declaredKind !== 'markdown') knownKind();
    req(spec.assistant && typeof spec.assistant === 'object', 'assistant is required');
    reqString(spec.assistant.systemPrompt, 'assistant.systemPrompt');
    req(spec.checks && typeof spec.checks === 'object', 'checks is required');

    const files = inputs.files();
    const writtenKind = spec.checks.kind;
    // A Design phase written before the design kind loads as one, at the doors
    // that ask: its markdown dropped, its rules as criterion sentences, its brief
    // file's words kept inline (a design phase keeps its brief in taskPanel).
    // Here rather than in `loadChecks` beside the Requirements conversion,
    // because it rewrites the rubric and the brief too, which `loadChecks`
    // never sees; the Requirements conversion rewrites only checks and files.
    if (options.convertLegacyDesign && key === 'design' && writtenKind === 'markdown') {
      // a rubric that is not a list of criteria objects, each description text or absent, is left to `loadRubric`,
      // which refuses it in its own words
      const shaped = spec.rubric && typeof spec.rubric === 'object' && Array.isArray(spec.rubric.criteria)
        && spec.rubric.criteria.every((c: { description?: unknown } | null) => !!c && typeof c === 'object' && (c.description === undefined || typeof c.description === 'string'));
      const rubric = shaped ? spec.rubric : undefined;
      const legacy = designChecksFromLegacyMarkdown(files, spec.checks, rubric);
      files.splice(0, files.length, ...legacy.files);
      if (spec.taskFile) spec.taskPanel = inputs.brief(spec);
      delete spec.taskFile;
      spec.checks = legacy.checks;
      if (legacy.rubric) spec.rubric = legacy.rubric;
      // Told once per upload: to the caller that collects it, else to the log.
      if (options.warnings) options.warnings.push(legacy.note);
      else this.logger.warn(legacy.note);
    }
    // An older config Deployment or code Maintenance loads with its record, at the doors that ask:
    // its markdown dropped or turned into the starting record, its runbook rules into criterion sentences,
    // its ticket built from its brief, and the brief file's words kept inline.
    const recordConversion =
      options.convertLegacyRunbook && key === 'deployment' && writtenKind === 'config' && spec.checks.runbook === undefined ? 'runbook'
        : options.convertLegacyChange && key === 'maintenance' && writtenKind === 'code' && spec.checks.ticket === undefined && spec.checks.change === undefined ? 'change'
          : null;
    if (recordConversion) {
      // a phase with no brief, or one that is not text, is refused as every phase is, never handed a brief made up for it
      req(spec.taskFile || typeof spec.taskPanel === 'string', `phase needs ${inputs.named('taskFile or taskPanel')}`);
      const taskPanel: string = inputs.brief(spec);
      // a rubric that is not a list of criteria objects, each description text or absent, is left to `loadRubric`, which
      // refuses it in its own words (the `shaped` guard of the Design conversion above, so a malformed rubric is a sentence, not a TypeError)
      const shaped = spec.rubric && typeof spec.rubric === 'object' && Array.isArray(spec.rubric.criteria)
        && spec.rubric.criteria.every((c: { description?: unknown } | null) => !!c && typeof c === 'object' && (c.description === undefined || typeof c.description === 'string'));
      // rules that are not a list of objects each with an id are left to `loadFileRules`, which refuses them in its own words
      const readable = Array.isArray(spec.checks.rules) && spec.checks.rules.every((r: { id?: unknown } | null) => !!r && typeof r === 'object' && typeof r.id === 'string');
      const rules = readable ? spec.checks.rules : [];
      const input = {
        files, checks: { ...spec.checks, kind: writtenKind, rules, drill: spec.checks.drill ? {} : undefined } as PhaseChecks,
        rubric: shaped ? spec.rubric : undefined, title: String(spec.title ?? ''), intro: String(spec.intro ?? ''), taskPanel,
        objectives: Array.isArray(spec.objectives) ? spec.objectives.map(String) : [],
      };
      const out = recordConversion === 'runbook' ? runbookChecksFromLegacy(input) : changeChecksFromLegacy(input);
      files.splice(0, files.length, ...out.files);
      if (recordConversion === 'runbook') {
        // the raw rules the conversion kept, so `loadFileRules` reads them as it reads any rule
        if (readable) spec.checks.rules = (out.checks as ConfigChecks).rules;
        spec.checks.runbook = (out.checks as ConfigChecks).runbook;
      } else {
        spec.checks.ticket = (out.checks as CodeChecks).ticket;
        spec.checks.change = (out.checks as CodeChecks).change;
      }
      if (out.rubric && shaped) spec.rubric = out.rubric;
      delete spec.taskFile;
      spec.taskPanel = taskPanel;
      // Told once per upload: to the caller that collects it, else to the log.
      if (options.warnings) options.warnings.push(out.note);
      else this.logger.warn(out.note);
    }
    const checks = this.loadChecks(inputs, spec.checks, project, files, key, options);
    // A converted Requirements or Design phase is of its structured kind all through; any other phase's
    // declared kind is one of ARTIFACT_KINDS.
    const converted = (checks.kind === 'story' || checks.kind === 'design') && writtenKind === 'markdown';
    if (!converted) knownKind();
    const loadedKind: ArtifactKind = converted ? checks.kind : (declaredKind as ArtifactKind);
    // A story phase grades one JSON record; a pack that ships none gets an
    // empty one, seeded with the learner's story id unless the learner picks it.
    if (checks.kind === 'story' && !files.some((f) => f.path === checks.record)) {
      files.push({ path: checks.record, content: seededStoryRecord(checks), editable: true, language: 'json' });
    }
    if (checks.kind === 'design') this.loadDesignDocuments(spec, files, checks);
    if (checks.kind === 'config' && checks.runbook) {
      const drill = !!checks.drill;
      this.loadRecordFiles(spec, files, 'Deployment', RUNBOOK_JSON, serialiseRunbook(EMPTY_RUNBOOK), (text) => startingRunbookProblem(text, drill));
    }
    if (checks.kind === 'code' && checks.change) {
      const ticket = checks.ticket!;
      this.loadRecordFiles(spec, files, 'Maintenance', CHANGE_REQUEST_JSON, serialiseChangeRequest(EMPTY_CHANGE_REQUEST), (text) => startingChangeProblem(text, ticket));
    }
    // A helper the runner writes into the workspace that the
    // explorer never shows is a file the learner cannot read and cannot be
    // told to import, so the pack has to declare it both ways round.
    if (checks.kind === 'tests') {
      const locked = new Set(files.filter((f) => !f.editable).map((f) => f.path));
      for (const at of Object.keys(checks.supportFiles)) {
        req(
          locked.has(at),
          `checks.supportFiles names "${at}", which files does not declare as a locked file — the learner would import a file they cannot see`,
        );
      }
    }
    const interview = this.loadInterview(inputs, key, spec);
    // The brief is a file (`taskFile`) or inline text (`taskPanel`); the file wins.
    req(
      spec.taskFile || typeof spec.taskPanel === 'string',
      `phase needs ${inputs.named('taskFile or taskPanel')}`,
    );

    const phase: PhaseContent = {
      key,
      order: spec.order,
      title: reqString(spec.title, 'title'),
      intro: reqString(spec.intro, 'intro'),
      artifactKind: loadedKind,
      language: project.language,
      canRun: !!spec.canRun,
      // Whether Run app can start the pack's own application from this
      // phase's workspace. The tab is absent without it, and the pack has to
      // declare a preview block for it to mean anything.
      canPreview: !!spec.canPreview,
      runLabel: spec.runLabel || 'Run',
      taskPanel: inputs.brief(spec),
      objectives: reqStringArray(spec.objectives, 'objectives'),
      files,
      rubric: this.loadRubric(spec.rubric, checks),
      checks,
      assistant: {
        systemPrompt: spec.assistant.systemPrompt,
        topics: spec.assistant.topics || [],
        progressive: reqStringArray(spec.assistant.progressive, 'assistant.progressive'),
      },
    };
    if (interview) phase.interview = interview;
    return phase;
  }

  /**
   * `interview`, optional and requirements-only: the hidden truth document the
   * customer answers from: the phase folder's own `interview.json`
   * (`PhaseInputs.interviewText`; an older archive's inline value or file is
   * written there by `layoutFromManifest` before the loader reads it).
   *
   * A brief on any other phase is dropped with a warning rather than a boot
   * failure, like the `checks.drill` guard above it: a pack author who
   * copies a phase directory should be told, not stopped on the morning of a
   * class.
   */
  private loadInterview(
    inputs: PhaseInputs,
    phaseKey: PhaseKey,
    phaseSpec: Record<string, unknown>,
  ): InterviewBrief | undefined {
    if (phaseKey !== 'requirements') {
      if (phaseSpec.interview !== undefined && phaseSpec.interview !== null) this.logger.warn(`interview ignored on a ${phaseKey} phase (${inputs.where})`);
      return undefined;
    }
    const source = inputs.interviewText(phaseSpec);
    if (source === null) return undefined;
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(source) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`interview is not valid JSON: ${(err as Error).message}`);
    }
    // The rules live in `validateInterviewBrief`, which the authoring door
    // calls too.
    return validateInterviewBrief(spec);
  }

  /**
   * The rubric, held against the keys the grader will actually set for these
   * checks. A criterion the grader never scores reads as a flat zero with no
   * evidence, and a rule or a scorer key with no criterion is graded into
   * nothing, so both directions are a boot-time error rather than a silent
   * mark against every learner of the pack.
   */
  private loadRubric(raw: any, checks: PhaseChecks): PhaseRubric {
    req(raw && typeof raw === 'object', 'rubric is required');
    req(typeof raw.passThreshold === 'number', 'rubric.passThreshold must be a number');
    req(
      Array.isArray(raw.criteria) && raw.criteria.length > 0,
      'rubric.criteria must be a non-empty array',
    );
    const seen = new Set<string>();
    (raw.criteria as any[]).forEach((c, i) => {
      const key = reqString(c?.key, `rubric.criteria[${i}].key`);
      req(!seen.has(key), `rubric.criteria[${i}]: duplicate key "${key}"`);
      seen.add(key);
      reqString(c.title, `rubric.criteria[${i}].title`);
      req(typeof c.weight === 'number', `rubric.criteria[${i}].weight must be a number`);
      req(c.description === undefined || typeof c.description === 'string', `rubric.criteria[${i}].description must be text`);
    });
    // what the editor's Criteria step saves, so an uploaded rubric saves back unchanged
    const breaches = rubricCapBreaches(raw);
    req(breaches.length === 0, breaches.join('; '));

    const scored = scoredKeysFor(checks, raw);
    const source = scorerSourceFor(checks);
    const quoted = (keys: string[]) => keys.map((k) => `"${k}"`).join(', ');
    const unscored = [...seen].filter((k) => !scored.has(k));
    req(
      unscored.length === 0,
      `rubric.criteria: nothing scores ${quoted(unscored)} on a ${checks.kind} phase, so every learner would see 0 there with no evidence. Scores come from ${source}: ${[...scored].sort().join(', ')}`,
    );
    const unclaimed = [...scored].filter((k) => !seen.has(k));
    req(
      unclaimed.length === 0,
      `${quoted(unclaimed)} ${unclaimed.length === 1 ? 'is' : 'are'} scored by ${source} but claimed by no rubric criterion, so that work is graded into nothing (rubric.criteria: ${[...seen].sort().join(', ')})`,
    );
    if (checks.kind === 'config' && checks.runbook) {
      req(recordCriteriaOf(checks, raw).length > 0, 'rubric.criteria: a Deployment with a runbook needs at least one runbook criterion: a key no file rule claims that is not build_smoke.');
    }
    if (checks.kind === 'code' && checks.change) {
      req(recordCriteriaOf(checks, raw).length > 0, 'rubric.criteria: a Maintenance with a change request needs at least one change criterion: a key outside correctness_hidden, visible_tests, code_quality and process.');
    }
    return raw as PhaseRubric;
  }

  /** Rules are regexes graded against a file, so a bad one must fail at boot. */
  private loadRules(raw: unknown, field: string): FileRule[] {
    req(Array.isArray(raw), `${field} must be an array`);
    (raw as Record<string, unknown>[]).forEach((r, i) => {
      const at = `${field}[${i}]`;
      req(r && typeof r === 'object', `${at} must be an object`);
      const id = reqString(r.id, `${at}.id`);
      reqString(r.label, `${at}.label`);
      reqString(r.criterion, `${at}.criterion`);
      reqString(r.failDetail, `${at}.failDetail`);
      const source = typeof r.pattern === 'string' ? r.pattern : r.forbidden;
      req(
        (typeof r.pattern === 'string') !== (typeof r.forbidden === 'string'),
        `${at} (${id}) needs exactly one of pattern or forbidden`,
      );
      try {
        new RegExp(source as string, (r.flags as string | undefined) || '');
      } catch (err) {
        throw new Error(`${at} (${id}) has an invalid regex: ${(err as Error).message}`);
      }
    });
    return raw as FileRule[];
  }

  /** A config phase's rules: each names its target, and with a runbook never a markdown file. */
  private loadFileRules(raw: unknown, field: string, withRunbook: boolean): FileRule[] {
    const rules = this.loadRules(raw, field);
    for (const rule of rules) {
      req(typeof rule.target === 'string' && rule.target.trim().length > 0, 'A file rule names the file it reads.');
      if (withRunbook) req(!MARKDOWN_PATH.test(rule.target!), 'A file rule cannot target a markdown file. The runbook is a record of its own.');
    }
    return rules;
  }

  /**
   * `checks.runs[]`, optional: the runs a phase grades, in the order they
   * execute.
   *
   * A phase that spans two layers declares two, a Python suite under pytest
   * and a front-end suite under the DOM harness, and the API runs them one
   * after another and pools the result. A phase that declares none is given a
   * single run built from its flat shape, so a pack that declares no runs
   * loads and grades as one run.
   *
   * Null means "the pack declared no runs", which the caller turns into that
   * single run; it is not the same as an empty array, which is an author who
   * wrote `"runs": []` and meant something.
   */
  private loadRunHeaders(
    raw: unknown,
    project: { language: string; languages: RunLanguage[] },
  ): RunHeader[] | null {
    if (raw === undefined || raw === null) return null;
    req(
      Array.isArray(raw) && raw.length > 0,
      'checks.runs must be a non-empty array (leave it out for a phase with one run)',
    );
    const entries = raw as unknown[];
    const seen = new Set<string>();
    const labels = new Set<string>();
    return entries.map((entry, i) => {
      const at = `checks.runs[${i}]`;
      req(entry && typeof entry === 'object' && !Array.isArray(entry), `${at} must be an object`);
      const spec = entry as Record<string, unknown>;

      const id = reqString(spec.id, `${at}.id`);
      req(RUN_ID.test(id), `${at}.id ("${id}") must match ${RUN_ID}`);
      req(
        !seen.has(id),
        `${at}: duplicate run id "${id}" — the id is the step stamped on every case, so two runs cannot share one`,
      );
      seen.add(id);

      const language = (
        spec.language === undefined ? project.language : reqString(spec.language, `${at}.language`)
      ) as RunLanguage;
      req(
        project.languages.includes(language),
        `${at}.language ("${language}") is not one of this pack's languages (${project.languages.join(', ')}): add it to project.json languages, or the runner would be asked for a harness the pack never declared`,
      );

      const harness = this.loadHarness(spec.harness, `${at}.harness`, language);
      const hiddenHarness = this.loadHarness(spec.hiddenHarness, `${at}.hiddenHarness`, language);

      const label =
        entries.length === 1 && spec.label === undefined
          ? DEFAULT_RUN_LABEL
          : reqString(spec.label, `${at}.label`);
      req(
        !labels.has(label),
        `${at}: duplicate run label "${label}" — it is the words a learner reads above the group, so two runs cannot share one`,
      );
      labels.add(label);

      req(
        spec.transform === undefined || typeof spec.transform === 'boolean',
        `${at}.transform must be true or false`,
      );
      const transform = spec.transform === true;
      req(
        !transform || language === 'typescript',
        `${at}.transform is only for a typescript run, and this one is ${language}`,
      );

      return { id, language, harness, hiddenHarness, label, transform, spec };
    });
  }

  /** A harness the runner can drive, and one this language can be driven by. */
  private loadHarness(raw: unknown, at: string, language: RunLanguage): RunHarness {
    if (raw === undefined || raw === null) return defaultHarness(language);
    const harness = reqString(raw, at) as RunHarness;
    req(
      RUN_HARNESSES.includes(harness),
      `${at} ("${harness}") is not one of ${RUN_HARNESSES.join(', ')}`,
    );
    req(
      HARNESSES_FOR[language].includes(harness),
      `${at} ("${harness}") cannot run ${language}: use ${HARNESSES_FOR[language].join(' or ')}`,
    );
    return harness;
  }

  /** An empty run of one language, filled in by the phase's own kind. */
  private blankRun(header: Omit<RunHeader, 'spec'>): PhaseRun {
    return {
      ...header,
      testPaths: [],
      visibleTests: [],
      hiddenTestFiles: {},
      learnerTestFiles: [],
      referenceTestFiles: {},
      implFiles: {},
      supportFiles: {},
    };
  }

  /** The single run a phase that declares none is given. */
  private soleHeader(project: { language: string }): Omit<RunHeader, 'spec'> {
    const language = project.language as RunLanguage;
    return {
      id: DEFAULT_RUN_ID,
      language,
      harness: defaultHarness(language),
      hiddenHarness: defaultHarness(language),
      label: DEFAULT_RUN_LABEL,
      transform: false,
    };
  }

  /**
   * `runs[].supportFiles`: the locked helpers that ride into this run's
   * workspace. The loader refuses one that is not a locked entry in `files`,
   * for the reason it always has: the learner would import a file they cannot
   * see.
   */
  private loadRunSupport(
    raw: unknown,
    at: string,
    available: Map<string, string>,
    why: string,
  ): Record<string, string> {
    const declared = reqStringArray(raw, at);
    const out: Record<string, string> = {};
    for (const path of declared) {
      req(available.has(path), `${at} names "${path}", which ${why}`);
      out[path] = available.get(path) as string;
    }
    return out;
  }

  /** `runs[].testPaths`: what the graded run collects, defaulting to its own files. */
  private loadRunTestPaths(raw: unknown, at: string, fallback: string[]): string[] {
    if (raw === undefined || raw === null) return fallback;
    const declared = reqStringArray(raw, at);
    req(declared.length > 0, `${at} must not be empty`);
    for (const entry of declared) {
      req(
        covers(entry, fallback),
        `${at} names "${entry}", which holds none of this run's test files (${fallback.join(', ')})`,
      );
    }
    return declared;
  }

  /**
   * The runs of a `code` phase: what the learner runs, and the sealed suite
   * each one is graded by.
   */
  private loadCodeRuns(
    inputs: PhaseInputs,
    raw: any,
    project: { language: string; languages: RunLanguage[] },
    files: ContentFileSpec[],
  ): PhaseRun[] {
    const locked = new Map(files.filter((f) => !f.editable).map((f) => [f.path, f.content]));
    const declared = files.map((f) => f.path);
    const headers = this.loadRunHeaders(raw.runs, project);
    if (!headers) {
      const visibleTests = reqStringArray(raw.visibleTests, 'checks.visibleTests');
      const hiddenTestFiles = inputs.hiddenFor(null, raw, 'checks.hiddenTestDir', DEFAULT_RUN_ID);
      return [
        {
          ...this.blankRun(this.soleHeader(project)),
          visibleTests,
          hiddenTestFiles,
          testPaths: Object.keys(hiddenTestFiles),
        },
      ];
    }
    return headers.map(({ spec, ...header }, i) => {
      const at = `checks.runs[${i}]`;
      const visibleTests = reqStringArray(
        spec.visibleTests === undefined ? raw.visibleTests : spec.visibleTests,
        `${at}.visibleTests`,
      );
      req(visibleTests.length > 0, `${at}.visibleTests must not be empty`);
      for (const test of visibleTests) {
        req(
          declared.includes(test),
          `${at}.visibleTests names "${test}", which files does not declare, so the learner could not run it`,
        );
      }
      const hiddenTestFiles = inputs.hiddenFor(spec, raw, `${at}.hiddenTestDir`, header.id);
      return {
        ...this.blankRun(header),
        visibleTests,
        hiddenTestFiles,
        testPaths: this.loadRunTestPaths(
          spec.testPaths,
          `${at}.testPaths`,
          Object.keys(hiddenTestFiles),
        ),
        supportFiles: this.loadRunSupport(
          spec.supportFiles,
          `${at}.supportFiles`,
          locked,
          'files does not declare as a locked file — the learner would import a file they cannot see',
        ),
      };
    });
  }

  /**
   * The runs of a `tests` phase: which of the learner's suites, which
   * reference implementation and which helpers belong to each layer.
   *
   * Every learner test file belongs to exactly one run. A file two runs
   * claimed would be graded twice and pooled twice; a file no run claimed
   * would be a suite the learner writes and nothing ever runs.
   */
  private loadTestsRuns(
    raw: any,
    project: { language: string; languages: RunLanguage[] },
    loaded: {
      learnerTestFiles: string[];
      referenceTestFiles: Record<string, string>;
      implFiles: Record<string, string>;
      supportFiles: Record<string, string>;
    },
  ): PhaseRun[] {
    const headers = this.loadRunHeaders(raw.runs, project);
    if (!headers) {
      return [
        {
          ...this.blankRun(this.soleHeader(project)),
          learnerTestFiles: loaded.learnerTestFiles,
          referenceTestFiles: loaded.referenceTestFiles,
          implFiles: loaded.implFiles,
          supportFiles: loaded.supportFiles,
          testPaths: loaded.learnerTestFiles,
        },
      ];
    }
    const support = new Map(Object.entries(loaded.supportFiles));
    const graded = new Set<string>();
    const runs = headers.map(({ spec, ...header }, i) => {
      const at = `checks.runs[${i}]`;
      const learnerTestFiles = reqStringArray(spec.learnerTestFiles, `${at}.learnerTestFiles`);
      req(learnerTestFiles.length > 0, `${at}.learnerTestFiles must not be empty`);
      for (const test of learnerTestFiles) {
        req(
          loaded.learnerTestFiles.includes(test),
          `${at}.learnerTestFiles names "${test}", which checks.learnerTestFiles does not declare`,
        );
        req(
          !graded.has(test),
          `${at}.learnerTestFiles names "${test}", which another run already grades`,
        );
        graded.add(test);
      }
      const implPaths = reqStringArray(spec.implFiles, `${at}.implFiles`);
      req(implPaths.length > 0, `${at}.implFiles must not be empty`);
      const implFiles: Record<string, string> = {};
      for (const impl of implPaths) {
        req(
          loaded.implFiles[impl] !== undefined,
          `${at}.implFiles names "${impl}", which the phase's reference implementation does not ship`,
        );
        implFiles[impl] = loaded.implFiles[impl];
      }
      // this run's own suite, plus any helper the reference directory ships
      // that lands on no learner test path at all
      const referenceTestFiles: Record<string, string> = {};
      for (const [at2, content] of Object.entries(loaded.referenceTestFiles)) {
        if (learnerTestFiles.includes(at2) || !loaded.learnerTestFiles.includes(at2)) {
          referenceTestFiles[at2] = content;
        }
      }
      return {
        ...this.blankRun(header),
        learnerTestFiles,
        referenceTestFiles,
        implFiles,
        supportFiles: this.loadRunSupport(
          spec.supportFiles,
          `${at}.supportFiles`,
          support,
          'checks.supportFiles does not declare, so it would never reach the grading workspace',
        ),
        testPaths: this.loadRunTestPaths(spec.testPaths, `${at}.testPaths`, learnerTestFiles),
      };
    });
    const ungraded = loaded.learnerTestFiles.filter((t) => !graded.has(t));
    req(
      ungraded.length === 0,
      `checks.runs: no run grades ${ungraded.join(', ')}, so the learner would write a suite nothing ever runs`,
    );
    return runs;
  }

  /** The workspace paths a `tests` phase's runs say their implementation lives at. */
  private declaredImplPaths(raw: Record<string, unknown>): string[] {
    if (!Array.isArray(raw.runs)) return Object.keys(raw.implFiles || {});
    return (raw.runs as Record<string, unknown>[]).flatMap((run) =>
      Array.isArray(run.implFiles) ? (run.implFiles as string[]) : [],
    );
  }

  /**
   * One mutant: the planted bug, and the run whose implementation it replaces.
   *
   * `run` is what makes the kill matrix one grid over two layers: it decides
   * which implementation the mutant overlays and which reference suite is run
   * against it. A phase with one run fills it in; a phase with two has to say.
   */
  private loadMutant(
    one: { name: string; meta: Record<string, unknown>; files: (implPaths: string[]) => Record<string, string> },
    runs: PhaseRun[],
  ): MutantSpec {
    const name = one.name;
    const at = `mutants/${name}/meta.json`;
    const meta = one.meta;
    const ids = runs.map((r) => r.id);
    const declared = optString(meta.run);
    req(
      declared === undefined || ids.includes(declared),
      `${at}: run "${declared}" is not one of ${ids.join(', ')}`,
    );
    req(
      declared !== undefined || runs.length === 1,
      `${at}: run is required when the phase declares more than one run — it decides which implementation this mutant overlays and which suite is run against it`,
    );
    const run = runs.find((r) => r.id === (declared ?? ids[0])) as PhaseRun;
    const implPaths = Object.keys(run.implFiles);
    // each file placed at the implementation path it replaces (its path under
    // the mutant's folder); a file that lands on no such path keeps its own,
    // and is refused here
    const files = one.files(implPaths);
    for (const target of Object.keys(files)) {
      req(
        implPaths.includes(target),
        `mutants/${name}: "${target}" overlays nothing in the ${run.id} run's implementation (${implPaths.join(', ')}), so no suite could kill it`,
      );
    }
    req(Object.keys(files).length > 0, `mutants/${name} has no file to overlay`);
    const mutant: MutantSpec = {
      name: reqString(meta.name, `${at}: name`),
      description: reqString(meta.description, `${at}: description`),
      files,
      run: run.id,
    };
    // `covers` names the criterion the mutant proves (the kill matrix column);
    // packs that predate it simply leave it off.
    const covers = optString(meta.covers);
    if (covers) mutant.covers = covers;
    return mutant;
  }

  private loadCoverageKeywords(raw: unknown): CoverageKeywordSpec[] {
    req(Array.isArray(raw), 'checks.coverageKeywords must be an array');
    return (raw as Record<string, unknown>[]).map((g, i) => {
      const at = `checks.coverageKeywords[${i}]`;
      req(g && typeof g === 'object', `${at} must be an object`);
      const group: CoverageKeywordSpec = {
        criterion: reqString(g.criterion, `${at}.criterion`),
        keywords: reqStringArray(g.keywords, `${at}.keywords`),
      };
      req(group.keywords.length > 0, `${at}.keywords must not be empty`);
      // `criterionId` is the "US-2/AC-1" style id the group evidences; some
      // packs carry only the human-readable `criterion`.
      const criterionId = optString(g.criterionId);
      if (criterionId) group.criterionId = criterionId;
      return group;
    });
  }

  /**
   * `checks.smoke.commands`, required: how the pack's own CLI is exercised
   * once the learner's container has started it. There is no default: a
   * language-blind fallback silently scored every learner of a pack that
   * forgot the key at zero on a criterion worth a third of the phase, and
   * nothing failed at boot to say so. Each command names an interpreter and
   * one of the reference implementation files, so the argv the smoke run
   * composes is always a script the pack ships.
   */
  private loadSmokeCommands(raw: unknown, implFiles: Record<string, string>): string[][] {
    req(
      Array.isArray(raw) && raw.length > 0,
      'checks.smoke.commands is required: name the commands that exercise the CLI this pack ships',
    );
    return (raw as unknown[]).map((command, i) => {
      const at = `checks.smoke.commands[${i}]`;
      req(
        Array.isArray(command) && command.every((a) => typeof a === 'string' && a.length > 0),
        `${at} must be an array of non-empty strings`,
      );
      const argv = command as string[];
      req(argv.length >= 2, `${at} must name an interpreter and a script`);
      req(
        SMOKE_INTERPRETERS.has(argv[0]),
        `${at}: "${argv[0]}" is not one of ${Array.from(SMOKE_INTERPRETERS).join(', ')}`,
      );
      req(
        implFiles[argv[1]] !== undefined,
        `${at}: "${argv[1]}" is not one of checks.smoke.implFiles, so the smoke run would start a file this pack does not ship`,
      );
      return argv;
    });
  }

  /**
   * `checks.smoke.expect`, required: the substring the smoke run looks for in
   * the CLI's output. It is derived from the pack's own reference
   * implementation, and validated as such at load time, because the graded
   * build check is only as strong as this string. An expectation made of
   * nothing but the words the command already passes in ("Ship the release")
   * is satisfied by any program that echoes its arguments, so a container
   * that never starts the CLI would score full marks.
   */
  private loadSmokeExpectation(
    raw: unknown,
    commands: string[][],
    implFiles: Record<string, string>,
    implFilesName: string,
  ): string {
    const expect = reqString(raw, 'checks.smoke.expect');
    const passedIn = new Set(
      commands.flatMap((argv) => argv.slice(1).flatMap((a) => a.split(/\s+/))).filter(Boolean),
    );
    const own = expect.split(/\s+/).filter((word) => word && !passedIn.has(word));
    req(
      own.length > 0,
      `checks.smoke.expect ("${expect}") repeats only what the smoke command passes in, so a program that echoes its arguments would pass the build check: expect what the reference implementation prints around them`,
    );
    const reference = Object.values(implFiles).join('\n');
    req(
      own.some((word) => reference.includes(word)),
      `checks.smoke.expect ("${expect}") is not printed by the reference implementation: none of ${own.join(', ')} appears in ${implFilesName}`,
    );
    return expect;
  }

  /**
   * `checks.drill`, optional and deployment-only: the faulted copy the
   * incident drill runs its "before" smoke check against: the files under
   * the phase folder's `drill/`.
   */
  private loadDrill(inputs: PhaseInputs, raw: unknown): DrillSpec | undefined {
    if (raw === undefined || raw === null) return undefined;
    req(typeof raw === 'object', 'checks.drill must be an object');
    const spec = raw as Record<string, unknown>;
    const fault = reqString(spec.fault, 'checks.drill.fault');
    const faultedFiles = inputs.drill(spec);
    req(
      Object.keys(faultedFiles).length > 0,
      `checks.drill (${fault}) needs at least one entry in ${inputs.named('faultedFiles')}`,
    );
    return {
      fault,
      description: optString(spec.description) || '',
      faultedFiles,
      // a drill whose fault the smoke check does not catch teaches nothing,
      // so expecting failure is the default, not the opt-in
      expectFailure: spec.expectFailure !== false,
    };
  }

  private loadChecks(
    inputs: PhaseInputs,
    raw: any,
    project: { language: string; languages: RunLanguage[] },
    files: ContentFileSpec[],
    phaseKey: PhaseKey,
    options: LoadProjectOptions = {},
  ): PhaseChecks {
    if (raw.drill && raw.kind !== 'config') {
      // a drill needs a smoke check to fail, which only config phases have
      this.logger.warn(`checks.drill ignored on a ${raw.kind} phase (${inputs.where})`);
    }
    // a record on a phase of the wrong kind or key is refused, never ignored, before anything else of the phase is read
    const keyed = (key: PhaseKey) => phaseKey === undefined || phaseKey === key;
    req(raw.runbook === undefined || (raw.kind === 'config' && keyed('deployment')), ONLY_DEPLOYMENT_RUNBOOK);
    req((raw.ticket === undefined && raw.change === undefined) || (raw.kind === 'code' && keyed('maintenance')), ONLY_MAINTENANCE_CHANGE);
    switch (raw.kind) {
      case 'markdown': {
        // The older written kind converts at the door only for Requirements (here) and Design (loadPhase);
        // under any other key, or without the door's flag, it is refused by name.
        if (options.convertLegacyRequirements && phaseKey === 'requirements') {
          const legacy = storyChecksFromLegacyMarkdown(files, raw);
          files.splice(0, files.length, ...legacy.files);
          // Told once per upload: to the caller that collects it, else to the log.
          if (options.warnings) options.warnings.push(legacy.note);
          else this.logger.warn(legacy.note);
          return legacy.checks;
        }
        // A Requirements without the flag, or a Design the door did not convert (loadPhase converts it before this),
        // is the older format of a phase that does convert: its own sentence, not the retired-key one.
        if (phaseKey === 'requirements') throw new Error(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
        if (phaseKey === 'design') throw new Error(DESIGN_OLDER_FORMAT_REFUSAL);
        throw new Error(retiredWrittenPhaseUploadRefusal(PHASE_TITLES[phaseKey]));
      }
      case 'code': {
        const runs = this.loadCodeRuns(inputs, raw, project, files);
        // the flat fields stay the union of the runs, so every reader written
        // before `runs` existed sees exactly what it saw
        const hiddenTestFiles: Record<string, string> = {};
        for (const run of runs) Object.assign(hiddenTestFiles, run.hiddenTestFiles);
        const editableTargets = reqStringArray(raw.editableTargets, 'checks.editableTargets');
        req(editableTargets.length > 0, 'checks.editableTargets must not be empty');
        req(!editableTargets.includes(CHANGE_REQUEST_JSON), 'maintenance/change-request.json is the change request record, never an editable target.');
        // The solution is the pack's own answer to its stubs, so it is mapped
        // onto the very paths the learner edits: the spec overlays it and runs
        // the hidden suite against it, which is the only thing that proves the
        // hidden tests and the shipped answer still agree.
        const solutionFiles = inputs.solution(raw, editableTargets);
        const unanswered = editableTargets.filter((t) => solutionFiles[t] === undefined);
        req(
          unanswered.length === 0,
          `${inputs.named('checks.solutionDir')}: nothing in it completes ${unanswered.join(', ')}, so the pack ships a stub with no answer to hold the hidden suite against`,
        );
        const code: CodeChecks = {
          kind: 'code',
          editableTargets,
          visibleTests: [...new Set(runs.flatMap((r) => r.visibleTests))],
          hiddenTestFiles,
          solutionFiles,
          solutionSources: Object.values(solutionFiles),
          runs,
        };
        if (raw.ticket !== undefined || raw.change !== undefined) {
          req(phaseKey === undefined || phaseKey === 'maintenance', ONLY_MAINTENANCE_CHANGE);
          req(raw.ticket !== undefined && raw.change !== undefined, 'A Maintenance change request comes with its ticket: checks.ticket and checks.change go together.');
          code.ticket = validateChangeTicket(raw.ticket);
          code.change = validateChangeChecks(raw.change, phaseKey);
        }
        return code;
      }
      case 'tests': {
        const learnerTestFiles = reqStringArray(raw.learnerTestFiles, 'checks.learnerTestFiles');
        req(learnerTestFiles.length > 0, 'checks.learnerTestFiles must not be empty');
        // The suite the pack itself would hand in. It lives beside the pack so
        // one artefact proves the kill matrix, rather than a copy in the e2e
        // fixtures and another in the JS journey script drifting apart, and so
        // a mutant no shipped suite can kill fails the pack's own spec.
        const referenceTestFiles = inputs.reference(raw, learnerTestFiles);
        req(
          learnerTestFiles.some((t) => referenceTestFiles[t] !== undefined),
          `${inputs.named('checks.referenceDir')}: nothing in it lands on ${learnerTestFiles.join(', ')}, so the reference suite would never be the file the graders run`,
        );
        // the reference implementation, at the workspace paths the runs name
        // the declared paths are read only for `implDir`, so a malformed run keeps its own sentence
        const implFiles = inputs.impl(raw, raw.implDir ? this.declaredImplPaths(raw) : []);
        // Locked helpers the learner's suite imports. They ride in
        // the job's `files` rather than in `gradedFiles`, because a module the
        // suite imports has to still exist when the suite loads: the graded
        // files are deleted before that, and they are named here rather than
        // taken from `files` because the grading runs deliberately carry none
        // of the phase's files.
        const supportFiles = inputs.support(raw, files);
        const runs = this.loadTestsRuns(raw, project, {
          learnerTestFiles,
          referenceTestFiles,
          implFiles,
          supportFiles,
        });
        const mutants = inputs
          .mutants(raw)
          .map((one) => this.loadMutant(one, runs))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          kind: 'tests',
          learnerTestFiles,
          referenceTestFiles,
          implFiles,
          mutants,
          coverageKeywords: this.loadCoverageKeywords(raw.coverageKeywords),
          minTests: raw.minTests ?? 3,
          supportFiles,
          runs,
        };
      }
      case 'config': {
        req(raw.smoke && typeof raw.smoke === 'object', 'checks.smoke is required');
        const smokeImplFiles = inputs.smoke(raw);
        const smokeCommands = this.loadSmokeCommands(raw.smoke.commands, smokeImplFiles);
        // Which Dockerfile the smoke check parses for an entry point.
        // A two-service application ships `api/Dockerfile` and
        // `web/Dockerfile`, and the smoke run starts one of them.
        const smokeDockerfile =
          raw.smoke.dockerfile === undefined
            ? 'Dockerfile'
            : reqWorkspacePath(raw.smoke.dockerfile, 'checks.smoke.dockerfile');
        req(
          smokeImplFiles[smokeDockerfile] !== undefined ||
            files.some((f) => f.path === smokeDockerfile),
          `checks.smoke.dockerfile ("${smokeDockerfile}") is neither a file this phase ships nor one of ${inputs.named('checks.smoke.implFiles')}, so the smoke run would read an entry point out of nothing`,
        );
        const drill = this.loadDrill(inputs, raw.drill);
        const checks: ConfigChecks = {
          kind: 'config',
          rules: this.loadFileRules(raw.rules, 'checks.rules', raw.runbook !== undefined),
          smokeImplFiles,
          smokeDockerfile,
          smokeCommands,
          expectInOutput: this.loadSmokeExpectation(raw.smoke.expect, smokeCommands, smokeImplFiles, inputs.named('checks.smoke.implFiles')),
        };
        if (drill) checks.drill = drill;
        if (raw.runbook !== undefined) checks.runbook = validateRunbookChecks(raw.runbook, phaseKey, !!drill);
        return checks;
      }
      case 'story':
        return validateStoryChecks(raw, phaseKey);
      case 'design':
        return validateDesignChecks(raw, phaseKey);
      default:
        throw new Error(`unknown checks kind: ${raw.kind}`);
    }
  }

  /* ------------------------------ accessors ------------------------------ */

  listProjects(): ProjectContent[] {
    return Array.from(this.projects.values());
  }

  getProject(slug: string): ProjectContent {
    const project = this.projects.get(slug);
    if (!project) throw new NotFoundException(`unknown project: ${slug}`);
    return project;
  }

  getPhase(slug: string, key: string): PhaseContent {
    return phaseOf(this.getProject(slug), key);
  }

  getPhaseByOrder(slug: string, order: number): PhaseContent {
    const phase = this.getProject(slug).phases.find((p) => p.order === order);
    if (!phase) throw new NotFoundException(`unknown phase order: ${order}`);
    return phase;
  }

  /* --------------------------------- the pin -------------------------------- */

  /**
   * The project **this enrolment** resolves content from.
   *
   * `getProject(slug)` above answers the published head, which is right for a
   * request that names a project: a catalogue, a rubric listing, an
   * instructor's project picker. It is wrong for an enrolment: a published
   * version is immutable precisely so that a learner cannot have a rubric, a
   * hidden suite or a phase title move under an attempt, and that promise is
   * only kept if the resolution takes the version they hold. So every content
   * resolution an enrolment owns comes through here.
   *
   * Synchronous, because two of those call sites are in a pure module
   * (`workflow/accepted-screen-copy.ts`) and because the whole point of the
   * compiled snapshot is that resolving content is a map read.
   *
   * A **null pin** resolves the published head. Legacy rows keep working and
   * the read never rewrites them: an enrolment made before the model had
   * versions is not a fault, it is a row from before.
   */
  getForEnrollment(enrollment: EnrollmentPin): ProjectContent {
    return this.resolveForEnrollment(enrollment).content;
  }

  /**
   * **The** resolution: which version this enrolment is served, and which id
   * that version has.
   *
   * `getForEnrollment` above, `getPhaseForEnrollment` and
   * `getTasksForEnrollment` all read through this one function, and that is the
   * whole of the step. An accessor that resolved a task list on its own would
   * look the pin up in `versionTasks`, and on either of the two faults below it
   * would find nothing (because the fault is precisely that the pin names no
   * installed version, or names another project's), and fall back to a sole
   * task synthesised over the **head's** phase. A head phase declaring three
   * required tasks would then resolve to the one required key `''`: the phase
   * would open on a single verdict, with the answer door behind it. One
   * resolution is what makes that doubt fall shut, and `heads` is already
   * slug → the head's version id, so there is one keyed structure and no second
   * that can disagree with it.
   *
   * The version id is null only where there is none to state: a deployment that
   * walked a directory holds no version rows at all.
   */
  resolveForEnrollment(enrollment: EnrollmentPin): {
    content: ProjectContent;
    versionId: string | null;
  } {
    const head = this.getProject(enrollment.projectSlug);
    const headId = this.heads.get(enrollment.projectSlug) ?? null;
    const pin = enrollment.projectVersionId;
    if (!pin) return this.servable({ content: head, versionId: headId });
    const pinned = this.versions.get(pin);
    // Two data faults, and neither takes a learner's door away: the answer is
    // the one the platform gave before the pin existed. Both are refused at the
    // door that writes them: the class import refuses an enrolment naming a
    // version the destination does not hold, by name, so a row in either shape
    // is a fault to be found rather than a case to be served, and the warning
    // is how it gets found.
    if (!pinned) {
      this.warnPin(pin, `enrolment in "${enrollment.projectSlug}" pins the project version ${pin}, which this deployment holds no published row for; answering its newest published version ${head.version}`);
      return this.servable({ content: head, versionId: headId });
    }
    if (pinned.slug !== enrollment.projectSlug) {
      this.warnPin(pin, `enrolment in "${enrollment.projectSlug}" pins the project version ${pin}, which belongs to "${pinned.slug}"; answering "${enrollment.projectSlug}" at ${head.version}, because projectSlug is what the enrolment's own rows key on`);
      return this.servable({ content: head, versionId: headId });
    }
    return this.servable({ content: pinned, versionId: pin });
  }

  /**
   * The resolution, or the refusal: the second, runtime statement of the
   * compiler's wall on executable split phases.
   *
   * It is asked of the version that **resolved**, not of the project: a learner
   * pinned to a snapshot this build can grade keeps their board whatever the
   * head looks like. And it is asked here rather than in each accessor, so that
   * a phase, its files and its task list cannot disagree about whether this
   * version may be served at all.
   *
   * A doubt reads shut, and a snapshot this build cannot grade is a doubt: the
   * alternative is grading every task of a split executable phase against the
   * whole phase's suite and carrying one task's work into another's score.
   */
  private servable(resolved: { content: ProjectContent; versionId: string | null }): {
    content: ProjectContent;
    versionId: string | null;
  } {
    const refused = resolved.versionId ? this.unservable.get(resolved.versionId) : undefined;
    if (refused) throw new Error(describeUnservableVersion(refused));
    return resolved;
  }

  /** One phase of the version this enrolment holds, with `getPhase`'s own 404. */
  getPhaseForEnrollment(enrollment: EnrollmentPin, key: string): PhaseContent {
    return phaseOf(this.resolveForEnrollment(enrollment).content, key);
  }

  /**
   * The compiled tasks of one phase **of the version this enrolment holds**.
   *
   * This is the accessor every learner-side question about the task grain reads
   * through (the roll-up's quantifier, the strict gate's narrow, the board
   * repair's wanted set, the per-task door, the view builder), and it answers
   * from the same resolution `getPhaseForEnrollment` answers from, so a phase
   * and its tasks are always one version's.
   *
   * A version this deployment stored no tasks for answers the phase's sole
   * task: a directory walk has no version rows, and a phase that declared no
   * tasks compiled to exactly that one. `soleTaskList` is then true and every
   * per-task derivation takes its phase-wide arm.
   *
   * **And it is the only accessor: there is deliberately no `getTasks(slug,
   * key)`.** Several comments across the workflow, the instructor console and
   * the portability import warn against composing the *head's* task list with a
   * pinned board: two keyed structures that disagree in both directions, an
   * enrolment on a split version whose head has been flattened getting no rows
   * at all and one on a flat version whose head has been split getting rows
   * keyed for tasks its own version does not declare. A head accessor was
   * written for the surfaces whose question is *"what does this project declare
   * right now"*, and no surface asks it: the console and the regrade
   * read per enrolment, and the authoring draft reads its own `project_tasks`
   * rows. Rather than ship a public accessor whose only stated property is that
   * no learner path may call it, the head's list has no accessor at all. A
   * caller that genuinely wants the head asks this one with a **null pin**,
   * which is the resolution that answers the head and says so at the call site.
   */
  getTasksForEnrollment(enrollment: EnrollmentPin, key: string): CompiledTask[] {
    const resolved = this.resolveForEnrollment(enrollment);
    const phase = phaseOf(resolved.content, key);
    return this.storedTasks(resolved.versionId, key) ?? [soleTaskFor(phase)];
  }

  /**
   * The tasks stored for one phase of one installed version, or null.
   *
   * A shallow copy of the array, for the reason `compilerDrift()` copies: the
   * stored list is the published version's and it is read on every submit,
   * every repair and every board read, so one caller sorting it by order (in
   * place, as `Array.prototype.sort` does) would reorder what every learner on
   * this deployment is served until the process restarts. The tasks themselves
   * are shared, exactly as `getForEnrollment` shares the resolved content.
   */
  private storedTasks(versionId: string | null, key: string): CompiledTask[] | null {
    if (!versionId) return null;
    const stored = this.versionTasks.get(versionId)?.get(key);
    return stored ? [...stored] : null;
  }

  /**
   * The `project_versions.id` of a project's published head, or null when this
   * deployment holds no version rows for it.
   *
   * It is what a new enrolment's pin is stamped from: a learner who starts
   * is pinned to what they started, so the pin is a fact about their
   * attempt rather than a fact about the deployment. Null before the registry
   * has installed anything, a directory load has no version rows, and a null
   * pin resolves the head, so the unpinned path is the same path a legacy row
   * takes.
   */
  headVersionIdFor(slug: string): string | null {
    return this.heads.get(slug) ?? null;
  }

  /** One line per broken pin, not one per request. */
  private warnPin(pin: string, message: string): void {
    if (this.warnedPins.has(pin)) return;
    this.warnedPins.add(pin);
    this.logger.warn(message);
  }

  /**
   * Client-facing workspace files for a phase: locked files from content,
   * editable files overlaid with the learner's saved workspace.
   */
  workspaceFiles(phase: PhaseContent, workspace: Record<string, string> | null): WorkspaceFile[] {
    return phase.files.map((f) => ({
      path: f.path,
      content: f.editable && workspace && workspace[f.path] !== undefined ? workspace[f.path] : f.content,
      editable: f.editable,
      language: f.language,
    }));
  }

  /**
   * Server-side file map for execution: locked content always comes from the
   * content bundle (never from the client), editable content from workspace.
   */
  executionFiles(phase: PhaseContent, workspace: Record<string, string> | null): Record<string, string> {
    const files: Record<string, string> = {};
    for (const f of phase.files) {
      files[f.path] =
        f.editable && workspace && workspace[f.path] !== undefined ? workspace[f.path] : f.content;
    }
    return files;
  }

  /**
   * The editable paths of a project's design phase (the record and each
   * contract switched on, `design/design.json` first), so the feedback pipeline reads the learner's design
   * artefacts by content declaration rather than by hard-coded name. Empty for
   * a project with no design phase.
   */
  designFilesFor(project: string | ProjectContent): string[] {
    const resolved = typeof project === 'string' ? this.getProject(project) : project;
    const design = resolved.phases.find((p) => p.key === 'design');
    if (!design) return [];
    return design.files.filter((f) => f.editable).map((f) => f.path);
  }

  /** The interview brief for a phase, or null when it declares none. */
  interviewBrief(phase: PhaseContent): InterviewBrief | null {
    return phase.interview ?? null;
  }

  /** The declared incident drill for a phase, or null when it has none. */
  drillSpec(phase: PhaseContent): DrillSpec | null {
    return phase.checks.kind === 'config' && phase.checks.drill ? phase.checks.drill : null;
  }

  /**
   * Execution files with the drill's faulted copy laid over the learner's
   * work: what the drill's "before" run executes. Null when the phase
   * declares no drill, so a caller can refuse the request instead of running a
   * check that proves nothing.
   */
  faultedExecutionFiles(
    phase: PhaseContent,
    workspace: Record<string, string> | null,
  ): Record<string, string> | null {
    const drill = this.drillSpec(phase);
    if (!drill) return null;
    return { ...this.executionFiles(phase, workspace), ...drill.faultedFiles };
  }
}
