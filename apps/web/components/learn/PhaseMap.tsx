'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PHASE_ORDER, PHASE_TITLES, type PhaseKey } from '@learnsdlc/shared';
import { PHASE_EXPERIENCE } from '@/components/phases/experience';
import { PhaseGlyph } from './figures/PhaseGlyph';
import { StatusMark } from './figures/StatusMark';
import './figures/figures.css';
import { PHASE_MAKES, gateSentence, type MapNode } from './phase-map';

/** The catalogue's lifecycle map: six phases on one line, joined by
 * the gate between each pair. A phase or a gate opens one panel under the
 * map (not a modal) saying what the learner makes there, the gate, and the
 * phase's mentor. Every node is a button: Tab reaches it, Enter or Space
 * opens it, the arrow keys, Home and End move along the line, Escape (in the
 * panel, on a phase or on a gate) closes it and returns to the phase. Every
 * state is a word. */
export function PhaseMap({ nodes }: { nodes: MapNode[] }) {
  const [open, setOpen] = useState<{ key: PhaseKey; gate: boolean } | null>(null);
  const nodeRefs = useRef<Partial<Record<PhaseKey, HTMLButtonElement | null>>>({});
  const gateRow = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    const target = open.gate ? gateRow.current : heading.current;
    target?.scrollIntoView?.({ block: 'nearest' });
    if (open.gate) target?.focus({ preventScroll: true });
  }, [open]);

  const toggle = (key: PhaseKey, gate = false) =>
    setOpen((now) => (now && now.key === key && now.gate === gate ? null : { key, gate }));

  const onRowKey = (event: KeyboardEvent<HTMLOListElement>) => {
    // Escape closes the open panel from a phase or a gate too, not only from
    // inside the panel, and returns to the open phase.
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
      return;
    }
    const keys = PHASE_ORDER;
    const at = keys.findIndex((key) => nodeRefs.current[key] === document.activeElement);
    if (at < 0) return;
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(at + 1, keys.length - 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? keys.length - 1
      : null;
    if (to === null) return;
    event.preventDefault();
    nodeRefs.current[keys[to]]?.focus();
  };

  const close = () => {
    if (!open) return;
    const key = open.key;
    setOpen(null);
    nodeRefs.current[key]?.focus();
  };

  const node = open ? nodes.find((one) => one.key === open.key) : undefined;
  const mentor = open ? PHASE_EXPERIENCE[open.key] : undefined;

  return (
    <section className="phase-map" aria-labelledby="phase-map-title" data-testid="phase-map">
      <header className="learn-section-heading">
        <h2 id="phase-map-title">How the six phases connect</h2>
        <span>Each phase ends at a gate</span>
      </header>
      <p className="phase-map-howto">Choose a phase or a gate to see what you make, how the phase is passed, and who mentors it.</p>
      <ol className="phase-map-row" onKeyDown={onRowKey}>
        {nodes.map((item, index) => {
          const expanded = open?.key === item.key && !open.gate;
          const name = PHASE_TITLES[item.key];
          return (
              <li key={item.key} className="phase-map-item" data-state={item.state}>
                <button
                  type="button"
                  ref={(el) => { nodeRefs.current[item.key] = el; }}
                  className="phase-map-node"
                  data-phase={item.key}
                  aria-expanded={expanded}
                  aria-controls="phase-map-panel"
                  onClick={() => toggle(item.key)}
                >
                  <span className="phase-map-glyph"><PhaseGlyph phaseKey={item.key} size={24} /></span>
                  <span className="phase-map-number">0{index + 1}</span>
                  <strong>{name}</strong>
                  <span className="phase-map-mentor">{PHASE_EXPERIENCE[item.key].name}</span>
                  <MapStateWord node={item} />
                </button>
              {index < nodes.length - 1 && (
                  <button
                    type="button"
                    className="phase-map-gate"
                    aria-expanded={open?.key === item.key && open.gate}
                    aria-controls="phase-map-panel"
                    aria-label={`The gate after ${name}: every required check and criterion must pass`}
                    onClick={() => toggle(item.key, true)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2l6 6-6 6-6-6z" /></svg>
                  </button>
              )}
              </li>
          );
        })}
      </ol>
      <div
        id="phase-map-panel"
        className="phase-map-panel"
        role="region"
        aria-labelledby={open ? 'phase-map-panel-title' : undefined}
        aria-label={open ? undefined : 'Phase details'}
        hidden={!open}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
      >
        {open && node && mentor && (
          <>
            <h3 id="phase-map-panel-title" ref={heading} tabIndex={-1}>
              <PhaseGlyph phaseKey={open.key} size={20} />
              {PHASE_TITLES[open.key]}
              <MapStateWord node={node} />
            </h3>
            {node.offered ? (
              <dl>
                <div>
                  <dt>You make</dt>
                  <dd><ul>{PHASE_MAKES[open.key].map((item) => <li key={item}>{item}</li>)}</ul></dd>
                </div>
                <div ref={gateRow} tabIndex={-1} className="phase-map-gate-row" data-focus={open.gate || undefined}>
                  <dt>The gate</dt>
                  <dd data-testid="phase-map-gate">{gateSentence(open.key)}</dd>
                </div>
                <div>
                  <dt>Your mentor</dt>
                  <dd><strong>{mentor.name}</strong>, {mentor.role}. {mentor.purpose}</dd>
                </div>
                <div>
                  <dt>Read the guide</dt>
                  <dd>
                    <Link className="exp-button" href={`/learn/${open.key}`} aria-label={`Open ${PHASE_TITLES[open.key]} guide`}>
                      Open guide
                      <ArrowRight size={14} />
                    </Link>
                  </dd>
                </div>
              </dl>
            ) : (
              <dl>
                <div ref={gateRow} tabIndex={-1} className="phase-map-gate-row">
                  <dt>This phase</dt>
                  <dd>{node.note}. Your phase brief says what it asks of you.</dd>
                </div>
                <div>
                  <dt>Your mentor</dt>
                  <dd><strong>{mentor.name}</strong>, {mentor.role}.</dd>
                </div>
              </dl>
            )}
            <button type="button" className="phase-map-close" onClick={close}>Close</button>
          </>
        )}
      </div>
    </section>
  );
}

/** A node's state: a StatusMark where one fits, else a plain word. */
function MapStateWord({ node }: { node: MapNode }) {
  if (node.state === 'passed') return <StatusMark status="passed" className="phase-map-state" />;
  if (node.state === 'current') return <StatusMark status="current" className="phase-map-state" />;
  if (node.state === 'locked' || node.state === 'not-held' || node.state === 'not-offered')
    return <StatusMark status="not-run" label={node.note} className="phase-map-state" />;
  return <span className="phase-map-state phase-map-open">{node.note}</span>;
}
