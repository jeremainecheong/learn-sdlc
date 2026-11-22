import { PHASE_ORDER, type PhaseKey } from '@learnsdlc/shared';

/**
 * Twenty-five synthetic learners and the whole of what they did, computed
 * before anything is written.
 *
 * The plan is pure and seeded, which is what makes the seeded class worth
 * looking at twice: who is stuck, who leaned on the mentor, which acceptance
 * cases each learner left out and on which lab day are all decided here and
 * are byte-identical between runs. Only the absolute dates move, because the
 * schedule is measured backwards from whatever "today" is: a class seeded in
 * March and a class seeded in September both read as week seven.
 *
 * Nothing here talks to the API. `scripts/seed-class/replay.mjs` is what turns
 * a plan into rows, and it does it through the public routes a learner uses,
 * so every row the seed makes is a row the product already makes.
 */

/** The class the seed creates and the domain its learners live on. */
export const CLASS_NAME = 'Section 1';
export const CLASS_EMAIL_DOMAIN = 'class.learnsdlc.test';
/** Printed once at the end of a run, the way scripts/start.sh prints the staff passwords. */
export const CLASS_PASSWORD = 'Password1!';

/** Lab days the term spans. Day 0 is the first lab; TERM_DAYS is "today". */
export const TERM_DAYS = 35;

/** The queue signal a persona is built to raise, or null for a quiet learner. */
export type PersonaSignal =
  | 'integrity-paste'
  | 'integrity-reliance'
  | 'stuck'
  | 'no-run'
  | 'idle';

/** One graded attempt: what was in the workspace, and how it was made. */
export interface AttemptPlan {
  /** Lab day of the term, 0-based. */
  day: number;
  /** Which artefact `scripts/seed-class/artefacts.mjs` should write. */
  variant: string;
  /** Mentor questions asked before this attempt. */
  hints: number;
  /** Whether the learner pressed Run first. Never true on a phase that cannot run. */
  ran: boolean;
  /**
   * Paste the mentor's own last reply into the editable artefact: the
   * `mentorPasteFlag` in `feedback.service.ts`, earned the way a learner earns
   * it rather than written into a column.
   */
  pasteMentorReply: boolean;
}

export interface PhasePlan {
  order: number;
  key: PhaseKey;
  /** True when the pack lets this phase run; markdown phases have no Run. */
  runnable: boolean;
  attempts: AttemptPlan[];
  /** Whether the learner merged this phase and moved on. */
  advanced: boolean;
  /** The incident drill, on the deployment phase only: worked by every learner dealt the full deployment. */
  drill: boolean;
  reflection: string;
}

export interface PersonaPlan {
  /** 1-based position in the roll, and the order the seeder replays them in. */
  index: number;
  displayName: string;
  email: string;
  /** The phase they are sitting in when the seed stops; 6 with `completed` means finished. */
  stopOrder: number;
  completed: boolean;
  /** Lab day of their last action. `TERM_DAYS - lastActiveDay` is how idle they look. */
  lastActiveDay: number;
  signals: PersonaSignal[];
  phases: PhasePlan[];
  /** The one-line progress the seeder prints for this learner. */
  summary: string;
}

export interface ClassPlan {
  seed: number;
  className: string;
  termDays: number;
  password: string;
  personas: PersonaPlan[];
}

/* ------------------------------ the roll -------------------------------- */

/**
 * A fixed roll, so a name is never generated and never collides. The seed
 * shuffles which track each name walks, so two seeds put different people in
 * the queue while the class always has the same shape.
 */
const ROLL: string[] = [
  'Aisyah Rahman',
  'Marcus Tan',
  'Priya Nair',
  'Wei Jie Ong',
  'Nurul Huda',
  'Daniel Chua',
  'Farhan Ismail',
  'Rachel Goh',
  'Kavitha Menon',
  'Jun Hao Sim',
  'Siti Aminah',
  'Bryan Koh',
  'Ling Ling Wong',
  'Ravi Subramaniam',
  'Chloe Lim',
  'Haziq Osman',
  'Mei Ling Chan',
  'Arjun Pillai',
  'Samuel Ng',
  'Yee Ling Toh',
  'Iskandar Yusof',
  'Grace Teo',
  'Nabil Hassan',
  'Xin Yi Foo',
  'Zhi Hao Lee',
];

