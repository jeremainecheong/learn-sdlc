# Notes for the Testing phase

The learner writes acceptance tests for the API and the page. Their tests
run against a working implementation, then against each planted fault, and
a good suite passes the first and catches the rest.

Sealed files, which no learner reads:

- `impl`, the working implementation the learner's tests run against.
- `mutants`, four planted faults, each with a `meta.json` that says what it
  breaks. Replace them before you assign the project.
- `reference`, a model test suite that deep validation proves catches every
  planted fault.

Two runs and four planted faults make 6 microVMs for this phase.
