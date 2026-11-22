import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { INHERITED_TASK_KEY, UPLOAD_REFUSALS, plainTextOf } from '@learnsdlc/shared';
import { OpenAiProvider } from '../src/assistant/openai.provider';
import { AuthService } from '../src/auth/auth.service';
import { EXPORT_AUDIT_EVENT, EXPORT_REFUSALS } from '../src/authoring/export.service';
import { UPLOAD_PATH } from '../src/authoring/upload.service';
import { canonicalJson } from '../src/content/blob.store';
import { checksOf, type CompiledSnapshot } from '../src/content/pack-compiler';
import {
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../src/content/project.entities';
import { readZip, zipLimits, type ArchiveEntry } from '../src/content/zip-reader';
import { config } from '../src/config';
import { AuditEventEntity, UserEntity } from '../src/db/entities';
import { mockAiForRoutes } from './mock-ai';
import { entriesOf as packEntriesOf, writeZip, zipDirectory } from './fixtures/upload-packs/archive';
import { SHELF_DIR } from './fixtures/upload-packs/markers';
import { storeTaskTypeEdit } from './stored-task-edit';
import { bearer, HttpTarget } from './support/http';
import { bootApi } from './support/app';

/**
 * The authoring format's per-phase `task` block,
 * end to end over the real AppModule.
 *
 * One listening loopback server (an ephemeral port, closed in afterAll), the
 * real pipeline (`configureApp`), and every archive through the real doors:
 *
 * (1) the Shelf pack uploaded, its implementation task renamed and its brief edited
 *     through the task door, exported, and the archive uploaded again: the
 *     re-upload compiles to the identical task list (keys, titles, briefs,
 *     objectives, checks), with no 409 (the export writes the title in
 *     phase.json's `task` block, and the importer applies it);
 * (2) the `shelf-task` sibling uploads and its block is applied, and its own
 *     export carries the block back;
 * (3) a malformed block is 400 NOT_A_PACK with a detail naming the phase
 *     folder, and writes no row (row counts before and after);
 * (4) an edit the folder layout cannot carry (what the task hands in) is
 *     still a 409: the read-back's `taskDrift` sentence, naming the phase.
 *
 * No model call (the provider is the routes' mock), no sandbox run, no port
 * but the one ephemeral loopback listener.
 */
const SHELF_TASK_DIR = path.join(path.dirname(SHELF_DIR), 'shelf-task');

/** supertest's body as the raw bytes, whatever the content type. */
const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

const archiveEntriesOf = (archive: Buffer): ArchiveEntry[] => readZip(archive, zipLimits(config.importMaxBytes));

/** The shelf-task sibling as an archive, its phase.json edited in memory (the fixture is never written). */
function shelfTaskArchive(edit: (phase: any) => void): Buffer {
  return writeZip(
    packEntriesOf(SHELF_TASK_DIR).map((entry) => {
      if (entry.name !== 'phases/01-requirements/phase.json') return entry;
      const phase = JSON.parse(entry.data.toString('utf-8'));
      edit(phase);
      return { name: entry.name, data: Buffer.from(`${JSON.stringify(phase, null, 2)}\n`) };
    }),
  );
}

describe('the phase.json task block, export → upload over the real AppModule', () => {
  let app: INestApplication;
  let http: HttpTarget;
  let db: DataSource;

  const stamp = Date.now();
  const PASSWORD = 'Correct-Horse-9';
  let address = 0;
  /** Each request from its own address, so per-address gates measure the route, not this file. */
  const from = () => ({ 'x-forwarded-for': `10.91.${Math.floor(address / 250)}.${(address++ % 250) + 1}` });

  let accounts = 0;

  /** A fresh teacher: the upload door allows five a minute per teacher, so each case uploads as its own. */
  const account = async (name: string) => {
    const registered = await request(http)
      .post('/api/v1/auth/register')
      .set(from())
      .send({ email: `${name}-${(accounts += 1)}-${stamp}@task-block.test`, password: PASSWORD, displayName: name })
      .expect(201);
    const id = registered.body.user.id as string;
    await db.manager.update(UserEntity, { id }, { role: 'INSTRUCTOR' });
    app.get(AuthService).forgetSession(id);
    return { id, token: registered.body.token as string };
  };

  const upload = (token: string, archive: Buffer, title: string) =>
    request(http).post(UPLOAD_PATH).set(bearer(token)).set(from()).send({ title, archiveBase64: archive.toString('base64') });

  /** An upload that must be accepted, by its ids. */
  const uploaded = async (token: string, archive: Buffer, title: string) => {
    const answer = await upload(token, archive, title);
    expect({ status: answer.status, code: answer.body?.code, detail: answer.body?.detail ?? null }).toEqual({ status: 201, code: undefined, detail: null });
    return { projectId: answer.body.projectId as string, versionId: answer.body.versionId as string, slug: answer.body.slug as string };
  };

  const versionBase = (projectId: string, versionId: string) => `/api/v1/instructor/projects/${projectId}/versions/${versionId}`;

  const editTask = async (token: string, projectId: string, versionId: string, phaseKey: string, body: Record<string, unknown>) => {
    const answer = await request(http)
      .patch(`${versionBase(projectId, versionId)}/phases/${phaseKey}/tasks/${INHERITED_TASK_KEY}`)
      .set(bearer(token))
      .set(from())
      .send(body);
    expect({ status: answer.status, message: answer.status === 200 ? null : answer.body?.message }).toEqual({ status: 200, message: null });
  };

  /** The export door, its bytes raw. */
  const exportOf = (token: string, projectId: string, versionId: string) =>
    request(http).get(`${versionBase(projectId, versionId)}/export`).set(bearer(token)).set(from()).buffer(true).parse(binary as never);

  const messageOf = (body: Buffer): string | null => {
    try {
      return (JSON.parse(body.toString('utf-8')) as { message?: string }).message ?? null;
    } catch {
      return null;
    }
  };

  const snapshotOf = async (versionId: string): Promise<CompiledSnapshot> =>
    (await db.manager.findOneByOrFail(ProjectVersionEntity, { id: versionId })).compiled as CompiledSnapshot;

  /**
   * The task list as a learner is graded on it: every phase's compiled tasks
   * whole (the sole key as a pack says it), and the checks each is graded by.
   */
  const taskListOf = (snapshot: CompiledSnapshot): unknown =>
    JSON.parse(
      canonicalJson(
        snapshot.phases.map((phase) => {
          const content = snapshot.content.phases.find((one) => one.key === phase.key)!;
          return {
            key: phase.key,
            tasks: phase.tasks.map((task) => ({
              ...task,
              taskKey: task.taskKey === INHERITED_TASK_KEY ? '' : task.taskKey,
              gradedBy: checksOf(content, task),
            })),
          };
        }),
      ),
    );

  const taskOf = (snapshot: CompiledSnapshot, phaseKey: string) => snapshot.phases.find((phase) => phase.key === phaseKey)!.tasks[0];

  /** The phase.json of a phase in an exported archive, parsed. */
  const exportedPhaseJson = (archive: Buffer, folder: string): Record<string, unknown> => {
    const entry = archiveEntriesOf(archive).find((one) => one.name.endsWith(`/${folder}/phase.json`));
    expect(entry).toBeDefined();
    return JSON.parse(entry!.bytes.toString('utf-8'));
  };

  const rowCounts = async (): Promise<Record<string, number>> => {
    const entities = { ProjectEntity, ProjectVersionEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectFileEntity } as const;
    const out: Record<string, number> = {};
    for (const [name, entity] of Object.entries(entities)) out[name] = await db.getRepository(entity).count();
    out.uploadedAudits = await db.getRepository(AuditEventEntity).count({ where: { event: 'project.uploaded' } });
    out.exportedAudits = await db.getRepository(AuditEventEntity).count({ where: { event: EXPORT_AUDIT_EVENT } });
    return out;
  };

  beforeAll(async () => {
    // Test-only: read the client address from X-Forwarded-For (see `from`).
    // One listening server on loopback, an ephemeral port, closed by app.close.
    ({ app, http } = await bootApi({ overrides: [[OpenAiProvider, mockAiForRoutes]], trustProxy: true, listen: true }));
    db = app.get(DataSource);
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  /* ---------------- (1) rename + brief → export → re-upload: the same task list ---------------- */

  it('(1) the Shelf pack with its implementation task renamed and its brief edited exports (no 409) and re-uploads to the identical task list', async () => {
    const owner = await account('task-block-rename');
    const shelf = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Task block shelf ${stamp}`);
    const title = 'Build the shelf API and page, FMT-TITLE-7RB';
    const brief = '## Build the shelf\n\nImplement the marked gaps in the API and the page, then run the visible tests. FMT-BRIEF-2KD';
    await editTask(owner.token, shelf.projectId, shelf.versionId, 'implementation', { title, brief });
    const held = await snapshotOf(shelf.versionId);
    // the editor's door stores the brief plain (docs/authoring-format.md, "Plain text"): the heading's # goes, every word stays
    expect({ title: taskOf(held, 'implementation').title, brief: taskOf(held, 'implementation').brief }).toEqual({ title, brief: plainTextOf(brief) });

    const out = await exportOf(owner.token, shelf.projectId, shelf.versionId);
    expect({ status: out.status, message: out.status === 200 ? null : messageOf(out.body as Buffer) }).toEqual({ status: 200, message: null });
    const archive = out.body as Buffer;
    // the rename rides the phase's task block; the brief is the phase's taskPanel, as the editor's compile puts it
    expect(exportedPhaseJson(archive, 'phases/03-implementation').task).toEqual({ title });
    for (const folder of ['phases/01-requirements', 'phases/02-design', 'phases/04-testing', 'phases/05-deployment', 'phases/06-maintenance']) {
      expect({ folder, task: exportedPhaseJson(archive, folder).task }).toEqual({ folder, task: undefined });
    }

    const again = await uploaded(owner.token, archive, `Task block shelf again ${stamp}`);
    const back = await snapshotOf(again.versionId);
    expect(taskListOf(back)).toEqual(taskListOf(held));
    expect({ title: taskOf(back, 'implementation').title, brief: taskOf(back, 'implementation').brief }).toEqual({ title, brief: plainTextOf(brief) });
    // and the re-upload exports to the same archive bytes (the project's slug and title aside: both are minted per upload)
    const twice = await exportOf(owner.token, again.projectId, again.versionId);
    expect(twice.status).toBe(200);
    const said = (one: Buffer) =>
      archiveEntriesOf(one).map((entry) => {
        const name = entry.name.slice(entry.name.indexOf('/'));
        if (name !== '/project.json') return [name, entry.bytes.toString('base64')];
        const { slug: _slug, title: _title, ...rest } = JSON.parse(entry.bytes.toString('utf-8'));
        return [name, canonicalJson(rest)];
      });
    expect(said(twice.body as Buffer)).toEqual(said(archive));
  }, 120000);

  /* ------------------- (2) the shelf-task sibling: its block is applied ------------------- */

  it('(2) the shelf-task sibling uploads and its block is applied: the task has the title, brief and objectives the block gives', async () => {
    const block = JSON.parse(
      packEntriesOf(SHELF_TASK_DIR).find((entry) => entry.name === 'phases/01-requirements/phase.json')!.data.toString('utf-8'),
    ).task as { key: string; title: string; brief: string; objectives: string[] };
    expect(Object.keys(block).sort()).toEqual(['brief', 'key', 'objectives', 'title']);

    const owner = await account('task-block-sibling');
    const made = await uploaded(owner.token, zipDirectory(SHELF_TASK_DIR), `Task block sibling ${stamp}`);
    const held = await snapshotOf(made.versionId);
    const phase = held.content.phases.find((one) => one.key === 'requirements')!;
    const task = taskOf(held, 'requirements');
    expect({ key: task.taskKey, title: task.title, brief: task.brief, objectives: task.objectives }).toEqual({
      key: INHERITED_TASK_KEY,
      title: block.title,
      // the block's brief is applied through the editor's overlay, so it is stored plain (docs/authoring-format.md, "Plain text")
      brief: plainTextOf(block.brief),
      objectives: block.objectives,
    });
    // the phase keeps its own title; the learner's brief and objectives are the task's (the editor's compile)
    expect({ title: phase.title, taskPanel: phase.taskPanel, objectives: phase.objectives }).toEqual({
      title: 'Requirements',
      taskPanel: plainTextOf(block.brief),
      objectives: block.objectives,
    });
    const row = await db.manager.findOneByOrFail(ProjectTaskEntity, {
      projectPhaseId: (await db.manager.findOneByOrFail(ProjectPhaseEntity, { projectVersionId: made.versionId, key: 'requirements' })).id,
    });
    expect({ title: row.title, brief: row.brief, objectives: row.objectives }).toEqual({ title: block.title, brief: plainTextOf(block.brief), objectives: block.objectives });

    // its own export carries the block back, and the re-upload is the same task list
    const out = await exportOf(owner.token, made.projectId, made.versionId);
    expect({ status: out.status, message: out.status === 200 ? null : messageOf(out.body as Buffer) }).toEqual({ status: 200, message: null });
    expect(exportedPhaseJson(out.body as Buffer, 'phases/01-requirements').task).toEqual({ title: block.title });
    const again = await uploaded(owner.token, out.body as Buffer, `Task block sibling again ${stamp}`);
    expect(taskListOf(await snapshotOf(again.versionId))).toEqual(taskListOf(held));
  }, 120000);

  /* --------------------- (3) a malformed block: 400 NOT_A_PACK, no row --------------------- */

  it('(3) a malformed task block is 400 NOT_A_PACK with a detail naming the phase folder, and writes no row', async () => {
    const cases: { name: string; edit: (phase: any) => void; reason: RegExp }[] = [
      // the block holds signOff too
      { name: 'an unknown member', edit: (phase) => (phase.task.criteria = []), reason: /a task block holds only key, title, brief, objectives and signOff/ },
      { name: 'a title that is not text', edit: (phase) => (phase.task.title = 7), reason: /its title must be text/ },
      { name: 'a title over the editor cap', edit: (phase) => (phase.task.title = 'T'.repeat(161)), reason: /A title is at most 160 characters/ },
      { name: 'an empty brief', edit: (phase) => (phase.task.brief = '   '), reason: /brief cannot be empty/ },
      { name: 'objectives that are not a list of text', edit: (phase) => (phase.task.objectives = 'one'), reason: /its objectives must be a list of text/ },
      { name: 'a key that renames', edit: (phase) => (phase.task.key = 'story'), reason: /its key names no task of this phase/ },
      { name: 'a block that is not an object', edit: (phase) => (phase.task = ['title']), reason: /it must be an object/ },
    ];
    for (const one of cases) {
      const teacher = await account('task-block-malformed');
      const before = await rowCounts();
      const answer = await upload(teacher.token, shelfTaskArchive(one.edit), `Task block malformed ${stamp}`);
      expect({
        name: one.name,
        status: answer.status,
        code: answer.body?.code,
        message: answer.body?.message,
        folder: String(answer.body?.detail ?? '').startsWith("phases/01-requirements's phase.json task block: "),
        reason: one.reason.test(String(answer.body?.detail ?? '')),
        detailMax: String(answer.body?.detail ?? '').length <= 400,
      }).toEqual({
        name: one.name,
        status: 400,
        code: 'NOT_A_PACK',
        message: UPLOAD_REFUSALS.NOT_A_PACK,
        folder: true,
        reason: true,
        detailMax: true,
      });
      expect({ name: one.name, counts: await rowCounts() }).toEqual({ name: one.name, counts: before });
    }
  }, 120000);

  /* ------------- (4) an edit the layout cannot carry is still a 409, by sentence ------------- */

  it("(4) an edit the layout cannot carry (what the task hands in) is still a 409, the read-back's taskDrift naming the phase, with no audit row", async () => {
    const owner = await account('task-block-refused');
    const made = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Task block refused ${stamp}`);
    // the title the block carries (through the task door), and what the task hands in, which it cannot (the
    // stored edit an older editor could leave: no editor save moves a story task's type any more)
    await editTask(owner.token, made.projectId, made.versionId, 'requirements', { title: 'FMT retitled requirements task' });
    await storeTaskTypeEdit(db, made.versionId, 'requirements', 'document');
    const held = await snapshotOf(made.versionId);
    expect(taskOf(held, 'requirements').artefactType).toBe('document');
    const phaseTitle = held.content.phases.find((phase) => phase.key === 'requirements')!.title;

    const before = await rowCounts();
    const out = await exportOf(owner.token, made.projectId, made.versionId);
    expect(out.status).toBe(409);
    expect(out.headers['content-type']).toMatch(/^application\/json/);
    // what a task hands in is no member of the folder layout: the read-back compiles the phase to its own task
    expect(messageOf(out.body as Buffer)).toBe(`${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift(phaseTitle)}.`);
    expect(out.headers['content-disposition']).toBeUndefined();
    expect(await rowCounts()).toEqual(before);
  }, 120000);
  /* ---------- (5) the sign-off mark rides the block, editor → export → re-upload ---------- */

  it('(5) the editor marks Requirements for sign-off; the export carries it in the task block (no 409) and the re-upload holds the mark', async () => {
    const owner = await account('task-block-signoff');
    const shelf = await uploaded(owner.token, zipDirectory(SHELF_DIR), `Task block sign-off ${stamp}`);
    await editTask(owner.token, shelf.projectId, shelf.versionId, 'requirements', { signOff: true });
    const held = await snapshotOf(shelf.versionId);
    expect(taskOf(held, 'requirements').signOff).toBe(true);

    const out = await exportOf(owner.token, shelf.projectId, shelf.versionId);
    expect({ status: out.status, message: out.status === 200 ? null : messageOf(out.body as Buffer) }).toEqual({ status: 200, message: null });
    const archive = out.body as Buffer;
    expect(exportedPhaseJson(archive, 'phases/01-requirements').task).toEqual({ signOff: true });

    const again = await uploaded(owner.token, archive, `Task block sign-off again ${stamp}`);
    const back = await snapshotOf(again.versionId);
    expect(taskOf(back, 'requirements').signOff).toBe(true);
    expect(taskListOf(back)).toEqual(taskListOf(held));
    // and the new draft's editor reads the mark
    const draft = await request(http).get(versionBase(again.projectId, again.versionId)).set(bearer(owner.token)).set(from()).expect(200);
    const requirements = (draft.body.phases as { key: string; tasks: { taskKey: string; signOff?: boolean }[] }[]).find((one) => one.key === 'requirements')!;
    expect(requirements.tasks.map((one) => [one.taskKey, one.signOff])).toEqual([[INHERITED_TASK_KEY, true]]);
    // a mark that is not true or false is the block's NOT_A_PACK, naming the member
    const teacher = await account('task-block-signoff-bad');
    const bad = await upload(teacher.token, shelfTaskArchive((phase) => (phase.task.signOff = 'yes')), `Task block bad sign-off ${stamp}`);
    expect({ status: bad.status, code: bad.body?.code, detail: bad.body?.detail }).toEqual({
      status: 400,
      code: 'NOT_A_PACK',
      detail: "phases/01-requirements's phase.json task block: its signOff must be true or false.",
    });
  }, 120000);
});