/** The six phases in their order, the platform's own list. */
export const PHASE_KEYS: readonly PhaseKey[] = PHASE_ORDER;

/** Phases the pack can run. Markdown artefacts have no Run button and no run row. */
const RUNNABLE: ReadonlySet<PhaseKey> = new Set<PhaseKey>([
  'implementation',
  'testing',
  'deployment',
  'maintenance',
]);

/* ------------------------------- the tracks ------------------------------ */

/**
 * How the phase a learner is sitting in ends. It is the whole difference
 * between a class that reads as a term and a staircase of green ticks, and it
 * has to be said out loud because the console's rules are unforgiving about
 * it: a phase whose latest attempt passed reads as `passed` for ever (the
 * status is sticky, `checkers.ts`, nextPhaseStatus), and any two failing
 * attempts under the gate make that learner "stuck" whether the plan meant it
 * or not (`analytics.service.ts`, STUCK_ATTEMPTS).
 */
type CurrentShape =
  /** Two or three attempts, all under the gate. The queue's priority-1 signal. */
  | 'stuck'
  /** One attempt, under the gate. Still working, and not stuck yet. */
  | 'one-try'
  /** Two attempts, the second over the gate: passed, not merged. */
  | 'nearly'
  /** The gate behind them opened and they have not started. `in_progress`. */
  | 'just-unlocked';

interface Track {
  /** Phase order the learner is sitting in, 1-6. */
  stopOrder: number;
  completed: boolean;
  current: CurrentShape;
  signals: PersonaSignal[];
  /** Lab days of silence at the end of the term. */
  idleDays: number;
}

const q = (
  stopOrder: number,
  current: CurrentShape,
  signals: PersonaSignal[] = [],
  idleDays = 0,
): Track => ({ stopOrder, completed: false, current, signals, idleDays });

/**
 * The class's shape, written down rather than drawn from the generator: the
 * phase strip has to be a spread rather than a staircase, and the queue has to
 * hold one of each kind of trouble. A shuffled fixed list guarantees both for
 * every seed, which a per-learner dice roll would not.
 */
const TRACKS: Track[] = [
  // Three have finished the project. An enrolment marked complete is out of
  // the console's idle branch by construction, so their last day is free.
  { stopOrder: 6, completed: true, current: 'one-try', signals: [], idleDays: 2 },
  { stopOrder: 6, completed: true, current: 'one-try', signals: [], idleDays: 4 },
  { stopOrder: 6, completed: true, current: 'one-try', signals: ['integrity-paste'], idleDays: 1 },
  // Five are in maintenance. The quiet days below IDLE_DAYS are what stops the
  // class reading as if everybody worked this morning.
  q(6, 'one-try', [], 1),
  q(6, 'just-unlocked', [], 3),
  q(6, 'one-try', ['integrity-reliance']),
  q(6, 'one-try', [], 2),
  q(6, 'one-try', ['no-run'], 1),
  // Four are in deployment.
  q(5, 'nearly', [], 2),
  q(5, 'one-try'),
  q(5, 'stuck', ['stuck'], 3),
  q(5, 'one-try', [], 5),
  // Five are in testing.
  q(4, 'one-try', [], 1),
  q(4, 'just-unlocked', [], 4),
  q(4, 'stuck', ['stuck'], 2),
  q(4, 'one-try', ['no-run']),
  q(4, 'one-try', [], 3),
  // Four are in implementation.
  q(3, 'one-try', [], 2),
  q(3, 'one-try'),
  // Stuck and quiet: the queue ranks the gate above the silence, which is why
  // two learners are idle and only one of them says so.
  q(3, 'stuck', ['stuck', 'idle'], 12),
  q(3, 'one-try', [], 5),
  // Two are in design, two still in requirements.
  q(2, 'nearly', [], 1),
  q(2, 'one-try', [], 4),
  q(1, 'one-try', [], 3),
  q(1, 'one-try', ['idle'], 9),
];

/* ------------------------------- artefacts ------------------------------- */

