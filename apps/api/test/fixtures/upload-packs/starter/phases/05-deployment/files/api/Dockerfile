# The image the shelf API ships in. Build it from the project root:
#   docker build -f api/Dockerfile -t shelf-api .
FROM python:3.11-slim

# TODO(learner): set the directory everything below runs in.

# TODO(learner): copy the application into the image (api/ and deploy/).

RUN pip install --no-cache-dir flask==3.1.3

ENV PORT=8000
EXPOSE 8000

# TODO(learner): start the API, in exec form, so `docker run shelf-api --selfcheck` reaches it.
