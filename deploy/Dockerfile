# syntax=docker/dockerfile:1
#
# One image for the whole CrossEngin workspace. Compose runs it four ways with different commands:
# the migrate job (crossengin apply), document-indexes, the API (operate-server) and the web UI
# (next start). Build context is the repo ROOT.
#
# Two stages. `build` holds the toolchain: every devDependency, TypeScript, pnpm and the sources.
# `runtime` holds what the four commands execute and nothing else, runs as the image's unprivileged
# `node` user, and never needs pnpm or the network: every command is `node <file>`.
#
# The Node line is pinned to an exact release rather than `22` or `22-bookworm-slim`, so an image
# rebuilt next month is the image this repository tested. Node 22 and not 20: 20's maintenance ended
# in April 2026, and `eslint` 10 (the lint step) already needs 20.19 or later.
ARG NODE_IMAGE=node:22.23.5-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# One coarse layer on purpose: a code change rebuilds deterministically from the lockfile. `pnpm -r
# build` builds operate-web too (its `build` script is `next build`).
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -r build

# Reinstall node_modules from scratch with only what the three shipped apps need at run time.
#
# Both halves are load-bearing and each was measured failing alone. `pnpm install --prod` over the
# existing tree unlinks the devDependencies and leaves them in the virtual store, so vitest,
# TypeScript and eslint were still in the image; and a fresh `--prod` install of the whole workspace
# still installs them, because @crossengin/testing declares vitest and @crossengin/config declares
# eslint as their own runtime dependencies. `--filter-prod` follows only `dependencies` from the
# three apps, so neither of those two packages is reached. Measured: 253 entries in the virtual store
# before, 43 after, and none of vitest, vite, tinypool, TypeScript or eslint among them.
#
# Then what nothing at run time reads. The sources: every runtime path is a `dist/` file, `.next/`, or
# a file an operator passes by flag. Next's SWC compiler (two 137 MB binaries, glibc and musl) and
# sharp's musl build: `next start` compiles nothing, and the image is glibc. Measured by serving
# /login, /, an authenticated page and the /api proxy with both removed: same statuses, no error
# logged, and /app goes from 543 MB to 252 MB.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && CI=true pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter-prod "@crossengin/operate-server..." \
      --filter-prod "@crossengin/architect-cli..." \
      --filter-prod "@crossengin/operate-web..." \
 && rm -rf node_modules/.pnpm/@next+swc-* node_modules/.pnpm/@img+sharp*linuxmusl* \
 && rm -rf packages/*/src apps/architect-cli/src apps/operate-server/src \
           apps/operate-web/.next/cache \
           "$PNPM_HOME" /root/.cache /root/.local/share/pnpm

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Owned by root and only readable by `node`, so a compromised process cannot rewrite the code it is
# running. The one writable path is Next's cache directory, which `next start` creates under .next.
COPY --from=build /app /app
RUN mkdir -p /app/apps/operate-web/.next/cache \
 && chown node:node /app/apps/operate-web/.next/cache

USER node

# API (8787) and web (3000), published on the compose network; Caddy fronts them.
EXPOSE 8787 3000

# Overridden per service in docker-compose.yml. The default prints the API's help.
CMD ["node", "apps/operate-server/dist/bin/operate-server.js", "--help"]