/**
 * The eight cases the pack's own reference suites ship one per planted bug, and
 * the mutant each one kills: six in the API suite and two in the front-end
 * one, because the kill matrix spans both layers now. The seeder reads the
 * cases out of `content/tasktrackr/phases/04-testing/reference/` rather than
 * carrying a copy, so a learner's suite is always a subset of the pack's own;
 * this list only says which subset. A front-end case is addressed by a slug of
 * its title, because its title has commas in it and the variant string does not.
 */
export const TEST_METHOD_KILLS: { method: string; mutant: string; run: 'api' | 'web' }[] = [
  { method: 'test_the_completion_is_still_there_on_the_next_request', mutant: 'complete_does_not_persist', run: 'api' },
  { method: 'test_completing_a_task_that_does_not_exist_is_a_404', mutant: 'complete_unknown_returns_200', run: 'api' },
  { method: 'test_a_keyword_matches_whatever_the_case', mutant: 'filter_keyword_case_sensitive', run: 'api' },
  { method: 'test_tasks_come_back_highest_priority_first', mutant: 'priority_order_reversed', run: 'api' },
  { method: 'test_a_task_due_today_is_not_overdue_yet', mutant: 'overdue_includes_due_today', run: 'api' },
  { method: 'test_a_task_finished_late_is_not_reported_as_overdue', mutant: 'overdue_includes_done', run: 'api' },
  { method: 'web:a-task-finished-after-its-due-date-carries-no-marker', mutant: 'badge_ignores_completion', run: 'web' },
  { method: 'web:the-keyword-still-reaches-the-api-when-a-status-is-set-as-well', mutant: 'filters_drop_the_search', run: 'web' },
];

/**
 * How many of the eight planted bugs each learner kills on their first testing
 * submission, in the order the tracks are dealt.
 *
 * Sixteen learners make a first testing submission, everyone at phase 4 or
 * beyond except the one who has just unlocked it, and the median of this list
 * is exactly 4 of the eight: the kill matrix is the phase's headline number,
 * and a class where everybody scores the same teaches nobody anything. The learner who is
 * stuck in testing hands in a pinned pair instead, which cannot move the
 * median: their deck card is still dealt, and there are five fours in the
 * middle of it.
 */
const FIRST_TESTING_KILLS = [2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 6, 7, 8, 8];

/**
 * One list per `coverageKeywords` group in phase.json, holding the killer cases
 * whose own source carries that group's keyword. Measured rather than guessed:
 * the grader matches a keyword against the whole submitted source, so the API
 * suite's preamble already carries `complete` and `overdue` and only `filter`
 * and `badge` need a case of their own. Listing all four keeps the model
 * conservative: it can only ever under-predict coverage, which is the safe
 * direction for a plan that promises a learner opened a gate.
 */
const COVERAGE_GROUPS: string[][] = [
  // complete
  [
    'test_the_completion_is_still_there_on_the_next_request',
    'test_completing_a_task_that_does_not_exist_is_a_404',
    'test_a_task_finished_late_is_not_reported_as_overdue',
  ],
  // filter
  [
    'test_completing_a_task_that_does_not_exist_is_a_404',
    'web:the-keyword-still-reaches-the-api-when-a-status-is-set-as-well',
  ],
  // overdue
  [
    'test_a_task_due_today_is_not_overdue_yet',
    'test_a_task_finished_late_is_not_reported_as_overdue',
  ],
  // badge
  ['web:a-task-finished-after-its-due-date-carries-no-marker'],
];

