import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { UserEntity } from '../src/db/entities';
import { HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The bell end to end.
 *
 * Two properties matter more than the rest and both are about who may say
 * what to whom: an instructor may write to a learner in their own class and
 * nobody else's, and a learner may read and clear their own rows and nobody
 * else's. The refusal is a 404 in both directions, so guessing an id tells the
 * caller nothing about whether it exists.
 *
 * Everything runs against the real container and an in-memory database, which
 * is what a laptop and CI both are.
 */
describe('The bell: notifications and the instructor note (integration)', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let dataSource: DataSource;

  let learnerToken = '';
  let learnerId = '';
  let secondLearnerToken = '';
  let instructorToken = '';
  let strangerToken = '';
  let phaseIds: Record<string, string> = {};

  const asLearner = () => ({ authorization: `Bearer ${learnerToken}` });
  const asSecondLearner = () => ({ authorization: `Bearer ${secondLearnerToken}` });
  const asInstructor = () => ({ authorization: `Bearer ${instructorToken}` });
  const asStranger = () => ({ authorization: `Bearer ${strangerToken}` });

  /** Registers an account and promotes it; role is not a registration field. */
  const staff = async (email: string, displayName: string): Promise<string> => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password1!', displayName })
      .expect(201);
    await dataSource.getRepository(UserEntity).update({ email }, { role: 'INSTRUCTOR' });
    return registered.body.token;
  };

  const note = (text: string, phaseStateId?: string) =>
    request(http)
      .post(`/api/v1/instructor/learners/${learnerId}/note`)
      .set(asInstructor())
      .send(phaseStateId ? { text, phaseStateId } : { text });

  const bell = () => request(http).get('/api/v1/notifications').set(asLearner());

  beforeAll(async () => {
    ({ app, http } = await bootApi({ pipeline: 'prefix' }));
    dataSource = app.get(DataSource);

    instructorToken = await staff('bell-ana@learnsdlc.test', 'Ana Tan');
    strangerToken = await staff('bell-bo@learnsdlc.test', 'Bo Lim');

    const monday = await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(asInstructor())
      .send({ name: 'Monday class' })
      .expect(201);

    // Bo has a class of their own, so their empty scope is a scope rather than
    // an instructor who has simply never made one.
    await request(http)
      .post('/api/v1/instructor/cohorts')
      .set(asStranger())
      .send({ name: 'Friday class' })
      .expect(201);

    const learner = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'bell-amir@learnsdlc.test', password: 'Password1!', displayName: 'Amir Rahman' })
      .expect(201);
    learnerToken = learner.body.token;
    learnerId = learner.body.user.id;

    const second = await request(http)
      .post('/api/v1/auth/register')
      .send({ email: 'bell-wei@learnsdlc.test', password: 'Password1!', displayName: 'Wei Ling' })
      .expect(201);
    secondLearnerToken = second.body.token;

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
    phaseIds = Object.fromEntries(enrolled.body.phases.map((p: any) => [p.key, p.id]));
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  it('starts empty for a learner who has just arrived', async () => {
    const res = await request(http).get('/api/v1/notifications').set(asSecondLearner()).expect(200);
    expect(res.body).toEqual({ items: [], unread: 0 });
  });

  it('carries an instructor note to the learner, signed with the instructor s name', async () => {
    await note('Read the boundary rule again before you resubmit.', phaseIds.requirements).expect(200);

    const res = await bell().expect(200);
    expect(res.body.unread).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      kind: 'instructor.note',
      audience: 'learner',
      title: 'A note from Ana Tan',
      detail: 'Read the boundary rule again before you resubmit.',
      href: `/workspace/${phaseIds.requirements}/`.slice(0, -1),
      phaseKey: 'requirements',
      actorName: 'Ana Tan',
      readAt: null,
    });
  });

  it('refuses an instructor whose class the learner is not in, with a 404', async () => {
    await request(http)
      .post(`/api/v1/instructor/learners/${learnerId}/note`)
      .set(asStranger())
      .send({ text: 'You should be in my class instead.' })
      .expect(404);

    // Nothing was written: the list still holds only the first note.
    const res = await bell().expect(200);
    expect(res.body.unread).toBe(1);
  });

  it('leaves an audit row naming the actor, the subject and what was said', async () => {
    const res = await request(http)
      .get('/api/v1/instructor/audit')
      .set(asInstructor())
      .expect(200);

    const row = res.body.find((event: any) => event.event === 'instructor.note');
    expect(row).toBeTruthy();
    expect(row.actorName).toBe('Ana Tan');
    expect(row.subjectUserId).toBe(learnerId);
    expect(row.detail.text).toBe('Read the boundary rule again before you resubmit.');
  });

  it('marks one row read, and marking it again is not an error', async () => {
    const before = await bell().expect(200);
    const id = before.body.items[0].id;

    const read = await request(http)
      .post(`/api/v1/notifications/${id}/read`)
      .set(asLearner())
      .expect(200);
    expect(read.body).toEqual({ unread: 0 });

    const after = await bell().expect(200);
    expect(after.body.items).toHaveLength(0);

    await request(http)
      .post(`/api/v1/notifications/${id}/read`)
      .set(asLearner())
      .expect(200)
      .expect({ unread: 0 });
  });

  it('answers 404 when the row belongs to somebody else', async () => {
    await note('A second note, for the row this test needs.').expect(200);
    const mine = (await bell().expect(200)).body.items[0].id;

    await request(http)
      .post(`/api/v1/notifications/${mine}/read`)
      .set(asSecondLearner())
      .expect(404);

    // Still unread for the learner it belongs to.
    expect((await bell().expect(200)).body.unread).toBe(1);
  });

  it('empties the whole block on read-all, and a second call is a no-op', async () => {
    await note('One.').expect(200);
    await note('Two.').expect(200);
    expect((await bell().expect(200)).body.unread).toBe(3);

    await request(http)
      .post('/api/v1/notifications/read-all')
      .set(asLearner())
      .expect(200)
      .expect({ unread: 0 });
    await request(http)
      .post('/api/v1/notifications/read-all')
      .set(asLearner())
      .expect(200)
      .expect({ unread: 0 });

    expect((await bell().expect(200)).body.items).toHaveLength(0);
  });

  it('lists newest first, honours a limit, and refuses a silly one', async () => {
    await note('First.').expect(200);
    await note('Second.').expect(200);
    await note('Third.').expect(200);

    const all = await bell().expect(200);
    expect(all.body.unread).toBe(3);
    const times = all.body.items.map((row: any) => Date.parse(row.createdAt));
    expect([...times].sort((a: number, b: number) => b - a)).toEqual(times);

    const one = await request(http)
      .get('/api/v1/notifications?limit=1')
      .set(asLearner())
      .expect(200);
    expect(one.body.items).toHaveLength(1);
    // The badge is the true count, never the length of the page.
    expect(one.body.unread).toBe(3);

    await request(http).get('/api/v1/notifications?limit=999').set(asLearner()).expect(400);
  });

  it('refuses a learner writing a note at all', async () => {
    await request(http)
      .post(`/api/v1/instructor/learners/${learnerId}/note`)
      .set(asSecondLearner())
      .send({ text: 'Not mine to send.' })
      .expect(403);
  });
});
