# LearnSDLC API: the NestJS service.
# Build from the learnsdlc/ monorepo root:
#   docker build -f apps/api/Dockerfile -t learnsdlc-api .
#
# The API listens on loopback unless API_BIND is set. Set API_BIND=0.0.0.0
# (docker-compose.yml does) to serve outside the container; a non-loopback bind
# also requires a production JWT_SECRET.
#
# Learner code does NOT run in this image in production: RUNNER_MODE=socket
# hands jobs to the runner container (infra/runner.Dockerfile). python3 stays
# for the static analyzer, which is trusted platform code, and for the
# development-only local runner.

FROM node:24.21.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @learnsdlc/shared --workspace @learnsdlc/api
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @learnsdlc/shared && npm run build -w @learnsdlc/api
# The runtime stage copies node_modules wholesale, so what is left here is
# what ships: drop the dev dependencies (jest, ts-jest, supertest, the @types
# packages) after the build, so no test tooling reaches a host that runs
# untrusted learners' submissions. Pruning after the build rather than
# installing twice keeps the native better-sqlite3 binding that npm ci already
# produced. typeorm stays: it is a runtime dependency and the runbook's rollback
# and replica steps call its CLI. typescript and ts-node survive the prune
# because typeorm names them as optional peers; the runtime and the runbook's
# typeorm CLI calls run compiled JavaScript and use neither.
RUN npm prune --omit=dev
# npm hoists what it can to the root, but a version conflict leaves a package
# in a workspace's own node_modules instead. The runtime stage copies named
# directories, so an uncopied one is a MODULE_NOT_FOUND at boot rather than a
# build failure. These exist even when npm put nothing in them, so the COPY
# below is never conditional on which packages happened to hoist.
RUN mkdir -p node_modules apps/api/node_modules packages/shared/node_modules

FROM node:24.21.0-slim
# No curl: the health probe below uses node, so the image carries no
# ready-made network client for anything that gets a foothold in it.
# apt is switched to HTTPS before the ca-certificates package exists, so
# Node's bundled root certificates are written first as the trust store apt
# uses.
RUN node -e "const fs=require('node:fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('node:tls').rootCertificates.join('\\n')+'\\n')" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY apps/api/runner apps/api/runner
COPY content content

ENV API_PORT=4000 \
    CONTENT_DIR=/app/content \
    DB_PATH=/data/learnsdlc.sqlite
# No VOLUME for /data: production sets DATABASE_URL and never touches it, and
# a declared volume would leave an anonymous volume behind on every container
# recreate. A SQLite trial mounts /data itself (-v learnsdlc-data:/data).

# Run as an unprivileged user: the API process should never be root.
# Application files are readable, immutable code. Only the data directory
# needs runtime ownership; recursively chowning /app duplicates its whole
# dependency tree in another image layer.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 4000
# Readiness probes the database and queue, so an unhealthy container is
# reported as such instead of accepting traffic it cannot serve. The probe
# follows API_PORT, so a container started on another port still reports
# healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:'+(process.env.API_PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]