/**
 * What the pack's own rubric gives each artefact, measured against the real
 * grader rather than guessed. This table is why the plan can promise that a
 * learner who advances actually opened the gate and a learner who is stuck
 * actually is.
 *
 * Measured against the two-language pack, one submission each: the
 * Requirements and Design columns through their floors, the rest through the
 * real graders on a local runner:
 *
 *   requirements-strong                100   design-strong               100
 *   requirements-vague                  60 ✗ design-no-overdue-contract  100
 *   requirements-no-boundary            80 ✗ design-thin                  38 ✗
 *   requirements-thin                   40 ✗
 *
 * Requirements is a story phase graded by its floor: the score is the share of
 * the record's five lines that pass, and any failing line closes the gate.
 * `requirements-vague` writes one criterion (story.criteria.min and
 * story.criteria.tags fail), `requirements-no-boundary` tags no boundary
 * (story.criteria.tags fails), so both are first drafts the floor turns back,
 * not passing work.
 *
 * Design is graded by its floor too: the score is the share of its thirteen
 * lines that pass (the sequence diagram is the thirteenth).
 *
 *   implementation, with a run behind it      deployment-full             100
 *   solution                           100    deployment-no-runbook        86 ✗
 *   mutant, filter/overdue/badge        98    deployment-thin               7 ✗
 *   mutant, complete_does_not_persist   89
 *   half-written                        81    maintenance-solution        100
 *   early: the filter and the report    57 ✗  maintenance-scaffold         65 ✗
 *   scaffold                            15 ✗
 *
 *   testing, covering, 6 cases          83    minTests is six over both layers,
 *   testing, covering, 7 cases          88    and a suite under it has two of
 *   testing, covering, 8 cases          94    the three criteria capped at half
 *   testing, the pinned stuck pair      33 ✗  marks, which is why six covering
 *                                             cases is the floor and not three.
 *
 * A run behind a submission is worth up to 40 points of the `process`
 * criterion, which is 6 marks in implementation and maintenance and nothing at
 * all in testing (no process criterion in that rubric). Every implementation
 * mutant clears the gate once a run is behind it, which is why a learner who
 * is genuinely stuck there is one who has written one method of three.
 *
 * Deployment and Maintenance each carry a record (the runbook, the change
 * request) graded by a floor of seven rows, and any failing row closes the
 * gate whatever the score; their rows above were measured on the Compose stack
 * with the drill closed for `deployment-full`. Both full variants pass 7 of 7.
 * `deployment-no-runbook` (a runbook of four environment entries) passes 3 of
 * 7 and scores 86, so it does not open the gate; `deployment-thin` passes 2
 * of 7, and `maintenance-scaffold` 2 of 7.
 */
/** Only the strong story clears the floor; `pick` still draws once, so the seeded stream is unchanged. */
const PASSING_REQUIREMENTS = ['requirements-strong'] as const;

/**
 * The first drafts the floor turns back, dealt by roll position rather than by
 * a draw, so adding them moved no other learner's dice.
 */
const REQUIREMENTS_DRAFTS = ['requirements-thin', 'requirements-vague', 'requirements-no-boundary'] as const;

const PASSING_DESIGN = ['design-strong', 'design-no-overdue-contract'] as const;

const PASSING_IMPLEMENTATION = [
  'implementation-solution',
  'implementation-half-written',
  // Different learners leave different things wrong, which is the whole point
  // of the class map: three planted bugs rather than one, one of them in the
  // front end, all of them over the gate with a run behind them.
  'implementation-mutant:filter_keyword_case_sensitive',
  'implementation-mutant:overdue_includes_due_today',
  'implementation-mutant:badge_ignores_completion',
] as const;

/**
 * The suite a learner stuck in testing keeps handing in: two tests that both
 * name filtering, so the overdue criterion is never covered. Measured at 69
 * against a gate of 70, which is what being stuck looks like, and pinned
 * rather than generated, because coverage is scored on the words in a test's
 * name and a randomly dealt pair can accidentally cover everything.
 */
const STUCK_TESTING_SUITE = [
  'test_a_keyword_matches_whatever_the_case',
  'test_tasks_come_back_highest_priority_first',
];

/**
 * Only the full deployment meets the runbook floor (a variant that fails a
 * floor leaves the passing list): measured, `deployment-full` scores 100 with
 * 7 of 7 runbook rows and `deployment-no-runbook` scores 86 with 3 of 7, which
 * the floor turns back. `pick` still draws once, so the seeded stream is
 * unchanged.
 */
const PASSING_DEPLOYMENT = ['deployment-full', 'deployment-full', 'deployment-full'] as const;

/**
 * The kill count each learner's *final* testing suite reaches, dealt to the
 * twelve who got past the phase. Six is the floor, and it is `minTests` rather
 * than the kill weight that sets it: a suite of five cases is under the phase's
 * minimum, which caps two of the three criteria at half marks and puts even a
 * covering suite below the gate. The spread above six is what keeps the phase's
 * median off 100 and keeps a mutant red for learners already in deployment.
 */
