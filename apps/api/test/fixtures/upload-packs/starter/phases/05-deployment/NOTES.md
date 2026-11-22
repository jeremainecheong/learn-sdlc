# Notes for the Deployment phase

The learner finishes `api/Dockerfile` so the image starts the API. The
runbook an operator reads is a record, not a file: the learner fills it in
the Runbook tab, and its floor (how many health checks and rollback steps it
needs, and whether the incident must be closed) is set in the editor's
Runbook step. The service's own selfcheck decides whether a configuration is
fit to ship.

Sealed files, which no learner reads:

- `drill/shelf.json`, a broken configuration that sets the port to 0. The
  drill swaps it in, and the learner closes the incident on the drill page
  with what broke.

One smoke run and one drill run make 2 microVMs for this phase.
