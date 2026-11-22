import type { PhaseKey, QuizQuestion } from '@learnsdlc/shared';

/**
 * The concept-check bank.
 *
 * Six multiple-choice questions per phase on what the chapter teaches in
 * general (user stories, Given/When/Then, coupling, red-green-refactor, CI vs
 * CD, maintenance types, ...), never on one project's specifics. The same six
 * are asked before the learner starts the phase and again after they pass it,
 * shuffled each time, so the two scores can be compared.
 *
 * Every question has four options, exactly one keyed, and an explanation the
 * learner reads after handing in. `correct` is the sealed key and never leaves
 * the API, the same as for a pack quiz.
 *
 * Bump `CONCEPT_BANK_VERSION` whenever a question changes, so a paper in
 * `quiz_attempts.packVersion` names the bank it was asked from.
 */
export const CONCEPT_BANK_VERSION = 'concept-bank@1';

export interface ConceptPhaseBank {
  /** The chapter, as the teacher's learning-gain card names it. */
  title: string;
  questions: QuizQuestion[];
}

type Option = [id: 'a' | 'b' | 'c' | 'd', text: string];

const q = (id: string, stem: string, options: Option[], correct: Option[0], explanation: string, concept: string): QuizQuestion => ({
  id,
  stem,
  options: options.map(([optionId, text]) => ({ id: optionId, text })),
  correct: [correct],
  explanation,
  concept,
});