const FINAL_TESTING_KILLS = [6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8];

/* -------------------------------- the PRNG ------------------------------- */

/**
 * mulberry32: thirty-two bits of state, no dependency, and the same sequence
 * on every machine. Good enough to deal a class, and small enough that the
 * determinism is inspectable rather than promised.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against a seeded generator; never touches the input. */
function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)];

const between = (random: () => number, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));

/* ----------------------------- the reflections --------------------------- */

/**
 * A reflection has to be at least twenty characters or `advance` refuses, and
 * a class where twenty-five learners wrote the same sentence is a fixture. One
 * line per phase per learner, dealt from a small bank.
 */
const REFLECTIONS: Record<PhaseKey, string[]> = {
  requirements: [
    'Writing the boundary case down as a criterion was the moment the story stopped being vague.',
    'I had to cut two features to write an honest scope note, and the story got sharper for it.',
    'The feedback showed my second criterion was not testable, so I rewrote it around an observable outcome.',
  ],
  design: [
    'Naming the return value of every operation forced me to decide things I had been leaving open.',
    'The decision log was the hardest part: writing the trade-off down showed me I had not weighed one.',
    'Tracing each field back to a story caught two columns nothing actually needed.',
  ],
  implementation: [
    'The hidden suite caught an ordering assumption my own tests never questioned.',
    'Running before submitting turned a guess into a two-minute loop, and my score followed.',
    'I rewrote filter_tasks once the analyzer showed how much branching had crept into it.',
  ],
  testing: [
    'The kill matrix was humbling: my suite passed and still let three planted bugs through.',
    'Testing the boundary rather than the happy path is what changed my score.',
    'I learned to assert on stored state instead of the return value, and a mutant died for it.',
  ],
  deployment: [
    'The smoke run failed on a path I had never typed out, which is exactly what a smoke run is for.',
    'Writing the rollback section made me notice the runbook assumed knowledge I had not written down.',
    'The incident drill taught me to check before claiming a fix, not after.',
  ],
  maintenance: [
    'Adding the change without breaking the regression suite is a different skill from writing it new.',
    'The contracts file made me state what I was changing before I changed it.',
    'I kept the old behaviour by adding rather than editing, and the regression tests agreed.',
  ],
};

/* ------------------------------ the builder ------------------------------ */

/** `first.last@class.learnsdlc.test`, ASCII only, unique across the roll. */
export function emailFor(displayName: string): string {
  const local = displayName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '');
  return `${local}@${CLASS_EMAIL_DOMAIN}`;
}

/**
 * A suite that touches all four coverage groups, killing `kills` mutants. The
 * groups come first so coverage is full, and the extras are dealt from what is
 * left. One case can answer two groups, so the picks are deduped before the
 * rest are dealt.
 */
export function coveringSuite(kills: number, random: () => number): string[] {
  const chosen = [...new Set(COVERAGE_GROUPS.map((group) => pick(group, random)))];
  const rest = shuffled(
    TEST_METHOD_KILLS.map((entry) => entry.method).filter((name) => !chosen.includes(name)),
    random,
  );
  return [...chosen, ...rest.slice(0, Math.max(0, kills - chosen.length))];
}

/** Any `kills` of the eight, in a seeded order: a first draft, coverage and all. */
export function anySuite(kills: number, random: () => number): string[] {
  return shuffled(
    TEST_METHOD_KILLS.map((entry) => entry.method),
    random,
  ).slice(0, kills);
}

const suiteVariant = (methods: string[]): string => `testing-partial:${methods.join(',')}`;

/**
 * Build the class. Deterministic in `seed`: two calls with the same seed
 * return deep-equal plans, and every absolute date is left to the replay.
 */
