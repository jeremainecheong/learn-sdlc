import type { PhaseKey } from '@learnsdlc/shared';

/**
 * What differs between the six study guides' first screens. Every guide
 * draws the same navy banner, the same "Your phase brief" heading and the same
 * row of chapter cards (`LessonReader.tsx`); the words and the picture come
 * from here. The catalogue's card for each guide (`app/(app)/learn/page.tsx`)
 * reads `GUIDE_CARD`.
 *
 * A lead says first what the phase is for, then what the learner makes in
 * LearnSDLC in that phase. The second sentence is checked against the
 * phase's brief in `content/tasktrackr/phases/<nn>-<phase>/phase.json`
 * (intro, objectives, taskPanel) and `PHASE_MAKES` in `phase-map.ts`, so it
 * names only what the learner really makes there.
 */
export interface GuideHero {
  /** The small line above the headline. */
  eyebrow: string;
  /** The headline, drawn as two lines. */
  headline: [string, string];
  /** One or two sentences under the headline. */
  lead: string;
  /** The 3D picture at the banner's right, drawn in one 4:3 box for all six
   * (`lessons.css`). `scale` grows a picture whose drawing fills less of its
   * file than Requirements' does, so that every guide's art has the same
   * visual weight (see ART_WEIGHT below); left out, it is 1. */
  art: {
    src: string; alt: string; width: number; height: number; scale?: number;
    /** The drawing reaches its file's top and bottom (Implementation's
     * workbench), so its scale grows it past the box's height into the
     * banner's padding. Where the banner stacks (a phone), the picture
     * keeps the top edge an unscaled one has, under the buttons, and grows
     * downward: that banner is a few pixels taller instead (lessons.css). */
    fillsHeight?: true;
  };
  /** The caption over the guide's path, drawn once under the banner. */
  path: string;
}

export const GUIDE_HERO: Record<PhaseKey, GuideHero> = {
  requirements: {
    eyebrow: 'Start with understanding',
    headline: ['Great software starts', 'with a better question.'],
    lead: 'Find the problem worth solving, then turn it into work a team can act on. Write a user story, define its acceptance criteria, and link it to an epic if you add one, in a guided Jira-style backlog.',
    art: { src: '/artwork/requirements-lesson-compact.webp', alt: 'A learner gathering ideas around a glass and paper pinboard', width: 365, height: 274 },
    path: 'The learning and evidence path',
  },
  design: {
    eyebrow: 'Agree before you build',
    headline: ['Good design makes', 'the pieces agree.'],
    lead: 'Decide what the screen, the API and the database promise each other before anyone writes code. Complete the UML model and the API contract, specify the overdue screen, and record a decision with its trade-off.',
    art: { src: '/artwork/dashboard-design-3d.webp', alt: 'A blueprint with a small diagram of linked blocks, a set square and a pencil', width: 640, height: 640, scale: 1.24 },
    path: 'The learning and evidence path',
  },
  implementation: {
    eyebrow: 'Build in small steps',
    headline: ['Good code fits', 'the code around it.'],
    lead: 'Make the design’s promises true inside an application that already runs. Fill the five marked gaps, three in the Python API and two in the TypeScript front end, then run the checks and watch the app work.',
    art: { src: '/artwork/implementation-workbench-3d.webp', alt: 'A developer fitting blocks together at a workbench', width: 512, height: 512, scale: 1.15, fillsHeight: true },
    path: 'The learning and evidence path',
  },
  testing: {
    eyebrow: 'Prove what you claim',
    headline: ['A passing test proves', 'only what it checks.'],
    lead: 'Show that each acceptance criterion holds, with tests that fail when the behaviour is wrong. Write the API and front-end acceptance suites, and on submit they run against eight planted broken copies of TaskTrackr.',
    art: { src: '/artwork/dashboard-testing-3d.webp', alt: 'A checklist shield under a magnifying glass, with a bug beside it', width: 640, height: 640, scale: 1.31 },
    path: 'The learning and evidence path',
  },
  deployment: {
    eyebrow: 'Ship what you can diagnose',
    headline: ['It runs on your machine.', 'Now make it run anywhere.'],
    lead: 'Package the application so another person can start it, check it and recover it. Finish the API Dockerfile, the Compose file and the CI workflow, write the runbook, and close the incident drill.',
    art: { src: '/artwork/dashboard-deployment-3d.webp', alt: 'A rocket lifting off a glass launch pad', width: 640, height: 640, scale: 1.1 },
    path: 'The learning and evidence path',
  },
  maintenance: {
    eyebrow: 'Change without breaking',
    headline: ['Change the product.', 'Keep every promise.'],
    lead: 'Add what people ask for without breaking what they already rely on. Ship change request CR-2, comments on a task and the count on its row, and keep the regression suite green.',
    art: { src: '/artwork/dashboard-maintenance-3d.webp', alt: 'A wrench across a gear, with an update arrow beside it', width: 640, height: 640, scale: 1.27 },
    path: 'The learning and evidence path',
  },
};

