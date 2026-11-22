'use client';

import { useEffect, useState, type RefObject } from 'react';
import { Pause, Play } from 'lucide-react';

/** Native controls remain available; this button also works with keyboard-only Safari. */
export function RecordingPlaybackButton({ video, videoId, title, onError }: {
  video: RefObject<HTMLVideoElement | null>; videoId: string; title: string; onError: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const player = video.current;
    if (!player) return;
    const sync = () => setPlaying(!player.paused && !player.ended);
    const events = ['play', 'playing', 'pause', 'ended', 'error'];
    events.forEach(event => player.addEventListener(event, sync));
    sync();
    return () => events.forEach(event => player.removeEventListener(event, sync));
  }, [video]);
  async function toggle() {
    const player = video.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    try { await player.play(); }
    catch (error) {
      // Pausing or replacing media can cancel a pending play request normally.
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return;
      if (player.isConnected) onError();
    }
  }
  const Icon = playing ? Pause : Play;
  return <button className="lh-recording-playback" type="button" aria-controls={videoId}
    aria-label={`${playing ? 'Pause' : 'Play'} recording: ${title}`} onClick={toggle}>
    <Icon size={16} aria-hidden="true" />{playing ? 'Pause' : 'Play'}
  </button>;
}
