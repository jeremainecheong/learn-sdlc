'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { RecordingPlaybackButton } from './RecordingPlaybackButton';
import './RecordedWalkthroughs.css';

/** Reviewed product and mentor footage, played only when the visitor chooses. */
export function RecordedClip({ title, label, src, poster, captions, kicker, description, boundary }: {
  title: string; label: string; src: string; poster: string; captions: string;
  kicker: string; description: string; boundary?: string;
}) {
  const id = useId();
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  useEffect(() => { const element = video.current; return () => { element?.pause(); }; }, []);
  return <figure className="lh-recorded-walkthrough">
    <div className="lh-recording-screen">
      <video id={`${id}-video`} ref={video} controls playsInline preload="none" poster={poster} aria-label={label} aria-describedby={id}
        onPlay={() => setState('loading')} onWaiting={() => setState('loading')}
        onPause={() => setState(current => current === 'loading' ? 'idle' : current)}
        onPlaying={() => setState('ready')} onCanPlay={() => setState('ready')} onError={() => setState('error')}>
        <source src={src} type="video/mp4" onError={() => setState('error')} />
        <track kind="captions" src={captions} srcLang="en" label="English walkthrough captions" default />
        <a href={src}>Open recording: {title}</a>
      </video>
      {state === 'loading' && <span className="lh-recording-status" role="status">Loading recording…</span>}
    </div>
    <figcaption id={id}>
      <div className="lh-recording-description"><span className="lh-recording-kicker">{kicker}</span><h3>{title}</h3><p>{description}</p></div>
      <div className="lh-recording-help"><RecordingPlaybackButton video={video} videoId={`${id}-video`} title={title} onError={() => setState('error')} /><span>Use fullscreen for a closer look.</span><a href={src}>Open recording <ArrowRight size={14} aria-hidden="true" /><span className="sr-only">: {title}</span></a></div>
      {state === 'error' && <p className="lh-recording-error" role="alert">This recording could not load. Try the open recording link or reload the page.</p>}
      {boundary && <p className="lh-recording-boundary">{boundary}</p>}
    </figcaption>
  </figure>;
}
