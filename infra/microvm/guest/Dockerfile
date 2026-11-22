# Build context: LearnSDLC repository root. package.py also creates the exact
# allowlisted ZIP that AWS image builds consume, with this as /Dockerfile.
# AWS's base includes the snapshot-compatible OpenSSL implementation.
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3

RUN dnf update -y --releasever=latest \
    && dnf install -y --releasever=latest python3.11 python3.11-pip nodejs22 nodejs22-npm tar gzip findutils \
    && dnf clean all \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
    && python3 --version \
    && node --version

COPY apps/api/runner /runner
COPY infra/microvm/guest/gateway.py /opt/learnsdlc-guest/gateway.py
COPY infra/microvm/guest/install_runtime.py /opt/learnsdlc-guest/install_runtime.py

# The archive carries the manifest only, never macOS wheels/esbuild/node_modules.
# Rebuild those exact pack-declared dependencies for ARM Linux inside the image.
RUN python3 /opt/learnsdlc-guest/install_runtime.py \
    && chown -R 0:0 /runner /opt/learnsdlc-guest \
    && chmod -R a-w /runner /opt/learnsdlc-guest \
    && find /usr -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} + \
    && mkdir -p /run/learnsdlc-guest \
    && chmod 700 /run/learnsdlc-guest

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8081
WORKDIR /opt/learnsdlc-guest
# Only this controller has uid 0. It drops uid/gid/capabilities/no_new_privs
# before starting the runner, never inherits a token into the learner process.
USER 0:0
ENTRYPOINT ["/usr/local/bin/python3", "/opt/learnsdlc-guest/gateway.py"]
