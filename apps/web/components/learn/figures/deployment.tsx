'use client';
import { useId, useState, type CSSProperties } from 'react';
import type { PhaseFigures } from './types';
import { Figure, FigureSvg } from './Figure';
import { StatusMark, type FigureStatus } from './StatusMark';
import { ToggleSet } from './ToggleSet';
import './deployment-maintenance.css';

/* The Deployment guide's figures. Every fact is
 * TaskTrackr's: the tasktrackr-data volume mounted at /data, TASKTRACKR_DB,
 * web published on 5173, api exposed on 8000, the drill's faulted line
 * API_URL: http://localhost:8000 and its fix http://api:8000. */

/* ------------------------------ chapter 1 ------------------------------- */

export const STARTING_TASKS = 12;
type LifeAction = 'none' | 'rebuild' | 'restart' | 'remove';
export const LIFECYCLE_ACTIONS: readonly { value: Exclude<LifeAction, 'none'>; label: string; keeps: boolean; why: string }[] = [
  { value: 'rebuild', label: 'Rebuild image', keeps: true, why: 'The image holds code and its runtime, not your tasks. The tasks live in the tasktrackr-data volume, so a new image opens the same database.' },
  { value: 'restart', label: 'Restart container', keeps: true, why: 'A new container mounts the same volume at /data, so it reads the same tasktrackr.db file.' },
  { value: 'remove', label: 'Remove volume', keeps: false, why: 'The volume held /data/tasktrackr.db. Removing it deletes the tasks. The next container starts with an empty database, and only a backup could bring them back.' },
];

export function LifecycleFigure() {
  const [action, setAction] = useState<LifeAction>('none');
  const [tasks, setTasks] = useState(STARTING_TASKS);
  const [message, setMessage] = useState('');
  const press = (value: Exclude<LifeAction, 'none'>) => {
    const entry = LIFECYCLE_ACTIONS.find((item) => item.value === value)!;
    const next = entry.keeps ? tasks : 0;
    setAction(value);
    setTasks(next);
    setMessage(`${entry.label}: tasks stored ${next}. ${entry.why}`);
  };
  const reset = () => { setAction('none'); setTasks(STARTING_TASKS); setMessage(`Reset: tasks stored ${STARTING_TASKS}.`); };
  const lit = (box: LifeAction) => (action === box ? 'lit' : undefined);
  return (
    <Figure
      title="What survives a restart"
      howTo="Press an action and watch the tasks stored."
      model
      description="Three things with three lifetimes. The image is the packaged code. The container is one running copy of it. The volume keeps the database file. Rebuilding the image or restarting the container keeps the tasks; removing the volume deletes them."
    >
      <div className="fig-dm-actions">
        {LIFECYCLE_ACTIONS.map((item) => (
          <button key={item.value} type="button" className="fig-button" onClick={() => press(item.value)}>{item.label}</button>
        ))}
        <button type="button" className="fig-button" onClick={reset}>Reset</button>
      </div>
      <div className="fig-dm-boxes">
        <div className="fig-dm-box" data-state={lit('rebuild')}><strong>Image</strong><code>api/Dockerfile</code><small>Code and runtime. Built, never changed by running.</small></div>
        <div className="fig-dm-box" data-state={lit('restart')}><strong>Container</strong><code>api</code><small>A running copy of the image. Replaceable.</small></div>
        <div className="fig-dm-box" data-state={action === 'remove' ? 'fail' : 'pass'}>
          <strong>Volume</strong><code>tasktrackr-data:/data</code>
          <small>Holds TASKTRACKR_DB, /data/tasktrackr.db.</small>
          <p className="fig-dm-count" data-testid="lifecycle-tasks">Tasks stored: {tasks}</p>
          <StatusMark status={tasks > 0 ? 'passed' : 'failed'} label={tasks > 0 ? 'Data kept' : 'Data gone'} />
        </div>
      </div>
      <p className="fig-live" aria-live="polite" data-testid="lifecycle-live">{message}</p>
    </Figure>
  );
}

