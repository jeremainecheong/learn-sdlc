# Notes for the Maintenance phase

The learner ships change request CHG-1: the shelf follows the author's
surname, then the title, then the id. They change the API and the page
without breaking lending, returning or the author filter.

Sealed files, which no learner reads:

- `hidden_tests/api` and `hidden_tests/web`, the tests a submission is graded
  by. Replace both before you assign the project.
- `solution`, the reference change deep validation proves the hidden tests
  against.

A submission runs two suites, each twice, so the phase costs 4 microVMs.
