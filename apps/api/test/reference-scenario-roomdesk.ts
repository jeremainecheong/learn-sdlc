import type { InterviewBody } from '@learnsdlc/shared';

/**
 * A teacher's own scenario for a copy of the reference project: RoomDesk, a
 * meeting-room booking service. Every word here is chosen to
 * share none with the reference project's story (no task list, no lateness,
 * no reference stakeholder) so any reference term in a payload or a request
 * built from a RoomDesk copy came from an element provenance still marks as
 * the reference's, never from the teacher.
 *
 * Shared by `src/authoring/scenario-authoring.spec.ts` and the mounted journey
 * `test/copy-becomes-own.e2e-spec.ts`.
 */

export const ROOMDESK_TITLE = 'RoomDesk — book a meeting room';

export const ROOMDESK_REQUIREMENTS_INTRO =
  'RoomDesk lets staff book a meeting room for a slot. In this phase you interview the facilities manager and write the one story the backlog is missing.';

export const ROOMDESK_DESIGN_INTRO =
  'Design how RoomDesk reserves a room: the booking record, the reserve operation and what it refuses.';

/** Priya Nair, facilities manager, and six facts. `answer`s are sealed: they never ride the draft. */
export const ROOMDESK_INTERVIEW: InterviewBody = {
  persona: { name: 'Priya Nair', role: 'Facilities manager' },
  opening: 'Hi, I run the meeting rooms on all four floors. What would you like to know about booking them?',
  unknownReply: 'That is not something I track, so I cannot say.',
  refusal: 'I would rather you wrote the story yourself; I can tell you how the rooms work.',
  maxTurns: 10,
  factsExpected: 3,
  facts: [
    { id: 'slot-length', topic: 'How long a booking lasts', keywords: ['slot', 'length', 'long', 'minutes'], answer: 'A booking is a slot of 30 or 60 minutes; nothing else is offered.' },
    { id: 'double-book', topic: 'Two people booking the same slot', keywords: ['same', 'double', 'clash', 'taken'], answer: 'The second person is told the slot is taken and offered the next free slot in that room.' },
    { id: 'cancel', topic: 'Cancelling a booking', keywords: ['cancel', 'release', 'free up'], answer: 'Whoever booked can cancel up to five minutes before the slot starts.' },
    { id: 'capacity', topic: 'Room size', keywords: ['size', 'capacity', 'people', 'seats'], answer: 'Each room shows its seat count; a booking for more people than seats is refused.' },
    { id: 'hours', topic: 'Opening hours', keywords: ['hours', 'open', 'weekend', 'evening'], answer: 'Rooms can be booked from 08:00 to 19:00 on weekdays only.' },
    { id: 'who', topic: 'Who may book', keywords: ['who', 'staff', 'visitor', 'guest'], answer: 'Any member of staff may book; visitors cannot book for themselves.' },
  ],
};

/** The RoomDesk backlog: US-1 to US-3 written, US-4 marked missing (the inherited story keeps that record id). */
export const ROOMDESK_BACKLOG = [
  '# RoomDesk product backlog (approved)',
  '',
  'Stories are numbered US-n and their acceptance criteria US-n/AC-m.',
  '',
  '## US-1 — Book a room for a slot *(approved)*',
  '',
  'As a member of staff, I want to book a room for a slot, so that my meeting has a place.',
  '',
  '## US-2 — See which rooms are free *(approved)*',
  '',
  'As a member of staff, I want to see the free rooms for a slot, so that I can pick one.',
  '',
  '## US-3 — Cancel a booking *(approved)*',
  '',
  'As a member of staff, I want to cancel my booking, so that the room is free for others.',
  '',
  '## US-4 — Book when the slot is taken *(missing, the story you write)*',
  '',
].join('\n');

/**
 * The RoomDesk story block for the inherited Requirements story task: the
 * backlog's three approved stories, the learner's US-4, and a floor that asks
 * for a happy path and a refusal (a taken slot).
 */
export const ROOMDESK_STORY = {
  providedStories: [
    {
      id: 'US-1', title: 'Book a room for a slot', persona: 'member of staff', capability: 'to book a room for a slot', benefit: 'my meeting has a place',
      criteria: [{ id: 'AC-1', given: 'a free room and slot', when: 'I book it', then: 'the booking is mine', tag: 'happy' as const }],
    },
    {
      id: 'US-2', title: 'See which rooms are free', persona: 'member of staff', capability: 'to see the free rooms for a slot', benefit: 'I can pick one',
      criteria: [{ id: 'AC-1', given: 'two rooms, one booked', when: 'I ask for the slot', then: 'only the free room is listed', tag: 'happy' as const }],
    },
    {
      id: 'US-3', title: 'Cancel a booking', persona: 'member of staff', capability: 'to cancel my booking', benefit: 'the room is free for others',
      criteria: [{ id: 'AC-1', given: 'a booking of someone else', when: 'I cancel it', then: 'the cancel is refused', tag: 'error' as const }],
    },
  ],
  learnerStory: { id: 'US-4', hints: { persona: 'member of staff' } },
  floor: { minCriteria: 2, requiredTags: ['happy' as const, 'error' as const], minExclusions: 1, requireSentence: true },
};

export const ROOMDESK_ARCHITECTURE = [
  '# RoomDesk architecture',
  '',
  'One service owns bookings. A booking is a room, a slot and the member of staff who holds it.',
  'The reserve operation either holds the slot or refuses it as taken.',
  '',
].join('\n');

/** The pattern every reference-scenario leak check greps for. */
export const REFERENCE_WORDS = /tasktrackr|overdue|dana|osei/i;