/* ------------------------------ chapter 2 ------------------------------- */

export const PIPELINE_STAGES: readonly { name: string; proves: string; not: string }[] = [
  { name: 'Build image', proves: 'The image builds from this source.', not: 'That it serves a request.' },
  { name: 'Start services', proves: 'A process started.', not: 'That it is ready.' },
  { name: 'Health check', proves: 'The api answers /api/health from inside its own container.', not: 'That the browser can reach it.' },
  { name: 'User path', proves: 'A request through the published web address reaches the api and comes back.', not: 'Every other journey.' },
  { name: 'Record release', proves: 'Which version shipped and what was checked.', not: 'Anything that was not checked.' },
];
type Release = 'v1' | 'v2' | 'rollback';
const RESULTS: Record<Release, { marks: { status: FigureStatus; label?: string }[]; verdict: string; tone: 'pass' | 'fail' }> = {
  v1: { marks: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'passed', label: 'v1 recorded' }], verdict: 'v1 is live. Every stage passed.', tone: 'pass' },
  v2: { marks: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'failed' }, { status: 'not-run', label: 'Blocked' }], verdict: 'v2 is blocked. Health passed because it asks the api directly. The user path failed because web sends /api requests to http://localhost:8000, which is web itself.', tone: 'fail' },
  rollback: { marks: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'passed' }, { status: 'passed', label: 'v1 restored' }], verdict: 'Rolled back to v1. The stages ran again and passed. The volume was not touched, so the 12 tasks are still there.', tone: 'pass' },
};

export function PipelineRollback() {
  const [release, setRelease] = useState<Release>('v1');
  const [message, setMessage] = useState('');
  const go = (next: Release) => { setRelease(next); setMessage(RESULTS[next].verdict); };
  const result = RESULTS[release];
  return (
    <Figure
      title="A pipeline is a chain of evidence"
      howTo="Ship v2 with a bad API_URL, then roll back to v1."
      model="A teaching model. LearnSDLC runs a selfcheck here, not GitHub Actions, and builds no image."
      description="Each stage proves one thing and leaves the next thing unproven. A health check can pass while the path a user takes fails. Rolling back swaps the version you run and leaves the data volume alone."
    >
      <div className="fig-dm-actions">
        <button type="button" className="fig-button" onClick={() => go('v2')} disabled={release === 'v2'}>Ship v2 with a bad API_URL</button>
        <button type="button" className="fig-button" onClick={() => go('rollback')} disabled={release !== 'v2'}>Roll back to v1</button>
        <button type="button" className="fig-button" onClick={() => go('v1')} disabled={release === 'v1'}>Reset</button>
      </div>
      <ol className="fig-dm-stages" aria-label={`Pipeline stages for ${release === 'v2' ? 'v2' : 'v1'}`}>
        {PIPELINE_STAGES.map((stage, i) => (
          <li key={stage.name} data-state={result.marks[i].status} data-testid={`stage-${i}`}>
            <strong>{stage.name}</strong>
            <StatusMark status={result.marks[i].status} label={result.marks[i].label} />
            <small>Proves: {stage.proves}</small>
            <small>Not: {stage.not}</small>
          </li>
        ))}
      </ol>
      <div className="fig-dm-boxes" style={{ marginTop: 10 }}>
        <div className="fig-dm-box"><strong>Running</strong><code>{release === 'v2' ? 'v2: API_URL: http://localhost:8000' : 'v1: API_URL: http://api:8000'}</code></div>
        <div className="fig-dm-box" data-state="pass"><strong>Volume</strong><code>tasktrackr-data</code><small data-testid="pipeline-tasks">Tasks stored: {STARTING_TASKS}</small></div>
      </div>
      <p className="fig-verdict" data-tone={result.tone}>{result.verdict}</p>
      <p className="sr-only" aria-live="polite" data-testid="pipeline-live">{message}</p>
    </Figure>
  );
}

/* ------------------------------ chapter 3 ------------------------------- */

