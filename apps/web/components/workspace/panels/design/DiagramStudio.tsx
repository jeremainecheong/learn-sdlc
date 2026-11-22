'use client';
import { useId, useState, type ReactNode } from 'react';
import { useScrollFocusRef } from '@/lib/scroll-focus';
import { sidewaysCue, useSidewaysBox } from '@/lib/use-sideways-box';
import type { DesignState } from './useDesign';
import { parseSequence, type ParsedDiagram } from './diagram';
import { ClassDiagram } from './ClassDiagram';
import { AssistantMark, optional } from './BoardCards';
// Its own rules, so every page that draws the studio draws it styled.
import './diagram-studio.css';
/**
 * Where the sequence diagram's pieces go: a message every 65 px.
 *
 * Lifelines 150 px apart in boxes 130 px wide whatever their names would make five participants a drawing 750 units
 * wide. At 1280 px with the brief and the mentor open the canvas holds about 490 px, so the drawing would either
 * shrink its words to about 7 px or, held at 520 px, run its last lifeline past the canvas with nothing to say so.
 * So each box is as wide as the longest name needs (from 88 to 130 px) and the lifelines stand 12 px further apart
 * than that, so TaskTrackr's five participants draw 560 units wide. The drawing fills its canvas, but it shrinks no
 * further than {@link SEQUENCE}.FLOOR of its size (its labels about 9 px) and grows no further than MAX_SCALE
 * (uncapped, with both panels hidden at 1440 px it would grow to 1273 px, two messages to a screen); narrower than its
 * floor, the canvas scrolls and a line above it says so.
 */
export const SEQUENCE = {
  ROW: 65, FIRST_Y: 85, LABEL_ABOVE: 10, LABEL_PX: 11, EDGE: 4,
  NAME_PX: 12, BOX_MIN: 88, BOX_MAX: 130, BOX_PAD: 10, GAP: 12,
  FLOOR: 0.8, MAX_SCALE: 1.2,
} as const;
/**
 * A label's drawn width at 11 px, estimated letter by letter so that it errs wide. One average
 * width for every letter (6.2 px) let a label of wide letters near the edge lose a few pixels: here the widest
 * letters count a full em, capitals three quarters, narrow letters and spaces about a third, everything else a
 * little over half, each a touch above what the common sans faces draw.
 */
