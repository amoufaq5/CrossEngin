#!/bin/bash
# Builds and boots the shipped compose stack from a clean volume and checks the things only a real
# boot can: the migrate, app-role and document-indexes one-shots succeed against a real Postgres, the
# API reports ready as the confined app role, the web UI serves, both run as a non-root user, and the
# backup service writes a dump that it restored before keeping.
#
# CI runs it as one step (`.github/workflows/ci.yml`, job `deploy-smoke`); locally it is
#   bash deploy/ci-smoke.sh
# from the repo root with Docker running. SMOKE_EXTRA_COMPOSE names one more compose file to layer on
# top, for a host whose builds need different base images or network settings. Every resource it
# creates is under the project name `crossengin-smoke` and is removed on exit, volumes included.
set -euo pipefail

cd "$(dirname "$0")"
project=crossengin-smoke
work="$(mktemp -d)"
env_file="$work/.env"
files=(-f docker-compose.yml)
if [ -n "${SMOKE_EXTRA_COMPOSE:-}" ]; then files+=(-f "$SMOKE_EXTRA_COMPOSE"); fi
compose() { docker compose -p "$project" --env-file "$env_file" "${files[@]}" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose ps -a || true
    compose logs --no-color --tail 80 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
b64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }

# Every secret the example leaves as a placeholder, generated fresh: the boot refuses a placeholder
# by name (SECRET_PLACEHOLDER_PREFIX), so leaving one would test the refusal rather than the stack.
# The two refuseWeakSecret-checked values are base64 and not hex, as .env.example generates them: a
# 48-character hex string draws on 16 symbols and the floor is 16 distinct byte values, so hex fails
# that check on 55% of runs (computed by inclusion-exclusion; it failed one run of two here).
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
  -e "s|^POSTGRES_APP_PASSWORD=.*|POSTGRES_APP_PASSWORD=$(hex 24)|" \
  -e "s|^OPERATE_ADMIN_API_KEY=REPLACE_WITH_STRONG_TOKEN|OPERATE_ADMIN_API_KEY=$(hex 24)|" \
  -e "s|^CREDENTIAL_PEPPER=.*|CREDENTIAL_PEPPER=$(b64 32)|" \
  -e "s|^OPERATE_TOKEN_SIGNING_KEY=.*|OPERATE_TOKEN_SIGNING_KEY=$(b64 32)|" \
  -e "s|^CURSOR_ENCRYPTION_SECRET=.*|CURSOR_ENCRYPTION_SECRET=$(b64 32)|" \
  -e "s|^AUDIT_CHAIN_SIGNING_KEY=.*|AUDIT_CHAIN_SIGNING_KEY=$(b64 32)|" \
  -e "s|^DOMAIN=.*|DOMAIN=localhost|" \
  .env.example > "$env_file"
# Only uncommented assignments: the example also carries commented-out optional secrets.
if grep -q '^[A-Z_]*=REPLACE_WITH' "$env_file"; then
  echo "ci-smoke: a placeholder survived in the generated .env: $(grep -o '^[A-Z_]*=REPLACE_WITH' "$env_file")" >&2
  exit 1
fi

# Caddy is not started: it needs a public domain for its certificate, and every check below reaches
# the services directly. `--wait` returns only when api, web and backup are healthy, and each
# healthcheck is the real one the stack ships with.
compose build
compose up -d --wait --wait-timeout 900 api web backup

check() { if "$@"; then echo "ok: $*"; else echo "FAILED: $*" >&2; exit 1; fi; }

# The published loopback port, so this is the request an operator's bootstrap curl makes.
check curl --noproxy '*' -fsS -o /dev/null http://127.0.0.1:8787/readyz
check compose exec -T web node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"
for svc in api web; do
  uid="$(compose exec -T "$svc" id -u | tr -d '\r')"
  check test "$uid" = 1000
done
# The code the API runs is root's and read-only to it; only Next's cache directory is writable.
check compose exec -T api sh -c 'if touch /app/package.json 2>/dev/null; then exit 1; fi'
check compose exec -T web sh -c 'touch /app/apps/operate-web/.next/cache/.w && rm /app/apps/operate-web/.next/cache/.w'
dumps="$(compose exec -T backup sh -c 'ls /backups/crossengin-*.dump 2>/dev/null | wc -l' | tr -d '\r ')"
check test "$dumps" -ge 1
restored() { compose logs --no-color backup | grep -q 'restore check passed'; }
check restored
echo "ci-smoke: passed"
