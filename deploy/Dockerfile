# Single multi-purpose image for the all-in-one deploys (Docker Compose / Render /
# Railway / Fly). Builds the whole workspace once; the running command selects the
# role (API, worker, or one-shot migrate). Build context = repo root:
#
#   docker build -f deploy/Dockerfile -t crossengin .
#
# Default command runs the operate-server API; override `command:` for the worker
# or the migrate step (see deploy/docker-compose.yml).
FROM node:20-slim

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

EXPOSE 8080

CMD ["node", "apps/operate-server/dist/bin/operate-server.js", \
     "--pack", "erp-retail", "--store", "pg", "--port", "8080"]
