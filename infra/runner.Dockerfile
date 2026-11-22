# LearnSDLC runner service: the container learner code actually runs in.
# Build from the repository root:
#   docker build -f infra/runner.Dockerfile -t learnsdlc-runner .
#
# This image is the isolation boundary, so it is built to hold nothing worth
# stealing and nothing to steal it with: no application code, no secrets in
# its environment, no curl/wget, and a non-root uid that owns nothing. The
# API talks to it only through a UNIX socket on a shared volume
# (RUNNER_SOCKET); docker-compose.yml runs it with network_mode: none, a
# read-only rootfs, dropped capabilities and a pid limit.

# The Node version learner code is graded on, the same one CI tests with
# (CI_LEARNER_NODE_VERSION in .github/workflows/ci.yml). Change both together.
FROM node:22.23.2-slim AS node

FROM python:3.11-slim
# Node's official binary needs libstdc++, which python:slim does not carry.
# Everything else the JS harness needs is the stdlib of either runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node

COPY apps/api/runner /runner

# ---------------------------------------------------------------- the pre-bake
#
# A graded run has no network and no package manager, so Flask, pytest, React,
# jsdom and esbuild have to be on disk before the first job arrives. They are
# built here rather than copied from the build host: the host is usually an
# Apple Silicon laptop and esbuild is a native binary, so a copy would put a
# darwin-arm64 executable in a linux image and every transform would fail with
# "exec format error". markupsafe's wheel is platform-specific for the same
# reason. What the host contributes is the manifest the packs' pinned versions
# hash to; write it with `node scripts/prebake.mjs manifest` (which installs
# nothing) before building this image, or the check below stops here with a
# sentence rather than three layers later with a traceback.
RUN { test -f /runner/runtime/manifest.json \
         || { echo "apps/api/runner/runtime/manifest.json is missing: run 'node scripts/prebake.mjs manifest' before building this image" >&2; exit 1; }; }

# The bake sits after the source COPY, so a change to sandbox_runner.py costs a
# rebuild of it, about a minute on a warm npm cache. The alternative is a
# .dockerignore exception and two COPYs of the same directory, which is more
# moving parts than a minute is worth; the CI job builds without a cache anyway.
#
# npm comes in for the install and goes out again at the end of the same layer,
# so the shipped image still has no package manager and no network client; the
# `docker` CI job asserts both. Only its library is copied and it is run through
# node: /usr/local/bin/npm is a symlink whose target resolves relative to itself,
# and a COPY of it dereferences into a file that cannot find its own cli.js.
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN set -eu; \
    cd /runner/runtime; \
    PYTHONPATH=/runner python3 -c "import json; from pathlib import Path; import runtime_dependencies as deps; import runtime_manifest as runtime_meta; path = Path('manifest.json'); manifest = json.loads(path.read_text()); declared = {'python': manifest['python'], 'node': {**manifest['node'], 'tools': manifest['tools']}}; deps.require(runtime_meta.digest(declared) == manifest.get('digest'), 'Runtime manifest digest mismatch'); deps.require(deps.lock_fingerprints(manifest) == manifest.get('dependencyLocks'), 'Runtime manifest lock fingerprints mismatch'); deps.prepare_runtime(path.parent); deps.install_python(manifest, Path('/runner/runtime/python')); deps.install_node(manifest, Path('/runner/runtime/node'), npm_command=['node', '/usr/local/lib/node_modules/npm/bin/npm-cli.js']); deps.install_esbuild(manifest, Path('/runner/runtime/bin')); manifest['dependencyLocks'] = deps.lock_fingerprints(manifest); manifest['platform'] = runtime_meta.platform_key(); path.write_text(json.dumps(manifest, indent=2) + '\n')"; \
    rm -rf /usr/local/lib/node_modules/npm /root/.npm; \
    chown -R 65534:65534 /runner/runtime; \
    chmod -R a-w /runner/runtime

# The runner computes LSDLC_PYLIB, NODE_PATH and ESBUILD_BIN from this and never
# takes any of them from a job.
ENV RUNNER_RUNTIME_DIR=/runner/runtime

# The socket directory is the mount point of the volume shared with the API.
# Named volumes take their ownership from the image, so creating it here as
# 65534 is what lets a non-root runner bind the socket inside it.
RUN mkdir -p /run/learnsdlc && chown 65534:65534 /run/learnsdlc && chmod 755 /run/learnsdlc

ENV RUNNER_SOCKET=/run/learnsdlc/runner.sock \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 65534:65534
WORKDIR /runner

# No curl in this image on purpose; the probe is the server's own client.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["python3", "/runner/serve.py", "--check"]
ENTRYPOINT ["python3", "/runner/serve.py"]
