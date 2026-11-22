// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecordedClip } from '@/components/landing/RecordedClip';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  act(() => root.render(<RecordedClip title="Explain, then apply" label="Recorded mentor example" src="/recording.mp4" poster="/poster.webp" captions="/captions.vtt" kicker="Recorded example" description="A prepared documentation change with real AI replies." />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it('waits for the visitor, announces buffering, and clears it when playback resumes', () => {
  const video = host.querySelector('video')!;
  expect(video.autoplay).toBe(false); expect(video.preload).toBe('none');
  expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => fireEvent.waiting(video)); expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading recording…');
  act(() => fireEvent.pause(video)); expect(host.querySelector('[role="status"]')).toBeNull();
  act(() => fireEvent.waiting(video)); expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading recording…');
  act(() => fireEvent.playing(video)); expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('track')?.hasAttribute('default')).toBe(true);
});
it('keeps a direct recording link after a media failure and stops removed media', () => {
  act(() => fireEvent.error(host.querySelector('source')!));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not load');
  expect(host.querySelector('.lh-recording-help a')?.getAttribute('href')).toBe('/recording.mp4');
  act(() => root.render(null)); expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
});
it('keeps the keyboard playback button in sync with native playback and ending', () => {
  const video = host.querySelector('video')!, button = host.querySelector<HTMLButtonElement>('.lh-recording-playback')!;
  const paused = vi.spyOn(video, 'paused', 'get');
  const ended = vi.spyOn(video, 'ended', 'get');
  paused.mockReturnValue(false); ended.mockReturnValue(false);
  act(() => fireEvent.play(video));
  expect(button.getAttribute('aria-label')).toBe('Pause recording: Explain, then apply');
  expect(button.getAttribute('aria-controls')).toBe(video.id);
  act(() => button.click()); expect(video.pause).toHaveBeenCalledOnce();
  paused.mockReturnValue(true); ended.mockReturnValue(true);
  act(() => fireEvent.ended(video));
  expect(button.getAttribute('aria-label')).toBe('Play recording: Explain, then apply');
});
it('reports a rejected keyboard playback request instead of claiming playback', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('Playback unavailable'));
  await act(async () => host.querySelector<HTMLButtonElement>('.lh-recording-playback')!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not load');
  expect(host.querySelector('.lh-recording-playback')?.getAttribute('aria-label')).toMatch(/^Play recording:/);
  expect(host.querySelector('.lh-recording-help a')?.getAttribute('href')).toBe('/recording.mp4');
});
it('does not report a loading failure when Pause cancels a pending play request', async () => {
  const video = host.querySelector('video')!, button = host.querySelector<HTMLButtonElement>('.lh-recording-playback')!;
  const paused = vi.spyOn(video, 'paused', 'get').mockReturnValue(true);
  let rejectPlay!: (reason: unknown) => void;
  vi.spyOn(video, 'play').mockImplementation(() => {
    paused.mockReturnValue(false); fireEvent.play(video);
    return new Promise((_, reject) => { rejectPlay = reject; });
  });
  vi.mocked(video.pause).mockImplementation(() => { paused.mockReturnValue(true); fireEvent.pause(video); });
  act(() => button.click()); expect(host.querySelector('[role="status"]')).not.toBeNull();
  act(() => button.click());
  await act(async () => rejectPlay(new DOMException('The play request was interrupted by pause', 'AbortError')));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(button.getAttribute('aria-label')).toMatch(/^Play recording:/);
});
