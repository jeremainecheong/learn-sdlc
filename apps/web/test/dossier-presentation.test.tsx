// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnrollmentView, LearnerDossier, PhaseDetail } from '@learnsdlc/shared';
import { buildDossier } from '@/components/dossier/build';
import { Dossier } from '@/components/dossier/Dossier';
import { PRESENTATION_VIEW_KEY, writePresentationView } from '@/components/experience/presentation-view';

/*
 * The printable record under the teacher's Presentation view, which hides
 * learners' email addresses while the screen is shared. The record's cover
 * follows the switch: it says the address is hidden rather than leaving a gap,
 * and keeps the name; off (the default), the email is printed.
 */

const EMAIL = 'ada.lovelace@smu.example';
const phase = { id: 'phase-req', key: 'requirements', order: 1, title: 'Requirements', status: 'in_progress', attempts: 0, bestScore: null, passedAt: null };
const enrollment = {
  phases: [phase], projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', releases: [], startedAt: '2026-10-10T00:00:00Z', completedAt: null,
} as unknown as EnrollmentView;
const details = { 'phase-req': { ...phase, files: [], links: [], rubric: { passThreshold: 70, criteria: [] } } } as unknown as Record<string, PhaseDetail>;
const dossier = (): LearnerDossier => ({ ...buildDossier(enrollment, details, {}, {}, null), displayName: 'Ada Lovelace', email: EMAIL });

let root: Root; let host: HTMLDivElement;
beforeEach(() => { window.localStorage.removeItem(PRESENTATION_VIEW_KEY); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.removeItem(PRESENTATION_VIEW_KEY); });
const draw = async () => { await act(async () => root.render(<Dossier dossier={dossier()} />)); };
const cover = () => host.querySelector('[data-testid="dossier-section-1"]')!;
const email = () => host.querySelector('[data-testid="dossier-cover-email"]')?.textContent ?? '';

describe("the record's cover under the Presentation view", () => {
  it('off (the default): the learner’s email is printed under the name', async () => {
    await draw();
    expect(host.querySelector('[data-testid="dossier-cover-name"]')!.textContent).toBe('Ada Lovelace');
    expect(email()).toBe(EMAIL);
  });

  it('on: the email is hidden and the cover says so; the name stays; nowhere on the page is the address', async () => {
    window.localStorage.setItem(PRESENTATION_VIEW_KEY, 'on');
    await draw();
    expect(host.querySelector('[data-testid="dossier-cover-name"]')!.textContent).toBe('Ada Lovelace');
    expect(email()).toBe('Email hidden in Presentation view');
    expect(cover().textContent).not.toContain(EMAIL);
    expect(host.textContent).not.toContain(EMAIL);
  });

  it('follows the switch while the page is open, both ways', async () => {
    await draw();
    expect(email()).toBe(EMAIL);
    await act(async () => writePresentationView(true));
    expect(email()).toBe('Email hidden in Presentation view');
    await act(async () => writePresentationView(false));
    expect(email()).toBe(EMAIL);
  });
});
