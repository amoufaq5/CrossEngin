#!/usr/bin/env bash
#
# Provisions a throwaway Postgres database for the gated real-Postgres
# integration tests (the suites that run under CROSSENGIN_PG_TEST=1 in
# apps/workflow-worker + apps/operate-server).
#
# It (re)creates the target database, installs pgcrypto + a uuid_generate_v7()
# shim (production uses the pg_uuidv7 extension; the shim over gen_random_uuid()
# is fine for tests), and applies the full meta-schema bootstrap DDL.
#
# Connection comes from the standard PG* env vars; the admin user (PGUSER) must
# be a superuser able to CREATE DATABASE + CREATE EXTENSION. Requires the kernel
# to be built first (`pnpm -r build`) and `psql` on PATH.
#
# Usage (CI or local):
#   pnpm -r build
#   PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGDATABASE=crossengin_test \
#     bash scripts/setup-integration-db.sh
#   CROSSENGIN_PG_TEST=1 PGHOST=… PGUSER=… PGPASSWORD=… PGDATABASE=crossengin_test \
#     PGSSLMODE=disable pnpm --filter @crossengin/workflow-worker-app test
set -euo pipefail

PGDATABASE="${PGDATABASE:-crossengin_test}"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> (re)creating database ${PGDATABASE} on ${PGHOST}:${PGPORT} as ${PGUSER}"
psql -v ON_ERROR_STOP=1 -d postgres \
  -c "DROP DATABASE IF EXISTS ${PGDATABASE}" \
  -c "CREATE DATABASE ${PGDATABASE}"

echo "==> installing pgcrypto + uuid_generate_v7() shim"
psql -v ON_ERROR_STOP=1 -d "${PGDATABASE}" \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" \
  -c "CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid LANGUAGE sql VOLATILE AS 'SELECT gen_random_uuid()'"

echo "==> applying meta-schema bootstrap (all META_TABLES)"
node "${HERE}/emit-bootstrap.mjs" | psql -v ON_ERROR_STOP=1 -q -d "${PGDATABASE}"

TABLE_COUNT="$(psql -tA -d "${PGDATABASE}" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'meta'")"
echo "==> done — ${TABLE_COUNT} meta tables in ${PGDATABASE}"
