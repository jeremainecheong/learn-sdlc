/**
 * The authoring contract for phase edits, the interview editor, file
 * replacement, provenance, the quiz reveal and the learner's task reset.
 *
 * Every shape and value in this file is read by the API (the authoring doors,
 * the provenance resolver, the quiz reveal, the learner's task reset, the
 * epoch in a class export, the default-project flag) and by the web app (the
 * editor, the class card, the learner rooms, the reset control). So a value
 * that drifts, a sentence that loses its subject, or a field that stops being
 * optional fails here, before either side trusts it.
 *
 * Three rules this file holds on purpose:
 *
 * - **Append only.** The five route rows and the four audit names this spec
 *   covers sit after the twenty rows and nine names ahead of them, and those
 *   earlier entries are pinned exactly, so "five added, none edited" is
 *   asserted rather than promised.
 * - **The vocabulary says `reference`, never the project's slug.** The web's
 *   codebase guard refuses a quoted project slug in `lib/`,
 *   `components/` and `app/`, and every provenance switch the web writes
 *   compares against one of these values. The name a person reads comes from
 *   the payload (`referenceName`, `application`), never from a literal.
 * - **The draft's interview view carries no answer**, the way
 *   `AuthoredQuizView` carries no key: its members are pinned exactly,
 *   optional ones included, so no field can hold one. The bytes the API sends
 *   are the API's serialised-response test to prove; shared has no builder of
 *   this view to run.
 *
 * The type-level assertions below are real assertions: this file is compiled
 * by ts-jest with diagnostics on, so a field that stops being optional, or an
 * answer that appears on the draft view, is a failed compile of this suite.
 */

import {
  AUTHORING_AUDIT_EVENTS,
  AUTHORING_ROUTES,
  AUTHORING_ROUTE_KEYS,
  COHORT_EXPORT_VERSION,
  CRITERION_DESCRIPTION_MAX,
  CRITERION_TITLE_MAX,
  ELEMENT_PROVENANCE_STATES,
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_FACT_ID_PATTERN,
  INTERVIEW_KEYWORDS_MAX,
  INTERVIEW_KEYWORD_MAX,
  INTERVIEW_LINE_MAX,
  INTERVIEW_MAX_FACTS,
  INTERVIEW_MAX_TURNS_CAP,
  INTERVIEW_MAX_TURNS_MIN,
  INTERVIEW_PERSONA_NAME_MAX,
  INTERVIEW_PERSONA_ROLE_MAX,
  INTERVIEW_PHASE,
  INTERVIEW_TOPIC_MAX,
  PHASE_INTRO_MAX,
  PHASE_PROVENANCE_ROLLUPS,
  PHASE_SUMMARY_INTRO_MAX,
  QUIZ_REVEAL_EXPLANATIONS,
  REPLACE_FILE_CONTENT_MAX,
  ROOM_TASK_PROVENANCES,
  applicationFileRefusal,
  applicationPhasesSentence,
  fileNotMountedRefusal,
  referenceFileBriefNote,
  roomRecordRefusal,
  withheldFileReplaceRefusal,
  type AssignableVersionView,
  type AuditEventView,
  type AuthoredQuiz,
  type AuthoredQuizView,
  type AuthoringAuditEvent,
  type AuthoringRouteKey,
  type CohortExportSubmission,
  type CohortProjectAssignmentView,
  type CriterionWordingBody,
  type DraftInterviewView,
  type DraftPhaseView,
  type ElementProvenance,
  type EnrollmentView,
  type InterviewBody,
  type PhaseDetail,
  type PhaseMutationResult,
  type PhaseProvenanceRollup,
  type PhaseProvenanceView,
  type PhaseSummary,
  type QuizChecks,
  type QuizRevealExplanation,
  type QuizRoomView,
  type ReplaceFileBody,
  type ReplaceFileResult,
  type ResetTaskInput,
  type RoomTaskProvenance,
  type TaskMutationResult,
  type TaskResetPlanView,
  type TaskResetResult,
  type UpdatePhaseBody,
  type UpdateTaskBody,
  type VersionProvenanceView,
} from './index';

