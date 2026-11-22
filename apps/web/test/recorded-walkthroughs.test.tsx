// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordedWalkthroughs, type RecordedWalkthrough } from '@/components/landing/RecordedWalkthroughs';

const candidate: RecordedWalkthrough = {
  phase: 'deployment', title: 'Deployment', caption: 'Inspect recorded configuration findings.',
  src: '/walkthroughs/deployment.mp4', poster: '/walkthroughs/deployment.webp',
  captionsSrc: '/walkthroughs/deployment.vtt', review: null,
};
const reviewed: RecordedWalkthrough = {
  ...candidate,
  review: { audience: 'public-product-tour', reviewedAt: '2026-09-11T03:00:00Z', sourceVerificationAt: '2026-09-11T02:00:00Z', solutionsExcluded: true, privateConversationsExcluded: true },
};
const clip = (phase: RecordedWalkthrough['phase']): RecordedWalkthrough => ({ ...reviewed, phase, title: phase[0].toUpperCase() + phase.slice(1), src: `/walkthroughs/${phase}.mp4`, poster: `/walkthroughs/${phase}.webp`, captionsSrc: `/walkthroughs/${phase}.vtt` });
let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('public recorded walkthroughs', () => {
  it('accepts reviewed versioned local tutorial media and rejects traversal or mixed editions', () => {
    const updated: RecordedWalkthrough = { ...reviewed, edition: 'phase-tutorials-v2', kind: 'workspace-tutorial', src: '/walkthroughs/phase-tutorials-v2/deployment.mp4', poster: '/walkthroughs/phase-tutorials-v2/deployment.webp', captionsSrc: '/walkthroughs/phase-tutorials-v2/deployment.vtt' };
    act(() => root.render(<RecordedWalkthroughs recordings={[updated]} />));
    expect(host.querySelector('video source')?.getAttribute('src')).toBe(updated.src);
    expect(host.textContent).toContain('clean starter workspace');
    expect(host.textContent).not.toContain('Configuration review and isolated selfcheck only');
    act(() => root.render(<RecordedWalkthroughs recordings={[{ ...updated, edition: '../private' }, { ...updated, captionsSrc: '/walkthroughs/deployment.vtt' }]} />));
    expect(host.querySelector('video')).toBeNull();
  });
  it('does not mount media from an unreviewed capture, incomplete review or external source', () => {
    const malformed = { ...reviewed, review: { ...reviewed.review, privateConversationsExcluded: false } } as unknown as RecordedWalkthrough;
    const stalePath = { ...reviewed, src: 'https://external.example/answer.mp4' };
    act(() => root.render(<RecordedWalkthroughs recordings={[candidate, malformed, stalePath]} />));
    expect(host.querySelector('video')).toBeNull(); expect(host.textContent).toBe('');
  });
  it('preserves evidence boundaries and opt-in playback even when the caller supplies a short caption', () => {
    act(() => root.render(<RecordedWalkthroughs recordings={[reviewed]} />));
    const video = host.querySelector('video')!;
    expect(video.controls).toBe(true); expect(video.autoplay).toBe(false); expect(video.preload).toBe('none');
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.querySelector('track[kind="captions"]')?.getAttribute('src')).toBe('/walkthroughs/deployment.vtt');
    expect(video.querySelector('track')?.hasAttribute('default')).toBe(true);
    expect(host.textContent).toContain('Configuration review and isolated selfcheck only');
    expect(host.textContent).toContain('does not demonstrate Docker builds, GitHub Actions execution, Compose startup, or live HTTP health probes');
    expect(host.textContent).toContain('Private conversations are outside the frame');
  });
  it('mounts one player and stops the previous recording when selecting another phase without autoplay', () => {
    act(() => root.render(<RecordedWalkthroughs recordings={['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'].map(phase => clip(phase as RecordedWalkthrough['phase']))} />));
    const previous = host.querySelector('video')!;
    expect(host.querySelectorAll('video')).toHaveLength(1); expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6);
    const testing = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(tab => tab.textContent?.includes('Testing'))!;
    act(() => testing.click());
    expect(host.querySelectorAll('video')).toHaveLength(1); expect(host.querySelector('video')).not.toBe(previous);
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.instances).toContain(previous);
    expect(host.querySelector('video source')?.getAttribute('src')).toBe('/walkthroughs/testing.mp4');
    expect(host.querySelector('video')?.autoplay).toBe(false);
    expect(host.querySelector('[aria-selected="true"]')).toBe(testing);
  });
  it('moves focus with arrow, Home and End keys while selecting the corresponding labelled panel', () => {
    act(() => root.render(<RecordedWalkthroughs recordings={[clip('requirements'), clip('design'), clip('testing')]} />));
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs[0].focus(); act(() => fireEvent.keyDown(tabs[0], { key: 'End' }));
    expect(document.activeElement).toBe(tabs[2]); expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs[2].id);
    act(() => fireEvent.keyDown(tabs[2], { key: 'ArrowRight' })); expect(document.activeElement).toBe(tabs[0]);
    act(() => fireEvent.keyDown(tabs[0], { key: 'ArrowRight' })); expect(document.activeElement).toBe(tabs[1]);
    act(() => fireEvent.keyDown(tabs[1], { key: 'Home' })); expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.filter(tab => tab.tabIndex === 0)).toHaveLength(1);
  });
  it('shows actual loading and failure feedback with a matching direct link, and clears it when another clip is selected', () => {
    act(() => root.render(<RecordedWalkthroughs recordings={[clip('requirements'), reviewed]} />));
    const video = host.querySelector('video')!;
    // preload=none must not imply buffering before a visitor chooses Play.
    act(() => fireEvent.loadStart(video)); expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => fireEvent.play(video)); expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading recording');
    act(() => fireEvent.pause(video)); expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => fireEvent.error(video.querySelector('source')!)); expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not load');
    expect(host.querySelector('.lh-recording-help a')?.getAttribute('href')).toBe('/walkthroughs/requirements.mp4');
    act(() => host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('.lh-recording-help a')?.getAttribute('href')).toBe('/walkthroughs/deployment.mp4');
  });
  it('withdraws media when its review is removed and keeps associations unique across gallery instances', () => {
    act(() => root.render(<><RecordedWalkthroughs recordings={[reviewed, reviewed]} /><RecordedWalkthroughs recordings={[reviewed]} /></>));
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    const ids = [...host.querySelectorAll('video')].map(video => video.getAttribute('aria-describedby'));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(host.querySelector(`[id="${id}"]`)?.textContent).toContain('Deployment');
    const players = [...host.querySelectorAll('video')];
    act(() => root.render(<RecordedWalkthroughs recordings={[candidate]} />));
    expect(host.querySelector('video')).toBeNull();
    for (const player of players) expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.instances).toContain(player);
  });
});
