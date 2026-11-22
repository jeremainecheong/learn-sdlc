import {
  countTestMethods,
  dockerEntrypoint,
  evaluateRules,
  smokeArgvFor,
  stripCodeComments,
} from '../feedback/checkers';
import { Logger } from '@nestjs/common';
import { buildDrillReport } from '../feedback/drill';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config';
import { SandboxService } from '../execution/sandbox.service';
import { ContentService } from './content.service';
import { STORY_SCORES_ALL, scoredKeysFor, scoredRubricKeys } from './rubric-scoring';
import { hasRecord, recordCriteriaOf } from './checks-validation';
import { CONFIG_SMOKE_KEY, FIXED_SCORER_KEYS } from '@learnsdlc/shared';
import {
  CHANGE_REQUEST_JSON, RUNBOOK_JSON, evaluateDesignFloor, evaluateRunbookFloor, evaluateStoryFloor, parseStoryJson, validateChangeRequestRecord, validateDesignRecord,
} from '@learnsdlc/shared';
import { PhaseContent, ProjectContent } from './content.types';
import { soleTaskFor } from './pack-compiler';
import { folderPack, writeConverted } from '../../test/fixtures/folder-packs';

const PHASE_KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

/** A single-service Dockerfile a learner could hand in: WORKDIR and ENTRYPOINT agree. */
const WORKING_DOCKERFILE: Record<string, string> = {
  python: 'FROM python:3.11-slim\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["python", "cli.py"]\n',
  javascript: 'FROM node:22-slim\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["node", "cli.js"]\n',
};

/**
 * The api image of a two-service pack. It is a *pair* with the compose file:
 * this build check asks whether the web service can reach the api service, and
 * a Dockerfile alone cannot answer that.
 */
const WORKING_API_DOCKERFILE =
  'FROM python:3.11-slim\nWORKDIR /app\nCOPY requirements.txt ./\nCOPY api/ ./api/\n' +
  'COPY ops/ ./ops/\nCOPY docker-compose.yml ./\n' +
  'RUN pip install --no-cache-dir -r requirements.txt\n' +
  'ENV TASKTRACKR_DB=/data/tasktrackr.db\nENV HOST=0.0.0.0\nENV PORT=8000\n' +
  'VOLUME ["/data"]\nEXPOSE 8000\nENTRYPOINT ["python3", "api/main.py"]\n';

/**
 * A finished deployment workspace, keyed by the Dockerfile the pack's smoke run
 * builds. Nothing here is the pack's own scaffold: the point of every test that
 * uses it is what happens to a learner who has finished the phase.
 */
const workingDeployment = (project: ProjectContent, phase: PhaseContent): Record<string, string> => {
  if (phase.checks.kind !== 'config') throw new Error('expected config checks');
  if (phase.checks.smokeDockerfile !== 'api/Dockerfile') {
    return { [phase.checks.smokeDockerfile]: WORKING_DOCKERFILE[project.language] };
  }
  // the finished compose file is the smoke run's own copy (smoke/docker-compose.yml), the bytes the
  // reference deployment starts from; canonical/ is a maintainers' reference no loader reads
  const compose = phase.checks.smokeImplFiles['docker-compose.yml'];
  if (compose === undefined) throw new Error(`${project.slug}: the smoke run ships no docker-compose.yml`);
  return { 'api/Dockerfile': WORKING_API_DOCKERFILE, 'docker-compose.yml': compose };
};

/**
 * Bundle integrity for every reference project. Each check runs over
 * content.listProjects(), so a bundle in a new language gets exactly the
 * same scrutiny as the original Python one.
 */
