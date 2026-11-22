# Authoring a reference project

A reference project is a **directory of data** under `content/<slug>/`:
no platform code changes are needed to add one. The API's `ContentService`
loads every bundle at boot; check logic is generic and configured from the
bundle.

The folders are the manifest. `project.json` lists no phases, and every
folder under `phases/` is a phase; a phase's files sit in its folder at the
workspace paths learners see. A platform pack under `content/`, a teacher's
upload and an export are all in this one layout, which
[The archive layout](#the-archive-layout) sets out in full.

```
content/<slug>/
├── project.json            slug, version, title, tagline, description,
│                           language, languages, build, runtime, preview;
│                           no phase list and no warm-up name
├── canonical/              the maintainers' complete, correct implementation:
│                           no loader reads it, and the content check holds
│                           every read-only copy of it equal to it
├── warmup/                 the warm-up, found by its folder (below)
└── phases/NN-<key>/
    ├── phase.json          everything about the phase (below); the brief
    │                       is its taskPanel, in plain text
    ├── files/<path>        a file the learner edits, mounted at <path>
    ├── readonly/<path>     a file the learner reads and cannot change
    ├── interview.json      (Requirements) the stakeholder interview
    ├── hidden_tests/<run id>/<path>
    │                       (code phases) a run's suite, run only on
    │                       submission
    ├── solution/<path>     (code phases) reference solution; powers the
    │                       assistant's answer-withholding redaction
    ├── reference/<path>    (tests phases) the reference suite
    ├── impl/<path>         (tests phases) the implementation it passes on
    ├── mutants/<name>/     (tests phases) buggy variants + meta.json
    ├── smoke/<path>        (config phases) the files the smoke run builds
    └── drill/<path>        (config phases) the drill's faulted copies
```

A pack may span two languages. Every folder a phase reads is walked
**recursively**, and each `<path>` is the workspace path the file lands on,
exactly: `solution/api/repository/tasks.py` completes
`api/repository/tasks.py`, and `solution/web/src/lib/overdue.ts` completes
`web/src/lib/overdue.ts`. No file is matched by its name alone, and no flat
folder lands under `tests/`. A file a phase both lets the learner edit and
locks is refused, naming both: "phases/03-implementation/files/api/main.py
and readonly/api/main.py are one path. A file is editable or read-only, never
both."

## The archive layout

One layout for every pack: a platform pack under `content/`, a teacher's
upload, and an export.

```
<folder>/project.json                          the project: slug, version, title, tagline, description,
                                               language, languages, build, runtime, preview; no phase list
<folder>/phases/<NN>-<key>/phase.json           the phase: title, intro, artifactKind, canRun, runLabel,
                                               canPreview, taskPanel, objectives, rubric, checks, assistant,
                                               and the task block; no file, folder or source names
<folder>/phases/<NN>-<key>/files/<path>         a file the learner edits, mounted at <path>
<folder>/phases/<NN>-<key>/readonly/<path>      a file the learner reads and cannot change, mounted at <path>
<folder>/phases/<NN>-<key>/interview.json       Requirements: the stakeholder interview
<folder>/phases/<NN>-<key>/quizzes/<task key>.json   a concept quiz of the phase
<folder>/phases/<NN>-<key>/hidden_tests/<run id>/<path>   code: a run's hidden suite         (sealed: hidden)
<folder>/phases/<NN>-<key>/solution/<path>      code: the reference solution                  (sealed: solution)
<folder>/phases/<NN>-<key>/reference/<path>     tests: the reference suite                    (sealed: reference)
<folder>/phases/<NN>-<key>/impl/<path>          tests: the implementation it is graded against (sealed: reference)
<folder>/phases/<NN>-<key>/mutants/<name>/meta.json and <path>   tests: one mutant              (sealed: mutant)
<folder>/phases/<NN>-<key>/smoke/<path>         config: a file the smoke run builds from        (not sealed)
<folder>/phases/<NN>-<key>/drill/<path>         config: the drill's faulted copy of <path>     (sealed: drill)
<folder>/warmup/                                a platform pack's warm-up (refused in an upload)
```

Every `<path>` is the workspace path the file lands on, exactly: no
basename matching, no flat folder landing under `tests/`, no source
elsewhere.

**The phases.** Each folder under `phases/` is one phase, named `<NN>-<key>`
or `<key>`, where the key is one of `requirements`, `design`,
`implementation`, `testing`, `deployment` and `maintenance`. The phases are
ordered by LearnSDLC's order, whatever the numbers say: `NN` is for people
and is not read. A project holds the phases its author chose, at least one,
each once. These are refused by name:

- "The archive holds no phase folder under phases/. A project holds at least
  one of LearnSDLC's six phases."
- "phases/07-review: review is not one of LearnSDLC's phases. A phase folder
  is named for its key: requirements, design, implementation, testing,
  deployment or maintenance." (a key is read as written, so
  `phases/03-Implementation` is refused the same way)
- "phases/02-design and phases/03-design both hold design. A project holds
  each phase once."
- "phases/03-implementation has no phase.json."

