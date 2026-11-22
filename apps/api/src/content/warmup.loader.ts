import * as fs from 'fs';
import * as path from 'path';
import type { RunHarness, RunLanguage } from '@learnsdlc/shared';
import { ContentFileSpec, WarmupContent } from './content.types';
import { HARNESSES_FOR, RUN_LANGUAGES } from './run-languages';
import { req, reqString, reqStringArray } from './validate';

/**
 * The warm-up loader.
 *
 * A platform pack holds the exercise in a `warmup/` folder beside `phases/`,
 * found by the folder alone (`project.json` names no warm-up in the folder
 * layout; an upload's `warmup/` is refused). It is loaded here rather than by
 * `loadPhase` because a warm-up is not a phase: it has no key, no order, no
 * rubric and no gate, and folding it into the phase loader would put it inside
 * the `order 1..6` invariant every phase reader depends on.
 *
 * The validation reads like `loadPhase`'s on purpose: a bad pack should name
 * its own mistake at boot, with the file and the field, rather than surface as
 * an undefined three services away on the morning of a class.
 *
 * What it loads is part of the compiled pack: the snapshot's `warmup` member,
 * the `warmup` file rows the importer writes, and the digests both are
 * compared by. No API route hands the warm-up to a learner.
 */

/** A workspace path a warm-up may declare: relative, and inside the workspace. */
function reqWorkspacePath(value: unknown, field: string): string {
  const at = reqString(value, field);
  const normalized = path.normalize(at);
  req(
    !path.isAbsolute(at) && !normalized.startsWith('..'),
    `${field} ("${at}") must be a relative path inside the workspace`,
  );
  return at;
}

/* --------------------------- the warm-up's own run ---------------------- */

/**
 * The warm-up's own run.
 *
 * The shipped exercise is TypeScript so that the first thing a learner ever
 * runs is the transform and the DOM harness on a one-line function, and the check
 * has to say which language and harness that is rather than inherit the pack's
 * primary: the pack's primary is Python and the warm-up is not.
 *
 * All three default: a warm-up that declares none runs in the pack's own
 * language, under that language's harness, with no transform.
 */
function loadCheckRun(
  check: Record<string, unknown>,
  projectLanguage: string,
  languages: readonly string[],
): { language: RunLanguage; harness: RunHarness; transform: boolean } {
  const language = (
    check.language === undefined ? projectLanguage : reqString(check.language, 'warmup.json: check.language')
  ) as RunLanguage;
  req(
    RUN_LANGUAGES.includes(language),
    `warmup.json: check.language ("${language}") is not one of ${RUN_LANGUAGES.join(', ')}`,
  );
  req(
    languages.includes(language),
    `warmup.json: check.language ("${language}") is not one of this pack's languages (${languages.join(', ')})`,
  );
  const allowed = HARNESSES_FOR[language];
  const harness = (
    check.harness === undefined
      ? (language === 'python' ? 'unittest' : 'js')
      : reqString(check.harness, 'warmup.json: check.harness')
  ) as RunHarness;
  req(
    allowed.includes(harness),
    `warmup.json: check.harness ("${harness}") cannot run ${language}: use ${allowed.join(' or ')}`,
  );
  req(
    check.transform === undefined || typeof check.transform === 'boolean',
    'warmup.json: check.transform must be true or false',
  );
  const transform = check.transform === undefined ? language === 'typescript' : check.transform === true;
  req(
    !transform || language === 'typescript',
    `warmup.json: check.transform is only for a typescript check, and this one is ${language}`,
  );
  return { language, harness, transform };
}

function readRel(dir: string, rel: string, field: string): string {
  const resolved = path.resolve(dir, rel);
  req(fs.existsSync(resolved), `${field}: source file not found: ${rel} (resolved to ${resolved})`);
  return fs.readFileSync(resolved, 'utf-8');
}

/** A warm-up keeps its brief inline as `brief`, plain text; a `briefFile` pointer is refused by name. */
export const WARMUP_BRIEF_FILE_REFUSAL = 'warmup.json keeps its brief inline as brief, not in a file.';

/**
 * Load a pack's warm-up, or null when it declares none.
 *
 * `rel` is `project.json`'s `warmup` value: the directory, relative to the pack
 * root. Absent is not an error: a pack can ship without one.
 */
export function loadWarmup(
  packDir: string,
  rel: unknown,
  projectLanguage: string,
  languages: readonly string[] = [projectLanguage],
): WarmupContent | null {
  if (rel === undefined || rel === null) return null;
  const at = `${path.basename(packDir)}/project.json: warmup`;
  const dir = path.resolve(packDir, reqString(rel, at));
  req(fs.existsSync(dir), `${at}: directory not found (resolved to ${dir})`);

  const specPath = path.join(dir, 'warmup.json');
  req(fs.existsSync(specPath), `${at}: ${path.basename(dir)}/warmup.json not found`);
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`warmup.json is not valid JSON: ${(err as Error).message}`);
  }
  req(spec && typeof spec === 'object' && !Array.isArray(spec), 'warmup.json must be an object');

  const title = reqString(spec.title, 'warmup.json: title');
  // the brief is plain text inline, so the loader reads no markdown file
  req(!('briefFile' in spec), WARMUP_BRIEF_FILE_REFUSAL);
  const brief = reqString(spec.brief, 'warmup.json: brief');
  const steps = reqStringArray(spec.steps, 'warmup.json: steps');
  req(steps.length > 0, 'warmup.json: steps must not be empty');

  req(Array.isArray(spec.files), 'warmup.json: files must be an array');
  const files: ContentFileSpec[] = (spec.files as unknown[]).map((raw, i) => {
    const at2 = `warmup.json: files[${i}]`;
    req(raw && typeof raw === 'object', `${at2} must be an object`);
    const f = raw as Record<string, unknown>;
    return {
      path: reqWorkspacePath(f.path, `${at2}.path`),
      content: readRel(dir, reqString(f.source, `${at2}.source`), `${at2}.source`),
      editable: !!f.editable,
      language: typeof f.language === 'string' && f.language.trim() ? f.language : projectLanguage,
    };
  });
  req(files.length > 0, 'warmup.json: files must not be empty');
  req(
    files.some((f) => f.editable),
    'warmup.json: files needs at least one editable entry, or there is nothing for the learner to change',
  );

  const check = (spec.check || {}) as Record<string, unknown>;
  req(check.kind === 'tests', 'warmup.json: check.kind must be "tests"');
  const testPaths = reqStringArray(check.testPaths, 'warmup.json: check.testPaths');
  req(testPaths.length > 0, 'warmup.json: check.testPaths must not be empty');

  const declared = new Map(files.map((f) => [f.path, f]));
  for (const at3 of testPaths) {
    const file = declared.get(at3);
    req(file !== undefined, `warmup.json: check.testPaths names "${at3}", which files does not declare`);
    // The check has to be the pack's, not the learner's. An editable test file
    // is a warm-up a learner passes by deleting the assertion, which teaches
    // the opposite of the thing this exercise exists to teach.
    req(!file!.editable, `warmup.json: check.testPaths names "${at3}", which is editable — a warm-up's own check must be locked`);
  }

  return {
    title,
    brief,
    runLabel: typeof spec.runLabel === 'string' && spec.runLabel.trim() ? spec.runLabel : 'Run the check',
    steps,
    files,
    check: { kind: 'tests', testPaths, ...loadCheckRun(check, projectLanguage, languages) },
  };
}
