# syntax=docker/dockerfile:1.7
#
# Production image for @bbm/api (Fastify).
#
# Build from the REPO ROOT (the pnpm workspace root) with BuildKit:
#   docker build -f apps/api/Dockerfile -t bbm-api .
#
# Run:
#   docker run -p 3001:3001 -e DATABASE_URL=postgres://... bbm-api
# One-off migration job (same image):
#   docker run --rm -e DATABASE_URL=postgres://... bbm-api node dist/migrate-cli.js
#
# Uploaded sources are written to /data/sources (SOURCE_STORAGE_DIR); mount a
# volume there to keep them across container restarts.

ARG NODE_VERSION=20.17.0
ARG PNPM_VERSION=9.15.9

# ---------------------------------------------------------------------------
# base: Node + pnpm. Corepack bundled with Node 20.17 fails signature checks
# ("Cannot find matching keyid"), so pnpm is installed with npm instead.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
RUN npm install -g "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && pnpm config set store-dir /pnpm/store
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: install the workspace deps @bbm/api needs (incl. dev deps for the
# build). Only the lockfile and package manifests are copied, so this layer is
# reused until dependencies change.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
# `pnpm fetch` needs only the lockfile: it fills the store (BuildKit cache
# mount) so the install below runs from it.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --filter "@bbm/api..."

# ---------------------------------------------------------------------------
# build: typecheck + esbuild bundle (dist/index.js, dist/migrate-cli.js,
# dist/migrations/*.sql), then `pnpm deploy` a production-only copy of the
# package (fastify, @fastify/multipart, pg) into /out.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @bbm/api build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @bbm/api deploy --prod --prefer-offline /out

# ---------------------------------------------------------------------------
# runtime: plain Node, no pnpm, no dev deps, no sources. App files stay
# root-owned (read-only for the app); only /data/sources is writable.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/cse416-fa26-sixseven/bug-bounty-marketplace" \
      org.opencontainers.image.title="bbm-api" \
      org.opencontainers.image.description="Bug Bounty Marketplace API (Fastify): contract uploads, bounties and findings"

ENV NODE_ENV=production \
    PORT=3001 \
    SOURCE_STORAGE_DIR=/data/sources

WORKDIR /app
RUN mkdir -p /data/sources && chown -R node:node /data

# package.json is required at runtime: it carries "type": "module" for dist/*.js.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# The API handles SIGTERM itself (closes the server and the pg pool, exits 0;
# forced exit after 10 s), so no init process is required. Node is PID 1 here,
# so enable `init: true` in compose if you want zombie reaping.
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist/index.js"]
