# syntax=docker/dockerfile:1
# The TaskTrackr API: Flask over a SQLite file on a volume.
#
# The build context is the project root and not api/, because this image needs
# requirements.txt, api/, ops/ and docker-compose.yml, and only one of those
# lives inside api/. web/Dockerfile beside this one is finished — read it when
# a line here will not come.

FROM python:3.11-slim

# TODO(learner): set the directory the rest of this file works in (WORKDIR).
# Every COPY destination and the entrypoint's own path are read against it, so
# this line decides what "api/main.py" means further down.

# TODO(learner): copy the application into the image (COPY). It needs
# requirements.txt for the line below, api/ and ops/ to run at all, and
# docker-compose.yml because ops/selfcheck.py reads the deployment this image
# belongs to. Everything an instruction reads has to arrive before it.

RUN pip install --no-cache-dir -r requirements.txt

ENV TASKTRACKR_DB=/data/tasktrackr.db
ENV HOST=0.0.0.0
ENV PORT=8000
VOLUME ["/data"]
EXPOSE 8000

# TODO(learner): say how the container starts (ENTRYPOINT, exec form — a JSON
# array). api/main.py serves the API on PORT, and answers --selfcheck by
# checking this deployment and printing one line. The build check starts your
# container the way this line says to, so an unfinished file has nothing to
# start.
