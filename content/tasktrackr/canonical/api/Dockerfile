# syntax=docker/dockerfile:1
# The TaskTrackr API: Flask over a SQLite file on a volume.

FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY api/ ./api/
COPY ops/ ./ops/
# ops/selfcheck.py reads the compose file to check that the web service is
# pointed at this one, so the image carries the deployment it belongs to.
COPY docker-compose.yml ./

ENV TASKTRACKR_DB=/data/tasktrackr.db
ENV HOST=0.0.0.0
ENV PORT=8000
VOLUME ["/data"]
EXPOSE 8000

ENTRYPOINT ["python3", "api/main.py"]