describe('ContentService (bundle integrity, every project)', () => {
  let content: ContentService;
  let projects: ProjectContent[];

  beforeAll(() => {
    content = new ContentService();
    content.loadAll();
    projects = content.listProjects();
  });

  const eachProject = (fn: (project: ProjectContent) => void) => {
    // the tree ships one pack, and every check below still runs over every pack the catalogue holds: the test above proves
    // the catalogue is the directory, so a pack the loader skipped is caught
    // there rather than by a count here.
    expect(projects.length).toBeGreaterThanOrEqual(1);
    for (const project of projects) fn(project);
  };

  const learnerFile = (phase: PhaseContent, path: string): string =>
    phase.files.find((f) => f.path === path)?.content || '';

  const editableTargets = (phase: PhaseContent): string[] =>
    phase.files.filter((f) => f.editable).map((f) => f.path);

  it('loads every pack the content directory ships, each in the languages it declares', () => {
    // the catalogue is the directory, not a list in a spec: a pack the loader
    // silently skipped would look exactly like a pack nobody had written
    const onDisk = fs
      .readdirSync(config.contentDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(config.contentDir, d.name, 'project.json')))
      .map((d) => d.name)
      .sort();
    expect(projects.map((p) => p.slug).sort()).toEqual(onDisk);
    expect(onDisk).toContain('tasktrackr');
    for (const project of projects) {
      // `language` is the pack's primary and is always one of `languages`,
      // which is what a run's language is held against
      expect(project.languages).toContain(project.language);
      for (const language of project.languages) {
        expect(['python', 'javascript', 'typescript']).toContain(language);
      }
    }
  });

  it('declares a version in every pack, and exposes it on the loaded project', () => {
    eachProject((project) => {
      // authored, not inferred: read the pack's own project.json
      const meta = JSON.parse(
        fs.readFileSync(path.join(config.contentDir, project.slug, 'project.json'), 'utf-8'),
      );
      expect({ slug: project.slug, declared: typeof meta.version }).toEqual({
        slug: project.slug,
        declared: 'string',
      });
      expect({ slug: project.slug, version: project.version }).toEqual({
        slug: project.slug,
        version: meta.version,
      });
      // MAJOR.MINOR.PATCH, and short enough to store beside every enrolment
      // and every graded submission
      expect(project.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
      expect(project.version.length).toBeLessThanOrEqual(32);
    });
  });

  it('gives every project the same six ordered phases, all in the project language', () => {
    eachProject((project) => {
      expect(project.phases.map((p) => p.key)).toEqual(PHASE_KEYS);
      expect(project.phases.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const phase of project.phases) expect(phase.language).toBe(project.language);
    });
  });

  it('gives every phase a task panel, objectives, files and an assistant bundle', () => {
    eachProject((project) => {
      for (const phase of project.phases) {
        expect(phase.taskPanel.length).toBeGreaterThan(100);
        expect(phase.objectives.length).toBeGreaterThanOrEqual(2);
        expect(phase.files.length).toBeGreaterThan(0);
        expect(phase.files.some((f) => f.editable)).toBe(true);
        expect(phase.assistant.systemPrompt).toContain(phase.key.toUpperCase());
        expect(phase.assistant.progressive.length).toBeGreaterThanOrEqual(3);
        expect(phase.assistant.topics.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  it('tells every learner what good looks like and how to use the mentor', () => {
    eachProject((project) => {
      for (const phase of project.phases) {
        expect(phase.taskPanel).toMatch(/what good looks like/i);
        expect(phase.taskPanel).toMatch(/mentor/i);
      }
    });
  });

  it('scores every rubric key it declares, and declares every key the grader scores', () => {
    eachProject((project) => {
      for (const phase of project.phases) {
        // `assembleCriteria` reads `scores.get(key) ?? 0`, so a criterion the
        // grader never sets is a flat zero with no evidence, and a rule or a
        // scorer key with no criterion is graded into nothing
        const declared = phase.rubric.criteria.map((c) => c.key).sort();
        // a story phase's floor scores every criterion its rubric declares
        const scored = [...scoredKeysFor(phase.checks, phase.rubric)].sort();
        expect({ phase: `${project.slug}/${phase.key}`, scored }).toEqual({
          phase: `${project.slug}/${phase.key}`,
          scored: declared,
        });
      }
    });
  });

  it('scoredRubricKeys answers the phase’s question unchanged when given no units', () => {
    // The function takes an optional `units`, so a compile rule can
    // ask what a *task* is scored on. The phase-level question must not move
    // by a character: `loadRubric`'s boot check on every shipped pack is the
    // caller that passes nothing, and a narrower answer there would re-judge a
    // rubric that has been right since the pack shipped.
    eachProject((project) => {
      for (const phase of project.phases) {
        // a story or a design phase answers with the sentinel; a phase with a record answers its locked keys and the sentinel
        const record = recordCriteriaOf(phase.checks, phase.rubric);
        const declared =
          phase.checks.kind === 'story' || phase.checks.kind === 'design'
            ? [STORY_SCORES_ALL]
            : hasRecord(phase.checks)
              ? [...phase.rubric.criteria.map((c) => c.key).filter((key) => !record.includes(key)), STORY_SCORES_ALL].sort()
              : phase.rubric.criteria.map((c) => c.key).sort();
        expect([...scoredRubricKeys(phase.checks)].sort()).toEqual(declared);
        // and a synthesised sole task owns every unit the phase declares, so
        // the narrowed answer is the same set
        expect([...scoredRubricKeys(phase.checks, soleTaskFor(phase).gradedUnits)].sort()).toEqual(
          declared,
        );
      }
    });
  });

  it('keeps the declared scorer keys the ones the grader actually sets', () => {
    // the fixed sets are a copy of literals in another file, so hold them
    // against that file: a new scored key has to reach the packs' rubrics
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'feedback', 'feedback.service.ts'),
      'utf-8',
    );
    const declared = [...FIXED_SCORER_KEYS.code, ...FIXED_SCORER_KEYS.tests, CONFIG_SMOKE_KEY];
    const set = [...source.matchAll(/scores\.set\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(set.length).toBeGreaterThanOrEqual(declared.length);
    for (const key of set) expect(declared).toContain(key);
    for (const key of declared) expect(source).toContain(`'${key}'`);
  });

  it('has rubric weights summing to 1 in every phase', () => {
    eachProject((project) => {
      for (const phase of project.phases) {
        const sum = phase.rubric.criteria.reduce((s, c) => s + c.weight, 0);
        expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
        expect(phase.rubric.passThreshold).toBe(70);
      }
    });
  });

  it('ships hidden tests and a solution for every code phase, with stubs in the learner file', () => {
    eachProject((project) => {
      for (const phase of project.phases) {
        if (phase.checks.kind !== 'code') continue;
        expect(Object.keys(phase.checks.hiddenTestFiles).length).toBeGreaterThan(0);
        expect(phase.checks.solutionSources.length).toBeGreaterThan(0);
        for (const target of phase.checks.editableTargets) {
          const learner = learnerFile(phase, target);
          expect(learner).toMatch(/TODO\(learner\)/);
          // a TypeScript stub is rendered, so it must not throw; the phrase it
          // can honestly carry is the one both languages share
          expect(learner).toMatch(/NotImplementedError|not implemented yet/);
          // the answer is not the stub. Naming one assignment in one file of
          // one pack (`task.completed = True`) would say nothing about the
          // other targets and would move the day the pack did. Per target, in either language: the pack answers this
          // path, and whatever marks the gap is gone from the answer.
          const solution = phase.checks.solutionFiles[target];
          expect({ target, answered: typeof solution }).toEqual({ target, answered: 'string' });
          expect(solution).not.toMatch(/TODO\(learner\)/);
          expect(solution).not.toMatch(/NotImplementedError|not implemented yet/);
          expect(solution).not.toBe(learner);
        }
      }
    });
  });

  it('adds a stubbed change request on top of the finished code in maintenance', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'maintenance');
      if (phase.checks.kind !== 'code') throw new Error('expected code checks');
      // the change request is comments on a task and a count on
      // the row. `editableTargets[0]` is `api/repository/tasks.py`, which
      // carries the code phase 3 already finished, so reading the request out
      // of it would pass while proving nothing: it is read where it is written.
      const learner = learnerFile(phase, 'api/repository/comments.py');
      expect(learner).toContain('def add_comment');
      expect(learner).toContain('def list_comments');
      expect(phase.checks.solutionSources.join('')).toContain('def add_comment');
      const suites = Object.keys(phase.checks.hiddenTestFiles);
      expect(suites.some((s) => /change/.test(s))).toBe(true);
      expect(suites.some((s) => /regression/.test(s))).toBe(true);
    });
  });

  it('ships eight mutants over two runs, each replacing its own run’s implementation', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'testing');
      if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
      const names = phase.checks.mutants.map((m) => m.name).sort();
      expect(names).toEqual([
        'badge_ignores_completion',
        'complete_does_not_persist',
        'complete_unknown_returns_200',
        'filter_keyword_case_sensitive',
        'filters_drop_the_search',
        'overdue_includes_done',
        'overdue_includes_due_today',
        'priority_order_reversed',
      ]);
      // the bugs are planted in both layers, which is the claim the
      // kill matrix makes. Without this a later author can quietly move all
      // eight into Python and every column of the grid still reads green.
      expect([...new Set(phase.checks.mutants.map((m) => m.run))].sort())
        .toEqual(phase.checks.runs.map((r) => r.id).sort());
      for (const mutant of phase.checks.mutants) {
        const run = phase.checks.runs.find((r) => r.id === mutant.run);
        // a mutant lands on the implementation of its own run: one that lands
        // anywhere else is never executed, so it can never be killed
        for (const at of Object.keys(mutant.files)) {
          expect({ mutant: mutant.name, at, lands: Object.keys(run?.implFiles || {}).includes(at) })
            .toEqual({ mutant: mutant.name, at, lands: true });
        }
        expect(mutant.description.length).toBeGreaterThan(20);
      }
      // the task panel describes mutation testing without naming the variants
      for (const mutant of phase.checks.mutants) expect(phase.taskPanel).not.toContain(mutant.name);
    });
  });

  it('ships a reference acceptance suite beside the mutants it has to kill', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'testing');
      if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
      const checks = phase.checks;
      // it lands on the very path the graders run, so the suite the pack
      // proves itself with is the suite a learner would hand in
      expect(Object.keys(checks.referenceTestFiles)).toEqual(checks.learnerTestFiles);
      const source = Object.values(checks.referenceTestFiles).join('\n');
      expect(source).not.toMatch(/TODO\(learner\)/);
      // each run is read in its own language, the way
      // `buildTestsReport` reads it. `countTestMethods(…, 'python')` finds
      // none of a `.tsx` file's `test(` cases, so `minTests` would be measured
      // against the API half alone; and the Python stripper does not know `//`,
      // so a front-end comment naming a behaviour would satisfy the coverage
      // rule that this suite exists to earn honestly.
      const runSources = checks.runs.map((run) => Object.values(run.referenceTestFiles).join('\n'));
      for (const [at, run] of checks.runs.entries()) {
        expect({ run: run.id, files: Object.keys(run.referenceTestFiles).length })
          .toEqual({ run: run.id, files: run.learnerTestFiles.length });
        expect(countTestMethods(runSources[at], run.language)).toBeGreaterThan(0);
      }
      const counted = checks.runs.reduce(
        (total, run, at) => total + countTestMethods(runSources[at], run.language),
        0,
      );
      expect(counted).toBeGreaterThanOrEqual(checks.minTests);
      // and it is a finished suite, not the stub template the learner opens
      const template = phase.files.find((f) => f.path === checks.learnerTestFiles[0]);
      expect(template?.content).toMatch(/TODO\(learner\)/);
      expect(source).not.toBe(template?.content);
      // full marks on the grader's own coverage rule: every keyword group is
      // named by the suite once its comments are stripped
      const stripped = checks.runs
        .map((run, at) => stripCodeComments(runSources[at], run.language))
        .join('\n')
        .toLowerCase();
      for (const group of checks.coverageKeywords) {
        expect({
          group: `${project.slug}/${group.criterion}`,
          covered: group.keywords.some((k) => stripped.includes(k.toLowerCase())),
        }).toEqual({ group: `${project.slug}/${group.criterion}`, covered: true });
      }
    });
  });

  it('never lets an untouched scaffold pass its written floor', () => {
    eachProject((project) => {
      for (const key of ['requirements', 'design'] as const) {
        const phase = content.getPhase(project.slug, key);
        if (phase.checks.kind === 'story') {
          // a story phase's scaffold is its seeded record, held to the floor
          const seeded = parseStoryJson(learnerFile(phase, phase.checks.record));
          expect(evaluateStoryFloor(seeded, phase.checks.floor).some((one) => !one.passed)).toBe(true);
          continue;
        }
        if (phase.checks.kind === 'design') {
          // a design phase's scaffold is its starting record and contracts, held to the floor
          const seeded = content.executionFiles(phase, {});
          expect(evaluateDesignFloor(seeded, phase.checks).some((one) => !one.passed)).toBe(true);
          continue;
        }
        throw new Error(`expected story or design checks on ${key}, got ${phase.checks.kind}`);
      }
    });
  });

  it('does not reward the design scaffold for its own empty rows', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'design');
      if (phase.checks.kind !== 'design') throw new Error('expected design checks');
      const outcomes = evaluateDesignFloor(content.executionFiles(phase, {}), phase.checks);
      // the empty operation rows (no input, no return) and the blank decision
      // (no rationale, no trade-off) are the scaffold's, not the learner's
      for (const id of ['design.operations.shape', 'design.decisions.shape']) {
        expect([id, outcomes.find((one) => one.id === id)?.passed]).toEqual([id, false]);
      }
    });
  });

  it('does not reward the starting runbook record: its named, unfilled items fall short of the floor', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'deployment');
      if (phase.checks.kind !== 'config' || !phase.checks.runbook) throw new Error('expected config checks with a runbook');
      const outcomes = evaluateRunbookFloor(content.executionFiles(phase, {})[RUNBOOK_JSON], phase.checks.runbook.floor);
      expect(outcomes.filter((o) => !o.passed).length).toBeGreaterThanOrEqual(3);
    });
  });

  it('leaves no coverage keyword in the stripped test template', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'testing');
      if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
      // stripped per run, in that run's own language. The Python
      // stripper does not know `//` or `/* */`, so a front-end scaffold's
      // header comment, which names the behaviours to cover, exactly as the
      // Python docstring does: would survive it and hand the learner the very
      // keyword this test says the template must not contain.
      const template = phase.checks.runs
        .map((run) =>
          stripCodeComments(
            run.learnerTestFiles.map((t) => learnerFile(phase, t)).join('\n'),
            run.language,
          ),
        )
        .join('\n');
      for (const group of phase.checks.coverageKeywords) {
        for (const keyword of group.keywords) {
          expect(template.toLowerCase()).not.toContain(keyword.toLowerCase());
        }
      }
    });
  });

  it('keeps the solution out of the mentor hints', () => {
    // the concrete lines a learner could paste: the completing assignment,
    // the overdue comparison, and the "reuse filter(open)" call
    const leaks = [
      /completed\s*=\s*(true|false)/i,
      /due_?date\s*<=?\s*today/i,
      /filter_tasks\(['"]open['"]\)/,
      /filterTasks\(\{\s*status\s*:\s*['"]open['"]\s*\}\)/,
    ];
    eachProject((project) => {
      for (const phase of project.phases) {
        const hints = [
          ...phase.assistant.progressive,
          ...phase.assistant.topics.flatMap((t) => t.hints),
        ];
        for (const hint of hints) {
          for (const leak of leaks) expect(hint).not.toMatch(leak);
        }
      }
    });
  });

  it('separates locked content from learner workspace overlays', () => {
    eachProject((project) => {
      // the first phase that ships locked files beside the learner's own
      // (Requirements holds the record alone, and Design its three documents)
      const phase = project.phases.find((one) => one.files.some((f) => f.editable) && one.files.some((f) => !f.editable))!;
      expect(phase).toBeDefined();
      const [editable] = editableTargets(phase);
      const locked = phase.files.find((f) => !f.editable)!;
      const files = content.executionFiles(phase, { [editable]: 'OVERLAY' });
      expect(files[editable]).toBe('OVERLAY');
      expect(files[locked.path]).toBe(locked.content);
      const tampered = content.executionFiles(phase, { [locked.path]: 'HACK' });
      expect(tampered[locked.path]).toBe(locked.content);
    });
  });

  it('ships an editable record beside the requirements and design artefacts', () => {
    eachProject((project) => {
      const requirements = content.getPhase(project.slug, 'requirements');
      const story = requirements.files.find((f) => f.path === 'requirements/story.json');
      expect(story?.editable).toBe(true);
      expect(story?.language).toBe('json');
      const record = JSON.parse(story?.content || '');
      expect(record.id).toBe('US-4');
      // the record ships empty: US-4 is the learner's story to write
      expect(record.criteria).toEqual([]);
      expect(record.scopeExclusions).toEqual([]);
      for (const key of ['title', 'persona', 'capability', 'benefit', 'notes']) {
        expect(record[key]).toBe('');
      }

      const design = content.getPhase(project.slug, 'design');
      const contract = design.files.find((f) => f.path === 'design/design.json');
      expect(contract?.editable).toBe(true);
      expect(contract?.language).toBe('json');
      // the starting record is a valid design record; its three operation
      // names are the phase's, not the learner's, and everything else on each
      // is left for the learner to fill
      const parsed = validateDesignRecord(contract?.content || '').design!;
      expect(parsed.operations.map((one) => one.name)).toEqual(['completeTask(id)', 'listTasks(listId, filters)', 'getOverdue(today)']);
      for (const operation of parsed.operations) {
        expect([operation.inputs, operation.returns, operation.errors, operation.satisfies]).toEqual([[], '', [], []]);
      }
      // the design phase writes three documents: the record and the two
      // contracts the next phases are held to. The contract ledger reads all
      // three, and `design/design.json` deliberately sits before the contracts
      // so `seedCarriedArtefacts` finds the record first.
      expect(content.designFilesFor(project)).toEqual([
        'design/design.json',
        'shared/contract/api.json',
        'shared/contract/screens.json',
      ]);
    });
  });

  it('files every keyword group and every mutant against a story criterion', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'testing');
      if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
      const criterionId = /^US-\d+\/AC-\d+$/;
      const declared = phase.checks.coverageKeywords.map((g) => g.criterionId);
      expect(declared).toHaveLength(4);
      for (const id of declared) expect(id).toMatch(criterionId);

      const covers = phase.checks.mutants.map((m) => m.covers);
      expect(covers).toHaveLength(8);
      for (const id of covers) expect(id).toMatch(criterionId);
      // one mutant per criterion: a duplicate would hide a criterion with no
      // evidence behind another mutant's kill
      expect(new Set(covers).size).toBe(covers.length);

      // every id that names an approved story names a criterion that exists
      const requirements = content.getPhase(project.slug, 'requirements');
      if (requirements.checks.kind !== 'story') throw new Error('expected story checks');
      const { providedStories, learnerStory } = requirements.checks;
      for (const id of [...declared, ...covers]) {
        const [story, ac] = (id as string).split('/');
        // the learner's own story mints its criteria; the backlog only names the gap
        if (story === learnerStory.id) continue;
        const provided = providedStories.find((one) => one.id === story);
        expect({ id, declared: (provided?.criteria ?? []).some((c) => c.id === ac) }).toEqual({ id, declared: true });
      }
    });
  });

  it('makes every config phase declare its own smoke commands, in the project language', () => {
    const launchers: Record<string, string[]> = { python: ['python', 'python3'], javascript: ['node'] };
    eachProject((project) => {
      // declared by the pack itself, not inherited: read the authored JSON of each phase folder
      const packDir = path.join(config.contentDir, project.slug);
      const folders = fs.readdirSync(path.join(packDir, 'phases'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(packDir, 'phases', d.name, 'phase.json')))
        .map((d) => `phases/${d.name}`);
      expect(folders.length).toBeGreaterThan(0);
      for (const rel of folders) {
        const spec = JSON.parse(fs.readFileSync(path.join(packDir, rel, 'phase.json'), 'utf-8'));
        if (spec.checks?.kind !== 'config') continue;
        const smoke = spec.checks.smoke || {};
        expect({ phase: `${project.slug}/${rel}`, declares: Array.isArray(smoke.commands) })
          .toEqual({ phase: `${project.slug}/${rel}`, declares: true });
        expect({ phase: `${project.slug}/${rel}`, expects: typeof smoke.expect })
          .toEqual({ phase: `${project.slug}/${rel}`, expects: 'string' });
      }

      const configPhases = project.phases.filter((p) => p.checks.kind === 'config');
      expect(configPhases.length).toBeGreaterThan(0);
      for (const phase of configPhases) {
        if (phase.checks.kind !== 'config') throw new Error('expected config checks');
        expect(phase.checks.smokeCommands.length).toBeGreaterThan(0);
        for (const argv of phase.checks.smokeCommands) {
          // no shared default: a pack that omitted `commands` inherited a
          // python3 argv whatever language it was written in, and scored
          // every learner zero on a criterion worth a third of the phase
          expect(launchers[project.language]).toContain(argv[0]);
          expect(phase.checks.smokeImplFiles[argv[1]]).toBeDefined();
        }
      }
    });
  });

  it('expects what the reference implementation prints, not the words the command passes in', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'deployment');
      if (phase.checks.kind !== 'config') throw new Error('expected config checks');
      const passedIn = new Set(
        phase.checks.smokeCommands.flatMap((argv) => argv.slice(1).flatMap((a) => a.split(/\s+/))),
      );
      const own = phase.checks.expectInOutput.split(/\s+/).filter((w) => w && !passedIn.has(w));
      // an expectation made only of the arguments the command already passes
      // in is met by any program that echoes them, which is how a container
      // that never started the CLI earned full build points
      expect(own).not.toEqual([]);
      const reference = Object.values(phase.checks.smokeImplFiles).join('\n');
      expect(own.filter((w) => reference.includes(w))).not.toEqual([]);
    });
  });

  it('ships an incident drill the config rules cannot see', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'deployment');
      const checks = phase.checks;
      if (checks.kind !== 'config') throw new Error('expected config checks');
      const drill = content.drillSpec(phase);
      expect(drill?.expectFailure).toBe(true);
      // the fault is a compose setting, not a Dockerfile directive.
      // The property the literal 'Dockerfile' stood in for is pack-agnostic and
      // is the one worth asserting: a fault the learner cannot open and edit is
      // a fault they cannot fix, and the drill would never close.
      const editable = new Set(phase.files.filter((f) => f.editable).map((f) => f.path));
      const faultedPaths = Object.keys(drill?.faultedFiles || {});
      expect(faultedPaths.length).toBeGreaterThan(0);
      for (const at of faultedPaths) {
        expect({ at, editable: editable.has(at) }).toEqual({ at, editable: true });
      }

      // the drill report credits a diagnosis that names what broke, so the
      // pack's own description has to name it. Asserted through the real
      // builder rather than through a regex over the directives one pack
      // happened to use: `faultTokens` reads a SCREAMING_SNAKE setting out of
      // the description exactly as it reads a directive.
      const named = (drill?.description || '').match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b(?:ENTRYPOINT|CMD|WORKDIR|COPY)\b/);
      expect(named).not.toBeNull();
      const diagnosis = (line: string) =>
        buildDrillReport({
          fault: drill!.fault,
          description: drill!.description,
          failedBeforeFix: true,
          passedAfterFix: true,
          incident: { rootCause: line, fix: 'changed the line' },
          beforeStderr: '',
          afterStdout: '',
        }).diagnosisNamesFault;
      expect(diagnosis(`${named![0]} was wrong, so the web service never reached the api service`)).toBe(true);
      expect(diagnosis('something in the deployment was broken')).toBe(false);

      // every rule over the Dockerfile the smoke run builds still passes on the
      // faulted copy: the fault is in what the deployment means, not in
      // anything a regex can read. It is filtered to that file on purpose:
      // `compose-api-url` is deliberately NOT blind to this fault, so a learner
      // who makes the drill's own mistake is told twice, by the rule and by
      // the build check. The workspace is a FINISHED one: the fault is in the
      // compose file, so reading the pack's own scaffold here would fail
      // these rules for the TODO markers and prove nothing about the drill.
      const files = content.faultedExecutionFiles(phase, workingDeployment(project, phase)) || {};
      const blind = checks.rules.filter((r) => r.target === checks.smokeDockerfile);
      expect(blind.length).toBeGreaterThanOrEqual(4);
      for (const outcome of evaluateRules(blind, (t) => files[t || ''] || '')) {
        expect(outcome.passed).toBe(true);
      }
    });
  });

  it('gates the incident record on naming the setting that broke', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'deployment');
      if (phase.checks.kind !== 'config' || !phase.checks.runbook) throw new Error('expected config checks with a runbook');
      // the runbook floor requires the incident, and its criterion is in the rubric
      expect(phase.checks.runbook.floor.requireIncident).toBe(true);
      expect(recordCriteriaOf(phase.checks, phase.rubric)).toEqual(['runbook_quality']);
      const sum = phase.rubric.criteria.reduce((s, c) => s + c.weight, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      // the drill's diagnosis reads the incident's root cause for the fault this pack
      // actually plants, whose name is a compose setting rather than a directive
      const fault = content.drillSpec(phase)!;
      const token = fault.description.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      expect(token).not.toBeNull();
      const names = (rootCause: string) => buildDrillReport({ fault: fault.fault, description: fault.description, failedBeforeFix: true, passedAfterFix: true, beforeStderr: '', afterStdout: '', incident: { rootCause, fix: 'changed the line' } }).diagnosisNamesFault;
      expect(names(`${token![0]} pointed the web service at its own container.`)).toBe(true);
      // saying something broke without naming what earns nothing
      expect(names('the container was broken on start.')).toBe(false);
    });
  });

  it('ships the release record artefacts in maintenance', () => {
    eachProject((project) => {
      const phase = content.getPhase(project.slug, 'maintenance');
      const contracts = phase.files.find((f) => f.path === 'design/contracts.json');
      expect(contracts?.editable).toBe(true);
      expect(contracts?.language).toBe('json');
      // ships empty: the workflow seeds it from the learner's own design record
      expect(JSON.parse(contracts?.content || '')).toEqual({ operations: [] });

      if (phase.checks.kind !== 'code' || !phase.checks.change) throw new Error('expected code checks with a change request');
      const record = phase.files.find((f) => f.path === CHANGE_REQUEST_JSON);
      expect(record?.editable).toBe(true);
      expect(record?.language).toBe('json');
      // the 2.1.0 release is a version and nothing else: the change request is the learner's to write
      const change = validateChangeRequestRecord(record?.content ?? '', phase.checks.ticket!.acceptance.map((a) => a.id)).change;
      expect(change?.release).toEqual({ version: '2.1.0', summary: '', changes: [], rollback: '' });
    });
  });
});