type Viewpoint = 'browser' | 'web' | 'api';
const VIEWPOINTS = [
  { value: 'browser', label: 'From the browser' },
  { value: 'web', label: 'From the web container' },
  { value: 'api', label: 'From the api container' },
] as const;
export const LOCALHOST_MEANS: Record<Viewpoint, string> = {
  browser: 'Here localhost is your own computer. Port 5173 is published there, so localhost:5173 reaches the web container.',
  web: 'Here localhost is the web container itself. Nothing listens on port 8000 inside it. The api service is reached by its name, api:8000.',
  api: 'Here localhost is the api container itself. Its health check asks http://127.0.0.1:8000/api/health, so it passes even while the web path is broken.',
};
type Url = 'faulted' | 'fixed';

export function NetworkViewpoints() {
  const [view, setView] = useState<Viewpoint>('web');
  const [url, setUrl] = useState<Url>('faulted');
  const fixed = url === 'fixed';
  const box = (v: Viewpoint) => (view === v ? 'node-lit' : 'node');
  const svgDescription = `The browser calls the published web address, localhost:5173. The web process forwards /api requests to the configured API destination. The api reads and writes SQLite on the tasktrackr-data volume. ${fixed
    ? 'API_URL is http://api:8000, so the request from web reaches the api container.'
    : 'API_URL is http://localhost:8000, so the request from web loops back into the web container and fails, while the api stays healthy.'} Viewpoint: ${VIEWPOINTS.find((v) => v.value === view)!.label}. This is a conceptual request path, not evidence that a deployment ran.`;
  return (
    <Figure
      title="Follow localhost from the caller"
      howTo="Pick a viewpoint, then name the api service."
      model
      scroll
      description={LOCALHOST_MEANS[view]}
    >
      <div className="fig-dm-controls">
        <div><span>Viewpoint</span><ToggleSet label="Viewpoint" options={VIEWPOINTS} value={view} onChange={setView} /></div>
        <div className="fig-dm-actions" style={{ marginBottom: 0 }}>
          <button type="button" className="fig-button" onClick={() => setUrl(fixed ? 'faulted' : 'fixed')}>
            {fixed ? 'Put the faulted line back' : 'Name the api service'}
          </button>
        </div>
      </div>
      {/* Laid out on a 1000-unit width so it fills the figure at 1440 with its
          text at body size; each label sits in a gap at least 35 units clear
          of the boxes beside it, so localhost:5173 never runs into web. At
          860 px or wider, its 13-unit text never draws under about 11 px
          while it scrolls in its box. */}
      <FigureSvg className="fig-dm-svg" title="TaskTrackr requests cross different network viewpoints" description={svgDescription} viewBox="0 0 1000 260" minWidth={860}>
        <defs>
          <marker id="dm-arrow" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--fig-line)" /></marker>
          <marker id="dm-arrow-fail" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--fig-fail)" /></marker>
          <marker id="dm-arrow-pass" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--fig-pass)" /></marker>
        </defs>
        <rect className={box('browser')} x="20" y="60" width="200" height="70" rx="8" data-node="browser" />
        <text x="120" y="89" textAnchor="middle" className="word-strong">Browser</text>
        <text x="120" y="111" textAnchor="middle" className="word-muted">your computer</text>
        <rect className={box('web')} x="400" y="60" width="210" height="70" rx="8" data-node="web" />
        <text x="505" y="89" textAnchor="middle" className="word-strong">web container</text>
        <text x="505" y="111" textAnchor="middle" className="mono">5173, published</text>
        <rect className={box('api')} x="790" y="60" width="190" height="70" rx="8" data-node="api" />
        <text x="885" y="89" textAnchor="middle" className="word-strong">api container</text>
        <text x="885" y="111" textAnchor="middle" className="mono">8000, exposed</text>
        <rect className="node" x="790" y="185" width="190" height="60" rx="8" />
        <text x="885" y="210" textAnchor="middle" className="word-strong">SQLite</text>
        <text x="885" y="231" textAnchor="middle" className="mono">tasktrackr-data</text>
        <line className="edge" x1="220" y1="95" x2="399" y2="95" markerEnd="url(#dm-arrow)" />
        <text x="310" y="83" textAnchor="middle" className="mono" data-label="published">localhost:5173</text>
        <line className="edge" x1="885" y1="130" x2="885" y2="184" markerEnd="url(#dm-arrow)" />
        <text x="897" y="162" className="word-muted">read, write</text>
        {fixed ? (
          <>
            <line className="edge-pass" x1="610" y1="95" x2="789" y2="95" markerEnd="url(#dm-arrow-pass)" />
            <text x="700" y="83" textAnchor="middle" className="mono">api:8000</text>
            <text x="505" y="170" textAnchor="middle" className="word-pass">Reaches the api</text>
          </>
        ) : (
          <>
            <path className="edge-fail" d="M560,130 C560,188 450,188 450,132" markerEnd="url(#dm-arrow-fail)" />
            <text x="505" y="210" textAnchor="middle" className="mono">localhost:8000</text>
            <text x="505" y="232" textAnchor="middle" className="word-fail">Back into web: nothing there</text>
            <text x="885" y="45" textAnchor="middle" className="word-pass">Health passes</text>
          </>
        )}
      </FigureSvg>
      <p className="fig-live" aria-live="polite" data-testid="viewpoint-live">
        API_URL is <code>{fixed ? 'http://api:8000' : 'http://localhost:8000'}</code>. {fixed ? 'The web container reaches the api.' : 'The web container calls itself, so every page is empty while the api stays healthy.'}
      </p>
    </Figure>
  );
}

