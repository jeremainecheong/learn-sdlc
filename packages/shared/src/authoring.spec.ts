/**
 * The authoring contract for teacher-authored projects.
 *
 * Everything asserted here is read elsewhere: by the Nest controllers and
 * services under `/instructor/projects`, the teacher pages under
 * `/teacher/projects`, and the class panel that assigns a published version.
 * A route that drifts, a refusal that loses its subject, a minted path that
 * collides, or a safety gate that quietly opens, fails in this file rather
 * than in the code that trusted it.
 */

import type { PhaseKey } from './phases';
import { PHASE_ORDER } from './phases';
import {
  ARTEFACT_TYPES,
  PHASE_ARTEFACT_TYPE_SUGGESTION,
  PROJECT_FILE_ROLES,
  PROJECT_VERSION_PATTERN,
  SEALED_FILE_ROLES,
  SOLE_TASK_KEY,
  isAuthoredTaskKey,
} from './projects';
// The whole module, so a spec can read an export through the module object.
import * as authoringModule from './authoring';
import {
  ASSIGNMENT_REASON_MIN,
  AUTHORABLE_ARTEFACT_TYPES,
  AUTHORING_AUDIT_EVENTS,
  AUTHORING_READABLE_FILE_ROLES,
  AUTHORING_ROUTES,
  AUTHORING_ROUTE_KEYS,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_QUIZ_PASS_MARK,
  DRAFT_FIRST_VERSION,
  EXECUTABLE_SPLIT_NOT_READY,
  INHERITED_TASK_KEY,
  INHERITED_TASK_NOTICE,
  SUPPORTED_STACKS_SENTENCE,
  VALIDATION_STATUSES,
  authorableArtefactTypeRefusal,
  draftAlreadyOpenRefusal,
  draftFromStaleHeadRefusal,
  duplicateArtefactPathRefusal,
  inheritedTaskRefusal,
  isAuthorableTask,
  isAuthoringReadableRole,
  learnerRuleCountDescription,
  multiTaskPublishRefusal,
  nextDraftVersion,
  noRequiredTaskRefusal,
  notApplicableLine,
  nothingPublishedRefusal,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
  publishableTasksPerPhase,
  refusesMultiTaskPublish,
  splittableCheckKind,
  summariseValidation,
  unsupportedLibraryRefusal,
  type AuthoredQuiz,
  type AuthoredQuizView,
  type CreateDraftVersionBody,
  type ValidationCheck,
} from './authoring';

/* --------------------------- the safety gate ------------------------------ */

