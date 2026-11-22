import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const Database = require('better-sqlite3') as new (path: string) => {
  exec(sql: string): void; prepare(sql: string): { all(): unknown[]; get(): unknown }; close(): void;
};
import { composeChatMessages, composeGuidedReviewMessages, mentorInstructionIdentity } from './openai.provider';
import type { MentorContext } from './provider.types';
import { REFERENCE_SCOPE } from './project-scope';

const root = resolve(__dirname, '../../../../content/tasktrackr');
const authored = JSON.parse(readFileSync(resolve(root, 'phases/06-maintenance/phase.json'), 'utf8'));
// TaskTrackr's maintenance mentor pinned on a synthetic phase, so the reference scope is passed on purpose.
const context = { phase: { key: 'maintenance', title: 'Maintenance', files: [], assistant: authored.assistant, taskPanel: 'Keep one returned row per task.' }, message: 'What changes when one task has two comments?', workspace: {}, signals: { todosRemaining: [], lastFailedChecks: [] }, interactionCount: 0, topicUseCounts: {}, scope: REFERENCE_SCOPE } as unknown as MentorContext;

describe('Maintenance query ownership facts', () => {
  it('proves canonical list totals stay unchanged when a separate read multiplies task rows', () => {
    const source = readFileSync(resolve(root, 'canonical/api/repository/lists.py'), 'utf8');
    const sql = source.match(/LIST_SELECT = """([\s\S]*?)"""/)?.[1];
    expect(sql).toBeDefined();
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE lists(id INTEGER PRIMARY KEY,name TEXT,created_at TEXT);
        CREATE TABLE tasks(id INTEGER PRIMARY KEY,list_id INTEGER,status TEXT);
        CREATE TABLE comments(id INTEGER PRIMARY KEY,task_id INTEGER);
        INSERT INTO lists VALUES(1,'Morning','2026-09-12');
        INSERT INTO tasks VALUES(10,1,'open'),(11,1,'done');
        INSERT INTO comments VALUES(1,10),(2,10);`);
      const before = db.prepare(sql!).all();
      expect(before).toEqual([expect.objectContaining({ id: 1, task_count: 2, open_count: 1 })]);
      const joined = db.prepare('SELECT t.id FROM tasks t LEFT JOIN comments c ON c.task_id=t.id ORDER BY t.id,c.id').all();
      expect(joined).toEqual([{ id: 10 }, { id: 10 }, { id: 11 }]);
      expect(db.prepare(sql!).all()).toEqual(before);
      expect(db.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });
  it('gives generation and semantic output review the same limited factual correction', () => {
    const candidate = 'Changing returned task rows changes the separately computed list totals.';
    const generation = composeChatMessages(context), review = composeGuidedReviewMessages(context, candidate);
    for (const system of [generation[0].content, review[0].content]) {
      expect(system).toContain('A row-multiplying read in TASK_SELECT does not itself change those separate list totals or stored task records.');
      expect(system).toContain('Ask the learner to predict these observations separately, without writing the query for them.');
      expect(system).not.toContain(candidate);
      expect(system).not.toContain('SELECT COUNT');
    }
    expect(review[1].content).toContain(candidate);
    const previous = { ...context.phase, assistant: { ...context.phase.assistant, systemPrompt: 'Coach maintenance without the corrected query ownership facts.' } };
    expect(mentorInstructionIdentity(context.phase, REFERENCE_SCOPE)).not.toBe(mentorInstructionIdentity(previous, REFERENCE_SCOPE));
    // The other side: resolved, the synthetic phase is not TaskTrackr's and gets none of TaskTrackr's query facts.
    const resolved = { ...context, scope: undefined } as MentorContext;
    expect(composeChatMessages(resolved)[0].content).not.toContain('TASK_SELECT');
    expect(composeGuidedReviewMessages(resolved, candidate)[0].content).not.toContain('TASK_SELECT');
  });
});