/**
 * A pack whose config phase leaves out part of `checks.smoke` has to say so at
 * boot. Falling back to a hard-coded python3 command and the string "Ship the
 * release" would make a pack in another language, or one whose CLI prints
 * something else, score every learner zero on a criterion worth a
 * third of the phase with nothing in the logs to explain it.
 */
describe('ContentService (a config phase declares its own smoke check)', () => {
  /** Copy one pack, edit its deployment smoke block, and load that copy. */
  const withPackSmoke = (mutate: (checks: any) => void): (() => void) => {
    const source = path.join(config.contentDir, 'tasktrackr');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-content-'));
    fs.cpSync(source, path.join(root, 'tasktrackr'), { recursive: true });
    const phaseJson = path.join(root, 'tasktrackr', 'phases', '05-deployment', 'phase.json');
    const spec = JSON.parse(fs.readFileSync(phaseJson, 'utf-8'));
    mutate(spec.checks);
    fs.writeFileSync(phaseJson, JSON.stringify(spec, null, 2));
    return () => {
      const original = config.contentDir;
      (config as any).contentDir = root;
      try {
        new ContentService().loadAll();
      } finally {
        (config as any).contentDir = original;
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
  };

  // the folder layout holds the smoke run's files in smoke/, never in the block, so the block
  // that declares no commands is the one that names nothing at all
  it('refuses a smoke block that declares no commands, its files only in smoke/', () => {
    expect(withPackSmoke((checks) => {
      checks.smoke = {};
    })).toThrow(/checks\.smoke\.commands is required/);
  });

  it('refuses a command that is not in the project language', () => {
    expect(withPackSmoke((checks) => {
      checks.smoke.commands = [['ruby', 'api/main.py', '--selfcheck']];
    })).toThrow(/is not one of python, python3, node/);
  });

  it('refuses a command that starts a file the pack does not ship', () => {
    expect(withPackSmoke((checks) => {
      checks.smoke.commands = [['python3', 'tools/seed.py', 'list']];
    })).toThrow(/the smoke command runs tools\/seed\.py, which smoke\/ does not hold/);
  });

  it('refuses an expectation the smoke command itself passes in', () => {
    // the words the command passes in are its own argv: this pack's
    // smoke run is `python3 api/main.py --selfcheck`, so that is the string
    // any program echoing its arguments would satisfy.
    expect(withPackSmoke((checks) => {
      checks.smoke.expect = 'api/main.py --selfcheck';
    })).toThrow(/echoes its arguments/);
  });

  it('refuses an expectation the reference implementation never prints', () => {
    // 'deployment succeeded' does not work as the example: the
    // selfcheck says "there is no deployment to check", so one of its words
    // does appear and the loader is right not to throw. Neither word of this
    // one occurs in any of the twelve implFiles.
    expect(withPackSmoke((checks) => {
      checks.smoke.expect = 'rollout acknowledged';
    })).toThrow(/not printed by the reference implementation/);
  });
});

/**
 * A pack whose rubric names a criterion the grader never scores, or whose
 * grader scores a criterion the rubric never names, has to say so at boot.
 * `assembleCriteria` reads `scores.get(key) ?? 0`, so a single typo is
 * indistinguishable from an honest zero: every learner of that pack loses the
 * criterion's whole weight and the report shows no reason. Same for the pack's
 * version, its reference suite and its solution: all three are read by
 * something that cannot ask the author what they meant.
 */
describe('ContentService (a pack declares its version, its rubric keys and its answers)', () => {
  /** Copy the tasktrackr pack into a temp root, break the copy, load that root. */
  const withPack = (mutate: (pack: string) => void): (() => void) => {
    const source = path.join(config.contentDir, 'tasktrackr');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-pack-'));
    const pack = path.join(root, 'tasktrackr');
    fs.cpSync(source, pack, { recursive: true });
    mutate(pack);
    return () => {
      const original = config.contentDir;
      (config as any).contentDir = root;
      try {
        new ContentService().loadAll();
      } finally {
        (config as any).contentDir = original;
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
  };

  const editJson = (at: string, mutate: (value: any) => void): void => {
    const value = JSON.parse(fs.readFileSync(at, 'utf-8'));
    mutate(value);
    fs.writeFileSync(at, JSON.stringify(value, null, 2));
  };

  const editPhase = (pack: string, phase: string, mutate: (spec: any) => void): void =>
    editJson(path.join(pack, 'phases', phase, 'phase.json'), mutate);

  it('refuses a pack that declares no version', () => {
    expect(withPack((pack) => {
      editJson(path.join(pack, 'project.json'), (meta) => delete meta.version);
    })).toThrow(/project\.json: version must be a non-empty string/);
  });

  it('refuses a version that is not major.minor.patch', () => {
    expect(withPack((pack) => {
      editJson(path.join(pack, 'project.json'), (meta) => {
        meta.version = 'autumn term';
      });
    })).toThrow(/must be MAJOR\.MINOR\.PATCH/);
  });

  it('refuses a rubric key the grader never scores', () => {
    expect(withPack((pack) => {
      editPhase(pack, '03-implementation', (spec) => {
        // one transposition, and every learner loses 40% of the phase with no
        // evidence line to say why
        spec.rubric.criteria[0].key = 'correctness_hiden';
      });
    })).toThrow(/nothing scores "correctness_hiden" on a code phase/);
  });

  it('refuses a rubric that leaves a scored criterion unclaimed', () => {
    expect(withPack((pack) => {
      editPhase(pack, '04-testing', (spec) => {
        spec.rubric.criteria = spec.rubric.criteria.filter(
          (c: { key: string }) => c.key !== 'mutants_killed',
        );
      });
    })).toThrow(/"mutants_killed" is scored by the tests grader but claimed by no rubric criterion/);
  });

  it('refuses a rule that grades into nothing', () => {
    // on Deployment, the phase whose rules TaskTrackr still grades (Design is a design phase with a floor)
    expect(withPack((pack) => {
      editPhase(pack, '05-deployment', (spec) => {
        spec.checks.rules[0].criterion = 'config_completenes';
      });
    })).toThrow(/"config_completenes" is scored by the file rules, the build check and the runbook floor but claimed by no rubric criterion/);
  });

  it('refuses a testing phase that ships no reference suite', () => {
    expect(withPack((pack) => {
      fs.rmSync(path.join(pack, 'phases', '04-testing', 'reference'), { recursive: true });
    })).toThrow(/phases\/04-testing has no reference\/ folder/);
  });

  it('refuses a reference suite that lands on no learner test path', () => {
    expect(withPack((pack) => {
      // the reference tree nests by workspace path, so the suite is at
      // reference/tests/test_acceptance.py with its front-end twin at
      // reference/web/src/acceptance.test.tsx. The loader's rule is that the
      // reference lands on at least one learner test path, so proving it fires
      // means moving BOTH, and a pack that ships a reference for only one of
      // its two runs is caught in "ships a reference acceptance suite", which
      // reads every run.
      const dir = path.join(pack, 'phases', '04-testing', 'reference');
      fs.renameSync(
        path.join(dir, 'tests', 'test_acceptance.py'),
        path.join(dir, 'tests', 'helpers.py'),
      );
      fs.renameSync(
        path.join(dir, 'web', 'src', 'acceptance.test.tsx'),
        path.join(dir, 'web', 'src', 'helpers.tsx'),
      );
    })).toThrow(/nothing in it lands on tests\/test_acceptance\.py/);
  });

  it('refuses a solution that completes none of the stubs', () => {
    expect(withPack((pack) => {
      const dir = path.join(pack, 'phases', '06-maintenance', 'solution');
      fs.renameSync(
        path.join(dir, 'api', 'repository', 'comments.py'),
        path.join(dir, 'api', 'repository', 'notes.py'),
      );
    })).toThrow(/phases\/06-maintenance\/solution\/api\/repository\/notes\.py completes no file the learner edits/);
  });
});

/**
 * Killability: every mutant must be caught by the phase-3 hidden suite, in
 * the real sandbox. A mutant nothing can kill would silently cap the
 * mutation score for every learner.
 */
describe('mutants are killable (sandbox)', () => {
  const content = new ContentService();
  content.loadAll();
  const sandbox = new SandboxService();

  for (const project of content.listProjects()) {
    it(`${project.slug}: the reference passes the hidden suite and every mutant fails it`, async () => {
      const testing = content.getPhase(project.slug, 'testing').checks;
      const hiddenOf = content.getPhase(project.slug, 'implementation').checks;
      if (testing.kind !== 'tests' || hiddenOf.kind !== 'code') {
        throw new Error('unexpected checks kind');
      }

      // a mutant only ever meets the suite of the run it belongs to, so
      // the layers are paired here the way the grader pairs them. One job with
      // both runs' paths under the phase's own language would run the API suite
      // and never the front end, unittest discovers only `*.py`, so the two
      // web mutants would survive a suite that could not see them and the
      // whole assertion would read green. `supportFiles` is not optional either: it
      // is what carries `api/db.py` and `api/schema.sql`, and without them
      // every case errors on a missing schema.
      const jobFor = (runId: string, mutant: Record<string, string> = {}) => {
        const graded = testing.runs.find((r) => r.id === runId) ?? testing.runs[0];
        const sealed = hiddenOf.runs.find((r) => r.id === runId) ?? hiddenOf.runs[0];
        return {
          files: {
            ...graded.supportFiles,
            ...graded.implFiles,
            ...mutant,
            ...sealed.hiddenTestFiles,
          },
          mode: 'tests' as const,
          testPaths: Object.keys(sealed.hiddenTestFiles),
          language: sealed.language,
          harness: sealed.hiddenHarness,
          ...(sealed.transform
            ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } }
            : {}),
        };
      };

      const survivors: string[] = [];
      for (const run of testing.runs) {
        const reference = await sandbox.execute(jobFor(run.id));
        expect({ run: run.id, stderr: reference.stderr }).toEqual({ run: run.id, stderr: '' });
        expect({ run: run.id, ok: reference.ok }).toEqual({ run: run.id, ok: true });
        // a run that collected nothing is not a green run, it is a run that
        // never happened: the silence a union of paths would hide
        expect({ run: run.id, collected: (reference.tests?.total || 0) > 0 })
          .toEqual({ run: run.id, collected: true });

        for (const mutant of testing.mutants.filter((m) => m.run === run.id)) {
          const bad = await sandbox.execute(jobFor(run.id, mutant.files));
          // ok=false with a parsed result is a caught bug; ok=false with no
          // result is a harness problem and must not count as a kill
          if (bad.ok || !bad.tests) {
            survivors.push(`${mutant.name} (${run.id}, ${bad.exitKind}: ${bad.stderr.slice(0, 120)})`);
          }
        }
      }
      expect(survivors).toEqual([]);
    }, 240000);
  }
});

/**
 * The incident drill has to have teeth: the same smoke check that grades the
 * deployment phase must pass on a working Dockerfile and fail on the pack's
 * faulted copy, in the real sandbox. A fault the smoke path cannot catch would
 * hand every learner a green drill and nothing to diagnose.
 */
describe('the deployment drill fails the smoke check (sandbox)', () => {
  const content = new ContentService();
  content.loadAll();
  const sandbox = new SandboxService();

  /** The smoke run exactly as the feedback pipeline performs it. */
  const smoke = async (phase: PhaseContent, files: Record<string, string>) => {
    if (phase.checks.kind !== 'config') throw new Error('expected config checks');
    // the pack says which Dockerfile the container under the smoke run
    // is built from. Reading 'Dockerfile' here parses a file a two-service pack
    // does not mount, so every workspace fails for a missing ENTRYPOINT
    // whatever it holds.
    const entry = dockerEntrypoint(files[phase.checks.smokeDockerfile] || '', {
      ...phase.checks.smokeImplFiles,
      ...files,
    });
    if (!entry.argv.length) return { ok: false, detail: entry.problem || '', stdout: '' };
    const run = await sandbox.execute({
      files: { ...phase.checks.smokeImplFiles, ...files },
      mode: 'smoke',
      smokeCommands: smokeArgvFor(entry.argv, phase.checks.smokeCommands),
      expectInOutput: phase.checks.expectInOutput,
      language: phase.language,
    });
    // stdout as well as stderr: a program that refuses politely writes its one
    // sentence to stdout and exits 1, and this pack's `ops/selfcheck.py` does
    return { ok: run.ok, detail: run.stderr, stdout: run.stdout };
  };


  for (const project of content.listProjects()) {
    it(`${project.slug}: a working Dockerfile smokes clean, the faulted copy does not`, async () => {
      const phase = content.getPhase(project.slug, 'deployment');
      if (phase.checks.kind !== 'config') throw new Error('expected config checks');
      const workspace = workingDeployment(project, phase);

      const fixed = await smoke(phase, content.executionFiles(phase, workspace));
      expect(fixed.detail).toBe('');
      expect(fixed.ok).toBe(true);

      const faulted = content.faultedExecutionFiles(phase, workspace);
      expect(faulted).not.toBeNull();
      const broken = await smoke(phase, faulted || {});
      expect(broken.ok).toBe(false);
      // and it fails for the fault, not for a harness problem. A faulted
      // ENTRYPOINT is named by the path it starts; a faulted deployment
      // setting is named by the pack's own sentence, which this selfcheck
      // prints on stdout before exiting 1.
      const said = `${broken.detail}\n${broken.stdout}`;
      const token = (content.drillSpec(phase)?.description || '')
        .match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
      if (token) {
        expect(said).toContain(token[0]);
      } else {
        const dockerfile = (faulted || {})[phase.checks.smokeDockerfile] || '';
        const entrypointLine = (dockerfile.match(/^\s*ENTRYPOINT\s+(\[.*\])\s*$/m) || [])[1];
        const started: string[] = JSON.parse(entrypointLine);
        expect(said).toContain(started[1]);
      }
    }, 120000);

    it(`${project.slug}: a container that prints the expectation without starting the CLI fails`, async () => {
      // the graded build check and the drill must both refuse an ENTRYPOINT
      // that runs the interpreter with an inline program.
      const phase = content.getPhase(project.slug, 'deployment');
      if (phase.checks.kind !== 'config') throw new Error('expected config checks');
      const forged =
        project.language === 'python'
          ? `FROM python:3.11-slim\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["python", "-c", "print('${phase.checks.expectInOutput}')"]\n`
          : `FROM node:22-slim\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ["node", "-e", "console.log('${phase.checks.expectInOutput}')"]\n`;
      // the forgery goes to the Dockerfile the smoke run actually builds:
      // written to 'Dockerfile' on a two-service pack it is never read, the
      // run fails for a missing entrypoint instead, and the assertion below
      // passes for the wrong reason.
      const out = await smoke(
        phase,
        content.executionFiles(phase, { [phase.checks.smokeDockerfile]: forged }),
      );
      expect(out.ok).toBe(false);
      expect(out.detail).toContain(project.language === 'python' ? '-c' : '-e');
    }, 120000);
  }
});

/**
 * The pack's own kill matrix, proven by the pack's own suite. Asserting only
 * that a submission passed is cleared comfortably by five mutants of six, so a
 * mutant could survive with nothing red. The suite ships beside the mutants it
 * has to kill, and this is the assertion that a mutant no shipped suite can
 * catch is a defect in the pack.
 */
describe('the reference suite completes the pack kill matrix (sandbox)', () => {
  const content = new ContentService();
  content.loadAll();
  const sandbox = new SandboxService();

  for (const project of content.listProjects()) {
    it(`${project.slug}: the reference suite passes on the implementation and kills every mutant`, async () => {
      const phase = content.getPhase(project.slug, 'testing');
      if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
      const checks = phase.checks;

      // one job per run, in that run's own language and harness. The union of
      // both suites under `python` would collect the API cases twice and the
      // front-end cases never, a `.tsx` file adds nothing to unittest, so
      // the whole front-end half of the matrix would be scored without running.
      // The locked helpers the suite imports (tests/clock.py, and api/db.py
      // with its schema) ride in the workspace here exactly as
      // they do in the grader's job.
      const jobFor = (runId: string, mutant: Record<string, string> = {}) => {
        const run = checks.runs.find((r) => r.id === runId) ?? checks.runs[0];
        return {
          files: { ...run.supportFiles, ...run.implFiles, ...mutant, ...run.referenceTestFiles },
          mode: 'tests' as const,
          testPaths: run.testPaths,
          language: run.language,
          harness: run.harness,
          ...(run.transform
            ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } }
            : {}),
        };
      };

      const survivors: string[] = [];
      const proven = new Set<string | undefined>();
      for (const run of checks.runs) {
        const clean = await sandbox.execute(jobFor(run.id));
        // a suite that fails on correct code is a bug in the suite
        expect({ run: run.id, stderr: clean.stderr }).toEqual({ run: run.id, stderr: '' });
        expect({ run: run.id, failed: clean.tests?.failed, errored: clean.tests?.errored })
          .toEqual({ run: run.id, failed: 0, errored: 0 });
        expect({ run: run.id, ok: clean.ok }).toEqual({ run: run.id, ok: true });
        // and it collected something: zero cases is not a pass
        expect({ run: run.id, collected: (clean.tests?.total || 0) > 0 })
          .toEqual({ run: run.id, collected: true });

        for (const mutant of checks.mutants.filter((m) => m.run === run.id)) {
          const bad = await sandbox.execute(jobFor(run.id, mutant.files));
          // the grader's own kill rule (buildTestsReport): a failure or an
          // error is a kill, a harness that returned no result says nothing
          const died = !!bad.tests && (bad.tests.failed > 0 || bad.tests.errored > 0);
          if (died) proven.add(mutant.covers);
          else survivors.push(`${mutant.name} (${run.id}, ${bad.exitKind}: ${bad.stderr.slice(0, 120)})`);
        }
      }
      expect(survivors).toEqual([]);
      // every criterion the matrix claims to evidence was evidenced by a kill
      expect([...proven].sort()).toEqual([...new Set(checks.mutants.map((m) => m.covers))].sort());
    }, 300000);
  }
});