describe('one task per phase at publish', () => {
  it('answers six kinds, every one publishable as one non-quiz task', () => {
    for (const kind of ['story', 'design', 'code', 'tests', 'config', 'quiz'] as const) expect(publishableTasksPerPhase(kind)).toBe(1);
    expect(splittableCheckKind('story')).toBe(true);
    expect(splittableCheckKind('config')).toBe(false);
  });

  it('the refusal carries the one sentence', () => {
    const sentence = multiTaskPublishRefusal('Implementation', 3, 'code');
    expect(sentence).toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(sentence).toContain('Implementation');
    expect(sentence).toContain('3');
    expect(sentence.endsWith('.')).toBe(true);
    expect(sentence).not.toMatch(/\s{2,}/);
    // The written phase's refusal is the general one-task sentence and does
    // not borrow the wall's. A written phase holding several tasks is refused
    // with it, and a caller that reworded it into the wall's would be saying
    // executable splitting is what a teacher is waiting for.
    expect(multiTaskPublishRefusal('Requirements', 3, 'story')).not.toContain(
      EXECUTABLE_SPLIT_NOT_READY,
    );
    expect(multiTaskPublishRefusal('Requirements', 3)).toBe(
      multiTaskPublishRefusal('Requirements', 3, 'story'),
    );
    // A phase whose OWN checks are `quiz` is refused above one task, and it
    // must not be refused with the executable sentence: the code, test and
    // deployment graders are not what grades it, and
    // `EXECUTABLE_SPLIT_NOT_READY` is not the reason. It reads the general
    // sentence, and the compiler's `phase-needs-a-required-artefact-task`
    // is what says the true thing, because it can see the required set.
    expect(multiTaskPublishRefusal('Design', 2, 'quiz')).not.toContain(
      EXECUTABLE_SPLIT_NOT_READY,
    );
    expect(multiTaskPublishRefusal('Design', 2, 'quiz')).toBe(
      multiTaskPublishRefusal('Design', 2),
    );
  });

  it('names the phase and the count in the refusal, so a teacher knows what to move', () => {
    const sentence = multiTaskPublishRefusal('Requirements', 3);
    expect(sentence).toContain('Requirements');
    expect(sentence).toContain('3');
    expect(sentence.endsWith('.')).toBe(true);
  });

  it('a task may be splittable where a phase of that kind is not: the quiz sits on the written side', () => {
    // The wall is two refusals and only the second is about
    // a task. `splittableCheckKind` answers the second; `publishableTasksPerPhase`
    // answers neither: it is kind-only, it is called with the PHASE's kind at
    // both of its call sites, and it does not move.
    expect(splittableCheckKind('story')).toBe(true);
    expect(splittableCheckKind('design')).toBe(true);
    expect(splittableCheckKind('quiz')).toBe(true);
    expect(splittableCheckKind('code')).toBe(false);
    expect(splittableCheckKind('tests')).toBe(false);
    expect(splittableCheckKind('config')).toBe(false);

    // The one that must NOT move, and the reason it must not: widening this
    // would admit a phase whose own `checks.kind` is `quiz` holding many tasks,
    // which is exactly the shape `phase-needs-a-required-artefact-task` is
    // written to refuse: a phase gated by an MCQ and nothing else.
    expect(publishableTasksPerPhase('quiz')).toBe(1);
    expect(refusesMultiTaskPublish(2, 'quiz')).toBe(true);
    // And every other kind publishes one task too.
    expect(publishableTasksPerPhase('story')).toBe(1);
    expect(publishableTasksPerPhase('code')).toBe(1);
    expect(publishableTasksPerPhase('tests')).toBe(1);
    expect(publishableTasksPerPhase('config')).toBe(1);
  });
});

/* ----------------------------- the route table ---------------------------- */

describe('the authoring route table', () => {
  it('covers every key exactly once', () => {
    const keys = AUTHORING_ROUTE_KEYS;
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(AUTHORING_ROUTES).sort()).toEqual([...keys].sort());
  });

  it('lives under /instructor, which is the API namespace staff routes already use', () => {
    for (const key of AUTHORING_ROUTE_KEYS) {
      expect(AUTHORING_ROUTES[key].path.startsWith('/instructor/')).toBe(true);
    }
  });

  it('declares one method and path per route, and no two routes collide', () => {
    const seen = new Set<string>();
    for (const key of AUTHORING_ROUTE_KEYS) {
      const route = AUTHORING_ROUTES[key];
      expect(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).toContain(route.method);
      const shape = `${route.method} ${route.path.replace(/:[a-zA-Z]+/g, ':p')}`;
      expect(seen.has(shape)).toBe(false);
      seen.add(shape);
    }
  });

  it('is INSTRUCTOR or ADMIN everywhere, because the guard is the API and not the page', () => {
    for (const key of AUTHORING_ROUTE_KEYS) {
      expect([...AUTHORING_ROUTES[key].roles].sort()).toEqual(['ADMIN', 'INSTRUCTOR']);
    }
  });

  it('marks a mutation as a mutation, so the audit lane has a list to walk', () => {
    for (const key of AUTHORING_ROUTE_KEYS) {
      const route = AUTHORING_ROUTES[key];
      expect(route.mutates).toBe(route.method !== 'GET');
    }
    const audited = AUTHORING_ROUTE_KEYS.filter((key) => AUTHORING_ROUTES[key].mutates);
    expect(audited.length).toBeGreaterThan(0);
    for (const key of audited) {
      expect(AUTHORING_AUDIT_EVENTS).toContain(AUTHORING_ROUTES[key].audit);
    }
  });

  it('never puts the sole task key in a URL', () => {
    // `SOLE_TASK_KEY` is `''`: a path segment it filled would be no segment at
    // all, which is why an authoring surface addresses authored keys only.
    for (const key of AUTHORING_ROUTE_KEYS) {
      expect(AUTHORING_ROUTES[key].path).not.toContain(`/${SOLE_TASK_KEY}/`);
      expect(AUTHORING_ROUTES[key].path.endsWith('/')).toBe(false);
    }
  });

  it('opens the next draft from the published head, so a project outlives its first publish', () => {
    // Without this route a project is editable exactly once: `projects.create`
    // is the only maker of a draft, and `version.publish` freezes it. A teacher
    // who published would have to copy their own project to change a word.
    const open = AUTHORING_ROUTES['versions.createDraft'];
    expect(open.method).toBe('POST');
    expect(open.path).toBe('/instructor/projects/:projectId/versions');
    expect(open.mutates).toBe(true);
    expect(open.audit).toBe('project.draft');
    // It is a different act from reading a draft, and the two never collide.
    expect(AUTHORING_ROUTES['version.draft'].method).toBe('GET');
    expect(AUTHORING_ROUTES['version.draft'].path.startsWith(open.path)).toBe(true);
    // The guard is the head the teacher was looking at, so a publish that
    // landed while the page was open is refused rather than silently skipped.
    const body: CreateDraftVersionBody = { fromVersionId: 'ver_1' };
    expect(body.fromVersionId).toBe('ver_1');
  });

  it('names the class-assignment routes on the cohort, which is what scopes them', () => {
    expect(AUTHORING_ROUTES['assignment.read'].path).toBe('/instructor/cohorts/:cohortId/project');
    expect(AUTHORING_ROUTES['assignment.assign'].path).toBe(
      '/instructor/cohorts/:cohortId/project',
    );
    expect(AUTHORING_ROUTES['assignment.assignable'].path).toBe(
      '/instructor/cohorts/:cohortId/project/assignable',
    );
  });
});

