## Your task

TaskTrackr is implemented and tested. Now make it shippable — and it ships as **two services**, not one: a Python API and a Node process that serves the front end and forwards `/api` to the API. Four deployment artefacts are scaffolded and incomplete:

1. **`api/Dockerfile`** — the base image, the environment and the volume are set. Replace the three `TODO(learner)` markers:
   - set a **`WORKDIR`** for the app,
   - **`COPY`** what the image needs — `requirements.txt` for the `pip install` below it, `api/` and `ops/` to run at all, and `docker-compose.yml`, because `ops/selfcheck.py` reads the deployment this image belongs to,
   - define an **`ENTRYPOINT`** in exec form, so `docker run tasktrackr --selfcheck` reaches `api/main.py`.

   `web/Dockerfile` beside it is finished and locked. It is the worked example: two stages, the build tools left behind in the first one. Read it when a line will not come.
2. **`docker-compose.yml`** — both services, one network and one named volume are wired. Replace the two `TODO(learner)` markers:
   - give **`api` a healthcheck** the `web` service can wait on. `web` already declares `condition: service_healthy`, so until this exists compose has nothing to wait for. The api image carries `python3` and nothing else — no `curl`, no `wget`.
   - point **`API_URL`** at the api service. Inside a compose network a service is reachable by its own name on a port it exposes; `localhost` inside a container means that container.
3. **`.github/workflows/ci.yml`** — three jobs, because this application has two suites and two images. Checkout, the runtime and the install are wired in each of them; what is missing is the line that runs something. Replace the three `TODO(learner)` markers:
   - in `test`, a step that **runs the API suite**. It installs the runner already; installing is not running. `package.json` calls this one `test:api`.
   - in `web`, a step that **runs the front-end suite** — `test:web` in the same file. Half of TaskTrackr is TypeScript, so half a pipeline tests half an application.
   - in `build`, a step that **builds both images**. Either one build per Dockerfile, each with `-f` because both are built from the project root, or one compose build for the pair. That job already `needs` both suites, so a red test never reaches it.
4. **`RUNBOOK.md`** — five sections for an operator at 3am who has never read this code. `## Deploying` is filled in as the example of what a finished section looks like; the rest are yours:
   - **Environment variables** — name `TASKTRACKR_DB` and `API_URL` and say what each controls and what it defaults to. Those are the two an operator changes; `PORT` and `HOST` are worth a line each.
   - **Health check** — one command that proves the deployment is alive, and the output that proves it. There are two good answers: the endpoint compose itself waits on, and the selfcheck that reads the whole deployment rather than one process.
   - **Rollback** — exactly what to type to get the previous known-good images back, and then the part everybody forgets: what a rollback does **not** undo.
   - **Data** — where the database lives, which commands keep it and which delete it, how to take a backup and how to put one back. The database is on a volume and the images are not, which is why rollback and data are two sections and not one.
   - **Incident** — the INCIDENT-1 record, below.

### Local selfcheck

Press **Run selfcheck** to check the saved configuration. The isolated runner compiles the Python source, reads the launcher from your `api/Dockerfile` ENTRYPOINT/CMD and WORKDIR, then invokes that launcher with the project's `--selfcheck` argument using the installed sandbox dependencies. An unfinished or unsupported launcher fails explicitly.

`ops/selfcheck.py` imports the Flask application, initializes the SQLite schema, and checks that the Compose file gives `web` an `API_URL` naming a declared service and port. It also reports whether a web bundle exists. The current successful output includes this legacy line:

```
selfcheck: web reaches api, 13 routes, 5 tables
```

Here, “web reaches api” means that the **declared Compose address is consistent**. The selfcheck makes no network request. This local check does not build either Docker image, install the Dockerfile's dependencies, execute GitHub Actions, start Compose services, or prove live HTTP health. The pipeline panel shows your authored workflow and configuration findings; unexecuted steps remain unverified.

A failed selfcheck records its actual output. Read the error, revise the configuration and rerun. A real release additionally needs successful image builds, live service and proxy checks, and a versioned release record. Do not claim those results from this selfcheck.

### INCIDENT-1

The pipeline panel carries one drill. Start it once your selfcheck passes: it runs the same isolated check against a faulted copy of your **compose file** and records the output. The incident scenario models an incorrect release configuration; it does not deploy a release. The symptom on the day was the whole application loading with every page empty, while the API was healthy and its logs were quiet. Then:

1. read the output and name the setting at fault,
2. check your own `docker-compose.yml` for the same mistake,
3. write the outage up under `## Incident` in `RUNBOOK.md`: symptom, root cause naming the setting, the line you changed, and the check that proves the fix.

The review reads that section. An incident heading with no named root cause needs revision because it tells the next operator nothing.

### What good looks like

- Each runbook section has a real command or sentence under it, not just the heading — the scaffold's comments are explanations for you, not answers.
- Both suites run in CI, so a red test in either language fails the pipeline, and the job that builds the images waits on both of them.
- The incident record names the setting (`API_URL`) and the line that changed, not just "the site was broken".

### Using the AI mentor well

Ask why instruction order matters in a Dockerfile, what exec-form `ENTRYPOINT` changes, why a service name works inside a compose network where `localhost` does not, what a healthcheck has to be able to run inside an image that carries only `python3`, or what a rollback leaves behind on the volume. It explains and critiques — the config lines are yours to write.

When you are ready, press **Submit PR-5**. Every required criterion and its evidence must pass review before the next phase opens. Passing this phase unlocks **Maintenance**, where the shipped code meets its first change request.
