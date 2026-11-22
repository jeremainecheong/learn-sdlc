'use client';

/**
 * Pure derivations for the journal. The API keeps every run, every verdict,
 * every mentor exchange and every merge; none of it is written by hand, so the
 * page's job is only to put them on one timeline and say what each one was.
 *
 * Nothing here fetches or touches the DOM.
 */
import type {
  AssistantMessageView,
  EnrollmentView,
  ExecutionRunView,
  PhaseDetail,
  PhaseKey,
  PhaseSummary,
  PhaseTaskView,
  SubmissionView,
} from '@learnsdlc/shared';
import { pluralWord } from '@learnsdlc/shared';
import type { PhaseRecords } from '@/lib/records';
import type { IconName } from '@/components/Icon';
import { capitalise } from '@/lib/capitalise';
import { DISPLAY_LOCALE } from '@/lib/locale';
import { PERSONA_NAME, type StatusState } from '@/lib/phase';
import { doorWithTasks, phaseDoorHref } from '@/components/shell/routes';

/**
 * A phase as this file reads it: the summary, plus the task list its door
 * needs.
 *
 * `buildJournal` is handed every open phase's detail already, so a row that
 * links to a phase whose quiz is the only thing left can open the paper rather
 * than the room the learner has finished with. The join happens once per phase
 * in `buildJournal` and the rows are built from what it returns, so no helper
 * here has to know about the map.
 */
type JournalPhase = PhaseSummary & { tasks?: readonly PhaseTaskView[] };

// The kinds of row the journal draws. 'solution' is the day the learner opened
// the pack's own answer to a phase.
export type JournalKind = 'run' | 'submission' | 'hint' | 'release' | 'drill' | 'solution';

export interface JournalEvent {
  /** Stable across reloads: it is the row's test id and its React key. */
  id: string;
  at: string;
  kind: JournalKind;
  icon: IconName;
  phaseKey: PhaseKey;
  phaseTitle: string;
  phaseId: string;
  title: string;
  detail: string;
  /** Colours the icon tile. Null for the rows that carry no verdict. */
  state: StatusState | null;
  /** The right-aligned chip. Absent where nothing was decided. */
  result?: string;
  href?: string;
}

/** Everything the page loaded for one phase, keyed by phase id. */
/**
 * One phase's records. Defined with the cache that holds them, and re-exported
 * here because this is where they are read.
 */
export type { PhaseRecords } from '@/lib/records';

/* --------------------------------- words --------------------------------- */

const MAX_DETAIL = 200;

