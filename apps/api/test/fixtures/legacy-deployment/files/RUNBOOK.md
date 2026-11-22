# TaskTrackr runbook

For whoever is holding the pager. Write it for an operator who has never read this
code, at three in the morning, on a phone.

## Deploying

This section is finished, as the example of what a filled one looks like: a command
somebody can type, and one sentence saying what it does.

```
docker compose up -d --build
```

Builds both images, starts `api`, waits for it to report healthy, then starts `web`
on port 5173. Nothing else is needed on the host.

## Environment variables

<!-- TODO(learner): document the variables the two services read. For each one:
     its name, which service reads it, what it controls, and its default.
     TASKTRACKR_DB and API_URL are the two an operator changes; PORT and HOST are
     worth a line each. api/Dockerfile and docker-compose.yml beside you are the
     list, not the explanation — the explanation is what you are writing. -->

## Health check

<!-- TODO(learner): the one command an operator runs to prove the deployment is
     alive, and the output that proves it. There are two answers and both are
     worth writing down: the endpoint compose itself waits on, and the command
     that checks the whole deployment rather than one process. -->

## Rollback

<!-- TODO(learner): exactly what to type when a release goes wrong, to get back
     to the previous known-good images. Then the part everybody forgets: say what
     a rollback does NOT undo. -->

## Data

<!-- TODO(learner): where the data lives, and what survives what. Which volume
     holds the database file, which commands keep it and which delete it, how to
     take a backup and how to put one back. An operator who redeploys without
     knowing this is one flag away from an empty database. -->

## Incident

<!-- TODO(learner): fill this in after INCIDENT-1. Record what an operator saw,
     the setting that caused it (name the setting), the one line you changed, and
     the check that now proves the fix. Write it for the person who was not on the
     call. -->

**INCIDENT-1**

- Symptom:
- Root cause:
- Fix:
- Proof:
