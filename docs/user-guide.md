# LearnSDLC user guide

## For learners

1. **Register** at `/register` and start the project. TaskTrackr is one web
   application (a Python API over SQLite and a TypeScript React front end)
   and it carries you through six phases: Requirements, Design,
   Implementation, Testing, Deployment and Maintenance. Only Requirements is
   unlocked; each later phase opens when the one before it passes its gate.
   Registration sends a confirmation email; a small banner on the dashboard
   asks until you open the link (nothing is locked behind it).
   **Join a class:** your instructor gives you an 8-character code; enter it
   at `/join` and your progress appears on their console. **Forgot your
   password?** The sign-in page emails a one-hour reset link.
2. **Work in the phase's room.** Every way into a phase opens its room in one
   step: the story desk in Requirements, where you write your story in a form;
   the Design room, with its UML model, API contract, Screens, Sequence
   diagram, Decisions and Review tabs; the editor in Implementation, Testing
   and Deployment, where Deployment's runbook has a Runbook tab of its own; and
   the change room in Maintenance, with the ticket in its Request tab. What the
   phase is in the life cycle, what you will produce, what to do in order, and
   how it is judged are in the room's brief, and the full brief stays one link
   away under the room's **More**.
   The editor has three columns:
   - **Left: the files.** The phase's whole tree; locked files (🔒) are
     context, editable ones are your artefact. Everything autosaves. Under the
     tree, **Your changes** lists the files you have edited and where the last
     submission stands. Jump to (⌘K) is in the top bar.
   - **Middle: the editor.** The file you are changing, with the problems the
     grader has already named drawn on the lines they are about.
   - **Right: the review column.** The brief, the criteria, the reviewer for
     this phase and, on a phase that ships an application, Preview.
   On a narrow screen the three do not fit, so one row of buttons above them
   chooses which is showing.
3. **Use the mentor like a senior colleague.** Ask it to critique, explain an
   error, or surface edge cases. It will not do the work: solution requests
   get a refusal plus a hint phrased as a question (asking again never digs
   deeper), questions for later phases are redirected, and long code in
   replies is withheld. Above the box, the column says what you have asked in
   this room and what the next question costs: the first ten in a phase cost
   nothing, then each takes three marks off the process criterion, thirty at
   most, and only on the two phases that carry a process criterion
   (Implementation and Maintenance). Every question counts, including the ones
   the reviewer will not answer. If the AI service is not available, the
   mentor says so and your work stays saved; nothing else answers in its
   place.
4. **Ask why a test fails.** Beside a test that did not pass there is
   **Explain this failure**. It asks the reviewer, in the thread you already
   have, what the test checks and where your code stopped. It is a question
   like any other: it is counted and it is on the record. Ask twice and the
   button reads **Read the explanation** and costs nothing: it takes you back
   to the answer. The reviewer never sees the hidden suite's source, so it
   cannot quote it.
5. **Read the code health under the editor.** On the code phases, the
   analyser's findings are drawn on your code as underlines and read under it
   in the **Health** tab. Press a finding and the caret lands on the line. It
   comes from your last graded submission, so it goes quiet the moment you
   edit and says why.
6. **Run early.** The phases with a Run button have a fast feedback loop:
   the visible tests, in both languages where the phase has both. The
   rubric's process criterion notices whether you ran before submitting.
7. **Run the app itself.** In Implementation, Testing and Maintenance there
   is a **Run app** button (⌘⇧A). It builds your front end, starts your API on
   its own and opens your application inside the Preview tab, with a Console
   pane carrying whatever it printed. It is your code and your database, not a
   recording: a gap you have not written yet fails there the way it will fail
   anywhere. Nothing about it is marked. It stops itself after ten minutes, or
   after five with nothing happening, and Stop ends it at once; the panel says
   how long is left when it is under two minutes.
8. **Submit.** In Requirements and Design the button says **Submit for
   review**; from Implementation on it says **Submit PR-n**, because from
   there every submission opens or updates a pull request. The engine reports
   a rubric breakdown, pass and fail checks with details, an AI review of your
   work and your process, and your AI-reliance index. The gate opens at
   **70/100**. One submission is graded at a time: pressing Submit again
   while one is running returns that same submission rather than queueing
   another.
9. **Reflect, then advance.** A short written reflection is part of the gate:
   what did the feedback change about how you would do it again? It is the
   message on the merge, and it becomes the tag in your repository.
10. **Read the reference, once the gate is in.** A phase that has passed
    offers **Read the reference solution**. It shows the pack's own answer
    beside your merged files, file by file. There is no locked door before the
    gate: a visible one is an invitation to look for the key. Opening it is on
    the record, so your instructor can see who has read it.
11. **Take the project with you.** `/artefacts` and the completion page offer
    the whole project as a real git repository: one commit per submission in
    your own name with the message you wrote, and a tag at every gate carrying
    your merge message. Unzip it and `git log` reads your term back to you.
12. **Finish.** After Maintenance passes you get the completion summary, and
    the dashboard shows your scores per phase.

The code scaffolds explain what each gap needs inside comments (`#` and `//`
comments and docstrings). The graders strip those before checking, so only what
you write counts: an untouched template scores nothing.

### Phase-by-phase expectations

