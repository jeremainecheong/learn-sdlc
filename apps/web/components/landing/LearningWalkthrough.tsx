'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, BookOpen, CircleCheck, MessageCircle } from 'lucide-react';
import './public-learning.css';

const steps = [
  { label: 'Understand the brief', title: 'What does the user need?', introduction: 'Start with the people using the software and the problem they need it to solve.', quote: '“I want to pick up where I left off.”', example: 'A user needs to save unfinished work and return to it later. What should be saved, and what should happen when they come back?', conclusion: 'Your job is to turn an open question into something the team can build.' },
  { label: 'Create your artefact', title: 'Make the need concrete.', introduction: 'Write a user story and define what it means for the behaviour to work.', quote: 'As a user, I want to save a draft so I can finish it later.', example: 'When I reopen my draft, the title and description I saved are restored.', conclusion: 'A useful requirement gives both the developer and the tester something specific to work with.' },
  { label: 'Check and improve', title: 'Find what you’ve missed.', introduction: 'Use checks and review feedback to question your first attempt.', conclusion: 'Revise the acceptance criteria to cover the failure case as well as the successful one.' },
  { label: 'Reflect and progress', title: 'Carry the insight forward.', introduction: 'Explain what changed and why it matters before moving to the next phase.', quote: '“I only described the happy path.”', example: 'Adding the save failure case changed the requirement. It will also shape the interface, error handling, and tests.', conclusion: 'That connection is the point: one decision becomes part of the whole lifecycle.' },
] as const;

/** An explorable teaching example; it makes no request and awards no verdict. */
export function LearningWalkthrough() {
  const [step, setStep] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? steps.length - 1
      : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (step + 1) % steps.length
        : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (step + steps.length - 1) % steps.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setStep(next);
    tabs.current[next]?.focus();
  }
  return <section className="lh-walkthrough lh-frost" aria-label="Explore the learning experience">
    <div>
      <div className="lh-kicker">Inside a learning phase</div>
      <h2 className="lh-walkthrough-title">Follow a decision from idea to insight.</h2>
      <div className="lh-step-tabs" role="tablist" aria-label="Learning steps">
        {steps.map((item, index) => <button key={item.label} ref={node => { tabs.current[index] = node; }} type="button" id={`lh-step-${index}`} className="lh-step-tab" role="tab" aria-selected={step === index} aria-controls={`lh-example-${index}`} tabIndex={step === index ? 0 : -1} onClick={() => setStep(index)} onKeyDown={navigate}>
          <span>{String(index + 1).padStart(2, '0')}</span>{item.label}<ArrowRight aria-hidden="true" />
        </button>)}
      </div>
    </div>
    <div className="lh-step-panel">
      <div className="lh-step-panel-head"><span>A closer look at Requirements</span><span><BookOpen aria-hidden="true" /> Learning in practice</span></div>
      <div className="lh-examples">
        {steps.map((item, index) => <div key={item.label} className="lh-example" id={`lh-example-${index}`} role="tabpanel" aria-labelledby={`lh-step-${index}`} aria-hidden={step !== index} tabIndex={step === index ? 0 : -1}>
          <div className="lh-example-label">{item.label}</div><h2>{item.title}</h2><p>{item.introduction}</p>
          <div className="lh-brief">{'quote' in item ? <><strong>{item.quote}</strong><p>{item.example}</p></> : <>
            <div className="lh-check"><CircleCheck aria-hidden="true" /><span>The story identifies a user need and an observable result.</span></div>
            <div className="lh-check attention"><MessageCircle aria-hidden="true" /><span>What should the user see if their draft cannot be saved?</span></div>
          </>}</div>
          <p>{item.conclusion}</p>
        </div>)}
      </div>
      <div className="lh-example-foot"><span aria-live="polite">{String(step + 1).padStart(2, '0')} / 04</span><button type="button" onClick={() => setStep(current => (current + 1) % steps.length)}>{step === steps.length - 1 ? 'Start again' : 'Next step'}<ArrowRight aria-hidden="true" /></button></div>
    </div>
  </section>;
}
