import * as fs from 'fs';
import * as path from 'path';
import { repoRoot } from './paths';

/** Where the packs live: one expression, read by `config.contentDir` and by the default below. */
export const contentDir =
  process.env.CONTENT_DIR || (repoRoot ? path.join(repoRoot, 'content') : path.resolve('content'));

/**
 * The project slug an operator named, or '' when they named none.
 *
 * The half of the default below that is a *choice* rather than a guess, split
 * out because the project resolution order needs to tell the two apart. The order's third step is "the DEFAULT_PROJECT slug,
 * if set", and its fourth is the `projects` row the importer flagged; a step 3
 * that read `defaultProject` would answer the first directory on disk whenever
 * nobody set the variable and step 4 would never get a turn. The directory
 * reading is not wrong; it is exactly what the seed needs, since it is how the
 * importer knows which pack to flag; it is only the wrong answer to "which
 * project is this learner in".
 *
 * Synchronous and file-free on purpose: `config` is read at module load, long
 * before a repository exists.
 */
export function resolveNamedProject(env = process.env): string {
  return (env.DEFAULT_PROJECT || '').trim();
}

/**
 * The pack this content directory ships, named or guessed, **and not the
 * answer to "which project is this learner in"**.
 *
 * A hard-coded literal such as 'tasktrackr' would be dangerous here: with one
 * pack and no chooser this default is taken often, so renaming the pack would
 * make every request without a `project` query ask for a project that does not
 * exist, with no compiler and no test to say so. So it is derived from the content directory
 * instead, read exactly as ContentService reads it (a directory holding a
 * project.json, keyed by the pack's own `slug`), which makes this
 * `ContentService.listProjects()[0].slug` without config importing the service
 * that imports config. DEFAULT_PROJECT overrides it for a deployment that
 * ships more than one pack and wants a particular one to be the answer.
 *
 * The learner routes must not use it. A directory listing is a fact about a
 * deployment's filesystem; passed whenever a request named no project, it would
 * resolve a learner whose class had been moved, or whose own project was not
 * the one that sorted first, to somebody else's project and hand them a
 * first-run screen. That question belongs to
 * `WorkflowService.projectVersionForLearner`: the learner's own
 * enrolment, their class's assignment, the `DEFAULT_PROJECT` slug
 * (`resolveNamedProject` above, never this), then the `projects` row the
 * importer flagged. What is left here is the slug fallback this is actually
 * good for: which pack a terminal import should flag when an operator asks it
 * to (`cli/import-pack.ts`), on a deployment that ships one and names it.
 *
 * Empty when there is no readable pack. That deployment cannot boot anyway
 * (`ProjectRegistryService` refuses to start when no published version holds a
 * compiled snapshot), so the honest empty string is better than a literal that
 * would be wrong twice over.
 */
export function resolveDefaultProject(dir: string = contentDir, env = process.env): string {
  const named = resolveNamedProject(env);
  if (named) return named;
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return '';
  }
  for (const name of names) {
    const at = path.join(dir, name, 'project.json');
    if (!fs.existsSync(at)) continue;
    try {
      const slug = JSON.parse(fs.readFileSync(at, 'utf-8')).slug;
      if (typeof slug === 'string' && slug.trim()) return slug.trim();
    } catch {
      // A project.json that will not parse is ContentService's error to report
      // at boot, in its own sentence naming the file. Fall back to the
      // directory name rather than raising a second, worse one from here.
    }
    return name;
  }
  return '';
}
