import {
  NO_PHASE_TO_PUBLISH, PHASE_COMPLETION_REFUSAL, PHASE_ORDER, PUBLISHED_PHASES_FIXED, addByUploadRefusal, alreadyHeldRefusal, cannotPutBackRefusal, firstPhaseOf, holdsPhase, isLastPhase,
  keepOnePhaseRefusal, nextPhaseOf, phaseAt, phaseListSentence, phaseSetRefusal, placeLabel, placeOf, previousPhaseOf,
  removeConfirm, unknownPhaseRefusal, type PhaseKey,
} from './index';

const project = (...keys: PhaseKey[]) => ({ phases: keys.map((key, at) => ({ key, order: at + 1 })) });
const six = project(...PHASE_ORDER);
const three = project('requirements', 'design', 'implementation');
const one = project('testing');

/** Every non-empty ordered subset of the six, as key lists. */
function subsets(): PhaseKey[][] {
  const out: PhaseKey[][] = [];
  for (let mask = 1; mask < 1 << PHASE_ORDER.length; mask += 1) out.push(PHASE_ORDER.filter((_, at) => mask & (1 << at)));
  return out;
}

describe('the place helpers', () => {
  it('reads six, three and one phase by place', () => {
    expect(phaseAt(six, 3)?.key).toBe('implementation');
    expect(phaseAt(three, 3)?.key).toBe('implementation');
    expect(phaseAt(one, 1)?.key).toBe('testing');
    expect(phaseAt(one, 2)).toBeNull();
    expect(firstPhaseOf(one)?.key).toBe('testing');
    expect(firstPhaseOf({ phases: [] })).toBeNull();
  });
  it('finds the next and the previous phase by key, never by order arithmetic', () => {
    expect(nextPhaseOf(three, 'design')?.key).toBe('implementation');
    expect(nextPhaseOf(three, 'implementation')).toBeNull();
    expect(nextPhaseOf(three, 'testing')).toBeNull();
    expect(previousPhaseOf(three, 'requirements')).toBeNull();
    // a stored teacher version with orders 1, 3 and 5: the next is the next held, not order + 1
    const gapped = { phases: [{ key: 'requirements' as const, order: 1 }, { key: 'implementation' as const, order: 3 }, { key: 'deployment' as const, order: 5 }] };
    expect(nextPhaseOf(gapped, 'requirements')?.key).toBe('implementation');
    expect(placeOf(gapped, 'deployment')).toBe(3);
  });
  it('says the last phase and the place label of a subset', () => {
    expect(isLastPhase(six, 'maintenance')).toBe(true);
    expect(isLastPhase(three, 'implementation')).toBe(true);
    expect(isLastPhase(three, 'design')).toBe(false);
    expect(isLastPhase(three, 'testing')).toBe(false);
    expect(placeLabel(three, 'design')).toBe('Phase 2 of 3');
    expect(placeLabel(one, 'testing')).toBe('Phase 1 of 1');
    expect(placeOf(three, 'testing')).toBe(0);
    expect(holdsPhase(three, 'design')).toBe(true);
    expect(holdsPhase(three, 'testing')).toBe(false);
  });
  it('reads a list given out of order, and a stored version numbered 1, 3 and 5, by place', () => {
    const shuffled = { phases: [{ key: 'implementation' as const, order: 3 }, { key: 'requirements' as const, order: 1 }, { key: 'design' as const, order: 2 }] };
    expect(phaseAt(shuffled, 1)?.key).toBe('requirements');
    expect(firstPhaseOf(shuffled)?.key).toBe('requirements');
    expect(nextPhaseOf(shuffled, 'requirements')?.key).toBe('design');
    expect(previousPhaseOf(shuffled, 'implementation')?.key).toBe('design');
    expect(isLastPhase(shuffled, 'implementation')).toBe(true);
    expect(placeLabel(shuffled, 'design')).toBe('Phase 2 of 3');
    expect(phaseSetRefusal(shuffled.phases)).toBeNull();
    const gapped = { phases: [{ key: 'requirements' as const, order: 1 }, { key: 'implementation' as const, order: 3 }, { key: 'deployment' as const, order: 5 }] };
    expect(phaseAt(gapped, 3)?.key).toBe('deployment');
    expect(previousPhaseOf(gapped, 'deployment')?.key).toBe('implementation');
    expect(isLastPhase(gapped, 'deployment')).toBe(true);
    expect(isLastPhase(gapped, 'implementation')).toBe(false);
    expect(placeLabel(gapped, 'implementation')).toBe('Phase 2 of 3');
    expect(phaseSetRefusal(gapped.phases)).toEqual({ fault: 'gapped', sentence: "A project's phases are numbered 1 to 3 in order, and these are numbered 1, 3 and 5." });
    expect(isLastPhase({ phases: [] }, 'design')).toBe(false);
  });
  it('names a phase list as a sentence', () => {
    expect(phaseListSentence(['requirements', 'design', 'implementation'])).toBe('Requirements, Design and Implementation');
    expect(phaseListSentence(['testing'])).toBe('Testing');
  });
});

