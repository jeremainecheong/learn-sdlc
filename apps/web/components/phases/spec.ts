import type { PhaseKey } from '@learnsdlc/shared';
import type { ThumbKind } from '@/components/shell';

/**
 * What each phase asks for, in the product's own words.
 *
 * Two things on the phases page are not in the API and never will be: the one
 * line saying what the phase is for before its brief has been loaded, and the
 * artefacts the platform *draws* for the learner (the ledger, the call graph,
 * the kill matrix). They are made from the learner's own work rather than
 * written by them, so they have no file to read a state from; they take the
 * phase's state instead. Everything else on that page comes from the API.
 */
export interface DrawnDeliverable {
  /** The name the product gives it. */
  title: string;
  /** One line: what it is drawn from. */
  detail: string;
  /** Which of the 24 thumbnails stands for it. */
  thumb: ThumbKind;
}

export interface PhaseSpec {
  /** Under the title on the phase card: what this phase is for. */
  purpose: string;
  /**
   * The brief's "What this stage is": two short paragraphs for a
   * second-year student who has written code but never shipped it. The first
   * says what this stage is in the software life cycle and why it matters;
   * the second says how what is made here feeds the next phase. The pack's
   * own intro, objectives and task panel stay the source for "what to do".
   */
  about: string[];
  /** Artefacts the platform draws from the learner's work. */
  drawn: DrawnDeliverable[];
}

export const PHASE_SPEC: Record<PhaseKey, PhaseSpec> = {
  requirements: {
    purpose:
      'Write the story and the criteria the rest of the project is measured against. The product owner reads them and asks whether each one can be run.',
    about: [
      'Requirements is where a piece of software is first written down in words, before any code. A story says who wants something and why; its acceptance criteria say how you would check it is done. Every later phase is measured against these sentences, so a vague one costs more here than anywhere else.',
      'The story you write becomes the brief for Design, where the model, the API and the screen are drawn to satisfy exactly what your criteria ask for. If a criterion cannot be run as a test, phase 4 has nothing to prove and phase 3 has nothing to aim at.',
    ],
    drawn: [
      { title: 'Backlog board', detail: 'The given stories, and the one you write', thumb: 'story-map' },
      { title: 'Criteria to test map', detail: 'Which hidden test proves each criterion', thumb: 'coverage-map' },
    ],
  },
  design: {
    purpose:
      'Decide the model, the contracts and one trade-off, and say what each decision gave up. The architect reads them; the contracts are what phase 3 checks the code against.',
    about: [
      'Design is where the decisions that are expensive to change get made on paper first: what the data looks like, what the API promises, what the screen shows. A contract is a promise between two sides of the system, written so that each side can be built without watching the other.',
      'The contracts you write here are what the code in Implementation is checked against, line by line, and what the tests in Testing prove from both sides. Change a field name after this and three phases feel it, which is why the architect asks what each decision gave up.',
    ],
    drawn: [
      { title: 'Class and component diagrams', detail: 'From your model and the imports', thumb: 'class-diagram' },
    ],
  },
  implementation: {
    purpose:
      'Make the code true to the contracts you wrote in Design. The hidden suite and the analyzer supply execution evidence; the senior engineer reviews the pull request.',
    about: [
      'Implementation is where the design becomes running code. Most of the application already exists; your job is to make the marked gaps true to the contracts you wrote, then run the app and watch it work. This is the phase that looks most like the coding you already know, and the phase where being faithful to a contract matters more than being clever.',
      'Your pull request is what the senior engineer reads and what the hidden tests check. The code you ship here is the code Testing writes acceptance suites against and Maintenance changes later, so a shortcut now is a bug you meet twice.',
    ],
    drawn: [
      { title: 'Conformance ledger', detail: 'Your code against your own contracts', thumb: 'ledger' },
      { title: 'Call graph with coverage', detail: 'From your code and the runs', thumb: 'call-graph' },
    ],
  },
  testing: {
    purpose:
      'Write one test per criterion and see it fail before it passes. Variants with planted bugs wait in the code; the QA lead asks which ones your tests catch.',
    about: [
      'Testing is where you prove the software does what the story said, rather than hoping it does. An acceptance test turns one criterion into a check that runs on its own. A test that passes on a broken copy of the program has proved nothing, so this phase also asks how sharp your assertions are.',
      'The suite you write here is the safety net Deployment ships behind and Maintenance leans on when it changes the code. The kill matrix shows which planted bugs your tests catch; the ones that survive are the gaps the next two phases inherit.',
    ],
    drawn: [
      { title: 'Kill matrix', detail: 'Your tests against the planted bugs', thumb: 'kill-matrix' },
      { title: 'Criteria coverage map', detail: 'Criteria with no test are orphans', thumb: 'coverage-map' },
    ],
  },
  deployment: {
    purpose:
      'Ship it: an image that runs through its own entrypoint, a health check that fails when it should, and a runbook someone else could follow.',
    about: [
      "Deployment is where a program that works on your machine becomes a service that works on somebody else's, at three in the morning, with you asleep. An image, a compose file and a pipeline say how to build and start it; a runbook says what to do when it stops. Most software fails here for reasons that have nothing to do with the code.",
      'The pipeline you finish here is what runs every change Maintenance makes, and the runbook is what an operator reads during the incident drill. A health check that cannot fail hides the outage it was meant to catch.',
    ],
    drawn: [
      { title: 'Incident timeline', detail: 'Drawn from the drill you are paged into', thumb: 'incident' },
      { title: 'Pipeline diagram', detail: 'From ci.yml, each step run', thumb: 'pipeline' },
    ],
  },
  maintenance: {
    purpose:
      'Take a change request into code the tests already guard. The maintainer asks for the new contract, the old tests still green, and a release record that says why.',
    about: [
      "Maintenance is where most of a program's life is spent: a change request arrives on a system that already works and has users who expect it to keep working. Shipping the change is half the job; proving nothing else broke is the other half, and the tests from Testing are how you prove it.",
      'This is the last phase, so what it feeds is the record. The contract you publish, the release entry you write and the tests you keep green are what the next person to change this system starts from, and a project that ends readable is a project that was engineered.',
    ],
    drawn: [
      { title: 'Change impact, before and after', detail: 'Graph diff of CR-1', thumb: 'graph-diff' },
      { title: 'Release record', detail: 'What changed and why', thumb: 'release' },
    ],
  },
};
