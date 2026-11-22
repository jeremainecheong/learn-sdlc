# Contributing to LearnSDLC

Thank you for looking at LearnSDLC from SMU SCIS. This page says how to set up, how to propose a change, what a pull request must show and how commits are worded here.

Please read the [code of conduct](CODE_OF_CONDUCT.md) first. To report a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Licence: read this before you write code

No licence has been chosen yet; until a LICENSE file is added, all rights are reserved.

This means outside contributions cannot be merged until a licence is chosen. You are welcome to open issues, report bugs and discuss ideas now. A pull request from outside the maintainers will stay open, unmerged, until the repository has a licence and the maintainers have said how contributions are accepted under it.

## Setting up

[docs/development.md](docs/development.md) is the full guide: the layout of the repository, its conventions and the everyday commands. [docs/local-run.md](docs/local-run.md) says how to run the product on your own machine.

The short version, from this folder:

```bash
nvm install        # reads .nvmrc
npm ci
npm run typecheck  # builds packages/shared first, then type-checks every workspace and the browser suite
```

Two things decide what you can run on your machine:

- **Learner code runs only where the kernel can isolate it.** That is Linux with Landlock (kernel 5.13 or newer), or Docker, which on macOS and Windows runs inside a Linux virtual machine whose kernel must have Landlock (on a Mac, Colima; Docker Desktop's kernel does not). On a Mac without Docker the product starts and every page works, but running, testing and grading learner code is refused, and the runner's tests that start learner code cannot pass. The continuous integration workflow runs those tests on Linux.
- **The AI features need an OpenAI API key** from the person running the product (`OPENAI_API_KEY` in `.env`). The test suites run without one: the API's specs replace the provider, and the browser suite starts a canned AI stub (`e2e/ai-stub.cjs`) and points the API at it. `npm run demo -- --ai-stub` starts the product with that canned test mentor, for a trial without a key.

## Proposing a change

1. For anything larger than a small fix, open an issue first (there are forms for a bug and for a feature) so the change can be discussed before you build it.
2. Branch from `main` and keep one pull request to one change.
3. A change in behaviour comes with a test that fails without it and passes with it.
4. Update the documents the change makes untrue in the same pull request. Documents are written in plain British English, in the present tense, and say how things are.
5. Open the pull request and fill in its checklist.

## What a pull request must show

The pull request template carries this list. Tick each item, or say why it does not apply.

- **Type-check.** `npm run typecheck` passes.
- **The tests of the area you changed** pass, and the pull request names the commands you ran. Do not run the whole of every suite for a small change; run the files that cover it. [docs/testing.md](docs/testing.md) describes every suite and what each needs.

  | You changed | Run at least |
  |---|---|
  | `apps/api/src`, `apps/api/test` or `packages/shared/src` | `npm run test -w @learnsdlc/api -- <path to the spec>` |
  | `apps/web` | `npm run test -w @learnsdlc/web -- <path to the test>` |
  | `apps/api/runner` | `python3.11 -m pytest apps/api/runner/<test file> -q` (tests that start learner code need Linux with Landlock) |
  | `scripts/` | `npm run test:scripts` |
  | `infra/` | `npm run test:infra` (it needs `apps/api/runner/runtime/manifest.json`, which `npm run prebake` writes) |
  | `content/` | `npm run content:check` |
  | a whole journey through the browser | `npm run e2e` (see [docs/testing.md](docs/testing.md) for what it needs) |

- **Copy lint for web copy.** If you changed words a learner or teacher reads in `apps/web`, `npm run lint:copy -w @learnsdlc/web` passes. If you changed `docs/teacher-project-upload.md`, the app shows parts of it: run `npm run gen:teacher-guide -w @learnsdlc/web` and commit the regenerated module, and `npm run check:teacher-guide -w @learnsdlc/web` passes.
- **No change to an applied migration.** A migration in `apps/api/src/migrations` is frozen by name and by body once it exists: renaming or editing it makes an existing database run it again, out of order, or differently from a fresh one. A schema change is always a new migration. `apps/api/src/db/database.module.ts` explains why.
- **No byte changed under `content/` without a new pack version.** A published pack version is immutable, because learners are pinned to the version they started on. Any change to a pack raises the `version` in its `project.json`. See [Changing a pack means bumping its version](docs/authoring-format.md#changing-a-pack-means-bumping-its-version-this-is-a-requirement).
- **No secret in the change.** Keys, passwords, tokens and private addresses come from the environment. `.env` and its local variants are ignored by git; `.env.example` holds only placeholders and defaults.
- **The runbook names what operators see.** A new model-call label or outcome is named, in backticks, in [docs/production-runbook.md](docs/production-runbook.md); `apps/api/src/assistant/assistant-wiring.spec.ts` checks it.

## How commits are worded

Each commit message is one plain sentence, in the present tense, that says what the code now does. It does not say what you did, and it carries no prefix, ticket number or tag. Some from this repository's history:

- Creating a class is limited to 60 a minute per teacher, the console rate every other teacher console route carries
- Every page and helper that shortens a project's title to its name calls projectName from lib/project-name.ts
- Quiz papers and option tokens are keyed with QUIZ_SEED_SECRET when it is set, and with the JWT secret when it is not

A merge commit says, in one sentence, what the merged branch brings, starting "Merge the".

## Comments in code

A comment says what the code does and why it must be so, for a reader who opens the file cold. It does not narrate how the code came to be.
