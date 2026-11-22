import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { IDLE_DAYS, STUCK_ATTEMPTS } from '../analytics/signals';
import type { StoryChecks } from '../content/content.types';
import { buildStoryPartial } from '../feedback/story-report';
import {
  CLASS_EMAIL_DOMAIN,
  PHASE_KEYS,
  TERM_DAYS,
  TEST_METHOD_KILLS,
  buildClassPlan,
  firstTestingKills,
  opensTheGate,
  withSignal,
} from './class-plan';

/**
 * The shape of the seeded class, asserted on the plan rather than on the rows.
 *
 * Everything the instructor console shows is downstream of these numbers, and
 * they are the numbers the product plan asks for: a phase strip that is a
 * spread rather than a staircase, a queue with one of each kind of trouble in
 * it, and a kill matrix whose median is neither nought nor six. Asserting them
 * here rather than after a nine-minute replay is what makes them cheap enough
 * to keep true.
 */
describe('the seeded class plan', () => {
  const SEED = 20260401;
  const plan = buildClassPlan(SEED);

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  it('is twenty-five learners with unique addresses on the class domain', () => {
    expect(plan.personas).toHaveLength(25);
    const emails = plan.personas.map((persona) => persona.email);
    expect(new Set(emails).size).toBe(25);
    for (const email of emails) expect(email.endsWith(`@${CLASS_EMAIL_DOMAIN}`)).toBe(true);
    expect(plan.personas.map((p) => p.displayName)).toEqual(
      expect.arrayContaining(['Aisyah Rahman', 'Zhi Hao Lee']),
    );
  });

  it('spreads the class over six phases instead of stacking it on one', () => {
    // 3 finished, then maintenance, deployment, testing, implementation,
    // design, requirements: the strip the class page draws.
    const at = (order: number) =>
      plan.personas.filter((p) => p.stopOrder === order && !p.completed).length;
    expect(plan.personas.filter((p) => p.completed)).toHaveLength(3);
    expect([at(6), at(5), at(4), at(3), at(2), at(1)]).toEqual([5, 4, 5, 4, 2, 2]);
    expect(at(6) + at(5) + at(4) + at(3) + at(2) + at(1) + 3).toBe(25);
  });

  it('puts one of each kind of trouble in the queue', () => {
    expect(withSignal(plan, 'stuck')).toHaveLength(3);
    expect(withSignal(plan, 'no-run')).toHaveLength(2);
    expect(withSignal(plan, 'idle')).toHaveLength(2);
    // Two flags, and deliberately not the same one twice: the console's
    // reasons should read as two different conversations.
    expect(withSignal(plan, 'integrity-paste')).toHaveLength(1);
    expect(withSignal(plan, 'integrity-reliance')).toHaveLength(1);
  });

  it('gives a stuck learner enough attempts under the gate to count as stuck', () => {
    for (const persona of withSignal(plan, 'stuck')) {
      const current = persona.phases[persona.phases.length - 1];
      expect(current.order).toBe(persona.stopOrder);
      expect(current.advanced).toBe(false);
      expect(current.attempts.length).toBeGreaterThanOrEqual(STUCK_ATTEMPTS);
    }
  });

  it('gives the no-run learners a runnable phase they never ran', () => {
    for (const persona of withSignal(plan, 'no-run')) {
      const current = persona.phases[persona.phases.length - 1];
      expect(current.runnable).toBe(true);
      expect(current.attempts.length).toBeGreaterThanOrEqual(1);
      expect(current.attempts.some((attempt) => attempt.ran)).toBe(false);
    }
  });

  it('leaves the idle learners quiet for longer than the console waits', () => {
    for (const persona of withSignal(plan, 'idle')) {
      expect(TERM_DAYS - persona.lastActiveDay).toBeGreaterThanOrEqual(IDLE_DAYS);
    }
    // Everyone else is inside the window, or the queue would be a wall of them.
    const quiet = plan.personas.filter((p) => TERM_DAYS - p.lastActiveDay >= IDLE_DAYS);
    expect(quiet).toHaveLength(2);
  });

  it('makes the mentor paste the learner\'s last word on the phase', () => {
    const [paster] = withSignal(plan, 'integrity-paste');
    const pasted = paster.phases.flatMap((phase) =>
      phase.attempts.map((attempt, i) => ({ attempt, last: i === phase.attempts.length - 1 })),
    );
    const pastes = pasted.filter((entry) => entry.attempt.pasteMentorReply);
    expect(pastes).toHaveLength(1);
    // The console reads the newest submission for the phase, so a paste on an
    // earlier attempt would never be seen.
    expect(pastes[0].last).toBe(true);
  });

  it('asks the mentor often enough to earn the reliance flag', () => {
    const [leaner] = withSignal(plan, 'integrity-reliance');
    const current = leaner.phases[leaner.phases.length - 1];
    expect(current.attempts).toHaveLength(1);
    // relianceIndex(5, 1) = round(500 / 8) = 63, over the 60 the report flags at.
    expect(current.attempts[0].hints).toBe(5);
  });

  it('lands the first testing submission on a median of four kills of eight', () => {
    const kills = plan.personas
      .map(firstTestingKills)
      .filter((count): count is number => count !== null);
    // Everybody who made a first testing submission: the seventeen at phase 4
    // or beyond, less the one who has only just unlocked it.
    expect(kills).toHaveLength(16);
    expect(median(kills)).toBe(4);
    expect(Math.min(...kills)).toBeGreaterThan(0);
    expect(Math.max(...kills)).toBe(TEST_METHOD_KILLS.length);
  });

  it('never asks for a run on a phase the pack cannot run', () => {
    for (const persona of plan.personas) {
      for (const phase of persona.phases) {
        expect(phase.key).toBe(PHASE_KEYS[phase.order - 1]);
        if (!phase.runnable) {
          expect(phase.attempts.every((attempt) => !attempt.ran)).toBe(true);
        }
      }
    }
  });

  it('writes a term that runs forwards and a reflection the gate accepts', () => {
    for (const persona of plan.personas) {
      let previous = -1;
      for (const phase of persona.phases) {
        // Every phase but the one a just-unlocked learner has not started.
        const current = phase.order === persona.stopOrder && !persona.completed;
        expect(phase.attempts.length).toBeGreaterThan(current ? -1 : 0);
        if (phase.advanced) expect(phase.attempts.length).toBeGreaterThan(0);
        // `advance` refuses anything under twenty characters (workflow.service.ts).
        if (phase.advanced) expect(phase.reflection.length).toBeGreaterThanOrEqual(20);
        for (const attempt of phase.attempts) {
          expect(attempt.day).toBeGreaterThanOrEqual(previous);
          expect(attempt.day).toBeLessThanOrEqual(persona.lastActiveDay);
          previous = attempt.day;
        }
      }
    }
  });

  it('is the same class twice, and a different class on another seed', () => {
    expect(buildClassPlan(SEED)).toEqual(buildClassPlan(SEED));
    expect(buildClassPlan(7)).not.toEqual(plan);
    // Still the same class shape, though: the seed deals the tracks, it does
    // not invent them.
    const other = buildClassPlan(7);
    expect(other.personas).toHaveLength(25);
    expect(other.personas.filter((p) => p.completed)).toHaveLength(3);
    expect(withSignal(other, 'stuck')).toHaveLength(3);
    expect(median(other.personas.map(firstTestingKills).filter((n): n is number => n !== null))).toBe(4);
  });
});

