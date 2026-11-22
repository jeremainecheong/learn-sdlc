import { RUNBOOK_JSON, serialiseRunbook, validateRunbookRecord } from '@learnsdlc/shared';
import { LEGACY_RUNBOOK_FILE } from '../migrations/runbook-records/runbook-records';
import { runbookFromMarkdown, runbookSectionOf, type RunbookSection } from '../migrations/runbook-records/runbook-markdown';
import { lockedCriteriaOf, validateRunbookChecks } from './checks-validation';
import type { ConfigChecks } from './content.types';
import { conversionNote, markdownToRecord, notesMember, type LegacyPhaseInput, type LegacyPhaseOutput } from './record-legacy';
import { count, foldRuleSentences, leftOutNote, withRecordCriterion } from './rule-sentences';

export type { LegacyPhaseInput, LegacyPhaseOutput } from './record-legacy';

const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const RULE_SECTION: Record<string, RunbookSection> = { 'runbook-env': 'environment', 'runbook-health': 'health', 'runbook-rollback': 'rollback', 'runbook-data': 'data', 'runbook-incident': 'incident' };

/**
 * An older config Deployment (rules over `RUNBOOK.md`) as a Deployment with a
 * runbook: `RUNBOOK.md` becomes the starting record (its TODO
 * lines dropped, the template rule not applied: the file is the template);
 * the `runbook-*` rules and any rule on a markdown file are dropped, each
 * label kept as a sentence of its criterion; the floor takes the new-phase
 * defaults, a list minimum kept only where the older pack graded or headed
 * that section; `runbook_quality` is added when no runbook criterion
 * remains. Throws one fixed sentence on a markdown mount it cannot place,
 * and on words that would not fit the record.
 */
export function runbookChecksFromLegacy(input: LegacyPhaseInput): LegacyPhaseOutput<ConfigChecks> {
  const checks = input.checks as ConfigChecks;
  const hasDrill = !!checks.drill;
  const swapped = markdownToRecord(input.files, {
    phase: 'Deployment',
    markdown: LEGACY_RUNBOOK_FILE,
    record: RUNBOOK_JSON,
    recordName: 'runbook record',
    read: (text) => {
      const parse = runbookFromMarkdown(text, { dropTodo: true, incidentToNotes: hasDrill });
      return serialiseRunbook({ ...parse.runbook, ...notesMember(parse.notes) });
    },
    valid: (record) => !validateRunbookRecord(record).error,
  });
  const markdown = input.files.find((f) => f.path === LEGACY_RUNBOOK_FILE);
  const dropped = checks.rules.filter((r) => r.id.startsWith('runbook-') || isMarkdown(r.target ?? ''));
  const graded = new Set(dropped.map((r) => RULE_SECTION[r.id]).filter(Boolean));
  const headed = new Set((markdown?.content ?? '').split('\n').filter((l) => /^##(?!#)/.test(l)).map((l) => runbookSectionOf(l.slice(2))));
  const floor = { ...validateRunbookChecks({}, 'deployment', hasDrill).floor };
  for (const [section, key] of [['environment', 'minEnvironment'], ['health', 'minHealth'], ['rollback', 'minRollback'], ['data', 'minData']] as const) {
    if (!graded.has(section) && !headed.has(section)) floor[key] = 0;
  }
  floor.requireIncident = hasDrill || graded.has('incident') || headed.has('incident');
  const folded = foldRuleSentences(input.rubric, dropped, input.teacherWorded ?? new Set());
  const next: ConfigChecks = { ...checks, rules: checks.rules.filter((r) => !dropped.includes(r)), runbook: { record: RUNBOOK_JSON, floor } };
  let rubric = folded.rubric;
  const locked = new Set(lockedCriteriaOf(next));
  if (rubric && !rubric.criteria.some((c) => !locked.has(c.key))) {
    rubric = withRecordCriterion(rubric, { key: 'runbook_quality', title: 'Runbook quality', description: 'Each runbook section is written for an operator who was not on the call.', weight: 0 });
    folded.notes.push('runbook_quality added, the other weights scaled by 0.85');
  }
  const left = leftOutNote(folded.left);
  if (left) folded.notes.push(left);
  const moved = [
    count(dropped.length, 'runbook rule became a criterion sentence', 'runbook rules became criterion sentences'),
    ...(swapped.from ? [`${swapped.from} became the starting runbook`] : []),
    ...folded.notes,
  ];
  return { files: swapped.files, checks: next, rubric, note: conversionNote('Deployment converted to the runbook record', moved) };
}
