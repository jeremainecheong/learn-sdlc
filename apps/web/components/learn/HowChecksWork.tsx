'use client';
import { useState } from 'react';
import { DIMENSION_LABEL, DIMENSION_ORDER, MISSING_WITH_QUOTE, type DimensionKey } from '@/components/workspace/mentor/ExplanationFindings';
import { Figure } from './figures/Figure';
import { StatusMark } from './figures/StatusMark';
import { StepThrough } from './figures/StepThrough';
import { ToggleSet } from './figures/ToggleSet';
import './figures/requirements-design.css';
import './HowChecksWork.css';

/* "How LearnSDLC checks your work": propose, explain, apply, told with the
 * Deployment incident drill (content/tasktrackr/phases/05-deployment). Fixed,
 * truthful words; no AI call. The four checks' names come from the room's own
 * ExplanationFindings; the headline words, the finding words and the refusal
 * sentence are the room's and the API's (test/how-checks-work.test.tsx
 * reads them from their source files). */

/** The drill's fault, as the phase brief states it. */
export const DRILL_FAULT =
  'The web service’s API_URL is http://localhost:8000, so inside the compose network the proxy dials its own container and every API call fails while the API itself is healthy.';
/** The room's headline over an explanation that has not been accepted, and over one that has. */
export const REVIEW_HEADLINE = 'Explanation review';
export const ACCEPTED_HEADLINE = 'Understanding accepted';
/** The room's finding words. */
export const FINDING_WORDS = { supported: 'Supported', missing: 'Not explained yet' } as const;
/** The API's refusal sentence for an explanation that does not say what the change does, and its question. */
export const EFFECTS_REFUSAL = 'Your explanation does not yet establish what the proposed change does.';
export const EFFECTS_QUESTION = 'What do the changed lines actually establish?';
/** The room's Apply button, and what the walk says beside it (the walk draws
 * it as a mark, not a control: nothing here applies anything). */
export const APPLY_LABEL = 'Apply this reviewed proposal';
export const APPLY_LOCKED = 'Apply stays locked until the explanation is accepted.';
export const APPLY_OPEN = 'In the room this applies the change.';

/** Three short explanations the review refuses. `quoted` names the checks
 * under which the review quoted the learner's sentence and still found it short. */
export const WEAK_EXPLANATIONS: readonly { value: string; label: string; quoted: readonly DimensionKey[] }[] = [
  { value: 'fixes', label: 'It fixes the bug.', quoted: [] },
  { value: 'asked', label: 'I asked the mentor.', quoted: [] },
  { value: 'changed', label: 'Changed the URL.', quoted: ['effects'] },
];

/** A proper explanation, one sentence per check, quoted back as the room quotes it. */
export const PROPER_EXPLANATION: Record<DimensionKey, string> = {
  effects: 'API_URL now names the api service instead of localhost.',
  constraints: 'So the web container sends /api requests to the API container rather than to itself, which is what the drill asks: the API was healthy, only the address was wrong.',
  verification: 'I have not run it yet: the selfcheck and a request through the web service would show it.',
  consistency: 'Only that one line in docker-compose.yml changes.',
};

function ConfigCard({ diff, applied }: { diff?: boolean; applied?: boolean }) {
  return (
    <div className="fig-card" data-tone={applied ? 'pass' : undefined}>
      <div className="fig-row">
        <span className="fig-label">docker-compose.yml, the web service</span>
        {diff && (applied ? <StatusMark status="passed" label="Applied" /> : <StatusMark status="not-run" label="Proposed, not applied" />)}
      </div>
      <pre className="fig-code"><code>
        {'web:\n  environment:\n'}
        {diff ? (
          <>
            {!applied && <span data-line="removed">{'-     API_URL: http://localhost:8000'}</span>}
            <span data-line={applied ? undefined : 'added'}>{applied ? '      API_URL: http://api:8000' : '+     API_URL: http://api:8000'}</span>
          </>
        ) : (
          <span data-line="removed">{'    API_URL: http://localhost:8000'}</span>
        )}
      </code></pre>
    </div>
  );
}

