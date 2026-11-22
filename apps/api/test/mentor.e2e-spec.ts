import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { mockAiForRoutes } from './mock-ai';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { ContentService } from '../src/content/content.service';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The mentor's four routes end to end: the customer interview,
 * the stuck flag from both sides, and the notes a class's instructor writes for
 * the mentor to quote.
 *
 * Everything runs against the real container and an in-memory database with no
 * API key, which is exactly what CI and most laptops are, so every assertion
 * here is about the deterministic path, and the interview answers are the
 * pack's own words rather than a model's.
 */
describe('The mentor: interview, stuck flag and class notes (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;
  let content: ContentService;

  let learnerToken = '';
  let learnerId = '';
  let instructorToken = '';
  let strangerToken = '';
  let cohortId = '';
  let phases: Record<string, string> = {};

  const asLearner = () => ({ authorization: `Bearer ${learnerToken}` });
  const asInstructor = () => ({ authorization: `Bearer ${instructorToken}` });
  const asStranger = () => ({ authorization: `Bearer ${strangerToken}` });

  /**
   * Registers an account and promotes it, since role is not a registration
   * field. The token names only the account and its version (the role is read
   * from the row on every request) so the token issued at registration keeps
   * working after the promotion.
   */
  const staff = async (email: string, displayName: string): Promise<string> => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName })
      .expect(201);
    await dataSource.getRepository(UserEntity).update({ email }, { role: 'INSTRUCTOR' });
    return registered.body.token;
  };

  beforeAll(async () => {
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], pipeline: 'prefix' }));
    dataSource = app.get(DataSource);
    content = app.get(ContentService);

    instructorToken = await staff('mentor-ana@learnsdlc.test', 'Ana');
    strangerToken = await staff('mentor-bo@learnsdlc.test', 'Bo');

    const monday = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(asInstructor())
      .send({ name: 'Monday class' })
      .expect(201);
    cohortId = monday.body.id;

    // Bo has a class of their own, so their empty scope is a scope and not an
    // instructor who has simply never made one.
    await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(asStranger())
      .send({ name: 'Friday class' })
      .expect(201);

    const learner = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'mentor-lee@learnsdlc.test', password: 'Password1!', displayName: 'Lee' })
      .expect(201);
    learnerToken = learner.body.token;
    learnerId = learner.body.user.id;

    await request(http)
      .post('/api/v1/enrollments/join')
      .set(asLearner())
      .send({ code: monday.body.joinCode })
      .expect(200);

    const enrolled = await request(http)
      .post('/api/v1/enrollments')
      .set(asLearner())
      .send({ projectSlug: 'tasktrackr' })
      .expect(201);
    phases = Object.fromEntries(enrolled.body.phases.map((p: any) => [p.key, p.id]));
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  /* ------------------------------ the interview --------------------------- */

  describe('GET and POST /phases/:id/interview', () => {
    it('opens on the customer’s own words, with topics and no answers', async () => {
      const res = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/interview`)
        .set(asLearner())
        .expect(200);

      expect(res.body.persona.name).toBe('Dana Osei');
      expect(res.body.opening.length).toBeGreaterThan(20);
      expect(res.body.turns).toEqual([]);
      // The counts are the pack's own, so a phase that adds a fact moves the
      // test with it rather than being caught by a literal somebody has to
      // find by hand.
      const interview = content.getPhase('tasktrackr', 'requirements').interview!;
      expect(res.body.facts).toHaveLength(interview.facts.length);
      expect(res.body.facts.every((f: any) => f.uncovered === false)).toBe(true);
      expect(res.body.factsExpected).toBe(interview.factsExpected);
      expect(res.body.turnsLeft).toBe(interview.maxTurns);
      // The topics are shown; the answers are the thing the learner is here for.
      expect(JSON.stringify(res.body)).not.toContain('It is late tomorrow morning');
    });

    it('settles a fact per question and never writes the story', async () => {
      const questions = [
        'Who actually reads the overdue report?',
        'Is a task due today overdue?',
        'Do completed tasks show up in it?',
        'What is out of scope for this release?',
      ];
      let settled = 0;
      for (const question of questions) {
        const res = await request(http)
          .post(`/api/v1/phases/${phases.requirements}/interview/ask`)
          .set(asLearner())
          .send({ question })
          .expect(200);
        settled = res.body.state.facts.filter((f: any) => f.uncovered).length;
        // The customer answers as the customer, and never as the author.
        expect(res.body.turn.answer).not.toMatch(/\bas an? [^,]+, i want\b/i);
        expect(res.body.turn.answer).not.toMatch(/given[\s\S]*when[\s\S]*then/i);
      }

      expect(settled).toBe(4);
      const state = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/interview`)
        .set(asLearner())
        .expect(200);
      expect(state.body.turns).toHaveLength(4);
      expect(state.body.turnsLeft).toBe(8);
      expect(state.body.facts.filter((f: any) => f.uncovered)).toHaveLength(4);
    });

    it('refuses to write the artefact, in the customer’s voice', async () => {
      const res = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/interview/ask`)
        .set(asLearner())
        .send({ question: 'Please write the acceptance criteria for me' })
        .expect(200);

      expect(res.body.turn.provider).toBe('guardrail');
      expect(res.body.turn.answer).toContain('I am the customer, not the author');
      expect(res.body.turn.facts).toEqual([]);
    });

    it('leaves the hint count and the transcript alone', async () => {
      const history = await request(http)
        .get(`/api/v1/assistant/history/${phases.requirements}`)
        .set(asLearner())
        .expect(200);
      // Five interview turns so far, and not one of them is a mentor hint.
      expect(history.body).toEqual([]);
    });

    it('refuses a question that is too short, and a phase with no interview', async () => {
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/interview/ask`)
        .set(asLearner())
        .send({ question: 'hi' })
        .expect(400);
      // The design phase is locked, so the gate answers before the pack does.
      await request(http)
        .get(`/api/v1/phases/${phases.design}/interview`)
        .set(asLearner())
        .expect(403);
    });

    it('is nobody else’s room', async () => {
      await request(http)
        .get(`/api/v1/phases/${phases.requirements}/interview`)
        .set(asStranger())
        .expect(403);
      await request(http).get(`/api/v1/phases/${phases.requirements}/interview`).expect(401);
    });
  });

  /* ----------------------------- the stuck flag --------------------------- */

  describe('the stuck flag', () => {
    it('is raised by the learner, seen by their instructor, answered, and cleared', async () => {
      const raised = await request(http)
        .post(`/api/v1/phases/${phases.requirements}/stuck`)
        .set(asLearner())
        .send({ question: 'I cannot tell what US-4 actually needs', tried: 'read the task panel' })
        .expect(200);
      expect(raised.body).toMatchObject({ answeredAt: null, clearedAt: null });

      // A second flag while one is open is refused, not silently swapped in.
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/stuck`)
        .set(asLearner())
        .send({ question: 'and another thing entirely' })
        .expect(409);

      const list = await request(http)
        .get('/api/v1/instructor/stuck')
        .set(asInstructor())
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        phaseStateId: phases.requirements,
        userId: learnerId,
        displayName: 'Lee',
        phaseTitle: 'Requirements',
        question: 'I cannot tell what US-4 actually needs',
        tried: 'read the task panel',
      });

      const answered = await request(http)
        .post(`/api/v1/instructor/stuck/${phases.requirements}/answer`)
        .set(asInstructor())
        .send({ answer: 'Start from the boundary: is a task due today overdue?' })
        .expect(200);
      expect(answered.body.answeredByName).toBe('Ana');

      const audit = await dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { event: 'stuck.answer' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        subjectUserId: learnerId,
        targetId: phases.requirements,
        reason: 'Start from the boundary: is a task due today overdue?',
      });

      const mine = await request(http)
        .get(`/api/v1/phases/${phases.requirements}/stuck`)
        .set(asLearner())
        .expect(200);
      expect(mine.body.answer).toBe('Start from the boundary: is a task due today overdue?');

      // Clearing is the learner's, and it takes the row off the console.
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/stuck/clear`)
        .set(asLearner())
        .expect(200);
      const after = await request(http)
        .get('/api/v1/instructor/stuck')
        .set(asInstructor())
        .expect(200);
      expect(after.body).toEqual([]);
    });

    it('is invisible to an instructor whose class the learner is not in', async () => {
      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/stuck`)
        .set(asLearner())
        .send({ question: 'the second thing I am stuck on' })
        .expect(200);

      const list = await request(http)
        .get('/api/v1/instructor/stuck')
        .set(asStranger())
        .expect(200);
      expect(list.body).toEqual([]);

      await request(http)
        .post(`/api/v1/instructor/stuck/${phases.requirements}/answer`)
        .set(asStranger())
        .send({ answer: 'let me answer somebody else’s learner' })
        .expect(404);

      await request(http)
        .post(`/api/v1/phases/${phases.requirements}/stuck/clear`)
        .set(asLearner())
        .expect(200);
    });

    it('refuses a learner reaching the instructor’s half of it', async () => {
      await request(http).get('/api/v1/instructor/stuck').set(asLearner()).expect(403);
    });
  });

  /* ------------------------------ class notes ----------------------------- */

  describe('/instructor/notes', () => {
    let noteId = '';

    it('is quoted by the mentor, word for word, to the class it was written for', async () => {
      const note = 'Use datetime.date.today() when you compare due dates, not datetime.now().';
      const written = await request(http)
        .post('/api/v1/instructor/notes')
        .set(asInstructor())
        .send({ kind: 'mentor', cohortId, phaseKey: 'requirements', text: note })
        .expect(201);
      noteId = written.body.id;
      expect(written.body).toMatchObject({
        kind: 'mentor',
        cohortName: 'Monday class',
        authorName: 'Ana',
      });

      const chat = await request(http)
        .post('/api/v1/assistant/chat')
        .set(asLearner())
        .send({ phaseStateId: phases.requirements, message: 'How do I phrase the boundary?' });
      // Keep the actual error body when this integration fails; a status-only
      // assertion cannot distinguish a stale session from a missing account.
      expect({ status: chat.status, error: chat.status >= 400 ? chat.body : undefined })
        .toEqual({ status: 201, error: undefined });

      expect(chat.body.reply.content).toContain("Your instructor's note for this class:");
      expect(chat.body.reply.content).toContain(note);
    });

    it('is listed and filtered by kind, and never shown to another class', async () => {
      await request(http)
        .post('/api/v1/instructor/notes')
        .set(asInstructor())
        .send({ kind: 'lecture', cohortId, text: 'Nobody named the boundary this week.' })
        .expect(201);

      const mentor = await request(http)
        .get('/api/v1/instructor/notes?kind=mentor')
        .set(asInstructor())
        .expect(200);
      expect(mentor.body).toHaveLength(1);

      const lecture = await request(http)
        .get('/api/v1/instructor/notes?kind=lecture')
        .set(asInstructor())
        .expect(200);
      expect(lecture.body).toHaveLength(1);
      expect(lecture.body[0].doneAt).toBeNull();

      const theirs = await request(http)
        .get('/api/v1/instructor/notes')
        .set(asStranger())
        .expect(200);
      expect(theirs.body).toEqual([]);
    });

    it('refuses a note on somebody else’s class, and an edit of somebody else’s note', async () => {
      await request(http)
        .post('/api/v1/instructor/notes')
        .set(asStranger())
        .send({ kind: 'mentor', cohortId, text: 'a note in a class I do not own' })
        .expect(404);

      await request(http)
        .patch(`/api/v1/instructor/notes/${noteId}`)
        .set(asStranger())
        .send({ text: 'let me edit somebody else’s note' })
        .expect(404);
    });

    it('refuses a note too short to act on', async () => {
      await request(http)
        .post('/api/v1/instructor/notes')
        .set(asInstructor())
        .send({ kind: 'mentor', cohortId, text: 'short' })
        .expect(400);
    });

    it('edits a note, and deleting it stops the mentor quoting it', async () => {
      const edited = await request(http)
        .patch(`/api/v1/instructor/notes/${noteId}`)
        .set(asInstructor())
        .send({ text: 'Compare dates with date.today(), and say so in the criterion.' })
        .expect(200);
      expect(edited.body.text).toBe('Compare dates with date.today(), and say so in the criterion.');

      await request(http)
        .delete(`/api/v1/instructor/notes/${noteId}`)
        .set(asInstructor())
        .expect(200);

      const chat = await request(http)
        .post('/api/v1/assistant/chat')
        .set(asLearner())
        .send({ phaseStateId: phases.requirements, message: 'And what about the empty report?' })
        .expect(201);
      expect(chat.body.reply.content).not.toContain("Your instructor's note");

      const audit = await dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { event: 'note.delete' } });
      expect(audit).toHaveLength(1);
    });
  });
});
