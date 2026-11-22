import type { Metadata } from 'next';
import { PublicLayout } from '@/components/landing/PublicLayout';

export const metadata: Metadata = { title: 'What you’ll learn', description: 'Explore six connected software development phases and the evidence you will create in your project.' };

const phases = [
  { key: 'requirements', name: 'Requirements', purpose: 'Define the problem', description: 'Turn stakeholder needs into clear, testable expectations. Learn to ask useful questions before committing to a solution.', artefacts: ['User stories', 'Acceptance criteria'] },
  { key: 'design', name: 'Design', purpose: 'Shape the solution', description: 'Connect the data, interface, and API. Make your choices visible and explain the tradeoffs behind the structure.', artefacts: ['API contracts', 'Data models', 'Design decisions'] },
  { key: 'implementation', name: 'Implementation', purpose: 'Bring it to life', description: 'Translate the design into working behaviour. Complete the code, inspect what happens, and use checks to guide your next change.', artefacts: ['Working code', 'Check results'] },
  { key: 'testing', name: 'Testing', purpose: 'Challenge the result', description: 'Write tests that uncover mistakes and cover edge cases. Learn to judge the evidence behind a passing test.', artefacts: ['Test suites', 'Test evidence'] },
  { key: 'deployment', name: 'Deployment', purpose: 'Prepare for release', description: 'Think beyond your own machine. Prepare a release, work through an incident, and plan how to recognise and recover from trouble.', artefacts: ['Configuration', 'Runbooks', 'Incident responses'] },
  { key: 'maintenance', name: 'Maintenance', purpose: 'Make the next change', description: 'Trace the impact of a change request. Improve the software while protecting existing behaviour and keeping documentation in step.', artefacts: ['Change plans', 'Regression tests', 'Changelogs'] },
] as const;

export default function WhatYouLearnPage() {
  return <PublicLayout active="learn">
    <div data-page-view="learn">
      <section className="lh-page-intro" aria-labelledby="lh-learn-title"><div className="lh-eyebrow">What you’ll learn</div><h1 id="lh-learn-title">See the whole lifecycle.<br /><span>Build your part in it.</span></h1><p>LearnSDLC has six phases, connected by one guided project; a project holds the ones its teacher chose. Each one introduces a different kind of decision and something concrete to create.</p></section>
      <section className="lh-curriculum" aria-label="The six learning phases">
        {phases.map((phase, index) => <article className="lh-course lh-frost" id={`lh-course-${phase.key}`} key={phase.key}>
          <div><div className="lh-kicker">{String(index + 1).padStart(2, '0')} / {phase.purpose}</div><h2>{phase.name}</h2><p>{phase.description}</p></div>
          <span className={`lh-object lh-object-${index}`} aria-hidden="true" />
          <div className="lh-course-artefacts">{phase.artefacts.map(artefact => <span key={artefact}>{artefact}</span>)}</div>
        </article>)}
      </section>
    </div>
  </PublicLayout>;
}
