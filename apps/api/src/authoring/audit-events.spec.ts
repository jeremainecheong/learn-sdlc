import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { AUTHORING_AUDIT_EVENTS } from '@learnsdlc/shared';
import type { AuditEventView, AuthoringAuditEvent } from '@learnsdlc/shared';
import { AuditEventEntity } from '../db/entities';
import type { AuditRow } from '../audit/audit';
import { S1_TEACHER, copyTaskTrackr, openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';

/**
 * The authoring audit writer, typed by the contract's own list.
 *
 * Every `AuthoringAuditEvent` is a member of `AuditEventView['event']`, so the
 * writer needs no narrowing cast, and what it emits is checked against
 * `AUTHORING_AUDIT_EVENTS` by name.
 */
describe('the authoring audit writer', () => {
  const SERVICE = path.join(__dirname, 'authoring.service.ts');

  it('writes an AuthoringAuditEvent into an audit row with no cast', () => {
    // compile-time half: every name in the contract's list is a member of the
    // row's union, so this assignment needs no `as`
    const every: AuditRow['event'][] = [...AUTHORING_AUDIT_EVENTS];
    const one: AuditEventView['event'] = 'project.interview-read' satisfies AuthoringAuditEvent;
    expect(every).toHaveLength(AUTHORING_AUDIT_EVENTS.length);
    expect(one).toBe('project.interview-read');

    // and the service does not narrow through `unknown`
    const source = fs.readFileSync(SERVICE, 'utf8');
    expect(source).not.toMatch(/as unknown as AuditRow\['event'\]/);
    expect(source).not.toMatch(/\bauditEvent\(/);
  });

  describe('what the writer emits', () => {
    let world: ForkWorld;
    beforeAll(async () => {
      world = await openForkWorld();
    });
    afterAll(async () => {
      await world?.close();
    });

    it('is a name from AUTHORING_AUDIT_EVENTS on every row a copy, a validate and an intro write leave (guard)', async () => {
      const fork = await copyTaskTrackr(world, 'ba-audit-names');
      await world.service.validate(S1_TEACHER, fork.projectId, fork.versionId);
      const rows = await world.dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { targetId: fork.projectId } });
      const names = new Set<string>(AUTHORING_AUDIT_EVENTS);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) expect(names.has(String(row.event))).toBe(true);
      expect(rows.map((row) => String(row.event)).sort()).toEqual(['project.create', 'project.validate']);
    });
  });
});