export function buildClassPlan(seed: number): ClassPlan {
  const random = mulberry32(seed);
  const names = shuffled(ROLL, random);
  const tracks = shuffled(TRACKS, random);
  const firstKills = shuffled(FIRST_TESTING_KILLS, random);
  const finalKills = shuffled(FINAL_TESTING_KILLS, random);
  let firstKillIndex = 0;
  let finalKillIndex = 0;

  const personas: PersonaPlan[] = tracks.map((track, i) => {
    const displayName = names[i];
    const signals = track.signals;
    const stopOrder = track.stopOrder;
    const lastActiveDay = Math.max(0, TERM_DAYS - track.idleDays);

    const phases: PhasePlan[] = [];
    for (let order = 1; order <= stopOrder; order++) {
      const key = PHASE_KEYS[order - 1];
      const runnable = RUNNABLE.has(key);
      const isCurrent = order === stopOrder && !track.completed;
      const advanced = !isCurrent;
      const shape: CurrentShape = isCurrent ? track.current : 'one-try';

      const attempts: AttemptPlan[] = [];
      // Days are laid out once the whole script is known (layOutDays below), so
      // a learner's last attempt lands exactly on the day they went quiet
      // rather than wherever the arithmetic happened to leave it.
      const push = (variant: string, hints: number, ran: boolean, paste = false) =>
        attempts.push({ day: 0, variant, hints, ran: ran && runnable, pasteMentorReply: paste });

      /* --- the phases they got past ------------------------------------- */
      if (advanced) {
        // A first draft that did not open the gate, on about half of them:
        // it is what puts an average of more than one attempt on the phase
        // strip and a history worth scrolling on the learner's page.
        const drafted = random() < 0.45;
        if (key === 'requirements') {
          if (drafted) push(REQUIREMENTS_DRAFTS[i % REQUIREMENTS_DRAFTS.length], between(random, 1, 3), false);
          if (signals.includes('integrity-paste')) {
            // The paste is the learner's last word on the phase, so it is what
            // the newest submission, and therefore the console, carries.
            push('requirements-strong', 1, false, true);
          } else {
            push(pick(PASSING_REQUIREMENTS, random), between(random, 0, 3), false);
          }
        } else if (key === 'design') {
          if (drafted) push('design-thin', between(random, 1, 3), false);
          push(pick(PASSING_DESIGN, random), between(random, 0, 3), false);
        } else if (key === 'implementation') {
          if (drafted) push('implementation-mutant:complete_does_not_persist', between(random, 1, 3), true);
          push(pick(PASSING_IMPLEMENTATION, random), between(random, 0, 3), true);
        } else if (key === 'testing') {
          push(suiteVariant(anySuite(firstKills[firstKillIndex++], random)), between(random, 0, 3), true);
          push(suiteVariant(coveringSuite(finalKills[finalKillIndex++], random)), between(random, 1, 4), true);
        } else if (key === 'deployment') {
          if (drafted) push('deployment-thin', between(random, 1, 3), true);
          push(pick(PASSING_DEPLOYMENT, random), between(random, 0, 3), true);
        } else {
          if (drafted) push('maintenance-scaffold', between(random, 1, 3), true);
          push('maintenance-solution', between(random, 0, 3), true);
        }
      } else {
        /* --- the phase they are sitting in -------------------------------- */
        const hints = signals.includes('integrity-reliance')
          ? 5
          : signals.includes('no-run')
            ? between(random, 1, 3)
            : between(random, 0, 3);
        const ran = !signals.includes('no-run');
        // Lazily, and once: a learner who has not started this phase must not
        // take a card off the kill deck, or the median of the class's first
        // testing submissions would depend on who happened to be dealt it.
        let deckKills: number | null = null;
        const belowGate = (): string => {
          if (key === 'testing') {
            if (deckKills === null) deckKills = firstKills[firstKillIndex++];
            return shape === 'stuck'
              ? suiteVariant(STUCK_TESTING_SUITE)
              : suiteVariant(anySuite(deckKills, random));
          }
          if (key === 'requirements') return 'requirements-thin';
          if (key === 'design') return 'design-thin';
          // The near-miss mutants all clear the gate once a run is behind
          // them (measured: 70 to 96), so a learner who is genuinely under it
          // is one who has written a method and not the other two.
          if (key === 'implementation') return 'implementation-early';
          if (key === 'deployment') return 'deployment-thin';
          return 'maintenance-scaffold';
        };

        if (shape === 'just-unlocked') {
          // Nothing: the gate behind them opened and they have not started.
        } else if (shape === 'stuck') {
          // The first go is worse than the ones after it: a learner who is
          // stuck has been getting closer, which is why the console shows a
          // best score rather than a last one.
          //
          // The hint counts are capped so this learner reads as stuck and not
          // as an integrity concern. `relianceIndex` flags at 60, which is
          // `hints > 3 × attempts + 1`, and the console ranks an integrity
          // flag above a gate, so a stuck learner who asked one question too
          // many would appear in the queue under "leaning on the mentor" and
          // the class map would show nobody stuck at all. The plan says these
          // three are stuck; this is what makes the console say it.
          const goes = [between(random, 1, 3), between(random, 3, 5)];
          if (random() < 0.5) goes.push(between(random, 2, 4));
          const ceiling = 3 * goes.length + 1;
          let spent = 0;
          const asked = goes.map((want) => {
            const take = Math.max(0, Math.min(want, ceiling - spent));
            spent += take;
            return take;
          });
          push(
            key === 'implementation' ? 'implementation-scaffold' : belowGate(),
            asked[0],
            ran,
          );
          for (const hint of asked.slice(1)) push(belowGate(), hint, ran);
        } else if (shape === 'nearly') {
          push(belowGate(), between(random, 1, 3), ran);
          const over =
            key === 'design'
              ? pick(PASSING_DESIGN, random)
              : key === 'deployment'
                ? PASSING_DEPLOYMENT[0]
                : key === 'requirements'
                  ? pick(PASSING_REQUIREMENTS, random)
                  : key === 'implementation'
                    ? pick(PASSING_IMPLEMENTATION, random)
                    : key === 'testing'
                      ? suiteVariant(coveringSuite(6, random))
                      : 'maintenance-solution';
          push(over, hints, ran);
        } else {
          push(belowGate(), hints, ran);
        }
      }

      phases.push({
        order,
        key,
        runnable,
        attempts,
        advanced,
        // The drill is the one writer of the runbook record's incident, and
        // the runbook floor asks for it, so every learner dealt the full
        // deployment works the drill before submitting it (replay.mjs,
        // closeDrill). `drillResolve` refuses a write-up until a health check
        // has gone from red to green against the learner's own files, and the
        // full deployment artefact is the one whose container starts, so the
        // two are the same set by construction. Everyone else leaves the drill
        // node untouched, which is what the class map is for.
        drill: key === 'deployment' && attempts.some((attempt) => attempt.variant === 'deployment-full'),
        reflection: pick(REFLECTIONS[key], random),
      });
    }

    layOutDays(phases, lastActiveDay, random);

    const submissions = phases.reduce((total, phase) => total + phase.attempts.length, 0);
    const hints = phases.reduce(
      (total, phase) => total + phase.attempts.reduce((n, a) => n + a.hints, 0),
      0,
    );
    return {
      index: i + 1,
      displayName,
      email: emailFor(displayName),
      stopOrder,
      completed: track.completed,
      lastActiveDay,
      signals,
      phases,
      summary: summarise(track, submissions, hints, TERM_DAYS - lastActiveDay),
    };
  });

  return {
    seed,
    className: CLASS_NAME,
    termDays: TERM_DAYS,
    password: CLASS_PASSWORD,
    personas,
  };
}

