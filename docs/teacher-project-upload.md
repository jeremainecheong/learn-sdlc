# Uploading, editing, validating, publishing and exporting your own project

This guide is for teachers. It shows how to run a project of your own on
LearnSDLC: prepare it as an archive, upload it, refine and seal its tasks,
check it in the sandbox, preview it as a learner will see it, publish it to a
class, sign off the work that waits for you, and export it again. It also
covers downloading quiz results.

---

## Start here

If you have not used LearnSDLC before, begin with the starter archive.

**Two downloads, for staff only.** Open **Projects** in the teacher area. The
**Start here** panel at the top has two buttons. Only teachers and
administrators can download these archives; a learner cannot.

- **Download the starter**: Shelf, a small library application with a Python
  API and a TypeScript page, taken through all six phases from Requirements to
  Maintenance. It uploads as it is and passes fast validation; run deep
  validation on your draft before you publish it. It also carries notes for
  you and a stakeholder interview for its Requirements phase.
- **Download the shelf example**: the same application as a plain project in
  the authoring layout, with no notes and no interview.

**Replace the starter's hidden tests before you assign it.** Every teacher who
downloads the starter can read the same hidden tests, reference solution and
mutants. A class that works on them unchanged is working on answers other
people already hold. Write your own through the sealed doors (section 3), then
run deep validation again. The same goes for its interview: every teacher who
downloads the starter can read the answers behind it, so write your own
stakeholder and provided stories in the Requirements builder (section 3)
before you assign the Requirements phase.

**The ten steps.** The Projects page and the draft editor show the path as a
rail of ten steps: Prepare, Upload, Refine, Seal, Deep-validate, Preview,
Publish, Assign, Sign-off and Export. In the editor, the rail marks each step
as done, not yet, or out of date (a deep validation, passed or failed, that
ran on the draft before an edit since), and says which step comes next. Each step has a few lines of help, a **Take me
there** link to the place you do it, and a link to its part of this guide. The
next section lists the steps in order.

**START-HERE.md and NOTES.md are for you.** The starter holds a
`START-HERE.md` at its top and a `NOTES.md` in each phase folder. They say
what each phase asks of learners and which files are sealed. No phase mounts
them, so no learner ever sees them, the upload stores none of their bytes, and
an export leaves them out. Keep your own copy of the archive if you want to
keep them. Notes like these in your own archives are treated the same way.