/* ----------------------------- the audit events --------------------------- */

describe('the audit events', () => {
  it('are unique, dotted and lower case', () => {
    expect(new Set(AUTHORING_AUDIT_EVENTS).size).toBe(AUTHORING_AUDIT_EVENTS.length);
    for (const event of AUTHORING_AUDIT_EVENTS) {
      expect(event).toMatch(/^[a-z]+\.[a-z-]+$/);
    }
  });
});

/* ------------------------------- the seal --------------------------------- */

describe('what an authoring endpoint may return bytes for', () => {
  it('is the two learner-facing roles and nothing else', () => {
    expect(AUTHORING_READABLE_FILE_ROLES).toEqual(['workspace', 'warmup']);
  });

  it('withholds every sealed role, and canonical with them', () => {
    for (const role of SEALED_FILE_ROLES) {
      expect(isAuthoringReadableRole(role)).toBe(false);
    }
    // `canonical` is not in the sealed set (a phase may legitimately mount it
    // as a locked workspace row), and it is still the finished application, so
    // the authoring API answers its path, role and size and never its bytes.
    expect(isAuthoringReadableRole('canonical')).toBe(false);
  });

  it('is derived from the role sets rather than being a second copy of them', () => {
    const derived = PROJECT_FILE_ROLES.filter((role) => isAuthoringReadableRole(role));
    expect(derived).toEqual(AUTHORING_READABLE_FILE_ROLES);
  });
});

/* --------------------------- what a teacher may author -------------------- */

describe('the authorable artefact types', () => {
  it('authors only the story, the design and the quiz, and reads the two older pairs', () => {
    expect(AUTHORABLE_ARTEFACT_TYPES).toEqual(['user-story', 'design-doc', 'quiz']);
    expect(isAuthorableTask('story', 'user-story')).toBe(true);
    expect(isAuthorableTask('design', 'design-doc')).toBe(true);
    expect(isAuthorableTask('quiz', 'quiz')).toBe(true);
    expect(isAuthorableTask('markdown', 'user-story')).toBe(true);
    expect(isAuthorableTask('markdown', 'design-doc')).toBe(true);
    expect(isAuthorableTask('markdown', 'document')).toBe(false);
    expect(isAuthorableTask('config', 'runbook')).toBe(false);
  });

  it('a quiz is authorable by its own kind, and by no other', () => {
    // A quiz is its own clause: the type decides which kind is allowed, and the
    // kind still has to agree. A quiz under any other kind is a task whose key
    // nothing reads, and a user story scored by the quiz grader is a task whose
    // floor nothing reads.
    expect(isAuthorableTask('quiz', 'quiz')).toBe(true);
    expect(isAuthorableTask('markdown', 'quiz')).toBe(false);
    expect(isAuthorableTask('story', 'quiz')).toBe(false);
    expect(isAuthorableTask('code', 'quiz')).toBe(false);
    expect(isAuthorableTask('tests', 'quiz')).toBe(false);
    expect(isAuthorableTask('config', 'quiz')).toBe(false);
    for (const type of ['user-story', 'design-doc', 'document'] as const) {
      expect(isAuthorableTask('quiz', type)).toBe(false);
    }
  });

  it('refuses an unauthorable type by name, and refuses editing an inherited task', () => {
    expect(authorableArtefactTypeRefusal('code')).toContain('code');
    expect(inheritedTaskRefusal('Build the API')).toContain('Build the API');
    expect(inheritedTaskRefusal('Build the API')).toContain(INHERITED_TASK_NOTICE);
  });
});