**The folders a phase holds.** A phase folder holds `phase.json`, the fixed
files and folders above, and only those its kind uses: `files/`, `readonly/`
and `quizzes/` in every phase; `interview.json` in Requirements;
`hidden_tests/` and `solution/` in a code phase; `reference/`, `impl/` and
`mutants/` in a tests phase; `smoke/` and `drill/` in a config phase. Any
other folder directly inside a phase folder is refused by name, so a typo
never drops learner files, suites or quizzes in silence: "phases/03-implementation/file/
is not one of a phase's folders. A phase folder holds files/, readonly/ and
quizzes/, and by its kind hidden_tests/, solution/, reference/, impl/,
mutants/, smoke/ or drill/." A kind's folder in a phase of another kind is
refused the same way, for example "phases/04-testing/hidden_tests/ belongs
to a code phase, and testing is a tests phase.", and an interview outside
Requirements with "phases/02-design/interview.json: only Requirements holds
a stakeholder interview." A loose file beside `phase.json` that is not one
of its fixed names (a `NOTES.md`, a `README.md`), and a file outside
`phases/` (a `README.md` beside `project.json`, a platform pack's
`canonical/`), is the author's own and is neither stored nor refused. A
`canonical/` folder in an upload is refused ("canonical/ is not read in an
upload. Put each file a phase mounts under that phase's files/ or readonly/
folder, and upload again."). A `quizzes/` folder is read in an upload only:
a platform pack's tasks are its phases' own, so the boot refuses one
("phases/04-testing/quizzes/ is read in an upload only: a platform pack's
tasks are its phases' own.").

**The sealed roles** are the platform's own: `hidden_tests/` hidden,
`solution/` solution, `reference/` and `impl/` reference, `mutants/` mutant,
`drill/` drill. `smoke/` is not sealed. A file a run or the phase names in
`supportFiles` keeps the support role and is one of the phase's `readonly/`
mounts.

### What the loader derives

| Fact | Derived from | Replaces |
|---|---|---|
| The phase set and order | the folders under `phases/`, each named `<NN>-<key>` or `<key>`, ordered by LearnSDLC's order; `NN` is for people and is not read | `project.json` `phases[]`, `phase.json` `key` and `order` |
| A mount, its path and its editability | `files/<path>` (editable) and `readonly/<path>` (locked) | `files[]` `path`, `source`, `editable` |
| The mount order | every phase's mounts, `files/` and `readonly/` merged into one list, sorted by workspace path in code-unit order; the export writes in it | the `files[]` order |
| A mount's language | the path's extension (the table below); a record is always json | `files[]` `language` |
| The starting records | `files/requirements/story.json`, `files/design/design.json`, `files/deployment/runbook.json`, `files/maintenance/change-request.json` and the contract files at their paths; absent, the loader seeds the empty one | the record mounts at other paths |
| A code run's hidden suite | `hidden_tests/<run id>/` for each `checks.runs[].id`; a code phase with no `checks.runs` has the one run `main`, so its suite is `hidden_tests/main/` | `hiddenTestDir` |
| The solution, the reference suite, the implementation | `solution/`, `reference/`, `impl/` | `solutionDir`, `referenceDir`, `implDir`, the `implFiles` map |
| The mutants | `mutants/<name>/`, each with its `meta.json` (`name`, `description`, `covers`, `run`) | `mutantsDir` |
| The smoke run's files | `smoke/<path>` | the `smoke.implFiles` map |
| The drill's faulted files | `drill/<path>` | the `drill.faultedFiles` map |
| The interview | `interview.json` | `phase.json` `interview` |
| The quizzes | `quizzes/<task key>.json`, each `{ title, brief, order, objectives, required, checks }`: `brief` the quiz's plain brief, `order` its place among the phase's tasks, `checks` of the quiz kind as the editor stores it | nothing: an export refused every quiz |
| The warm-up | the `warmup/` folder of a platform pack | `project.json` `warmup` |
| The files a preview may run | the mounts every previewing phase holds | `canonical/` |

**Mount order is a rule, not an authored fact.** A folder walk cannot
reproduce an authored order, and the order matters: the store keeps a
phase's files as an ordered list, the explorer and the map draw them in it,
and the AI requests build their workspace and references from it. So the
order is fixed, sorted by workspace path, for every pack the loader reads.
A stored version keeps the order it was compiled with, because it is never
loaded from disk again.

**Languages.** A mount's language is read from its path:

| Extension or name | Language |
|---|---|
| `py` | python |
| `ts`, `tsx`, `mts`, `cts` | typescript |
| `js`, `jsx`, `mjs`, `cjs` | javascript |
| `json` | json |
| `sql` | sql |
| `html` | html |
| `yml`, `yaml` | yaml |
| `css` | css |
| `scss` | scss |
| `sh` | shell |
| `toml` | toml |
| `xml` | xml |
| `md` | markdown |
| `txt` | plaintext |
| the file name `Dockerfile` | dockerfile |
| anything else | plaintext |

The table reads the extension as written, so `X.PY` is plaintext. An
older-layout archive whose declared language differs from the derived one
is converted with the derived one, and the upload says so once per file:
"<path> was declared <language>; it is read as <derived language> by its
extension now."

**The folder walk.** Under `files/` and `readonly/`, a dot-prefixed file or
folder is a mount at its path like any other: TaskTrackr Deployment's `files/.github/workflows/ci.yml` mounts
`.github/workflows/ci.yml`, editable, and a `.gitignore` under `files/`
mounts at its path. A sealed file's path holds no part that starts with a
dot, because the editor could not replace it; an upload refuses one:
"phases/03-implementation/hidden_tests/api/.helper.py: a sealed file's path
has no part that starts with a dot, so the editor could not replace it.
Rename it and upload again." The secret rule still refuses by name (a
`.env*` or `*.env` file, a file under a `.ssh`, `.aws`, `.git`, `.gnupg` or
`.docker` folder, a credential name, a key or keystore extension) and a PEM
private key by content. In an upload, what a local run leaves behind is
refused by name, never skipped in silence: a `__pycache__`, `node_modules`,
`.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.venv` or `venv`
folder, or a `.pyc` or `.map` file, under `files/`, `readonly/`, `smoke/` or
a sealed folder ("phases/03-implementation/files/api/__pycache__ is machine
output. Remove it from the archive and upload again."), and an editor's
`.idea` or `.vscode` folder with a sentence of its own
("phases/03-implementation/files/.vscode is an editor's settings folder.
Remove it from the archive and upload again."). Desktop files are never
refused: a `.DS_Store`, `Thumbs.db` or `desktop.ini` file, an AppleDouble
`._<name>` file and a `__MACOSX/` folder, at any depth and under any folder,
are left out, never mounted, sealed or stored, and the upload names each in
its warnings ("left out: phases/03-implementation/files/.DS_Store is a
desktop file", "left out: __MACOSX/ is a desktop folder"; five files are
named one by one, then "left out: <n> more desktop files"). A platform
pack's folders on disk are walked the same way, except that machine output,
editor folders and desktop files are skipped there, because a maintainer's
local run leaves them.

**What stays in `checks`** is configuration, not layout, and it names
workspace paths where the grading needs a path chosen for a purpose:
`editableTargets`, `visibleTests`, `learnerTestFiles`, `runs[]` (with `id`,
the shape, `label`, `visibleTests`, `testPaths`, and as lists of workspace
paths `supportFiles` and `implFiles`), `coverageKeywords`, `minTests`,
`smoke.dockerfile`, `smoke.commands` (whose script is a path under
`smoke/`), `smoke.expect`, `rules[].target`, `drill.fault`,
`drill.description`, `runbook`, `ticket`, `change`, and the story and design
checks. Every path a check names must be a file of the folder it belongs to,
or the phase is refused by name, for example "phases/04-testing: checks
names web/src/lib/overdue.ts in implFiles, which impl/ does not hold."

**An archive in the older layout.** An upload whose `project.json` lists
`phases` is in the older layout, with a list of phases and of files and
pointers to folders. The upload door reads it once, honouring every
pointer exactly as the loader read it before (sources under its own
`canonical/`, mount paths that differ from folder paths, flat hidden
folders, `taskFile`, the interview's file or inline value, the task block's
`brief`), writes this layout in memory with each phase's mounts in path
order and each language derived from its path, and loads that. The upload
warns once: "This archive was in the older layout, with a list of phases and
files. It was read once; its export will be in the folder layout." Its own
`canonical/` folder is read for the files the phases source from it, and is
left behind. An archive is in one layout or the other: a pointer in an
archive that lists no phases is refused by name (below). The boot loader
reads only this layout.

## project.json

| Field | Meaning |
|---|---|
| `slug`, `version`, `title`, `tagline`, `description` | Identity. `version` is `MAJOR.MINOR.PATCH`, stamped on every enrolment and submission, so a score can be read against the pack that produced it |
| `language` | The pack's primary language: the project chip, the smoke interpreter, and the language a phase runs when it names no other |
| `languages` | Every language any phase of the pack runs, `language` among them. `python`, `javascript` and `typescript` are the three the runner has a harness for |
| `build` | How the front end is produced, in a pack that has one |
| `runtime` | What has to be pre-baked into the runner before the pack can run at all |
| `preview` | What the Run app button starts, in a pack the learner can run |

`languages`, `build`, `runtime` and `preview` are all optional: a pack that
omits them loads exactly as a pack always did, in one language, with no build
and no preview.

`project.json` names no phases and no warm-up: the folders under `phases/`
are the list, and a warm-up is the pack's `warmup/` folder. A `project.json`
that still names either is refused: "project.json lists phases, and the
folders under phases/ are the list now. Remove phases from project.json."
and "project.json names a warm-up folder, and a warm-up is found by its
folder now. Remove warmup from project.json." (A teacher's upload whose
`project.json` lists `phases` is in the older layout and is converted
instead; see [The archive layout](#the-archive-layout).)

### Changing a pack means bumping its version: this is a requirement

A pack is imported into the store at every boot, and a published version is
**immutable**: the learners working it are pinned to it, so a rubric, a hidden
suite or a phase title cannot move under an attempt. The importer is therefore
idempotent on `(slug, version)` *and* on the bytes it read, and the three
outcomes are different in kind:

| What is on disk | What the boot does |
|---|---|
| a version the store does not hold | imports it, compiles it, publishes it |
| the same version, the same bytes | nothing at all, and one log line |
| the same version, **different bytes** | **refuses to boot**, naming the version to bump |
| the same version, and it is still a draft | replaces the draft, because drafts are mutable |

So **every content change needs a new `version`**, and the refusal is what
stops the alternative: a redeploy that quietly changes nothing, with the fix
sitting in the image and the class still being graded by the old bytes. The
sentence says so out loud:

    tasktrackr is at 2.0.1, which is already published from different bytes.
    A published version is immutable — bump project.json's version to import
    this change.

**"The bytes it read" means every file under the pack directory**, by path and
by the sha of its contents: `project.json`, every `phase.json`, every file the
phases mount, every hidden suite, solution, reference, mutant, drill copy and
warm-up file, and anything else you put there. So a note you added beside
`project.json` is a change to the pack like any other and needs the same bump.

It is deliberately **not** a digest of what the loader or the compiler made of
those bytes. A digest taken over the compiled snapshot moves whenever the
platform's own code moves, so the first redeploy after a compiler change would
refuse to boot and tell you to bump a version for a change that was not yours.
When the code has moved and your pack has not, the boot says so in a warning
and carries on: the published version keeps the snapshot it was published with,
because that is what the learners pinned to it are working from.

`version` must be exactly `MAJOR.MINOR.PATCH` to be imported. The loader still
accepts a `-prerelease` or `+build` suffix for a pack that is only ever read off
disk, but the store resolves a project's newest published version by comparing
versions field by field as numbers (which is also why `2.0.10` is newer than
`2.0.9` here and would not be as a string), and a suffix has no place in that
order.

A bumped version becomes the head, and the version it supersedes stays
published and immutable. **Learners already enrolled stay on the version they
started**; new enrolments get the new one. Moving a class onto a new version is
an audited action of its own, so a content fix reaches new enrolments
immediately and existing ones when someone decides to move them.

To import a pack that is not under `CONTENT_DIR`, or to see the refusal on a
terminal rather than in a log, from the repository root:

    npx ts-node --project apps/api/tsconfig.json \
      apps/api/src/cli/import-pack.ts --pack content/tasktrackr

The command runs the boot's null-pin pass first, so an enrolment stored with
no pin is pinned to the version it was reading before this import can
publish another, and it prints that pass's line ("null pin: pinned <n>
enrolment(s) in <p> project(s) to the published version they read with no
pin; left <m> in <q> project(s) with no published version, to be pinned at
their project's first publish"). When the import publishes a project's first
version, it pins, in the same transaction, every enrolment of that project
still waiting with no pin, and prints after the import's own line "null pin:
pinned <n> enrolment(s) waiting on this project's first version" (only when
it pinned one).

### A pack in two languages

    "language": "python",
    "languages": ["python", "typescript"],

    "build": {
      "tool": "esbuild",
      "entry": "web/src/main.tsx",
      "outfile": "web/dist/app.js",
      "jsx": "automatic"
    }

`build.tool` is an enum of one on purpose. A pack names a tool the runner
already knows, never an argv, so content can never ask the sandbox to run a
command of its own. `entry` and `outfile` are workspace-relative and may not
escape the workspace.

### The runtime the pack needs

    "runtime": {
      "python": {
        "version": "3.11",
        "packages": ["flask==3.0.3", "pytest==8.3.4", "..."]
      },
      "node": {
        "version": "22",
        "packages": { "react": "18.3.1", "jsdom": "25.0.1" },
        "tools": { "esbuild": "0.24.2" }
      }
    }

Every version is pinned exactly (`name==1.2.3` for Python, a bare semver for
node), because a range would make what a learner runs depend on the day the
image was built.

**A pack may not add a dependency by editing content alone.** Every name is
checked at boot against the runner's own allowlist in `runtime_manifest.py`
(`ALLOWED_PYTHON`, `ALLOWED_NODE`, `ALLOWED_TOOLS`), and a name that is not on
it is refused, naming the package and the file to add it to. This is the one
place the pack is not the authority, and it is deliberate: what the jail can
import is a code change with a review, not a line in a JSON file. On a tree
with no manifest the check is skipped: there is no pre-baked layer there
either, and the run's own "the sandbox dependencies are not built on this
machine" is the honest answer.

### Running the app

    "preview": {
      "service": {
        "command": ["python3", "api/main.py"],
        "portEnv": "PORT",
        "health": "/api/health"
      },
      "web": { "root": "web/dist", "html": "web/index.html" },
      "env": { "TASKTRACKR_DB": "data/preview.sqlite" },
      "seed": ["python3", "ops/seed.py"]
    }

`preview.service.command` and `preview.seed` are validated exactly as a smoke
command is: the first word is `python3` or `node` and nothing else, and the
second is a file every previewing phase ships. `portEnv` is the environment
variable the kernel-chosen loopback port arrives in, `health` is the path the
runner polls until the app answers, and it must start with `/`.

`preview.env` keys may not collide with the variables the runner sets itself
(`PATH`, `HOME`, `PYTHONDONTWRITEBYTECODE`, `PYTHONHASHSEED`,
`TASKTRACKR_DATA`, `LEARNSDLC_NOW`, `LSDLC_PYLIB`, `NODE_PATH`, `ESBUILD_BIN`)
or with `portEnv` itself. A pack that could overwrite them could reach the
pre-baked layer or the clock.

A pack with no `preview` block cannot be previewed from any phase, and a phase
that claims `canPreview` in such a pack is refused at boot.

#### The opaque-origin contract, and why your front end must obey it

The preview is framed with `sandbox="allow-scripts allow-forms allow-modals"`
and **no** `allow-same-origin`. That is not a setting to loosen: it is what
stops a learner's own code, or code a learner was persuaded to paste, from
reading the page that frames it. The cost is that the frame is an opaque
origin, and four things a front end normally reaches for are unavailable inside
one:

- `localStorage` and `sessionStorage`: every access **throws**, and an
  unhandled throw in a module's top level is a blank page;
- `document.cookie`: reads and writes are silently dropped;
- `history.pushState`: unreliable, so path routing cannot be trusted.

So a previewable pack routes on the **hash** (`createHashRouter`, and the door
serves `index.html` for an unknown extensionless path so those routes work),
keeps its state in its own API, and stores nothing in the browser. The
reference pack does all three from its first line, and the content checker's
`no-browser-storage` greps the canonical `web/src/**` for all four names so a
violation fails the author rather than the learner, who would see a blank page
and blame themselves.

Two more things the door does for you, so the pack needs no special case:
`<base href="/api/v1/preview/<capability>/">` is injected after `<head>`, which
is why a relative `fetch('api/tasks')` reaches the learner's own API; and a
proxied `api/` call is answered with `Access-Control-Allow-Origin: null` and no
credentials, because an opaque origin's own fetches carry `Origin: null`. Write
the front end as if it were served from the root and it works unchanged in the
browser, in `docker compose up` and in the preview.

## phase.json

| Field | Meaning |
|---|---|
| `title`, `intro` | Display. The phase's key and its place come from its folder's name (`phases/03-implementation`), never from `phase.json` |
| `taskPanel` | The brief the learner works from, in plain text ([Plain text](#plain-text) below). It is the phase's one task's brief; there is no `task.md` |
| `artifactKind` | `story`, `design`, `code`, `tests` or `config` (`quiz` is a task's kind, not a phase's). There is no `markdown` kind (below) |
| `canRun`, `runLabel` | Whether the phase has a fast-feedback ▶ action |
| `canPreview` | Whether the learner can start the pack's own application from this phase. Optional, false unless the phase says otherwise, and the pack must declare a `preview` block for it to mean anything |
| `objectives` | Bullet objectives shown in the task panel header |
| `rubric` | `passThreshold` + weighted criteria (weights must sum to 1, enforced by a unit test) |
| `checks` | The grading configuration, by kind (below) |
| `assistant` | `systemPrompt` (used verbatim with the OpenAI provider), `topics[]` (keyword-matched hint ladders) and `progressive[]` (guidance that escalates with interaction count). An outright solution request is answered from them with the shallowest rung phrased as a question, never the deepest, so the last rung may be the most concrete, but no rung may contain the solution in prose (the content suite rejects hints carrying the completing assignment, the overdue comparison or the `filter(open)` call) |
| `task` | Optional: the phase's one task's own title, objectives and sign-off mark ([The task block in phase.json](#the-task-block-in-phasejson)) |

The files are not in `phase.json`: they are the phase's `files/` and
`readonly/` folders. **Locked files are always served from the bundle
server-side; a client can never overwrite them.** No member names a file, a
folder or a source, and each such member is refused by name, with the phase
folder it is in:

- "phases/03-implementation/phase.json names its key or order, and the
  folder's name says both now. Remove key and order."
- "phases/03-implementation/phase.json names files. Put each file under
  files/ or readonly/ at the path the learner sees, and remove files."
- "phases/03-implementation/phase.json: Implementation keeps its brief in
  taskPanel, not in a file." (a `taskFile`, in every phase)
- "phases/01-requirements/phase.json names interview, a file the layout
  fixes. Put the interview in interview.json and remove interview."
- the folder members of `checks` (below), each in the shape
  "phases/03-implementation/phase.json names solutionDir, a folder the layout
  fixes. Put the solution under solution/ and remove solutionDir."

### Plain text

A brief, an objective, an intro, a rubric sentence, a ticket or story line,
and a quiz's stem, options and explanations are plain text. Plain text keeps
its line breaks, a blank line separates paragraphs, and nothing in it is
interpreted: the learner reads it as written. What plain text allows, and
what a save in the editor or an upload changes in older text:

- **Code is kept as it is, its delimiters included.** A code span keeps its
  backticks, a fenced block keeps its two fence lines and every line between
  them, and a line indented four spaces or a tab is kept as it is.
- **A list is kept.** A dash, star, plus or list number that opens a line is
  kept with its item, as plain text writes a list, and so is a quote's `>`.
- **Headings and emphasis go.** A heading's `#` and the stars or underscores
  around words are removed; an underscore or asterisk inside a word
  (`list_tasks`, `a*b*c`) stays. A table row becomes its cells joined by
  "; ", and a link becomes its text followed by its address in brackets.
  Every word stays, in order.
- **An HTML comment is never shown to a learner.** It is kept in the stored
  text, for the author, and every display leaves it out.

A platform pack is written plain: the content check's `brief-plain` rule
("every brief and phase text is plain text") fails a phase's brief
(`taskPanel`), intro, objective, rubric criterion title or description, or
the mentor's system prompt or one of its hints, when the text is not equal
to its own plain form, naming the phase and the member
("implementation: taskPanel is not plain text"). A
teacher's upload is stored plain and says what it changed, once per phase
("Implementation's brief had markdown in it. It was kept as plain text,
every word in place; read it in the editor.").

## checks by kind

- **`story`** (Requirements only): `providedStories[]` (`id`, `title`, `persona`, `capability`, `benefit`, optional `criteria[]`), `learnerStory` (`id` or `"learner-picks"`, `hints`), `floor` (`minCriteria` 1..8, `requiredTags` from happy/boundary/error, `minExclusions` 0..6, `requireSentence`). The learner's record lives at `requirements/story.json` and the loader creates it; the phase mounts no files, and its brief is `taskPanel`. The review judges the rubric criteria over the record's fields; the floor is checked first.
- **`design`** (Design only): `record` (always `"design/design.json"`, the learner's record), `contracts` (`api` and `screens`, true or false: a contract that is off is neither mounted, seeded, shown nor graded), `sequence` (true or false, false when absent: on, the learner's record carries a sequence diagram that must name at least one of their operations and the floor checks it; off, its tab is hidden and nothing is graded for it), `stories[]` (`id` at most 16 characters, `title` and `line` at most 400, at most 12, ids unique), `floor` (`minEntities` 0..20, `minRelations` 0..40, `minOperations` 0..30, `operationShape`, `minDecisions` 0..10, `decisionShape`, `traceEveryStory`, `minEndpoints` 0..30, `requireErrorCatalogue`, `minScreens` 0..20, `screenShape`). The learner's record lives at `design/design.json`; the loader seeds it, and each contract that is on, when the pack ships none. The phase mounts no markdown, and its brief is `taskPanel`. The floor is checked first; the review judges the rubric's criteria over the record's and the contracts' fields, one citable path per field.
- **There is no `markdown` kind.** A phase whose checks still declare it is
  in the older written format. At the upload door, Requirements and Design
  convert from it as their sections above describe, and a phase under any
  other key is refused with the sentence that names it: "Testing is a
  written phase in the older format, and only Requirements and Design
  convert from it. Remove the phase from the pack or give it checks of its
  own." (naming Implementation, Testing, Deployment or Maintenance by its
  key, whatever the pack titles it). Every other phase has no written form:
  its work is code, tests or configuration, and a Deployment or Maintenance
  writes its document as a record (below). A pack under `content/`, which no
  door converts, may not declare the kind in any phase.
- **`code`**: `editableTargets` (analysed statically) and `visibleTests`.
  The sealed suite is the files under `hidden_tests/main/` and the reference
  solution the files under `solution/`, each at its workspace path; a phase
  with no `solution/` is refused ("phases/03-implementation has no solution/
  folder. A code phase holds its reference solution under solution/."), and
  so is a solution file that completes nothing the learner edits
  ("phases/03-implementation/solution/api/x.py completes no file the learner
  edits."). Scores map: hidden pass-rate →
  `correctness_hidden`, visible pass-rate → `visible_tests`, analyser findings
  → `code_quality`, run-before-submit + hint moderation → `process`. A phase
  that spans two layers declares `runs[]` instead, and gives each run its own
  `visibleTests` and its own folder under `hidden_tests/` (below).

  `ticket` and `change` (Maintenance only, always together): `ticket` holds
  `id` (at most 16 characters), `title` (at most 400), `summary` (at most
  2000) and `acceptance` (at most 12 lines, each an `id` of at most 16
  characters, unique in the ticket, and a `line` of at most 400; the editor
  names them `AC-1`, `AC-2` and onward). `change` holds `record` (always
  `"maintenance/change-request.json"`), `contract` (true or false, false when
  absent: on, the learner declares contract amendments and the change room
  shows the Contract tab; off, neither) and `floor`: `minImpact` (0..20),
  `minContract` (0..20, read only when `contract` is on), `minTests`
  (0..20), `requireRelease` and `traceEveryAcceptance` (true or false). A
  floor member left out takes 1 for each minimum and true for each switch.
  The phase ships the starting change request as
  `files/maintenance/change-request.json`, mounted editable at
  `maintenance/change-request.json` and valid as it ships (every
  `covers` id one of the ticket's acceptance ids); the loader mounts the
  empty one when the pack ships none. The record is never in
  `editableTargets`, so the runs, the hidden suites and the analyser read
  the code alone; naming it there is refused:
  "maintenance/change-request.json is the change request record, never an
  editable target." The phase keeps its brief in `taskPanel` (a `taskFile`
  is refused: "phases/06-maintenance/phase.json: Maintenance keeps its brief
  in taskPanel, not in a file.") and mounts no markdown file ("A Maintenance phase mounts no markdown file:
  <path>."). The rubric must hold the four fixed keys (the loader refuses a
  rubric missing one; the editor keeps these keys locked) and at least one
  change criterion: a key other than `correctness_hidden`, `visible_tests`,
  `code_quality` and `process`, which the change floor scores (TaskTrackr's
  is `change_request`; a pack with none is refused: "rubric.criteria: a
  Maintenance with a change request needs at least one change criterion: a
  key outside correctness_hidden, visible_tests, code_quality and
  process."). A `ticket` or `change` on any other phase is refused: "Only
  Maintenance carries a ticket and a change request." A code Maintenance
  without them is in the older format: the upload door converts it as it
  converts Deployment, with the ticket built from the brief (the first
  `CR-<n>` or `CHG-<n>` in it, else `CR-1`; the bold head of its first
  quoted block, else the phase's `title`; the rest of that block after the
  bold head, empty when nothing follows it, or with no bold head the whole
  block, else the phase's `intro`; the objectives as `AC-1` onward, those
  past the 12th left out and named, and a ticket field over its cap cut and
  named), the contract switch on exactly when the phase mounts
  `design/contracts.json`, a mounted `CHANGELOG.md` as the starting record,
  and `change_request` added when no change criterion is there, the other
  weights scaled by 0.85; the upload says what it changed. A pack under
  `content/` is refused instead: "<slug>: A Maintenance phase of the code
  kind carries checks.ticket and checks.change."
- **`tests`**: `learnerTestFiles`; the reference suite under `reference/`
  (a phase with none is refused: "phases/04-testing has no reference/ folder.
  A tests phase holds its reference suite under reference/."); the
  reference implementation the suite must pass on under `impl/`; each
  mutant a folder under `mutants/<name>/` holding its `meta.json` (whose
  description is shown when it survives) and the full replacement files it
  changes, at their workspace paths; `coverageKeywords`,
  `minTests` (the number of tests over the whole phase, both layers together,
  counted in each run's own language: `def test_…` on a `python` run, `test(`
  or `it(` on a `javascript` or `typescript` one). Comments are stripped from
  the learner's suite in that same language (Python docstrings and `#` lines,
  or `//` and `/* … */`) before the coverage keywords are matched, so neither
  template's own prose ever counts. The task panel must describe mutation testing without
  naming the mutants. A phase with two `runs[]` splits `learnerTestFiles` and
  the `impl/` files between them (each run's `implFiles`, a list of
  workspace paths), and every mutant then says which run it belongs to
  in its `meta.json` (below).
- **`config`**: `rules[]`, the file rules, each naming the file it reads in
  `target` (a rule with none is refused: "A file rule names the file it
  reads."), plus the smoke run's files under `smoke/` at
  their workspace paths and optional `smoke.commands` (whose script is a
  path under `smoke/`: "phases/05-deployment: the smoke command runs
  api/main.py, which smoke/ does not hold.") and `smoke.expect`, and
  `smoke.dockerfile`: the Dockerfile the smoke run parses for an entry point,
  `"Dockerfile"` unless the pack says otherwise, and a file the phase ships. A
  two-service application needs it: `api/Dockerfile` builds the service the
  smoke run starts, `web/Dockerfile` builds the other one. On submission the
  smoke run does **not** use the authored launcher: the learner's Dockerfile
  is parsed for `ENTRYPOINT`/`CMD` (exec or shell form, `WORKDIR` paths made
  relative) and each authored command's own arguments are re-issued through
  that argv, so the container starts through the learner's own `ENTRYPOINT` and
  runs the deployment's selfcheck, which reads their compose file. A Dockerfile with no entrypoint, or one that starts anything
  other than `python`/`node`, fails the build check with a message saying so.
  The ▶ "Run" button still uses the authored commands as a fast loop.

  `drill` (optional): `fault` and `description`, with the faulted copies
  under `drill/` at the workspace paths they replace. A faulted copy of a
  file the phase does not mount is refused
  ("phases/05-deployment/drill/docker-compose.yml faults a file the phase
  does not mount."), and so is a `drill/` folder in a phase that declares no
  drill ("phases/05-deployment/drill/ holds files, but phase.json declares
  no drill. Declare the drill in phase.json or remove the folder.").

  `runbook` (Deployment only): `record` (always
  `"deployment/runbook.json"`) and `floor`: `minEnvironment`, `minHealth`,
  `minRollback` and `minData` (each 0..20; left out, 2, 1, 2 and 1) and
  `requireIncident` (true or false; left out, on exactly when the phase
  declares a drill). The phase ships the starting runbook as
  `files/deployment/runbook.json`, mounted editable at
  `deployment/runbook.json` and valid as it ships; the loader
  mounts the empty one when the pack ships none. With a drill, the starting
  runbook's incident is empty, because the drill writes it: "A starting
  runbook in a phase with a drill has an empty incident: the drill writes
  it." The phase keeps its brief in `taskPanel` ("phases/05-deployment/phase.json:
  Deployment keeps its brief in taskPanel, not in a file."), mounts no markdown file ("A Deployment
  phase mounts no markdown file: <path>.") and grades no markdown file ("A
  file rule cannot target a markdown file. The runbook is a record of its
  own."). The rubric must hold every file rule's criterion and `build_smoke`
  (the loader refuses a rubric missing one; the editor keeps these keys
  locked) and at least one runbook criterion: a key no file rule claims that
  is not `build_smoke`, which the runbook floor scores (TaskTrackr's is
  `runbook_quality`; a pack with none is refused: "rubric.criteria: a
  Deployment with a runbook needs at least one runbook criterion: a key no
  file rule claims that is not build_smoke."). A `runbook` on any other
  phase is refused: "Only Deployment carries a runbook." A config Deployment
  without `runbook` is in the older format: the upload door converts it and
  says so. A mounted `RUNBOOK.md` becomes the starting record (its sections
  read by their headings, as "The runbook record" below describes), the
  `runbook-*` rules and any rule on a markdown file are dropped, and each
  one's label becomes a sentence of its criterion's description (at the
  upload these sentences replace that criterion's own description; one past
  the 400-character cap is left out and named in the note), the floor keeps
  the default minimum (2, 1, 2, 1) only where the older pack graded or
  headed that section (0 otherwise), the incident is required when the phase
  declares a drill or graded or headed an incident, and `runbook_quality` is
  added when no runbook criterion is left, the other weights scaled by 0.85.
  A pack under `content/` is refused instead: "<slug>: A Deployment phase of
  the config kind carries checks.runbook."

### `checks.supportFiles` (tests phases, optional)

Locked helper modules the learner's suite imports, as a list of the workspace
paths they are written to:

    "supportFiles": ["tests/clock.py"]

Each is one of the phase's `readonly/` mounts (here
`readonly/tests/clock.py`), and the loader refuses one that is not:
"phases/04-testing: checks names tests/clock.py in supportFiles, which
readonly/ does not hold." A phase that declares `runs[]` may leave the
phase's own list out: it is then every run's `supportFiles` together, in the
order first named. The older map from a workspace path to a source file is
refused: "phases/04-testing/phase.json names supportFiles, a folder the
layout fixes. Put each support file under readonly/ and remove
supportFiles." The reason a helper is declared at all is the grading job:
`mutationJob` writes only the learner's own test files into the workspace, so
that a suite cannot read the implementation it is scored against, and the
reference implementation and the mutants ride in `gradedFiles`, which the
harness deletes before any learner module loads. A module the suite imports has
to still exist when it loads, so it goes in the workspace, deliberately, by
name.

The reference pack uses it for the run clock helper the acceptance suite reads
instead of calling `date.today()` itself, so a matrix graded in March means the
same thing in September (one helper per layer once the phase has two runs, and
each run names its own), and for any file the reference implementation itself
opens at run time: `api/schema.sql` and the `api/db.py` that reads it ride in
the workspace, because a graded artefact is deleted before the suite runs and
cannot open a file beside itself.

### `checks.runs` (code and tests phases, optional)

A phase that spans a Python API and a TypeScript front end grades both, and
says so with `runs[]`. A phase that leaves it out has exactly one run, `main`,
built from the flat shape above, whose hidden suite is `hidden_tests/main/`.

    "checks": {
      "kind": "code",
      "editableTargets": ["api/repository/tasks.py", "web/src/lib/overdue.ts"],
      "runs": [
        {
          "id": "api",
          "language": "python",
          "harness": "pytest",
          "hiddenHarness": "unittest",
          "label": "API tests",
          "visibleTests": ["tests/test_tasks_api.py"],
          "supportFiles": ["tests/conftest.py"]
        },
        {
          "id": "web",
          "language": "typescript",
          "harness": "js",
          "label": "Front end",
          "transform": true,
          "visibleTests": ["web/src/lib/overdue.test.ts"]
        }
      ]
    }

| Key | Meaning |
|---|---|
| `id` | `^[a-z][a-z0-9-]{0,15}$`, unique in the phase. It is stamped on every case as its `step` and quoted by the mutant table, so it is stable once a class has run |
| `language` | One of the pack's own `languages`. Defaults to the pack's `language` |
| `harness` | `pytest`, `unittest` or `js`: what the learner's own Run uses. Defaults to `unittest` for Python and `js` otherwise |
| `hiddenHarness` | The harness the sealed suite runs under. Same defaults. The learner reads and writes pytest; the sealed artefacts stay on the harness whose seal is proved |
| `label` | The words a learner reads above the group, in sentence case. Required once a phase declares more than one run, and two runs may not share one |
| `transform` | Compile the workspace's TypeScript before the child starts. Only a `typescript` run may ask for it |
| `testPaths` | What the **graded** run collects. Defaults to the run's own hidden suite on a code phase and to its `learnerTestFiles` on a tests phase |
| `visibleTests` | Code phases: what the learner's own Run collects. Every entry must be a file the phase mounts |
| `learnerTestFiles`, `implFiles` | Tests phases: this run's share of the learner's suites and of the reference implementation under `impl/` it is graded against, as workspace paths. Every learner test file belongs to exactly one run: two runs claiming one would grade it twice, and none claiming it is a suite nothing runs |
| `supportFiles` | The locked helpers this run's workspace carries. The same rule as above: each must be a `readonly/` mount |

A code run's sealed suite is the folder `hidden_tests/<id>/`, each file at the
workspace path it runs from: `hidden_tests/api/tests/test_hidden_tasks.py`
runs as `tests/test_hidden_tasks.py`, and a front-end suite sits at the
workspace path its component expects. A sealed suite is imported from outside
the workspace, so it must require what it tests by workspace path
(``require(`${process.cwd()}/web/src/lib/overdue`)``), never with a relative
import. Each of these is refused by name:

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

**A sealed suite cannot import its neighbour.** The failure mode is silent, so
it is worth its own paragraph: the sealed copy is never written at the workspace
path the nested directory names (it is imported from outside the workspace and
unlinked), so a relative import out of it resolves to nothing, the run comes back
`exitKind: "error"` with `tests: null`, no cases and no stderr, and an author
reads that as "the runner broke". Require what you are testing by workspace path
instead.

Each mutant is a folder under `mutants/` holding its `meta.json` and the
files it changes; a file directly under `mutants/` is refused
("phases/04-testing/mutants/off_by_one.py sits in no mutant's folder. Each
mutant is a folder under mutants/ holding its meta.json and the files it
changes."). Each mutant then says which run it belongs to, in its own
`meta.json`:

    {
      "name": "overdue_includes_due_today",
      "description": "The overdue query uses <= where < belongs, so a task due today is reported late.",
      "covers": "US-4/AC-2",
      "run": "api"
    }

`run` decides which implementation the mutant overlays and which reference
suite is run against it, so the kill matrix is one grid over both layers. It is
required as soon as a phase declares more than one run, and a mutant that
overlays nothing in its own run's implementation is refused at boot: a mutant
nothing can kill would cap every learner's mutation score.

**What two runs do at run time.** They are two sandbox jobs, one after the
other, never at once: one learner's Run press then holds one runner slot at a
time, which is what keeps a class of thirty fair. The results are merged into
one: the pass rate is pooled over both runs' cases rather than averaged over
the runs, so a learner who finishes the API and skips the front end cannot
score full marks, and a single unreachable runner in either layer makes the
whole result unavailable rather than a verdict. Each case carries its run's
`id` as its `step`, and each run's output appears under its own `label`.

## The design record (`design/design.json`)

A Design phase of the `design` kind holds one record, `design/design.json`,
and the learner's room is a set of forms over it: the UML model, the API
contract and the Screens form when those contracts are on, the sequence
diagram when it is on, and the decisions. The floor grades the record, the
review reads its fields one path each, and nothing renders it to markdown. A
pack may ship a starting record as `files/design/design.json`; the loader
seeds an empty one when it ships none. The schema is `Design` in `packages/shared/src/design-record.ts`:

    {
      "entities":   [{ "id": "E1", "name": "Task", "kind": "class",
                       "attributes": [{ "name": "dueDate", "type": "date", "note": "" }],
                       "responsibilities": ["knows when it is due"], "satisfies": ["US-1"] },
                     { "id": "E2", "name": "TaskList", "kind": "class", "attributes": [],
                       "responsibilities": ["holds the tasks"], "satisfies": ["US-1"] }],
      "relations":  [{ "id": "R1", "from": "E1", "to": "E2", "kind": "association",
                       "fromCard": "*", "toCard": "1", "label": "belongs to" }],
      "operations": [{ "id": "O1", "name": "getOverdue(today)", "inputs": ["today"],
                       "returns": "list[Task]", "errors": ["INVALID_DATE"], "satisfies": ["US-4"],
                       "note": "Ordered by due date, oldest first." }],
      "decisions":  [{ "id": "D1", "title": "Store", "context": "", "choice": "", "alternative": "",
                       "rationale": "", "tradeOff": "", "consequences": [], "status": "proposed",
                       "satisfies": ["US-1"], "decidedAt": "" }],
      "sequence":   "Screen -> API: GET /tasks/overdue",
      "notes":      ""
    }

**Entities.** Each has an `id` (at most 16 characters, unique among the
entities), a `name`, a `kind` (`class`, `component`, `service` or `screen`),
`attributes` (at most 30, each a `name` with an optional `type` and `note`),
`responsibilities` (a list of at most 30 lines) and `satisfies`, the story ids
it serves. At most 20 entities.

**Relations.** Each has an `id`, `from` and `to` (both the id of an entity in
the same record, or the record is refused), a `kind` (`association`,
`aggregation`, `composition`, `inheritance` or `dependency`), the
cardinalities `fromCard` and `toCard` (such as `1`, `0..1`, `*` or `1..*`, at
most 16 characters each) and an optional `label`. At most 40 relations.

**Operations.** Each has an `id`, a `name` (the signature the later phases
check against), `inputs` (a list), `returns`, `errors` (a list of error codes)
and `satisfies`, with an optional `note` for what the operation promises
beyond its signature (an ordering, a boundary, an example). At most 30
operations. `design/contracts.json` in Maintenance is seeded from
`operations[].name`, `inputs` and `returns`.

**Decisions.** Each has an `id`, a `title`, an optional `context` (the forces:
what made this a decision rather than a default), the `choice`, the
`alternative` it was weighed against, the `rationale`, the `tradeOff`,
optional `consequences` (a list of at most 6 lines, what follows from it), a
`status` (`proposed`, `accepted` or `superseded`), an optional `supersededBy`
(the id of the decision that replaced it), `satisfies`, and `decidedAt`, which
the room stamps the first time the decision is accepted. At most 10 decisions.

**The sequence diagram.** `sequence` is the request path as text, one message
per line. It is read and graded only when the phase's `checks.sequence` is on:
then the floor requires it to name at least one of the learner's operations,
and the review may cite it. Off, its tab is hidden and nothing reads it.

**Notes.** `notes` is free text the learner keeps beside the design; the
review reads it, the floor does not.

**Caps.** Every text field holds at most 4000 characters, every list of text
at most 20 entries (responsibilities 30, consequences 6), and every id at most
16 characters. A record over a cap, with an id used twice, or with a relation
pointing at no entity is refused with a sentence that names the field; the
save is not written. An unknown key is dropped: the validator rebuilds the
record from the keys above, so a pack's extra key does not survive the next
save.

**The board's older record.** A record the earlier design board wrote (its
`fields`, its `endpoints`, operations as text with `ordering`, `boundary` and
`example`, a lowercase `tradeoff`) is folded into this schema by the
`S2-DesignRecordsFromMarkdown` migration, by the boot's re-pin and by the upload door. Everything the board
drew moves field for field: an entity's kind and responsibilities, a
relation's cardinalities and its dependency kind, an operation's note, a
decision's context, consequences and superseded-by link. Three things move
elsewhere: the `fields` become the attributes of one entity, Model (or lines
in `notes` beside drawn entities), the `endpoints` become lines in `notes`,
and each operation's ordering, boundary and example join its own `note`.
Nothing else is dropped; a notes line that would pass the 4,000-character cap is left out and named, and the migration refuses the row rather than cut it: every key the fold does not read (an unknown key of
an entity, an operation or a decision) is kept as text in that item's note,
or in `notes` for the record, and a relation the board kept but never drew
keeps its kind and cardinalities as text the same way. A teacher's Design still in the older markdown format converts on its
first save in the project editor; publish and the class door refuse one that
has not.

**What the room reads beside it.** The stories to design for are the
teacher's own list in `checks.stories`, typed in the editor (or copied from
the Requirements phase there); the room shows them read-only. The
contradiction warnings read those stories and the learner's own story record,
`requirements/story.json` (its title, its sentence and its criteria, never
its out-of-scope lines), fetched once from the requirements phase.

## The runbook record (`deployment/runbook.json`)

A Deployment phase of the `config` kind with `checks.runbook` holds one
record beside its configuration files, and the learner's Runbook tab is a
set of forms over it: Environment, Health checks, Rollback, Data, the
Incident and Notes. The learner never opens it as a file: the IDE's file
tree leaves it out, and the pull request's list of changed files never
names it. The runbook floor grades it, the review reads its fields one path
each, and nothing renders it to markdown. The configuration files stay
files, graded by the file rules and the smoke run. The schema is
`Runbook` in `packages/shared/src/runbook-record.ts`:

    {
      "environment": [{ "id": "E1", "name": "API_URL", "purpose": "Where the web container finds the API.",
                        "kind": "config", "example": "http://api:8000" }],
      "health":      [{ "id": "H1", "name": "API healthcheck", "how": "curl -fsS http://localhost:8000/health",
                        "expected": "{\"status\": \"ok\"}" }],
      "rollback":    [{ "id": "R1", "step": "Deploy the previous image tag.", "verify": "The healthcheck passes again." }],
      "data":        [{ "id": "D1", "what": "The database file", "how": "Copied nightly", "where": "The db volume",
                        "retention": "Seven days" }],
      "incident":    { "rootCause": "", "fix": "", "actionItem": "" },
      "notes":       ""
    }

**Environment.** Each entry has an `id`, a `name` (the setting), a
`purpose` (what it controls), a `kind` (`config` or `secret`) and an
optional `example`.

**Health checks.** Each has an `id`, a `name`, `how` (the command) and
`expected` (the output that proves the deployment is alive).

**Rollback.** Each step has an `id`, a `step` and `verify` (how to check it
worked). The list is in the order an operator runs the steps, and the room
moves a step up or down.

**Data.** Each entry has an `id`, `what` is kept, `how`, `where`, and an
optional `retention`.

**The incident.** `rootCause`, `fix` and `actionItem`, and an optional
`timeline` of entries, each an `at` and an `event`. In a phase that
declares a drill, the drill page is the one writer of the incident: closing
the incident writes the three fields from the learner's write-up and a
timeline of three lines ("Paged: the check against the faulted copy
failed.", "A health check passed after the failure." and "Incident
closed."), and the Runbook tab shows them read-only under the line "Written
from the drill page when you close the incident." Every other write (the
tab's own save, an applied proposal) keeps the stored incident. Closing the
incident over a stored runbook that does not validate is refused with "Save
a valid runbook before you close the incident.", and a close that loses to
a save made in between writes nothing and answers "Your runbook was saved
somewhere else while you closed the incident. Close it again." In a phase
with no drill, the incident is an ordinary form the learner fills,
timeline lines included.

**Notes.** `notes` is free text beside the runbook; the review reads it,
the floor does not.

**Ids.** The room names a new item with its list's letter and the next
free number: `E1` in Environment, `H1` in Health checks, `R1` in Rollback,
`D1` in Data. An id is at most 16 characters and unique within its list.

**Caps.** At most 20 items in each of the four lists and 20 timeline
entries; every text field, `notes` included, at most 2000 characters; a
timeline `at` at most 40. The empty runbook is four empty lists and an
incident of three empty strings. A record over a cap, with an id used twice
or an unknown `kind`, is refused with a sentence that names the field, and
the save is not written ("The runbook was not saved: <the sentence>.").
An optional field may be null, which reads as absent. An unknown key is
dropped: the validator rebuilds the record from the keys above.

**What the floor counts.** Only a filled item counts toward a minimum: an
environment entry with a `name` and a `purpose`, a health check with a
`name`, a `how` and an `expected`, a rollback step with a `step` and a
`verify`, a data entry with a `what`, a `how` and a `where`. A seeded name
alone counts for nothing. The floor's seven rules, each a required check,
and the sentence each says when it fails: `runbook.record` "The runbook
record is missing or not valid"; `runbook.environment.min` "Fewer than N
environment entries with a name and a purpose"; `runbook.health.min`
"Fewer than N health checks with a name, a command and the expected
output"; `runbook.rollback.min` "Fewer than N rollback steps with a step and
a check"; `runbook.data.min` "Fewer than N data entries saying what is kept,
how and where"; `runbook.incident` "The incident is missing its root cause,
fix and action item" (naming only the blank fields; "Not required" when
the switch is off); `runbook.named` "N runbook items have no name" (an item
whose `name`, `step` or `what` is blank). A minimum of 0 passes. Each
runbook criterion scores the share of these rules that pass.

**What the review reads.** One labelled path per field:
`runbook/env-N/name`, `purpose`, `kind` and `example`;
`runbook/health-N/name`, `how` and `expected`; `runbook/rollback-N/step` and
`verify`, and `runbook/rollback/order`; `runbook/data-N/what`, `how`,
`where` and `retention`; `runbook/incident/root-cause`, `fix`, `action-item`
and `timeline`; `runbook/notes`. A passing review quotes, for every
criterion, one of these paths or a configuration file the task owns;
`build_smoke` cites `[check:build-smoke]` instead, which must have passed.

**An older `RUNBOOK.md`.** When a teacher's older Deployment converts (the
`runbook` entry under "checks by kind"), its `RUNBOOK.md` is split at its
level-two headings: a heading whose words include environment, env, runtime
or variable fills Environment; health fills Health checks; rollback or roll
back fills Rollback; data, backup, volume or storage fills Data; incident,
postmortem, post-mortem or outage is the incident; any other heading, and
the text above the first, goes to `notes`. Each bullet or line is one item
(a fenced block one item with the block's text): an environment line its
`name` and `purpose` (split at the first colon followed by a space or ending
the line, or at a spaced hyphen, en dash or em dash; a line with none of
these is a `name`), a health line its `how` (the `name` left blank), a
rollback line its `step`, a data line its `what`. In the incident, a line
starting `Root cause:`, `Fix:` or `Action item:` fills that field (the first
of each), and every other incident line goes to `notes`; in a phase with a
drill every incident line goes to `notes`, since the drill writes the
incident. Lines that are only a `TODO(learner)` marker are dropped. Each
group is kept in `notes` under "Kept from RUNBOOK.md, <heading>:" (the text
above the first heading under "Kept from RUNBOOK.md:"); a comment, a
level-one title line, and any item past 20 in a list or over 2000 characters
go there too. Only `RUNBOOK.md` converts; another markdown file the phase
mounts is refused: "A Deployment phase mounts no markdown file: <path>."
Words that would not fit (`notes` past 2000 characters) refuse the
conversion rather than being cut: "The words in RUNBOOK.md would not fit in
the runbook record."

A learner's own `RUNBOOK.md` converts the same way in the
`S3-DeploymentAndMaintenanceRecords` migration and at the boot's re-pin, read
against their version's template: a line the template holds in the same
section is dropped; a list or incident heading the template does not hold is kept in `notes` as "Kept from RUNBOOK.md,
<heading>:"; the drill's stored incident wins over the file's, whose
incident lines go to `notes`; a workspace that already holds a valid record
keeps its lists and its own incident (the drill's fills only an empty one),
and the file's items go to `notes`; words that would not fit refuse the row,
left exactly as it was.

## The change request record (`maintenance/change-request.json`)

A Maintenance phase of the `code` kind with `checks.ticket` and
`checks.change` holds one record beside its code, and the learner writes it
in the change room's four tabs: Request, Contract (only when the contract
switch is on), Checks and Release. The code is edited in the IDE;
the IDE never lists the record, and the pull request's list of
changed files never names it. The change floor grades it, the review reads
its fields one path each, and nothing renders it to markdown. The schema is
`ChangeRequest` in `packages/shared/src/change-record.ts`, read against the
teacher's ticket:

    "ticket": {
      "id": "CHG-1",
      "title": "Shelve by surname",
      "summary": "Order the shelf the way a librarian shelves it.",
      "acceptance": [{ "id": "AC-1", "line": "Order the shelf by surname, then title, then id, in the API" },
                     { "id": "AC-2", "line": "Make the page agree with the API's new order" }]
    }

    {
      "impact":   { "operations": ["list_books"], "screens": ["The shelf"], "files": ["api/shelf.py"] },
      "contract": [],
      "tests":    [{ "id": "T1", "suite": "test_shelf_order", "covers": ["AC-1"], "result": "pass" }],
      "release":  { "version": "1.1.0", "summary": "The shelf follows the surname.",
                    "changes": [{ "id": "L1", "line": "Books are listed by surname, then title.", "covers": ["AC-1", "AC-2"] }],
                    "rollback": "Deploy 1.0.0 again; nothing in the data changed.", "risks": [] },
      "notes":    ""
    }

**The ticket** is the teacher's, in `checks.ticket` (above), and is shown
read-only on the Request tab. It is never part of the record, and the
reviewer reads it as the teacher's text, apart from the learner's fields.

**Impact.** Three lists of text: the `operations`, the `screens` and the
`files` the change touches. The Request tab offers the phase's editable
paths as files, and any path can be typed.

**Contract amendments.** Each has an `id`, a `method` (at most 16
characters), a `path`, a `change` (`added`, `changed` or `removed`) and
`why`. They are the learner's declared amendments, which the review checks
against the change in `design/contracts.json` and the API contract files
the phase mounts. While the switch is off they are not part of the change
request: the floor, the review and the change set leave them out, and the
starting record the teacher saves holds none.

**Tests.** Each has an `id`, a `suite`, `covers` (acceptance ids of the
ticket) and a `result` (`pass`, `fail` or `not-run`).

**Release.** A `version` (at most 40 characters), a `summary`, `changes`
(each an `id`, a `line` and `covers`), a `rollback` and optional `risks` (a
list of text).

**Notes.** `notes` is free text beside the change request; the review reads
it, the floor does not.

**Ids and covers.** The room names a new amendment `C1`, a new test `T1` and
a new change line `L1`, each the next free number. An id is at most 16
characters and unique within its list. A `covers` list holds at most 12
ids, each one of the ticket's acceptance ids: an id the ticket does not
hold is refused. The trace rule counts these ids; it never matches words.

**Caps.** At most 20 entries in each impact list, in `contract`, `tests`,
`release.changes` and `release.risks`; every text field, `notes` included,
at most 2000 characters. The empty change request is three empty impact
lists, no amendments and no tests, and a release of empty text with no
change lines. A record over a cap, with an id used twice or an unknown
`change` or `result`, is refused with a sentence that names the field, and
the save is not written ("The change request was not saved: <the
sentence>."). An optional field may be null, which reads as absent. An
unknown key is dropped.

**What the floor counts.** An impact entry that is not blank; an amendment
with a `method`, a `path` and a `why`; a test with a `suite` and at least
one `covers` id; a release with a `version` and a change line. An
acceptance id counts as covered when it is in the `covers` of a test or a
change line that is named. The floor's rules, each a required check, and
the sentence each says when it fails: `change.record` "The change request
record is missing or not valid"; `change.impact.min` "Fewer than N
operations, screens or files named in the impact"; `change.contract.min`
"Fewer than N contract amendments with a method, a path and a reason" (only
when the contract is on); `change.tests.min` "Fewer than N tests naming a
suite and the acceptance items they cover"; `change.release` "The release
has no version or no change line"; `change.trace` "Acceptance items not
covered by any change line or test: AC-2, AC-4" (naming the ids; "No
acceptance items to trace" when the ticket holds none); `change.named` "N
items in the change request have no name" (a blank impact entry, contract
path, test suite or change line). A minimum of 0 passes, and a switch that
is off reads "Not required". Each change criterion scores the share of
these rules that pass; the four fixed keys are scored by the code grader as
before.

**What the review reads.** One labelled path per field:
`change/impact/operations`, `screens` and `files`; `change/contract-N/path`,
`method`, `change` and `why` (only when the contract is on);
`change/test-N/suite`, `covers` and `result`; `change/release/version`,
`summary`, `rollback` and `risks`; `change/release/change-N/line` and
`covers`; `change/notes`. The ticket is not one of them.

**An older `CHANGELOG.md`.** When a teacher's older Maintenance converts,
its `CHANGELOG.md` becomes the starting record: the newest entry, the first
level-two heading that carries a `MAJOR.MINOR.PATCH` version, gives the
release's `version` and, from the heading's other words, its `summary`; each
bullet or line under it becomes a change line covering nothing yet, written
"<subheading>: <line>" when it sits under a level-three subheading, at most
20 of them; everything else the file holds, the change lines past the 20th
among it, is kept in `notes` under "Kept from CHANGELOG.md:". Only
`CHANGELOG.md` converts; another markdown file the phase mounts is refused:
"A Maintenance phase mounts no markdown file: <path>." Words that would not
fit refuse the conversion rather than being cut: "The words in CHANGELOG.md
would not fit in the change request record."

A learner's own `CHANGELOG.md` converts the same way in the
`S3-DeploymentAndMaintenanceRecords` migration and at the boot's re-pin, read against their version's template: a line the
template holds in the same entry is dropped, and a level-three subheading
the template's entry lacks is kept; a workspace that already holds a valid
record keeps its release, and the file's release lines go to `notes` under
"Kept from CHANGELOG.md, Release <version>:"; words that would not fit
refuse the row, left exactly as it was.

## The warm-up (optional, one per project)

A pack's warm-up is its `warmup/` folder beside `phases/`, holding
`warmup/warmup.json` with the exercise; `project.json` does not name it. It is
not a phase: it has no key, no order, no rubric, no gate, no attempts and no
place in the map. The platform loads, checks and stores a pack's warm-up, but
no page or route offers it to a learner.

    {
      "title": "Warm-up",
      "runLabel": "Run the check",
      "brief": "Change the word greeting.ts returns, run the check, and submit.",
      "steps": ["Open greeting.ts and change the word it returns", "..."],
      "files": [
        { "path": "web/src/lib/greeting.ts", "source": "files/greeting.ts",
          "editable": true, "language": "typescript" },
        { "path": "web/src/lib/greeting.test.ts", "source": "files/greeting.test.ts",
          "editable": false, "language": "typescript" }
      ],
      "check": { "kind": "tests", "testPaths": ["web/src/lib/greeting.test.ts"],
                 "language": "typescript", "harness": "js", "transform": true }
    }

`brief` is the warm-up's brief, inline and in plain text, as a phase's
`taskPanel` is; a `briefFile` is refused: "warmup.json keeps its brief
inline as brief, not in a file." Every path in `files` is a workspace path
(relative, inside the workspace) and every `source` is relative to the
warm-up directory: the warm-up is the platform's own format, never uploaded,
so it keeps its file list.
`apps/api/src/content/warmup.loader.ts` refuses a pack that gets it wrong, at
boot, naming the field: a non-empty `title` and `brief`, at least one step,
at least one file, at least one `editable` file, `check.kind` exactly `"tests"`,
at least one `check.testPaths` entry, every `source` resolvable on disk, and
every path the check names both declared in `files` and **not** editable: an
editable test file is a warm-up a learner passes by deleting the assertion.

The shipped state of the editable file must fail the check. A warm-up that
passes untouched teaches nothing, and the loader's own spec
(`warmup.loader.spec.ts`) asserts it of every pack that ships one.

The check may name its own language, which is how a pack whose primary language
is Python opens with a one-line TypeScript exercise: five minutes in which the
learner meets the front-end harness before any of it is graded:

    "check": {
      "kind": "tests",
      "testPaths": ["web/src/lib/greeting.test.ts"],
      "language": "typescript"
    }

`language` defaults to the pack's own and must be one of its `languages`;
`harness` defaults to that language's own and must be one it can run;
`transform` defaults to true for a TypeScript warm-up and false otherwise. A
warm-up that declares none of the three runs exactly as it did.

## Authoring checklist

1. Write the canonical implementation first and its hidden tests; prove
   `python -m unittest` passes.
2. Derive the learner version by replacing target bodies with
   `# TODO(learner)` + `raise NotImplementedError` (the analyser and the
   mentor's workspace signals key off both markers).
3. Generate mutants as minimal single-bug edits of canonical files. The
   content suite runs the implementation phase's hidden suite against every
   mutant in the real sandbox and fails if any survives: a mutant nothing can
   kill would cap every learner's mutation score.
4. Keep every `failDetail` formative: say what to fix, not just that it failed.
5. Give the assistant at least three topics and three progressive hints per
   phase; never put solution text in hints, and phrase the shallow rungs as
   questions (they are what a solution request receives).
6. Give every phase's `taskPanel` a *What good looks like* line and a word on
   using the AI mentor well (the suite checks both, in every phase of every
   project), and write it, like every objective, intro and rubric sentence,
   in plain text ([Plain text](#plain-text)).
7. **Bump `project.json`'s `version`.** A published version is immutable and the
   learners working it are pinned to it, so a content change with the same
   version refuses the next boot by name (above). This is a requirement, not a
   convention.
8. Run the content integrity unit suite (`npm test`): it runs every check
   above over `listProjects()`, so a new bundle is held to the same bar as the
   reference project: the subset rule (at least one phase, each once, in
   LearnSDLC's order, numbered 1 to n), rubric weights, a hidden suite per
   run and a solution per code phase, a stubbed change request in maintenance,
   killable mutants in every run the phase declares, scaffolds that score
   nothing untouched, and no solution text in the hints.

## Proving a pack

`npm run content:check` runs every proof the platform makes about a pack, over
every pack in `CONTENT_DIR`, and prints what it proved:

```
==> Checking 1 content pack against the real sandbox

  tasktrackr 2.0.0, python, 6 phases
    ok    the pack loads                                  6 phases, 4 run code, 6 runs in python and typescript, weights sum to 1 in each
    ok    every run names files the phase ships           6 runs, 21 paths, all accounted for
    ok    the pre-baked dependency layer is here          matches the packs. digest a678738…
    ok    the shipped solution passes its hidden suite    implementation python 14 of 14, implementation typescript 8 of 8, maintenance python 31 of 31, maintenance typescript 2 of 2
    ok    every planted bug dies                          8 of 8
    ok    the planted bugs cover every layer              api 6, web 2
    ok    the contract and the routes are the same list   13 operations, 13 routes, the same list
    ok    the front end keeps no state in the browser     23 front-end files, no cookies, no storage, no pushState
    ok    the declared preview starts and serves the app  ready in 4 s, 2143 bytes of web/index.html
    ...
==> 1 pack, 21 checks, no defects. 12 seconds
```

A defect names the pack, the phase, what to open and what to add, and the run
keeps going: one command tells you everything that is wrong, not the first
thing. The checks, one line each per pack:

| id | what it proves |
|---|---|
| `pack-loads` | the subset rule (at least one phase, each once, in LearnSDLC's order, numbered 1 to n), a `MAJOR.MINOR.PATCH` version, rubric weights summing to 1 in each phase, and every `languages` member and `checks.runs[].language` one the runner can execute |
| `brief-plain` | "every brief and phase text is plain text": each phase's `taskPanel`, intro, objectives, rubric criterion titles and descriptions, and the mentor's system prompt and hints equal their own plain form ([Plain text](#plain-text)); a defect names the phase and the member, "<phase key>: <member> is not plain text" |
| `canonical-copies-agree` | "every read-only copy of a canonical file is the canonical file's bytes", for the reference project only (another pack is skipped: "only the reference project keeps a canonical/ folder"): every `readonly/` file at a path `canonical/` holds is byte-equal to `canonical/`, except the phase-owned locked files the check names in a list of its own (Implementation's `tests/test_tasks_api.py` and `web/src/lib/overdue.test.ts`, and Maintenance's `tests/test_comments_api.py`); a `files/` starter is not held to it, because a starter has gaps by design; a defect reads "<phase key>: readonly/<path> differs from canonical/<path>" |
| `rubric-keys-scored` | every rubric key is one the grader sets, and every scored key is claimed by a criterion |
| `runs-agree` | every run's `testPaths`, `visibleTests` and `supportFiles` name a file the phase ships or hides, every support file is locked, and every previewable phase mounts `build.entry` |
| `no-graded-file-in-the-workspace` | no hidden test file is also a mounted file, and no mutant lands on a file the learner edits or on a path its run does not grade |
| `prebake-available` | `node scripts/prebake.mjs verify` agrees with what the packs pin; skipped when no pack declares a `runtime` |
| `solution-passes-hidden` | every code phase's shipped `solution/` passes its own `hidden_tests/`, **per run**, in the real sandbox, with that run's own harness and transform |
| `stub-fails-hidden` | the stub the learner opens fails that same suite, per run, so the suite has teeth in both layers |
| `front-end-suite-runs` | the canonical front-end suite passes the canonical components under the esbuild transform and the DOM harness |
| `reference-passes-impl` | the testing phase's `reference/` suite passes the reference implementation, per run |
| `mutants-die` | every mutant is killed by its own run's reference suite, by the grader's own kill rule |
| `both-layers-mutated` | the mutants cover every run the phase declares, so a kill matrix cannot quietly become one language's |
| `criterion-verified` | every `covers` and `criterionId` names a criterion the approved backlog declares, and no two mutants cover the same one |
| `contract-matches-routes` | every operation in `shared/contract/api.json` has a route in `api/`, and every route has an operation |
| `schema-matches-contract` | every entity field in the contract is a column in `api/schema.sql`, and every NOT NULL column is required in the contract |
| `no-browser-storage` | the canonical front end uses no `localStorage`, `sessionStorage`, `document.cookie` or `history.pushState`: the preview's iframe is opaque-origin and every one of those is unusable there |
| `drill-breaks-smoke` | the smoke check passes a working image and fails the drill's faulted copy, naming the directive the drill's own description names |
| `forged-entrypoint-refused` | an ENTRYPOINT that prints the expectation with `python -c` or `node -e` is refused, at the Dockerfile the pack's smoke run builds |
| `incident-gated` | a Deployment whose drill writes the incident requires it in the runbook floor, and the drill report counts a record whose root cause names the fault in the drill's own words, and not one that only says something broke |
| `scaffold-fails-gate` | no untouched scaffold meets its own floor: the seeded story and design records, the starting runbook and the starting change request each fail at least one floor rule |
| `change-request-complete` | `design/contracts.json`, required only when the contract switch is on, ships editable and empty, and the starting change request is valid and no change line in it covers an acceptance item yet |
| `preview-starts` | the pack's declared preview starts on the canonical files, comes ready and serves the pack's own page; `unavailable` on a transport that cannot run an app, never a defect |

Two things an author gets wrong first, so they are worth stating under the table:

- A check that reads the pack's **canonical application** (the contract, the schema, the front
  end, the preview) reads `content/<slug>/canonical/`, not a phase's mounted copy: phases 2 and
  6 mount a scaffold of `shared/contract/api.json` with operations removed, and grading a pack
  against its own scaffold proves nothing.
- Four checks are per **run**, not per phase, and each asserts its own run collected something.
  A run that collected nothing is the failure mode this exists for: unittest discovers only
  `*.py`, so a `.tsx` hidden suite would add zero tests, raise nothing, and read as green.

Flags: `--quick` skips every sandbox proof (including `preview-starts`, which
starts a real application) and runs the loader and the static invariants in
about a second, which is the loop to use while editing a `phase.json`; `--pack <slug>` checks one pack; `--only <ids>` runs named checks;
`--json <path>` and `--markdown <path>` write the report to a file; `--quiet`
prints the last lines only.

Exit codes, and the distinction that matters: **1 means a pack is wrong, 2
means the checker could not tell.** 0 is clean, 1 is a defect, 2 is a pack that
would not load or a code runner that never answered, 3 is bad usage, and 70 is
an unexpected failure in the checker itself. A
pipeline that treats 1 and 2 the same will one day mark a pack broken because a
socket was missing.

The sandbox proofs need a runner: `RUNNER_MODE=local` runs the harness as a
child of the checker's own process, and `scripts/start.sh` gives you the socket runner. Without one
the report says so and exits 2: nothing in it says the packs are wrong. They
also need the pre-baked dependency layer (`npm run prebake`); `prebake-available`
is the check that says so first, and it is **skipped**, not failed, when no pack
declares a `runtime` block. On the Lambda transport `preview-starts` reports
`unavailable` rather than a defect: an app has nowhere to keep running there.

`npm test` runs `content.spec.ts`, which asserts the same things and is
the gate a commit has to clear; the checker is the tool that says *what* is
wrong while you are writing the pack. Both read the same `ContentService`, the
same `checkers.ts` helpers and the same kill rule, so a pack change moves them
together.

## Rules for an uploaded archive

A teacher can upload a project as a `.zip` archive. This section lists the
rules the upload adds to everything above. A pack under `content/`
that is loaded at boot is not affected. Where a rule here is narrower than the
general rule above, the narrower one applies to an upload. The guide for
teachers is [teacher-project-upload.md](teacher-project-upload.md).

Every rule below is checked at upload. The ceiling, the runtime profile, the run
shapes, the run limits and the one-work-task rule are checked again at publish,
so an edit made in the editor is held to them too. A refused upload imports
nothing. It answers one fixed sentence for the first reason found and, when a
run shape or a run limit is refused, one fixed sentence per finding with where
in the manifest it was found (manifest keys and positions only). No sentence
quotes anything from the archive. The one addition is a short detail line (at
most 400 characters) under "not a project in the authoring format". It names
the file or field to fix and may repeat a path or a value the pack chose, such
as a manifest value, but never a byte of a file's content. The upload page
shows it as plain text.

### The archive

- `project.json` sits at the top of the archive, or inside the one top-level
  folder every entry sits in (what zipping the folder itself produces). A
  `__MACOSX/` folder, a `.DS_Store`, `Thumbs.db` or `desktop.ini` file, and
  an AppleDouble `._` file are left out, and the upload names each in its
  warnings.
- Size: at most the deployment's import limit (32 MB by default), packed and
  unpacked. At most 2,000 entries, folders included. Any entry over 1 KB
  unpacked may unpack to at most 100 times its packed size.
- Entries are stored or deflated. Refused: encryption, symbolic links and other
  special files, a large-archive (ZIP64) size or position beyond the upload
  limit (ZIP64 inside the limit is read), a declared size or checksum that does
  not match,
  an entry that climbs out of the project folder or starts at the root (an
  absolute path, a drive letter, a backslash or a `..` step), two entries with
  one name, a file and a folder at one path, names that differ only in case, a
  null or other control character in a name, and an empty archive. An entry
  name may be at most 1,024 bytes and at most 64 parts between slashes, folders
  and file name together.
- In an older-layout archive, a `source` of `../../canonical/…` resolves
  inside the archive, never outside it. A folder-layout archive holds no
  `canonical/`: it is refused ([The archive layout](#the-archive-layout)).
- `slug` and `version` in `project.json` must still be valid, but the upload
  does not use them. The project's address is made from the title the teacher
  types, and the draft always opens as `0.1.0`.

### Secret-shaped files

Refused anywhere in the archive. An older-layout archive may ship one
dot-env file, `canonical/.env.example`, which its conversion leaves behind
with the rest of `canonical/`. A folder-layout archive has no exception, so
its sentence names none: "<path> looks like a secret (a .env file, a private
key or a credential). Leave secrets out of the archive and upload again."

- any file whose name starts with `.env` or ends with `.env` (`.env`,
  `.env.local`, `.envrc`, `prod.env`),
- any file inside a folder named `.ssh`, `.aws`, `.git`, `.gnupg` or `.docker`,
- files named `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.npmrc`,
  `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `credentials`,
  `credentials.json` or `.dockercfg`,
- files ending `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.kdbx` or
  `.ppk`,
- any file holding a PEM private key block.

The `.git` rule means a working copy of a repository cannot be zipped as it is.
Zip a clean copy.

### No warm-up

An upload holds no warm-up. A `warmup/` folder in the archive is refused with
the upload's warm-up sentence, and so is an older archive whose `project.json`
names one. The warm-up loader reads from the disk rather than from the archive,
so an uploaded warm-up is refused until that changes. An export never carries
a warm-up: a copy of a project that has one exports with no `warmup/` folder,
so its archive can be uploaded again.

### One work task per executable phase

A `code`, `tests` or `config` phase holds one work task. A `tasks` array on such
a phase with more than one task that is not a quiz is refused, with the upload's
"more than one work task" sentence. Publish refuses the same shape.

### The runtime block

`runtime` is optional. When it is present:

- only `python.version`, `python.packages`, `node.version`, `node.packages` and
  `node.tools` may appear,
- a `python` or `node` block must give its `version`, as a string, and it must
  be the baked interpreter version,
- every package pin must be exactly the version the deployment bakes (the
  runtime profile the upload page shows),
- a Python package may be pinned only once.

The `esbuild` pin in the example earlier in this file (`0.24.2`) is not the
baked version, so an upload naming it is refused. Copy pins from the runtime
profile.

### Run shapes: the closed list

A pack may declare runs in seven shapes only. The four test-run shapes are
matched on `language`, `harness`, `hiddenHarness` and `transform` exactly as the
manifest writes them:

| Shape | `language` | `harness` | `hiddenHarness` | `transform` |
|---|---|---|---|---|
| `run-python-hidden` | `python` | `pytest` | `unittest` | absent or `false` |
| `run-typescript-hidden` | `typescript` | `js` | `js` | `true` |
| `run-python` | `python` | `pytest` | absent | absent or `false` |
| `run-typescript` | `typescript` | `js` | absent | `true` |

So, for an upload:

- Declare `runs[]` on every `code` and `tests` phase, and write `language` and
  `harness` on every run, `hiddenHarness` on a run with a hidden suite, and
  `transform: true` on a TypeScript run. The upload does not fill in the
  defaults the table under `checks.runs` describes. A Python learner run uses
  `pytest`, not `unittest`.
- A hidden suite (`hidden_tests/<run id>/`) holds at least one file, and
  every file in it is a test file the runner
  executes with its own command: `test_*.py` on a Python run, `*.test.ts` or
  `*.test.tsx` on a TypeScript run. Helper modules do not go in it.

The other three shapes are the only places a command may appear:

| Shape | Where | The argv |
|---|---|---|
| `smoke-python` | `checks.smoke.commands`, each entry | `["python3", "<a .py file under smoke/>"]`, optionally followed by `"--selfcheck"` and nothing else |
| `preview-python` | `preview.service.command` and `preview.seed` | `["python3", "<a .py file the phases mount read-only>"]`, with no argument |
| `drill-faulted-files` | `checks.drill` | no command at all: only the files under `drill/`, swapped in before the smoke check runs again |

Rules that go with them:

- A command is an array of non-empty words. A command written as one string is
  refused.
- The first word is `python3`. The general rule above also allows `node` for the
  preview and the smoke check; an upload does not.
- The second word is a Python file the pack ships: for the smoke check, a file
  under `smoke/` at that path (`api/main.py` means `smoke/api/main.py`); for
  the preview and its seed, a file the phases mount read-only at that path
  (`api/main.py` means `readonly/api/main.py`).
- No word may hold a space, a tab, a line feed, a carriage return or any of
  ``; & | ` $ < > ( ) { } [ ] * ? ! ~ ' " \ # =``.
- The keys `command`, `commands`, `cmd`, `argv`, `shell`, `script`,
  `entrypoint`, `exec` and `run` are refused anywhere else in `project.json` or
  a `phase.json`, a `tasks` entry included.

### Run limits

A learner's run gets 15 seconds and 256 MB by default; the deployment sets
them. Any `timeoutSeconds`, `timeout`, `memoryMb` or `memory` a pack declares,
anywhere in `project.json` or a `phase.json`, must be a whole number above zero
and no higher than the deployment's limit, or the upload is refused. A pack
never needs to declare either.

### Sealed bytes stay out of learner files

The two byte rules the importer already holds are asked of an upload before
anything is written: no file a learner reads may hold the bytes of a hidden
test, and no file a learner edits may hold the bytes of the reference solution.

### The microVM ceiling

One full pass of a phase may boot at most 10 microVMs, and one full pass of the
version at most 24, priced by the compiler's own count: each run of a `code`
phase counts two, each run and each mutant of a `tests` phase counts one, and a
`config` phase counts one for its smoke check plus one for its drill. Over
either ceiling, the upload is refused, and so is a publish.

### The archive layout for sealed roles, as the export writes it

The export writes a version back as one stored zip under one top-level folder
named for the project's address, in [the archive layout](#the-archive-layout).
Entries are sorted by name and carry one fixed date. `project.json`, every
`phase.json`, every quiz file and every mutant's `meta.json` are rewritten from
what the platform holds, with two-space indentation; a requirements interview
is written from the stored interview. Each phase the version holds is one
folder, `phases/<NN>-<key>`, `NN` its place in the version, and every file is
written under the workspace path it lands on:

```
<address>/project.json                       no phase list and no warm-up
<address>/phases/NN-<key>/phase.json         the version's compiled task, below
<address>/phases/NN-<key>/interview.json     a requirements interview
<address>/phases/NN-<key>/quizzes/<task key>.json   each concept quiz of the phase
<address>/phases/NN-<key>/files/<path>       every file the learner edits, starting records included
<address>/phases/NN-<key>/readonly/<path>    every locked file
<address>/phases/NN-<key>/hidden_tests/<run id>/<path>   code: the hidden suite, per run    (sealed role: hidden)
<address>/phases/NN-<key>/solution/<path>    code: the reference solution                 (sealed role: solution)
<address>/phases/NN-<key>/reference/<path>   tests: the reference suite                   (sealed role: reference)
<address>/phases/NN-<key>/impl/<path>        tests: the implementation it is graded against (sealed role: reference)
<address>/phases/NN-<key>/mutants/<name>/meta.json and <path>   tests: one mutant         (sealed role: mutant)
<address>/phases/NN-<key>/smoke/<path>       config: a file the smoke run builds from
<address>/phases/NN-<key>/drill/<path>       config: the drill's faulted copy               (sealed role: drill)
```

- Every mount is written in every phase that mounts it, so a file two phases
  mount is written twice; `canonical/` is never written.
- A starting record is written at its workspace path
  (`files/deployment/runbook.json`, `files/maintenance/change-request.json`)
  unless it is the empty record the upload seeds again.
- `phase.json` is written from the version's compiled task, not the phase's
  raw content: its title, brief (`taskPanel`), objectives, rubric, checks,
  records and sign-off mark are the task's as the editor last saved them, so
  every edit the builders make travels. Every text member is written plain,
  so a version published before the plain-text rule exports plain text.
- Each quiz is written as `quizzes/<task key>.json`, with its title, its plain
  brief, its `order` among the phase's tasks, its objectives, its required
  mark and its checks.
- Each mutant's `meta.json` holds `name`, `description`, `covers` when it has
  one, and `run`. A mutant is written whole or not at all.

In a copy of a project the teacher does not own, sealed files that came with
the copy are left out of the archive and listed as withheld (path, sha256 and
size). An archive with a withheld file may be refused by the upload, or it may
load with a smaller suite: the loader reads whatever `mutants/` and each run's
folder under `hidden_tests/` hold, so an archive that withholds only whole
mutants, or some of a run's hidden tests, uploads and grades with what
remains. The teacher writes their own files at the withheld paths before
uploading it.

### The task block in phase.json

A phase's one task is written as the phase itself: the task's title is the
phase's `title`, its brief is the phase's `taskPanel` and its objectives are
the phase's `objectives`. An uploaded `phase.json` may also hold a `task` block that gives
the task words of its own, and the teacher's sign-off mark:

```json
"task": {
  "key": "main",
  "title": "Write SH-5, the free-to-borrow story",
  "objectives": [
    "Write SH-5 in the As a / I want / so that form",
    "Cover the case of a book that is already on loan"
  ],
  "signOff": true
}
```

The block is optional, and every member is optional. Its members, and the
limits on each, are the ones the editor's task form uses:

| Member | What it is | Limit |
|---|---|---|
| `key` | Names the task. It never renames it. If present, it must be `"main"`, the key of a phase's one task. | Any other value is refused. |
| `title` | The task's title. The phase keeps its own `title`. | Text, at most 160 characters, and not empty after trimming. |
| `objectives` | The task's objectives. Learners read them in place of the phase's `objectives`. | A list of at most 20 texts. Each text is at most 300 characters and not empty after trimming. An empty list clears them. |
| `signOff` | Whether the task needs the teacher's sign-off: the editor's **Needs your sign-off** mark. A learner who passes a task marked `true` waits in the class's sign-off queue until a teacher signs it off. Absent leaves the task as the phase compiles it (no sign-off). | A boolean, `true` or `false`. Anything else is refused: `its signOff must be true or false`. |

- The block has no `brief`: the phase's `taskPanel` is its one task's brief.
  A `brief` member is refused in a folder-layout archive:
  "phases/03-implementation's phase.json task block: the brief is the phase's
  taskPanel now; move it there." In an older-layout archive the conversion
  applies it: the block's brief becomes the phase's `taskPanel`, and its
  limits are the brief's (at most 20,000 characters, not empty after
  trimming).
- A limit counts characters as the editor's task form does, and text is stored
  trimmed, in plain text. A folder-layout block's texts are trimmed before
  they are measured. An older-layout archive's block is measured as it was
  sent, before the conversion moves its brief, so a space or line break at
  either end counts toward its limit there.
- The block is allowed only on a phase that compiles to exactly one task a
  learner works, with quizzes aside. Every phase an upload compiles today is
  such a phase.
- The block carries no sealed content, because it has no member for any.
  Hidden tests, the reference solution, mutants and drills stay where the
  layout above puts them.
- Any other member is refused, and so is a value of the wrong type or past its
  limit. A refused block imports nothing. The upload answers "This archive is
  not a project in the authoring format, so nothing was imported." Its detail
  line names the phase folder, the member and the limit, in the shape
  `<folder>'s phase.json task block: <reason>`, for example:
  `phases/01-requirements's phase.json task block: A title is at most 160
  characters, and this one is 161.` It never repeats the value. For a member
  the block does not have, the reason is: `it holds a member the editor does
  not have; a task block holds only key, title, brief, objectives and signOff
  (its sign-off)` in an older-layout archive, and `... a task block holds
  only key, title, objectives and signOff (its sign-off)` in a folder-layout
  one ("2 members", and so on, when it holds more than one).
- The upload applies the block exactly as the editor applies the same words
  and the same mark. So an uploaded task reads as if the words had been typed,
  and the mark ticked, in the editor after the upload. A block that holds only
  `key`, or nothing at all, changes nothing.
- Only the upload reads the block. A pack under `content/` that is loaded at
  boot does not apply it, and its loader ignores the key.

**What the export writes.** The export writes each phase's `phase.json` from
the version's compiled task, so the task's brief is the phase's `taskPanel`
and its objectives are the phase's `objectives`. The `task` block is written
only for a task title that differs from the phase's, and for `"signOff": true`
on a task marked as needing sign-off (the phase's own task has none, so
`false` is never written). `key` is never written. An untouched phase gets no
block.

**Every edit travels.** The rubric, the checks, what a task hands in, whether
it is required and the files it owns are written as the editor last saved
them, and a quiz beside the work task is written as its own file under
`quizzes/`. An export is refused for a phase whose work task is gone and only
quizzes are left, because a phase folder holds its work task: "<Phase> holds
no work task, only quizzes, and a phase folder holds its work task. Put the
phase's task back, or remove the phase, and export again."
