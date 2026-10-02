# syntax=docker/dockerfile:1.7

# Stage 1: install production dependencies from the committed lockfile.
# The project has no runtime dependencies, so this stage is deliberately thin
# and never runs a lifecycle script or reaches for an unpinned package.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `--ignore-scripts` denies every dependency's lifecycle hooks, so nothing in
# the tree can execute code during the image build.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Stage 2: the runtime image.
FROM node:24-alpine AS runtime

# `tini` reaps zombies and forwards signals so SIGTERM reaches Node and the
# graceful shutdown path actually runs inside a container.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/app/data \
    LOG_LEVEL=info

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
# `scripts/` is deliberately NOT copied: it is excluded from the build context
# by .dockerignore and holds the linter, which is not runtime code.

# The inventory database is the only writable path the app needs.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Drop root: a compromise of the app process must not yield a privileged shell.
USER node

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --output-document=- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
