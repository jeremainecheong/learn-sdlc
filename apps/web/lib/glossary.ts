/**
 * The ten words this product uses that a second-year student has not met yet.
 *
 * One list, read by two things: the `Term` popover that marks a word's first
 * use on a page, and the 'Words used here' section of docs/user-guide.md,
 * which carries the same ten entries by hand. A definition is one or two plain
 * sentences in the product's voice: what the thing is here, not what a
 * textbook says about it. No entry names a vendor, a model or a course.
 */
export type GlossaryKey =
  | 'gate'
  | 'process marks'
  | 'dossier'
  | 'artefacts'
  | 'kill matrix'
  | 'mutant'
  | 'runbook'
  | 'ledger'
  | 'pull request'
  | 'contract';

export interface GlossaryEntry {
  key: GlossaryKey;
  /** The word as it is written in prose, for a heading or a list. */
  word: string;
  /** What it means here. Two sentences at most. */
  meaning: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    key: 'gate',
    word: 'Gate',
    meaning:
      'The score a phase needs before the next one opens: 70 out of 100. Nothing is timed, and you can submit as often as you like until you clear it.',
  },
  {
    key: 'process marks',
    word: 'Process marks',
    meaning:
      'The part of your score that is about how you worked, not what you made: whether you ran the tests before submitting and how much you leaned on the reviewer. Questions to the reviewer count against it after the first ten.',
  },
  {
    key: 'dossier',
    word: 'Dossier',
    meaning:
      'Your whole project bound as one document, phase by phase, ready to read on screen or print. It is built from what you wrote, so it fills in as you go.',
  },
  {
    key: 'artefacts',
    word: 'Artefacts',
    meaning:
      'The things you make in a phase: a user story, a design, code, tests, a runbook. Everything you write here is kept, and it is yours to take with you.',
  },
  {
    key: 'kill matrix',
    word: 'Kill matrix',
    meaning:
      'A grid of your tests against copies of the application with one bug planted in each. A cell is green when a test fails on the broken copy, which is what a good test is for.',
  },
  {
    key: 'mutant',
    word: 'Mutant',
    meaning:
      'One copy of the application with one deliberate bug in it. Your tests kill a mutant when at least one of them fails against it; a mutant that survives found a gap in your suite.',
  },
  {
    key: 'runbook',
    word: 'Runbook',
    meaning:
      'The written steps for running the system: how to start it, check it, roll it back and recover it. It is what the person on call reads at two in the morning.',
  },
  {
    key: 'ledger',
    word: 'Ledger',
    meaning:
      'A table of what your design promised against what your code did, one row per claim. Where the two disagree, one of them needs to change, and the ledger says which row.',
  },
  {
    key: 'pull request',
    word: 'Pull request',
    meaning:
      'Your work packaged for review: the changes, the checks that ran on them and the conversation about them. Every submission from phase 3 onwards opens or updates one.',
  },
  {
    key: 'contract',
    word: 'Contract',
    meaning:
      'The agreed shape of a request and its reply between the front end and the API: which fields go in, what comes back, and which errors are possible. You write it in design and the later phases hold you to it.',
  },
];

export function glossaryEntry(key: GlossaryKey): GlossaryEntry {
  const entry = GLOSSARY.find((e) => e.key === key);
  if (!entry) throw new Error(`No glossary entry for ${key}`);
  return entry;
}
