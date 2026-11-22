# The web service: build the bundle, then ship the bundle and a tiny server.
#
# Two stages, because esbuild and node_modules belong to the build and not to
# the thing that runs: the image that ends up on the machine is node, one
# JavaScript file of our own, and the bundle.
#
# The build context is the project root, not web/, because package.json — which
# names the build — lives there.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY web ./web
COPY shared ./shared
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5173
ENV HOST=0.0.0.0
COPY web/serve.js ./web/serve.js
COPY web/index.html ./web/index.html
COPY --from=build /app/web/dist ./web/dist
EXPOSE 5173
ENTRYPOINT ["node", "web/serve.js"]