/** True exactly when `K` may be left out of a `T`: an optional field. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

/**
 * True exactly when `T`'s members are `K`, no more and no fewer. An optional
 * member counts, so a field added to a view or a body, an `answers?` map on
 * the draft's interview, a `digest?` on a provenance row, is a failed
 * compile, not a quiet pass.
 */
type HasExactlyKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? [K] extends [keyof T]
    ? true
    : false
  : false;

/* --------------------------- the five route rows --------------------------- */

/** The table's first twenty keys, in their order. */
const BEFORE_KEYS = [
  'projects.list',
  'projects.create',
  'projects.get',
  'projects.updateMeta',
  'projects.archive',
  'version.draft',
  'version.validate',
  'version.publish',
  'tasks.list',
  'tasks.add',
  'tasks.update',
  'tasks.setRequired',
  'tasks.reorder',
  'tasks.remove',
  'files.list',
  'assignment.assignable',
  'assignment.read',
  'assignment.assign',
  'versions.createDraft',
  'tasks.quizKey',
];

/** Each of those twenty rows as `METHOD path audit`, exactly. */
const BEFORE_ROWS: Record<string, string> = {
  'projects.list': 'GET /instructor/projects null',
  'projects.create': 'POST /instructor/projects project.create',
  'projects.get': 'GET /instructor/projects/:projectId null',
  'projects.updateMeta': 'PATCH /instructor/projects/:projectId project.update',
  'projects.archive': 'POST /instructor/projects/:projectId/archive project.archive',
  'version.draft': 'GET /instructor/projects/:projectId/versions/:versionId null',
  'version.validate': 'POST /instructor/projects/:projectId/versions/:versionId/validate project.validate',
  'version.publish': 'POST /instructor/projects/:projectId/versions/:versionId/publish project.publish',
  'tasks.list': 'GET /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks null',
  'tasks.add': 'POST /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks project.tasks',
  'tasks.update':
    'PATCH /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey project.tasks',
  'tasks.setRequired':
    'PUT /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/required project.tasks',
  'tasks.reorder': 'PUT /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/task-order project.tasks',
  'tasks.remove':
    'DELETE /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey project.tasks',
  'files.list': 'GET /instructor/projects/:projectId/versions/:versionId/files null',
  'assignment.assignable': 'GET /instructor/cohorts/:cohortId/project/assignable null',
  'assignment.read': 'GET /instructor/cohorts/:cohortId/project null',
  'assignment.assign': 'PUT /instructor/cohorts/:cohortId/project cohort.project',
  'versions.createDraft': 'POST /instructor/projects/:projectId/versions project.draft',
  'tasks.quizKey': 'GET /instructor/projects/:projectId/versions/:versionId/phases/:phaseKey/tasks/:taskKey/quiz/key null',
};

const PHASE = '/instructor/projects/:projectId/versions/:versionId/phases';