/*
 * ART_WEIGHT: how each banner picture's `scale` was chosen.
 * Requirements' picture is a 4:3 file drawn edge to edge in the 4:3 box; the
 * other five are square files, contained in the same box at its height, and
 * their drawings fill less of the file, so they read at about 60 percent of
 * Requirements' weight. The box round each drawing's opaque pixels (alpha
 * over 24), as fractions of its file, left, top, right, bottom:
 *   requirements-lesson-compact  0.07 0.10 0.99 0.91 (4:3)
 *   dashboard-design-3d          0.04 0.15 0.96 0.84
 *   implementation-workbench-3d  0.13 0.01 0.93 0.99
 *   dashboard-testing-3d         0.13 0.16 0.83 0.86
 *   dashboard-deployment-3d      0.22 0.07 0.82 0.92
 *   dashboard-maintenance-3d     0.14 0.13 0.88 0.82
 * A square drawn at `scale` times the box height covers as much of the box
 * as Requirements' drawing does at 1.25 (design), 1.13 (implementation),
 * 1.42 (testing), 1.39 (deployment) and 1.38 (maintenance); each scale is
 * that, lowered until the drawing stays inside the 4:3 box with 2.5 percent
 * to spare, and rounded down: design 1.24, testing 1.31, deployment 1.1
 * (the rocket is tall), maintenance 1.27. So none of those is stretched,
 * cropped or drawn outside its box, and none grows the banner.
 *
 * Implementation is the exception. Its workbench reaches
 * the file's top and bottom, so inside the 4:3 box it could grow 2 percent
 * and stayed at 1, the smallest picture of the six (273.8 px at 1440 against
 * 339 to 359). It is 1.15, the measured 1.13 rounded up, and draws past the
 * box's height into the banner's padding: at 1440 (drawn 314.8 px square)
 * the drawing keeps about 12 px of the banner clear above it and 18 px
 * below; at 1024 it draws 146.6 px in a banner much taller than it. Where
 * the banner stacks (390: drawn 206.6 px), `fillsHeight` keeps the top edge
 * under the buttons where the unscaled picture had it and lets the banner
 * grow by the 13.5 px it adds, with about 8 px of the bottom padding clear.
 * It is never stretched or cropped.
 */

/**
 * Each guide's card in the catalogue: the promise line, the topics its four
 * chapters teach (in the chapters' own words, at most four), and a third meta
 * item only where it is true of that guide.
 */
export interface GuideCard {
  promise: string;
  topics: string[];
  extra?: string;
}

export const GUIDE_CARD: Record<PhaseKey, GuideCard> = {
  requirements: {
    promise: 'Turn a real need into work your team can understand.',
    topics: ['Stakeholder questions', 'Epics and user stories', 'Acceptance criteria', 'Jira’s Parent field'],
    extra: 'Jira field guide',
  },
  design: {
    promise: 'Shape a contract the screen and the API can both build against.',
    topics: ['Begin with the consumer', 'Model cardinality', 'Trace a request in order', 'Defend a decision'],
  },
  implementation: {
    promise: 'Turn the contract into working code, one observable change at a time.',
    topics: ['Read the neighbourhood', 'Data separate from structure', 'Honest request states', 'Evidence before review'],
  },
  testing: {
    promise: 'Write tests that make a wrong implementation fail.',
    topics: ['Choose the right level', 'Isolate the claim', 'The screen and the clock', 'Read the mutation result'],
  },
  deployment: {
    promise: 'Ship a system you can diagnose, and recover it without losing data.',
    topics: ['What survives a restart', 'A pipeline as evidence', 'Localhost from the caller', 'A runbook others can use'],
  },
  maintenance: {
    promise: 'Add a capability to working software without breaking what it does.',
    topics: ['The change boundary', 'One row per task', 'Review the diff', 'Regression and release'],
  },
};
