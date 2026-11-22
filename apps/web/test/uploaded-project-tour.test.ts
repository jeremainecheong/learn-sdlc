/**
 * The phase tutorial of a room that is not the reference
 * project's (an uploaded project) names only what the room draws.
 *
 * The tiny uploaded project "Deadline badge" (pack v4) is the example: its
 * Design room draws UML model, Decisions and Review (no API contract, no
 * Screens, no Sequence diagram), and its Implementation room has no Design
 * contracts. The reference project's tour is unchanged by this.
 */
import { describe, expect, it } from 'vitest';
import type { PhaseKey, PhaseProvenanceView } from '@learnsdlc/shared';
import { phaseTutorialMarks } from '@/components/shell/tours';

const APPLICATION: PhaseKey[] = ['implementation', 'testing', 'deployment', 'maintenance'];

/** An uploaded phase's provenance: every element the teacher's own, its room task not the reference's. */
function uploaded(key: PhaseKey): PhaseProvenanceView {
  return {
    phaseKey: key,
    referenceName: null,
    rollup: 'own',
    intro: 'own',
    interview: null,
    files: [],
    tasks: [{ taskKey: 'main', provenance: 'edited', titleEdited: false }],
    roomTask: 'other',
    ...(APPLICATION.includes(key) ? { application: null } : {}),
  } as PhaseProvenanceView;
}

/** The reference project's provenance. */
function reference(key: PhaseKey): PhaseProvenanceView {
  return {
    phaseKey: key,
    referenceName: 'TaskTrackr',
    rollup: 'reference',
    intro: 'reference',
    interview: null,
    files: [],
    tasks: [{ taskKey: 'main', provenance: 'reference', titleEdited: false }],
    roomTask: 'reference',
    ...(APPLICATION.includes(key) ? { application: 'TaskTrackr' } : {}),
  } as PhaseProvenanceView;
}

describe("the phase tutorial's steps", () => {
  const none = { contracts: { api: false, screens: false }, sequence: false };

  it('names only the tabs an uploaded Design room draws, each at its own place', () => {
    const marks = phaseTutorialMarks('design', false, uploaded('design'), none);
    expect(marks.map((mark) => mark.target)).toEqual([
      'design-tutorial-model',
      'design-tutorial-decisions',
      'design-tutorial-review',
      'design-tutorial-help',
    ]);
    expect(marks.map((mark) => `${mark.title} ${mark.body}`).join(' ')).not.toMatch(/API contract|[Ss]equence|contracts/);
    expect(marks[1].selector).toBe('[aria-label="Design working area"] > :nth-child(2)');
    expect(marks[2].fallbackSelector).toBe('[aria-label="Design working area"] > :nth-child(3), .phase-room-nav');
  });

  it('keeps a switched-on tab its step, after the tabs before it', () => {
    const marks = phaseTutorialMarks('design', false, uploaded('design'), { contracts: { api: true, screens: true }, sequence: true });
    expect(marks.map((mark) => mark.target)).toEqual([
      'design-tutorial-model',
      'design-tutorial-contracts',
      'design-tutorial-sequence',
      'design-tutorial-decisions',
      'design-tutorial-review',
      'design-tutorial-help',
    ]);
    expect(marks[1].selector).toBe('[aria-label="Design working area"] > :nth-child(2)');
    // Screens (3) sits between the contract and the sequence diagram.
    expect(marks[2].selector).toBe('[aria-label="Design working area"] > :nth-child(4)');
    expect(marks[3].selector).toBe('[aria-label="Design working area"] > :nth-child(5)');
  });

  it('names no contract in a Sequence step where the API contract is off', () => {
    const marks = phaseTutorialMarks('design', false, uploaded('design'), { contracts: { api: false, screens: false }, sequence: true });
    expect(marks.map((mark) => `${mark.title} ${mark.body}`).join(' ')).not.toMatch(/contract/i);
    const sequence = marks.find((mark) => mark.target === 'design-tutorial-sequence');
    expect(sequence?.selector).toBe('[aria-label="Design working area"] > :nth-child(2)');
    expect(sequence?.body).toBe('Open Sequence diagram to describe how the parts interact. Check that the messages match your model.');
  });

  it("names the brief, not contracts, in an uploaded Implementation room's first step", () => {
    const marks = phaseTutorialMarks('implementation', false, uploaded('implementation'));
    expect(marks[0].title).toBe('Work in the editable files');
    expect(`${marks[0].title} ${marks[0].body}`).not.toMatch(/contract/i);
  });

  it("keeps the reference project's tour exactly, and a payload that does not say", () => {
    const standing = phaseTutorialMarks('design', false);
    expect(phaseTutorialMarks('design', false, reference('design'), none)).toEqual(standing);
    expect(phaseTutorialMarks('design', false, { application: undefined } as never, none)).toEqual(standing);
    expect(standing.map((mark) => mark.title)).toEqual([
      'Start with the UML model',
      'Define the API contracts',
      'Trace a sequence',
      'Explain your design decisions',
      'Review the design as a whole',
      'Return whenever you need help',
    ]);
    expect(phaseTutorialMarks('implementation', false, reference('implementation'))[0].title).toBe('Implement the agreed contracts');
  });
});