/**
 * The pack's own answer, held against the pack's own hidden suite. Nothing ran
 * `solution/` against `hidden_tests/` before: the spec read the solution as
 * text, so a hidden test that outgrew the shipped answer would have failed
 * every learner who wrote the answer the pack itself calls correct, and the
 * first person to find out would have been a learner.
 */
describe('the shipped solution passes the hidden suite (sandbox)', () => {
  const content = new ContentService();
  content.loadAll();
  const sandbox = new SandboxService();

  for (const project of content.listProjects()) {
    for (const phase of project.phases.filter((p) => p.checks.kind === 'code')) {
      it(`${project.slug}/${phase.key}: the solution passes it and the shipped stub does not`, async () => {
        if (phase.checks.kind !== 'code') throw new Error('expected code checks');
        const checks = phase.checks;
        expect(Object.keys(checks.hiddenTestFiles).length).toBeGreaterThan(0);

        // one job per run, in that run's own language and its own
        // SEALED harness. One job with the union of both runs' paths under the
        // phase's language is a false green on a two-layer phase: unittest
        // discovers only `*.py`, so a `.tsx` hidden suite adds no cases at all
        // and a front end that does not work reports 14 of 14. Measured, with
        // one character changed in `web/src/lib/overdue.ts`: 14 of 14 sent as
        // one union job, 7 of 8 with one named failure sent per run.
        for (const run of checks.runs) {
          const testPaths = Object.keys(run.hiddenTestFiles);
          expect({ run: run.id, sealed: testPaths.length > 0 }).toEqual({ run: run.id, sealed: true });
          const job = (files: Record<string, string>) => ({
            files: { ...files, ...run.hiddenTestFiles },
            mode: 'tests' as const,
            testPaths,
            language: run.language,
            harness: run.hiddenHarness,
            ...(run.transform
              ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } }
              : {}),
          });

          // the solution overlaid exactly as a learner's workspace would be
          const solved = await sandbox.execute(job(content.executionFiles(phase, checks.solutionFiles)));
          expect({ run: run.id, stderr: solved.stderr }).toEqual({ run: run.id, stderr: '' });
          expect({ run: run.id, failed: solved.tests?.failed, errored: solved.tests?.errored })
            .toEqual({ run: run.id, failed: 0, errored: 0 });
          expect({ run: run.id, ok: solved.ok }).toEqual({ run: run.id, ok: true });
          expect({ run: run.id, collected: (solved.tests?.total || 0) > 0 })
            .toEqual({ run: run.id, collected: true });

          // and the suite has teeth: the stub the learner opens fails it
          const stub = await sandbox.execute(job(content.executionFiles(phase, null)));
          expect({ run: run.id, ok: stub.ok }).toEqual({ run: run.id, ok: false });
          expect({
            run: run.id,
            caught: (stub.tests?.failed || 0) + (stub.tests?.errored || 0) > 0,
          }).toEqual({ run: run.id, caught: true });
        }
      }, 300000);
    }
  }
});

