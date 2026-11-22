# Notes for the Implementation phase

The learner fills four marked gaps: two in `api/shelf.py` and two in
`web/src/lib/shelf.ts`. The visible tests in the workspace can be run before
they submit.

Sealed files, which no learner reads:

- `hidden_tests/api` and `hidden_tests/web`, the tests a submission is graded
  by. Replace both before you assign the project.
- `solution`, the reference implementation deep validation proves the hidden
  tests against.

A submission runs two suites, each twice, so the phase costs 4 microVMs.