`interview.json` in the Requirements folder is not a note. It is the
stakeholder interview, and the upload seals it with the draft: see
[1. Prepare the archive](#1-prepare-the-archive).

---

## The whole path at a glance

1. **Prepare** a `.zip` of your project in the authoring layout, or start from
   the starter (section 1).
2. **Upload** it on the Projects page. It becomes a **draft**, version `0.1.0`,
   that you own. No other teacher and no learner can see it. The upload runs
   fast validation at once, and the draft's editor shows the report
   (section 2).
3. **Refine** the tasks: their briefs and objectives, and the quiz questions
   and answers (section 3).
4. **Seal** the hidden tests, the reference solution and the mutants through
   their sealed doors (section 3).
5. **Deep-validate**. This boots your project in the sandbox and makes sure
   the hidden tests, the solution, the mutants and the smoke check all behave
   (section 4).
6. **Preview** the draft as a learner will see it (optional; see
   [Preview a draft as a learner](#preview-a-draft-as-a-learner)).
7. **Publish** the version. Publishing checks everything again (section 5).
8. **Assign** the published version to a class, as you do with any project.
9. **Sign off** the tasks that wait for you (optional; section 9).
10. **Export** a version back to an archive when you want a copy (optional;
    section 8).

Nothing reaches a learner until you publish a version and assign it.

---

## 1. Prepare the archive

An upload is one `.zip` file. It holds the project folder in the layout
[authoring-format.md](authoring-format.md) describes: `project.json`, and one
folder per phase under `phases/`, each holding its files at the paths
learners see. `project.json` may sit at the top of the archive or inside one
top-level folder, which is what you get when you zip the folder itself. A
`__MACOSX/` folder, a `.DS_Store`, `Thumbs.db` or `desktop.ini` file, and an AppleDouble `._` file are left out, and the upload names each in its warnings.

### The folders are the list

The archive says what it holds by its folders. `project.json` lists no
phases and names no files: each folder under `phases/` is one phase, and
each file sits in its phase's folder at the path learners see.

```
<project>/project.json
<project>/phases/<NN>-<key>/phase.json
<project>/phases/<NN>-<key>/files/<path>         learners edit it
<project>/phases/<NN>-<key>/readonly/<path>      learners read it
<project>/phases/<NN>-<key>/interview.json       Requirements
<project>/phases/<NN>-<key>/quizzes/<key>.json   a concept quiz
<project>/phases/<NN>-<key>/hidden_tests/<run>/<path>   code
<project>/phases/<NN>-<key>/solution/<path>      code
<project>/phases/<NN>-<key>/reference/<path>     tests
<project>/phases/<NN>-<key>/impl/<path>          tests
<project>/phases/<NN>-<key>/mutants/<name>/      tests
<project>/phases/<NN>-<key>/smoke/<path>         config
<project>/phases/<NN>-<key>/drill/<path>         config
```

- **A phase folder is named for its phase**: `<NN>-<key>` or just `<key>`,
  where the key is `requirements`, `design`, `implementation`, `testing`,
  `deployment` or `maintenance`, in lower case. The phases are put in
  LearnSDLC's order whatever the numbers say; the number is for you.
- **`files/` and `readonly/`** hold the files learners start from:
  `files/api/shelf.py` is mounted at `api/shelf.py` for learners to edit,
  and `readonly/tests/conftest.py` at `tests/conftest.py`, locked. A file in
  both is refused.
- **`phase.json`** holds the phase's words and checks: its title, its
  intro, its brief (the task panel, in plain text), its objectives, its
  criteria and its checks. It names no file and no folder.
- **The sealed folders** hold what learners never see: a coding phase's
  hidden tests, one folder per run under `hidden_tests/`, each file at the
  path it runs from, and its reference solution under `solution/`; a
  testing phase's reference suite under `reference/`, the implementation it
  is graded against under `impl/`, and one folder per mutant under
  `mutants/`, holding its `meta.json` and the files it changes; a
  deployment drill's faulted copies under `drill/`. The smoke run's own
  files sit under `smoke/`.
- **`quizzes/`** holds one file per concept quiz, named for the quiz's task
  key: `quizzes/concepts.json` becomes the quiz `concepts`, placed among the
  phase's tasks by its `order`.
- **Anything else in a phase folder is refused by name**, so a typo such as
  `file/` or `quizes/` never loses files in silence. A note beside
  `phase.json` (a `NOTES.md`) is yours and is neither stored nor refused.

**An archive in the older layout is converted once.** An archive whose
`project.json` lists its phases, with a list of files in each `phase.json`,
is read once as it is uploaded and stored in the folder layout. The upload
says so: "This archive was in the older layout, with a list of phases and
files. It was read once; its export will be in the folder layout." Its
`canonical/` folder is read for the files the phases take from it, and left
behind. A file whose declared language differs from its extension's is
named once: "<path> was declared <language>; it is read as <derived
language> by its extension now."

### Size and shape limits

| Limit | Value |
|---|---|
| Archive size | 32 MB (32 × 1,024 × 1,024 bytes) by default. The upload page shows the size this deployment accepts |
| Unpacked size | The same limit, for everything in the archive together |
| Entries | At most 2,000, folders included |
| Compression | At most 100 to 1 for any one entry. Entries of 1 KB (1,024 bytes) or less unpacked are not held to the ratio |
| Entry names | At most 1,024 bytes, and at most 64 parts between slashes, folders and file name together |
| Compression methods | Stored and deflated only |

Also refused:

- an encrypted entry,
- a symbolic link or any other special file,
- an entry whose path climbs out of the project folder or starts at the root of
  the disk,
- two entries with the same name, a file and a folder at the same path, or
  names that differ only in upper and lower case,
- a name holding a null or any other control character,
- an entry whose declared size or checksum does not match its bytes, or a
  large-archive (ZIP64) size or position beyond the upload limit,
- an empty archive, or a file that is not a zip.

If the archive is too big, the usual cause is dependencies or build output.
Leave out `node_modules/`, `__pycache__/`, built bundles and the like.

### What the project itself must be

- **The phases it needs, one folder each.** A project holds any of
  LearnSDLC's six phases, at least one, each once, in LearnSDLC's order:
  Requirements, Design, Implementation, Testing, Deployment and Maintenance.
  A project of three phases is a whole project: learners pass the phases it
  holds, and its completion asks for those. In the usual layout,
  Requirements is a story phase, Design is a design phase, and
  Implementation, Testing, Deployment and Maintenance run your application.
  Deployment and Maintenance are also record phases: beside the files they
  grade, each holds one record the learner writes in forms, the runbook in
  Deployment and the change request in Maintenance.
- **No written task in any phase.** No phase is graded as markdown any more.
  A Requirements or Design phase written in the older markdown format is
  converted as it is uploaded (the next two sections). An older written
  phase under any other key is refused, and the line under the refusal names
  it by its key, whatever the pack titles it, for example "Testing is a
  written phase in the older format, and only Requirements and Design
  convert from it. Remove the phase from the pack or give it checks of its
  own."
- **One task in Design.** A Design phase holds one design task; a concept
  quiz may sit beside it.
- **One work task in each of Implementation, Testing, Deployment and
  Maintenance.** A quiz beside it does not count. A phase with two work tasks is
  refused. A coding, testing or deployment phase cannot be split into several
  tasks yet.
- **No warm-up.** An uploaded project cannot carry one. Leave the `warmup/`
  folder out of the archive.
- **No `canonical/` folder.** Put each file a phase uses in that phase's
  `files/` or `readonly/` folder, even when two phases use it.
- **No secret-shaped files.** That means `.env` files, private keys, credential
  files, and folders such as `.git` or `.ssh`. Zipping a working copy of a
  repository therefore fails on its `.git` folder; zip a clean copy instead.
- **No machine output.** A `__pycache__`, `node_modules`, `.pytest_cache`,
  `.mypy_cache`, `.ruff_cache`, `.tox`, `.venv` or `venv` folder, a `.pyc` or
  `.map` file, and an editor's `.idea` or `.vscode` folder are refused by
  name. Delete them before you zip the folder.
- **Every brief in plain text** (below).
- **Runs only in the shapes the platform already grades with.** There are seven
  (listed in [section 6](#6-the-seven-run-shapes)). A project cannot bring its
  own command line.
- **No run that asks for more time or memory than a learner's run gets.** A
  learner's run gets 15 seconds and 256 MB by default. An upload can never
  raise either limit. You never need to declare them.
- **A runtime inside this deployment's one runtime profile** (next section).
- **No more microVMs than the ceiling.** One full pass of a phase may boot at
  most 10 microVMs, and one full pass of the whole version at most 24. A
  microVM is one sandbox boot. Each run of a coding task counts two, each run
  and each mutant of a testing task counts one, and the deployment smoke check
  counts one, plus one more for its incident drill.
- **No sealed bytes in a learner's files.** A file a learner reads may not hold
  the bytes of a hidden test, and a file a learner edits may not hold the bytes
  of the reference solution.

### The Requirements phase

The Requirements phase holds no files. Learners write their story in a form
in the room, and it is saved as a record, never as a file they open. In the
archive, the phase folder holds:

- **`phase.json`**, whose checks say the phase is a story phase and hold what
  the editor's five steps hold: the provided stories learners read, the id of
  the story the learner writes (or that the learner picks it), and the floor,
  the minimums checked before the review. The brief learners read is the
  phase's task panel. [authoring-format.md](authoring-format.md) gives every
  field and its limits.
- **`interview.json`**, if the phase has a stakeholder. It holds who learners
  question and the facts the stakeholder answers from. No phase mounts it, and
  no learner opens it.
- **`quizzes/`**, if the phase has concept quizzes, one file each.

Nothing else is needed: no task file, no starter files and no notes. You can
also upload a Requirements phase with only its `phase.json` and fill in the
rest in the editor's five steps (section 3).

- **A stories file is refused.** An archive that still holds the stories
  file the upload once made an interview from imports nothing. The page says
  "This archive is not a project in the authoring format", and the line under
  it names the file, says it is no longer read, and asks you to type the
  stakeholder's facts in the editor. Remove the file, upload again, and write
  the facts in step 2 of the builder (section 3).
- **An older Requirements phase is converted.** A Requirements phase written
  in the older markdown format, with a backlog file, a story file for the
  learner and pattern rules, is converted to a story phase as it is uploaded.
  Each story in the backlog becomes a provided story, from its title and its
  As a, I want, so that sentence; the acceptance criteria written under them
  are not carried, so add them again in step 3. The learner's story keeps its
  id, the floor takes its defaults (two criteria, a happy and a boundary case,
  one out-of-scope line, the full sentence), and the pattern rules are
  dropped. The upload lists what it changed before the draft opens
  (section 2).

### The Design phase

The Design phase holds no markdown. Learners build their design in the room's
forms (the UML model, the operations, the decisions, and the API contract,
the screens and the sequence diagram where you switch them on), and it is
saved as a record, never as a file they open. In the archive, the phase
folder holds:

- **`phase.json`**, whose checks say the phase is a design phase and hold what
  the editor's six steps hold: the stories learners design for, the three
  switches (the API contract, the screen contract and the sequence diagram),
  and the floor, the minimums checked before the review. The brief learners
  read is the phase's task panel. [authoring-format.md](authoring-format.md)
  gives every field and its limits.
- **`files/design/design.json`, `files/shared/contract/api.json` and
  `files/shared/contract/screens.json`**, if you want learners to start from
  something. Each is optional: a design phase without them starts from an
  empty record, and from an empty contract for each contract you switched
  on.

Nothing else is needed: no task file and no notes. You can also upload a
Design phase with only its `phase.json` and fill in the rest in the editor's
six steps (section 3).

- **An older Design phase is converted.** A Design phase written in the
  older markdown format, with a design page for the learner, the read-only
  backlog and architecture files and pattern rules, is converted to a design
  phase as it is uploaded. Every markdown file is dropped; the design record
  keeps everything the learner's room drew; a contract is switched on when
  the phase mounted it; the sequence diagram is off; the floor takes its
  defaults; and each pattern rule's label becomes a sentence of the criterion
  it scored. The stories to design for start empty, so add them in step 2
  (Copy from Requirements fills them). The upload lists what it changed before
  the draft opens (section 2).

### The Implementation and Testing phases

The Implementation phase runs your application's code, and the Testing
phase the learner's tests against it. In the archive:

- **Implementation** holds `phase.json`, whose checks are a coding phase's:
  the files learners write (`editableTargets`), and its runs, each with its
  label, its visible tests and its language. Its folder holds the starter
  files under `files/` and `readonly/`, the hidden tests of each run under
  `hidden_tests/<run id>/` at the paths they run from (the run `api` runs
  `hidden_tests/api/tests/test_shelf.py` as `tests/test_shelf.py`), and the
  reference solution under `solution/`, each file at the path it completes.
- **Testing** holds `phase.json`, whose checks are a testing phase's: the
  learner's test files, the smallest number of tests, the coverage keywords
  and its runs. Its folder holds the files learners start from, the
  reference suite under `reference/`, the implementation the learner's
  tests are graded against under `impl/`, and one folder per mutant under
  `mutants/`, holding its `meta.json` and the files it changes.

No task file: the brief is the phase's task panel, in plain text.

### The Deployment phase

The Deployment phase runs your configuration and holds one record, the
runbook. Learners edit the configuration files in the IDE, and write the
runbook in the Runbook tab's forms, never as a file they open. In the
archive, the phase folder holds:

- **`phase.json`**, whose checks are a config phase's (the file rules, the
  smoke run and the drill, as before) and a `runbook` member with the floor,
  the minimums checked before the review. The brief learners read is the
  phase's task panel. [authoring-format.md](authoring-format.md) gives every
  field and its limits.
- **The files learners start from**, the smoke run's files under `smoke/`,
  the drill's faulted copies under `drill/`, and
  **`files/deployment/runbook.json`**, mounted editable at
  `deployment/runbook.json`, if you want learners to start from a runbook. A
  phase without it starts from an empty one. In a phase with a drill, its
  incident is empty, because the drill writes it.

No task file and no markdown file. These are refused, each with its line
under the refusal: a task file ("phases/05-deployment/phase.json: Deployment
keeps its brief in taskPanel, not in a file."), a mounted markdown file ("A Deployment phase mounts no
markdown file: " and its path), a file rule on a markdown file ("A file rule
cannot target a markdown file. The runbook is a record of its own."), a rule
with no file ("A file rule names the file it reads."), a starting runbook
with an incident in a phase with a drill ("A starting runbook in a phase with
a drill has an empty incident: the drill writes it.") and a runbook on any
other phase ("Only Deployment carries a runbook.").

- **An older Deployment phase is converted.** A Deployment phase written
  before the runbook record, with a `RUNBOOK.md` the learner edits and rules
  over it, is converted as it is uploaded. The brief file's words become the
  task panel; `RUNBOOK.md` becomes the starting runbook, its sections read by
  their headings; the runbook rules are dropped, each rule's label kept as a
  sentence of the criterion it scored; the floor asks for a section only
  where the older phase graded it or had a heading for it; and a runbook
  criterion is added when none is left, the other weights scaled to make
  room. The upload lists what it changed before the draft opens (section 2).

### The Maintenance phase

The Maintenance phase runs your application and holds one record, the
change request, beside the ticket you write. Learners edit the code in the
IDE, and write the change request in the change room's tabs, never as a
file they open. In the archive, the phase folder holds:

- **`phase.json`**, whose checks are a code phase's (the runs, the hidden
  suites and the solution, as before) and two members: `ticket`, the change
  learners are asked to make (an id, a title, a summary and the acceptance
  lines), and `change`, with the contract switch and the floor. The brief
  learners read is the phase's task panel.
  [authoring-format.md](authoring-format.md) gives every field and its
  limits.
- **The files learners start from**, the hidden tests and the solution, as
  in Implementation, and **`files/maintenance/change-request.json`**, mounted
  editable at `maintenance/change-request.json`, if you want learners to
  start from a change request. A phase without it starts from an empty one.

No task file and no markdown file. These are refused, each with its line
under the refusal: a task file ("phases/06-maintenance/phase.json:
Maintenance keeps its brief in taskPanel, not in a file."), a mounted markdown file ("A Maintenance phase mounts no
markdown file: " and its path), and a ticket or change request on any other
phase ("Only Maintenance carries a ticket and a change request.").

- **An older Maintenance phase is converted.** A Maintenance phase written
  before the change request, with no ticket and perhaps a `CHANGELOG.md`, is
  converted as it is uploaded. The ticket is built from the brief (its first
  `CR-` or `CHG-` number, else `CR-1`; its quoted request; the objectives as
  the acceptance lines); the contract switch is on exactly when the phase
  mounts `design/contracts.json`; `CHANGELOG.md` becomes the starting change
  request; and a change criterion is added when none is there. Check the
  ticket in step 2 of the builder. The upload lists what it changed before
  the draft opens (section 2).

An uploaded archive of an older version, even one exported from the
platform's own project, converts this generic way, so its Deployment and
Maintenance are your own and need deep validation (section 4) before you
publish.

### Every brief is plain text

A brief, an objective, an intro, a criterion's title and sentence, a ticket
or story line, and a quiz's stem, options and explanations are plain text.
Learners read them as you wrote them: line breaks kept, a blank line between
paragraphs, and nothing interpreted. When a text still holds markdown, the
upload, or your first save in the editor, keeps every word and changes only
the markup:

- **Code is kept as it is.** A code span keeps its backticks, a fenced block
  keeps its two fence lines and every line between them, and a line
  indented four spaces is kept as it is, so code examples keep their
  indentation.
- **A list is kept.** A dash, star, plus or list number that opens a line is
  kept, as plain text writes a list, and so is a quote's `>`.
- **Headings and emphasis go.** A heading's # and the emphasis around words
  are removed at a save, as the editor's hint says: "Plain text. Lists,
  indented lines and code in backticks are kept as you type them; a
  heading's # and the stars or underscores around words are removed when
  you save." An underscore or asterisk inside a word, as in `list_tasks`,
  stays. A table row becomes its cells joined by "; ", and a link becomes
  its text followed by its address in brackets.
- **An HTML comment is kept for you and never shown to learners.**

The upload says what it changed, once per phase, for example
"Implementation's brief had markdown in it. It was kept as plain text, every
word in place; read it in the editor." (or "Implementation's brief and
objectives had markdown in them. They were kept as plain text, every word in
place; read them in the editor.") and "Implementation's brief holds an HTML
comment. Learners do not see it; read it in the editor." A text that held
only markup, such as a lone `#` or `---`, is refused, because nothing would
be left: "A brief cannot be empty." (and the same for each text: "A
criterion title cannot be empty.", "The intro of Implementation cannot be
empty."). The upload trims each text, measures it against the editor's
limits after trimming, and stores it trimmed. In the editor, a task's title,
brief and objectives are trimmed the same way; the intro, the criteria and a
quiz's texts are measured and kept as you typed them, spaces at either end
included. A draft you made before this rule converts at the platform's
next restart, or at your first save in the editor; a text that held only
markup is then stored empty, and the editor says so on its phase:
"Implementation's brief held only markup and is now empty; fill it in."

### The runtime profile

This deployment has one runtime profile, called **Baked runtime**: the Python
and Node packages and the build tool already built into the sandbox. The upload
page shows it before you choose a file, and the editor shows it on each
version, under **Advanced information** near the top of the page. On the upload page the line ends with the first 12 characters of a
sha256 of the three baked allow-lists (Python, Node, tools), so you can tell
which lists the upload is checked against.

If `project.json` declares a `runtime` block, every pin in it must be exactly
the version the profile holds. A package the profile does not hold, or a
different version of one it does hold, is refused. Adding a library is a
platform change, not a content change. Leaving the `runtime` block out is
allowed.

### Files for you, not for learners

A file no phase mounts is not stored and is not refused, as long as it is not
shaped like a secret. That covers `START-HERE.md`, a `NOTES.md` in a phase
folder, or a README beside `project.json`. Learners never see such a file, and
an export does not carry it.

---

## 2. Upload

1. Open **Projects** in the teacher area and choose **Upload a project**.
2. Give the project a **title** of 1 to 120 characters. Learners see the
   title, and the project's web address is made from it. The address is never
   taken from the archive. If another project already uses that address, or
   the platform keeps it for its own project, a number is added to the end,
   such as `-2`, and the upload goes ahead.
3. Choose the archive. The page shows its size against the limit and stops
   you before sending a file that is too large.
4. Choose **Upload as a draft**.

You can upload at most 5 archives a minute. A sixth is not read, and the page
says: "Too many uploads in the last minute, so this one was not read and
nothing was imported. Wait a minute, then upload the archive again." Nothing is
wrong with the archive.

When the upload is accepted, what happens next depends on the archive:

- **If the upload changed the archive on the way in**, for example by
  converting an older Requirements phase or an archive in the older layout,
  keeping a brief's words as plain text, or leaving out a desktop file
  (section 1), the upload form gives
  way to a panel that says "The upload changed the archive on the way in.
  Check these in the editor." with one line for each change. This is the only
  time the page says so. Choose **Open the draft** to go to the editor, or
  **Close**.
- **Any other upload** opens the editor on the new draft at once.

The draft:

- is owned by you; no other teacher and no learner can see it,
- is version `0.1.0`, whatever `version` the archive's `project.json` says,
- is not published, and no class can be assigned to it yet,
- has already been through fast validation once. Its editor shows the report.

The upload is recorded in your record of changes as "Uploaded the project
… as a draft".

**Uploading again always makes a new project.** It never replaces an existing
draft or version. To change a project you uploaded, edit its draft (section
3). If what you need to change cannot be edited, upload the corrected archive
as a new project.

If the page says an upload timed out, it may still have finished. Reload and
look for the draft before you upload again.

### When an upload is refused

Nothing is imported. The page shows one fixed sentence for the reason, and
these sentences never quote anything from your archive. Under the sentence it
says what happened, how to fix it, and which part of this guide says more.
[Section 7](#7-upload-refusals) lists every reason.

When the answer carries no reason, for example after too many uploads in a
minute, a session that ended, or a server that did not answer in time, the
page says what to try next. It never says your archive is wrong, because
nothing in such an answer says so.

Three refusals carry more:

- **A run shape or run limit refusal** lists each finding with its own
  sentence and where in the manifest it was found, for example
  `phases[implementation].checks.runs[0]`. The location is built from
  manifest keys and positions only.
- **"This archive is not a project in the authoring format"** may add one
  short line underneath, up to 400 characters. It names the file or field to
  fix, such as a `phase.json` that is not valid JSON, and may repeat a path or
  a value your manifest gave, such as a phase key the format does not know. It
  never quotes a file's body, and the page shows it as plain text.
- **"This project asks for a library this deployment does not bake"** adds one
  short line underneath that names the first package in your `project.json`
  runtime block that the runtime profile does not hold (or says the block
  could not be read), shown as plain text.

---

## 3. Edit the draft

The editor opens on the **Phases** card, which says which of LearnSDLC's six
phases the draft holds and lets you remove one, put one back, or add one
(see "The Phases card" below). Under it, the editor shows every phase the
draft holds, each in its builder: Requirements in five steps and Design in
six (the next two sections), Deployment in four and Maintenance in five (the
two after them), and Implementation and Testing in three each (after the
Phases card). The code and runs of Implementation, Testing and Maintenance
use the same controls, described after the builders.

### The Requirements phase in five steps

The Requirements tab is built the way learners will meet it, in five steps
from top to bottom. A bar across the top marks each step as done, the one you
are on, or not yet. Everything you type here is what learners read, ask and
are judged by. Nothing is a file.

1. **Background.** What learners read first: two or three sentences about the
   world and the problem. A phase always has one.
2. **Stakeholder.** Who learners interview: a name, a role, the opening line,
   and the facts the stakeholder knows, each a topic with its answer. The
   interview answers only from these facts, so what you leave out, learners
   cannot find. Learners see the topics as a checklist, never the answers.
   When the task's brief names the stakeholder, the AI reviewer is given the
   facts too, so name them in the brief exactly as here, in the same
   capitals; the validation report warns when the brief does not. Without a
   stakeholder the phase has no interview, and the editor says "Add a
   stakeholder in step 2 below to give learners someone to interview."
3. **Provided stories.** What the backlog already holds when a learner
   arrives, shown exactly as learners will see it. Each has an id, a title,
   the As a, I want, so that sentence, and optional acceptance criteria that
   learners read as worked examples. The learner's own story sits in the list
   as the one they write. At most 12.
4. **The learner's story.** The one learners write themselves: its id (or
   let each learner pick one), its title, the brief, and optional hints for
   the three parts of the sentence. Then **the floor**, the minimums checked
   before the review: how many acceptance criteria (1 to 8), which cases they
   must include (happy, boundary, error), how many out-of-scope lines (0 to
   6), and whether the As a, I want, so that sentence must be filled. A line
   under the floor says the minimums in words. The sign-off and optional
   toggles are here too.
5. **Criteria.** What the review judges the story against, in your words.
   Each criterion has a title, a description and a weight; the weights must
   add up to 1, and a story passes at the pass mark (1 to 100).

**How a learner's story is graded.** When a learner submits, the floor is
checked first, and each minimum the story misses is said in a fixed sentence,
such as "Story has fewer than 2 acceptance criteria" or "No boundary case
among the criteria". The AI reviewer then judges the story against your
criteria, quoting the story's own fields as its evidence. A story passes only
when it meets the floor and the review passes it.

**A task in the older format.** A Requirements task still in the older
markdown format opens in the builder with the line "This task is in the older
format. Saving any story step converts it." Learners of a version published
in that format see "This project's Requirements task is in an older format;
its owner needs to re-save it." in place of the form. Convert the task in a
draft, then publish and assign the new version: publish refuses a task still
in the older format, and so does Assign, for any version whose Requirements is
in that format. Learners already on the older version move to your new one
automatically at the platform's next restart, but only when the rest of the
project is unchanged; when any other phase changed too, they stay where they
are and are listed for the platform's owner to decide.

### The Design phase in six steps

The Design tab is built the same way, in six steps from top to bottom, with
the same bar across the top. A Design phase holds one design task; a concept
quiz may sit beside it. Everything you set here is what learners read, start
from and are judged by. Nothing is a file.

1. **Background.** What learners read first: the system they are designing
   and what it must do. A phase always has one.
2. **Stories to design for.** The stories learners design against, each with
   an id, a title and the one line learners read. At most 12, each id once.
   **Copy from Requirements** fills the list from this draft's Requirements
   phase, after a confirm line, replacing what is listed.
3. **The learner's design.** The task's title, the brief and the objectives,
   one per line. Then three switches: the **API contract** (learners write
   the endpoints and the error catalogue), the **screen contract** (learners
   write each screen: its route, component, the operations it reads, what it
   shows, its components and its empty-state sentence) and the **sequence
   diagram** (learners write the request path, one message per line, and it
   must name at least one of their operations). Off, learners never see that
   part and nothing is graded for it. The sequence diagram is off for a new
   phase. Switching a contract off asks you to confirm first when its
   starting document holds more than the empty seed, because switching it off
   deletes that document.
4. **Starting point.** The design record and the contracts learners open the
   room on, edited with the room's own cards, so you seed exactly what
   learners will see. Under the cards: replace one document, **Start empty**
   (an empty record and empty contracts, after a confirm line), and **Reset to
   the pack's**, which puts back the documents of the version this draft was
   opened from (shown only on a draft opened from one).
5. **The floor.** The minimums checked before the review: how many entities,
   relations, operations, decisions, endpoints and screens, and the shape
   rules (every operation fully specified, every decision complete, every
   story traced, an error catalogue, every screen complete). A contract's rows
   are greyed while its switch is off, and the sequence diagram's row follows
   its switch in step 3. A line under the floor says the minimums in words.
   The sign-off mark is here too.
6. **Criteria.** What the review judges the design against, in your words.
   Each criterion has a title, a description and a weight; the weights must
   add up to 1, and a design passes at the pass mark (1 to 100).

**How a learner's design is graded.** When a learner submits, the floor is
checked first, and each minimum the design misses is said in a fixed
sentence. The AI reviewer then judges the design against your criteria,
quoting the design's own fields as its evidence, and only the contracts and
the sequence diagram you switched on. A design passes only when it meets the
floor and the review passes it.

**A task in the older format.** A Design task still in the older markdown
format opens in the builder with the line "This task is in the older format.
Saving the stories, the learner's design, the floor or the criteria converts
it." Learners of a version published in that format see "This project's
Design task is in an older format; its owner needs to re-save it." Convert the
task in a draft by saving any of those steps once, then publish and assign the
new version: publish refuses a Design still in the older format ("Design is
still in the older format. Open its Design step in the editor and save it
once to convert it."), and so does Assign, for any version whose Design is in
that format. Learners already on the older version move to your new one
automatically at the platform's next restart, under the same rule as
Requirements: only when the rest of the project is unchanged.

### The Deployment phase in four steps

The Deployment tab is built the same way, in four steps from top to bottom,
with the same bar across the top and a line under the last card saying how
many of the four are done. The files and checks come with the project; the
brief, the runbook and the criteria are yours. Each card opens with one
line saying what it is for.

1. **Brief.** "Learners read this first: the background, then the task's
   title, brief and what they aim for." The Background (at most 2,000
   characters), then the task's title, brief and objectives, one per line.
2. **Files and checks.** "What learners start from and what grades it.
   These change only when the project is uploaded again." A read-only list
   of the files the phase mounts, each marked as one learners edit or one
   that is read only; the file rules (each rule's label, the file it reads
   and the criterion it scores); the smoke run (the Dockerfile it builds,
   the command and the line it expects); and the drill (its fault, its
   description and the files it breaks), or a line saying the phase has
   none. The runbook is not in this list: learners never see it as a file.
3. **Runbook.** "The minimums the learner's runbook is checked against, and
   the record their Runbook tab opens on." Four counts (environment
   entries, health checks, rollback steps and data entries, each 0 to 20)
   and the incident switch: on, the learner's runbook records the
   incident's root cause, fix and action item. A line under them says the
   floor in words, as learners read it. Each change saves at once. Under
   the floor, the starting runbook, the same record learners open in their
   Runbook tab: each environment variable, health check, rollback step and
   data entry is a card named for it ("Environment E2 · API_URL") that you
   can fold, its Remove names the entry ("Remove API_URL"), each list has
   its own Add ("Add an environment variable"), and each field says what it
   expects with a short example (a data entry asks for **What is kept**,
   **How the backup is made**, **Where it is kept** and **How long copies
   are kept**); in a phase with a drill its incident is read-only, because
   the drill writes it. **Start
   empty** replaces it with an empty runbook, and **Reset to the pack's**
   puts back the starting runbook of the version this draft was opened
   from; each asks you to confirm first. On a draft opened from no other
   version (a fresh upload), Reset answers "This draft was not opened from
   another version, so there is nothing to reset to." On a draft whose
   source version has no starting runbook (one published before the runbook
   record), it answers "The version this draft came from has no starting
   runbook. Start empty, or edit this one." The sign-off mark is here too.
4. **Criteria.** "What the review judges the runbook and the files against.
   The rows the phase's own checks grade keep their key and stay in the
   rubric; their title, sentence and weight are yours." The rows the file
   rules and the smoke run (`build_smoke`) score are locked (their key
   cannot change and they cannot be removed); every other row is a runbook
   criterion, and at least one is needed. The weights must add up to 1, and
   the phase passes at the pass mark (1 to 100).

**How a learner's runbook is graded.** When a learner submits, the file
rules and the smoke run grade the configuration files as before. The
runbook floor is checked beside them, and each minimum the runbook misses
is said in a fixed sentence, such as "Fewer than 2 rollback steps with a
step and a check". Only a filled item counts: a seeded name with nothing
under it counts for nothing. The AI reviewer then judges the runbook
against your criteria, quoting the runbook's own fields as its evidence.

**A task in the older format.** A Deployment task still in the older format
(a `RUNBOOK.md` and rules over it) opens in the builder with the line "This
task is in the older format. Saving the brief, the runbook floor or the
criteria converts it." The starting runbook appears once it is converted.
If the conversion would be refused (for example because the file's words
would not fit in the runbook), the builder does not open: the editor shows
the phase's usual panels with the reason above them. When the brief or an
objective still names the file, the Brief card says "The brief still names
RUNBOOK.md, which this phase no longer has."

### The Maintenance phase in five steps

The Maintenance tab is built the same way, in five steps from top to
bottom, with the same bar and the same count of steps done: the brief, the
ticket, the code and its runs, the change request and the criteria.

1. **Brief.** "Learners read this first: the background, then the task's
   title, brief and what they aim for." As in Deployment.
2. **Ticket.** "The change the learner is asked to make: what it is called,
   why, and the acceptance lines their change request covers." The ticket's
   id (at most 16 characters), its title, its summary, and its acceptance
   lines (at most 12, **Add a line** names the next one `AC-1`, `AC-2` and
   onward). A line above the fields shows the ticket as learners read it,
   by its id and title. Edits save when you leave the card, or with **Save
   the ticket**. A line the starting change request covers cannot be
   dropped: "AC-2 is covered in the starting change request. Remove it
   there first."
3. **Code and runs.** "What learners start from and what grades it: the
   starter, the visible tests, the hidden suite and the reference
   solution." The executable task's summary and its editor, as for
   Implementation and Testing (below), with the sealed doors.
4. **Change request.** "The minimums the learner's change request is
   checked against, and the record their change room opens on." The
   contract switch: "On, the learner declares contract amendments and the
   Contract tab is shown; off, neither." Switching it off over a starting
   change request that declares amendments asks first: "Switching this off
   deletes the 2 contract amendments in the starting change request." Then
   three counts (operations, screens or files in the impact; contract
   amendments, which counts only while the contract is on, its box disabled
   while it is off; tests, each 0 to 20) and
   two switches: the release (the learner's change request names a version
   and at least one change line) and every acceptance line covered by a
   test or a change line. A line under them says the floor in words. Each
   change saves at once. Under the floor, the starting change request,
   drawn with the change room's own forms (the request, the amendments when
   the contract is on, the tests and the release), with **Start empty** and
   **Reset to the pack's** as in Deployment, each confirmed first. On a
   fresh upload Reset answers "This draft was not opened from another
   version, so there is nothing to reset to."; on a draft whose source
   version has no starting change request, "The version this draft came from
   has no starting change request. Start empty, or edit this one." The
   sign-off mark is here too.
5. **Criteria.** "What the review judges the change request and the code
   against. The four rows the grader scores itself keep their key and stay
   in the rubric; their title, sentence and weight are yours." The four
   locked rows are the hidden tests, the visible tests, the code quality
   and the process; every other row is a change criterion, and at least one
   is needed. The weights must add up to 1, and the phase passes at the
   pass mark (1 to 100).

**How a learner's change request is graded.** The code is graded as
before: the hidden suites, the visible tests, the analyzer and the process.
The change floor is checked beside it, and each minimum the change request
misses is said in a fixed sentence, such as "Acceptance items not covered by
any change line or test: AC-2, AC-4". A test or a change line covers an
acceptance line by its id, which learners pick from the ticket's own list,
so the trace is counted, never guessed from words. The AI reviewer then
judges the change request against your criteria, quoting its fields, and
checks each declared contract amendment against the change in the contract
files.

**A task in the older format.** A Maintenance task still in the older format
(no ticket) opens in the builder with the line "This task is in the older
format. Saving the brief, the ticket, the change request floor or the
criteria converts it." The ticket and the starting change request appear
once it is converted. If the conversion would be refused (for example
because the changelog's words would not fit in the change request), the
builder does not open: the editor shows the phase's usual panels with the
reason above them. When the brief or an objective still names the changelog,
the Brief card says "The brief still names CHANGELOG.md, which
this phase no longer has."

### The Phases card

The first card in the editor lists LearnSDLC's six phases in order, each
marked "In this project", "Removed" or "Not in this project", under the
line "A project holds the phases it needs, in LearnSDLC's order." Its
readiness line names what the draft holds, for example "This draft holds 3
of LearnSDLC's six phases: Requirements, Design and Implementation."

- **Remove** takes a phase out of the draft, when the draft holds two or
  more. It asks first: "Remove Testing from this project? Its task, its
  files, its sealed files and its quizzes leave this draft. Published
  versions keep it." Choose **Remove Testing** to go ahead or **Keep it**.
  When no version this draft came from holds the phase (a fresh upload, or
  a phase you added), the question says how it can come back: "Remove
  Testing from this project? Its task, its files, its sealed files and its
  quizzes leave this draft. This draft was not opened from a version, so
  Testing comes back only by uploading the project again." (for
  Requirements or Design, "...so Design comes back only as an empty phase,
  through Add."). The draft keeps at least one phase: "A project keeps at
  least one phase. Put another phase back before you remove Requirements."
- **Put back** copies a removed phase back from the version this draft was
  opened from, as it is there: its task, its files, its sealed files and its
  quizzes.
- **Add** gives the draft an empty Requirements or Design, which you then
  build in its steps. Implementation, Testing, Deployment and Maintenance
  come with files, tests and a solution the browser cannot make, so the
  card says beside each one the draft does not hold: "Added by upload: its
  files, tests and solution cannot be made in the browser." Upload the
  project again with that phase's folder to have it.

The card says what happened ("Testing was removed from this draft.", "was
put back", "was added to this draft"), and when a change is refused, why,
for example "Implementation comes with its files, tests and solution, so it
is added by upload. Upload the project again with an implementation folder
to add it.", "Testing cannot be put back: the version this draft was opened
from does not hold it. Upload the project again with a testing folder to add
it." or "Design is already in this project." Each change is recorded in
your record of changes as "Removed Testing from the draft", "Put Testing
back in the draft" or "Added Design to the draft". A published version
never changes: "A published version does not change. Open a draft to change
its phases." A remove, a put back or an add makes a deep validation out of
date, because the phases it ran on have changed.

### The Implementation phase in three steps

The Implementation tab is built the way the other builders are, in three
steps from top to bottom, with a bar across the top and a line under the
last card saying how many of the three are done: "Three steps, top to
bottom: the brief, the code and its runs, and the criteria. The starter
files come with the project. The sealed suites come with the upload, or you
seal them here at step 2."

1. **Brief.** "Learners read this first: the background, then the task's
   title, brief and what they aim for." The Background, then the task's
   title, brief and objectives, one per line, in plain text (section 1).
2. **Code and runs.** "What learners start from and what grades it: the
   starter, the visible tests, the hidden suite and the reference
   solution." The executable task's summary and, under **Edit the code and
   runs**, its editor: each run's label, test paths and visible tests, with
   the sealed doors for the hidden tests and the solution (below). The
   sign-off mark is here too.
3. **Criteria.** "What the review judges, in your words: the grader's own
   criteria, their sentences and weights." The four rows the grader scores
   itself (`correctness_hidden`, `visible_tests`, `code_quality` and
   `process`: the hidden tests, the visible tests, the code quality and the
   process) keep their key and stay in the rubric; their title, sentence
   and weight are yours, under the line "These criteria are fixed: the
   grader scores each one. Change their sentences and weights." The weights
   must add up to 1, and the phase passes at the pass mark. A criterion of
   your own is refused: "Implementation is scored by its fixed criteria.
   Change their sentences and weights; a new criterion has nothing to score
   it."

### The Testing phase in three steps

The Testing tab is built the same way: "Three steps, top to bottom: the
brief, the tests and their runs, and the criteria. The starter files come
with the project. The sealed suites come with the upload, or you seal them
here at step 2."

1. **Brief.** As in Implementation. When you want the Testing room to list
   your acceptance criteria for learners to link their tests to, write each
   story as a line that opens with its id, with the prefix your Requirements
   stories use (`SH-3` when they are `SH-1`, `SH-2` and so on; `US-3` when
   Requirements provides no stories), and each of its criteria under it as a
   list item that opens with its id, such as `- AC-2`.
2. **Tests and runs.** "What learners test and what grades their tests: the
   runs, the reference suite, the reference implementation and the
   mutants." The executable task's summary and, under **Edit the tests and
   runs**, its editor: each run's label and test paths and the smallest
   number of tests, with the sealed doors for the reference suite, the
   implementation and the mutants (below). The sign-off mark is here too.
3. **Criteria.** As in Implementation, over the three rows the grader scores
   on a testing task: `tests_pass`, `mutants_killed` and
   `coverage_mapping`. A criterion of your own is refused: "Testing
   is scored by its fixed criteria. Change their sentences and weights; a
   new criterion has nothing to score it."

### What you can change in an executable task

| You can change | Where |
|---|---|
| The brief | Step 1 of the phase's builder |
| Each run's **label**, the test paths its graded run collects, and on a coding task its **visible tests** | The task editor |
| On a testing task, the **smallest number of tests** a learner's suite must hold (1 to 500) | The task editor |
| **Hidden tests**, one file at a time | Sealed upload, per run |
| The **reference solution**, one file at a time | Sealed upload |
| On a testing task, the **reference suite**, the **implementation** it grades against, and the **mutants** | Sealed upload, mutants editor |

A run's label is 1 to 80 characters on one line. A run collects 1 to 20 test
paths, each must hold at least one file the run grades, and together they must
still hold every one of them: on a coding task, every hidden file in that run;
on a testing task, every one of the learner's test files in that run. A coding
run has 1 to 40 visible tests, each a file the phase ships. The editor refuses
a save that breaks any of these rules, with a sentence saying why.

### What is set at upload and shown read-only

These are listed in the editor, each marked as set at upload. To change them,
upload a corrected archive as a new project.

- **Which files a learner edits** (the starter files a learner works in).
- **The runs themselves.** You cannot add, remove, rename or reorder a run, or
  change its shape. Each run is a priced microVM and a shape the runner was
  reviewed for.
- **Which test files belong to each run** of a testing task.
- **The coverage keywords** of a testing task. They are grouped by the
  acceptance criterion each group evidences, and the editor cannot regroup them
  yet.
- **The smoke check and the incident drill** of the Deployment phase. The
  editor shows them, but only a new upload changes them.
- **The bytes of starter files and visible tests** in Implementation, Testing,
  Deployment and Maintenance. The editor does not replace those files one by
  one. The starting runbook and the starting change request are records, not
  starter files: you edit them in the Runbook and Change request steps.
- **Deployment's files, file rules, smoke run and drill.** A save that tries
  to change them is refused: "Deployment's files, rules, smoke run and drill
  change only when the project is uploaded again."

### Sealed files: hidden tests, the solution and mutants

A sealed file is one a learner never sees:

- on a **coding** task: the **hidden** suite of each run, and the **reference
  solution**,
- on a **testing** task: the **reference suite** (written as `hidden`), the
  **implementation** it grades against (written as `solution`), and the
  **mutants**.

You write a sealed file through its own door, one whole file at a time. The
page then shows only its path, a sha256 digest and its size. No other page,
report or answer carries its bytes.

Rules for a sealed file:

- It is UTF-8 text, not empty, with no null character, at most 200,000
  characters.
- Its path is relative, uses forward slashes, and uses only letters, digits,
  dots, dashes and underscores. Each part starts with a letter, a digit or an
  underscore, so no part may start with a dot or a dash or be `..`. At most
  240 characters.
- A hidden test on a coding task cannot sit at a path the phase already gives
  the learner, because in the graded run it would replace the learner's file.
- A coding task's reference solution must complete one of the files the
  learner is asked to write.
- A hidden test is uploaded under one run, and a run that would not grade the
  file is refused. A new hidden file may go into any run of its own language,
  not only the first.
- On a coding task a hidden test is a test file by its name, in the language
  of the run it lands in: `test_<name>.py` in a Python run, or
  `<name>.test.ts` or `<name>.test.tsx` in a TypeScript run. A hidden suite
  holds no helper files. The upload and publish ask the same rule.
- A mutant's path is its name, then the file it overlays: `<name>/<path>`, for
  example `off-by-one/shelf.py`. The name is lower-case letters, digits, dashes
  and underscores, at most 64 characters, starting with a letter or a digit.
  Only a testing task has mutants.
- A file's role never changes. A path that is already a file of another kind is
  refused.

**Reading a sealed file back.** The editor never shows a sealed file's bytes,
only its path, digest and size. The platform keeps one owner-only read-back:
the project's owner can read back a hidden test or a solution they wrote
through the platform's API (the editor has no control for it), and every such
read is recorded in their record of changes. Nobody else can read it: another
teacher gets "not found", and an administrator is refused. Two kinds of file
are never read back, by anyone:

- **A mutant.** What it changes is the test a learner's suite has to pass, so
  it stays sealed.
- **A sealed file that came with a project you copied.** It stays sealed for you
  as it is for every learner. Write your own at that path and you can read that
  one back.

The Files tab also says this: your reference solution may also appear as a
locked file a learner reads, such as the finished code a later phase builds on.
It is never a file a learner is asked to edit.

### The microVM ceiling in the editor

Each executable task shows how many microVMs one full pass of its phase costs.
The editor page adds them up against the version ceiling of 24. That total
covers the coding and testing phases the editor can price, and publishing
counts every phase again, including the deployment smoke check (and its drill,
if it has one). Each mutant you add adds one to the count. Over the ceiling,
the editor shows the sentence publishing would refuse with, such as:

> Testing would boot 11 microVMs for one full pass, and a phase may boot at most
> 10. Remove runs or mutants from Testing to publish this version.

### If you started from a copy instead

A copy of the platform's reference project can be edited the same way. Its
coding, testing, deployment and maintenance phases stay the reference project's
until you change something in one: its brief, its objectives, its runs, or any
sealed file. From then on that phase is your own. It needs deep validation
before it can publish, and its AI review uses the neutral prompts described in
[section 5](#5-publish-and-assign). Changing only a task's title does not count
as a change, and neither does an edit in Deployment's Runbook step or
Maintenance's Ticket and Change request steps, or either phase's criteria:
the records are not part of the application.

A copy of the reference project's current version is plain text already,
so the editor shows no plain-text note on it unless you write markdown into
it yourself. A copy you made of an earlier version converts as any draft
made before the plain-text rule does ("Every brief is plain text", section
1).

---

## 4. Deep validation

Fast validation reads your project. Deep validation runs it. It boots your
project in the sandbox, one microVM at a time, with a learner's time and memory
limits and no AI model. It checks four things:

| Letter | Check | Passes when |
|---|---|---|
| a | The solution passes the hidden suite | The reference solution passes its hidden suite on every run |
| b | The starter fails the hidden suite | The starter a learner opens fails that suite on every run, so the suite has teeth |
| c | Every mutant is killed | The reference tests pass the reference implementation and kill every mutant |
| d | The smoke check passes | The deployment smoke run passes on a working container, and the drill's faulted copy fails it |

A check that does not apply to your project reads **Does not apply**. A run the
sandbox could not perform never counts as a pass.

### Starting a run

1. In the editor's **Deep validation** section, choose **Run deep
   validation**.
2. A dialog shows the cost first, in microVMs, for example:

   > Deep validation boots 16 microVMs in the sandbox, one at a time, and asks
   > no AI model. You can run one deep validation at a time.

   Its **Start deep validation** control stays disabled until that sentence is
   shown.
3. Choose **Start deep validation**. The run is queued and then runs. The
   panel follows it while it is queued or running.

Rules that keep a run honest:

- **The count you saw is the count you pay.** If the draft changed after the
  dialog showed its count, the start is refused and nothing boots: "This draft
  now needs N microVMs for deep validation, not the count you were shown. Read
  the new count and start again."
- **One run at a time for each teacher.** Pressing start again on the same
  bytes is the same run. If you change the draft and start again while a run
  is still queued, the queued run is replaced by one on the new bytes. If a run
  on an earlier copy of the same draft is already running, a new start is
  refused until it finishes. A start on another of your drafts waits in the
  queue until your running one finishes.
- **A limited number at once across the platform.** At most two deep
  validations run at the same time on the whole platform. A run past that
  limit stays queued, and while a run is queued or running its checks read
  "This check is waiting for its turn in the sandbox."
- Only the project's owner can start or read a deep validation. A draft that
  has not compiled yet must be validated first.

### When a result goes stale

A passing result belongs to the exact bytes it ran on: every file, run, sealed
file and runtime pin in Implementation, Testing, Deployment and Maintenance.
Change any of them and the result is no longer current, so you need to run deep
validation again before you publish. Edits to Requirements and Design do not
make it stale.

---

## Preview a draft as a learner

Before you publish, you can see each phase as a learner of it will first read
it. In the draft editor's header, choose **Preview as a learner**. Only the
project's owner can open the preview.

A banner stays at the top of every phase: "Preview: nothing here is saved,
graded or seen by learners". The preview starts no run, asks no AI model,
writes nothing, and opens no phase for anyone. It has no Run, Check, Submit,
Ask or mentor control.

For each phase, in order, it shows:

- the phase's title, its brief and its objectives,
- the files a learner opens, and only those, read-only, each marked as one the
  learner edits or one that is locked,
- each task, with its kind and whether it needs your sign-off,
- the quiz questions and their options, without the answers,
- in Requirements, the interview's stakeholder and their opening line only,
  never the facts behind it,
- the labels a learner sees on the runs and checks,
- when learners can open the phase.

That last line reads "Learners open this first." for the first phase. For every
later phase it reads "Learners open this after every task in <the phase before>
has passed and, where a task needs it, has been signed off." When the phase
before holds an optional task, it says "every required task", because an
optional task never keeps a phase shut. The sentence describes the gate; the preview does not
open or close it.

Nothing sealed is in the preview: no hidden test, reference solution, mutant,
drill fault, interview answer or quiz answer.

A draft whose last save did not compile cannot be previewed, because a learner
could not open it yet. The page shows the server's sentence, which names the
project and version and ends "Fix what Validate reports, then open the preview
again."

---

## 5. Publish and assign

Publish from the editor as with any draft. A draft that holds no phase is
refused: "This draft holds no phase. Put a phase back or add one before you
publish." For a version with executable phases of your own, publishing
refuses, each with a sentence, when:

- a phase or the version is over the microVM ceiling (10 a phase, 24 a
  version),
- the runtime asks for a package or version outside the runtime profile; the
  refusal names the package,
- a run is not one of the seven shapes, or asks for more than a learner's run
  gets,
- an executable phase of your own has no current, passing deep validation,
  for example: "Testing has no current deep validation. Run deep validation
  on this draft and publish once it passes.",
- an executable phase holds more than one work task,
- a Requirements or Design task is still in the older format (section 3),
- a Deployment or Maintenance task is still in the older format (section 3):
  "Deployment is still in the older format. Open its Deployment step in the
  editor and save it once to convert it." or "Maintenance is still in the
  older format. Open its Maintenance step in the editor and save it once to
  convert it.",
- a phase other than Requirements and Design still holds a written task in
  the older markdown format, with the sentence that names the phase, such as
  "Testing is a written phase in the older format, and only Requirements and
  Design convert from it. Remove the phase from the pack or give it checks of
  its own.",
- anything fast validation already blocks on.

When a starting record already meets its floor, a warning is drawn above
**Publish** (it never refuses it), because a learner who changes nothing
would pass: "The starting runbook already meets
the floor, so a learner who changes nothing passes it. Raise the floor or
empty the starting record." and "The starting change request already meets
the floor, so a learner who changes nothing passes it. Raise the floor or
empty the starting record."

The ceiling, the runtime profile, the run shapes and limits, and the one-task
rule are checked at upload and checked again at publish, so an edit cannot slip
past them. The deep-validation rule shows as a warning on a draft and becomes a
refusal only at publish, so a fresh upload validates clean and you read the
requirement early.

Once published, assign the version to a class the usual way. The list of
versions you can assign names each one's phases, in the shape "<title>
<version>: Requirements, Design and Implementation (yours)". A published version never
changes: learners stay on the version they started, with its phases.

**Versions published before the runbook and the change request.** Assign
refuses a version whose Deployment or Maintenance is in the older format,
and the list of versions you can assign leaves it out: "This version's
Deployment is in the older format and cannot be assigned. Publish it again
from the editor." or "This version's Maintenance is in the older format and
cannot be assigned. Publish it again from the editor." It refuses a version
that holds a written phase in the older format under any key other than
Requirements and Design, which nothing grades any more: "This version's
Testing is a written phase in the older format, which LearnSDLC no longer
grades, and cannot be assigned." (with that phase's title). Learners already
on such a version see, in that phase, "This project's Deployment task is in
an older format; its owner needs to re-save it." (or the Maintenance twin),
or for a retired written phase "This phase is in an older format that
LearnSDLC no longer grades. Your work is kept; your teacher needs to publish
the project again.", with Check and Submit disabled. The API refuses a run,
a submit, a regrade and a drill's resolve there with the same sentence, and a concept quiz in
that phase cannot be started or handed in. Their work is kept.

For an older Deployment or Maintenance, convert the phase in a draft,
publish, and assign the new version; learners on the older version move to
it at the platform's next restart, under the same rule as Requirements and
Design (only when the rest of the project is unchanged), each phase they
wrote converted with every word kept; a learner whose words would not fit in
the record stays where they are, with their work untouched. For a retired
written phase, remove it in a draft or give it checks of its own, then
publish and assign the new version; once you have published a version that
holds no written phase, learners on the older version move to it at the
platform's next restart (only when the rest of the project is unchanged, the
retired phase and any phase it converts aside). Nothing is converted: their written work stays in
their workspace as files, and nothing grades it.

**A copy of the reference project's version 4.0.0.** A draft copied from
the platform's reference project at version 4.0.0, whose Deployment and
Maintenance are exactly as 4.0.0 shipped them, converts to version 5.0.0's
Deployment and Maintenance exactly: their checks, criteria, files, brief, objectives and mentor (the
task's title is kept). It stays the reference project's application, so it
needs no deep validation for them. A phase you had changed converts as an
uploaded older phase does (section 1) and keeps your brief. When the
reference's current phase cannot be read, the copy converts the generic way
too, and the note says so: "The reference's current Deployment could not be
read, so this copy of its older Deployment was converted the generic way."
(or the Maintenance twin).

### What learners get

- **The phases your project holds, and only those.** Learners see each
  phase by its place in your project ("Phase 2 of 3"), a phase opens when the
  one before it is passed, and completing the project asks for a pass in
  every phase it holds. On a class page, a learner on a version without a
  phase reads "Not in their version" in that phase's column.
- **The brief, as plain text.** In Implementation, Testing, Deployment and
  Maintenance, the brief is in the IDE's left aside, as "The brief" in the
  "Phase requirements and review" block; the Design room shows it as "The
  brief" too.
- **Implementation, Testing, Deployment and Maintenance show your
  application.** The brief, the files and the runs are yours, and the rooms
  drop the reference project's own panels and wording.
- **The AI uses neutral prompts.** In an executable phase of your own, the
  reviewer, the mentor and the agentic assistant use prompts that do not mention
  the reference project. Your hidden tests, solution, reference suite,
  implementation, mutants and drill files are not sent to an AI model, and a
  mentor reply that echoes one of them is redacted. (When a learner asks why a
  hidden test failed, the explanation is given that test's name and the first
  line of its failure message, as it is for the reference project.)
- **Run limits are a learner's limits:** 15 seconds and 256 MB a run, this
  deployment's defaults.
- **App preview is not offered for uploaded applications.** A room whose
  files hold a page (an `.html` file, a `main` script or a page component)
  draws the page preview instead: the learner's page code, with their
  unsaved edits, runs in the browser with sample data, and no server runs.
  Implementation shows it under the editor in **Split** and on its own in
  **Page preview**; the other rooms show it in their **Page preview** view.
  **Open in a new tab** opens the page preview in a tab of its own: that tab
  is a snapshot of the code in the editor at the moment it was opened, and it
  does not update.
  Learners check the rest of their work by running
  its tests, and the Files tab tells you so.
- **Requirements is a form, not a file.** Learners read your background, your
  provided stories and the brief, interview the stakeholder if the phase has
  one, and write their story in the room's form. The floor is checked on
  every save, in words, and again at submission, before the review (see
  [3. Edit the draft](#3-edit-the-draft)).
- **Design is a set of forms, not files.** Learners read your background,
  the stories to design for and the brief, and build their design in the
  room's forms, starting from the documents you set in step 4. Only the
  contracts and the sequence diagram you switched on are shown and graded.
- **Deployment's runbook is a tab of forms.** Learners edit the
  configuration files in the IDE, with the pipeline and the drill beside
  them, and write the runbook in the Runbook tab: Environment, Health
  checks, Rollback (in order, each step moved up or down), Data, the
  Incident and Notes, starting from the runbook you set in step 3. In a
  phase with a drill, the incident is written from the drill page when the
  learner closes the incident, and the tab shows it read-only. The floor is
  said in words above the forms, and **Check the runbook** lists each rule
  as passed or not yet, updating as the learner edits.
- **Maintenance's change request is a room of four tabs.** Learners edit the
  code in the IDE and write the change request in the change room:
  **Request** (your ticket, read-only, and what the change touches),
  **Contract** (shown only when you switched the contract on: where the
  phase mounts `design/contracts.json`, the contract for the operation the
  Request tab names, with Add off and "Name the operation on the Request tab
  first." until one is named; then the amendments they declare), **Checks**
  (the regression run, the verdict on each acceptance line, the tests that
  cover each acceptance line, and the floor in words with **Check the change
  request**, which lists each rule as passed or not yet) and **Release**
  (the version, the summary, the change lines, the rollback, the risks and
  notes). No learner sees the runbook or the change request as a file.

---

## 6. The seven run shapes

A project may declare runs only in these shapes. They are exactly the shapes the
platform's reference project uses, and the runner builds every test command
itself.

| Shape | What it is |
|---|---|
| `run-python-hidden` | A Python test run with a hidden suite: pytest for the learner, unittest for the sealed run |
| `run-typescript-hidden` | A TypeScript test run with a hidden suite, built by esbuild and run by the JavaScript harness |
| `run-python` | A Python test run with no hidden suite, run by pytest |
| `run-typescript` | A TypeScript test run with no hidden suite, built by esbuild |
| `smoke-python` | A smoke check: `python3`, one of the smoke files the project ships, and optionally `--selfcheck`, nothing more |
| `preview-python` | The live preview or its seed: `python3` and one Python file the project ships, with no argument |
| `drill-faulted-files` | An incident drill declares no command: it swaps in its faulted files and runs the smoke check again |

What this means in practice is spelled out in the run shapes part of
[authoring-format.md](authoring-format.md#run-shapes-the-closed-list).

---

## 7. Upload refusals

A refused upload imports nothing. Each sentence below is shown exactly as
written. The first column is the reason's code, the name the server's answer
gives it. How to fix each one is on the Teacher guide page in the app, under
**Every refusal, and how to fix it**, and under every refusal on the upload
page.

| Code | What the page says |
|---|---|
| `PATH_CLIMB` | An entry in this archive climbs out of the project folder or starts at the root of the disk, so nothing was imported. |
| `SYMLINK` | An entry in this archive is a symbolic link, and an upload holds ordinary files only, so nothing was imported. |
| `DUPLICATE_NAME` | Two entries in this archive have the same name, so which one a learner would get cannot be told, and nothing was imported. |
| `CASE_COLLISION` | Two entries in this archive differ only in upper and lower case, which some disks treat as one file, so nothing was imported. |
| `NUL_IN_NAME` | An entry name in this archive holds a control character, such as a null, so nothing was imported. |
| `RATIO_BOMB` | An entry in this archive unpacks to more than 100 times its packed size, so nothing was imported. |
| `TOTAL_SIZE_BOMB` | This archive unpacks to more than the upload limit, so nothing was imported. |
| `TOO_MANY_ENTRIES` | This archive holds more than 2,000 entries, so nothing was imported. |
| `ENCRYPTED_ENTRY` | An entry in this archive is encrypted, and an upload is read as it is, without a password, so nothing was imported. |
| `ZIP64_OR_SIZE_MISMATCH` | An entry in this archive declares a size or checksum it does not have, or a large-archive (ZIP64) size or position beyond the upload limit, so nothing was imported. |
| `CRC_MISMATCH` | An entry in this archive does not match its own checksum, so it is damaged and nothing was imported. |
| `RUNTIME_OUTSIDE_PROFILE` | This project asks for a library this deployment does not bake. This deployment runs Flask and React. Adding a library is a platform change, not a content change. Nothing was imported. |
| `RUN_LIMIT_ABOVE_LEARNER` | A run in this project asks for more time or memory than a learner's run gets, and an upload can never raise those limits, so nothing was imported. |
| `RUN_SHAPE_NOT_ALLOWED` | A run in this project declares a command or a harness outside the shapes this platform runs, so nothing was imported. |
| `TWO_WORK_TASKS` | A coding, testing or deployment phase in this project holds more than one work task. Several tasks in a coding, testing or deployment phase arrive next. Nothing was imported. |
| `HIDDEN_IN_WORKSPACE` | A file a learner reads in this project holds the bytes of a hidden test, so the hidden suite would be shown and nothing was imported. |
| `SOLUTION_IN_EDITABLE` | A file a learner edits in this project holds the bytes of the reference solution, so the answer would be handed out and nothing was imported. |
| `CEILING_PER_PHASE` | One phase of this project would boot more than 10 microVMs for one full pass, and the ceiling is 10 a phase, so nothing was imported. |
| `CEILING_PER_VERSION` | This project would boot more than 24 microVMs for one full pass, and the ceiling is 24 a version, so nothing was imported. |
| `RESERVED_NAME` | When the address a title makes is taken or kept for the platform, a number is added to the end of it, such as -2, and the upload goes ahead. |
| `SECRET_FILE` | This archive holds a file shaped like a secret, such as an environment file, outside the one example a project may ship, so nothing was imported. |
| `ARCHIVE_TOO_LARGE` | This archive is larger than the upload limit, so nothing was imported. |
| `NOT_A_ZIP` | This file is not a zip archive, so nothing was imported. |
| `NOT_A_PACK` | This archive is not a project in the authoring format, so nothing was imported. |
| `WARMUP_NOT_UPLOADABLE` | This project declares a warm-up, and an upload cannot carry one, so nothing was imported. Remove the warm-up and upload again. |
| `TITLE_INVALID` | A project needs a title of 1 to 120 characters, because its address is made from it, so nothing was imported. |
| `UNSUPPORTED_ARCHIVE` | An entry in this archive is compressed in a way this upload does not read. An upload reads stored and deflated entries only, so nothing was imported. |
| `EMPTY_ARCHIVE` | This archive holds no files, so nothing was imported. |
| `ARCHIVE_NAME_TOO_LONG` | An entry name in this archive is longer than 1,024 bytes or has more than 64 parts (folders and the file name), so nothing was imported. |

An upload is not refused with `RESERVED_NAME` today: when the address a title
makes is taken or kept for the platform, a number is added to it instead
(section 2).

When the answer carries no code (too many uploads in a minute, a session that
ended, or no answer in time), the page says "What to try next": Wait a minute,
then upload the archive again. If the upload ran out of time, look in Your
projects for the draft first. If you were signed out, sign in and try once
more.

Under **Run shape** and **Run limit**, each finding has a sentence of its own:

| Finding | Sentence |
|---|---|
| Command as text | A command is written as one string. A project may declare a command only as a list of words in a shape the runner already knows, never as shell text. |
| Own command | A test run or a check declares its own command. Every test run, hidden suite and drill runs under the runner's fixed command, so the key is refused. |
| Interpreter | A command starts with an interpreter other than python3, the only one a project may name. |
| Script | A command's second word is not a Python file this project ships. It must name a shipped script, never a flag or inline code. |
| Extra argument | A command passes an argument after its script that is not allowed there. A smoke check may pass only --selfcheck, and every other command passes nothing. |
| Shell character | A command word holds a shell character or a space. No run shape needs one, so it is refused. |
| Harness | A test run asks for a language, a harness or a build step outside the run shapes this platform grades with. |
| Hidden suite | A hidden suite must be test files the runner executes with its own fixed command: Python files whose names start with test_, or TypeScript files ending in .test.ts or .test.tsx. |
| Time | A run asks for more than the 15 seconds a learner's run gets. A project can never raise that limit. |
| Memory | A run asks for more than the 256 MB a learner's run gets. A project can never raise that limit. |

### The line under "not a project in the authoring format"

"This archive is not a project in the authoring format" adds one line that
names the folder, file or member to fix, in one of the sentences below. The
examples use one project's folders; yours name your own.

**The phases and `project.json`.**

- "The archive holds no phase folder under phases/. A project holds at least
  one of LearnSDLC's six phases."
- "phases/07-review: review is not one of LearnSDLC's phases. A phase folder
  is named for its key: requirements, design, implementation, testing,
  deployment or maintenance." A key is read as written, so a capital letter
  (`phases/03-Implementation`) is refused the same way.
- "phases/02-design and phases/03-design both hold design. A project holds
  each phase once."
- "phases/03-implementation has no phase.json."
- "project.json names a warm-up folder, and a warm-up is found by its folder
  now. Remove warmup from project.json." A `warmup/` folder in the archive
  is refused with the warm-up sentence in the table above.

**What `phase.json` may not name.**

- "phases/03-implementation/phase.json names its key or order, and the
  folder's name says both now. Remove key and order."
- "phases/03-implementation/phase.json names files. Put each file under
  files/ or readonly/ at the path the learner sees, and remove files."
- "phases/03-implementation/phase.json names solutionDir, a folder the layout
  fixes. Put the solution under solution/ and remove solutionDir." The same
  shape names `hiddenTestDir`, `referenceDir`, `implDir`, `mutantsDir`, the
  `implFiles` or `supportFiles` map, `smoke.implFiles`, `drill.faultedFiles`
  and `interview`, each with the folder or file it belongs in.
- "phases/03-implementation/phase.json: Implementation keeps its brief in
  taskPanel, not in a file."
- "phases/03-implementation's phase.json task block: the brief is the
  phase's taskPanel now; move it there."

**The folders of a phase.**

- "phases/03-implementation/file/ is not one of a phase's folders. A phase
  folder holds files/, readonly/ and quizzes/, and by its kind hidden_tests/,
  solution/, reference/, impl/, mutants/, smoke/ or drill/."
- "phases/04-testing/hidden_tests/ belongs to a code phase, and testing is a
  tests phase." The same shape names `solution/` outside a coding phase,
  `reference/`, `impl/` or `mutants/` outside a testing phase, and `smoke/`
  or `drill/` outside a deployment phase.
- "phases/02-design/interview.json: only Requirements holds a stakeholder
  interview."
- "phases/03-implementation: the run api has no hidden_tests/api/ folder.
  Each run's hidden suite sits under hidden_tests/ in a folder named for the
  run's id."
- "phases/03-implementation/hidden_tests/web names no run of the phase. Each
  folder under hidden_tests/ is named for a run's id."
- "phases/03-implementation/hidden_tests/test_extra.py sits in no run's
  folder. Each run's hidden suite sits under hidden_tests/ in a folder named
  for the run's id."
- "phases/03-implementation/hidden_tests/api/test_hidden_tasks.py sits at no
  workspace path: a hidden test sits at the path it runs from, for example
  hidden_tests/api/tests/test_hidden_tasks.py."
- "phases/03-implementation has no solution/ folder. A code phase holds its
  reference solution under solution/."
- "phases/04-testing has no reference/ folder. A tests phase holds its
  reference suite under reference/."
- "phases/04-testing/mutants/off_by_one.py sits in no mutant's folder. Each
  mutant is a folder under mutants/ holding its meta.json and the files it
  changes."
- "phases/05-deployment/drill/ holds files, but phase.json declares no
  drill. Declare the drill in phase.json or remove the folder."
- "phases/04-testing/quizzes/notes.txt is not a quiz file. A quiz is
  quizzes/<task key>.json." (a folder under `quizzes/` is named the same
  way)
- "phases/04-testing/quizzes/testing.json: testing is the key of the phase's
  work task. A quiz file is named for a task key of its own."
- "phases/04-testing/quizzes/<name>.json: <name> is not a task key. A task
  key is lower case, opens on a letter and is at most 32 characters, so that
  a learner's work follows the task across versions rather than its
  position."

Nothing under a sealed folder or `quizzes/` is dropped in silence.

**The files and what the checks name.**

- "phases/03-implementation/solution/api/x.py completes no file the learner
  edits."
- "phases/04-testing: checks names web/src/lib/overdue.ts in implFiles,
  which impl/ does not hold."
- "phases/03-implementation/files/api/main.py and readonly/api/main.py are
  one path. A file is editable or read-only, never both."
- "phases/05-deployment/drill/docker-compose.yml faults a file the phase
  does not mount."
- "phases/05-deployment: the smoke command runs api/main.py, which smoke/
  does not hold."
- "phases/01-requirements/quizzes/concepts.json is not a quiz: " and the
  reason the editor's quiz form would give, for example
  "phases/01-requirements/quizzes/concepts.json is not a quiz: A pass mark
  is a whole percentage from 0 to 100, and this one is 500. A mark above 100
  is a gate no paper can clear."

**What a local run, an editor or a secret leaves.**

- "phases/03-implementation/files/api/__pycache__ is machine output. Remove
  it from the archive and upload again." The same for a `node_modules`,
  `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.venv` or `venv`
  folder and a `.pyc` or `.map` file, naming its path.
- "phases/03-implementation/files/.vscode is an editor's settings folder.
  Remove it from the archive and upload again." (and `.idea`)
- "phases/03-implementation/hidden_tests/api/.helper.py: a sealed file's
  path has no part that starts with a dot, so the editor could not replace
  it. Rename it and upload again."
- "canonical/ is not read in an upload. Put each file a phase mounts under
  that phase's files/ or readonly/ folder, and upload again."
- "<path> looks like a secret (a .env file, a private key or a credential).
  Leave secrets out of the archive and upload again." (a `.env.example`
  included). An archive in the older layout keeps the older sentence, whose
  one exception is `canonical/.env.example`.

**An archive in the older layout.** Its lines name your archive's own phase
folders, as its `project.json` lists them. Two kinds name the folder the
conversion wrote instead, `phases/<NN>-<key>` numbered by the phase's place:
a sealed file whose path has a part that starts with a dot, and a
secret-shaped or machine-output file at a path the conversion wrote. A brief
the upload refuses is named at your folder's `phase.json`, even when the
brief came from a task file or from the task block's `brief`. Its task
blocks are measured as you wrote them, before the conversion, so a space or
line break at either end counts toward a limit there; a folder-layout
block's texts are trimmed first. One sentence
is the older layout's own: "phases/04-testing: checks.supportFiles gives
tests/clock.py other bytes than its read-only mount, and the folder layout
holds one copy of a path. Make the two the same file and upload again."

**Left out, never refused.** Desktop files are named in the upload's
warnings, not refused: "left out: phases/03-implementation/files/.DS_Store
is a desktop file" for each of the first five files, then "left out: <n>
more desktop files", and "left out: __MACOSX/ is a desktop folder" for each
such folder.

---

## 8. Export a version

Export turns a version of your project back into an archive in the folder
layout (section 1), one you could upload again. The **Export as an archive** button is in
the editor header, for the project's owner. When the archive is saved, the page
says so. If the export is refused, the page shows the refusal's sentence
instead.

What the export does:

- **Only the owner.** Your own project exports. Another teacher's project is
  "not found". An administrator cannot export a teacher's project. The
  platform's own project cannot be exported; copy it to make a project of your
  own.
- **It includes your sealed files.** The archive holds your hidden tests,
  solution, reference suite, implementation and mutants, so keep it where only
  you can read it.
- **A copy keeps what it inherited sealed.** If your project is a copy of one
  you do not own, the sealed files that came with it are left out. The page
  says how many were left out; it does not list them. Such an archive may be
  refused when you upload it, or it may upload with a smaller suite: if all
  that was left out is a whole mutant, or some of a run's hidden tests, the
  upload takes the mutants and hidden tests that remain and grades with those.
  Before you upload it again, write your own hidden tests, solution and
  mutants into it, and check that its suite is the one you mean.
- **No warm-up.** An export never carries a warm-up. A copy of a project that
  has one exports without it, so the archive can be uploaded again.
- **The file** is named `<project-address>-<version>.zip`. It is a plain stored
  zip with entries in a fixed order and a fixed date, so exporting the same
  version twice gives the same bytes.
- **It is checked before it leaves.** The archive is read back with the upload's
  own reader and limits, and refused by its sentence if the upload would refuse
  it. It is then compiled again through the upload's own door and compared
  with the version, task by task, each text as plain text, and file by file,
  each file's path, whether learners edit it, its language and its bytes: if
  any phase would compile to a different task or mount different files, the
  export is refused.
- **Round trip.** Uploading an export gives a new draft with the same tasks, run
  shapes and sealed files. It is not byte-for-byte the archive you first
  uploaded: JSON files are rewritten from what the platform holds, and files no
  phase uses (a README beside `project.json`, for example) are not kept.
- **The folder layout.** Each phase the version holds is one folder,
  `phases/<NN>-<key>`, numbered by its place in the version. Every file is
  written under `files/` or `readonly/` at the path learners see, in every
  phase that uses it, and no `canonical/` folder is written. An archive you
  uploaded in the older layout comes back in the folder layout.
- **Every edit travels.** Each `phase.json` is written from the task as you
  last saved it in the editor: its title, brief, objectives, criteria,
  checks, sign-off mark and files. Every text is written as plain text, so a
  version published before the plain-text rule exports plain text.
- **Quizzes travel.** Each concept quiz is written as
  `quizzes/<task key>.json`, with its title, its brief, its place among the
  phase's tasks, its objectives, whether it is required, and its questions.
- **The Requirements phase travels as its `phase.json`.** The provided
  stories, the learner's story and the floor are written in its checks, and
  the stakeholder as `interview.json` beside it. The learner's starting record
  is written too, as `files/requirements/story.json`, only when it is not the
  empty one the upload creates; an empty record is left out and made again on
  upload. Uploading the export gives the same phase.
- **The Design phase travels as its `phase.json`.** The stories to design
  for, the three switches and the floor are written in its checks, and the
  brief in its task panel; no task file and no markdown are written. The
  starting documents (the design record and each contract) are written under
  `files/` only when they are not the empty seeds the upload creates.
  Uploading the export gives the same phase.
- **Deployment and Maintenance travel as their `phase.json`.** Deployment's
  runbook floor, and Maintenance's ticket, contract switch and floor, are
  written in their checks, and each brief in its task panel; no task file
  and no markdown are written. The starting runbook is written as
  `files/deployment/runbook.json` and the starting change request as
  `files/maintenance/change-request.json`, unless it is the empty one the
  upload creates again. A version whose Deployment or Maintenance
  is still in the older format is written as it was, and its upload converts
  it. Uploading the export gives the same phase.
- **Recorded.** Each export writes one row in your record of changes: the
  version, the number of entries and how many files were withheld.

Exporting a draft whose last edit failed validation is allowed: the archive is
the draft as you left it, and uploading the archive again validates it
afresh. An export only reads the draft, so it is
never refused for a failed validation. It is refused only when there is nothing
to write, or the archive could not hold the version as it stands, or the upload
would refuse the archive.

An export is refused, with a sentence, when:

- the version holds no compiled snapshot. Open it in the editor, save once, and
  export again,
- a phase holds no work task, only quizzes: "Testing holds no work task, only
  quizzes, and a phase folder holds its work task. Put the phase's task back,
  or remove the phase, and export again." (naming the phase),
- a phase is graded by a kind of check the archive layout cannot hold,
- a phase other than Requirements and Design is a written phase in the
  older format, which nothing grades any more ("This version's Testing is a
  written phase in the older format, which LearnSDLC no longer grades, and
  cannot be assigned.", with that phase's title),
- a run has no visible test or no implementation file,
- in a Testing phase, one run holds its own copy of a suite or implementation
  file that differs from the phase's. The archive holds those files once for
  every run, so write the same file for every run,
- a sealed file's path cannot be written back where the loader reads it:
  "Testing holds "<path>", which the archive layout cannot carry where the
  loader would read it back (a sealed file needs a folder in its path, no
  part starting with a dot, and no build-output name). Rename it in the
  editor and export again." The same sentence answers any file the folder
  walk would leave out or refuse, under an editor's settings folder or with
  a desktop file's name for example, though the brackets name only the
  sealed-file and build-output rules. It also answers a testing phase's
  support file that the phase does not mount read-only with the same bytes;
  there the fix is to make the support file and its read-only copy the same
  file, not to rename it,
- a phase names a sealed file whose bytes the version no longer holds,
- the version would be larger than an upload accepts, or hold more than 2,000
  files,
- the archive, read back with the upload's own reader and checks, would be
  refused by the upload, or would compile a phase to a different task than
  the version holds: "This version would make an archive the upload
  refuses, so it is not exported: the archive would compile Testing to a
  different task than this version holds, so it is not exported." The
  folder layout cannot carry every edit the editor allows. Undo a change of
  what a task hands in, a work task's key you renamed, or a task you made
  optional, then export again. A quiz you moved before the phase's work task
  comes back in that place only when its key sorts before `main`, the work
  task's key; otherwise the export is refused the same way, so put the quiz
  after the work task.

---

## 9. Sign off one task for many learners

Some tasks need a teacher's countersignature before the phase opens.

### Mark a task as needing your sign-off

In the project editor, under **Phases and their tasks**, each task row has a
checkbox, **Needs your sign-off**. A quiz has none. Above a phase's tasks the
editor says what the mark does:

> A learner who passes a task marked “Needs your sign-off” waits in their
> class’s sign-off queue until you sign it off. Until then the task does not
> count as passed, so a required one keeps the next phase shut. A mark is saved
> as soon as you change it and reaches only the versions you publish from now
> on, because a published version never changes. An export of the version
> carries it.

So:

- The mark is saved the moment you tick or clear it. Nothing else on the task
  is saved with it.
- Only versions published after the mark carry it. A version that is already
  published, and every class assigned to it, keeps the tasks it was published
  with. Mark the draft, publish a new version, and assign it.
- On a version that cannot change, the checkbox is shown but cannot be changed,
  and the editor says why.
- An export carries the mark in the phase's `task` block, and uploading that
  archive again gives a draft whose task is marked the same way (see
  [section 8](#8-export-a-version)).

### The sign-off queue

The class view lists the learners waiting under **Awaiting your sign-off**:
one group per task, in phase order, each listing the learners waiting on it by
name and how long each has waited. A learner appears there once they pass a
marked task on a version published with the mark. The list is further down the
class view. The **Sign-off queue** button in the class view's header takes you
to it, and each class on the teacher home has a **Sign-off queue** link that
opens that class at the list. When nothing is waiting, the list says so:

> Mark a task as needing your sign-off in the project editor. Learners on a
> version published with that mark appear here once they pass it.

To sign off:

1. Pick the task, then tick the learners.
2. Give one reason of at least 10 characters. It is recorded for every learner
   in the batch.
3. Confirm.

At most 200 learners go in one batch. Each learner is signed off separately, so
one refusal does not stop the rest. The result lists who was signed off and,
for anyone who was not, one sentence saying why, for example:

- "This learner is not in this class, so nothing was signed for them."
- "… is not awaiting a countersignature for this learner, so nothing was
  signed."
- "A newer revision of … is still being marked for this learner, so nothing
  was signed; try again once its verdict is in."
- "This learner has more than one project awaiting that task, so nothing was
  signed; sign it off on their own page."

Each signed learner gets one row in the record of changes. Signing off a single
learner from their own page works as before.

### When you mark a phase as passed

Marking a phase as passed for one learner credits it on your class board at the
pass mark, with your reason in the learner's audit. It does not stand in for the
review: the learner still submits that phase for a reviewed pass before they can
move on, and their detail page says so ("Waiting on a reviewed pass of …").
Until then the class page names the phase **Credit awarded, review still
needed**; a reviewed pass reads **Review passed**, and a pass waiting on your
countersignature reads **Awaiting your sign-off**.

---

## 10. Download quiz results

The teacher page's download row has a **Quiz results** choice and **Download the
quiz results**. It saves one of four CSV files for the learners in your classes.
An administrator gets every class.
On a class's own page the file covers that class only, and the row says "For
this class only."; on the teacher home it covers every class of yours, and says
"For every class of yours."

| File | One row per | Columns |
|---|---|---|
| `quiz-learners.csv` ("One row per learner and quiz") | learner, project and quiz task they handed a paper in on | email, displayName, class, project, phaseKey, taskKey, attempts used, attempts voided, best score, latest score, passed, first submittedAt, last submittedAt |
| `quiz-attempts.csv` ("Every attempt") | handed-in or voided paper | email, displayName, class, project, phaseKey, taskKey, epoch, attempt, status, score, passed, startedAt, submittedAt, packVersion |
| `quiz-questions.csv` ("Every question drawn, right or wrong") | handed-in paper and question it drew | email, class, project, taskKey, epoch, attempt, position, questionId, outcome |
| `quiz-class.csv` ("Each question across the class") | class, project, quiz task and question drawn in that class | class, project, taskKey, questionId, times drawn, times right, % right, learners attempted, learners passed |

What to know when reading them:

- Scores and pass results are the values stored when each paper was graded.
  Nothing is regraded.
- A paper still open is not in any file. A paper voided by a reset is listed as
  voided, with no score and no attempt number.
- `outcome` is `right` or `wrong`.
- **Never included:** the answer key, explanations, question text, option text,
  which options a learner picked, questions a paper did not draw, internal ids,
  and learners outside your classes.
- A cell that would start a spreadsheet formula is written as plain text.
- Each kind can be downloaded 5 times a minute.

The class export and the grade book cover every class of yours, and their
buttons say so: **Download the grade book (all your classes)** and **Download
the grades (all your classes)**. On a class's page, **Download this class's
grade book** and **Download this class's grades** hold that class only. Each
button's line under it says how many learners the file covers.

### See a class's quiz results as charts

In the class view's header, **Quiz results**, beside **Sign-off queue**, opens
that class's quiz results on a page of their own. For each quiz task it shows:

- The attempts handed in, and how many of the class's learners attempted it,
  passed it and have not yet passed it.
- The mean and median best score, and a chart of best scores in five bands:
  0-19, 20-39, 40-59, 60-79 and 80-100.
- The pass rate (learners passed out of learners attempted), as a bar.
- How often each question was answered right, by its `questionId`.

A table lists each learner's attempts, best score and whether they passed.
The page counts the same stored scores with the same code as the four files
above, so the two always agree, and nothing is regraded. A score is each
learner's best stored score. Every chart has a table of its numbers. No
question text, option, answer key or explanation is shown.
A quiz on the class's assigned version is listed before anyone sits it, as
**No attempts yet.**
A class with no learners, or with no quiz yet, says so. Four buttons download
the four files for this class only. The page can be opened 20 times a minute.

---

## What uploads do not do yet

- No second runtime profile, and no new libraries by upload.
- No warm-up in an uploaded project.
- Only one work task in each executable phase.
- No adding Implementation, Testing, Deployment or Maintenance in the
  browser: their files, tests and solution come by upload.
- No editing of the smoke check, the drill, which files a learner edits, run
  shapes, or coverage keywords in the editor. Upload again as a new project.
- No replacing a starter or visible-test file in Implementation, Testing,
  Deployment or Maintenance in the editor.
- No uploading into an existing project. Every upload is a new project.
- No App preview for uploaded applications: your application's server is
  never started for a learner. A room with a page draws the page preview
  instead, its page code run in the browser with sample data.
