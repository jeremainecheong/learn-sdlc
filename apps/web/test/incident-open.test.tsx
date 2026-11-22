/**
 * An open incident states one length, not two.
 *
 * While INCIDENT-1 is still broken (no passing health run after the failure,
 * so no `fixAppliedAt`, and no resolve) the drill page's chip counts paged to
 * now ("Broken for 30 seconds", ticking). The timeline's red span ends at the
 * last event drawn, so a closed length there ("Broken for 5 seconds") would
 * stop at a moment the outage did not stop: the timeline says the incident is
 * still open, "Still broken", over the same span, and the chip keeps counting
 * to now. Once the fix is recorded, the one duration (paged to
 * `fixAppliedAt`) is drawn on the timeline, the card and the chip.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { DrillState } from '@learnsdlc/shared';
import { STILL_BROKEN, brokenFor, timelineEvents } from '@/components/workspace/panels/deployment/drill';
import { IncidentTimeline } from '@/components/workspace/panels/deployment/Timeline';
import { IncidentWriteUp } from '@/components/workspace/panels/deployment/DrillDoc';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

const T0 = Date.parse('2026-11-10T10:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** Paged at 0:00; the learner's health check failed again at 0:05; nothing fixed or written. */
const open = (over: Partial<DrillState> = {}): DrillState => ({
  fault: 'missing-env',
  pagedAt: at(0),
  runbookBefore: null,
  pagedExit: 1,
  healthRanAt: at(5),
  healthExit: 1,
  fixAppliedAt: null,
  resolvedAt: null,
  incident: null,
  ...over,
});
const fixed = (over: Partial<DrillState> = {}): DrillState =>
  open({ healthRanAt: at(40), healthExit: 0, fixAppliedAt: at(11), ...over });

const timeline = (state: DrillState) => renderToStaticMarkup(<IncidentTimeline events={timelineEvents(state, state.healthExit === 0)} />);
const spanLabel = (state: DrillState) => /(Broken for [^<]*|Still broken)/.exec(timeline(state))?.[0] ?? '';
const writeUp = (state: DrillState) =>
  renderToStaticMarkup(<IncidentWriteUp drill={state} value={{ rootCause: '', fix: '', actionItem: '' }} onChange={() => {}} />);

describe('while the incident is open', () => {
  it('the timeline says it is still broken, never a closed length, and the chip counts to now', () => {
    expect(STILL_BROKEN).toBe('Still broken');
    expect(spanLabel(open())).toBe('Still broken');
    expect(timeline(open())).not.toContain('Broken for');
    expect(brokenFor(open(), T0 + 30_000)).toBe('Broken for 30 seconds');
    expect(brokenFor(open(), T0 + 95_000)).toBe('Broken for 1 minute 35 seconds');
  });

  it('the red span is still drawn from the page to the last event', () => {
    const html = timeline(open());
    expect(html).toContain('fill-opacity="0.14"');
    expect(html).toContain('stroke-width="3"');
  });

  it('the INCIDENT-1 write-up, open, draws the same words', () => {
    const html = writeUp(open());
    expect(html).toContain('Still broken');
    expect(html).not.toContain('Broken for');
  });

  it('just paged, with nothing after the page, draws no span and no length', () => {
    const html = timeline(open({ healthRanAt: null, healthExit: null }));
    expect(html).not.toContain('Still broken');
    expect(html).not.toContain('Broken for');
  });
});

describe('once the fix is recorded, the one duration stands', () => {
  it('fixed, not yet written up: the timeline and the chip read paged to the fix', () => {
    expect(spanLabel(fixed())).toBe('Broken for 11 seconds');
    expect(brokenFor(fixed(), T0 + 90_000)).toBe('Broken for 11 seconds, then fixed');
    expect(writeUp(fixed())).toContain('Broken for 11 seconds');
    expect(writeUp(fixed())).not.toContain('Still broken');
  });

  it('resolved and written up, and an older drill with no fix stamp', () => {
    const resolved = fixed({ resolvedAt: at(70), incident: { rootCause: 'API_URL pointed at localhost.', fix: 'Pointed it at the api service.', actionItem: 'Check service names.' } });
    expect(spanLabel(resolved)).toBe('Broken for 11 seconds');
    const older = open({ healthRanAt: null, healthExit: null, resolvedAt: at(70) });
    expect(spanLabel(older)).toBe('Broken for 1 minute 10 seconds');
  });
});
