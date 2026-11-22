/**
 * One duration for one incident.
 *
 * The INCIDENT-1 card said "Broken for 1 minute 10 seconds, then fixed"
 * (paged to the learner's written resolution, typing time included), the
 * timeline said "Broken for 11 seconds" (the first red to the LATEST health
 * run), and the drill page's chip counted paged to resolved, still ticking
 * after the fix. The system's own record says the outage ended at
 * `fixAppliedAt`: the first passing health run after the failure (the API's
 * `healthCheck`), which the runbook's timeline stores as "A health check
 * passed after the failure." All three now state paged to `fixAppliedAt`, and
 * a later re-run of the health check does not stretch it.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DrillState } from '@learnsdlc/shared';
import { brokenFor, timelineEvents } from '@/components/workspace/panels/deployment/drill';
import { IncidentTimeline } from '@/components/workspace/panels/deployment/Timeline';
import { IncidentRecord } from '@/components/workspace/panels/deployment';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** Paged at 0:00, fixed by the health check at 0:11, re-checked at 0:40, written up at 1:10. */
const drill = (over: Partial<DrillState> = {}): DrillState => ({
  fault: 'missing-env',
  pagedAt: at(0),
  runbookBefore: null,
  pagedExit: 1,
  healthRanAt: at(40),
  healthExit: 0,
  fixAppliedAt: at(11),
  resolvedAt: at(70),
  incident: { rootCause: 'API_URL pointed at localhost.', fix: 'Pointed it at the api service.', actionItem: 'Check service names in review.' },
  ...over,
});

const timelineLabel = (state: DrillState) => {
  const html = renderToStaticMarkup(<IncidentTimeline events={timelineEvents(state, state.healthExit === 0)} />);
  return /Broken for [^<]*/.exec(html)?.[0] ?? '';
};
const cardPurpose = (state: DrillState) => {
  const html = renderToStaticMarkup(<IncidentRecord props={{} as PhasePanelProps} drill={state} />);
  return /Broken for [^<]*/.exec(html)?.[0] ?? '';
};

describe('one incident, one duration: paged to the first passing health run after the failure', () => {
  it('the card, the timeline and the drill page chip agree, typing time left out', () => {
    expect(cardPurpose(drill())).toBe('Broken for 11 seconds, then fixed. The two lines a machine cannot write are yours.');
    expect(timelineLabel(drill())).toBe('Broken for 11 seconds');
    expect(brokenFor(drill(), T0 + 500_000)).toBe('Broken for 11 seconds, then fixed');
  });

  it('a later re-run of the health check does not stretch it', () => {
    const rerun = drill({ healthRanAt: at(300) });
    expect(timelineLabel(rerun)).toBe('Broken for 11 seconds');
    expect(cardPurpose(rerun)).toContain('Broken for 11 seconds, then fixed.');
    expect(brokenFor(rerun, T0 + 500_000)).toBe('Broken for 11 seconds, then fixed');
  });

  it('the TaskTrackr sighting: fixed at 0:03, written up at 0:06', () => {
    const quick = drill({ healthRanAt: at(3), fixAppliedAt: at(3), resolvedAt: at(6) });
    expect(cardPurpose(quick)).toContain('Broken for 3 seconds, then fixed.');
    expect(timelineLabel(quick)).toBe('Broken for 3 seconds');
    expect(brokenFor(quick, T0)).toBe('Broken for 3 seconds, then fixed');
  });

  it('minutes are said the same way in all three', () => {
    const slow = drill({ healthRanAt: at(200), fixAppliedAt: at(125), resolvedAt: at(400) });
    expect(cardPurpose(slow)).toContain('Broken for 2 minutes 5 seconds, then fixed.');
    expect(timelineLabel(slow)).toBe('Broken for 2 minutes 5 seconds');
    expect(brokenFor(slow, T0)).toBe('Broken for 2 minutes 5 seconds, then fixed');
  });

  it('the chip: fixed but not yet written up is fixed, and stops counting', () => {
    const fixed = drill({ resolvedAt: null, incident: null });
    expect(brokenFor(fixed, T0 + 50_000)).toBe('Broken for 11 seconds, then fixed');
    expect(brokenFor(fixed, T0 + 90_000)).toBe('Broken for 11 seconds, then fixed');
  });

  it('the chip: still broken counts to now and says nothing of a fix', () => {
    const open = drill({ healthRanAt: at(5), healthExit: 1, fixAppliedAt: null, resolvedAt: null, incident: null });
    expect(brokenFor(open, T0 + 30_000)).toBe('Broken for 30 seconds');
  });

  it('a resolved drill with no fix stamp (none is written today: the resolve refuses one) ends at the resolve', () => {
    const older = drill({ fixAppliedAt: null, healthRanAt: null, healthExit: null });
    expect(brokenFor(older, T0 + 500_000)).toBe('Broken for 1 minute 10 seconds, then fixed');
    expect(cardPurpose(older)).toContain('Broken for 1 minute 10 seconds, then fixed.');
    expect(timelineLabel(older)).toBe('Broken for 1 minute 10 seconds');
  });
});
