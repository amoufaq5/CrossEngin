# Always-on host for the CrossEngin background workers (timers, retries, timeouts,
# the async activity queue, lease reaping, stale-worker → incident monitoring).
#
# Serverless platforms (Vercel) can't host this — it's a long-running poll loop.
# Deploy this image to Fly.io / Railway / Render / a small VM. Point it at the
# SAME Postgres (Supabase) the API uses, with a role that can BYPASSRLS (one
# worker drains every tenant).
#
# Build context = the repo root:  docker build -f deploy/worker/Dockerfile -t crossengin-worker .
#
# Required env: PGHOST PGUSER PGPASSWORD PGDATABASE PGSSLMODE (and PGPORT if not 5432).
# Provide your workflow definitions at /app/workflows.json (mount or bake it in);
# an empty `[]` is valid if you have no manifest workflows yet.
FROM node:20-slim

RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build
RUN test -f workflows.json || echo '[]' > workflows.json

# --mode all = claim + retry + timeout + execute + reap; --monitor + --persist-incidents
# write a stale-worker incident to meta.incidents and resolve it on recovery.
CMD ["node", "apps/workflow-worker/dist/bin/workflow-worker.js", \
     "--mode", "all", \
     "--monitor", "--persist-incidents", \
     "--definitions", "/app/workflows.json"]
