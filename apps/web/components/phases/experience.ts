import type { PhaseKey } from '@learnsdlc/shared';

export const PHASE_EXPERIENCE: Record<PhaseKey, { name: string; role: string; colour: string; purpose: string; tools: string; art: string; position: string }> = {
  requirements: { name: 'Mira', role: 'Requirements mentor', colour: '#d49113', purpose: 'Turn a need into a testable promise.', tools: 'Stakeholder discovery: Epics & stories', art: 'dashboard-requirements-3d.webp', position: '0% 0%' },
  design: { name: 'Arlo', role: 'Design mentor', colour: '#6974d9', purpose: 'Make the contract and the request path agree.', tools: 'API collections: Models & sequences', art: 'dashboard-design-3d.webp', position: '50% 0%' },
  implementation: { name: 'Nova', role: 'Implementation mentor', colour: '#168dab', purpose: 'Read the scaffold. Implement one contract.', tools: 'Code editor: Live application', art: 'dashboard-implementation-3d.webp', position: '100% 0%' },
  testing: { name: 'Quinn', role: 'Testing mentor', colour: '#ba6689', purpose: 'Choose evidence that can expose a wrong rule.', tools: 'Test suites: Failures & evidence', art: 'dashboard-testing-3d.webp', position: '0% 100%' },
  deployment: { name: 'Atlas', role: 'Deployment mentor', colour: '#63984b', purpose: 'Follow the real path through the running system.', tools: 'Docker: Pipelines & health checks', art: 'dashboard-deployment-3d.webp', position: '50% 100%' },
  maintenance: { name: 'Sage', role: 'Maintenance mentor', colour: '#b28559', purpose: 'Add capability. Preserve existing promises.', tools: 'Pull requests: Regression & releases', art: 'dashboard-maintenance-3d.webp', position: '100% 100%' },
};
/**
 * The mentor's purpose in a room that is not the reference project's: the
 * standing purposes name the reference project's deliverables
 * ("Make the contract and the request path agree."), so such a room's mentor
 * says what its own phase intro says, the opening paragraph on one line and
 * ending as a sentence, or nothing where there is no intro of its own. The
 * mentor's name, role and colour stay. (`tools` is drawn nowhere.)
 */
export function ownMentorPurpose(intro: string | null | undefined): string {
  const opening = (intro ?? '').split(/\n[ \t]*\n/)[0].replace(/\s+/g, ' ').trim();
  return !opening || /[.!?\u2026]$/.test(opening) ? opening : `${opening}.`;
}
export const PHASE_KEYS = Object.keys(PHASE_EXPERIENCE) as PhaseKey[];
export function isPhaseKey(value: string): value is PhaseKey { return PHASE_KEYS.includes(value as PhaseKey); }
