# syntax=docker/dockerfile:1.7
#
# Production image for @bbm/web (Next.js standalone server).
#
# Build from the REPO ROOT (the pnpm workspace root) with BuildKit:
#   docker build -f apps/web/Dockerfile -t bbm-web .
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_MOCKING=enabled -t bbm-web:mocks .
#
# Run (API_INTERNAL_URL is read per request, so one image fits any API origin):
#   docker run -p 3000:3000 -e API_INTERNAL_URL=http://api:3001 bbm-web

ARG NODE_VERSION=22.23.4
ARG PNPM_VERSION=9.15.9

# ---------------------------------------------------------------------------
# base: Node + pnpm. Corepack bundled with older Node fails signature checks
# ("Cannot find matching keyid"), so pnpm is installed with npm instead.
# The build stages and the runtime share bookworm (glibc): sharp's native
# binaries are traced for the build platform.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
RUN npm install -g "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && pnpm config set store-dir /pnpm/store
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: install the workspace deps @bbm/web needs (incl. dev deps for the
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
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --filter "@bbm/web..."

# ---------------------------------------------------------------------------
# build: `next build` with `output: "standalone"` and the tracing root at the
# repo root, producing apps/web/.next/standalone/apps/web/server.js plus the
# traced node_modules (pnpm symlinks, kept as-is).
# ---------------------------------------------------------------------------
FROM deps AS build
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# this must be an ENV before `next build`; changing it needs a rebuild.
ARG NEXT_PUBLIC_API_MOCKING=disabled
ENV NEXT_PUBLIC_API_MOCKING=${NEXT_PUBLIC_API_MOCKING} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm --filter @bbm/web build

# ---------------------------------------------------------------------------
# runtime: only the standalone server, static assets and public/.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/cse416-fa26-sixseven/bug-bounty-marketplace" \
      org.opencontainers.image.title="bbm-web" \
      org.opencontainers.image.description="Bug Bounty Marketplace web frontend (Next.js standalone server)"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Owned by `node` so Next can write its runtime cache under apps/web/.next.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Next's standalone server exits on SIGTERM. Node is PID 1 here, so enable
# `init: true` in compose if you want zombie reaping.
STOPSIGNAL SIGTERM
CMD ["node", "apps/web/server.js"]