function ReviewCard({ explanation, accepted, quoted = [] }: { explanation: string; accepted: boolean; quoted?: readonly DimensionKey[] }) {
  return (
    <div className="fig-card" data-tone={accepted ? 'pass' : 'warn'}>
      <span className="fig-label">Your explanation</span>
      <p className="fig-card-quote">“{explanation}”</p>
      <strong className="how-checks-headline" data-testid="review-headline">{accepted ? ACCEPTED_HEADLINE : REVIEW_HEADLINE}</strong>
      {!accepted && (
        <p className="fig-card-reason">
          {EFFECTS_REFUSAL} {EFFECTS_QUESTION}
        </p>
      )}
      <ul className="fig-review" aria-label="The four checks">
        {DIMENSION_ORDER.map((key) => (
          <li key={key} data-dimension={key}>
            <div>
              <span>{DIMENSION_LABEL[key]}</span>
              {accepted ? (
                <StatusMark status="passed" label={FINDING_WORDS.supported} />
              ) : (
                <StatusMark status="not-run" label={quoted.includes(key) ? MISSING_WITH_QUOTE : FINDING_WORDS.missing} />
              )}
            </div>
            {accepted && <blockquote>{PROPER_EXPLANATION[key]}</blockquote>}
          </li>
        ))}
      </ul>
      {/* The room's Apply button, drawn as words with a lock or a tick, no
          outline: nothing here applies anything, so nothing looks
          pressable. */}
      <p className="fig-apply" data-testid="apply-mark" data-state={accepted ? 'open' : 'locked'}>
        <svg className="fig-apply-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          {accepted
            ? <path d="M3.5 8.5l3 3 6-7" />
            : <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>}
        </svg>
        <span className="fig-apply-words">
          <span className="fig-apply-label">{APPLY_LABEL}</span>: <span className="fig-apply-state">{accepted ? 'Open' : 'Locked'}</span>.
        </span>
        <span className="fig-card-reason">{accepted ? APPLY_OPEN : APPLY_LOCKED}</span>
      </p>
    </div>
  );
}

function WeakFrame() {
  const [which, setWhich] = useState<string>(WEAK_EXPLANATIONS[0].value);
  const weak = WEAK_EXPLANATIONS.find((w) => w.value === which) ?? WEAK_EXPLANATIONS[0];
  return (
    <div className="fig-split">
      <ReviewCard explanation={weak.label} accepted={false} quoted={weak.quoted} />
      <div>
        <span className="fig-label">Try a different weak explanation</span>
        <ToggleSet label="Weak explanation" options={WEAK_EXPLANATIONS} value={which} onChange={setWhich} />
      </div>
    </div>
  );
}

const PROPER_TEXT = DIMENSION_ORDER.map((key) => PROPER_EXPLANATION[key]).join(' ');

/** The steps, exported for the test. */
export const HOW_CHECKS_STEPS = [
  { title: 'The request', text: `The Deployment incident drill: ${DRILL_FAULT}` },
  { title: 'The mentor proposes', text: 'In Agentic mode the mentor can propose a change to files you may edit. Here it proposes the api service’s own name. Nothing is applied yet.' },
  { title: 'You explain it, weakly', text: 'Before you can apply a proposal, you explain it in your own words. A short claim with no reason is not accepted, and the proposal stays unapplied.' },
  { title: 'You explain it properly', text: 'Say what the change does, why it meets the request, what is and is not verified, and keep every claim true to the proposal. Each check quotes the sentence that meets it.' },
  { title: 'You apply it, and you own it', text: 'You apply the change yourself. Your run and the phase review judge the result, not the mentor.' },
] as const;

/** "How LearnSDLC checks your work": a five-step walk through propose,
 * explain, apply. Self-contained, no props; drawn on the Learn catalogue
 * inside `HowChecksWorkSlot`, which draws the section and its h2, so this
 * draws no heading of its own. */
export function HowChecksWork() {
  const contents = [
    <ConfigCard key="request" />,
    <ConfigCard key="proposal" diff />,
    <WeakFrame key="weak" />,
    <div key="proper" className="fig-split"><ReviewCard explanation={PROPER_TEXT} accepted /><ConfigCard diff /></div>,
    <ConfigCard key="applied" diff applied />,
  ];
  return (
    <div className="how-checks">
      <p>The mentor can propose. You explain. Only then can you apply. This is how every room treats an AI proposal.</p>
      <Figure
        title="Propose, explain, apply"
        howTo="Press Next, or use the arrow keys, to walk through one proposal."
        model="A teaching model with fixed words. Nothing here calls the mentor; in the rooms the review is live."
      >
        <StepThrough label="Propose, explain, apply" steps={HOW_CHECKS_STEPS.map((step, i) => ({ ...step, content: contents[i] }))} />
      </Figure>
    </div>
  );
}

export default HowChecksWork;