/**
 * A last check on the layout, because the console's idle branch reads the
 * newest submission's date rather than anything the plan says: a learner who
 * worked steadily must not read as quiet.
 */
describe('the term the plan lays out', () => {
  const plan = buildClassPlan(20260401);

  it('ends each learner on the day they went quiet', () => {
    for (const persona of plan.personas) {
      const days = persona.phases.flatMap((phase) => phase.attempts.map((a) => a.day));
      expect(Math.max(...days)).toBe(persona.lastActiveDay);
      // A learner with a term behind them started at the top of it. The one
      // with a single submission is a late starter who then went quiet, and
      // their first day is the day they went quiet.
      if (days.length > 1) expect(Math.min(...days)).toBeLessThanOrEqual(2);
    }
  });

  it('leaves only the two idle learners outside the console\'s window', () => {
    const quiet = plan.personas.filter(
      (persona) => !persona.completed && TERM_DAYS - persona.lastActiveDay >= IDLE_DAYS,
    );
    expect(quiet).toHaveLength(2);
    // Both are meant to be quiet, and one of them has a louder reason to be in
    // the queue than the silence.
    expect(quiet.every((persona) => persona.signals.includes('idle'))).toBe(true);
    expect(quiet.filter((persona) => persona.signals.includes('stuck'))).toHaveLength(1);
  });

  it('spreads a finished learner over at least three weeks', () => {
    for (const persona of plan.personas.filter((p) => p.completed)) {
      const days = persona.phases.flatMap((phase) => phase.attempts.map((a) => a.day));
      expect(new Set(days).size).toBeGreaterThanOrEqual(6);
      expect(Math.max(...days) - Math.min(...days)).toBeGreaterThanOrEqual(21);
    }
  });
});