/* ========================== the full-stack pack format ======================
 *
 * The pack format the full-stack project needs: two runs in a phase, overlays
 * that nest, a runtime the runner has to have pre-baked, and a preview the
 * pack declares rather than the product hard-codes.
 *
 * These build their own pack on disk rather than copying `content/`: the
 * format is what is under test, not the shipped pack, and a format test that
 * reads the pack breaks every time an author edits it.
 */

type PackTree = Record<string, string>;

/*
 * `fullstackPack` is authored in the older (pointer) layout, a phase list in
 * project.json and a file list in each phase.json, because the cases edit
 * those members. The loader reads only the folder layout, so each `load`
 * converts the tree once, as the upload door converts an older archive
 * (`writeConverted`), and boots the converted pack from disk.
 */

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** The rubric keys each grader sets, since the loader refuses any other. */
const CODE_RUBRIC = {
  passThreshold: 70,
  criteria: [
    { key: 'correctness_hidden', title: 'Hidden tests', weight: 0.4 },
    { key: 'visible_tests', title: 'Visible tests', weight: 0.2 },
    { key: 'code_quality', title: 'Code quality', weight: 0.2 },
    { key: 'process', title: 'Process', weight: 0.2 },
  ],
};

const TESTS_RUBRIC = {
  passThreshold: 70,
  criteria: [
    { key: 'tests_pass', title: 'The suite passes', weight: 0.4 },
    { key: 'mutants_killed', title: 'Mutants killed', weight: 0.4 },
    { key: 'coverage_mapping', title: 'Coverage mapping', weight: 0.2 },
  ],
};

const CONFIG_RUBRIC = {
  passThreshold: 70,
  criteria: [
    { key: 'runbook_quality', title: 'Runbook', weight: 0.5 },
    { key: 'build_smoke', title: 'The container starts', weight: 0.5 },
  ],
};

const assistant = (key: string) => ({
  systemPrompt: `${key.toUpperCase()} mentor`,
  topics: [],
  progressive: [],
});

/**
 * The smallest pack that is a two-language application: a code phase with an
 * API run and a front-end run, a testing phase whose mutants are split across
 * both, and a config phase with two Dockerfiles.
 *
 * `edit` receives the three phase specs, the project meta and the file tree
 * before any of it is written, so each case says exactly what it changed.
 */