/* ------------------------------ chapter 4 ------------------------------- */

/** The drill-like incident, one tick per step: its time since the page
 * (minutes and seconds), the step's short name drawn under the tick, what
 * happened, and the evidence to keep. */
export const INCIDENT_ROWS: readonly { at: string; kind: string; what: string; keep: string }[] = [
  { at: '0:00', kind: 'Paged', what: 'INCIDENT-1: the faulted copy did not start.', keep: 'The page time and the selfcheck exit code on the faulted copy.' },
  { at: '1:40', kind: 'Symptom', what: 'The api is healthy and its logs are quiet, but every page in the browser is empty.', keep: 'What a user sees, and the api log showing no incoming /api request.' },
  { at: '3:10', kind: 'Hypothesis', what: 'Requests never leave web, because API_URL is http://localhost:8000.', keep: 'The config line, and why a quiet api log points before the api.' },
  { at: '5:20', kind: 'Fix applied', what: 'API_URL set to http://api:8000.', keep: 'The changed line and the run that used it.' },
  { at: '6:30', kind: 'Re-checked', what: 'The same check that failed now passes on your files.', keep: 'The passing output, tied to the changed source.' },
];
/** What the skipped re-check's tick says instead. */
export const SKIPPED_RECHECK = { kind: 'Re-check skipped', what: 'Nobody re-ran the check that failed, so there is no passing output to keep.' };

const seconds = (at: string) => { const [m, s] = at.split(':').map(Number); return m * 60 + s; };
/** Where each tick sits on the rail, in percent: true to its time, the last
 * step at 80 percent, and "Resolved" at the rail's end (100). */
export const INCIDENT_AT: readonly number[] = INCIDENT_ROWS.map((row) =>
  Math.round((seconds(row.at) / seconds(INCIDENT_ROWS[INCIDENT_ROWS.length - 1].at)) * 800) / 10,
);