/**
 * The replay walks the whole term through the public API, so a phase a learner
 * is planned to have merged has to be a phase they could actually merge: the
 * artefact they finished it on has to clear the pack's own threshold. These
 * are the assertions that turn a nine-minute failure into a five-millisecond
 * one.
 */
describe('what the plan promises the replay', () => {
  const plan = buildClassPlan(20260401);

  it('finishes every merged phase on an artefact that opens the gate', () => {
    // Collected rather than asserted one at a time, so a failure names every
    // learner and variant at once instead of the first.
    const wouldNotMerge = plan.personas.flatMap((persona) =>
      persona.phases
        .filter((phase) => phase.advanced)
        .map((phase) => ({ phase, last: phase.attempts[phase.attempts.length - 1] }))
        .filter(({ last }) => !opensTheGate(last.variant))
        .map(({ phase, last }) => `${persona.email} merged ${phase.key} on ${last.variant}`),
    );
    expect(wouldNotMerge).toEqual([]);
  });

  it('leaves every stuck learner under the gate on every attempt', () => {
    for (const persona of withSignal(plan, 'stuck')) {
      const current = persona.phases[persona.phases.length - 1];
      expect(current.attempts.length).toBeGreaterThanOrEqual(2);
      const overTheGate = current.attempts
        .filter((attempt) => opensTheGate(attempt.variant))
        .map((attempt) => `${persona.email}: ${attempt.variant}`);
      expect(overTheGate).toEqual([]);
    }
  });

  it('gives every learner who is not stuck at most one attempt they could fail', () => {
    // Two failing attempts under the gate is what "stuck" means to the console
    // (analytics.service.ts, STUCK_ATTEMPTS), so a learner the plan did not
    // mean to be stuck must not accidentally be.
    const accidentallyStuck = plan.personas
      .filter((persona) => !persona.completed && !persona.signals.includes('stuck'))
      .map((persona) => ({ persona, current: persona.phases[persona.phases.length - 1] }))
      .filter(({ current }) => {
        const failing = current.attempts.filter((attempt) => !opensTheGate(attempt.variant));
        const passed = current.attempts.some((attempt) => opensTheGate(attempt.variant));
        return !passed && failing.length > 1;
      })
      .map(({ persona, current }) => `${persona.email} in ${current.key}`);
    expect(accidentallyStuck).toEqual([]);
  });

  it('shows the phase strip every state it can draw', () => {
    const current = plan.personas
      .filter((persona) => !persona.completed)
      .map((persona) => persona.phases[persona.phases.length - 1]);
    // in_progress: unlocked and untouched.
    expect(current.filter((phase) => phase.attempts.length === 0)).toHaveLength(2);
    // passed, not merged. A handful rather than an exact number: a learner
    // sitting in testing submits whatever the kill deck dealt them, and a
    // generous hand opens the gate.
    const over = current.filter((phase) => phase.attempts.some((a) => opensTheGate(a.variant)));
    expect(over.length).toBeGreaterThanOrEqual(2);
    expect(over.length).toBeLessThanOrEqual(5);
    // submitted, still under the gate: everybody else.
    expect(
      current.filter(
        (phase) =>
          phase.attempts.length > 0 && !phase.attempts.some((a) => opensTheGate(a.variant)),
      ).length,
    ).toBeGreaterThanOrEqual(15);
  });

  it('only runs the incident drill where the container starts again', () => {
    for (const persona of plan.personas) {
      for (const phase of persona.phases.filter((p) => p.drill)) {
        expect(phase.key).toBe('deployment');
        // drillResolve refuses a write-up until a health check has gone from
        // red to green against the learner's own files, and only
        // the full deployment artefact does that.
        expect(phase.attempts[phase.attempts.length - 1].variant).toBe('deployment-full');
      }
    }
    expect(plan.personas.filter((p) => p.phases.some((ph) => ph.drill)).length).toBeGreaterThanOrEqual(3);
  });

  it('follows the runbook floor: only the full deployment opens the gate, and every learner dealt it works the drill', () => {
    expect(opensTheGate('deployment-full')).toBe(true);
    // a runbook of four environment entries fails the floor, so it left the passing list
    for (const variant of ['deployment-no-runbook', 'deployment-thin']) {
      expect([variant, opensTheGate(variant)]).toEqual([variant, false]);
    }
    const deployments = plan.personas.flatMap((p) => p.phases.filter((ph) => ph.key === 'deployment'));
    expect(deployments.some((ph) => !ph.advanced && ph.attempts.some((a) => a.variant === 'deployment-full'))).toBe(true);
    for (const phase of deployments) {
      for (const attempt of phase.attempts.filter((a) => opensTheGate(a.variant))) expect(attempt.variant).toBe('deployment-full');
      expect(phase.drill).toBe(phase.attempts.some((a) => a.variant === 'deployment-full'));
    }
  });

  it('follows the Requirements floor: only the strong story opens the gate, and the floor\'s teaching cases are drafts it turns back', () => {
    expect(opensTheGate('requirements-strong')).toBe(true);
    for (const variant of ['requirements-vague', 'requirements-no-boundary', 'requirements-thin']) {
      expect([variant, opensTheGate(variant)]).toEqual([variant, false]);
    }
    const requirements = plan.personas.flatMap((p) => p.phases.filter((ph) => ph.key === 'requirements' && ph.advanced));
    for (const phase of requirements) expect(phase.attempts[phase.attempts.length - 1].variant).toBe('requirements-strong');
    const drafts = new Set(requirements.flatMap((ph) => ph.attempts.slice(0, -1).map((a) => a.variant)));
    expect(drafts.has('requirements-vague') || drafts.has('requirements-no-boundary')).toBe(true);
  });

  it('measures the Requirements variants at the scores class-plan.ts states: 100, 60, 80 and 40', () => {
    // The records the seeder writes, read out of the seeder itself (an ES
    // module, so a child node reads it), graded by the story grader against
    // the shipped phase's rubric and floor. The child is plain node, so its
    // `@learnsdlc/shared` is the built package (`dist`), not this suite's
    // source mapping: the shared package must be built first, as CI does.
    const root = join(__dirname, '..', '..', '..', '..');
    if (!existsSync(join(root, 'packages', 'shared', 'dist', 'index.js'))) {
      throw new Error('This case runs the seeder in a child node, which reads @learnsdlc/shared from its build: run `npm run build -w @learnsdlc/shared` first.');
    }
    const variants = ['requirements-strong', 'requirements-vague', 'requirements-no-boundary', 'requirements-thin'];
    const script = `import { filesFor } from ${JSON.stringify(join(root, 'scripts', 'seed-class', 'artefacts.mjs'))};
process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(variants)}.map((v) => [v, filesFor(v)]))));`;
    const files = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' }),
    ) as Record<string, Record<string, string>>;
    const phase = JSON.parse(readFileSync(join(root, 'content', 'tasktrackr', 'phases', '01-requirements', 'phase.json'), 'utf8')) as {
      rubric: Parameters<typeof buildStoryPartial>[0];
      checks: StoryChecks;
    };
    const scores = Object.fromEntries(
      variants.map((v) => [v, buildStoryPartial(phase.rubric, phase.checks, files[v][phase.checks.record]).overall]),
    );
    expect(scores).toEqual({
      'requirements-strong': 100,
      'requirements-vague': 60,
      'requirements-no-boundary': 80,
      'requirements-thin': 40,
    });
  });
});
