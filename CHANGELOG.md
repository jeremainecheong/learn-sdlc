# Changelog

This file records each released version of LearnSDLC from SMU SCIS. The version is the one in the root `package.json`.

## 1.0.0 (21 November 2026)

The first published version. LearnSDLC is a web application in which a learner who can already code carries one real project through the six phases of the software development life cycle: requirements, design, implementation, testing, deployment and maintenance.

For learners:

- TaskTrackr, the reference project: a web application with a Python API, a TypeScript front end and a SQLite database, with work in all six phases.
- A browser workspace for each phase: the brief, a code editor, and a panel shaped like the phase's artefact (an issue form, a design editor, a pull request, a kill matrix, an incident drill, a change request).
- Learner code that runs, is tested and is graded in a sandbox, with the learner's own app open in the browser beside the code from implementation on.
- A phase-aware AI mentor that guides without writing the answer, a stakeholder interview, and an Agentic assistant that proposes a change and applies it only after the learner has explained it correctly.
- Grading of both the artefact and the process, with a gate before each next phase; a project map, a journal, an artefact shelf, quizzes, and the whole project as a downloadable git repository.
- Six phase guides with lessons and practice.

For teachers:

- An instructor console: the class map, lecture points, a queue of learners who need attention, each learner's page, gate overrides with a written reason, a sign-off queue, an audit trail and CSV exports, quiz results included.
- A teacher's own project: copy one or upload an archive, edit its tasks and hidden tests, prove it in the sandbox and publish it to a class, with any of the six phases in order.

For operators:

- One command for a local run on SQLite (`npm run demo`), and a Docker stack with PostgreSQL and Redis (`npm run demo -- --docker`).
- A production Compose file with a TLS edge, the code runner in an isolated container, and daily backups.
- Learner code that runs only under kernel isolation (Linux with Landlock, or a single-job MicroVM), and is refused elsewhere.
- An OpenAI-compatible provider for the AI features, with the operator's own key; [docs/local-run.md](docs/local-run.md) says which providers the code supports.
- Optional Google sign-in and Amazon Cognito sign-in.
- A reference AWS deployment, with learner code in single-job Lambda MicroVMs.
