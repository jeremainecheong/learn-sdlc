import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { DossierPhase } from '@learnsdlc/shared';
import {
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
} from '../db/entities';
import { buildDossierJournal } from './journal';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The dossier's timeline has two readers (the instructor's dossier and the
 * repository export) so it lives in its own module, and this spec can check
 * it without standing up an instructor, a cohort or a whole Nest application.
 */
describe('buildDossierJournal', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = await memoryDataSource();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('puts a revision, a merge and a run on one timeline, newest first', async () => {
    const manager = dataSource.manager;
    const state = await manager.save(
      manager.create(PhaseStateEntity, {
        id: 'state-1',
        enrollmentId: 'enrol-1',
        userId: 'learner-1',
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'passed',
        passedAt: '2026-03-03T09:00:00.000Z',
      } as Partial<PhaseStateEntity>),
    );
    const release = await manager.save(
      manager.create(ReleaseRecordEntity, {
        enrollmentId: 'enrol-1',
        userId: 'learner-1',
        phaseStateId: state.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        version: 'v1',
        score: 86,
        notes: 'Merged the overdue story',
      } as Partial<ReleaseRecordEntity>),
    );
    await manager.save(
      manager.create(ExecutionRunEntity, {
        phaseStateId: state.id,
        userId: 'learner-1',
        kind: 'run',
        status: 'completed',
        result: { ok: true, tests: { total: 4, passed: 4, failed: 0, errored: 0 } },
      } as Partial<ExecutionRunEntity>),
    );

    const phases: DossierPhase[] = [
      {
        phaseStateId: state.id,
        key: 'requirements',
        order: 1,
        title: 'Requirements',
        status: 'passed',
        bestScore: 86,
        attempts: 1,
        hints: 2,
        passedAt: '2026-03-03T09:00:00.000Z',
        files: [],
        revisions: [
          {
            id: 'sub-1',
            status: 'completed',
            score: 86,
            passed: true,
            report: null,
            createdAt: '2026-03-02T09:00:00.000Z',
            attempt: 1,
            commitMessage: 'Write the overdue story',
            runClock: null,
          },
        ],
        merged: null,
        mergeMessage: 'Merged the overdue story',
        drill: null,
        links: [],
      },
    ];

    const rows = await buildDossierJournal(manager, [state], phases, [release]);
    const kinds = rows.map((row) => row.kind);
    expect(kinds).toContain('submission');
    expect(kinds).toContain('release');
    expect(kinds).toContain('run');
    expect(rows.find((row) => row.kind === 'submission')?.detail).toBe('Write the overdue story');
    expect(rows.find((row) => row.kind === 'release')?.title).toBe(
      'Merged Requirements as v1',
    );
    expect(rows.find((row) => row.kind === 'release')?.result).toBe('Merged');
    expect(JSON.stringify(rows.filter((row) => row.kind === 'release'))).not.toMatch(/Passed with|approved at|86/);
    // Newest first is the dossier's own order, and the export reverses it.
    const times = rows.map((row) => new Date(row.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('names the two drill rows in words, never by an incident number', async () => {
    const manager = dataSource.manager;
    const state = await manager.save(
      manager.create(PhaseStateEntity, {
        id: 'state-5',
        enrollmentId: 'enrol-1',
        userId: 'learner-1',
        phaseKey: 'deployment',
        phaseOrder: 5,
        status: 'in_progress',
      } as Partial<PhaseStateEntity>),
    );
    const phases: DossierPhase[] = [
      {
        phaseStateId: state.id,
        key: 'deployment',
        order: 5,
        title: 'Deployment',
        status: 'in_progress',
        bestScore: null,
        attempts: 0,
        hints: 0,
        passedAt: null,
        files: [],
        revisions: [],
        merged: null,
        mergeMessage: null,
        drill: {
          fault: 'TASKTRACKR_DB',
          pagedAt: '2026-03-04T09:00:00.000Z',
          runbookBefore: null,
          healthRanAt: '2026-03-04T09:05:00.000Z',
          healthExit: 0,
          fixAppliedAt: '2026-03-04T09:05:00.000Z',
          resolvedAt: '2026-03-04T09:10:00.000Z',
          incident: { rootCause: 'r', fix: 'f', actionItem: 'a' },
        },
        links: [],
      },
    ];

    const drill = (await buildDossierJournal(manager, [state], phases, [])).filter((row) => row.kind === 'drill');
    expect(drill.map((row) => row.title).sort()).toEqual(['Closed the incident', 'Paged for the incident drill']);
    expect(JSON.stringify(drill)).not.toContain('INCIDENT-1');
  });
});
