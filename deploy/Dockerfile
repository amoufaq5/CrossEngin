# Single multi-purpose image for the all-in-one deploys (Docker Compose / Render /
# Railway / Fly). Builds the whole workspace once; the running command selects the
# role (API, worker, or one-shot migrate). Build context = repo root:
#
#   docker build -f deploy/Dockerfile -t crossengin .
#
# Default command runs the operate-server API; override `command:` for the worker
# or the migrate step (see deploy/docker-compose.yml).
FROM node:20-slim

# Install the exact pnpm from the repo's packageManager field via npm. This is
# more robust than `corepack prepare` on managed build platforms (corepack's
# download/signature step is a common, flaky point of failure).
RUN npm install -g pnpm@9.12.0
WORKDIR /app

# Build with more headroom — `pnpm -r build` runs tsc across the whole workspace,
# which can OOM a small build container with the default heap.
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

EXPOSE 8080

CMD ["node", "apps/operate-server/dist/bin/operate-server.js", \
     "--pack", "erp-retail", "--store", "pg", "--port", "8080"]