describe('the five authoring route rows', () => {
  it('appends exactly five keys after the twenty that were there, and moves none', () => {
    expect(AUTHORING_ROUTE_KEYS.slice(0, BEFORE_KEYS.length)).toEqual(BEFORE_KEYS);
    // Bounded to these five keys; later keys are appended after them, and
    // upload-contract.spec.ts pins the rest.
    expect(AUTHORING_ROUTE_KEYS.slice(BEFORE_KEYS.length, BEFORE_KEYS.length + 5)).toEqual([
      'phases.update',
      'interview.replace',
      'interview.remove',
      'interview.read',
      'files.replace',
    ]);
    // No key is listed twice, however many are appended. (A pin on the
    // length could not fail this way; a key appended twice can.)
    expect(new Set(AUTHORING_ROUTE_KEYS).size).toBe(AUTHORING_ROUTE_KEYS.length);
  });

  it('leaves every one of the twenty existing rows exactly as it was', () => {
    for (const key of BEFORE_KEYS) {
      const route = AUTHORING_ROUTES[key as AuthoringRouteKey];
      expect([key, `${route.method} ${route.path} ${route.audit}`]).toEqual([key, BEFORE_ROWS[key]]);
      expect([key, [...route.roles].sort()]).toEqual([key, ['ADMIN', 'INSTRUCTOR']]);
    }
  });

  it("edits a phase's intro at the phase itself", () => {
    expect(AUTHORING_ROUTES['phases.update']).toMatchObject({
      method: 'PATCH',
      path: `${PHASE}/:phaseKey`,
      mutates: true,
      audit: 'project.phase',
    });
  });

  it('writes, removes and reads the interview on Requirements, the one phase that can hold one', () => {
    expect(INTERVIEW_PHASE).toBe('requirements');
    const at = `${PHASE}/${INTERVIEW_PHASE}/interview`;
    expect(AUTHORING_ROUTES['interview.replace']).toMatchObject({
      method: 'PUT',
      path: at,
      mutates: true,
      audit: 'project.interview',
    });
    expect(AUTHORING_ROUTES['interview.remove']).toMatchObject({
      method: 'DELETE',
      path: at,
      mutates: true,
      audit: 'project.interview',
    });
    // A read that leaves a row, as `tasks.quizKey` is: `audit` names what a
    // **write** leaves, so it is null here, and the row's name is the fourth
    // audit event below.
    expect(AUTHORING_ROUTES['interview.read']).toMatchObject({
      method: 'GET',
      path: at,
      mutates: false,
      audit: null,
    });
    expect(AUTHORING_ROUTES['interview.read'].summary).toMatch(/owner alone/);
    expect(AUTHORING_ROUTES['interview.read'].summary).toMatch(/Audited on every read/);
  });

  it("replaces one file's bytes at the phase that mounts it", () => {
    expect(AUTHORING_ROUTES['files.replace']).toMatchObject({
      method: 'PUT',
      path: `${PHASE}/:phaseKey/files`,
      mutates: true,
      audit: 'project.files',
    });
  });

  it('keeps all five staff-only, under /instructor, and apart from every other route', () => {
    const shapes = new Set(
      AUTHORING_ROUTE_KEYS.map(
        (key) => `${AUTHORING_ROUTES[key].method} ${AUTHORING_ROUTES[key].path.replace(/:[a-zA-Z]+/g, ':p')}`,
      ),
    );
    expect(shapes.size).toBe(AUTHORING_ROUTE_KEYS.length);
    // Bounded to the entries this spec covers; later entries are appended
    // after them, and upload-contract.spec.ts pins the rest.
    for (const key of AUTHORING_ROUTE_KEYS.slice(BEFORE_KEYS.length, BEFORE_KEYS.length + 5)) {
      const route = AUTHORING_ROUTES[key];
      expect([key, [...route.roles].sort()]).toEqual([key, ['ADMIN', 'INSTRUCTOR']]);
      expect(route.path.startsWith(PHASE)).toBe(true);
      expect(route.mutates).toBe(route.method !== 'GET');
      expect(route.summary.length).toBeGreaterThan(20);
    }
  });
});

/* ------------------------------ the audit names ----------------------------- */

describe('the four authoring audit names and the union', () => {
  const BEFORE_EVENTS = [
    'project.create',
    'project.update',
    'project.tasks',
    'project.validate',
    'project.publish',
    'project.archive',
    'cohort.project',
    'project.draft',
    'project.quiz-key',
  ];

  it('appends four names after the nine that were there, and moves none', () => {
    expect(AUTHORING_AUDIT_EVENTS.slice(0, BEFORE_EVENTS.length)).toEqual(BEFORE_EVENTS);
    // Bounded to the entries this spec covers; later entries are appended
    // after them, and upload-contract.spec.ts pins the rest.
    expect(AUTHORING_AUDIT_EVENTS.slice(BEFORE_EVENTS.length, BEFORE_EVENTS.length + 4)).toEqual([
      'project.phase',
      'project.interview',
      'project.files',
      'project.interview-read',
    ]);
  });

  it('names every write of the five routes, and the interview read, with one of the four', () => {
    // Bounded to the entries this spec covers; later entries are appended
    // after them, and upload-contract.spec.ts pins the rest.
    const written = AUTHORING_ROUTE_KEYS.slice(BEFORE_KEYS.length, BEFORE_KEYS.length + 5)
      .map((key) => AUTHORING_ROUTES[key].audit)
      .filter((audit): audit is AuthoringAuditEvent => audit !== null);
    expect(new Set(written)).toEqual(new Set(['project.phase', 'project.interview', 'project.files']));
    expect(AUTHORING_AUDIT_EVENTS).toContain('project.interview-read');
  });

  it("puts every authoring name in the audit row's union, so no writer needs a cast", () => {
    // "Every authoring name is in the union exactly once" is read as
    // assignability: every authoring name is a member of
    // `AuditEventView['event']`. This line does not compile unless it is.
    const every: AuditEventView['event'][] = [...AUTHORING_AUDIT_EVENTS];
    // No name is listed twice (a pin on the length could not fail this way).
    expect(new Set(every).size).toBe(every.length);
    // Names outside the authoring list are members of the union too.
    const kept: AuditEventView['event'][] = ['task.reset', 'solution.read', 'project.quiz-key'];
    expect(kept).toHaveLength(3);
  });
});