/* --------------------------- the refusal sentences ------------------------ */

describe('the refusal sentences', () => {
  const sentences: [string, string][] = [
    ['multi-task publish', multiTaskPublishRefusal('Requirements', 2)],
    ['unsupported library', unsupportedLibraryRefusal('python', 'fastapi')],
    ['no required task', noRequiredTaskRefusal('Design')],
    ['duplicate artefact path', duplicateArtefactPathRefusal('requirements/draft.md', 'Write the story')],
    ['not your project', projectNotYoursRefusal()],
    ['platform project is copy-only', platformProjectCopyOnlyRefusal('TaskTrackr')],
    ['a draft is already open', draftAlreadyOpenRefusal('1.3.0')],
    ['nothing is published yet', nothingPublishedRefusal('Ward Rounds')],
    ['the head moved under the page', draftFromStaleHeadRefusal('2.1.0')],
  ];

  it('each say something, in the product’s voice, ending in a full stop', () => {
    for (const [name, sentence] of sentences) {
      expect(typeof sentence).toBe('string');
      expect(sentence.length).toBeGreaterThan(30);
      expect(sentence.endsWith('.')).toBe(true);
      expect(sentence).not.toMatch(/\s{2,}/);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('each name their subject, so a teacher knows what to change', () => {
    expect(unsupportedLibraryRefusal('python', 'fastapi')).toContain('fastapi');
    expect(noRequiredTaskRefusal('Design')).toContain('Design');
    expect(duplicateArtefactPathRefusal('requirements/draft.md', 'Write the story')).toContain(
      'requirements/draft.md',
    );
    expect(duplicateArtefactPathRefusal('requirements/draft.md', 'Write the story')).toContain(
      'Write the story',
    );
    expect(platformProjectCopyOnlyRefusal('TaskTrackr')).toContain('TaskTrackr');
    expect(draftAlreadyOpenRefusal('1.3.0')).toContain('1.3.0');
    expect(nothingPublishedRefusal('Ward Rounds')).toContain('Ward Rounds');
    expect(draftFromStaleHeadRefusal('2.1.0')).toContain('2.1.0');
  });

  it('tells a teacher whose draft was refused where the work they can do is', () => {
    // Each of the three draft refusals ends somewhere the teacher can act: the
    // draft that is already open, the publish that has not happened, or the
    // version somebody else published while this page was open.
    expect(draftAlreadyOpenRefusal('1.3.0').toLowerCase()).toContain('draft');
    expect(nothingPublishedRefusal('Ward Rounds').toLowerCase()).toContain('publish');
    expect(draftFromStaleHeadRefusal('2.1.0').toLowerCase()).toContain('reload');
  });

  it('offer the way forward rather than only the wall', () => {
    expect(platformProjectCopyOnlyRefusal('TaskTrackr').toLowerCase()).toContain('copy');
    expect(projectNotYoursRefusal().toLowerCase()).toContain('copy');
    expect(unsupportedLibraryRefusal('node', 'vue')).toContain(SUPPORTED_STACKS_SENTENCE);
  });

  it('never blame the learner or promise a date', () => {
    for (const [, sentence] of sentences) {
      expect(sentence.toLowerCase()).not.toContain('soon');
      expect(sentence.toLowerCase()).not.toContain('coming');
    }
  });
});

/* -------------------------- the validation report -------------------------- */

describe('the fast validation report', () => {
  const check = (over: Partial<ValidationCheck>): ValidationCheck => ({
    id: 'a-check',
    label: 'A check',
    status: 'passed',
    sentence: 'Nothing is wrong here.',
    phaseKey: null,
    taskKey: null,
    files: [],
    ...over,
  });

  it('has exactly three statuses', () => {
    expect(VALIDATION_STATUSES).toEqual(['passed', 'failed', 'not-applicable']);
  });

  it('counts each status and says publish would be accepted when nothing failed', () => {
    const report = summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
      check({ id: 'one' }),
      check({ id: 'two', status: 'not-applicable', sentence: 'This project ships no application.' }),
    ]);
    expect(report.tier).toBe('fast');
    expect(report.ranAt).toBe('2026-09-19T00:00:00.000Z');
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.notApplicable).toBe(1);
    expect(report.publishable).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.notApplicableLine).toBe('1 check does not apply to this project.');
  });

  it('says exactly why publish would refuse, in the order the checks were run', () => {
    const first = multiTaskPublishRefusal('Requirements', 3);
    const second = noRequiredTaskRefusal('Design');
    const report = summariseValidation('fast', '2026-09-19T00:00:00.000Z', [
      check({ id: 'phase-holds-one-task', status: 'failed', sentence: first, phaseKey: 'requirements' }),
      check({ id: 'ok' }),
      check({ id: 'required-task-per-phase', status: 'failed', sentence: second, phaseKey: 'design' }),
    ]);
    expect(report.publishable).toBe(false);
    expect(report.blocking).toEqual([first, second]);
    expect(report.failed).toBe(2);
    expect(report.notApplicableLine).toBeNull();
  });

  it('collapses the not-applicable rows behind one line that counts them', () => {
    expect(notApplicableLine(0)).toBeNull();
    expect(notApplicableLine(1)).toBe('1 check does not apply to this project.');
    expect(notApplicableLine(18)).toBe('18 checks do not apply to this project.');
  });
});

