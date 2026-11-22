import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PublicLayout } from '@/components/landing/PublicLayout';
import { LearningWalkthrough } from '@/components/landing/LearningWalkthrough';
import { RecordedWalkthroughs } from '@/components/landing/RecordedWalkthroughs';
import { REVIEWED_WALKTHROUGHS } from '@/components/landing/reviewed-recordings';
import { RecordedClip } from '@/components/landing/RecordedClip';
import { QuickStartGuide } from '@/components/landing/QuickStartGuide';

export const metadata: Metadata = { title: 'How it works', description: 'Understand the brief, create your artefact, use feedback, and carry your learning into the next phase.' };

const methods = [
  ['A project that grows with you.', 'Work through connected phases in the same project. Your requirements inform your design, your design guides the code, and your tests challenge what you built.'],
  ['Feedback you can act on.', 'Run checks, inspect the results, and work through review feedback. You get a chance to revisit your choices and improve your work before moving on.'],
  ['Work you can explain.', 'Build a record of artefacts and reflections. Learn to describe the tradeoffs behind your decisions, alongside the code and documents they produced.'],
] as const;

export default function HowItWorksPage() {
  return <PublicLayout active="how">
    <div data-page-view="how">
      <section className="lh-page-intro" aria-labelledby="lh-how-title"><div className="lh-eyebrow">How it works</div><h1 id="lh-how-title">Make something.<br /><span>Make sense of it.</span></h1><p>Every phase follows a practical rhythm: understand the problem, do the work, use the feedback, and reflect. Here’s what that looks like.</p></section>
      <QuickStartGuide />
      <div id="demo" className="lh-recording-section">
        <section className="lh-recorded-walkthroughs" aria-labelledby="course-highlight-title">
          <header className="lh-recordings-heading"><div><span className="lh-kicker">A recorded course journey</span><h2 id="course-highlight-title">One project, from brief to completion.</h2></div><p>An 82-second look at the work, feedback and revisions across the six phases of the reference project.</p></header>
          <div className="lh-recordings-glass lh-frost">
            <RecordedClip title="Use feedback. Revise. Carry the work forward."
              label="Six-phase recorded course highlight" src="/walkthroughs/course-highlight.mp4" poster="/walkthroughs/course-highlight.webp" captions="/walkthroughs/course-highlight.vtt"
              kicker="Real recorded reviews in 1 min 22 sec"
              description="Edited excerpts from a recorded QA course with prepared inputs. Needs revision and Pass are the original outcomes. Private conversations and complete solutions are outside the frame. Holds and faster playback are labelled. Footage was recorded on 14 September 2026 (UTC)."
              boundary="The Deployment excerpt shows an isolated configuration selfcheck and incident drill. It does not demonstrate Docker builds, CI execution, Compose startup or live HTTP health probes." />
          </div>
        </section>
        <section id="agentic-demo" className="lh-recorded-walkthroughs" aria-labelledby="agentic-recording-title">
          <header className="lh-recordings-heading"><div><span className="lh-kicker">A real mentor conversation</span><h2 id="agentic-recording-title">Explain it. Then apply it.</h2></div><p>See why agreement alone does not unlock an agent’s changes.</p></header>
          <div className="lh-recordings-glass lh-frost">
            <RecordedClip title="Your understanding comes before Apply."
              label="Recorded agentic mentor explanation and Apply flow" src="/walkthroughs/agentic-approval.mp4" poster="/walkthroughs/agentic-approval.webp" captions="/walkthroughs/agentic-approval.vtt"
              kicker="Real AI replies in 30 seconds"
              description="A prepared QA documentation change: a vague explanation is rejected, a precise explanation is accepted, and the learner explicitly applies the unchanged proposal. These are recorded interactions with the configured AI. Reading pauses are labelled."
              boundary="This clip shows a Maintenance mentor conversation and one saved documentation change. It does not show execution, grading or a phase Pass." />
          </div>
        </section>
        <div id="phase-videos"><RecordedWalkthroughs recordings={REVIEWED_WALKTHROUGHS} /></div>
      </div>
      <LearningWalkthrough />
      <section className="lh-methods" aria-label="What shapes the learning experience">
        {methods.map(([title, text], index) => <article className="lh-method" key={title}><span>{String(index + 1).padStart(2, '0')}</span><h2>{title}</h2><p>{text}</p></article>)}
      </section>
      <div className="lh-content"><Link className="lh-text-link" href="/what-you-learn">See what you’ll create in each phase <ArrowRight aria-hidden="true" /></Link></div>
    </div>
  </PublicLayout>;
}
