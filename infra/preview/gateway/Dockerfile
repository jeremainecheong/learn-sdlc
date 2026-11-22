FROM python:3.13-alpine@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a
WORKDIR /opt/preview-gate
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY gate.py access.html ./
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"
CMD ["python", "gate.py"]