/**
 * Spread one learner's attempts across the term.
 *
 * Two things have to be true and neither falls out of a per-phase stride: the
 * last attempt lands on the day the learner went quiet, otherwise every
 * learner who worked steadily reads as idle, and attempts inside one phase sit
 * a day or two apart while phases sit weeks apart. So each attempt gets a
 * weight (a new phase is a jump, a retry is a nudge), and the running total is
 * scaled onto [0, lastActiveDay].
 */
function layOutDays(phases: PhasePlan[], lastActiveDay: number, random: () => number): void {
  const attempts: AttemptPlan[] = [];
  const weights: number[] = [];
  for (const phase of phases) {
    phase.attempts.forEach((attempt, i) => {
      attempts.push(attempt);
      weights.push(i === 0 ? 1 : 0.3);
    });
  }
  if (attempts.length === 1) {
    attempts[0].day = lastActiveDay;
    return;
  }
  const cumulative: number[] = [];
  let running = 0;
  for (let i = 0; i < attempts.length; i++) {
    if (i > 0) running += weights[i];
    cumulative.push(running);
  }
  const total = running || 1;
  let previous = -1;
  attempts.forEach((attempt, i) => {
    const exact = (cumulative[i] / total) * lastActiveDay;
    // A day of jitter on the interior, never on the first or the last, and
    // never enough to run the term backwards.
    const jitter = i === 0 || i === attempts.length - 1 ? 0 : between(random, 0, 1);
    const day = Math.min(lastActiveDay, Math.max(previous, Math.round(exact) + jitter));
    attempt.day = day;
    previous = day;
  });
  attempts[attempts.length - 1].day = lastActiveDay;
}