function fullstackPack(
  edit: (pack: {
    project: any;
    code: any;
    tests: any;
    config: any;
    tree: PackTree;
  }) => void = () => undefined,
): PackTree {
  const project: any = {
    slug: 'fullstack',
    version: '2.0.0',
    title: 'Fullstack',
    tagline: 'One project, two layers.',
    description: 'A Python API and a TypeScript front end.',
    language: 'python',
    languages: ['python', 'typescript'],
    build: { tool: 'esbuild', entry: 'web/src/main.tsx', outfile: 'web/dist/app.js', jsx: 'automatic' },
    runtime: {
      python: { version: '3.11', packages: ['flask==3.0.3', 'pytest==8.3.4'] },
      node: {
        version: '22',
        packages: { react: '18.3.1', jsdom: '25.0.1' },
        tools: { esbuild: '0.24.2' },
      },
    },
    preview: {
      service: { command: ['python3', 'api/main.py'], portEnv: 'PORT', health: '/api/health' },
      web: { root: 'web/dist', html: 'web/index.html' },
      env: { TASKTRACKR_DB: 'data/preview.sqlite' },
      seed: ['python3', 'ops/seed.py'],
    },
    phases: ['phases/03-implementation', 'phases/04-testing', 'phases/05-deployment'],
  };

  const code: any = {
    key: 'implementation',
    order: 3,
    artifactKind: 'code',
    title: 'Implementation',
    intro: 'Fill in the marked gaps.',
    taskFile: 'task.md',
    objectives: ['Fill the gaps', 'Run the tests'],
    canRun: true,
    canPreview: true,
    runLabel: 'Run tests',
    assistant: assistant('implementation'),
    files: [
      { path: 'api/main.py', source: 'files/main.py', language: 'python' },
      { path: 'ops/seed.py', source: 'files/seed.py', language: 'python' },
      { path: 'api/repository/tasks.py', source: 'files/tasks.py', editable: true, language: 'python' },
      { path: 'web/src/lib/overdue.ts', source: 'files/overdue.ts', editable: true, language: 'typescript' },
      { path: 'tests/test_tasks_api.py', source: 'files/test_tasks_api.py', language: 'python' },
      { path: 'tests/conftest.py', source: 'files/conftest.py', language: 'python' },
      { path: 'web/src/lib/overdue.test.ts', source: 'files/overdue.test.ts', language: 'typescript' },
    ],
    rubric: CODE_RUBRIC,
    checks: {
      kind: 'code',
      editableTargets: ['api/repository/tasks.py', 'web/src/lib/overdue.ts'],
      solutionDir: 'solution',
      runs: [
        {
          id: 'api',
          language: 'python',
          harness: 'pytest',
          hiddenHarness: 'unittest',
          label: 'API tests',
          testPaths: ['tests'],
          visibleTests: ['tests/test_tasks_api.py'],
          hiddenTestDir: 'hidden_tests/api',
          supportFiles: ['tests/conftest.py'],
        },
        {
          id: 'web',
          language: 'typescript',
          harness: 'js',
          label: 'Front end',
          transform: true,
          visibleTests: ['web/src/lib/overdue.test.ts'],
          hiddenTestDir: 'hidden_tests/web',
        },
      ],
    },
  };

  const tests: any = {
    key: 'testing',
    order: 4,
    artifactKind: 'tests',
    title: 'Testing',
    intro: 'Write the acceptance suite.',
    taskFile: 'task.md',
    objectives: ['Write the suite', 'Kill the mutants'],
    canRun: true,
    runLabel: 'Run tests',
    assistant: assistant('testing'),
    files: [
      { path: 'tests/test_acceptance.py', source: 'files/test_acceptance.py', editable: true, language: 'python' },
      { path: 'web/src/acceptance.test.tsx', source: 'files/acceptance.test.tsx', editable: true, language: 'typescript' },
      { path: 'tests/clock.py', source: 'files/clock.py', language: 'python' },
      { path: 'web/src/testing/clock.ts', source: 'files/clock.ts', language: 'typescript' },
    ],
    rubric: TESTS_RUBRIC,
    checks: {
      kind: 'tests',
      learnerTestFiles: ['tests/test_acceptance.py', 'web/src/acceptance.test.tsx'],
      referenceDir: 'reference',
      implDir: 'impl',
      mutantsDir: 'mutants',
      minTests: 4,
      supportFiles: { 'tests/clock.py': 'files/clock.py', 'web/src/testing/clock.ts': 'files/clock.ts' },
      coverageKeywords: [
        { criterion: 'overdue', keywords: ['overdue'], criterionId: 'US-4/AC-1' },
      ],
      runs: [
        {
          id: 'api',
          language: 'python',
          harness: 'pytest',
          label: 'API tests',
          learnerTestFiles: ['tests/test_acceptance.py'],
          implFiles: ['api/repository/tasks.py'],
          supportFiles: ['tests/clock.py'],
          testPaths: ['tests'],
        },
        {
          id: 'web',
          language: 'typescript',
          harness: 'js',
          label: 'Front end',
          transform: true,
          learnerTestFiles: ['web/src/acceptance.test.tsx'],
          implFiles: ['web/src/lib/overdue.ts', 'web/src/components/TaskRow.tsx'],
          supportFiles: ['web/src/testing/clock.ts'],
        },
      ],
    },
  };

  const configPhase: any = {
    key: 'deployment',
    order: 5,
    artifactKind: 'config',
    title: 'Deployment',
    intro: 'Containerise both services.',
    // a platform pack's Deployment carries its runbook record and keeps its brief inline (TaskTrackr 5.0.0's shape)
    taskPanel: 'Deployment. What good looks like: the mentor agrees.',
    objectives: ['Write the Dockerfile', 'Write the runbook'],
    canRun: true,
    runLabel: 'Run the build check',
    assistant: assistant('deployment'),
    files: [
      { path: 'api/Dockerfile', source: 'files/Dockerfile', editable: true, language: 'dockerfile' },
    ],
    rubric: CONFIG_RUBRIC,
    checks: {
      kind: 'config',
      rules: [],
      runbook: { record: 'deployment/runbook.json', floor: { minEnvironment: 0, minHealth: 1, minRollback: 1, minData: 0, requireIncident: false } },
      smoke: {
        dockerfile: 'api/Dockerfile',
        implFiles: { 'api/main.py': 'impl/main.py' },
        commands: [['python3', 'api/main.py', '--selfcheck']],
        expect: 'selfcheck: web reaches api',
      },
    },
  };

  const tree: PackTree = {
    'phases/03-implementation/task.md': '# Implementation\n\nWhat good looks like: the mentor agrees.\n',
    'phases/03-implementation/files/main.py': 'def create_app():\n    return None\n',
    'phases/03-implementation/files/seed.py': 'print("seeded")\n',
    'phases/03-implementation/files/tasks.py': 'def overdue(today):\n    raise NotImplementedError  # TODO(learner)\n',
    'phases/03-implementation/files/overdue.ts': 'export function isOverdue() { return false; } // TODO(learner)\n',
    'phases/03-implementation/files/test_tasks_api.py': 'def test_overdue():\n    assert True\n',
    'phases/03-implementation/files/conftest.py': 'import pytest\n',
    'phases/03-implementation/files/overdue.test.ts': "test('overdue', () => {});\n",
    'phases/03-implementation/solution/api/repository/tasks.py': 'def overdue(today):\n    return []\n',
    'phases/03-implementation/solution/web/src/lib/overdue.ts': 'export function isOverdue() { return true; }\n',
    'phases/03-implementation/hidden_tests/api/test_hidden_tasks.py': 'def test_hidden():\n    assert True\n',
    'phases/03-implementation/hidden_tests/web/overdue.hidden.test.ts': "test('hidden', () => {});\n",

    'phases/04-testing/task.md': '# Testing\n\nWhat good looks like: the mentor agrees.\n',
    'phases/04-testing/files/test_acceptance.py': 'def test_overdue():\n    pass  # TODO(learner)\n',
    'phases/04-testing/files/acceptance.test.tsx': "test('overdue', () => {}); // TODO(learner)\n",
    'phases/04-testing/files/clock.py': 'def today():\n    return "2026-01-01"\n',
    'phases/04-testing/files/clock.ts': 'export const today = () => "2026-01-01";\n',
    'phases/04-testing/reference/tests/test_acceptance.py': 'def test_overdue():\n    assert True\n',
    'phases/04-testing/reference/web/src/acceptance.test.tsx': "test('overdue', () => {});\n",
    'phases/04-testing/impl/api/repository/tasks.py': 'def overdue(today):\n    return []\n',
    'phases/04-testing/impl/web/src/lib/overdue.ts': 'export function isOverdue() { return true; }\n',
    'phases/04-testing/impl/web/src/components/TaskRow.tsx': 'export function TaskRow() { return null; }\n',
    'phases/04-testing/mutants/overdue_includes_today/meta.json': json({
      name: 'overdue_includes_today',
      description: 'The overdue query uses <= where < belongs, so a task due today reads as late.',
      covers: 'US-4/AC-1',
      run: 'api',
    }),
    'phases/04-testing/mutants/overdue_includes_today/tasks.py': 'def overdue(today):\n    return ["everything"]\n',
    'phases/04-testing/mutants/badge_never_shows/meta.json': json({
      name: 'badge_never_shows',
      description: 'The row never renders the overdue badge, so nothing looks late.',
      covers: 'US-5/AC-1',
      run: 'web',
    }),
    'phases/04-testing/mutants/badge_never_shows/TaskRow.tsx': 'export function TaskRow() { return "no badge"; }\n',

    'phases/05-deployment/files/Dockerfile': 'FROM python:3.11-slim\nWORKDIR /app\n',
    'phases/05-deployment/impl/main.py': 'print("selfcheck: web reaches api, 13 routes, 5 tables")\n',
  };

  edit({ project, code, tests, config: configPhase, tree });
  return {
    ...tree,
    'project.json': json(project),
    'phases/03-implementation/phase.json': json(code),
    'phases/04-testing/phase.json': json(tests),
    'phases/05-deployment/phase.json': json(configPhase),
  };
}

