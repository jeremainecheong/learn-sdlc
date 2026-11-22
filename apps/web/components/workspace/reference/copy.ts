/**
 * The reference project's (TaskTrackr's) own words in the learner's rooms:
 * placeholders, headings and sentences a room shows in place of its neutral
 * wording when the phase is the reference project's. Each room still holds its
 * neutral wording, and chooses between the two where it draws them.
 */
export const REFERENCE_COPY = {
  /** The backlog and its story form (Requirements). */
  requirements: {
    storyListNote: 'US-4 is your story to define.',
    createStory: 'Create US-4 story',
    refineStory: 'Refine US-4',
    storyTitle: 'Specify the overdue report',
    storyId: 'Story: US-4',
    storyPurpose: 'The overdue report you are defining for TaskTrackr.',
    evidenceTip: 'Keep US-4 connected to the customer’s evidence. The approved stories define the work around it.',
    providedStory: 'This approved story supplies the surrounding TaskTrackr behavior. Write US-4 so it agrees with these requirements.',
    titlePlaceholder: 'Overdue report',
    personaPlaceholder: 'person who runs tasktrackr every morning',
    capabilityPlaceholder: 'a report of the tasks that are overdue',
    benefitPlaceholder: 'I catch what I missed before the day starts',
    scopePlaceholder: 'reminders and notifications',
    givenPlaceholder: 'a task due yesterday',
    whenPlaceholder: 'I run the overdue report',
    thenPlaceholder: 'the task is listed',
    interviewBrief: 'Ask about the missing overdue report, collect examples, then turn the answers into US-4 and its acceptance criteria.',
  },
  /** The commit message field (the code rooms). */
  commitPlaceholder: 'Fix the overdue boundary so due today is not overdue',
  /** What the incident drill runs against (Deployment). */
  drillTarget: 'Compose configuration',
} as const;