/** The words the seeder prints for one learner, once their replay is done. */
function summarise(track: Track, submissions: number, hints: number, idleDays: number): string {
  const where = track.completed
    ? 'finished all six phases'
    : (PHASE_KEYS[track.stopOrder - 1] as string);
  const parts = [where, `${submissions} submissions`, `${hints} hints`];
  if (track.signals.includes('integrity-paste')) parts.push('a passage matches a mentor reply');
  if (track.signals.includes('integrity-reliance')) parts.push('leaning on the mentor');
  if (track.signals.includes('stuck')) parts.push('stuck at a gate');
  if (track.signals.includes('no-run')) parts.push('submitted without running');
  if (track.signals.includes('idle')) parts.push(`no activity for ${idleDays} days`);
  return parts.join(', ');
}

/* --------------------------- what opens a gate --------------------------- */

/**
 * Every variant measured at or above the pack's threshold. A phase a learner
 * advanced out of has to end on one of these, or the replay would stop at
 * `POST /phases/:id/advance` half way through a nine-minute run, so the plan
 * asserts it rather than discovering it.
 */
const OPENS_THE_GATE: ReadonlySet<string> = new Set([
  'requirements-strong',
  'design-strong',
  'design-no-overdue-contract',
  'implementation-solution',
  'implementation-half-written',
  'implementation-mutant:filter_keyword_case_sensitive',
  'implementation-mutant:overdue_includes_due_today',
  'implementation-mutant:badge_ignores_completion',
  'deployment-full',
  'maintenance-solution',
]);

/**
 * The pack scores coverage by looking for each group's keyword anywhere in the
 * submitted source (`coverageKeywords` in phase.json), not by which mutant a
 * case was written for. Modelling it any other way puts a learner over the gate
 * the plan expected to be under it, which is exactly the mistake this function
 * exists to stop, so the model is the measured table in COVERAGE_GROUPS.
 */
export function coversEveryGroup(methods: string[]): boolean {
  return COVERAGE_GROUPS.every((group) => group.some((name) => methods.includes(name)));
}

/**
 * Whether this artefact scored at or above the phase's threshold when it was
 * measured. `minTests` is six over both layers, and a suite under it has both
 * `tests_pass` and `coverage_mapping` capped at half marks, so six covering
 * cases is the floor for a testing suite however many bugs they kill.
 */
export function opensTheGate(variant: string): boolean {
  if (variant.startsWith('testing-partial:')) {
    const methods = variant.slice('testing-partial:'.length).split(',').filter(Boolean);
    return methods.length >= 6 && coversEveryGroup(methods);
  }
  return OPENS_THE_GATE.has(variant);
}

/* ------------------------------ plan queries ----------------------------- */

/** Personas whose current phase raises this signal. */
export const withSignal = (plan: ClassPlan, signal: PersonaSignal): PersonaPlan[] =>
  plan.personas.filter((persona) => persona.signals.includes(signal));

/** How many of the eight planted bugs a learner's first testing suite killed. */
export function firstTestingKills(persona: PersonaPlan): number | null {
  const testing = persona.phases.find((phase) => phase.key === 'testing');
  if (!testing || !testing.attempts.length) return null;
  const variant = testing.attempts[0].variant;
  if (variant === 'testing-reference') return TEST_METHOD_KILLS.length;
  if (!variant.startsWith('testing-partial:')) return null;
  const methods = variant.slice('testing-partial:'.length);
  return methods ? methods.split(',').length : 0;
}