describe('ContentService (the pack format: two runs, two layers)', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const temp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(dir);
    return dir;
  };

  /** Write a pack into its own content root and load it, exactly as the API does at boot. */
  const load = (tree: PackTree, runnerDir?: string): ProjectContent => {
    const root = temp('lsdlc-f2-content-');
    writeConverted(folderPack(tree, 'fullstack'), path.join(root, 'fullstack'));
    const contentDir = config.contentDir;
    const runner = config.runnerDir;
    (config as any).contentDir = root;
    if (runnerDir) (config as any).runnerDir = runnerDir;
    try {
      const service = new ContentService();
      service.loadAll();
      return service.listProjects()[0];
    } finally {
      (config as any).contentDir = contentDir;
      (config as any).runnerDir = runner;
    }
  };

  const loading =
    (edit: Parameters<typeof fullstackPack>[0], runnerDir?: string) => (): ProjectContent =>
      load(fullstackPack(edit), runnerDir);

  const phaseOf = (project: ProjectContent, key: string): PhaseContent =>
    project.phases.find((p) => p.key === key) as PhaseContent;

  /* ------------------------------- the runs ------------------------------ */

  it('loads a phase’s two runs, one per layer, and keeps the flat fields the union of them', () => {
    const phase = phaseOf(load(fullstackPack()), 'implementation');
    if (phase.checks.kind !== 'code') throw new Error('expected code checks');
    const checks = phase.checks;

    expect(checks.runs.map((r) => [r.id, r.language, r.harness, r.hiddenHarness, r.transform])).toEqual([
      ['api', 'python', 'pytest', 'unittest', false],
      ['web', 'typescript', 'js', 'js', true],
    ]);
    expect(checks.runs.map((r) => r.label)).toEqual(['API tests', 'Front end']);
    // each run carries its own sealed suite, and the flat field is the union
    expect(Object.keys(checks.runs[0].hiddenTestFiles)).toEqual(['tests/test_hidden_tasks.py']);
    expect(Object.keys(checks.runs[1].hiddenTestFiles)).toEqual(['tests/overdue.hidden.test.ts']);
    expect(Object.keys(checks.hiddenTestFiles).sort()).toEqual([
      'tests/overdue.hidden.test.ts',
      'tests/test_hidden_tasks.py',
    ]);
    expect(checks.visibleTests).toEqual([
      'tests/test_tasks_api.py',
      'web/src/lib/overdue.test.ts',
    ]);
    // the graded run collects what the pack says, and the helper rides with it
    expect(checks.runs[0].testPaths).toEqual(['tests']);
    expect(Object.keys(checks.runs[0].supportFiles)).toEqual(['tests/conftest.py']);
    // the nested solution lands on the very paths the learner edits: a flat
    // read found neither file and the pack failed to load at all
    expect(Object.keys(checks.solutionFiles).sort()).toEqual([
      'api/repository/tasks.py',
      'web/src/lib/overdue.ts',
    ]);
  });

  it('refuses a run whose language the pack never declared', () => {
    expect(loading((p) => {
      p.code.checks.runs[1].language = 'javascript';
    })).toThrow(/checks\.runs\[1\]\.language \("javascript"\) is not one of this pack's languages \(python, typescript\)/);
  });

  it('refuses two runs that share an id', () => {
    expect(loading((p) => {
      p.code.checks.runs[1].id = 'api';
    })).toThrow(/duplicate run id "api"/);
  });

  it('refuses a transform on a python run', () => {
    expect(loading((p) => {
      p.code.checks.runs[0].transform = true;
    })).toThrow(/checks\.runs\[0\]\.transform is only for a typescript run, and this one is python/);
  });

  it('refuses a harness that cannot run its run’s language', () => {
    expect(loading((p) => {
      p.code.checks.runs[1].harness = 'pytest';
    })).toThrow(/checks\.runs\[1\]\.harness \("pytest"\) cannot run typescript: use js/);
  });

  it('gives a phase that declares no runs the one run its flat shape describes', () => {
    const project = load(fullstackPack((p) => {
      // the flat shape: one run, no `runs` array
      p.code.checks = {
        kind: 'code',
        editableTargets: ['api/repository/tasks.py'],
        solutionDir: 'solution/api/repository',
        visibleTests: ['tests/test_tasks_api.py'],
        hiddenTestDir: 'hidden_tests/api',
      };
    }));
    const phase = phaseOf(project, 'implementation');
    if (phase.checks.kind !== 'code') throw new Error('expected code checks');
    expect(phase.checks.runs).toHaveLength(1);
    expect(phase.checks.runs[0]).toMatchObject({
      id: 'main',
      language: 'python',
      harness: 'unittest',
      hiddenHarness: 'unittest',
      transform: false,
      visibleTests: ['tests/test_tasks_api.py'],
    });
    // the flat hidden suite keeps its `tests/` prefix
    expect(Object.keys(phase.checks.hiddenTestFiles)).toEqual(['tests/test_hidden_tasks.py']);
    expect(phase.checks.visibleTests).toEqual(['tests/test_tasks_api.py']);
  });

  /* ------------------------------ the overlays --------------------------- */

  it('keeps two solution files that share a basename apart, by the path each sits at', () => {
    const project = load(fullstackPack((p) => {
      // the real phase edits api/repository/tasks.py and api/routes/tasks.py:
      // one basename, two directories, two different answers
      p.code.checks.editableTargets = ['api/repository/tasks.py', 'api/routes/tasks.py'];
      p.code.files.push({ path: 'api/routes/tasks.py', source: 'files/routes.py', editable: true, language: 'python' });
      p.tree['phases/03-implementation/files/routes.py'] = 'def overdue_route():\n    raise NotImplementedError\n';
      p.tree['phases/03-implementation/solution/api/routes/tasks.py'] =
        'def overdue_route():\n    return "the route"\n';
      delete p.tree['phases/03-implementation/solution/web/src/lib/overdue.ts'];
    }));
    const phase = phaseOf(project, 'implementation');
    if (phase.checks.kind !== 'code') throw new Error('expected code checks');
    // mapping by basename alone put both files on one target, so half the
    // shipped answer vanished and the other half graded twice
    expect(phase.checks.solutionFiles['api/repository/tasks.py']).toContain('def overdue(today)');
    expect(phase.checks.solutionFiles['api/routes/tasks.py']).toContain('the route');
  });

  it('refuses two overlay files that land on the same workspace path', () => {
    expect(loading((p) => {
      p.tree['phases/03-implementation/solution/tasks.py'] = 'def overdue(today):\n    return []\n';
    })).toThrow(/checks\.solutionDir: api\/repository\/tasks\.py and tasks\.py both overlay "api\/repository\/tasks\.py"/);
  });

  it('keeps a nested hidden suite where the pack put it, beside the code it imports', () => {
    const project = load(fullstackPack((p) => {
      delete p.tree['phases/03-implementation/hidden_tests/web/overdue.hidden.test.ts'];
      p.tree['phases/03-implementation/hidden_tests/web/web/src/lib/overdue.hidden.test.ts'] =
        "import { isOverdue } from './overdue';\ntest('hidden', () => {});\n";
      p.code.checks.runs[1].testPaths = ['web/src/lib/overdue.hidden.test.ts'];
    }));
    const phase = phaseOf(project, 'implementation');
    if (phase.checks.kind !== 'code') throw new Error('expected code checks');
    expect(Object.keys(phase.checks.runs[1].hiddenTestFiles)).toEqual([
      'web/src/lib/overdue.hidden.test.ts',
    ]);
  });

  /* ------------------------------- the mutants --------------------------- */

  it('loads a .tsx mutant and files it against the run whose implementation it replaces', () => {
    const phase = phaseOf(load(fullstackPack()), 'testing');
    if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
    const byName = new Map(phase.checks.mutants.map((m) => [m.name, m]));

    // the front-end mutant is a .tsx file: a loader that accepted only .py
    // and .js would load it as an empty overlay and grade it as unkillable
    expect(byName.get('badge_never_shows')?.run).toBe('web');
    expect(Object.keys(byName.get('badge_never_shows')?.files || {})).toEqual([
      'web/src/components/TaskRow.tsx',
    ]);
    expect(byName.get('overdue_includes_today')?.run).toBe('api');
    expect(Object.keys(byName.get('overdue_includes_today')?.files || {})).toEqual([
      'api/repository/tasks.py',
    ]);
    // and the kill matrix is one grid: both runs are mutated
    expect(new Set(phase.checks.mutants.map((m) => m.run))).toEqual(new Set(['api', 'web']));
  });

  it('refuses a mutant that names a run the phase does not declare', () => {
    expect(loading((p) => {
      p.tree['phases/04-testing/mutants/badge_never_shows/meta.json'] = json({
        name: 'badge_never_shows',
        description: 'The row never renders the overdue badge, so nothing looks late.',
        covers: 'US-5/AC-1',
        run: 'frontend',
      });
    })).toThrow(/mutants\/badge_never_shows\/meta\.json: run "frontend" is not one of api, web/);
  });

  it('refuses a mutant that names no run when the phase declares two', () => {
    expect(loading((p) => {
      p.tree['phases/04-testing/mutants/badge_never_shows/meta.json'] = json({
        name: 'badge_never_shows',
        description: 'The row never renders the overdue badge, so nothing looks late.',
        covers: 'US-5/AC-1',
      });
    })).toThrow(/mutants\/badge_never_shows\/meta\.json: run is required when the phase declares more than one run/);
  });

  it('refuses a mutant that overlays nothing in its own run’s implementation', () => {
    expect(loading((p) => {
      p.tree['phases/04-testing/mutants/badge_never_shows/Sidebar.tsx'] = 'export function Sidebar() {}\n';
    })).toThrow(/mutants\/badge_never_shows: "Sidebar\.tsx" overlays nothing in the web run's implementation/);
  });

  /* --------------------------- the testing runs -------------------------- */

  it('splits the learner’s suites across the runs, and refuses one no run grades', () => {
    const phase = phaseOf(load(fullstackPack()), 'testing');
    if (phase.checks.kind !== 'tests') throw new Error('expected tests checks');
    expect(phase.checks.runs.map((r) => r.learnerTestFiles)).toEqual([
      ['tests/test_acceptance.py'],
      ['web/src/acceptance.test.tsx'],
    ]);
    expect(Object.keys(phase.checks.runs[1].implFiles)).toEqual([
      'web/src/lib/overdue.ts',
      'web/src/components/TaskRow.tsx',
    ]);
    expect(Object.keys(phase.checks.runs[0].supportFiles)).toEqual(['tests/clock.py']);
    expect(Object.keys(phase.checks.runs[0].referenceTestFiles)).toEqual(['tests/test_acceptance.py']);

    expect(loading((p) => {
      p.tests.checks.runs[1].learnerTestFiles = [];
    })).toThrow(/checks\.runs\[1\]\.learnerTestFiles must not be empty/);
    expect(loading((p) => {
      p.tests.checks.runs.pop();
    })).toThrow(/no run grades web\/src\/acceptance\.test\.tsx, so the learner would write a suite nothing ever runs/);
  });

  it('refuses a run implementation file the phase does not ship', () => {
    // the converted pack holds the reference implementation under impl/, so the folder layout names that folder
    expect(loading((p) => {
      p.tests.checks.runs[0].implFiles = ['api/services/reminders.py'];
    })).toThrow(/phases\/02-testing: checks names api\/services\/reminders\.py in implFiles, which impl\/ does not hold/);
  });

  it('still refuses a support file the pack does not declare as a locked file', () => {
    expect(loading((p) => {
      p.tests.checks.supportFiles['tests/secret.py'] = 'files/clock.py';
    })).toThrow(/phases\/02-testing: checks names tests\/secret\.py in supportFiles, which readonly\/ does not hold/);
    expect(loading((p) => {
      p.code.checks.runs[0].supportFiles = ['tests/test_tasks_api.py', 'tests/nowhere.py'];
    })).toThrow(/phases\/01-implementation: checks names tests\/nowhere\.py in supportFiles, which readonly\/ does not hold/);
  });
});

/**
 * What the pack declares about the machine it runs on: the languages, the
 * pre-baked dependencies, the front-end build and the app the learner can
 * start. Each one is refused at boot, naming the file and the field, because
 * the alternative is a learner pressing Run app and reading a stack trace.
 */
