# Deployment: package the API

Finish `api/Dockerfile` so the image starts the API, and write the runbook an
operator reads at 3am. Then run the selfcheck, and run the drill: a broken
configuration is swapped in, and you write down what broke.

## What good looks like

- The Dockerfile sets a working directory, copies the application and starts
  `api/main.py` in exec form, with no TODO left.
- The runbook says how to check the service is healthy, how to roll back, and
  what the drill's incident was.

## Using the AI mentor well

Ask what each Dockerfile instruction changes about the image; write the
instructions yourself.
