# syntax=docker/dockerfile:1
#
# One image for the whole CrossEngin workspace. Compose runs it three ways with
# different commands: the migrate job (crossengin apply), the API (operate-server),
# and the web UI (Next.js standalone server). Build context is the repo ROOT.
FROM node:20-bookworm-slim AS builder

# pnpm via corepack (version pinned by the repo's packageManager field).
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Build the workspace, then extract only the API's production dependency graph.
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -r build \
 && pnpm --filter @crossengin/operate-server deploy --prod /out/api

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# API runtime and its production-only workspace dependency closure.
COPY --from=builder --chown=node:node /out/api ./
# The privileged one-shot migration runs from the same production dependency closure.
COPY --from=builder --chown=node:node /app/deploy/migrate.mjs ./deploy/migrate.mjs
COPY --from=builder --chown=node:node /app/deploy/migrations ./deploy/migrations
# Next.js standalone output contains only traced server files and runtime dependencies.
COPY --from=builder --chown=node:node /app/apps/operate-web/.next/standalone /web
COPY --from=builder --chown=node:node /app/apps/operate-web/.next/static /web/apps/operate-web/.next/static

USER node

# API (8787) and web (3000) — published internally; Caddy fronts them.
EXPOSE 8787 3000

# Overridden per-service in docker-compose.yml. Default shows the API help.
CMD ["node", "dist/bin/operate-server.js", "--help"]