describe('ContentService (a pack declares its languages, its runtime and its preview)', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  const temp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(dir);
    return dir;
  };

  const load = (tree: PackTree, runnerDir?: string): ProjectContent => {
    const root = temp('lsdlc-f2-runtime-');
    writeConverted(folderPack(tree, 'fullstack'), path.join(root, 'fullstack'));
    const contentDir = config.contentDir;
    const runner = config.runnerDir;
    (config as any).contentDir = root;
    if (runnerDir) (config as any).runnerDir = runnerDir;
    try {
      const service = new ContentService();
      service.loadAll();
      return service.listProjects()[0];
    } finally {
      (config as any).contentDir = contentDir;
      (config as any).runnerDir = runner;
    }
  };

  const loading =
    (edit: Parameters<typeof fullstackPack>[0], runnerDir?: string) => (): ProjectContent =>
      load(fullstackPack(edit), runnerDir);

  /** A runner tree whose allowlist is the one the packs here declare against. */
  const runnerWithAllowlist = (): string => {
    const dir = temp('lsdlc-f2-runner-');
    fs.writeFileSync(
      path.join(dir, 'runtime_manifest.py'),
      [
        'ALLOWED_PYTHON = {',
        '    "flask",',
        '    "pytest",',
        '}',
        '',
        'ALLOWED_NODE = {',
        '    "react",',
        '    "jsdom",',
        '}',
        '',
        'ALLOWED_TOOLS = {"esbuild": "0.24.2"}',
        '',
      ].join('\n'),
      'utf-8',
    );
    return dir;
  };

  it('loads the languages, the build, the runtime and the preview a pack declares', () => {
    const project = load(fullstackPack(), runnerWithAllowlist());
    expect(project.languages).toEqual(['python', 'typescript']);
    expect(project.build).toEqual({
      tool: 'esbuild',
      entry: 'web/src/main.tsx',
      outfile: 'web/dist/app.js',
      jsx: 'automatic',
    });
    expect(project.runtime?.python?.packages).toEqual(['flask==3.0.3', 'pytest==8.3.4']);
    expect(project.runtime?.node?.tools).toEqual({ esbuild: '0.24.2' });
    expect(project.preview?.service).toEqual({
      command: ['python3', 'api/main.py'],
      portEnv: 'PORT',
      health: '/api/health',
    });
    expect(project.preview?.env).toEqual({ TASKTRACKR_DB: 'data/preview.sqlite' });
    expect(project.phases.map((p) => [p.key, p.canPreview])).toEqual([
      ['implementation', true],
      ['testing', false],
      ['deployment', false],
    ]);
  });

  it('gives a pack that declares no languages its own one', () => {
    const project = load(fullstackPack((p) => {
      delete p.project.languages;
      // one language means one layer: the front-end run goes with it
      p.code.checks.runs.pop();
      p.code.checks.editableTargets = ['api/repository/tasks.py'];
      delete p.tree['phases/03-implementation/solution/web/src/lib/overdue.ts'];
      p.tests.checks.runs.pop();
      p.tests.checks.learnerTestFiles = ['tests/test_acceptance.py'];
      delete p.tree['phases/04-testing/reference/web/src/acceptance.test.tsx'];
      delete p.tree['phases/04-testing/mutants/badge_never_shows/meta.json'];
      delete p.tree['phases/04-testing/mutants/badge_never_shows/TaskRow.tsx'];
    }));
    expect(project.languages).toEqual(['python']);
  });

  it('refuses a languages list that leaves out the pack’s own language', () => {
    expect(loading((p) => {
      p.project.languages = ['typescript'];
    })).toThrow(/project\.json: languages must include the pack's own language "python"/);
  });

  it('refuses a runtime version that is not pinned exactly', () => {
    expect(loading((p) => {
      p.project.runtime.python.packages = ['flask>=3.0'];
    })).toThrow(/runtime\.python\.packages: "flask>=3\.0" must be pinned exactly, as name==version/);
    expect(loading((p) => {
      p.project.runtime.node.packages.react = '^18.3.1';
    })).toThrow(/runtime\.node\.packages\["react"\] \("\^18\.3\.1"\) must be an exact version/);
  });

  it('refuses a package the runner does not allow, and takes one it does', () => {
    const runner = runnerWithAllowlist();
    expect(loading((p) => {
      p.project.runtime.python.packages.push('requests==2.32.3');
    }, runner)).toThrow(/runtime\.python\.packages: "requests" is not on the runner's allowlist \(ALLOWED_PYTHON/);
    expect(loading((p) => {
      p.project.runtime.node.packages.svelte = '5.0.0';
    }, runner)).toThrow(/runtime\.node\.packages: "svelte" is not on the runner's allowlist \(ALLOWED_NODE/);
    // and the pack's own set is the allowlist's, so it loads
    expect(load(fullstackPack(), runner).runtime?.node?.packages.react).toBe('18.3.1');
  });

  it('reads the runner’s own allowlist, so a pack cannot add a package by editing content', () => {
    // the allowlist is the runner's, not the pack's, and the loader parses it
    // out of the runner's module: if that module stops declaring the three
    // names as literals the allowlist reads as empty and every package passes,
    // which is the one way this rule fails silently
    const manifest = path.join(config.runnerDir, 'runtime_manifest.py');
    expect(fs.existsSync(manifest)).toBe(true);
    expect(fs.readFileSync(manifest, 'utf-8')).toMatch(/^ALLOWED_PYTHON\s*=/m);
    expect(loading((p) => {
      p.project.runtime.python.packages.push('requests==2.32.3');
    })).toThrow(/"requests" is not on the runner's allowlist \(ALLOWED_PYTHON in runner\/runtime_manifest\.py\)/);
    // and what the runner does bake loads: flask, pytest, react, jsdom, esbuild
    expect(load(fullstackPack()).runtime?.python?.packages).toEqual(['flask==3.0.3', 'pytest==8.3.4']);
  });

  it('loads a runtime on a tree where the runner has no manifest yet', () => {
    // the allowlist lives in the runner, and a tree without it has no pre-baked
    // layer either: the run says so with the sentence that names the pre-bake,
    // which is a better answer than refusing to boot over the runner's own file
    const project = load(fullstackPack(), temp('lsdlc-f2-empty-runner-'));
    expect(project.runtime?.python?.version).toBe('3.11');
  });

  it('refuses a build that names a tool the runner does not know, or an entry outside the workspace', () => {
    expect(loading((p) => {
      p.project.build.tool = 'webpack';
    })).toThrow(/project\.json: build\.tool must be "esbuild"/);
    expect(loading((p) => {
      p.project.build.entry = '../../../etc/passwd';
    })).toThrow(/project\.json: build\.entry \("\.\.\/\.\.\/\.\.\/etc\/passwd"\) must be a relative path inside the workspace/);
  });

  it('refuses a preview command that is not an interpreter the runner knows', () => {
    expect(loading((p) => {
      p.project.preview.service.command = ['bash', 'api/main.py'];
    })).toThrow(/project\.json: preview\.service\.command: "bash" is not one of python3, node/);
  });

  it('refuses a preview command whose script the previewing phase does not ship', () => {
    expect(loading((p) => {
      p.project.preview.service.command = ['python3', 'api/server.py'];
    })).toThrow(/preview\.service\.command: "api\/server\.py" is not a file the implementation phase ships/);
    expect(loading((p) => {
      p.project.preview.seed = ['python3', 'ops/fixtures.py'];
    })).toThrow(/preview\.seed: "ops\/fixtures\.py" is not a file the implementation phase ships/);
  });

  it('refuses a preview environment key the runner sets itself', () => {
    expect(loading((p) => {
      p.project.preview.env.NODE_PATH = 'web/node_modules';
    })).toThrow(/preview\.env: "NODE_PATH" is set by the runner itself/);
    expect(loading((p) => {
      p.project.preview.env.PORT = '8000';
    })).toThrow(/preview\.env: "PORT" is set by the runner itself/);
  });

  it('refuses a health path that is not a path, and a port variable that is not a variable', () => {
    expect(loading((p) => {
      p.project.preview.service.health = 'api/health';
    })).toThrow(/preview\.service\.health \("api\/health"\) must start with "\/"/);
    expect(loading((p) => {
      p.project.preview.service.portEnv = 'the port';
    })).toThrow(/preview\.service\.portEnv \("the port"\) must match/);
  });

  it('refuses a phase that says it can preview when the pack declares no preview', () => {
    expect(loading((p) => {
      delete p.project.preview;
    })).toThrow(/implementation declares canPreview, but the pack declares no preview block/);
  });

  /* ------------------------- the smoke Dockerfile ------------------------ */

  it('takes the Dockerfile the smoke check names, and refuses one the pack does not ship', () => {
    const project = load(fullstackPack());
    const deployment = project.phases.find((p) => p.key === 'deployment') as PhaseContent;
    if (deployment.checks.kind !== 'config') throw new Error('expected config checks');
    expect(deployment.checks.smokeDockerfile).toBe('api/Dockerfile');

    expect(loading((p) => {
      p.config.checks.smoke.dockerfile = 'web/Dockerfile';
    })).toThrow(/phases\/03-deployment: checks names web\/Dockerfile in smoke\.dockerfile, which files\/, readonly\/ or smoke\/ does not hold/);
  });

  it('defaults the smoke Dockerfile to Dockerfile, as every pack before it declared', () => {
    const project = load(fullstackPack((p) => {
      delete p.config.checks.smoke.dockerfile;
      p.config.files[0] = { path: 'Dockerfile', source: 'files/Dockerfile', editable: true, language: 'dockerfile' };
    }));
    const deployment = project.phases.find((p) => p.key === 'deployment') as PhaseContent;
    if (deployment.checks.kind !== 'config') throw new Error('expected config checks');
    expect(deployment.checks.smokeDockerfile).toBe('Dockerfile');
  });
});

/**
 * The pin, at the accessor.
 *
 * `getProject(slug)` answers the published head, and that is right for a
 * request that names a project. It is wrong for an enrolment: a learner
 * resolved to a published version must not have a rubric, a hidden suite or a
 * phase title move under an attempt, so every content resolution an enrolment
 * owns goes through the pair below instead.
 *
 * The fixture is two versions of the shipped pack that differ in one phase
 * title and in which phases they hold, installed straight into the registry:
 * no database, because what is being tested here is the resolution and not the
 * storage. `import-identity.spec.ts` is the other half: the same resolution
 * over snapshots that came out of `project_versions`.
 */
describe('ContentService (the pin: an enrolment resolves the version it holds)', () => {
  let content: ContentService;
  let head: ProjectContent;
  let pinned: ProjectContent;

  beforeAll(() => {
    const disk = new ContentService();
    disk.loadAll();
    const loaded = disk.getProject('tasktrackr');
    // the superseded version: one phase retitled, and one phase it never had
    pinned = {
      ...loaded,
      version: '1.0.0',
      phases: loaded.phases
        .filter((phase) => phase.key !== 'maintenance')
        .map((phase, at) => (at === 0 ? { ...phase, title: 'Requirements (1.0.0)' } : phase)),
    };
    head = { ...loaded, version: '2.0.0' };
    content = new ContentService();
    // the newest is installed *last* on purpose: the head is the newest
    // published version compared field by field as numbers, never the last row
    // a query happened to return
    content.installVersions([
      { versionId: 'version-2', content: head },
      { versionId: 'version-1', content: pinned },
    ]);
  });

  it('getForEnrollment resolves by version id', () => {
    const answer = content.getForEnrollment({
      projectSlug: 'tasktrackr',
      projectVersionId: 'version-1',
    });
    expect(answer.version).toBe('1.0.0');
    expect(answer.phases[0].title).toBe('Requirements (1.0.0)');
    expect(answer.phases.map((p) => p.key)).toEqual(pinned.phases.map((p) => p.key));
    expect(content.getPhaseForEnrollment(
      { projectSlug: 'tasktrackr', projectVersionId: 'version-1' },
      'requirements',
    ).title).toBe('Requirements (1.0.0)');

    // and the head is untouched by the read: a request naming the project
    // still answers the newest published version
    expect(content.getProject('tasktrackr').version).toBe('2.0.0');
    expect(content.getPhase('tasktrackr', 'requirements').title).toBe(head.phases[0].title);
  });

  it('getForEnrollment falls back to the published head for a legacy null pin', () => {
    const enrollment = { projectSlug: 'tasktrackr', projectVersionId: null };
    expect(content.getForEnrollment(enrollment).version).toBe('2.0.0');
    expect(content.getPhaseForEnrollment(enrollment, 'requirements').title).toBe(
      head.phases[0].title,
    );
    // the read never rewrites the row, so the enrolment it was handed is the
    // enrolment it hands back
    expect(enrollment).toEqual({ projectSlug: 'tasktrackr', projectVersionId: null });
    expect(content.getForEnrollment(enrollment).warmup ?? null).toEqual(head.warmup ?? null);
  });

  /**
   * The seam, asserted where the pin's own behaviour is asserted.
   * `getForEnrollment`, `getPhaseForEnrollment` and
   * `getTasksForEnrollment` read through one `resolveForEnrollment`, so a phase
   * and its task list can never be two versions'. `task-resolution.spec.ts`
   * holds the rest of that statement; this is the half that belongs beside the
   * fixture it would break.
   */
  it('the pin resolves one version, and names it', () => {
    const at = { projectSlug: 'tasktrackr', projectVersionId: 'version-1' };
    const resolved = content.resolveForEnrollment(at);
    expect(resolved.versionId).toBe('version-1');
    expect(resolved.content).toBe(content.getForEnrollment(at));

    // This fixture installs no compiled tasks, so every phase answers the sole
    // task the compiler synthesises for a phase declaring none: the shared
    // resolution changes where the answer is resolved, not what it is.
    expect(content.getTasksForEnrollment(at, 'requirements')).toEqual([
      soleTaskFor(content.getPhaseForEnrollment(at, 'requirements')),
    ]);

    // and a legacy null pin names the head's id rather than nothing, which is
    // what lets it resolve the head's task list rather than a synthesised one
    expect(
      content.resolveForEnrollment({ projectSlug: 'tasktrackr', projectVersionId: null }),
    ).toMatchObject({ versionId: 'version-2' });
  });

  it('getPhaseForEnrollment answers a 404 for a key the pinned version does not have', () => {
    expect(() =>
      content.getPhaseForEnrollment(
        { projectSlug: 'tasktrackr', projectVersionId: 'version-1' },
        'maintenance',
      ),
    ).toThrow(/unknown phase: maintenance/);
    // the same key on the head is answered, which is what makes the refusal a
    // statement about the pinned version rather than about the pack
    expect(
      content.getPhaseForEnrollment(
        { projectSlug: 'tasktrackr', projectVersionId: null },
        'maintenance',
      ).key,
    ).toBe('maintenance');
    expect(() =>
      content.getForEnrollment({ projectSlug: 'nosuchpack', projectVersionId: null }),
    ).toThrow(/unknown project: nosuchpack/);
  });

  it('the head is the newest published version, compared as numbers', () => {
    const registry = new ContentService();
    registry.installVersions([
      { versionId: 'nine', content: { ...head, version: '2.0.9' } },
      { versionId: 'ten', content: { ...head, version: '2.0.10' } },
    ]);
    // '2.0.10' > '2.0.9' is false between strings, which is why the head is
    // resolved by comparing the fields as numbers
    expect(registry.getProject('tasktrackr').version).toBe('2.0.10');
    expect(registry.headVersionIdFor('tasktrackr')).toBe('ten');
    expect(registry.headVersionIdFor('nosuchpack')).toBeNull();
  });

  /**
   * The two data faults the pin can arrive in, and why neither takes a
   * learner's door away.
   *
   * Both are refused at the door that writes them (the class import refuses an
   * enrolment naming a version the destination does not hold, by name), so a
   * row in either shape is a fault rather than a case. The resolution is
   * therefore the one the platform had before the pin existed, the published
   * head, and the fault is a warning naming the row so an operator can find it.
   */
  it('a pin the registry does not hold answers the head, and says so', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(
        content.getForEnrollment({ projectSlug: 'tasktrackr', projectVersionId: 'no-such-version' })
          .version,
      ).toBe('2.0.0');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-such-version'));

      // and a pin naming a version of *another* project answers this
      // enrolment's own project: `projectSlug` is what every other row keys on
      warn.mockClear();
      const second = new ContentService();
      second.installVersions([
        { versionId: 'version-2', content: head },
        { versionId: 'other-1', content: { ...head, slug: 'otherpack', version: '3.0.0' } },
      ]);
      const crossed = second.getForEnrollment({
        projectSlug: 'tasktrackr',
        projectVersionId: 'other-1',
      });
      expect({ slug: crossed.slug, version: crossed.version }).toEqual({
        slug: 'tasktrackr',
        version: '2.0.0',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('otherpack'));
    } finally {
      warn.mockRestore();
    }
  });
});