export function clamp(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The first sentence, so a detail line reads as one statement. */
function firstSentence(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const stop = flat.search(/[.!?](\s|$)/);
  return clamp(stop > 20 ? flat.slice(0, stop + 1) : flat, max);
}

/** A detail line is a sentence, so it ends like one. */
function period(text: string): string {
  return !text || /[.!?…"']$/.test(text) ? text : `${text}.`;
}

function plural(n: number, one: string, many?: string): string {
  return `${n} ${pluralWord(n, one, many)}`;
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/* --------------------------------- dates --------------------------------- */

const TIME = new Intl.DateTimeFormat(DISPLAY_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat(DISPLAY_LOCALE, { day: 'numeric', month: 'long' });
const WEEKDAY = new Intl.DateTimeFormat(DISPLAY_LOCALE, { weekday: 'long' });

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : TIME.format(d);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today, 3 September", "Yesterday, 2 September", else "Monday, 1 September". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Undated';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  const date = DAY.format(d);
  if (days === 0) return `Today, ${date}`;
  if (days === 1) return `Yesterday, ${date}`;
  return `${WEEKDAY.format(d)}, ${date}`;
}

/* --------------------------------- events -------------------------------- */

function runEvent(run: ExecutionRunView, phase: JournalPhase): JournalEvent {
  const result = run.result;
  const tests = result?.tests;
  const href = `/workspace/${phase.id}/runs/${run.id}`;
  const base = {
    id: `run-${run.id}`,
    at: run.createdAt,
    kind: 'run' as const,
    icon: 'play' as IconName,
    phaseKey: phase.key,
    phaseTitle: phase.title,
    phaseId: phase.id,
    href,
  };
  if (run.status === 'queued' || run.status === 'running') {
    return { ...base, title: 'Run started', detail: `The sandbox is running ${phase.title}.`, state: 'now', result: 'Running' };
  }
  if (!result) {
    return {
      ...base,
      title: 'Run did not finish',
      detail: 'The sandbox returned nothing. Nothing was recorded against the phase.',
      state: 'warn',
      result: 'Open',
    };
  }
  if (tests) {
    const ok = tests.failed === 0 && tests.errored === 0;
    const firstBad = tests.cases.find((c) => c.status !== 'passed');
    return {
      ...base,
      title: `Visible suite: ${tests.passed} of ${tests.total}`,
      detail: ok
        ? `${plural(tests.total, 'case')} in ${seconds(result.durationMs)}.`
        : firstBad
          ? period(
              `${firstBad.name} ${firstBad.status === 'errored' ? 'errored' : 'failed'}: ${firstSentence(
                firstBad.message || 'no message was returned',
                140,
              )}`,
            )
          : `${plural(tests.failed + tests.errored, 'case')} did not pass.`,
      state: ok ? 'pass' : 'fail',
      result: ok ? 'Passed' : 'Failed',
    };
  }
  const clean = result.ok && result.exitKind === 'ok';
  const problem =
    result.exitKind === 'timeout'
      ? 'The run hit the time limit.'
      : result.exitKind === 'memory'
        ? 'The run hit the memory limit.'
        : period(firstSentence(result.stderr || result.stdout || 'The command exited non-zero.', 140));
  return {
    ...base,
    title: clean ? 'Checks ran clean' : 'Checks failed',
    detail: clean ? `Finished in ${seconds(result.durationMs)}.` : problem,
    state: clean ? 'pass' : 'fail',
    result: clean ? 'Passed' : 'Failed',
  };
}

function submissionEvent(sub: SubmissionView, phase: JournalPhase, index: number): JournalEvent {
  const attempt = sub.attempt ?? index + 1;
  const base = {
    id: `submission-${sub.id}`,
    at: sub.createdAt,
    kind: 'submission' as const,
    icon: 'send' as IconName,
    phaseKey: phase.key,
    phaseTitle: phase.title,
    phaseId: phase.id,
    href: phaseDoorHref(phase),
  };
  if (sub.status === 'queued' || sub.status === 'running') {
    return {
      ...base,
      title: `Submission ${attempt} of ${phase.title} is with the reviewer`,
      detail: 'The reviewer checks the submitted evidence against every required criterion.',
      state: 'now',
      result: 'In review',
    };
  }
  if (sub.status === 'failed' || !sub.report) {
    return {
      ...base,
      title: `Submission ${attempt} of ${phase.title} did not finish grading`,
      detail: sub.error ? clamp(sub.error) : 'No verdict was recorded. Resubmit the work for a complete review.',
      state: 'warn',
      result: 'Open',
    };
  }
  const report = sub.report;
  const strict = report.assessmentMode === 'strict_binary';
  const passed = strict ? sub.verifiedPass === true : report.passed === true;
  const verdict = passed ? 'Pass' : 'Needs revision';
  const parts: string[] = [];
  if (report.tests) parts.push(`hidden suite ${report.tests.passed} of ${report.tests.total}`);
  if (report.mutation) parts.push(`${report.mutation.killed} of ${plural(report.mutation.total, 'mutant')} killed`);
  const issues = report.staticAnalysis?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  if (errors || warnings) parts.push(`analyzer ${plural(errors, 'error')} and ${plural(warnings, 'warning')}`);
  const tail = strict
    ? passed
      ? 'The strict review passed.'
      : report.passed
        ? 'The recorded Pass lacks verified evidence and does not clear this phase.'
        : 'Revise the work using the retained feedback.'
    : 'This historical verdict does not establish a current phase pass.';
  const lead = parts.length ? `${parts.join(', ')}. ` : '';
  return {
    ...base,
    title: `Submission ${attempt} of ${phase.title}: ${strict ? '' : 'Historical '}${verdict}`,
    detail: clamp(capitalise(`${lead}${tail}`)),
    state: passed ? 'pass' : 'fail',
    result: strict ? verdict : `Historical ${verdict}`,
  };
}

function hintEvents(chat: AssistantMessageView[], phase: JournalPhase): JournalEvent[] {
  const out: JournalEvent[] = [];
  let asked = 0;
  chat.forEach((message, i) => {
    if (message.role !== 'user') return;
    asked += 1;
    const reply = chat.slice(i + 1).find((m) => m.role === 'assistant');
    const question = clamp(message.content, 72);
    const answer = reply?.meta?.redacted
      ? 'The answer was withheld: the question asked for the solution.'
      : reply
        ? `"${firstSentence(reply.content, 170)}"`
        : 'No answer was recorded.';
    out.push({
      id: `hint-${message.id}`,
      at: message.createdAt,
      kind: 'hint',
      icon: 'hint',
      phaseKey: phase.key,
      phaseTitle: phase.title,
      phaseId: phase.id,
      // The reviewer, not the phase, answers: "Hint 2 from the architect: ..."
      title: `Hint ${asked} from the ${PERSONA_NAME[phase.key].toLowerCase()}: ${question}`,
      detail: answer,
      // A hint has no verdict, so it carries no chip; the amber tile is how the
      // design marks the rows that cost something rather than settled anything.
      state: 'warn',
      href: phaseDoorHref(phase),
    });
  });
  return out;
}

function releaseEvents(
  enrollment: EnrollmentView,
  details: Record<string, PhaseDetail>,
): JournalEvent[] {
  const releases = enrollment.releases ?? [];
  return releases.map((r) => {
    const phase = enrollment.phases.find((p) => p.key === r.phaseKey);
    const title = phase?.title ?? r.phaseKey;
    return {
      id: `release-${r.id}`,
      at: r.createdAt,
      kind: 'release' as const,
      icon: 'merge' as IconName,
      phaseKey: r.phaseKey,
      phaseTitle: title,
      phaseId: phase?.id ?? '',
      title: `${title} merged as ${r.version}`,
      detail: r.notes ? `Merge message: "${clamp(r.notes, 180)}"` : `Recorded when the ${title} gate passed.`,
      state: 'pass' as StatusState,
      result: 'Merged',
      href: phase ? phaseDoorHref(doorWithTasks(phase, details)) : undefined,
    };
  });
}

/**
 * The day the learner opened the pack's own
 * answer to a phase they had already passed. One row, derived from the phase
 * detail the journal already holds: no request of its own.
 */
function solutionEvents(detail: PhaseDetail, phase: JournalPhase): JournalEvent[] {
  const at = detail.solution?.readAt;
  if (!at) return [];
  return [
    {
      id: `solution-${phase.id}`,
      at,
      kind: 'solution' as const,
      icon: 'eye' as IconName,
      phaseKey: phase.key,
      phaseTitle: phase.title,
      phaseId: phase.id,
      title: 'Read the reference solution',
      detail: `${phase.title}, after the gate passed.`,
      state: null,
      href: phaseDoorHref(phase),
    },
  ];
}

function drillEvents(detail: PhaseDetail, phase: JournalPhase): JournalEvent[] {
  const drill = detail.drill;
  if (!drill) return [];
  const href = phaseDoorHref(phase);
  const common = {
    kind: 'drill' as const,
    phaseKey: phase.key,
    phaseTitle: phase.title,
    phaseId: phase.id,
    href,
  };
  const out: JournalEvent[] = [
    {
      ...common,
      id: `drill-paged-${phase.id}`,
      at: drill.pagedAt,
      icon: 'bell',
      title: `Paged: the smoke check fails on ${drill.fault}`,
      detail: 'The incident drill is open. The faulted copy is the one that broke, not your files.',
      state: 'warn',
      result: 'Open',
    },
  ];
  if (drill.healthRanAt) {
    const ok = drill.healthExit === 0;
    out.push({
      ...common,
      id: `drill-health-${phase.id}`,
      at: drill.healthRanAt,
      icon: 'terminal',
      title: 'Health check run against your files',
      detail: `The smoke check exited ${drill.healthExit ?? 'without a code'}.`,
      state: ok ? 'pass' : 'fail',
      result: ok ? 'Passed' : 'Failed',
    });
  }
  if (drill.resolvedAt) {
    out.push({
      ...common,
      id: `drill-resolved-${phase.id}`,
      at: drill.resolvedAt,
      icon: 'check-circle',
      title: 'Closed the incident',
      detail: drill.incident ? `Root cause: ${clamp(drill.incident.rootCause, 170)}` : 'The smoke check passes again.',
      state: 'pass',
      result: 'Closed',
    });
  }
  return out;
}

/** Every recorded event for the project, newest first. */
export function buildJournal(
  enrollment: EnrollmentView,
  details: Record<string, PhaseDetail>,
  records: Record<string, PhaseRecords>,
): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const bare of enrollment.phases) {
    // One join per phase, so every row this loop makes opens the same door.
    // `doorWithTasks` keeps the summary's own fields, which
    // is why the rows below still read `phase.title` and `phase.key`.
    const phase = doorWithTasks(bare, details);
    const detail = details[phase.id];
    const rec = records[phase.id];
    if (rec) {
      rec.runs.filter((r) => r.kind === 'run').forEach((r) => events.push(runEvent(r, phase)));
      rec.submissions.forEach((s, i) => events.push(submissionEvent(s, phase, i)));
      events.push(...hintEvents(rec.chat, phase));
    } else if (detail?.lastSubmission) {
      // Home warms the records of the phase the learner is on, not of
      // every open phase, so the journal's first commit has the shell's copy
      // and not yet the per-phase records. The newest verdict of every phase
      // is already in that copy, so the timeline opens with the rows a learner
      // came to read and the runs and hints fill in behind them: rather than
      // opening on a skeleton, or on a page missing its verdicts. The records
      // pass replaces this row with the same id, so nothing is drawn twice.
      events.push(submissionEvent(detail.lastSubmission, phase, Math.max(0, phase.attempts - 1)));
    }
    if (detail) events.push(...drillEvents(detail, phase));
    if (detail) events.push(...solutionEvents(detail, phase));
  }
  events.push(...releaseEvents(enrollment, details));
  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
