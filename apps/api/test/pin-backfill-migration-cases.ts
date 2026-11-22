import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { H9PinLegacyEnrolments1789800100000 } from '../src/migrations/1789800100000-H9-PinLegacyEnrolments';
import { TASKTRACKR, TEACHER_SLUG, insertRow, tableRows } from './migration-history-fixture';

/**
 * The H9 cases, one set for both dialects. Each case runs inside a
 * transaction on a database already at base + H5 and rolls it back, so the
 * cases cannot see each other's rows.
 */

type Version = { version: string; status: 'draft' | 'published' | 'archived' };

interface Seeded {
  versions: Record<string, string>;
  nullTasktrackr: string[];
  pinnedTasktrackr: string;
  nullOther: string;
}

/** Projects, versions and enrolments for one case. */
async function seed(q: QueryRunner, tasktrackrVersions: Version[]): Promise<Seeded> {
  const tasktrackr = randomUUID();
  const other = randomUUID();
  await insertRow(q, 'projects', { id: tasktrackr, slug: TASKTRACKR, title: 'TaskTrackr', platformOwned: true, isDefault: true, origin: 'directory' });
  await insertRow(q, 'projects', { id: other, slug: TEACHER_SLUG, title: 'Library desk', origin: 'authored', ownerUserId: 'teacher-1' });
  const versions: Record<string, string> = {};
  for (const { version, status } of tasktrackrVersions) {
    versions[version] = randomUUID();
    await insertRow(q, 'project_versions', { id: versions[version], projectId: tasktrackr, version, status, manifest: '{}' });
  }
  versions['other-1.0.0'] = randomUUID();
  await insertRow(q, 'project_versions', { id: versions['other-1.0.0'], projectId: other, version: '1.0.0', status: 'published', manifest: '{}' });

  const enrol = async (slug: string, pin: string | null) => {
    const id = randomUUID();
    await insertRow(q, 'enrollments', { id, userId: randomUUID(), projectSlug: slug, projectVersionId: pin });
    return id;
  };
  const nullTasktrackr = [await enrol(TASKTRACKR, null), await enrol(TASKTRACKR, null)];
  // Pinned at enrolment to whichever version exists last in the list (the head).
  const head = tasktrackrVersions.length ? versions[tasktrackrVersions[tasktrackrVersions.length - 1].version] : null;
  const pinnedTasktrackr = await enrol(TASKTRACKR, head);
  const nullOther = await enrol(TEACHER_SLUG, null);
  return { versions, nullTasktrackr, pinnedTasktrackr, nullOther };
}

const pins = async (q: QueryRunner): Promise<Record<string, string | null>> =>
  Object.fromEntries(
    (await tableRows(q, 'enrollments')).map((row) => [row.id as string, (row.projectVersionId as string | null) ?? null]),
  );

/** Every statement `fn` issues on `runner`, in order. */
async function recorded(runner: QueryRunner, fn: () => Promise<void>): Promise<string[]> {
  const issued: string[] = [];
  const query = runner.query.bind(runner);
  const spy = jest.spyOn(runner, 'query').mockImplementation(((sql: string, parameters?: unknown[]) => {
    issued.push(sql);
    return query(sql, parameters);
  }) as never);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return issued;
}

export function h9Cases(database: () => DataSource, dialect: 'sqlite' | 'postgres'): void {
  const h9 = new H9PinLegacyEnrolments1789800100000();

  const inRolledBackTransaction = async (fn: (q: QueryRunner) => Promise<void>) => {
    const q = database().createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await fn(q);
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  };

  it('pins only the TaskTrackr null rows, to 2.0.1 by explicit semver, never to a later head', () =>
    inRolledBackTransaction(async (q) => {
      const s = await seed(q, [
        { version: '2.0.1', status: 'published' },
        { version: '2.1.0', status: 'published' },
      ]);
      const before = await pins(q);
      await h9.up(q);
      const after = await pins(q);
      for (const id of s.nullTasktrackr) expect(after[id]).toBe(s.versions['2.0.1']);
      expect(after[s.pinnedTasktrackr]).toBe(s.versions['2.1.0']);
      expect(after[s.nullOther]).toBeNull();
      const moved = Object.keys(before).filter((id) => before[id] !== after[id]).sort();
      expect(moved).toEqual([...s.nullTasktrackr].sort());
    }));

  it('changes nothing when no TaskTrackr 2.0.1 row exists', () =>
    inRolledBackTransaction(async (q) => {
      await seed(q, [{ version: '2.1.0', status: 'published' }]);
      const before = await pins(q);
      await h9.up(q);
      expect(await pins(q)).toEqual(before);
    }));

  it('changes nothing when 2.0.1 exists but is not published (draft, or archived)', async () => {
    for (const status of ['draft', 'archived'] as const) {
      await inRolledBackTransaction(async (q) => {
        await seed(q, [{ version: '2.0.1', status }]);
        const before = await pins(q);
        await h9.up(q);
        expect(await pins(q)).toEqual(before);
      });
    }
  });

  it('is idempotent: a second run changes nothing', () =>
    inRolledBackTransaction(async (q) => {
      await seed(q, [{ version: '2.0.1', status: 'published' }]);
      await h9.up(q);
      const once = await tableRows(q, 'enrollments');
      await h9.up(q);
      expect(await tableRows(q, 'enrollments')).toEqual(once);
    }));

  it('is a no-op on an empty database', () =>
    inRolledBackTransaction(async (q) => {
      await h9.up(q);
      expect(await tableRows(q, 'enrollments')).toEqual([]);
    }));

  it('has a down() that changes nothing, because a pin H9 wrote cannot be told from one written at enrolment', () =>
    inRolledBackTransaction(async (q) => {
      await seed(q, [{ version: '2.0.1', status: 'published' }]);
      await h9.up(q);
      const pinned = await tableRows(q, 'enrollments');
      const issued = await recorded(q, () => h9.down(q));
      expect(issued).toEqual([]);
      expect(await tableRows(q, 'enrollments')).toEqual(pinned);
    }));

  it('issues one plain UPDATE of "enrollments", with the uuid/varchar casts, and no DDL', () =>
    inRolledBackTransaction(async (q) => {
      const issued = await recorded(q, () => h9.up(q));
      const statements = dialect === 'postgres' ? issued.slice(1) : issued;
      if (dialect === 'postgres') expect(issued[0]).toBe(`SET lock_timeout = '3s'`);
      expect(statements).toHaveLength(1);
      const [sql] = statements;
      expect(sql).toMatch(/^UPDATE "enrollments" SET "projectVersionId" = \(/);
      expect(sql).not.toMatch(/\b(ALTER|CREATE|DROP)\s+TABLE\b/i);
      expect(sql.match(/CAST\(p\."id" AS varchar\) = v\."projectId"/g)).toHaveLength(2);
      expect(sql).toContain(`SELECT CAST(v."id" AS varchar)`);
      expect(sql).toContain(`v."version" = '2.0.1'`);
      expect(sql).toContain(`v."status" = 'published'`);
      expect(sql).toContain(`"projectVersionId" IS NULL AND "projectSlug" = 'tasktrackr'`);
    }));
}