| Phase | You produce | The graders look for |
|---|---|---|
| Requirements | User story US-4, the overdue report, written in the story desk's form: As a / I want / So that, Given / When / Then acceptance criteria, exclusions and open questions | A story in the standard form, criteria that can be tested, the due-today boundary, no vague wording |
| Design | The data model in the UML model tab, the operations of the API contract, the screens, the sequence diagram and the decisions | Every entity and field the stories force, each operation naming the story it satisfies with what it returns and what goes wrong, and decisions that give their reasons |
| Implementation | Five marked gaps: `list_tasks` and `overdue_tasks` in the API's repository, `complete_task` in its routes, `isOverdue` and `useTasks` in the front end | Visible and hidden tests in both languages, clean static analysis, running before submitting |
| Testing | Two acceptance suites, `tests/test_acceptance.py` for the API and `web/src/acceptance.test.tsx` for the front end | They pass on the reference implementation and fail on copies of it with a bug planted in each, with real tests for completing, filtering and ordering, the overdue report and the late marker |
| Deployment | The API's Dockerfile, the Compose file, the CI workflow, and the runbook in the Runbook tab | The required instructions present; the container starts **through your own `ENTRYPOINT`** and runs the deployment's self-check, which reads your Compose file; every runbook section filled with a real command or sentence; the incident drill worked through |
| Maintenance | Change request CR-2: comments on a task, a comment count on each row, the two contracts that travel with the change, and the change request written in the change room | The change's own tests pass **and** the full regression suite still passes; the change stays small |

### Words used here

Some pages mark one of these words with a dotted underline where it first
appears; hover over or focus the word to read the same meaning. The list lives
in `apps/web/lib/glossary.ts`.

- **Gate**: the score a phase needs before the next one opens: 70 out of 100.
  Nothing is timed, and you can submit as often as you like until you clear it.
- **Process marks**: the part of your score that is about how you worked, not
  what you made: whether you ran the tests before submitting and how much you
  leaned on the reviewer. Questions to the reviewer count against it after the
  first ten.
- **Dossier**: your whole project bound as one document, phase by phase, ready
  to read on screen or print. It is built from what you wrote, so it fills in
  as you go.
- **Artefacts**: the things you make in a phase: a user story, a design, code,
  tests, a runbook. Everything you write here is kept, and it is yours to take
  with you.
- **Kill matrix**: a grid of your tests against copies of the application with
  one bug planted in each. A cell is green when a test fails on the broken
  copy, which is what a good test is for.
- **Mutant**: one copy of the application with one deliberate bug in it. Your
  tests kill a mutant when at least one of them fails against it; a mutant
  that survives found a gap in your suite.
- **Runbook**: the written steps for running the system: how to start it,
  check it, roll it back and recover it. It is what the person on call reads
  at two in the morning.
- **Ledger**: a table of what your design promised against what your code
  did, one row per claim. Where the two disagree, one of them needs to change,
  and the ledger says which row.
- **Pull request**: your work packaged for review: the changes, the checks
  that ran on them and the conversation about them. Every submission from
  phase 3 onwards opens or updates one.
- **Contract**: the agreed shape of a request and its reply between the front
  end and the API: which fields go in, what comes back, and which errors are
  possible. You write it in design and the later phases hold you to it.

## For instructors

Sign in with an instructor account (in the local demo,
`instructor@learnsdlc.test`) and you land on the teacher console (`/teacher`):

- **Your classes**: create a class and read its join code there; learners
  enter the code at `/join`. You see everyone in every class you created and in
  the class you belong to.
- **Learner phase map and roster**: a row per learner, phase by phase. Open a
  learner's phase to read the evidence they submitted and their latest
  submission, and to reach the phase levers.
- **The phase levers**: *Mark as passed*, *Reopen* (or *Unlock early* for a
  locked phase), *Reset the workspace*, *Reset this phase* and *Regrade this
  phase*. Each needs a reason of at least ten characters, and each is recorded
  in the audit trail with your name and that reason.
- **View as**: opens a learner's own view read-only, from your own account.
  Starting it is recorded; the learner's work cannot be changed from it.
- **Dates and regrades**: release and due dates per class and phase, and
  class-wide regrades.
- **Downloads**: the grades (`learnsdlc-grades[-<project>].csv`, one row per
  learner and phase, with email, display name, class, project, phase, status,
  best score, attempts, hints, reliance index, the kill matrix, conformance and
  drill results, the pack version, the time of the newest attempt, whether it
  was late and whether it was regraded) and the grade book
  (`learnsdlc-gradebook[-<project>].csv`, one row per learner and project, one
  column per phase), for one class or all of yours, and the quiz results.
  Values that look like spreadsheet formulas are prefixed with an apostrophe.
- **Your projects** and the **Teacher guide** (`/teacher/guide`): uploading
  and building a project of your own, described in full in
  [teacher-project-upload.md](teacher-project-upload.md).

The AI-reliance index is `100 × hints / (hints + 2 × submissions + 1)` per
phase; a high number means the learner leans on the mentor more than they
iterate.

## For administrators

Admin accounts have every instructor capability and see every class. The
**Accounts** page (`/admin`) looks an account up by email to change its role
or class, suspend or restore it (suspension signs out every session at once),
or set a new password for someone locked out: any account but your own. Its
**Classes** panel lists every class with its owner, and moves a class to
another instructor. Platform configuration lives in environment variables
(`.env.example`, and [production-runbook.md](production-runbook.md) §2):
database, AI provider key, sandbox limits, the first admin, mail.
