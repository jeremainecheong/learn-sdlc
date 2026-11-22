import type { CiStep } from '@learnsdlc/shared';
import * as yaml from 'js-yaml';
import { capWithEllipsis } from './text-caps';

/** The separate isolated selfcheck; it cannot establish a workflow step outcome. */
export interface SmokeOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Commands that actually run a test suite. */
const TEST_COMMAND =
  /(python\s+-m\s+unittest|unittest\s+discover|\bpytest\b|\btox\b|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test|node\s+--test|\bjest\b|\bvitest\b|\bmocha\b|go\s+test|cargo\s+test)/i;

/** Commands that actually build a deployable artefact. */
const BUILD_COMMAND =
  /(docker(\s+buildx)?\s+build|docker\s+compose\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+(run\s+)?build|make\s+build|pack\s+build)/i;

const MAX_ROWS = 100;
const MAX_DETAIL = 200;

type StepKind = 'test' | 'build' | 'other';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const firstLine = (text: string, limit = 160): string => {
  const line = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return capWithEllipsis(line, limit);
};

const oneLine = (text: string, limit = 80): string => {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return capWithEllipsis(flat, limit);
};

const clampDetail = (detail: string): string => capWithEllipsis(detail, MAX_DETAIL);

const commandKind = (command: string): StepKind => {
  if (!command.trim()) return 'other';
  if (TEST_COMMAND.test(command)) return 'test';
  if (BUILD_COMMAND.test(command)) return 'build';
  return 'other';
};

/** A step label a learner will recognise from their own file. */
const stepLabel = (step: Record<string, unknown>, index: number): string => {
  const name = step.name;
  if (typeof name === 'string' && name.trim()) return oneLine(name);
  const uses = step.uses;
  if (typeof uses === 'string' && uses.trim()) return oneLine(uses);
  const run = step.run;
  if (typeof run === 'string' && run.trim()) return oneLine(firstLine(run, 80));
  return `step ${index + 1}`;
};

/**
 * Describe the declared workflow. No workflow commands are executed here.
 * Structural errors are findings; all execution outcomes remain unknown.
 * The separate selfcheck is reported in the review checks and run output.
 */
export function buildCiSteps(ciYaml: string, _smoke: SmokeOutcome | undefined): CiStep[] {
  const source = typeof ciYaml === 'string' ? ciYaml : '';
  if (!source.trim()) return [];

  let doc: unknown;
  try {
    // js-yaml 4 `load` is the safe schema: the full schema that could build
    // arbitrary types was removed in that major, and `safeLoad` folded into it.
    doc = yaml.load(source);
  } catch (err) {
    const reason = firstLine(err instanceof Error ? err.message : String(err));
    return [
      {
        job: 'workflow',
        step: 'parse ci.yml',
        ok: false,
        detail: clampDetail(
          reason
            ? `ci.yml is not valid YAML, so no pipeline runs at all: ${reason}`
            : 'ci.yml is not valid YAML, so no pipeline runs at all.',
        ),
      },
    ];
  }

  if (!isRecord(doc)) {
    return [
      {
        job: 'workflow',
        step: 'parse ci.yml',
        ok: false,
        detail: 'ci.yml does not describe a workflow, so no pipeline runs at all.',
      },
    ];
  }

  const jobs = doc.jobs;
  if (!isRecord(jobs) || Object.keys(jobs).length === 0) {
    return [
      {
        job: 'workflow',
        step: 'jobs',
        ok: false,
        detail: 'ci.yml declares no jobs, so a push runs nothing.',
      },
    ];
  }

  const rows: CiStep[] = [];
  const push = (row: CiStep) => {
    if (rows.length < MAX_ROWS) rows.push(row);
  };

  const jobNames = Object.keys(jobs);
  jobNames.forEach((jobName, jobIndex) => {
    const job = jobs[jobName];
    if (!isRecord(job)) {
      push({
        job: jobName,
        step: '(empty job)',
        ok: false,
        detail: 'This job has no definition, so it does nothing.',
      });
      return;
    }

    // Job order is not a dependency. A later job with no `needs` runs beside the
    // first one, so a red test job cannot stop the build.
    if (jobIndex > 0 && job.needs === undefined) {
      push({
        job: jobName,
        step: 'needs',
        ok: null,
        detail:
          `This job declares no needs, so it runs beside ${jobNames[0]} instead of after it — ` +
          'a red test job would not stop it.',
      });
    }

    const steps = job.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      push({
        job: jobName,
        step: '(no steps)',
        ok: false,
        detail: 'This job has no steps, so it does nothing.',
      });
      return;
    }

    steps.forEach((raw, index) => {
      if (!isRecord(raw)) {
        push({
          job: jobName,
          step: `step ${index + 1}`,
          ok: false,
          detail: 'This step is not a mapping, so the workflow would not load.',
        });
        return;
      }
      const label = stepLabel(raw, index);
      const command = typeof raw.run === 'string' ? raw.run : '';
      const uses = typeof raw.uses === 'string' ? raw.uses.trim() : '';
      const kind = commandKind(command);

      if (kind !== 'other') {
        push({
          job: jobName,
          step: label,
          ok: null,
          detail: clampDetail(
            `Declares \`${oneLine(firstLine(command, 80))}\`. This ${kind === 'test' ? 'test suite' : 'build'} step was not executed. The separate selfcheck does not prove its outcome.`,
          ),
        });
        return;
      }

      if (command.trim()) {
        push({
          job: jobName,
          step: label,
          ok: null,
          detail: clampDetail(
            `Declares \`${oneLine(firstLine(command, 80))}\`. The grader does not execute this step.`,
          ),
        });
        return;
      }

      // No `run` at all. A name that promises a test or a build is worth saying
      // out loud: the grader's rules match the whole file, so a promise in a
      // `name:` (or a commented-out command) reads as a step that never runs.
      const nameOnly = typeof raw.name === 'string' ? raw.name : '';
      const promised = commandKind(nameOnly);
      if (promised !== 'other') {
        push({
          job: jobName,
          step: label,
          ok: null,
          detail: clampDetail(
            `This step names the ${promised === 'test' ? 'test suite' : 'build'} but has no run command, so nothing executes.`,
          ),
        });
        return;
      }

      push({
        job: jobName,
        step: label,
        ok: null,
        detail: uses
          ? clampDetail(`Provided by ${uses}. The grader does not execute this step.`)
          : 'This step runs no command.',
      });
    });
  });

  return rows;
}