/* --------------------------------- the caps --------------------------------- */

describe("the caps a teacher's scenario is written within", () => {
  it("the interview's caps are the loader's own", () => {
    expect(INTERVIEW_TOPIC_MAX).toBe(80);
    expect(INTERVIEW_ANSWER_MAX).toBe(1200);
    expect(INTERVIEW_MAX_FACTS).toBe(20);
    expect(INTERVIEW_MAX_TURNS_MIN).toBe(1);
    expect(INTERVIEW_MAX_TURNS_CAP).toBe(40);
    expect(INTERVIEW_FACT_ID_PATTERN.source).toBe('^[A-Za-z0-9_-]{1,16}$');
  });

  it('the fact id pattern accepts what the loader accepts and nothing more', () => {
    for (const id of ['F1', 'q', 'a_b-9', 'A'.repeat(16)]) expect([id, INTERVIEW_FACT_ID_PATTERN.test(id)]).toEqual([id, true]);
    for (const id of ['', 'A'.repeat(17), 'a b', 'é1', 'a.b', 'F1\n']) {
      expect([id, INTERVIEW_FACT_ID_PATTERN.test(id)]).toEqual([id, false]);
    }
  });

  it("the persona's name and role fit the fenced lines they are printed in", () => {
    expect(INTERVIEW_PERSONA_NAME_MAX).toBe(80);
    expect(INTERVIEW_PERSONA_ROLE_MAX).toBe(160);
  });

  it('the fields the loader does not cap carry the DTO caps', () => {
    expect(INTERVIEW_LINE_MAX).toBe(1000);
    expect(INTERVIEW_KEYWORDS_MAX).toBe(12);
    expect(INTERVIEW_KEYWORD_MAX).toBe(60);
    expect(REPLACE_FILE_CONTENT_MAX).toBe(200_000);
    expect(PHASE_INTRO_MAX).toBe(2000);
  });

  it("a criterion's wording is capped, and its weight is not a member of the body", () => {
    expect(CRITERION_TITLE_MAX).toBe(120);
    expect(CRITERION_DESCRIPTION_MAX).toBe(500);
    const reworded: CriterionWordingBody = { key: 'story_structure', title: 'Story shape', description: 'One sentence.' };
    // @ts-expect-error a weight is never accepted: the pack's weights are kept
    const weighted: CriterionWordingBody = { key: 'story_structure', title: 't', description: 'd', weight: 0.5 };
    const body: UpdateTaskBody = { criteria: [reworded] };
    // Nor any other member: a key, a title and a description, exactly.
    const exact: true = true satisfies HasExactlyKeys<CriterionWordingBody, 'key' | 'title' | 'description'>;
    expect(body.criteria).toEqual([reworded]);
    expect(weighted.key).toBe('story_structure');
    expect(exact).toBe(true);
  });

  it("a phase summary's intro is capped well below the detail's", () => {
    expect(PHASE_SUMMARY_INTRO_MAX).toBe(400);
    expect(PHASE_SUMMARY_INTRO_MAX).toBeLessThan(PHASE_INTRO_MAX);
  });
});

/* ------------------------------ the provenance ------------------------------ */