/* --------------------------- the rule-count line --------------------------- */

describe('the line a learner reads under a criterion the teacher\'s rules score', () => {
  it('counts the rules, ending in a full stop', () => {
    expect(learnerRuleCountDescription(1)).toBe('Scored by 1 rule your teacher set.');
    expect(learnerRuleCountDescription(3)).toBe('Scored by 3 rules your teacher set.');
    for (const count of [1, 2, 3, 9]) {
      expect(learnerRuleCountDescription(count).endsWith('.')).toBe(true);
      expect(learnerRuleCountDescription(count)).toContain(String(count));
    }
  });
});

/* ---------------------------- the small constants ------------------------- */

describe('the constants the doors read', () => {
  it('opens the next draft at a version publish would still accept', () => {
    // Publish refuses anything that is not newer than the head, so the draft
    // has to start somewhere newer or a teacher who changes nothing about the
    // number cannot publish at all.
    expect(nextDraftVersion('1.0.0')).toBe('1.0.1');
    expect(nextDraftVersion('2.11.9')).toBe('2.11.10');
    for (const head of ['1.0.0', '0.1.0', '2.11.9', '10.0.3']) {
      expect(PROJECT_VERSION_PATTERN.test(nextDraftVersion(head))).toBe(true);
    }
    // Nothing is guessed at from a string the pattern would not accept.
    expect(nextDraftVersion('not-a-version')).toBe(DRAFT_FIRST_VERSION);
    expect(nextDraftVersion('1.0')).toBe(DRAFT_FIRST_VERSION);
  });

  it('opens a copy at a draft version the pattern accepts', () => {
    expect(PROJECT_VERSION_PATTERN.test(DRAFT_FIRST_VERSION)).toBe(true);
    expect(DRAFT_FIRST_VERSION).toBe('0.1.0');
  });

  it('asks a class reassignment for the same ten characters every override already asks', () => {
    expect(ASSIGNMENT_REASON_MIN).toBe(10);
  });

  it('says which stacks this deployment runs, without naming a date', () => {
    expect(SUPPORTED_STACKS_SENTENCE.endsWith('.')).toBe(true);
    expect(SUPPORTED_STACKS_SENTENCE.toLowerCase()).not.toContain('soon');
  });

  it('has one notice for an inherited task and it promises nothing it cannot keep', () => {
    expect(INHERITED_TASK_NOTICE).toBe(
      'Inherited from the project you copied. It is graded as it came, and it cannot be edited or removed here.',
    );
    // No roadmap wording in product copy.
    expect(INHERITED_TASK_NOTICE).not.toMatch(/arrives|next|soon|later|coming|future/i);
  });

  it('gives the inherited sole task a key a route can address', () => {
    // `SOLE_TASK_KEY` is `''` and can never be a path segment, so a copy
    // materialises the phase's sole task under this key instead.
    expect(INHERITED_TASK_KEY).toBe('main');
    expect(INHERITED_TASK_KEY).not.toBe(SOLE_TASK_KEY);
    expect(isAuthoredTaskKey(INHERITED_TASK_KEY)).toBe(true);
  });
});