export const CONCEPT_BANK: Record<PhaseKey, ConceptPhaseBank> = {
  requirements: {
    title: 'Requirements',
    questions: [
      q(
        'req-story-form',
        'Which of these is written in the usual user story form?',
        [
          ['a', 'The system shall store loans in a database table.'],
          ['b', 'As a librarian, I want to see overdue loans, so that I can remind borrowers.'],
          ['c', 'Fix the bug where the overdue list is empty.'],
          ['d', 'Given a loan, when it is overdue, then show it in red.'],
        ],
        'b',
        'A user story names who wants something, what they want and why: "As a <role>, I want <goal>, so that <benefit>". The Given/When/Then line is an acceptance criterion, not a story.',
        'user story form',
      ),
      q(
        'req-gwt',
        'In a Given/When/Then acceptance criterion, what does the "Then" part describe?',
        [
          ['a', 'The starting state of the system before anything happens.'],
          ['b', 'The action the user or system takes.'],
          ['c', 'The observable outcome that must be true afterwards.'],
          ['d', 'The developer who will implement the story.'],
        ],
        'c',
        'Given sets up the context, When is the action or event, and Then is the expected, checkable outcome. A good Then can be turned straight into a test assertion.',
        'Given/When/Then',
      ),
      q(
        'req-epic-story-task',
        'How do an epic, a user story and a task (ticket) relate to each other?',
        [
          ['a', 'An epic is a large goal split into stories; a story is split into tasks the team works on.'],
          ['b', 'A task is the largest item and contains several epics.'],
          ['c', 'They are three names for the same thing on different tools.'],
          ['d', 'A story contains epics, and each epic is one line of code.'],
        ],
        'a',
        'An epic is a big piece of user value that is too large for one iteration. It is broken into user stories, each small enough to deliver, and a story is broken into technical tasks or tickets.',
        'epic vs story vs task',
      ),
      q(
        'req-invest',
        'The INVEST checklist says a good user story should be Independent, Negotiable, Valuable, Estimable, Small and ...',
        [
          ['a', 'Technical'],
          ['b', 'Typed'],
          ['c', 'Timeboxed'],
          ['d', 'Testable'],
        ],
        'd',
        'The T in INVEST is Testable: if nobody can say how to check that the story is done, it is not ready. Acceptance criteria are what make a story testable.',
        'INVEST',
      ),
      q(
        'req-ac-vs-dod',
        'What is the difference between acceptance criteria and the Definition of Done?',
        [
          ['a', 'They are the same list, written by different people.'],
          ['b', 'Acceptance criteria are specific to one story; the Definition of Done applies to every story the team finishes.'],
          ['c', 'The Definition of Done is written by the customer; acceptance criteria are written by testers only.'],
          ['d', 'Acceptance criteria are optional; the Definition of Done is only used at release time.'],
        ],
        'b',
        'Acceptance criteria describe what this particular story must do. The Definition of Done is the team-wide quality bar (tested, reviewed, merged, documented) that every story must meet.',
        'acceptance criteria vs definition of done',
      ),
      q(
        'req-nonfunctional',
        'Which of these is a non-functional requirement?',
        [
          ['a', 'A member can borrow up to five books.'],
          ['b', 'A librarian can mark a book as returned.'],
          ['c', 'The search page responds within 2 seconds for 95% of requests.'],
          ['d', 'An overdue loan is shown on the member\'s page.'],
        ],
        'c',
        'Functional requirements say what the system does. Non-functional requirements say how well it does it: performance, security, availability, usability and so on.',
        'functional vs non-functional',
      ),
    ],
  },
  design: {
    title: 'Design',
    questions: [
      q(
        'des-coupling-cohesion',
        'Which combination usually makes a design easiest to change?',
        [
          ['a', 'High coupling and low cohesion'],
          ['b', 'Low coupling and high cohesion'],
          ['c', 'High coupling and high cohesion'],
          ['d', 'Low coupling and low cohesion'],
        ],
        'b',
        'Low coupling means modules depend on each other as little as possible; high cohesion means each module does one focused job. Together they keep a change contained to one place.',
        'coupling and cohesion',
      ),
      q(
        'des-404-vs-400',
        'A client asks GET /api/books/999 and no book with id 999 exists. Which status code fits best?',
        [
          ['a', '400 Bad Request'],
          ['b', '500 Internal Server Error'],
          ['c', '200 OK with an empty body'],
          ['d', '404 Not Found'],
        ],
        'd',
        '404 means the request was well formed but the resource does not exist. 400 is for a malformed or invalid request, such as a missing required field. 500 means the server itself failed.',
        '400 vs 404',
      ),
      q(
        'des-adr',
        'An Architecture Decision Record (ADR) normally contains which parts?',
        [
          ['a', 'Context, the decision, and its consequences (including the alternatives considered).'],
          ['b', 'Only the final code that implements the decision.'],
          ['c', 'A list of every developer\'s opinion, with no conclusion.'],
          ['d', 'The project\'s budget and timeline.'],
        ],
        'a',
        'An ADR records why a decision was made: the context and forces, the decision itself, and the consequences or trade-offs. Future readers can then see the reasoning, not just the result.',
        'ADR parts',
      ),
      q(
        'des-composition',
        'In a UML class diagram, an Order owns its OrderLines, and the lines cannot exist without the order. Which relationship is this?',
        [
          ['a', 'Inheritance (generalisation)'],
          ['b', 'A plain association'],
          ['c', 'Composition'],
          ['d', 'A dependency'],
        ],
        'c',
        'Composition (a filled diamond) is a strong "whole owns part" relationship: delete the order and its lines go with it. A plain association just says two classes are related; aggregation is the weaker "has a" form.',
        'composition vs association',
      ),
      q(
        'des-multiplicity',
        'On a class diagram, the association Library 1 ---- * Book means:',
        [
          ['a', 'Each book belongs to many libraries.'],
          ['b', 'One library holds zero or more books, and each book belongs to one library.'],
          ['c', 'There is exactly one book in the system.'],
          ['d', 'A library must hold at least one hundred books.'],
        ],
        'b',
        'Multiplicity is read at the far end: one Library is linked to * (zero or more) Books, and each Book is linked to exactly 1 Library.',
        'multiplicity',
      ),
      q(
        'des-api-contract',
        'Why agree an API contract (endpoints, request and response shapes, error codes) during design?',
        [
          ['a', 'So the database can be skipped.'],
          ['b', 'Because the contract replaces the need for any tests.'],
          ['c', 'So it can be changed freely later without telling anyone.'],
          ['d', 'So the front end and back end can be built and tested independently against the same promise.'],
        ],
        'd',
        'A contract is a shared promise. Both sides can work in parallel, mock each other, and write tests against it; a change to it is a deliberate, visible decision.',
        'API contract',
      ),
    ],
  },
  implementation: {
    title: 'Implementation',
    questions: [
      q(
        'imp-red-green',
        'In test-driven development, what is the order of the red-green-refactor cycle?',
        [
          ['a', 'Write a failing test, make it pass with the simplest code, then clean the code up while the tests stay green.'],
          ['b', 'Write all the code, then write tests, then delete the tests that fail.'],
          ['c', 'Refactor first, then write tests, then write the code.'],
          ['d', 'Write passing tests only, so the build is never red.'],
        ],
        'a',
        'Red: a test that fails for the right reason. Green: the smallest change that passes it. Refactor: improve the design with the tests as a safety net.',
        'red-green-refactor',
      ),
      q(
        'imp-code-review',
        'What is the main purpose of a pull request code review?',
        [
          ['a', 'To find out who wrote the most lines this week.'],
          ['b', 'To slow the team down so fewer changes ship.'],
          ['c', 'To have another person check the change for bugs, clarity and fit before it is merged.'],
          ['d', 'To replace automated tests.'],
        ],
        'c',
        'Review catches defects and design problems early, spreads knowledge of the code across the team, and keeps the codebase consistent. It works alongside tests, not instead of them.',
        'code review purpose',
      ),
      q(
        'imp-commit-message',
        'Which commit message is most useful to a teammate reading the history later?',
        [
          ['a', 'stuff'],
          ['b', 'Return 404 when a book id does not exist'],
          ['c', 'fixed it'],
          ['d', 'WIP WIP WIP'],
        ],
        'b',
        'A good commit is small and focused, and its message says what changed and why in a short line. That makes the history searchable and a bad change easy to find and revert.',
        'commit messages',
      ),
      q(
        'imp-validation',
        'Where should a web API validate the data a client sends?',
        [
          ['a', 'Only in the browser, because the server can trust its own front end.'],
          ['b', 'Nowhere; the database will reject bad data.'],
          ['c', 'Only in the unit tests.'],
          ['d', 'On the server, even if the front end also checks it.'],
        ],
        'd',
        'Anyone can call an API directly, skipping the front end. Browser checks are for a pleasant user experience; server-side validation is what actually protects the system.',
        'server-side validation',
      ),
      q(
        'imp-refactor',
        'What does refactoring mean?',
        [
          ['a', 'Adding a new feature to existing code.'],
          ['b', 'Rewriting the whole project in a new language.'],
          ['c', 'Changing the structure of code without changing what it does.'],
          ['d', 'Deleting tests that are slow.'],
        ],
        'c',
        'Refactoring improves names, structure or duplication while keeping behaviour the same. Passing tests before and after are how you know the behaviour really did not change.',
        'refactoring',
      ),
      q(
        'imp-dry',
        'The same 15-line price calculation is pasted in four places. What is the main risk?',
        [
          ['a', 'A bug fixed in one copy stays in the other three.'],
          ['b', 'The program will not compile.'],
          ['c', 'The code will run four times slower.'],
          ['d', 'There is no risk; duplication is always fine.'],
        ],
        'a',
        'Duplicated logic has to be changed everywhere at once, and it is easy to miss a copy. Extracting one well-named function (Don\'t Repeat Yourself) gives the rule a single home.',
        'duplication (DRY)',
      ),
    ],
  },
  testing: {
    title: 'Testing',
    questions: [
      q(
        'tst-levels',
        'Which statement about unit, integration and end-to-end tests is right?',
        [
          ['a', 'End-to-end tests are the fastest, so most tests should be end-to-end.'],
          ['b', 'Unit tests check the whole system through the user interface.'],
          ['c', 'Unit tests check one small piece in isolation; integration tests check pieces working together; end-to-end tests drive the whole system like a user.'],
          ['d', 'Integration tests never touch more than one function.'],
        ],
        'c',
        'The test pyramid: many fast unit tests, fewer integration tests, and a small number of slower end-to-end tests that prove the full journey works.',
        'unit vs integration vs end-to-end',
      ),
      q(
        'tst-boundary',
        'A member may borrow at most 5 books. Which set of values is the best boundary test?',
        [
          ['a', '1, 2, 3'],
          ['b', '4, 5 and 6'],
          ['c', '100, 200, 300'],
          ['d', 'Only 5'],
        ],
        'b',
        'Bugs cluster at the edges of a rule. Testing just below, on, and just above the limit (4, 5, 6) catches off-by-one mistakes such as using < instead of <=.',
        'boundary values',
      ),
      q(
        'tst-regression',
        'What is a regression test for?',
        [
          ['a', 'Measuring how fast the code runs.'],
          ['b', 'Testing only code that has never been run before.'],
          ['c', 'Checking the user interface colours.'],
          ['d', 'Checking that something which used to work still works after a change.'],
        ],
        'd',
        'A regression is a bug that comes back or a feature that breaks after an unrelated change. Re-running the existing tests, and adding a test for every fixed bug, guards against it.',
        'regression tests',
      ),
      q(
        'tst-flaky',
        'A test passes and fails at random on the same code. What is the right response?',
        [
          ['a', 'Treat it as a real problem: find the cause (timing, shared state, order) and make it deterministic.'],
          ['b', 'Re-run the build until it goes green and move on.'],
          ['c', 'Delete every test in that file.'],
          ['d', 'Ignore it; random failures are normal.'],
        ],
        'a',
        'A flaky test teaches the team to ignore red builds, which hides real failures. The usual causes are timing, shared state, test order or the network, and each can be fixed.',
        'flaky tests',
      ),
      q(
        'tst-coverage',
        'A test suite has 100% line coverage. What can you safely conclude?',
        [
          ['a', 'The code has no bugs.'],
          ['b', 'Every requirement has been met.'],
          ['c', 'Every line ran at least once during the tests, but the tests may still miss wrong behaviour.'],
          ['d', 'No more tests will ever be needed.'],
        ],
        'c',
        'Coverage only says code was executed, not that its results were checked or that the right cases were tried. A line can run under a test with no meaningful assertion.',
        'what coverage means',
      ),
      q(
        'tst-aaa',
        'What does the Arrange-Act-Assert pattern describe?',
        [
          ['a', 'The order in which tests are run on the CI server.'],
          ['b', 'A clear test layout: set up the data, perform the action, then check the result.'],
          ['c', 'Three people who must approve every test.'],
          ['d', 'A way of naming test files.'],
        ],
        'b',
        'Arrange builds the starting state, Act calls the thing under test, and Assert checks the outcome. It is the code form of Given/When/Then.',
        'Arrange-Act-Assert',
      ),
    ],
  },
  deployment: {
    title: 'Deployment',
    questions: [
      q(
        'dep-ci-cd',
        'What is the difference between Continuous Integration (CI) and Continuous Delivery/Deployment (CD)?',
        [
          ['a', 'CI is for front-end code; CD is for back-end code.'],
          ['b', 'CI deploys to production; CD only compiles the code.'],
          ['c', 'They are the same thing.'],
          ['d', 'CI merges and automatically builds and tests every change; CD automatically gets passing builds ready to release, or releases them.'],
        ],
        'd',
        'CI keeps the main branch healthy by building and testing every change. CD carries a passing build on through the release pipeline, so shipping is routine instead of a big event.',
        'CI vs CD',
      ),
      q(
        'dep-staging',
        'Why deploy to a staging environment before production?',
        [
          ['a', 'To test the release in a production-like setting without affecting real users.'],
          ['b', 'Because production cannot run the same code as staging.'],
          ['c', 'So that developers can skip writing tests.'],
          ['d', 'Staging is where real customers do their work.'],
        ],
        'a',
        'Staging mirrors production (configuration, data shape, infrastructure) so problems show up there first. Production is where real users are.',
        'staging vs production',
      ),
      q(
        'dep-rollback',
        'A new release causes errors for users. What is a rollback?',
        [
          ['a', 'Deleting the source code repository.'],
          ['b', 'Fixing the bug directly on the production server by hand.'],
          ['c', 'Returning production to the last known good version quickly, then fixing the problem.'],
          ['d', 'Asking users to clear their browser cache.'],
        ],
        'c',
        'Rolling back restores service fast and buys time to find the root cause calmly. A release process should always know what the previous good version is and how to return to it.',
        'rollback',
      ),
      q(
        'dep-secrets',
        'Where should a database password for production live?',
        [
          ['a', 'Hard-coded in the source code, so it never gets lost.'],
          ['b', 'In an environment variable or secrets manager, outside the code repository.'],
          ['c', 'In the README so the whole team can find it.'],
          ['d', 'In a comment at the top of the main file.'],
        ],
        'b',
        'Anything committed to a repository is copied to every clone and stays in its history. Secrets belong in the environment or a secrets manager and are injected at run time.',
        'secrets in environment, not code',
      ),
      q(
        'dep-smoke',
        'What does a health check or smoke test after a deployment do?',
        [
          ['a', 'Runs the full test suite for several hours.'],
          ['b', 'Measures the temperature of the servers.'],
          ['c', 'Checks the code style of the new release.'],
          ['d', 'Quickly confirms the deployed app is up and its key paths respond.'],
        ],
        'd',
        'A smoke test is a short, shallow check, such as "does /health return 200 and does the home page load?", that tells you straight away whether the release is alive.',
        'health and smoke checks',
      ),
      q(
        'dep-semver',
        'With semantic versioning (MAJOR.MINOR.PATCH), a release only fixes a bug and changes no public behaviour. Version 2.4.1 becomes:',
        [
          ['a', '2.4.2'],
          ['b', '3.0.0'],
          ['c', '2.5.0'],
          ['d', '2.4.1-final'],
        ],
        'a',
        'PATCH is for backwards-compatible bug fixes, MINOR for backwards-compatible new features, and MAJOR for breaking changes.',
        'semantic versioning',
      ),
    ],
  },
  maintenance: {
    title: 'Maintenance',
    questions: [
      q(
        'mnt-types',
        'Changing the app because a payment provider retired its old API is which kind of maintenance?',
        [
          ['a', 'Corrective'],
          ['b', 'Perfective'],
          ['c', 'Adaptive'],
          ['d', 'Preventive'],
        ],
        'c',
        'Corrective fixes bugs, adaptive keeps the software working in a changed environment, perfective improves or adds features, and preventive reduces future problems (for example refactoring or upgrading).',
        'maintenance types',
      ),
      q(
        'mnt-repro',
        'What makes a bug report most useful to the developer who picks it up?',
        [
          ['a', 'The word "urgent" in capital letters.'],
          ['b', 'Clear steps to reproduce, the expected result and the actual result.'],
          ['c', 'A guess at which developer caused it.'],
          ['d', 'A screenshot with no description.'],
        ],
        'b',
        'If the developer can reproduce the bug, they can find it, fix it and write a test that proves it is gone. Expected versus actual says exactly what "wrong" means.',
        'reproduction steps',
      ),
      q(
        'mnt-root-cause',
        'What is root cause analysis after an incident for?',
        [
          ['a', 'Finding the underlying reason the problem happened, so it can be prevented, not just patched.'],
          ['b', 'Finding the person to blame.'],
          ['c', 'Restarting the server until the problem goes away.'],
          ['d', 'Writing the incident up as quickly as possible and closing it.'],
        ],
        'a',
        'Fixing only the symptom lets the same failure return. Asking "why?" repeatedly leads to the real cause and to an action item that stops it recurring. Good post-mortems are blameless.',
        'root cause',
      ),
      q(
        'mnt-tech-debt',
        'What is technical debt?',
        [
          ['a', 'Money the team owes for cloud hosting.'],
          ['b', 'The number of open bug reports.'],
          ['c', 'Code that has been deleted.'],
          ['d', 'The future cost of shortcuts taken now, paid back as slower, riskier changes later.'],
        ],
        'd',
        'Like a loan, a shortcut can be worth taking, but it collects "interest": every later change in that area is harder. Teams pay it down deliberately by refactoring.',
        'technical debt',
      ),
      q(
        'mnt-test-first-fix',
        'You are fixing a reported bug. What should you do before changing the code?',
        [
          ['a', 'Delete the tests around that code so they do not get in the way.'],
          ['b', 'Change several unrelated things at once to save time.'],
          ['c', 'Write a test that fails because of the bug, so you can prove the fix and stop it coming back.'],
          ['d', 'Nothing; just ship the change.'],
        ],
        'c',
        'A failing test pins down the bug precisely. Once the fix makes it pass, the same test stays in the suite as a regression guard.',
        'test before fixing',
      ),
      q(
        'mnt-small-changes',
        'Why are small, focused changes safer when maintaining a live system?',
        [
          ['a', 'They are easier to review, test and roll back, and a failure points to a smaller cause.'],
          ['b', 'Small changes never contain bugs.'],
          ['c', 'They avoid the need for version control.'],
          ['d', 'Large changes are not allowed by Git.'],
        ],
        'a',
        'A small change has a small blast radius: reviewers can understand it, tests target it, and if it goes wrong it is quick to find and revert.',
        'small changes',
      ),
    ],
  },
};