describe('provenance says reference, never the slug', () => {
  it('the three vocabularies, exactly', () => {
    expect([...ELEMENT_PROVENANCE_STATES]).toEqual(['reference', 'own', 'edited']);
    expect([...PHASE_PROVENANCE_ROLLUPS]).toEqual(['reference', 'mixed', 'own']);
    expect([...ROOM_TASK_PROVENANCES]).toEqual(['reference', 'other', 'none']);
  });

  it("no value of any of them is a project's name", () => {
    const every = [...ELEMENT_PROVENANCE_STATES, ...PHASE_PROVENANCE_ROLLUPS, ...ROOM_TASK_PROVENANCES];
    for (const value of every) expect(value).not.toMatch(/tasktrackr/i);
  });

  it("a phase's provenance carries the name a person reads, and the version's counts say referencePhases", () => {
    const requirements: PhaseProvenanceView = {
      phaseKey: 'requirements',
      referenceName: 'TaskTrackr',
      rollup: 'own',
      intro: 'own',
      interview: 'own',
      files: [{ path: 'requirements/draft.md', provenance: 'own' }],
      tasks: [{ taskKey: 'main', provenance: 'edited', titleEdited: true }],
      roomTask: 'other',
    };
    const implementation: PhaseProvenanceView = {
      phaseKey: 'implementation',
      referenceName: 'TaskTrackr',
      rollup: 'reference',
      intro: 'reference',
      interview: null,
      files: [],
      tasks: [{ taskKey: 'main', provenance: 'reference', titleEdited: false }],
      roomTask: 'none',
      application: 'TaskTrackr',
    };
    const version: VersionProvenanceView = { ownPhases: 1, mixedPhases: 0, referencePhases: 1, applicationFrom: 'TaskTrackr' };
    expect(requirements.application).toBeUndefined();
    expect(implementation.application).toBe('TaskTrackr');
    expect(Object.keys(version).sort()).toEqual(['applicationFrom', 'mixedPhases', 'ownPhases', 'referencePhases']);
    // Every member pinned, optional ones included: no digest, sealed byte or
    // slug-keyed count can be added to these views without failing here.
    const exact: true[] = [
      true satisfies HasExactlyKeys<
        PhaseProvenanceView,
        'phaseKey' | 'referenceName' | 'rollup' | 'intro' | 'interview' | 'files' | 'tasks' | 'roomTask' | 'application'
      >,
      true satisfies HasExactlyKeys<PhaseProvenanceView['files'][number], 'path' | 'provenance'>,
      true satisfies HasExactlyKeys<PhaseProvenanceView['tasks'][number], 'taskKey' | 'provenance' | 'titleEdited'>,
      true satisfies HasExactlyKeys<VersionProvenanceView, 'ownPhases' | 'mixedPhases' | 'referencePhases' | 'applicationFrom'>,
    ];
    expect(exact).toHaveLength(4);
    // @ts-expect-error an intro is the reference's or the teacher's; only a task is "edited"
    const introEdited: PhaseProvenanceView['intro'] = 'edited';
    // @ts-expect-error the slug is not a provenance value
    const slug: PhaseProvenanceRollup = 'tasktrackr';
    const room: RoomTaskProvenance = 'none';
    const element: ElementProvenance = 'edited';
    expect([introEdited, slug, room, element]).toHaveLength(4);
  });

  it('rides the draft phase, the assignable version, the active assignment and the learner views, all optional', () => {
    const optional: true[] = [
      true satisfies IsOptional<DraftPhaseView, 'provenance'>,
      true satisfies IsOptional<DraftPhaseView, 'interview'>,
      true satisfies IsOptional<AssignableVersionView, 'provenance'>,
      true satisfies IsOptional<CohortProjectAssignmentView, 'provenance'>,
      true satisfies IsOptional<PhaseSummary, 'scenario'>,
      true satisfies IsOptional<PhaseSummary, 'intro'>,
      true satisfies IsOptional<PhaseDetail, 'provenance'>,
      true satisfies IsOptional<PhaseDetail, 'stakeholder'>,
      true satisfies IsOptional<EnrollmentView, 'projectIsDefault'>,
    ];
    expect(optional).toHaveLength(9);
    // The detail keeps its own intro required and whole; only the summary's is optional and capped.
    const detailIntroRequired: false = false satisfies IsOptional<PhaseDetail, 'intro'>;
    expect(detailIntroRequired).toBe(false);
    const scenario: PhaseSummary['scenario'] = 'mixed';
    const stakeholder: PhaseDetail['stakeholder'] = { name: 'Priya Nair', role: 'Facilities manager' };
    const noStakeholder: PhaseDetail['stakeholder'] = null;
    const isDefault: EnrollmentView['projectIsDefault'] = false;
    expect([scenario, stakeholder, noStakeholder, isDefault]).toEqual([
      'mixed',
      { name: 'Priya Nair', role: 'Facilities manager' },
      null,
      false,
    ]);
  });
});

