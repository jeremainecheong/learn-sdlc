import { readFileSync } from 'fs';
import { basename, join } from 'path';
import type { PhaseContent } from '../src/content/content.types';
import { FIXTURES_DIR } from './fixtures/paths';

/**
 * TaskTrackr 3.0.0's markdown Design phase, rebuilt from the legacy fixture
 * (`test/fixtures/legacy-design`, the files and phase.json the adapter spec
 * reads) over a loaded phase: its checks, rubric and six files, two of them
 * read-only documents. TaskTrackr 4.0.0's Design is a design phase, so a spec
 * that needs a written Design of the markdown kind (rules, a prose file, a
 * phase a teacher splits) stands it up from here. The fixture's file names
 * are its sources' base names.
 */
const LEGACY = join(FIXTURES_DIR, 'legacy-design');
export const LEGACY_DESIGN_PHASE = JSON.parse(readFileSync(join(LEGACY, 'phase.json'), 'utf8')) as {
  checks: PhaseContent['checks'];
  rubric: PhaseContent['rubric'];
  files: { path: string; source: string; editable: boolean; language: string }[];
};

export function legacyDesignPhase(base: PhaseContent): PhaseContent {
  // Cast through `unknown`: the phase carries the retired markdown kind, which no product type names. It stands
  // for a Design stored in that kind, as a learner pinned to an older version still has one, for the specs that
  // read such a stored row.
  return {
    ...base,
    artifactKind: 'markdown',
    checks: LEGACY_DESIGN_PHASE.checks,
    rubric: LEGACY_DESIGN_PHASE.rubric,
    files: LEGACY_DESIGN_PHASE.files.map((file) => ({
      path: file.path,
      editable: file.editable,
      language: file.language,
      content: readFileSync(join(LEGACY, basename(file.source)), 'utf8'),
    })),
  } as unknown as PhaseContent;
}
