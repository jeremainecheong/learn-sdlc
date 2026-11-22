# Testing: prove the backlog

Write acceptance tests for SH-1 to SH-4 in `tests/test_acceptance.py` (the API)
and `web/src/lib/acceptance.test.ts` (the page). The graders run your suites
against the working application and against copies of it with bugs planted in
them; a good suite passes on the first and fails on every one of the others.

## What good looks like

- Every test passes against the working application.
- At least one test per acceptance criterion, asserting what a person or a
  client would see, not only a status code.
- Cases about the author filter, lending, returning and the "on loan" line.

## Using the AI mentor well

Ask the mentor which acceptance criterion a test of yours does not yet cover.