/* ------------------------- the interview, without answers ------------------------- */

describe('the draft carries the interview without its answers', () => {
  const brief: InterviewBody = {
    persona: { name: 'Priya Nair', role: 'Facilities manager' },
    opening: 'Thanks for coming. The rooms are a mess.',
    unknownReply: 'I would have to check.',
    refusal: 'That is yours to write.',
    maxTurns: 12,
    factsExpected: 2,
    facts: [
      { id: 'F1', topic: 'Who books a room', keywords: ['book', 'who'], answer: 'SEALED-ANSWER-ONE' },
      { id: 'F2', topic: 'How long a booking lasts', keywords: ['long'], answer: 'SEALED-ANSWER-TWO' },
    ],
  };

  it("the draft's view has topics and no answer: its members are exactly these, so none can hold one", () => {
    // Exact members, optional ones included: an answer, a
    // keyword, an unknownReply or a map of any of them, added anywhere on the
    // view, its persona or a fact, is a failed compile of this suite.
    const exact: true[] = [
      true satisfies HasExactlyKeys<DraftInterviewView, 'persona' | 'opening' | 'maxTurns' | 'factsExpected' | 'facts'>,
      true satisfies HasExactlyKeys<DraftInterviewView['persona'], 'name' | 'role'>,
      true satisfies HasExactlyKeys<DraftInterviewView['facts'][number], 'id' | 'topic'>,
    ];
    expect(exact).toHaveLength(3);
    const view: DraftInterviewView = {
      persona: brief.persona,
      opening: brief.opening,
      maxTurns: brief.maxTurns,
      factsExpected: brief.factsExpected,
      facts: brief.facts.map(({ id, topic }) => ({ id, topic })),
    };
    // @ts-expect-error the draft view has no place for an answer
    const leaked: DraftInterviewView['facts'][number] = { id: 'F1', topic: 'Who books a room', answer: 'x' };
    // @ts-expect-error nor for the keywords that select one
    const keyed: DraftInterviewView['facts'][number] = { id: 'F1', topic: 'Who books a room', keywords: ['book'] };
    // The bytes of a view built from a brief the way the resolver must build
    // it. This shows the shape leaves the answers behind; it runs no API code,
    // so the bytes the API sends are the API's serialised-response test.
    const bytes = JSON.stringify(view);
    expect(bytes).not.toContain('SEALED-ANSWER');
    expect(bytes).not.toContain('answer');
    expect(leaked.id).toBe(keyed.id);
  });

  it('the body a teacher writes is the whole brief, and the phase body is the intro alone', () => {
    const phase: UpdatePhaseBody = { intro: 'Book a meeting room without a spreadsheet.' };
    // @ts-expect-error a phase title stays fixed
    const titled: UpdatePhaseBody = { intro: 'x', title: 'Mine' };
    expect(Object.keys(brief).sort()).toEqual([
      'facts',
      'factsExpected',
      'maxTurns',
      'opening',
      'persona',
      'refusal',
      'unknownReply',
    ]);
    expect(Object.keys(phase)).toEqual(['intro']);
    expect(titled.intro).toBe('x');
    // The same, as types: the phase body is the intro alone, and the brief is
    // the loader's shape field for field.
    const exact: true[] = [
      true satisfies HasExactlyKeys<UpdatePhaseBody, 'intro'>,
      true satisfies HasExactlyKeys<
        InterviewBody,
        'persona' | 'opening' | 'unknownReply' | 'refusal' | 'maxTurns' | 'factsExpected' | 'facts'
      >,
      true satisfies HasExactlyKeys<InterviewBody['persona'], 'name' | 'role'>,
      true satisfies HasExactlyKeys<InterviewBody['facts'][number], 'id' | 'topic' | 'keywords' | 'answer'>,
    ];
    expect(exact).toHaveLength(4);
  });

  it('a file replace names a path and its bytes (or, for a design document, a reset), and answers what the other doors answer', () => {
    const body: ReplaceFileBody = { path: 'requirements/draft.md', content: '## US-1 — Book a room\n' };
    const reset: ReplaceFileBody = { path: 'design/design.json', reset: 'source' };
    // @ts-expect-error the only reset is to the version the draft was opened from
    const elsewhere: ReplaceFileBody = { path: 'design/design.json', reset: 'pack' };
    // @ts-expect-error a replace keeps the row's role; the body cannot name one
    const roled: ReplaceFileBody = { path: 'x.md', content: 'y', role: 'workspace' };
    const alias: PhaseMutationResult = {} as TaskMutationResult;
    const replaced: Pick<ReplaceFileResult, 'alsoReplacedIn'> = { alsoReplacedIn: ['design'] };
    const exact: true = true satisfies HasExactlyKeys<ReplaceFileBody, 'path' | 'content' | 'reset'>;
    expect(body.path).toBe('requirements/draft.md');
    expect([reset.reset, elsewhere.path]).toEqual(['source', 'design/design.json']);
    expect([roled.path, alias, replaced.alsoReplacedIn, exact]).toEqual(['x.md', {}, ['design'], true]);
  });
});

