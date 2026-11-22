import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { API_CONTRACT_JSON, DESIGN_JSON, EMPTY_API_CONTRACT, EMPTY_DESIGN, INHERITED_TASK_KEY, serialiseDesign, serialiseStory, type Story } from '@learnsdlc/shared';
import { config } from '../src/config';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { SCREEN_COPY_PATH } from '../src/content/screen-copy';
import { EnrollmentEntity, PhaseStateEntity, UserEntity } from '../src/db/entities';
import { AI_GOLDEN_BASE_URL, AI_GOLDEN_EFFORT, AI_GOLDEN_MODEL } from './ai-request-golden';
import { referenceTermsIn } from './reference-terms';
import { ROOM_API_WORK, ROOM_DESIGN, ROOM_DESIGN_EDIT, ROOM_DESIGN_WORK, tasktrackrPhase } from './tasktrackr-phase';
import {
  REFERENCE_WORDS,
  ROOMDESK_DESIGN_INTRO,
  ROOMDESK_INTERVIEW,
  ROOMDESK_REQUIREMENTS_INTRO,
  ROOMDESK_STORY,
  ROOMDESK_TITLE,
} from './reference-scenario-roomdesk';
import { bearer, HttpTarget, waitForSubmission } from './support/http';
import { bootApi } from './support/app';

/**
 * The mounted journey for the copy that becomes the teacher's own.
 *
 * Real `AppModule`, real `OpenAiProvider`; only the network is replaced, by a
 * recorder that answers each request from its own schema (the
 * `authored-reviewer.e2e-spec.ts` setup). A teacher copies the reference
 * project as RoomDesk and rewrites every written element of Requirements and
 * Design through the authoring doors; a learner then works it. Requirements is
 * a story phase (TaskTrackr 3.0.0): its written elements are the intro, the
 * interview and the story task's brief, provided stories and floor; the
 * backlog document is Design's.
 *
 * **Asserted against the resolver, not an edit list**: in every
 * learner payload of phases 1–2, no element provenance marks `own` carries a
 * reference word, and every reference word found lies in an element it marks
 * `reference`. Here the teacher rewrote both phases whole, so both roll up to
 * `own` and the payloads carry none at all.
 *
 * Design opens by **one declared repository write** (the named test shortcut),
 * then passes on a canned review of the teacher's own decision record, and the
 * advance mounts the pack's baseline screen copy (no task owns the screen
 * contract, so there is no copy to carry and nothing to refuse).
 */

interface RecordedBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string; json_schema?: { name: string; schema: any } };
}

const RECORD = 'requirements/story.json';

/**
 * TaskTrackr's one Design task made the teacher's in place (a Design phase
 * holds one design task since 4.0.0), with the screen contract switched off:
 * no task owns the screen copy, so Implementation mounts the baseline.
 */
const OWN_DESIGN = { ...ROOM_DESIGN_EDIT, design: { ...ROOM_DESIGN_EDIT.design, contracts: { api: true, screens: false } } };

const NAME = 'TaskTrackr';

/** The teacher's own story brief, on the inherited story task. */
const STORY_BRIEF =
  'Write the missing story, US-4, for Priya Nair, the facilities manager: a member of staff books a slot that is already taken. ' +
  'Give at least two Given / When / Then acceptance criteria, one for the taken slot, and say what the story leaves out.';
const STORY_OBJECTIVES = [
  'Write US-4, booking a taken slot, in the As a / I want / so that form',
  'Give at least two testable Given / When / Then criteria, one for a slot that is already taken',
];

/** A story record that clears the teacher's floor (a happy path, a taken slot, one exclusion). */
const ROOM_RECORD: Story = {
  id: 'US-4',
  title: 'Book when the slot is taken',
  persona: 'member of staff',
  capability: 'be offered the next free slot when mine is taken',
  benefit: 'my meeting still has a room',
  notes: 'Shown on the booking form, not a separate page.',
  scopeExclusions: ['recurring bookings'],
  criteria: [
    { id: 'AC-1', given: 'the slot is free', when: 'I book it', then: 'the booking is mine', tag: 'happy' },
    { id: 'AC-2', given: 'the slot is taken', when: 'I book it', then: 'I am told it is taken and offered the next free slot', tag: 'error' },
  ],
} as Story;