/* ---------------------------- the authored quiz ---------------------------- */

describe('the quiz a teacher writes', () => {
  /** A two-question quiz with a key and explanations, as the owner would send it. */
  const authored: AuthoredQuiz = {
    questions: [
      {
        id: 'story-grammar',
        stem: 'Which line is a user story?',
        options: [
          { id: 'a', text: 'As a marker, I want …, so that …' },
          { id: 'b', text: 'Add a button to the marking screen.' },
        ],
        correct: ['a'],
        explanation: 'A story names the role, the goal and the benefit.',
        concept: 'role/goal/benefit',
      },
      {
        id: 'invest',
        stem: 'Which two make a story INVEST-able?',
        options: [
          { id: 'a', text: 'It is independent.' },
          { id: 'b', text: 'It names a class.' },
          { id: 'c', text: 'It is testable.' },
        ],
        correct: ['a', 'c'],
        explanation: 'Independence and testability are two of the six.',
      },
    ],
    passMark: 60,
  };

  it('defaults a required quiz to a mark five questions can actually land on', () => {
    // EDIT ME, do not satisfy me: this is a policy number, not a
    // computation. A five-question paper scores 0, 20, 40,
    // 60, 80 or 100, so `DEFAULT_PASS_THRESHOLD`'s 70 is 80 wearing another
    // number and `quiz-pass-mark-reachable` would warn about it on the first
    // quiz anybody wrote.
    expect(DEFAULT_QUIZ_PASS_MARK).toBe(60);
    expect(DEFAULT_QUIZ_PASS_MARK).not.toBe(DEFAULT_PASS_THRESHOLD);
    expect(DEFAULT_PASS_THRESHOLD).toBe(70);
  });

  it('carries the key in the owner’s own payload, and nowhere else', () => {
    // `AuthoredQuiz` is what the audited `…/quiz/key` route answers with and
    // what its owner sends. It is the one shape in this file that holds a key.
    expect(authored.questions[0].correct).toEqual(['a']);
    expect(authored.questions[1].correct).toEqual(['a', 'c']);
  });

  it('the draft payload is a different type, and the seal is one substring', () => {
    // `readDraft` and `listTasks` are guarded by `requireVisibleProject`, which
    // admits every instructor on the deployment for any platform-owned project
    // and any ADMIN for anybody's. So the draft carries `AuthoredQuizView`, and
    // `AuthoredQuizView` is a separate type rather than `AuthoredQuiz` with two
    // fields deleted: a builder that starts from the wrong shape does not
    // compile.
    //
    // The view says how many options the key holds and never which, and the
    // count is called `answerCount`, so the string `correct` appears nowhere
    // in it, and the API's seal test is one assertion over the whole serialised payload
    // rather than a field-by-field walk.
    const view: AuthoredQuizView = {
      questions: authored.questions.map((question) => ({
        id: question.id,
        stem: question.stem,
        options: question.options,
        answerCount: question.correct.length,
        concept: question.concept,
      })),
      shuffleOptions: true,
      passMark: authored.passMark ?? DEFAULT_QUIZ_PASS_MARK,
      attempts: { max: 3, cooldownSeconds: null },
      criterion: 'concepts',
    };

    const wire = JSON.stringify(view);
    expect(wire).not.toContain('correct');
    expect(wire).not.toContain('explanation');
    for (const question of authored.questions) {
      expect(wire).not.toContain(question.explanation);
    }
    // What it does carry: enough for the editor to draw "pick 2" without the
    // answer being in the payload.
    expect(view.questions.map((question) => question.answerCount)).toEqual([1, 2]);
    expect(view.questions[1].options.map((option) => option.id)).toEqual(['a', 'b', 'c']);
  });
});

