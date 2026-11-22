# The image that runs the deployment selfcheck. LearnSDLC starts the selfcheck
# through this ENTRYPOINT; it does not build the image.
FROM python:3.11-slim
WORKDIR /app
COPY . /app
ENTRYPOINT ["python3", "ops/selfcheck.py"]
