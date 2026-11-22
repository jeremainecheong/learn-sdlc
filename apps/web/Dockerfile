# LearnSDLC web client: Next.js, standalone output.
# Build from the learnsdlc/ monorepo root:
#   docker build -f apps/web/Dockerfile -t learnsdlc-web . \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.edu \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://learnsdlc.example.edu
#
# Both NEXT_PUBLIC_* values are build args, not runtime env: `next build`
# substitutes them into the client bundle and into the prerendered canonical,
# og:url, sitemap and robots output. Passing them to `docker run` instead leaves
# the image advertising localhost. Changing either one needs a rebuild. The
# defaults below are the app's own fallbacks, kept in apps/web/public-env.js.

FROM node:24.21.0-slim AS build
WORKDIR /app
# next build and next start both phone home otherwise, on every image build
# and in every container. A deployment should make no request its operator
# did not ask for.
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# Who runs this deployment, shown on /privacy and /terms (lib/operator.ts
# carries the defaults); inlined at build like the URLs above.
ARG NEXT_PUBLIC_OPERATOR_NAME
ENV NEXT_PUBLIC_OPERATOR_NAME=$NEXT_PUBLIC_OPERATOR_NAME
ARG NEXT_PUBLIC_OPERATOR_EMAIL
ENV NEXT_PUBLIC_OPERATOR_EMAIL=$NEXT_PUBLIC_OPERATOR_EMAIL
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @learnsdlc/shared --workspace @learnsdlc/web
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @learnsdlc/shared && npm run build -w @learnsdlc/web \
    && rm -rf apps/web/.next/cache

FROM node:24.21.0-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# `output: 'standalone'` (next.config.js) traces the files the server needs
# into .next/standalone, a few tens of MB instead of the monorepo's whole
# node_modules. The tracing root is the monorepo, so the tree keeps its
# apps/web/ prefix. Static assets are not traced and are copied alongside.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
# node:slim ships no curl, and the image should not grow one for a probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
