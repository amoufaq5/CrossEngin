# syntax=docker/dockerfile:1
#
# One image for the whole CrossEngin workspace. Compose runs it three ways with
# different commands: the migrate job (crossengin apply), the API (operate-server),
# and the web UI (operate-web / next start). Build context is the repo ROOT.
FROM node:20-bookworm-slim

# pnpm via corepack (version pinned by the repo's packageManager field).
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Install + build the entire workspace (dev deps are needed for tsc / next build).
# Kept as one layer so a code change rebuilds deterministically; for faster
# incremental builds you can split the lockfile/package.json copy into its own layer.
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -r build \
 && pnpm --filter @crossengin/operate-web build

# API (8787) and web (3000) — published internally; Caddy fronts them.
EXPOSE 8787 3000

# Overridden per-service in docker-compose.yml. Default shows the API help.
CMD ["node", "apps/operate-server/dist/bin/operate-server.js", "--help"]
