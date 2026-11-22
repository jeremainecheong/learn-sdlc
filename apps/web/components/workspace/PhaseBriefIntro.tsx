import type { PhaseKey } from '@learnsdlc/shared';
import { isLastPhase } from '@learnsdlc/shared';
import { useProjectMaybe } from '@/lib/useProject';
import { briefClosingLine } from './onward-copy';
import { PhaseArtwork } from '@/components/phases/PhaseArtwork';
import { PHASE_EXPERIENCE } from '@/components/phases/experience';
import { bridgeNotice, kickerName, useBridgeApplication, useOwnRoomGuidance, usePhaseOwnIntro, useProjectName } from '@/lib/scenario';

const BRIEFS: Record<PhaseKey, { title: string; description: string; steps: string[] }> = {
 // Words that fit any project: the aside is drawn in every project's room, so
 // it names no story of the reference project's.
 requirements: { title: 'Find the need behind the request.', description: 'Discover what the stakeholder needs and why. Turn their evidence into a story a team can build.', steps: ['Ask the stakeholder', 'Keep the source evidence', 'Write observable criteria'] },
 design: { title: 'Make the pieces agree.', description: 'Turn the approved stories into data, operations, and a screen contract. A consumer should know what to expect before any code is written.', steps: ['Story and boundary', 'Data model', 'HTTP contract', 'Screen states'] },
 implementation: { title: 'Make the contract work.', description: 'Follow one request from the user to the database, then verify the saved implementation.', steps: ['Read the contract', 'Implement one gap', 'Run and inspect'] },
 testing: { title: 'Prove the promise.', description: 'Choose tests that expose an incorrect rule. A useful failure tells you what broke and where to look.', steps: ['Choose a boundary', 'Write an assertion', 'Inspect the evidence'] },
 deployment: { title: 'Understand the release.', description: 'Connect the image definition, service address, workflow, and runbook. Inspect exactly what your selfcheck proves.', steps: ['Define the services', 'Connect the workflow', 'Investigate the incident'] },
 maintenance: { title: 'Keep the promise.', description: 'Add the requested capability while preserving the behavior people already rely on.', steps: ['Scope the change', 'Review the diff', 'Check for regressions'] },
};
/**
 * The standing words that state the reference project's deliverables, as a
 * room that is not the reference's reads them instead: Design's
 * "screen contract" and Implementation's "contract" and "request ... to the
 * database". Only where the room's own intro is not drawn in their place.
 */
const OWN_ROOM: Partial<Record<PhaseKey, { title?: string; description?: string }>> = {
 design: { description: 'Decide what the work holds and what it does, before anyone writes the code.' },
 implementation: { title: 'Make the code work.', description: 'Change the editable files the brief names, then run the tests and read what they report.' },
};
/**
 * `phaseSteps`: whether the room is working the phase's own task. A room open
 * on a teacher's authored task states that task's steps in its own panel, so
 * a room of its own leaves the phase's objectives out here (the reference
 * project's standing steps are not the phase's objectives and stay).
 */
export function PhaseBriefIntro({ phaseKey, phaseSteps = true }: { phaseKey: PhaseKey; phaseSteps?: boolean }) {
 // A room that is not the reference project's (an uploaded project, or a
 // copy whose room task the teacher rewrote) reads its pack's objectives as
 // the steps, and no line that names the reference project's deliverables.
 // The reference project's room keeps every word as it was.
 const own=useOwnRoomGuidance(phaseKey);
 const brief=own?{...BRIEFS[phaseKey],...OWN_ROOM[phaseKey]}:BRIEFS[phaseKey];
 const steps=own?(phaseSteps?own.objectives:[]):brief.steps;
 // The kicker names the learner's own project, not the reference project, on one line; a name too long
 // for the column ends in an ellipsis (the whole kicker is its title), never a last letter wrapped alone.
 const named=useProjectName();
 const project=kickerName(named);
 // On the last four phases of a
 // teacher's project the application is still the reference project's, and
 // the learner is told so plainly. The name comes from the provenance
 // payload, never from a literal.
 const application=useBridgeApplication(phaseKey);
 // On a phase that is not the reference project's scenario the aside draws
 // the version's own intro, the teacher's words, in place of the standing
 // description. The reference project keeps its standing words byte for byte.
 const ownIntro=usePhaseOwnIntro(phaseKey);
 // The closing line says what the work carries into. On the project's last
 // phase (`isLastPhase` over the enrolment's own list) there is no next phase:
 // the phase passing lets the learner complete the project (onward-copy.ts).
 const enrollment=useProjectMaybe()?.enrollment;
 const last=Boolean(enrollment&&isLastPhase(enrollment,phaseKey));
 // The mentor's purpose line is the reference project's ("Make the contract
 // and the request path agree."); in a room of its own the intro above already
 // says what the phase is for, so the line is left out rather than repeated.
 return <div className="phase-brief-intro"><small className="flex min-w-0" title={`${phaseKey.toUpperCase()} / ${project}`}><span className="shrink-0 whitespace-pre">{phaseKey.toUpperCase()} / </span><span className="min-w-0 truncate" data-testid="phase-brief-kicker-project">{project}</span></small><div><h2>{brief.title}</h2><PhaseArtwork phaseKey={phaseKey} /></div>{ownIntro?<p className="wrap whitespace-pre-line" data-testid="phase-brief-own-intro">{ownIntro}</p>:<p>{brief.description}</p>}{application&&<p className="phase-brief-bridge" role="note" data-testid="phase-bridge-notice">{bridgeNotice(application)}</p>}{steps.length>0&&<><h3>From a need to a promise</h3><ol>{steps.map((step,index)=><li key={index}><span>{index+1}</span><p>{step}</p></li>)}</ol></>}<section>{!own&&<strong>{PHASE_EXPERIENCE[phaseKey].purpose}</strong>}<p>{briefClosingLine(last)}</p></section></div>;
}
