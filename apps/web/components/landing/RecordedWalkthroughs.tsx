'use client';

import { PHASE_ORDER, type PhaseKey } from '@learnsdlc/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, CirclePlay, Film, Maximize, Play } from 'lucide-react';
import { RecordingPlaybackButton } from './RecordingPlaybackButton';
import './RecordedWalkthroughs.css';

export type RecordedWalkthrough = {
  phase: PhaseKey;
  title: string;
  caption: string;
  src: string;
  poster: string;
  captionsSrc: string;
  /** Versioned local assets keep previous recordings available for provenance. */
  edition?: string;
  kind?: 'workspace-tutorial';
  /** The recorder writes null. Fill only after watching the real clip and poster. */
  review: {
    audience: 'public-product-tour';
    reviewedAt: string;
    sourceVerificationAt: string;
    solutionsExcluded: true;
    privateConversationsExcluded: true;
  } | null;
};

/** Candidate captures cannot appear on a public page merely by passing a manifest. */
export function isReviewedWalkthrough(recording: RecordedWalkthrough): boolean {
  const review = recording.review;
  if (recording.edition !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(recording.edition)) return false;
  const directory = `/walkthroughs/${recording.edition ? `${recording.edition}/` : ''}`;
  return PHASE_ORDER.includes(recording.phase)
    && review?.audience === 'public-product-tour'
    && review.solutionsExcluded === true
    && review.privateConversationsExcluded === true
    && Number.isFinite(Date.parse(review.reviewedAt))
    && Number.isFinite(Date.parse(review.sourceVerificationAt))
    && Date.parse(review.reviewedAt) >= Date.parse(review.sourceVerificationAt)
    && recording.src === `${directory}${recording.phase}.mp4`
    && recording.poster === `${directory}${recording.phase}.webp`
    && recording.captionsSrc === `${directory}${recording.phase}.vtt`;
}

function RecordingPlayer({ recording, descriptionId }: { recording: RecordedWalkthrough; descriptionId: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  useEffect(() => {
    const player = video.current;
    // Stop a removed recording, including when its reviewed metadata changes.
    return () => { player?.pause(); };
  }, []);
  return <figure className="lh-recorded-walkthrough">
    <div className="lh-recording-screen">
      <video
        id={`${descriptionId}-video`}
        ref={video}
        controls
        playsInline
        preload="none"
        poster={recording.poster}
        aria-label={`${recording.title}: recorded LearnSDLC walkthrough`}
        aria-describedby={descriptionId}
        onLoadStart={() => { if (video.current && !video.current.paused) setState('loading'); }}
        onPlay={() => setState('loading')}
        onWaiting={() => setState('loading')}
        onPause={() => setState(current => current === 'loading' ? 'idle' : current)}
        onCanPlay={() => setState('ready')}
        onPlaying={() => setState('ready')}
        onError={() => setState('error')}
      >
        <source src={recording.src} type="video/mp4" onError={() => setState('error')} />
        <track kind="captions" src={recording.captionsSrc} srcLang="en" label="Walkthrough captions" default />
        <a href={recording.src}>Open the {recording.title} recording</a>
      </video>
      {state === 'loading' && <span className="lh-recording-status" role="status">Loading recording…</span>}
    </div>
    <figcaption id={descriptionId}>
      <div className="lh-recording-description"><span className="lh-recording-kicker"><Film size={14} aria-hidden="true" /> Recorded in LearnSDLC</span><h3>{recording.title}</h3><p>{recording.caption}</p></div>
      <div className="lh-recording-help"><RecordingPlaybackButton video={video} videoId={`${descriptionId}-video`} title={recording.title} onError={() => setState('error')} /><span><Maximize size={14} aria-hidden="true" /> Use fullscreen for a closer look.</span><a href={recording.src}>Open recording <ArrowUpRight size={14} aria-hidden="true" /><span className="sr-only">: {recording.title}</span></a></div>
      {state === 'error' && <p className="lh-recording-error" role="alert">This recording could not load. Try the open recording link, or choose another phase.</p>}
      {recording.kind === 'workspace-tutorial' ? <p className="lh-recording-boundary">A tour of the current controls using a clean starter workspace. Each phase was opened separately for this demonstration. No questions are sent, work is submitted, checks are run or passes are earned in this recording. Skip or replay this tutorial inside your phase.</p>
        : recording.phase === 'deployment' && <p className="lh-recording-boundary">Configuration review and isolated selfcheck only. This recording does not demonstrate Docker builds, GitHub Actions execution, Compose startup, or live HTTP health probes.</p>}
    </figcaption>
  </figure>;
}

/** Only the selected, visually reviewed clip mounts media; changing phase never starts playback. */
export function RecordedWalkthroughs({ recordings }: { recordings: readonly RecordedWalkthrough[] }) {
  const id = useId().replace(/:/g, '');
  const [selected, setSelected] = useState<PhaseKey | null>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  // One tab per real reviewed phase, in phase order; duplicate candidates do
  // not create duplicate IDs, players, or confusing keyboard destinations.
  const reviewed = PHASE_ORDER.flatMap(phase => {
    const recording = recordings.find(item => item.phase === phase && isReviewedWalkthrough(item));
    return recording ? [recording] : [];
  });
  const active = reviewed.find(recording => recording.phase === selected) ?? reviewed[0];
  if (!active) return null;
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? reviewed.length - 1
      : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % reviewed.length
        : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + reviewed.length - 1) % reviewed.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setSelected(reviewed[next].phase);
    tabs.current[next]?.focus();
  }
  return <section className="lh-recorded-walkthroughs" aria-labelledby={`${id}-title`}>
    <header className="lh-recordings-heading"><div><span className="lh-kicker"><CirclePlay size={16} aria-hidden="true" /> A look inside LearnSDLC</span><h2 id={`${id}-title`}>See the work, phase by phase.</h2></div><p>Short recordings of the real working spaces. Choose a phase, then press play.</p></header>
    <div className="lh-recordings-glass lh-frost">
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active.phase}`} tabIndex={0}>
        <RecordingPlayer key={`${active.phase}-${active.review?.reviewedAt}`} recording={active} descriptionId={`${id}-description-${active.phase}`} />
      </div>
      <div className="lh-recording-tabs" role="tablist" aria-label="Recorded project phases">
        {reviewed.map((recording, index) => <button
          key={recording.phase}
          ref={node => { tabs.current[index] = node; }}
          id={`${id}-tab-${recording.phase}`}
          type="button"
          role="tab"
          aria-selected={recording.phase === active.phase}
          aria-controls={`${id}-panel`}
          tabIndex={recording.phase === active.phase ? 0 : -1}
          onClick={() => setSelected(recording.phase)}
          onKeyDown={event => navigate(event, index)}
        ><span className="lh-recording-thumbnail"><img src={recording.poster} alt="" width={240} height={150} loading="lazy" /><span><Play size={17} fill="currentColor" aria-hidden="true" /></span></span><span className="lh-recording-tab-name"><small>{String(PHASE_ORDER.indexOf(recording.phase) + 1).padStart(2, '0')}</small>{recording.title}</span></button>)}
      </div>
    </div>
    <p className="lh-recordings-note">{reviewed.every(recording => recording.kind === 'workspace-tutorial')
      ? 'Follow the controls in a clean starter workspace. Each recording includes captions; the in-app tutorial can be skipped or replayed.'
      : 'Focused views of supplied examples and retained evidence. Private conversations are outside the frame. Each recording includes captions.'}</p>
  </section>;
}