/* --------------------- the phase key vocabulary is reused ----------------- */

describe('the vocabulary', () => {
  it('reuses the six phase keys rather than declaring a seventh', () => {
    const keys: PhaseKey[] = [...PHASE_ORDER];
    expect(keys).toHaveLength(6);
    for (const key of keys) {
      expect(PHASE_ARTEFACT_TYPE_SUGGESTION[key]).toBeDefined();
    }
  });
});

/* ---------------------------- executable authoring ----------------------------
 *
 * A phase's one code or tests task is editable, so the editor needs a second
 * predicate beside `isAuthorableTask`. It is a second predicate and not a
 * widening of the first: `AUTHORABLE_ARTEFACT_TYPES` is read by the learner
 * room and pinned by four invariants above, so it answers for written tasks
 * only, and the guard below says so.
 *
 * Read through `authoringModule` so that, if the predicate's export is
 * missing, that is this test's failure and not a failed compile of the file.
 * ------------------------------------------------------------------------- */

describe('the executable authoring predicate', () => {
  type Predicate = (checkKind: string, artefactType: string) => boolean;
  const KINDS = ['markdown', 'story', 'design', 'code', 'tests', 'config', 'quiz'];

  it('isAuthorableExecutableTask is true only for (code, code) and (tests, tests)', () => {
    const module = authoringModule as unknown as {
      isAuthorableExecutableTask?: Predicate;
      EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES?: string[];
    };
    expect(module.EXECUTABLE_AUTHORABLE_ARTEFACT_TYPES).toEqual(['code', 'tests']);
    const predicate = module.isAuthorableExecutableTask as Predicate;
    expect(typeof predicate).toBe('function');
    const yes: string[] = [];
    for (const kind of KINDS) {
      for (const type of ARTEFACT_TYPES) {
        if (predicate(kind, type)) yes.push(`${kind}/${type}`);
      }
    }
    expect(yes).toEqual(['code/code', 'tests/tests']);
  });

  it('GUARD: AUTHORABLE_ARTEFACT_TYPES and isAuthorableTask answer for written tasks only', () => {
    expect(AUTHORABLE_ARTEFACT_TYPES).toEqual(['user-story', 'design-doc', 'quiz']);
    const yes: string[] = [];
    for (const kind of KINDS) {
      for (const type of ARTEFACT_TYPES) {
        if (isAuthorableTask(kind as Parameters<typeof isAuthorableTask>[0], type)) yes.push(`${kind}/${type}`);
      }
    }
    // The three written pairs and the two older pairs a legacy reader converts, and no executable one.
    expect(yes).toEqual(['markdown/user-story', 'markdown/design-doc', 'story/user-story', 'design/design-doc', 'quiz/quiz']);
  });
});

// A teacher reads the criterion's name, never its key: not "correctness_hidden is graded by the phase's own checks".
describe('lockedCriterionRefusal names a criterion, never by its key alone', () => {
  it('uses the title the caller has, then the words for the grader\'s own keys, then the key quoted as a name', () => {
    expect(authoringModule.lockedCriterionRefusal('correctness_hidden', 'Change and regression (hidden tests)')).toBe("Change and regression (hidden tests) is graded by the phase's own checks, so it stays in the rubric.");
    expect(authoringModule.lockedCriterionRefusal('correctness_hidden')).toBe("Hidden tests is graded by the phase's own checks, so it stays in the rubric.");
    expect(authoringModule.lockedCriterionRefusal('build_smoke', '  ')).toBe("The isolated selfcheck is graded by the phase's own checks, so it stays in the rubric.");
    for (const key of ['visible_tests', 'code_quality', 'process', 'tests_pass', 'mutants_killed', 'coverage_mapping']) {
      expect(authoringModule.lockedCriterionRefusal(key)).not.toContain(key);
    }
    expect(authoringModule.lockedCriterionRefusal('config_completeness')).toBe('The criterion "config_completeness" is graded by the phase\'s own checks, so it stays in the rubric.');
    expect(authoringModule.lockedCriterionRefusal('k', 'x'.repeat(200))).toBe(`${'x'.repeat(120)} is graded by the phase's own checks, so it stays in the rubric.`);
  });
});