describe("the copy becomes the teacher's own, mounted", () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;
  const bodies: RecordedBody[] = [];
  const refused: string[] = [];
  const realFetch = globalThis.fetch;

  const stamp = Date.now();
  const SLUG = `room-desk-${stamp}`;
  const PASSWORD = 'Correct-Horse-9';

  let teacherToken = '';
  let learnerToken = '';
  let controlToken = '';
  let projectId = '';
  let versionId = '';
  let publishedId = '';
  let cohortId = '';
  const ids: Record<string, string> = {};
  const control: Record<string, string> = {};

  const held = {
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModel: config.openaiModel,
    openaiReasoningEffort: config.openaiReasoningEffort,
  };

  /** The reference interview's ten answers and one of the teacher's, checked as substrings. */
  const referenceAnswers = tasktrackrPhase('requirements').interview!.facts.map((fact) => fact.answer);
  const authoredAnswer = ROOMDESK_INTERVIEW.facts[0].answer;

  /* ------------------------------- the recorder ------------------------------ */

  const answer = (body: RecordedBody): string => {
    const system = body.messages[0]?.content ?? '';
    const schema = body.response_format?.json_schema;
    if (schema?.name === 'learning_rubric_review') {
      type Variant = { properties: { key: { enum: string[] }; met: { enum: boolean[] }; evidence: { pattern?: string } } };
      const variants = (schema.schema.properties.criteriaEvidence.items.anyOf ?? []) as Variant[];
      const keys = [...new Set(variants.map((variant) => variant.properties.key.enum[0]))];
      // A canned pass for the teacher's own decision record, and a revision for
      // everything else. A met criterion must cite what its schema allows: the
      // first literal of its citation pattern, unescaped.
      const citation = (key: string): string | null => {
        const met = variants.find((variant) => variant.properties.key.enum[0] === key && variant.properties.met.enum[0] === true);
        const pattern = met?.properties.evidence.pattern;
        return pattern ? pattern.split('|')[0].replace(/\\(.)/g, '$1') : null;
      };
      const pass = system.includes(ROOM_DESIGN.brief) && keys.every((key) => citation(key) !== null);
      return JSON.stringify({
        verdict: pass ? 'pass' : 'needs_revision',
        summary: 'Recorded review.',
        strengths: pass ? ['Recorded strength.'] : [],
        improvements: pass ? [] : ['Recorded improvement.'],
        processNote: 'Recorded.',
        criteriaEvidence: keys.map((key) =>
          pass
            ? { key, met: true, evidence: `${citation(key)} states it.`, issue: '', nextStep: '' }
            : { key, met: false, evidence: 'Recorded evidence.', issue: 'Recorded issue.', nextStep: 'Recorded next step.' }),
      });
    }
    if (schema?.name?.startsWith('stakeholder_output_review')) {
      const evidenceIds = schema.schema.properties.checks.items.properties.candidateEvidenceIds.items.enum as string[];
      const factIds = Object.keys(schema.schema.properties.facts.properties);
      return JSON.stringify({
        checks: ['grounded', 'relevant', 'no_artifact'].map((key) => ({ key, met: true, reason: 'Recorded.', candidateEvidenceIds: [evidenceIds[0]] })),
        facts: Object.fromEntries(factIds.map((id) => [id, { status: 'unaddressed', reason: 'Recorded.', candidateEvidenceIds: [evidenceIds[0]] }])),
      });
    }
    if (system.startsWith('You review a proposed Guided mentor reply')) {
      const data = body.messages[1].content.split('\n').slice(1, -1).join('\n');
      const evidence = (JSON.parse(data).candidateEvidence as Array<{ id: string }>).map((unit) => unit.id);
      return JSON.stringify({
        revealedDecisions: [],
        remainingReasoning: { description: 'The learner still chooses.', substantive: true, candidateEvidenceIds: [evidence[evidence.length - 1]] },
        checks: ['limited_step', 'grounded', 'learner_reasoning'].map((key) => ({ key, met: true, candidateEvidenceIds: [evidence[0]], reason: 'Recorded.' })),
      });
    }
    return 'Bookings come in fixed slots of 30 or 60 minutes.';
  };

  const recorder = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url);
    if (url !== `${config.openaiBaseUrl}/chat/completions`) {
      refused.push(url);
      throw new Error(`the BX recorder refuses ${url}`);
    }
    const body = JSON.parse(String(init?.body)) as RecordedBody;
    bodies.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer(body) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  const systemOf = (body: RecordedBody) => body.messages[0].content;
  const outsideFence = (text: string) => text.replace(/<<<TEACHER_BRIEF[\s\S]*?TEACHER_BRIEF>>>/g, '');

  /* --------------------------------- helpers -------------------------------- */

  const account = async (name: string, role: 'LEARNER' | 'INSTRUCTOR' = 'LEARNER') => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: `${name}-${stamp}@b0-own.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    if (role !== 'LEARNER') {
      await db.manager.update(UserEntity, { id }, { role });
      app.get(AuthService).forgetSession(id);
    }
    return registered.body.token as string;
  };

  const teacher = (path: string) => `/api/v1/instructor/projects${path}`;
  const draft = (path = '') => teacher(`/${projectId}/versions/${versionId}${path}`);

  /** Every reference word in a serialised payload, for the leak checks. */
  const referenceWords = (payload: unknown): string[] => {
    const text = JSON.stringify(payload);
    return [...new Set((text.match(new RegExp(REFERENCE_WORDS.source, 'gi')) ?? []).map((one) => one.toLowerCase()))];
  };

  /** Where in a payload each reference word sits, as JSON paths, so a failure names the element. */
  const referencePaths = (payload: unknown, at = '$'): string[] => {
    if (typeof payload === 'string') return REFERENCE_WORDS.test(payload) ? [at] : [];
    if (Array.isArray(payload)) return payload.flatMap((one, index) => referencePaths(one, `${at}[${index}]`));
    if (payload && typeof payload === 'object') {
      return Object.entries(payload as Record<string, unknown>).flatMap(([key, one]) => [
        ...(REFERENCE_WORDS.test(key) ? [`${at}.<key ${key}>`] : []),
        ...referencePaths(one, `${at}.${key}`),
      ]);
    }
    return [];
  };

  /** The sealed answers, never in any payload but `interview.read`'s. */
  const expectNoAnswer = (label: string, payload: unknown) => {
    const text = JSON.stringify(payload);
    for (const one of [...referenceAnswers, authoredAnswer]) expect([label, text.includes(one)]).toEqual([label, false]);
  };

  const submitTask = async (token: string, phaseStateId: string, taskKey: string): Promise<any> => {
    const submitted = await request(http)
      .post(`/api/v1/phases/${phaseStateId}/tasks/${encodeURIComponent(taskKey)}/submit`)
      .set(bearer(token))
      .expect(201);
    return waitForSubmission(http, bearer(token), submitted.body.id, { attempts: 100, intervalMs: 150, message: `the ${taskKey} submission did not finish` });
  };

  const detailOf = async (token: string, phaseStateId: string) =>
    (await request(http).get(`/api/v1/phases/${phaseStateId}`).set(bearer(token)).expect(200)).body;

  /* ---------------------------------- setup --------------------------------- */

  beforeAll(async () => {
    config.openaiBaseUrl = AI_GOLDEN_BASE_URL;
    config.openaiModel = AI_GOLDEN_MODEL;
    config.openaiReasoningEffort = AI_GOLDEN_EFFORT;
    jest.spyOn(OpenAiProvider.prototype, 'available', 'get').mockReturnValue(true);
    globalThis.fetch = recorder as unknown as typeof fetch;
    ({ app, http } = await bootApi());
    db = app.get(DataSource);
    teacherToken = await account('teacher', 'INSTRUCTOR');
  }, 120000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    config.openaiBaseUrl = held.openaiBaseUrl;
    config.openaiModel = held.openaiModel;
    config.openaiReasoningEffort = held.openaiReasoningEffort;
    jest.restoreAllMocks();
    await app?.close();
  });

  /* --------------------------------- teacher -------------------------------- */

  it('copies the reference project and marks every written element the reference\'s', async () => {
    const library = await request(http).get('/api/v1/instructor/projects').set(bearer(teacherToken)).expect(200);
    const platform = library.body.library.find((one: any) => one.isDefault);
    const created = await request(http).post(teacher('')).set(bearer(teacherToken))
      .send({ title: ROOMDESK_TITLE, slug: SLUG, fromVersionId: platform.publishedVersionId }).expect(201);
    projectId = created.body.project.id;
    versionId = created.body.draftVersionId;
    const read = await request(http).get(draft()).set(bearer(teacherToken)).expect(200);
    for (const phase of read.body.phases) {
      expect([phase.key, phase.provenance?.rollup, phase.provenance?.referenceName]).toEqual([phase.key, 'reference', NAME]);
    }
    expectNoAnswer('readDraft (copied)', read.body);
  }, 60000);

  it('rewrites every written element of Requirements through the doors, each leaving one audit row', async () => {
    const intro = await request(http).patch(draft('/phases/requirements')).set(bearer(teacherToken))
      .send({ intro: ROOMDESK_REQUIREMENTS_INTRO }).expect(200);
    expect(intro.body.phase.provenance.intro).toBe('own');

    const interview = await request(http).put(draft('/phases/requirements/interview')).set(bearer(teacherToken))
      .send(ROOMDESK_INTERVIEW).expect(200);
    expect(interview.body.phase.provenance.interview).toBe('own');
    expectNoAnswer('interview.replace result', interview.body);

    // Requirements mounts its record alone, and since TaskTrackr 4.0.0 Design
    // mounts no backlog document: the provided stories live in the story block.

    // The inherited story, kept (its record stays US-4): title, brief naming
    // the stakeholder, objectives, its own provided stories and floor, and the
    // wording of every criterion it keeps.
    const updated = await request(http).patch(draft(`/phases/requirements/tasks/${INHERITED_TASK_KEY}`)).set(bearer(teacherToken))
      .send({ title: 'Book a taken slot', brief: STORY_BRIEF, objectives: STORY_OBJECTIVES, story: ROOMDESK_STORY }).expect(200);
    const criteria = (updated.body.phase.tasks.find((one: any) => one.taskKey === INHERITED_TASK_KEY).rubric.criteria as Array<{ key: string }>);
    await request(http).patch(draft(`/phases/requirements/tasks/${INHERITED_TASK_KEY}`)).set(bearer(teacherToken))
      .send({ criteria: criteria.map((one) => ({ key: one.key, title: `The ${one.key.replace(/_/g, ' ')}`, description: 'Judged against what Priya Nair asked for.' })) })
      .expect(200);

    const phase = (await request(http).get(draft()).set(bearer(teacherToken)).expect(200)).body.phases.find((one: any) => one.key === 'requirements');
    expect(phase.provenance).toMatchObject({ rollup: 'own', intro: 'own', interview: 'own', roomTask: 'other' });
    expect(phase.provenance.files).toEqual([]);
    expect(phase.provenance.tasks).toEqual([{ taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: true }]);
    const story = phase.tasks.find((one: any) => one.taskKey === INHERITED_TASK_KEY).story;
    expect(story.providedStories.map((one: any) => one.id)).toEqual(['US-1', 'US-2', 'US-3']);
    expect(story.learnerStory.id).toBe('US-4');
  }, 60000);

  it('rewrites Design: its Background, its one design task and its starting records, the teacher\'s own', async () => {
    // Since TaskTrackr 4.0.0 the architecture is Design's Background, and its one design task is made the teacher's in place.
    await request(http).patch(draft('/phases/design')).set(bearer(teacherToken)).send({ intro: ROOMDESK_DESIGN_INTRO }).expect(200);
    await request(http).patch(draft(`/phases/design/tasks/${INHERITED_TASK_KEY}`)).set(bearer(teacherToken)).send(OWN_DESIGN).expect(200);
    await request(http).put(draft('/phases/design/files')).set(bearer(teacherToken))
      .send({ path: DESIGN_JSON, content: serialiseDesign(EMPTY_DESIGN) }).expect(200);
    await request(http).put(draft('/phases/design/files')).set(bearer(teacherToken))
      .send({ path: API_CONTRACT_JSON, content: EMPTY_API_CONTRACT }).expect(200);
    const phase = (await request(http).get(draft()).set(bearer(teacherToken)).expect(200)).body.phases.find((one: any) => one.key === 'design');
    expect(phase.provenance.rollup).toBe('own');
    expect(phase.provenance.tasks).toEqual([{ taskKey: INHERITED_TASK_KEY, provenance: 'edited', titleEdited: false }]);
  }, 60000);

  it('validates to the scenario rows, publishable with no task owning the screen contract', async () => {
    const validated = await request(http).post(draft('/validate')).set(bearer(teacherToken)).expect(200);
    const report = validated.body.validation ?? validated.body;
    const status = (id: string) => report.checks.filter((one: any) => one.id === id).map((one: any) => one.status);
    expect(status('interview-well-formed')).toEqual(['passed']);
    expect(status('interview-sealed-row-matches')).toEqual(['passed']);
    // only Design mounts the backlog now, so no twin of it is held to one document
    expect(status('provided-backlog-one-document')).toEqual([]);
    expect(status('application-is-the-reference')).toEqual(['passed']);
    expect(status('screen-contract-has-an-owner')).toEqual(['passed']);
    expect(report.publishable).toBe(true);
    expectNoAnswer('validate', validated.body);
  }, 60000);

  it('reads the interview whole for its owner alone, audited', async () => {
    const read = await request(http).get(draft('/phases/requirements/interview')).set(bearer(teacherToken)).expect(200);
    expect(read.body).toEqual(ROOMDESK_INTERVIEW);
    const other = await account('another-teacher', 'INSTRUCTOR');
    await request(http).get(draft('/phases/requirements/interview')).set(bearer(other)).expect(404);
  }, 60000);

  it('leaves exactly one audit row per door and read, named from the four new events, on the teacher\'s audit route', async () => {
    const audit = await request(http).get('/api/v1/instructor/audit').set(bearer(teacherToken)).query({ limit: 100 }).expect(200);
    const events = (audit.body as Array<{ event: string }>).map((one) => one.event);
    const count = (event: string) => events.filter((one) => one === event).length;
    expect(count('project.phase')).toBe(2);
    expect(count('project.interview')).toBe(1);
    expect(count('project.files')).toBe(2);
    expect(count('project.interview-read')).toBe(1);
    expectNoAnswer('audit', audit.body);
    // Path, byte length and fact count at most: never bytes or digests.
    const text = JSON.stringify(audit.body);
    expect(text).not.toContain(ROOM_API_WORK);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  }, 60000);

  it('publishes 1.0.0 and gives it to a class, whose card says both written phases are the teacher\'s', async () => {
    const tasks = await request(http).get(draft('/phases/requirements/tasks')).set(bearer(teacherToken)).expect(200);
    expectNoAnswer('listTasks', tasks.body);
    const files = await request(http).get(draft('/files')).set(bearer(teacherToken)).expect(200);
    expectNoAnswer('files.list', files.body);

    const published = await request(http).post(draft('/publish')).set(bearer(teacherToken)).send({ version: '1.0.0' }).expect(200);
    expectNoAnswer('publish', published.body);
    publishedId = published.body.versionId;
    const cohort = await request(http).post('/api/v1/instructor/cohorts').set(bearer(teacherToken)).send({ name: SLUG }).expect(201);
    cohortId = cohort.body.id;
    const assignable = await request(http).get(`/api/v1/instructor/cohorts/${cohortId}/project/assignable`).set(bearer(teacherToken)).expect(200);
    const card = assignable.body.find((one: any) => one.versionId === publishedId);
    expect(card.provenance).toEqual({ ownPhases: 2, mixedPhases: 0, referencePhases: 0, applicationFrom: NAME });
    expectNoAnswer('assignable', assignable.body);
    const assigned = await request(http).put(`/api/v1/instructor/cohorts/${cohortId}/project`).set(bearer(teacherToken))
      .send({ projectVersionId: publishedId, reason: 'BX mounted journey.' }).expect(200);
    expect(assigned.body.active.provenance).toEqual(card.provenance);

    learnerToken = await account('learner');
    await request(http).post('/api/v1/enrollments/join').set(bearer(learnerToken)).send({ code: cohort.body.joinCode }).expect(200);
    const enrolled = await request(http).post('/api/v1/enrollments').set(bearer(learnerToken)).send({}).expect(201);
    for (const one of enrolled.body.phases) ids[one.key] = one.id;
    // The summary: whose each phase is, and the intro's opening.
    const summary = Object.fromEntries(enrolled.body.phases.map((one: any) => [one.key, one]));
    expect(summary.requirements.scenario).toBe('own');
    expect(summary.requirements.intro).toBe(ROOMDESK_REQUIREMENTS_INTRO);
    expect(summary.design.scenario).toBe('own');
    expect(summary.implementation.scenario).toBe('reference');
    for (const one of enrolled.body.phases) expect((one.intro ?? '').length).toBeLessThanOrEqual(400);

    controlToken = await account('control');
    const platform = await request(http).post('/api/v1/enrollments').set(bearer(controlToken)).send({}).expect(201);
    for (const one of platform.body.phases) control[one.key] = one.id;
    expect(platform.body.phases.find((one: any) => one.key === 'requirements').scenario).toBe('reference');
  }, 120000);

  /**
   * The resolver check on one learner payload: the phase rolls up to `own`, so no
   * element of it is the reference's and the payload carries no reference
   * word. The reference project's name is the one reference word a payload
   * carries on purpose (the registry's display name the provenance view says
   * the application phases come from) so those two fields are skipped.
   */
  const expectOwnPayload = (key: string, detail: any) => {
    expect([key, detail.provenance.rollup]).toEqual([key, 'own']);
    const hits = referencePaths(detail).filter((path) => !/\.(referenceName|application)$/.test(path));
    expect([key, hits]).toEqual([key, []]);
    expectNoAnswer(`PhaseDetail ${key}`, detail);
  };

  it("serves the learner the teacher's words in Requirements, and no reference word in any element marked own", async () => {
    expectOwnPayload('requirements', await detailOf(learnerToken, ids.requirements));
    const requirements = await detailOf(learnerToken, ids.requirements);
    expect(requirements.intro).toBe(ROOMDESK_REQUIREMENTS_INTRO);
    expect(requirements.stakeholder).toEqual({ name: 'Priya Nair', role: 'Facilities manager' });
    expect(requirements.objectives).toEqual(STORY_OBJECTIVES);
    expect(requirements.files.map((file: any) => file.path)).toEqual([RECORD]);
    expect(requirements.story.providedStories).toEqual(ROOMDESK_STORY.providedStories);
    const interview = await request(http).get(`/api/v1/phases/${ids.requirements}/interview`).set(bearer(learnerToken)).expect(200);
    expect(interview.body.persona).toEqual(ROOMDESK_INTERVIEW.persona);
    expectNoAnswer('interview state', interview.body);
  }, 60000);

  it('answers one interview question on the authored arm: fenced, no reference term outside the fence', async () => {
    const before = bodies.length;
    await request(http).post(`/api/v1/phases/${ids.requirements}/interview/ask`).set(bearer(learnerToken))
      .send({ question: 'How long can a booking be?' }).expect(200);
    const turn = bodies.slice(before);
    expect(turn.length).toBeGreaterThanOrEqual(2);
    const review = turn.find((body) => body.response_format?.json_schema?.name?.startsWith('stakeholder_output_review'))!;
    expect(review.response_format!.json_schema!.name).toBe('stakeholder_output_review_v6_authored');
    for (const body of turn) {
      expect(systemOf(body)).toContain('<<<TEACHER_BRIEF');
      expect(referenceTermsIn(outsideFence(systemOf(body)))).toEqual([]);
    }
    expect(systemOf(turn[0]).split('\n')[0]).toContain('You are Priya Nair, Facilities manager');
  }, 60000);

  it("grades the kept story with the teacher's floor, on the record alone", async () => {
    await request(http).put(`/api/v1/phases/${ids.requirements}/workspace`).set(bearer(learnerToken))
      .send({ files: { [RECORD]: serialiseStory(ROOM_RECORD) } })
      .expect(200);
    const before = bodies.length;
    const verdict = await submitTask(learnerToken, ids.requirements, INHERITED_TASK_KEY);
    expect(verdict.status).toBe('completed');
    const graded = bodies.slice(before).filter((body) => body.response_format?.json_schema?.name === 'learning_rubric_review');
    expect(graded).toHaveLength(1);
    expect(systemOf(graded[0])).toContain("strict evidence reviewer for one task of a teacher's project");
    // The interview was rewritten (Priya Nair), so the grading request
    // about the kept story names no reference term the task did not supply
    // itself: not outside the fence, and not anywhere in the messages. The
    // record's path (the record rule calls it story.json) and the learner's
    // own record are the task's, and are allowed.
    const own = [RECORD, 'story.json'];
    const allowed = `${STORY_BRIEF} ${serialiseStory(ROOM_RECORD)}`;
    expect(referenceTermsIn(outsideFence(systemOf(graded[0])), STORY_BRIEF, own)).toEqual([]);
    expect(referenceTermsIn(graded[0].messages.map((message) => message.content).join('\n'), allowed, own)).toEqual([]);
    expect(systemOf(graded[0])).not.toMatch(/Dana|Osei/);
    // The floor, the teacher's: every line of it passes, and no record-consistency check exists any more.
    const checks = verdict.report.checks as Array<{ id: string; status: string }>;
    expect(checks.map((one) => [one.id, one.status])).toEqual([
      ['story.record', 'passed'],
      ['story.sentence', 'passed'],
      ['story.criteria.min', 'passed'],
      ['story.criteria.tags', 'passed'],
      ['story.scope.min', 'passed'],
    ]);
    expect(referenceWords(verdict.report.checks)).toEqual([]);
  }, 60000);

  it('reaches Design by the declared shortcut, passes it, and advances onto the baseline screen copy', async () => {
    const states = db.getRepository(PhaseStateEntity);
    const requirements = await states.findOneByOrFail({ id: ids.requirements });
    const design = await states.findOneByOrFail({ id: ids.design });
    expect(design.status).toBe('locked');
    // The named test shortcut: one declared write per row opens Design.
    await states.update({ id: requirements.id }, { status: 'passed', passedAt: new Date().toISOString() });
    await states.update({ id: design.id }, { status: 'in_progress', unlockedAt: new Date().toISOString() });
    await db.getRepository(EnrollmentEntity).update({ id: design.enrollmentId }, { currentPhaseOrder: design.phaseOrder });

    const detail = await detailOf(learnerToken, ids.design);
    expectOwnPayload('design', detail);
    expect(detail.intro).toBe(ROOMDESK_DESIGN_INTRO);
    expect(detail.stakeholder).toBeNull();
    // the teacher's records, empty, and no screen contract: it is switched off
    expect(detail.files.map((file: any) => file.path).sort()).toEqual([API_CONTRACT_JSON, DESIGN_JSON].sort());
    await request(http).put(`/api/v1/phases/${ids.design}/workspace`).set(bearer(learnerToken))
      .send({ files: { [DESIGN_JSON]: serialiseDesign(ROOM_DESIGN_WORK), [API_CONTRACT_JSON]: ROOM_API_WORK } })
      .expect(200);
    const verdict = await submitTask(learnerToken, ids.design, INHERITED_TASK_KEY);
    expect(verdict.status).toBe('completed');
    expect([verdict.report.passed, verdict.report.checks.filter((one: any) => one.status !== 'passed' && one.status !== 'info'), verdict.report.aiReview?.verdict]).toEqual([true, expect.anything(), 'pass']);

    await request(http).post(`/api/v1/phases/${ids.design}/advance`).set(bearer(learnerToken)).expect(201);
    const implementation = await detailOf(learnerToken, ids.implementation);
    expect(implementation.acceptedScreenCopy).toBeNull();
    expect(JSON.parse(implementation.files.find((file: any) => file.path === SCREEN_COPY_PATH).content)).toMatchObject({ source: 'reference' });
    // The application is still the reference's, read on the pinned base.
    expect(implementation.provenance).toMatchObject({ application: NAME, rollup: 'reference' });
  }, 120000);

  it("keeps a pinned learner on 1.0.0's interview when the teacher publishes 1.1.0", async () => {
    const opened = await request(http).post(teacher(`/${projectId}/versions`)).set(bearer(teacherToken))
      .send({ fromVersionId: publishedId }).expect(201);
    const next = opened.body.versionId as string;
    await request(http).put(teacher(`/${projectId}/versions/${next}/phases/requirements/interview`)).set(bearer(teacherToken))
      .send({ ...ROOMDESK_INTERVIEW, persona: { name: 'Sam Ortiz', role: 'Office manager' } }).expect(200);
    await request(http).post(teacher(`/${projectId}/versions/${next}/publish`)).set(bearer(teacherToken)).send({ version: '1.1.0' }).expect(200);
    const interview = await request(http).get(`/api/v1/phases/${ids.requirements}/interview`).set(bearer(learnerToken)).expect(200);
    expect(interview.body.persona).toEqual(ROOMDESK_INTERVIEW.persona);
    expect((await detailOf(learnerToken, ids.requirements)).stakeholder).toEqual({ name: 'Priya Nair', role: 'Facilities manager' });
  }, 60000);

  it("keeps the reference learner on the reference: every phase the reference's, and the interview on today's arm", async () => {
    const detail = await detailOf(controlToken, control.requirements);
    expect(detail.provenance).toMatchObject({ rollup: 'reference', interview: 'reference', roomTask: 'reference' });
    expect(detail.stakeholder?.name).toBe(tasktrackrPhase('requirements').interview!.persona.name);
    const before = bodies.length;
    await request(http).post(`/api/v1/phases/${control.requirements}/interview/ask`).set(bearer(controlToken))
      .send({ question: 'What should the report show?' }).expect(200);
    const turn = bodies.slice(before);
    const review = turn.find((body) => body.response_format?.json_schema?.name?.startsWith('stakeholder_output_review'))!;
    expect(review.response_format!.json_schema!.name).toBe('stakeholder_output_review_v6');
    for (const body of turn) expect(systemOf(body)).not.toContain('<<<TEACHER_BRIEF');
  }, 60000);

  it("exports the teacher's own interview and design records, and never a reference answer", async () => {
    const exported = await request(http).get('/api/v1/account/export').set(bearer(teacherToken)).expect(200);
    const mine = (exported.body.authoredProjects as any[]).find((one) => one.slug === SLUG);
    const first = mine.versions.find((one: any) => one.version === '1.0.0');
    const requirements = first.phases.find((one: any) => one.key === 'requirements');
    expect(requirements.interview).toEqual(ROOMDESK_INTERVIEW);
    const design = first.phases.find((one: any) => one.key === 'design');
    expect(design.files).toEqual(expect.arrayContaining([{ path: API_CONTRACT_JSON, content: EMPTY_API_CONTRACT }]));
    const text = JSON.stringify(exported.body.authoredProjects);
    for (const one of referenceAnswers) expect(text.includes(one)).toBe(false);
  }, 60000);

  it('sent no request anywhere but the model endpoint', () => {
    expect(refused).toEqual([]);
  });
});