/* ------------------------------- the sentences ------------------------------ */

describe('the sentences the editor and the rooms render', () => {
  // Built inside each test rather than at collection, so a missing export is
  // that test's failure and not the whole file's.
  const all = (): string[] => [
    applicationPhasesSentence('TaskTrackr'),
    applicationFileRefusal('TaskTrackr'),
    withheldFileReplaceRefusal('tests/hidden/test_api.py'),
    fileNotMountedRefusal('design/notes.md', 'Requirements'),
    roomRecordRefusal('requirements/story.json', 'Write the story'),
    referenceFileBriefNote('docs/notes.md'),
  ];

  // The wording is fixed by this contract, word for word. Two choices are
  // deliberate: the application sentence joins its last clause with ", and"
  // rather than a semicolon, and the application refusal is a complete
  // sentence rather than one that trails off at an ellipsis.
  it('say, word for word, the wording this contract fixes', () => {
    expect(all()).toEqual([
      "Implementation, Testing, Deployment and Maintenance are TaskTrackr's application: its code, hidden tests, deployment and maintenance. Your own application arrives with project upload, and your own code tasks with teacher code tasks.",
      "Implementation, Testing, Deployment and Maintenance are TaskTrackr's application until project upload arrives, so their files cannot be replaced here.",
      '"tests/hidden/test_api.py" is withheld from this editor, so its bytes cannot be replaced here. Only a file a learner reads can be replaced.',
      'Requirements has no file at "design/notes.md". Replace a file this phase already mounts: its path and its role stay as they are.',
      '"requirements/story.json" is the record the room builds from a learner\'s work for "Write the story", so it cannot be replaced here.',
      'The reviewer reads "docs/notes.md" only when a task brief names it, so name this path in the brief of the task it serves.',
    ]);
  });

  it("take the application's name from the caller, never from a literal", () => {
    expect(applicationPhasesSentence('Acme')).not.toMatch(/tasktrackr/i);
    expect(applicationFileRefusal('Acme')).not.toMatch(/tasktrackr/i);
    expect(applicationPhasesSentence('Acme')).toContain("Acme's application");
  });

  it('open as sentences and use no middle dot or pipe (the web copy rules)', () => {
    for (const sentence of all()) {
      expect(sentence).toMatch(/^["A-Z]/);
      expect(sentence).not.toMatch(/[·|]/);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });
});

/* ---------------- the task reset, the quiz reveal, the default flag ---------------- */

describe("the learner's task reset", () => {
  it('the plan names what the confirm will say, and the refusal when there is one', () => {
    const plan: TaskResetPlanView = {
      restores: ['requirements/my-story-rooms.md'],
      reseeds: [],
      protectedBy: [{ path: 'docs/requirements/shared.md', siblingTitle: 'Glossary' }],
      dropsPendingProposal: true,
      refusal: null,
      retry: null,
    };
    const refused: TaskResetPlanView = { ...plan, refusal: 'A run is still going. Reset once it finishes.' };
    expect(plan.protectedBy[0].siblingTitle).toBe('Glossary');
    expect(refused.refusal).toMatch(/^A run is still going/);
  });

  it('a plan on a passed task is a retry, and says what it keeps', () => {
    const retry: TaskResetPlanView = {
      restores: ['requirements/story.json'],
      reseeds: [],
      protectedBy: [],
      dropsPendingProposal: false,
      refusal: null,
      retry: { wholePhase: true, keeps: 'This phase counts as passed again once a new submission passes the same review.' },
    };
    expect(retry.retry?.wholePhase).toBe(true);
    expect(retry.retry?.keeps).toMatch(/passes the same review\.$/);
  });

  it('the input is one key, and the result is the new version, the workspace and the task', () => {
    const input: ResetTaskInput = { baseVersion: null };
    // @ts-expect-error the DTO is whitelisted to one key
    const extra: ResetTaskInput = { baseVersion: '2026-09-29T00:00:00.000Z', files: {} };
    const result: Pick<TaskResetResult, 'version' | 'workspace'> = {
      version: '2026-09-29T00:00:01.000Z',
      workspace: { 'requirements/my-story-rooms.md': '# Story\n' },
    };
    const task: TaskResetResult['task']['key'] = 'rooms';
    // One key, and no optional second one either.
    const exact: true = true satisfies HasExactlyKeys<ResetTaskInput, 'baseVersion'>;
    expect([input.baseVersion, extra.baseVersion, Object.keys(result.workspace), task, exact]).toEqual([
      null,
      '2026-09-29T00:00:00.000Z',
      ['requirements/my-story-rooms.md'],
      'rooms',
      true,
    ]);
  });

  it('a class export carries the epoch, optional, and the file version does not move', () => {
    expect(COHORT_EXPORT_VERSION).toBe(3);
    const optional: true = true satisfies IsOptional<CohortExportSubmission, 'resetEpoch'>;
    const epoch: CohortExportSubmission['resetEpoch'] = null;
    const counted: CohortExportSubmission['resetEpoch'] = 2;
    expect([optional, epoch, counted]).toEqual([true, null, 2]);
  });
});

describe('the practice-quiz reveal, the default flag and the credited pass', () => {
  it('the reveal is one of two words, optional on the compiled checks and on both authoring shapes', () => {
    expect([...QUIZ_REVEAL_EXPLANATIONS]).toEqual(['on-pass', 'always']);
    const optional: true[] = [
      true satisfies IsOptional<QuizChecks, 'revealExplanation'>,
      true satisfies IsOptional<AuthoredQuiz, 'revealExplanation'>,
      true satisfies IsOptional<AuthoredQuizView, 'revealExplanation'>,
    ];
    const always: QuizRevealExplanation = 'always';
    const onPass: QuizChecks['revealExplanation'] = 'on-pass';
    // @ts-expect-error there is no third mode
    const never: QuizRevealExplanation = 'never';
    expect([optional.length, always, onPass, never]).toEqual([3, 'always', 'on-pass', 'never']);
  });

  it("the quiz room's credited pass is present and true, or absent", () => {
    const optional: true = true satisfies IsOptional<QuizRoomView, 'passCredited'>;
    const credited: QuizRoomView['passCredited'] = true;
    // @ts-expect-error absent is how "not credited" is said; false is not a value
    const notCredited: QuizRoomView['passCredited'] = false;
    expect([optional, credited, notCredited]).toEqual([true, true, false]);
  });
});
