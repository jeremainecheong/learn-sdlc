import Link from 'next/link';
import { ArrowRight, BookOpen, CircleHelp, ClipboardCheck, MessagesSquare, Play, Route } from 'lucide-react';
import './QuickStartGuide.css';

const steps = [
  { icon: MessagesSquare, title: 'Start with Requirements.', text: 'Open your project from the dashboard. Read the brief, interview the product owner, then turn what you learn into a user story and acceptance criteria.' },
  { icon: Route, title: 'Make one useful change.', text: 'Each phase has its own working tools. Follow its short tutorial, choose a task, and check the save status after editing. Hide the brief or mentor whenever you need more room.' },
  { icon: Play, title: 'Check what actually happened.', text: 'Use the checks or preview available in your phase. Read the output and inspect failures. A successful run gives you evidence; it does not pass the phase.' },
  { icon: ClipboardCheck, title: 'Submit. Revise. Move forward.', text: 'Submit saved work for review. Needs revision tells you what to improve; submit again when you are ready. A verified Pass opens the next phase, or your teacher’s countersignature does where a task asks for one, and earlier reviews stay in your history.' },
] as const;

export function QuickStartGuide() {
  return <section className="lh-start-guide" id="start-guide" aria-labelledby="start-guide-title">
    <header className="lh-start-heading"><div><span className="lh-kicker">Your first session</span><h2 id="start-guide-title">Know where to begin.</h2></div><p>You can learn independently or join a class. Either way, your project starts at Requirements.</p></header>
    <ol className="lh-start-steps">
      {steps.map(({ icon: Icon, title, text }, index) => <li className="lh-frost" key={title}><div className="lh-start-step-label"><span>0{index + 1}</span><Icon size={23} aria-hidden="true" /></div><h3>{title}</h3><p>{text}</p></li>)}
    </ol>
    <div className="lh-start-help lh-frost">
      <div><CircleHelp size={21} aria-hidden="true" /><h3>A little help, whenever you need it.</h3><p>Each phase has a skippable tutorial you can replay. Use Guided mode for hints, or discuss a proposal in Agentic mode. You must explain the proposed change correctly before choosing Apply.</p></div>
      <div><BookOpen size={21} aria-hidden="true" /><h3>Lessons are optional.</h3><p>Open Learn for structured guides, worked examples and exercises. Reading a lesson does not submit your project or change its phase status.</p></div>
    </div>
    <nav className="lh-start-links" aria-label="Choose your walkthrough">
      <a href="#phase-videos">Find your phase walkthrough <ArrowRight size={16} aria-hidden="true" /></a>
      <a href="#agentic-demo">See how Agentic mode works <ArrowRight size={16} aria-hidden="true" /></a>
      <Link href="/register">Create your account <ArrowRight size={16} aria-hidden="true" /></Link>
    </nav>
  </section>;
}