export function IncidentTimeline() {
  const [open, setOpen] = useState<number | null>(0);
  const [skip, setSkip] = useState(false);
  const panel = useId();
  const last = INCIDENT_ROWS.length - 1;
  const skipped = (i: number) => skip && i === last;
  const shown = open === null ? null : skipped(open) ? { ...INCIDENT_ROWS[open], ...SKIPPED_RECHECK } : INCIDENT_ROWS[open];
  return (
    <Figure
      title="An incident, written so someone else can follow it"
      howTo="Press a tick on the timeline to read what happened then and the evidence to keep. Then skip the re-check."
      model="A teaching model of an incident like the drill. Your own times are on the Incident drill page."
      description="Five steps from page to proof, each at its time since the page: paged, symptom, hypothesis, fix, re-check. The incident is resolved only when the path that failed is checked again and passes. Skip the re-check and the timeline breaks before Resolved. You then close it in three lines: what went wrong, what you changed, what would have caught it."
    >
      <div className="fig-dm-actions">
        <button type="button" className="fig-button" aria-pressed={skip} onClick={() => setSkip(!skip)}>Skip the re-check</button>
      </div>
      <div className="fig-tl">
        <p className="fig-tl-axis">Minutes and seconds since the page</p>
        <ol className="fig-tl-rail" aria-label="Incident timeline">
          {INCIDENT_ROWS.map((row, i) => (
            <li
              key={row.at}
              style={{ '--at': `${INCIDENT_AT[i]}%`, '--next': `${i < last ? INCIDENT_AT[i + 1] : 100}%` } as CSSProperties}
              data-state={skipped(i) ? 'skipped' : 'done'}
              data-segment={i === last ? (skip ? 'broken' : 'whole') : undefined}
            >
              <button type="button" className="fig-tl-tick" aria-expanded={open === i} aria-controls={panel} onClick={() => setOpen(open === i ? null : i)}>
                <time>{row.at}</time>
                <span className="fig-tl-dot" aria-hidden="true" />
                <span className="fig-tl-kind">{skipped(i) ? SKIPPED_RECHECK.kind : row.kind}</span>
              </button>
            </li>
          ))}
          <li className="fig-tl-end" style={{ '--at': '100%' } as CSSProperties} data-state={skip ? 'unresolved' : 'resolved'} data-testid="incident-end">
            <span className="fig-tl-endmark">
              <span aria-hidden="true" />
              <span className="fig-tl-dot" aria-hidden="true" />
              <StatusMark status={skip ? 'failed' : 'passed'} label={skip ? 'Not shown resolved' : 'Resolved'} />
            </span>
          </li>
        </ol>
        <div
          id={panel}
          className="fig-tl-panel"
          aria-live="polite"
          data-testid="incident-evidence"
          data-open={open === null ? undefined : 'true'}
          style={open === null ? undefined : ({ '--at-fraction': String(INCIDENT_AT[open] / 100) } as CSSProperties)}
        >
          {shown ? (
            <>
              <p><strong>{shown.at} {shown.kind}.</strong> {shown.what}</p>
              <p>{skipped(open!) ? 'Evidence to keep: none, so the incident is not shown resolved.' : `Evidence to keep: ${shown.keep}`}</p>
            </>
          ) : <p>Press a tick to read what happened then and the evidence to keep.</p>}
        </div>
      </div>
      {/* The tag ends in a full stop and sits on the sentence's baseline
          (never "Resolved The check..." run together, the tag higher). */}
      <p className="fig-verdict fig-tl-verdict" data-tone={skip ? 'fail' : 'pass'} aria-live="polite" data-testid="incident-verdict">
        <StatusMark status={skip ? 'failed' : 'passed'} label={skip ? 'Not shown resolved' : 'Resolved'} />{'. '}
        {skip ?'The fix was applied, but nobody checked the path that failed. A passing health check does not count.' : 'The check that failed now passes on the changed source.'}
      </p>
    </Figure>
  );
}

/** One line per figure. Chapters are numbered as the reader shows them (1 to 4). */
export const DEPLOYMENT_FIGURES: PhaseFigures = {
  'deployment-lifecycle': { chapter: 1, component: LifecycleFigure },
  'deployment-pipeline-rollback': { chapter: 2, component: PipelineRollback },
  'deployment-network-viewpoints': { chapter: 3, component: NetworkViewpoints },
  'deployment-incident-timeline': { chapter: 4, component: IncidentTimeline },
};
