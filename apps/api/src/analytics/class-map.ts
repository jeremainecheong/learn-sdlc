import {
  EMPTY_STORY,
  RUNBOOK_FLOOR_IDS,
  changeFloorIds,
  evaluateDesignFloor,
  evaluateStoryFloor,
  recordCheckOf,
  type ClassMapNode,
  type FeedbackReport,
  type PhaseKey,
  type TestCaseResult,
} from '@learnsdlc/shared';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { ownsUnit } from '../content/task-units';
import { subjectToken, words } from '../feedback/impact';

/**
 * The class map's artefacts, derived from the content pack rather than listed
 * here: a node is something the pack already gates on (a rule, a reference
 * function, a mutant, a config file, the drill) so a new project gets a map
 * without anyone editing this file. Each node carries a probe that says how to
 * read one learner's latest report for it.
 */

export type NodeStatus = 'green' | 'red' | 'missing';

export type NodeProbe =
  /** Every named check must be 'passed'; a warning is a red, not a pass. */
  | { kind: 'rules'; ids: string[] }
  /** Test cases in the report that name this function, the way impact.ts matches. */
  | { kind: 'function'; name: string }
  | { kind: 'mutant'; name: string }
  | { kind: 'drill' };

export interface NodeSpec {
  id: string;
  label: string;
  kind: ClassMapNode['kind'];
  phase: PhaseKey;
  probe: NodeProbe;
}

/** Enough artefacts to read a class at a glance; a wall of nodes reads as noise. */
const MAX_NODES_PER_PHASE = 12;
const MAX_FUNCTION_NODES = 6;
const MAX_CHANGE_NODES = 3;

