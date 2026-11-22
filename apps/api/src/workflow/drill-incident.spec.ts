import { EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook, type DrillState, type Runbook } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent } from '../content/content.types';
import { recordPack } from '../../test/record-pack';
import { drillWithIncident } from './drill-incident';

const runbook: Runbook = EMPTY_RUNBOOK;
const withIncident = (book: Runbook, rootCause: string): Runbook => ({ ...book, incident: { rootCause, fix: 'set API_URL to http://api:8000', actionItem: 'lint compose in CI' } });

describe('drillWithIncident', () => {
  const drill: DrillState = { fault: 'f', pagedAt: 'p', runbookBefore: null, healthRanAt: null, healthExit: null, fixAppliedAt: null, resolvedAt: null, incident: { rootCause: 'stored', fix: 'x', actionItem: 'y' } };
  const withRunbook = new ContentService().loadProject(recordPack()).phases.find((p) => p.key === 'deployment')!;
  const withoutRunbook = { checks: { ...withRunbook.checks, runbook: undefined } } as Pick<PhaseContent, 'checks'>;

  it('reads the incident from the record, null when its three fields are blank', () => {
    expect(drillWithIncident(drill, { [RUNBOOK_JSON]: serialiseRunbook(withIncident(runbook, 'from the record')) }, withRunbook)!.incident?.rootCause).toBe('from the record');
    expect(drillWithIncident(drill, { [RUNBOOK_JSON]: serialiseRunbook(runbook) }, withRunbook)!.incident).toBeNull();
  });
  it('keeps an older drill\'s stored incident when the workspace holds no record, or the phase grades none', () => {
    expect(drillWithIncident(drill, {}, withRunbook)!.incident?.rootCause).toBe('stored');
    expect(drillWithIncident(drill, null, withRunbook)!.incident?.rootCause).toBe('stored');
    expect(drillWithIncident(drill, { [RUNBOOK_JSON]: serialiseRunbook(runbook) }, withoutRunbook)!.incident?.rootCause).toBe('stored');
    expect(drillWithIncident(null, {}, withRunbook)).toBeNull();
  });
  it('answers no incident for a record that does not parse or validate, so nothing stale is shown', () => {
    expect(drillWithIncident(drill, { [RUNBOOK_JSON]: '{ not json' }, withRunbook)!.incident).toBeNull();
    expect(drillWithIncident(drill, { [RUNBOOK_JSON]: JSON.stringify({ environment: 'none' }) }, withRunbook)!.incident).toBeNull();
  });
});
