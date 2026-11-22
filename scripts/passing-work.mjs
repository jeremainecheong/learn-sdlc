// Work that passes a phase as the product grades it now, for the scripts that
// drive the API directly (scripts/journey.mjs, scripts/stress/api.mjs).
//
// Requirements is the story record alone, design is its record and the two
// contracts, deployment is the config files and the runbook record whose
// incident the drill writes (closeDrill), and CR-2 is a published change (the
// contracts, the code and the change request record, not only code). Those
// records are the ones the Playwright suite keeps in e2e/golden-records.ts
// and e2e/record-fixtures.mjs, so they are loaded from there rather than copied.
//
// E2E_AI_STUB=true says the API under test talks to e2e/ai-stub.cjs (CI starts
// it; no real provider is called). That assessor passes a submission only when
// the learner's own files carry its marker, so the work is marked exactly as
// e2e/passing-work.ts marks the Playwright walk: in the story's notes, the
// design record's notes, or a comment line in the first file of a code phase
// that takes one. Unset, the work goes in as written, for a real provider.
import { createRequire } from 'node:module';
import { PASSING_INCIDENT } from '../e2e/record-fixtures.mjs';

const require = createRequire(import.meta.url);
// registered once: scripts/golden-artefacts.mjs registers the same hook when it is loaded first
if (!process[Symbol.for('ts-node.register.instance')]) {
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: { module: 'commonjs', target: 'es2022', esModuleInterop: true },
  });
}
const GOLDEN = require('../e2e/golden-records.ts');
const { DESIGN_JSON, STORY_JSON, serialiseDesign, serialiseStory } = require('@learnsdlc/shared');

const MARKER = process.env.E2E_AI_STUB === 'true' ? require('../e2e/ai-stub.cjs').MARKER : null;

/** Phase 1: the story record, marked in its notes when the stub assesses it. */
export function requirementsWork() {
  if (!MARKER) return GOLDEN.REQUIREMENTS_ARTEFACT;
  const story = { ...GOLDEN.REQUIREMENTS_STORY, notes: `${GOLDEN.REQUIREMENTS_STORY.notes} ${MARKER}` };
  return { [STORY_JSON]: serialiseStory(story) };
}

/** Phase 2: the design record and both contracts, the record marked in its notes when the stub assesses it. */
export function designWork() {
  if (!MARKER) return GOLDEN.DESIGN_ARTEFACT;
  const record = { ...GOLDEN.DESIGN_RECORD, notes: `${GOLDEN.DESIGN_RECORD.notes} ${MARKER}` };
  return { ...GOLDEN.DESIGN_ARTEFACT, [DESIGN_JSON]: serialiseDesign(record) };
}

/** A code phase's files, marked in the first one that takes a comment. */
export function codeWork(files) {
  if (!MARKER) return files;
  const comment = (path) => {
    if (/\.(py|ya?ml|toml|sh)$|(^|\/)Dockerfile$/.test(path)) return `# ${MARKER}`;
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return `// ${MARKER}`;
    if (/\.md$/.test(path)) return `<!-- ${MARKER} -->`;
    return null;
  };
  const target = Object.keys(files).find((path) => comment(path) !== null);
  if (!target) throw new Error('no file in this phase takes a comment for the stub marker');
  const body = files[target];
  return { ...files, [target]: `${body}${body.endsWith('\n') ? '' : '\n'}${comment(target)}\n` };
}

/** The write-up that closes the drill, shared with the Playwright suite. */
export { PASSING_INCIDENT };

/**
 * Page, check and close the drill through the API, so the record's incident is
 * written as the product writes it. `call(method, path, body)` is the caller's
 * own API client, which throws with the route's sentence on a refusal. Call it
 * after the workspace save, so the resolve's smoke check reads the fixed
 * compose file. The resolve route takes the write-up as `{ incident }`
 * (DrillResolveDto).
 */
export async function closeDrill(call, phaseId) {
  await call('POST', `/phases/${phaseId}/drill/start`);
  await call('POST', `/phases/${phaseId}/drill/health`);
  return call('POST', `/phases/${phaseId}/drill/resolve`, { incident: PASSING_INCIDENT });
}

/** Phase 5: the golden deployment files and the runbook record; the incident comes from closeDrill. */
export function deploymentWork(files) {
  return codeWork(files);
}

/** Phase 6: CR-2 as a published change, its change request record included. */
export function maintenanceWork() {
  return codeWork(GOLDEN.MAINTENANCE_ARTEFACT);
}