describe('the subset rule', () => {
  it('accepts all 63 ordered subsets, numbered 1 to n', () => {
    const all = subsets();
    expect(all).toHaveLength(63);
    for (const keys of all) expect(phaseSetRefusal(keys.map((key, at) => ({ key, order: at + 1 })))).toBeNull();
  });
  it('refuses an empty, unknown, duplicated, unordered or gapped set, each with its sentence', () => {
    expect(phaseSetRefusal([])).toEqual({ fault: 'empty', sentence: "A project holds at least one of LearnSDLC's six phases." });
    expect(phaseSetRefusal([{ key: 'review', order: 1 }])).toEqual({ fault: 'unknown', sentence: unknownPhaseRefusal('review') });
    expect(phaseSetRefusal([{ key: 'design', order: 1 }, { key: 'design', order: 2 }])).toEqual({ fault: 'duplicate', sentence: 'A project holds each phase once, and Design is there twice.' });
    expect(phaseSetRefusal([{ key: 'testing', order: 1 }, { key: 'implementation', order: 2 }])).toEqual({ fault: 'unordered', sentence: "A project keeps LearnSDLC's order, and Implementation comes before Testing." });
    expect(phaseSetRefusal([{ key: 'requirements', order: 1 }, { key: 'testing', order: 3 }])).toEqual({ fault: 'gapped', sentence: "A project's phases are numbered 1 to 2 in order, and these are numbered 1 and 3." });
  });
});

describe('the Phases card sentences', () => {
  it('are the fixed sentences, naming the phase', () => {
    expect(keepOnePhaseRefusal('requirements')).toBe('A project keeps at least one phase. Put another phase back before you remove Requirements.');
    expect(addByUploadRefusal('implementation')).toBe('Implementation comes with its files, tests and solution, so it is added by upload. Upload the project again with an implementation folder to add it.');
    expect(addByUploadRefusal('deployment')).toContain('with a deployment folder');
    expect(alreadyHeldRefusal('design')).toBe('Design is already in this project.');
    expect(unknownPhaseRefusal('review')).toBe("review is not one of LearnSDLC's phases. A phase is one of requirements, design, implementation, testing, deployment or maintenance.");
    expect(PHASE_COMPLETION_REFUSAL).toBe('Every phase of this project must be passed before its record can be exported.');
    expect(NO_PHASE_TO_PUBLISH).toBe('This draft holds no phase. Put a phase back or add one before you publish.');
    expect(PUBLISHED_PHASES_FIXED).toBe('A published version does not change. Open a draft to change its phases.');
  });
  it('words Put back by whether the phase is added or uploaded, and whether the draft has a source version', () => {
    // a source version that lacks the phase: the four upload kinds keep the upload sentence
    expect(cannotPutBackRefusal('testing', { hasSource: true })).toBe('Testing cannot be put back: the version this draft was opened from does not hold it. Upload the project again with a testing folder to add it.');
    expect(cannotPutBackRefusal('implementation', { hasSource: true })).toContain('with an implementation folder');
    expect(cannotPutBackRefusal('deployment', { hasSource: true })).toContain('with a deployment folder');
    // Requirements and Design are added from the card, never uploaded
    expect(cannotPutBackRefusal('requirements', { hasSource: true })).toBe('Requirements is not in this draft. Add it from the Phases card.');
    expect(cannotPutBackRefusal('design', { hasSource: true })).toBe('Design is not in this draft. Add it from the Phases card.');
    // a draft with no source version
    expect(cannotPutBackRefusal('design', { hasSource: false })).toBe('This draft was not opened from a version, so Design cannot be put back. Add it from the Phases card.');
    expect(cannotPutBackRefusal('requirements', { hasSource: false })).toBe('This draft was not opened from a version, so Requirements cannot be put back. Add it from the Phases card.');
    expect(cannotPutBackRefusal('testing', { hasSource: false })).toBe('This draft was not opened from a version, so Testing cannot be put back. Upload a project that holds a testing folder.');
    expect(cannotPutBackRefusal('implementation', { hasSource: false })).toBe('This draft was not opened from a version, so Implementation cannot be put back. Upload a project that holds an implementation folder.');
  });
  it('words the Remove confirm by where the phase comes back from', () => {
    expect(removeConfirm('testing', 'held')).toBe('Remove Testing from this project? Its task, its files, its sealed files and its quizzes leave this draft. Published versions keep it.');
    expect(removeConfirm('testing', 'no-source')).toBe('Remove Testing from this project? Its task, its files, its sealed files and its quizzes leave this draft. This draft was not opened from a version, so Testing comes back only by uploading the project again.');
    expect(removeConfirm('requirements', 'no-source')).toBe('Remove Requirements from this project? Its task, its files, its sealed files and its quizzes leave this draft. This draft was not opened from a version, so Requirements comes back only as an empty phase, through Add.');
    expect(removeConfirm('design', 'no-source')).toBe('Remove Design from this project? Its task, its files, its sealed files and its quizzes leave this draft. This draft was not opened from a version, so Design comes back only as an empty phase, through Add.');
    expect(removeConfirm('design', 'not-held')).toBe('Remove Design from this project? Its task, its files, its sealed files and its quizzes leave this draft. The version this draft was opened from does not hold Design, so Design comes back only as an empty phase, through Add.');
    expect(removeConfirm('testing', 'not-held')).toBe('Remove Testing from this project? Its task, its files, its sealed files and its quizzes leave this draft. The version this draft was opened from does not hold Testing, so Testing comes back only by uploading the project again.');
  });
});