const PY_DEF = /(?:^|\n)[ \t]*def[ \t]+([A-Za-z_]\w*)[ \t]*\(/g;
/**
 * A JavaScript class body writes its methods bare (`completeTask(id) {`) so
 * the shape is the only marker. Control flow wears the same shape, hence the
 * keyword list.
 */
const JS_DEF = /(?:^|\n)[ \t]*(?:static[ \t]+)?(?:async[ \t]+)?(?:function[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\([^()]*\)[ \t]*\{/g;
const JS_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'do',
  'else',
  'return',
  'function',
  'constructor',
  'try',
  'with',
]);

/** Public definition names in a reference implementation, in source order. */
export function definitionNames(sources: string[], language: string): string[] {
  const names: string[] = [];
  const pattern = language === 'python' ? PY_DEF : JS_DEF;
  for (const source of sources) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1];
      if (name.startsWith('_')) continue;
      if (language !== 'python' && JS_KEYWORDS.has(name)) continue;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** The reference implementation a phase grades against, whichever kind it is. */
function referenceSources(phase: PhaseContent): string[] {
  const checks = phase.checks;
  if (checks.kind === 'code') return checks.solutionSources;
  if (checks.kind === 'tests') return Object.values(checks.implFiles);
  return [];
}

/**
 * The operations the pack itself calls out; the coverage keywords the testing
 * phase maps to story criteria. Everything else in the reference (`load`,
 * `save`, `get_task`) is plumbing, and a map of plumbing tells an instructor
 * nothing about who is stuck.
 */
function keySubjects(project: ProjectContent): Set<string> {
  const subjects = new Set<string>();
  for (const phase of project.phases) {
    if (phase.checks.kind !== 'tests') continue;
    for (const group of phase.checks.coverageKeywords) {
      for (const keyword of group.keywords) {
        const first = words(keyword)[0];
        if (first) subjects.add(first);
      }
    }
  }
  return subjects;
}

const isKeyFunction = (name: string, subjects: Set<string>): boolean =>
  words(name).some((word) => subjects.has(word));

/** Test cases that name this function, matched exactly as the impact report does. */
export function casesForFunction(name: string, cases: TestCaseResult[]): TestCaseResult[] {
  const full = words(name);
  if (!full.length) return [];
  const subject = subjectToken(name);
  return cases.filter((testCase) => {
    const caseWords = words(testCase.name);
    const spellsItOut = full.length > 1 && caseWords.join(' ').includes(full.join(' '));
    return spellsItOut || (subject !== null && caseWords.includes(subject));
  });
}

/**
 * A story phase's gates are the record check (`story.record`) and its floor
 * lines (`story.sentence`, `story.criteria.min`, …): the five checks every
 * graded record's report carries, labelled as the floor labels them for this
 * phase's numbers.
 */
function storyFloorIds(phase: PhaseContent): { id: string; label: string }[] {
  const checks = phase.checks;
  if (checks.kind !== 'story') return [];
  return [recordCheckOf({ error: null }), ...evaluateStoryFloor(EMPTY_STORY, checks.floor)].map(({ id, label }) => ({ id, label }));
}

/**
 * A design phase's gates are its floor rules for the switches the teacher set
 * (`design.record`, `design.entities.min`, …, `design.api.*` only with the API
 * contract on, `design.sequence` only with the sequence diagram on), labelled
 * as the floor labels them for this phase's numbers.
 */
function designFloorRules(phase: PhaseContent): { id: string; label: string }[] {
  const checks = phase.checks;
  if (checks.kind !== 'design') return [];
  return evaluateDesignFloor({}, checks).map(({ id, label }) => ({ id, label }));
}

/**
 * A design rule about the shape of the model or a contract draws as a
 * contract; the record, the decisions, the trace and the diagram as the story
 * around it.
 */
const DESIGN_CONTRACT_RULE = /^design\.(entities|relations|operations|api|screens)\./;

function ruleNodes(phase: PhaseContent): NodeSpec[] {
  const checks = phase.checks;
  if (checks.kind === 'design') {
    return designFloorRules(phase).map(({ id, label }) => {
      const kind: ClassMapNode['kind'] = DESIGN_CONTRACT_RULE.test(id) ? 'contract' : 'story';
      return { id: `${phase.key}:${kind}:${id}`, label, kind, phase: phase.key, probe: { kind: 'rules', ids: [id] } as NodeProbe };
    });
  }
  if (checks.kind === 'story') {
    return storyFloorIds(phase).map(({ id, label }) => ({
      id: `${phase.key}:story:${id}`,
      label,
      kind: 'story',
      phase: phase.key,
      probe: { kind: 'rules', ids: [id] } as NodeProbe,
    }));
  }
  return [];
}

function configNodes(phase: PhaseContent): NodeSpec[] {
  const checks = phase.checks;
  if (checks.kind !== 'config') return [];
  const nodes: NodeSpec[] = [];
  // One node per config file the rules target, holding every rule for it: an
  // instructor asks "who has a working Dockerfile", not "who matched rule 3".
  const byTarget = new Map<string, string[]>();
  for (const rule of checks.rules) {
    const target = rule.target || phase.key;
    const ids = byTarget.get(target);
    if (ids) ids.push(rule.id);
    else byTarget.set(target, [rule.id]);
  }
  for (const [target, ids] of byTarget) {
    nodes.push({
      id: `${phase.key}:file:${target}`,
      label: target,
      kind: 'file',
      phase: phase.key,
      probe: { kind: 'rules', ids },
    });
  }
  // The runbook record is one artefact, probed by its floor's rules.
  if (checks.runbook) {
    nodes.push({ id: `${phase.key}:file:runbook`, label: 'Runbook', kind: 'file', phase: phase.key, probe: { kind: 'rules', ids: [...RUNBOOK_FLOOR_IDS] } });
  }
  nodes.push({
    id: `${phase.key}:test:build-smoke`,
    label: 'build and smoke run',
    kind: 'test',
    phase: phase.key,
    probe: { kind: 'rules', ids: ['build-smoke'] },
  });
  if (checks.drill) {
    nodes.push({
      id: `${phase.key}:change:drill`,
      label: `drill: ${checks.drill.fault}`,
      kind: 'change',
      phase: phase.key,
      probe: { kind: 'drill' },
    });
  }
  return nodes;
}

function mutantNodes(phase: PhaseContent): NodeSpec[] {
  const checks = phase.checks;
  if (checks.kind !== 'tests') return [];
  const nodes: NodeSpec[] = checks.mutants.map((mutant) => ({
    id: `${phase.key}:mutant:${mutant.name}`,
    label: mutant.covers ? `${mutant.name} (${mutant.covers})` : mutant.name,
    kind: 'mutant' as const,
    phase: phase.key,
    probe: { kind: 'mutant', name: mutant.name } as NodeProbe,
  }));
  nodes.push({
    id: `${phase.key}:test:tests-on-correct`,
    label: 'suite passes on the reference implementation',
    kind: 'test',
    phase: phase.key,
    probe: { kind: 'rules', ids: ['tests-on-correct'] },
  });
  return nodes;
}

function codeNodes(phase: PhaseContent, subjects: Set<string>, earlier: string[]): NodeSpec[] {
  if (phase.checks.kind !== 'code') return [];
  const defined = definitionNames(referenceSources(phase), phase.language);
  const nodes: NodeSpec[] = [];
  // Anything the reference grows in a later phase is the change request: the
  // pack does not label it, but the diff against the earlier reference is the
  // change, and it is the one artefact a maintenance class turns on.
  const changed = defined.filter((name) => earlier.length > 0 && !earlier.includes(name));
  for (const name of changed.slice(0, MAX_CHANGE_NODES)) {
    nodes.push({
      id: `${phase.key}:change:${name}`,
      label: name,
      kind: 'change',
      phase: phase.key,
      probe: { kind: 'function', name },
    });
  }
  for (const name of defined.filter((n) => isKeyFunction(n, subjects)).slice(0, MAX_FUNCTION_NODES)) {
    nodes.push({
      id: `${phase.key}:function:${name}`,
      label: name,
      kind: 'function',
      phase: phase.key,
      probe: { kind: 'function', name },
    });
  }
  // The change request record is one artefact, probed by its floor's rules.
  const checks = phase.checks;
  if (checks.change) {
    nodes.push({
      id: `${phase.key}:file:change-request`,
      label: 'Change request',
      kind: 'file',
      phase: phase.key,
      probe: { kind: 'rules', ids: changeFloorIds(checks.change.contract) },
    });
  }
  nodes.push({
    id: `${phase.key}:test:hidden-tests`,
    label: 'hidden test suite',
    kind: 'test',
    phase: phase.key,
    probe: { kind: 'rules', ids: ['hidden-tests'] },
  });
  return nodes;
}

/**
 * Every artefact on the map, phase by phase. Node ids are stable across runs
 * (`<phase>:<kind>:<local id>`), which is what lets the web keep a selection
 * across a refresh.
 */
export function buildNodeSpecs(project: ProjectContent): NodeSpec[] {
  const subjects = keySubjects(project);
  const specs: NodeSpec[] = [];
  const seenDefinitions: string[] = [];
  for (const phase of [...project.phases].sort((a, b) => a.order - b.order)) {
    const nodes = [
      ...ruleNodes(phase),
      ...codeNodes(phase, subjects, seenDefinitions),
      ...mutantNodes(phase),
      ...configNodes(phase),
    ];
    // Only a `code` phase's own solution counts as "already written". A
    // `tests` phase mounts the whole application as `implFiles` so the learner
    // can read it and run it (the shipped testing phase mounts all of it,
    // comments included) and counting that as an earlier definition would
    // make the maintenance change request look like something the class had
    // already seen, which is the one node a maintenance class turns on.
    if (phase.checks.kind === 'code') {
      for (const name of definitionNames(referenceSources(phase), phase.language)) {
        if (!seenDefinitions.includes(name)) seenDefinitions.push(name);
      }
    }
    // A design phase's nodes are its floor's lines, at most thirteen by
    // construction (the record, the model, the decisions, the trace and the
    // switched-on contracts and diagram), and a line cut off the map would be
    // a gate an instructor can never see the class stuck on: so the cap does
    // not apply to them.
    specs.push(...(phase.checks.kind === 'design' ? nodes : nodes.slice(0, MAX_NODES_PER_PHASE)));
  }
  return specs;
}

/**
 * The four fields a probe reads off a report, and nothing else.
 *
 * On a split written phase the report a
 * `rules` probe has to read is **assembled** from the reports of the tasks that
 * own each rule (`ownedRuleReport` below), so the parameter cannot be a whole
 * `FeedbackReport`; there is no single revision to take the other fields from,
 * and inventing them would be this file making up a verdict. A real
 * `FeedbackReport` is assignable to this, so callers can pass one directly.
 */
export type ProbeReport = Pick<FeedbackReport, 'checks' | 'tests' | 'mutation' | 'drill'>;

/**
 * Which task owns each rule of a phase, keyed by rule id.
 *
 * The map is the whole of the per-task merge: a rule node's tally has to read
 * the report of the task that is graded by that rule, not whichever task the
 * learner happened to submit last. On a phase whose compiled list is the
 * synthesised sole task `ownsUnit` takes its phase-wide arm and every rule maps
 * to that one key, so the merge below is the identity, which is why the caller
 * only asks for it where a phase state carries more than one task's rows.
 *
 * A rule no task owns is left out rather than mapped to an arbitrary task:
 * `tasks-partition-units` refuses such a version at publish, and a rule with no
 * owner has no report to be read from, which the tally already spells
 * `missing`.
 */
export function ruleOwners(
  phase: PhaseContent,
  tasks: readonly CompiledTask[],
): Map<string, string> {
  const owners = new Map<string, string>();
  const checks = phase.checks;
  if (checks.kind === 'story') {
    // every floor line is the report of the task that owns the record
    const owner = tasks.find((task) => ownsUnit(phase, tasks, task, 'record', checks.record));
    if (owner) for (const { id } of storyFloorIds(phase)) owners.set(id, owner.taskKey);
    return owners;
  }
  if (checks.kind === 'design') {
    // every floor rule is the report of the task that owns the record (one task holds the record and the contracts)
    const owner = tasks.find((task) => ownsUnit(phase, tasks, task, 'record', checks.record));
    if (owner) for (const { id } of designFloorRules(phase)) owners.set(id, owner.taskKey);
    return owners;
  }
  // a record's floor rules are the report of the task that owns the record unit
  const record = checks.kind === 'config' && checks.runbook ? { id: checks.runbook.record, rules: [...RUNBOOK_FLOOR_IDS] as string[] }
    : checks.kind === 'code' && checks.change ? { id: checks.change.record, rules: changeFloorIds(checks.change.contract) as string[] } : null;
  if (record) {
    const owner = tasks.find((task) => ownsUnit(phase, tasks, task, 'record', record.id));
    if (owner) for (const id of record.rules) owners.set(id, owner.taskKey);
    if (checks.kind === 'code') return owners;
  }
  if (checks.kind !== 'config') return owners;
  for (const rule of checks.rules) {
    const owner = tasks.find((task) => ownsUnit(phase, tasks, task, 'rule', rule.id));
    if (owner) owners.set(rule.id, owner.taskKey);
  }
  return owners;
}

/**
 * One phase state's rule checks, each taken from the report of the task that
 * owns it.
 *
 * Only `checks` is filled, because only a `rules` probe reads this: the
 * `function`, `mutant` and `drill` probes are unreachable on a written phase
 * and keep reading the phase's newest revision. They need the same merge if
 * the executable kinds are ever split across tasks.
 *
 * A task that has never submitted contributes nothing, so its rules are absent
 * and the tally reads `missing`; honestly, rather than `red`.
 */
export function ownedRuleReport(
  owners: ReadonlyMap<string, string>,
  byTask: ReadonlyMap<string, ProbeReport | null | undefined>,
): ProbeReport {
  const checks: FeedbackReport['checks'] = [];
  for (const [ruleId, taskKey] of owners) {
    const found = (byTask.get(taskKey)?.checks ?? []).find((check) => check.id === ruleId);
    if (found) checks.push(found);
  }
  return { checks };
}

/**
 * How one learner stands on one node, read from their latest report for that
 * phase. 'missing' means the report says nothing about this artefact (no
 * submission yet, or a suite that never reached it) which is a different
 * thing from getting it wrong, and the map keeps the two apart.
 */
export function nodeStatus(spec: NodeSpec, report: ProbeReport | null | undefined): NodeStatus {
  if (!report) return 'missing';
  switch (spec.probe.kind) {
    case 'rules': {
      const seen = spec.probe.ids
        .map((id) => (report.checks || []).find((check) => check.id === id))
        .filter((check): check is NonNullable<typeof check> => !!check);
      if (!seen.length) return 'missing';
      return seen.every((check) => check.status === 'passed') ? 'green' : 'red';
    }
    case 'function': {
      const cases = casesForFunction(spec.probe.name, report.tests?.cases || []);
      if (!cases.length) return 'missing';
      return cases.every((testCase) => testCase.status === 'passed') ? 'green' : 'red';
    }
    case 'mutant': {
      const name = spec.probe.name;
      const row = report.mutation?.matrix?.find((entry) => entry.mutant === name);
      if (row) return row.killed ? 'green' : 'red';
      if (!report.mutation) return 'missing';
      // No matrix (an older report): the survivor list still says which lived.
      return report.mutation.survivors.some((s) => s.name === name) ? 'red' : 'green';
    }
    case 'drill': {
      const drill = report.drill;
      if (!drill) return 'missing';
      return drill.passedAfterFix && drill.diagnosisNamesFault ? 'green' : 'red';
    }
  }
}