export function sequenceLabelWidth(text: string, px: number = SEQUENCE.LABEL_PX): number {
 let em = 0;
 for (const ch of text) {
  em += /[MWmw@%]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? 0.75 : /[0-9]/.test(ch) ? 0.62 : /[iljtfr.,:;'!|\s()[\]]/.test(ch) ? 0.36 : /[a-z]/.test(ch) ? 0.6 : 0.66;
 }
 return em * px;
}
/** A message as drawn: up to 70 characters, a longer one cut at 67 with an ellipsis (the whole label is its title). */
export const sequenceText = (label: string) => (label.length > 70 ? label.slice(0, 67) + '…' : label);
/**
 * The drawing's numbers. Nothing here reads the source: it lays out
 * what parseSequence returned. A label is centred over its
 * arrow, then moved in just enough that its estimated width stays
 * inside the drawing, so a long first or last label is never cut at the edge.
 * The lifelines it crosses are hidden behind the label's own background (its
 * halo, drawn in the canvas colour), not drawn through the words.
 *
 * The drawing is as wide as its lifelines need, or as its widest label needs where that is wider, with the lifelines
 * centred in it. `minWidth` and `maxWidth` are the CSS px it is drawn between.
 */
export function sequenceLayout(parsed: ParsedDiagram) {
 const names = parsed.participants.map((name) => sequenceLabelWidth(name, SEQUENCE.NAME_PX));
 const box = Math.round(Math.min(SEQUENCE.BOX_MAX, Math.max(SEQUENCE.BOX_MIN, Math.max(0, ...names) + 2 * SEQUENCE.BOX_PAD)));
 const step = box + SEQUENCE.GAP;
 const texts = parsed.messages.map((message) => sequenceText(message.label));
 const widest = Math.max(0, ...texts.map((text) => sequenceLabelWidth(text)));
 const width = Math.ceil(Math.max(parsed.participants.length * step, widest + 2 * SEQUENCE.EDGE, step));
 const height = Math.max(170, parsed.messages.length * SEQUENCE.ROW + 100);
 const first = (width - parsed.participants.length * step) / 2 + step / 2;
 const xOf = (name: string) => first + parsed.participants.indexOf(name) * step;
 const participants = parsed.participants.map((name) => ({ name, x: xOf(name) }));
 const messages = parsed.messages.map((message, i) => {
  const x1 = xOf(message.from); const x2 = xOf(message.to); const y = SEQUENCE.FIRST_Y + i * SEQUENCE.ROW;
  const text = texts[i];
  const half = sequenceLabelWidth(text) / 2;
  const middle = (x1 + x2) / 2;
  const labelX = half * 2 > width - 2 * SEQUENCE.EDGE ? width / 2 : Math.min(Math.max(middle, SEQUENCE.EDGE + half), width - SEQUENCE.EDGE - half);
  return { x1, x2, y, label: message.label, text, labelX, labelY: y - SEQUENCE.LABEL_ABOVE, reply: message.reply };
 });
 return {
  width, height, box, participants, messages,
  minWidth: Math.round(width * SEQUENCE.FLOOR),
  maxWidth: Math.round(width * SEQUENCE.MAX_SCALE),
 };
}
/** The line above the canvas while the drawing is wider than its floor lets it shrink to. */
export const SEQUENCE_SCROLL_CUE = sidewaysCue('the whole drawing');
/**
 * The canvas: the drawing between its floor and its cap, and the line above it while it scrolls (above it: under a tall
 * drawing it would fall below the first view). Where nothing scrolls there is no line and no room for one.
 */
function SequenceCanvas({ layout, children }: { layout: ReturnType<typeof sequenceLayout>; children: ReactNode }) {
 const box = useSidewaysBox();
 const ref = useScrollFocusRef<HTMLDivElement>(box.ref);
 return <>
  {box.scrolls && <p data-testid="design-sequence-scroll-cue">{SEQUENCE_SCROLL_CUE}</p>}
  <div ref={ref} className="diagram-canvas" data-testid="design-sequence-canvas"><svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Sequence diagram of your authored messages" style={{ minWidth: layout.minWidth, maxWidth: layout.maxWidth }}>{children}</svg></div>
 </>;
}
export function DiagramStudio({ design }: { design: DesignState }) {
 const [mode, setMode] = useState<'sequence' | 'class'>('sequence');
 const arrowId = useId().replace(/:/g, '');
 const source = design.doc.sequence ?? '';
 const parsed = parseSequence(source);
 const layout = sequenceLayout(parsed);
 const { height, box, participants, messages } = layout;
 return <section className="diagram-studio" aria-label="Diagram studio"><div className="flex items-center justify-between gap-3"><h2 className="h3">Diagram studio</h2><div className="mentor-mode-switch"><button type="button" aria-pressed={mode === 'sequence'} onClick={() => setMode('sequence')}>Sequence</button><button type="button" aria-pressed={mode === 'class'} onClick={() => setMode('class')}>Class / UML</button></div></div>
  {mode === 'class' ? <><p>The class diagram reflects your entities, their attributes and relations, and your operations above. Change the model to change this diagram; the saved design remains the source of truth.</p><ClassDiagram doc={design.doc} codePath={null} apiContract={design.contracts.api} testId="design-studio-class" /></> : <><p>Write a request path, one message per line. Use <code>Sender -&gt; Receiver: message</code> for a call and <code>Receiver --&gt; Sender: result</code> for a reply. Your source is saved in your design.</p><AssistantMark fields={design.assisted('design/sequence')} testId="design-sequence-touched" /><label htmlFor="sequence-source">Sequence source</label><textarea id="sequence-source" data-testid="design-sequence-source" spellCheck={false} value={source} disabled={design.busy} onChange={event => { const { sequence: _gone, ...rest } = design.doc; design.write({ ...rest, ...optional('sequence', event.target.value) }); }} placeholder={'Browser -> Route: request\nRoute -> Repository: query\nRepository --> Route: result\nRoute --> Browser: response'} />
  {parsed.errors.length > 0 ? <div role="alert">{parsed.errors.map(error => <p key={error}>{error}</p>)}</div> : parsed.messages.length === 0 ? <p>Your sequence will appear here as you describe its messages.</p> : <SequenceCanvas layout={layout}><defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker>{/* A reply (`-->`) ends in an open arrowhead as well as a dashed line. */}<marker id={`${arrowId}-reply`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="currentColor" strokeWidth={1.5} /></marker></defs>{participants.map(({ name, x }) => <g key={name}><rect x={x - box / 2} y={8} width={box} height={34} rx={7} fill="rgb(var(--c-surface))" stroke="rgb(var(--c-edge))" /><text x={x} y={29} textAnchor="middle" fontSize={12} fill="currentColor">{name}</text><line x1={x} x2={x} y1={43} y2={height - 12} stroke="rgb(var(--c-edge))" strokeDasharray="5 5" /></g>)}{messages.map((message, i) => <g key={i} data-reply={message.reply ? 'true' : undefined}><line x1={message.x1} x2={message.x2} y1={message.y} y2={message.y} stroke="rgb(var(--c-accent))" strokeWidth={1.5} strokeDasharray={message.reply ? '5 4' : undefined} markerEnd={`url(#${message.reply ? `${arrowId}-reply` : arrowId})`} /><text x={message.labelX} y={message.labelY} textAnchor="middle" fontSize={11} fill="currentColor" stroke="rgb(var(--c-ground))" strokeWidth={5} strokeLinejoin="round" paintOrder="stroke">{message.text}<title>{message.label}</title></text></g>)}</SequenceCanvas>}
  </>}
 </section>;
}
