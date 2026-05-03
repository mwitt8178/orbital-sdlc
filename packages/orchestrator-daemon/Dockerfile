# syntax=docker/dockerfile:1.7
#
# @orbital/orchestrator-daemon — runtime image.
#
# Multi-stage build:
#   1. base   — Node 22, OS deps the daemon needs at runtime (git, curl, ca-certs)
#   2. deps   — full monorepo install for tsc compile
#   3. build  — compile TypeScript via tsc -b
#   4. runtime — slim image with only the compiled output + prod deps
#
# Runtime user is non-root. Health endpoint listens on :3000.
#
# The daemon spawns Claude workers via CLAUDE_BIN. The Claude CLI must be
# installed in the runtime image; for the first cut we install it via the
# official tarball and document the version pin. The image is rebuilt when
# the Claude CLI version is bumped.

ARG NODE_VERSION=22.11.0

#-----------------------------------------------------------------------------
# Stage 1: base — OS-level deps
#-----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS base
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        curl \
        tini \
    ; \
    rm -rf /var/lib/apt/lists/*

#-----------------------------------------------------------------------------
# Stage 2: deps — install full workspace dev+prod deps for tsc
#-----------------------------------------------------------------------------
FROM base AS deps
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/orchestrator-daemon/package.json packages/orchestrator-daemon/
COPY packages/api-lambda/package.json packages/api-lambda/
COPY packages/ui/package.json packages/ui/
COPY infra/package.json infra/
RUN npm ci --workspaces --include-workspace-root

#-----------------------------------------------------------------------------
# Stage 3: build — tsc compile types + orchestrator + daemon
#-----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /workspace
COPY tsconfig.base.json tsconfig.json ./
COPY packages/types packages/types
COPY packages/orchestrator packages/orchestrator
COPY packages/orchestrator-daemon packages/orchestrator-daemon
COPY scripts scripts
RUN npm run build -w @orbital/types
RUN npm run build -w @orbital/orchestrator
RUN npm run build -w @orbital/orchestrator-daemon

#-----------------------------------------------------------------------------
# Stage 4: runtime — slim image, prod deps only
#-----------------------------------------------------------------------------
FROM base AS runtime

# Non-root user
RUN groupadd --system --gid 10001 orbital \
 && useradd  --system --gid orbital --uid 10001 --shell /bin/bash --home /home/orbital --create-home orbital \
 && mkdir -p /var/orbital \
 && chown orbital:orbital /var/orbital

WORKDIR /app

# Copy only what runtime needs.
COPY --from=build --chown=orbital:orbital /workspace/package.json /workspace/package-lock.json ./
COPY --from=build --chown=orbital:orbital /workspace/packages/types/package.json packages/types/
COPY --from=build --chown=orbital:orbital /workspace/packages/types/dist packages/types/dist
COPY --from=build --chown=orbital:orbital /workspace/packages/orchestrator/package.json packages/orchestrator/
COPY --from=build --chown=orbital:orbital /workspace/packages/orchestrator/dist packages/orchestrator/dist
COPY --from=build --chown=orbital:orbital /workspace/packages/orchestrator-daemon/package.json packages/orchestrator-daemon/
COPY --from=build --chown=orbital:orbital /workspace/packages/orchestrator-daemon/dist packages/orchestrator-daemon/dist

# Production-only install — pulls just the runtime deps for the daemon
# workspace (node_modules at the workspace root).
RUN npm ci --workspaces --include-workspace-root --omit=dev \
 && npm cache clean --force

USER orbital
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=3500" \
    DAEMON_HEALTH_PORT=3000 \
    ORBITAL_HOME=/var/orbital \
    ORBITAL_DEPLOY_TARGET=aws

EXPOSE 3000

# tini reaps zombies and forwards SIGTERM correctly so the daemon's
# graceful-shutdown logic actually fires.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "packages/orchestrator-daemon/dist/main.js"]

# Container-level health check — Fargate also runs its own task-level
# health check pointing at /health, but this gives docker run a hint too.
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
