/** The study guides' own word list. Kept apart from `lib/glossary.ts`,
 * which the user guide and the account Help page mirror by hand: these words
 * belong to the guides only. The reader marks one term per chapter, at its
 * first use in "The idea". `forms` are the spellings matched in the text
 * (a plural "s" is matched too); the first form is the entry's own word. */
export interface LessonTermEntry {
  word: string;
  meaning: string;
  forms: string[];
}

export const LESSON_TERMS = {
  'acceptance-criterion': { word: 'Acceptance criterion', meaning: 'A condition a story must meet, written so a test can show whether it holds: a starting situation, an action and a result you can observe.', forms: ['acceptance criterion', 'acceptance criteria'] },
  epic: { word: 'Epic', meaning: 'A larger outcome for users that several stories deliver together.', forms: ['epic'] },
  cardinality: { word: 'Cardinality', meaning: 'How many of one thing can relate to another. For example, one list holds zero or more tasks.', forms: ['cardinality'] },
  contract: { word: 'Contract', meaning: 'The agreed shape of a request and its response (method, path, inputs, status codes and errors), so both sides can build against it.', forms: ['contract'] },
  'pure-function': { word: 'Pure function', meaning: 'A function whose result depends only on its inputs and which changes nothing outside itself, so a test can call it directly.', forms: ['pure function'] },
  fixture: { word: 'Fixture', meaning: 'The prepared starting state a test runs from, such as a fresh database holding known rows.', forms: ['fixture'] },
  mutant: { word: 'Mutant', meaning: 'A copy of the code with one small bug planted on purpose, used to see whether your tests notice it.', forms: ['mutant'] },
  killed: { word: 'Killed', meaning: 'A mutant is killed when at least one test fails against it: your suite noticed the planted bug.', forms: ['killed'] },
  survived: { word: 'Survived', meaning: 'A mutant survives when every test still passes against it: your suite cannot tell it from the real code.', forms: ['survived', 'surviving'] },
  'equivalent-mutant': { word: 'Equivalent mutant', meaning: 'A mutant whose change no user or test can observe, so no test can kill it. Explain it rather than chase it.', forms: ['equivalent mutant'] },
  image: { word: 'Image', meaning: 'A packaged build of the application and what it needs to run. A container starts from an image.', forms: ['image'] },
  container: { word: 'Container', meaning: 'A running instance of an image. Anything written inside it, and not on a volume, goes when the container is removed.', forms: ['container'] },
  volume: { word: 'Volume', meaning: 'Storage kept outside a container, so its data survives when the container is removed or rebuilt.', forms: ['volume'] },
  'health-check': { word: 'Health check', meaning: 'A repeated probe that says whether a service answers. Passing it does not prove that a user’s path works.', forms: ['health check', 'healthcheck'] },
  readiness: { word: 'Readiness', meaning: 'Whether a service can take requests now, not only whether its process is running.', forms: ['readiness'] },
  rollback: { word: 'Rollback', meaning: 'Going back to the last release that worked while you find the fault.', forms: ['rollback', 'roll back'] },
  runbook: { word: 'Runbook', meaning: 'Written steps another person can follow to diagnose and fix a known kind of incident.', forms: ['runbook'] },
  regression: { word: 'Regression', meaning: 'Something that used to work and stopped working after a change.', forms: ['regression'] },
  'impact-analysis': { word: 'Impact analysis', meaning: 'Finding every part of the system a change touches before you make the change.', forms: ['impact analysis'] },
  diff: { word: 'Diff', meaning: 'The lines a change adds and removes, shown together for review.', forms: ['diff'] },
} satisfies Record<string, LessonTermEntry>;

export type LessonTermKey = keyof typeof LESSON_TERMS;

const escape = (text: string) => text.replace(/[.*+?^${}()[\]\\]/g, '\\$&');

/** The first place a term's form appears in `text`: whole words, any case,
 * an optional plural "s". */
export function findTerm(text: string, key: LessonTermKey): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const form of LESSON_TERMS[key].forms) {
    const match = new RegExp(`\\b${escape(form)}s?\\b`, 'i').exec(text);
    if (match && (!best || match.index < best.index)) best = { index: match.index, length: match[0].length };
  }
  return best;
}
