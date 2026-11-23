#!/usr/bin/env bash
# Onboard one customer: create their tenant (workspace), their first user, and a temporary password.
#
#   ./onboard-tenant.sh <slug> "<Company name>" <email> "<Display name>" [role]
#
# Run it on the VM from crossengin/deploy, so .env is beside it. It talks to the API on the loopback
# port the compose file publishes (127.0.0.1:8787) with the bootstrap key in .env, which is the
# credential --platform-user-routes and --credential-admin-role are granted to. Override the address
# with API=https://api.yourdomain.com if you run it from somewhere else.
#
# CrossEngin has no self-registration: there is no public signup route, no email verification and
# no mail channel to send a link with. This script is what replaces it — a customer asks (by email,
# or through any form you like), and one command gives them a workspace and a login.
#
# The password it prints is TEMPORARY in intent only: the platform does not force a change at first
# sign-in, so tell the customer to change it at /account, and send it over a channel you trust.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <slug> \"<Company name>\" <email> \"<Display name>\" [role]" >&2
  echo "  slug: lowercase letters, digits and '-', 2-49 characters, starting with a letter" >&2
  echo "  role: one of the pack's roles; default erp_admin (the customer's own administrator)" >&2
  exit 2
fi
SLUG=$1
NAME=$2
EMAIL=$3
DISPLAY=$4
ROLE=${5:-erp_admin}
TIER=${TIER:-small}       # small | enterprise | regulated | on-prem
REGION=${REGION:-eu}      # eu | us | me | ap | sa
API=${API:-http://127.0.0.1:8787}

case "$SLUG" in
  [a-z]*) ;;
  *) echo "slug must start with a lowercase letter" >&2; exit 2 ;;
esac
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z][a-z0-9-]{1,48}$'; then
  echo "slug must be 2-49 characters of lowercase letters, digits and '-'" >&2
  exit 2
fi

if [ -z "${ADMIN:-}" ]; then
  [ -f .env ] || { echo "run this from crossengin/deploy (no .env here), or set ADMIN" >&2; exit 2; }
  ADMIN=$(grep '^OPERATE_ADMIN_API_KEY=' .env | cut -d= -f2- | cut -d: -f1)
fi
[ -n "$ADMIN" ] || { echo "OPERATE_ADMIN_API_KEY is not set in .env" >&2; exit 2; }

# Every JSON body is built by python3 (present on Ubuntu) rather than by string pasting, so a name
# with a quote in it cannot break the request — or change what it asks for.
tenant_id() { python3 -c 'import json,sys; print(json.load(sys.stdin)["tenant"]["id"])'; }
role_warnings() { python3 -c 'import json,sys; print("; ".join(w["detail"] for w in json.load(sys.stdin).get("roleWarnings", [])))'; }

# Neither secret this script handles may appear on a command line, because any account on the VM can
# read every process's argv with `ps`. The admin key goes to curl as a header FILE (`-H @file`,
# created mode 600 and deleted on exit); every body, which for the last call carries the new
# password, goes on curl's stdin; and the password reaches python3 through its environment, which
# /proc shows only to the same user.
umask 077
HDR=$(mktemp)
trap 'rm -f "$HDR"' EXIT
printf 'x-api-key: %s\ncontent-type: application/json\n' "$ADMIN" > "$HDR"

post() {
  local path=$1 body=$2 out status
  out=$(mktemp)
  status=$(printf '%s' "$body" | curl -sS -o "$out" -w '%{http_code}' -X POST "$API$path" \
    -H @"$HDR" --data-binary @-)
  if [ "${status:0:1}" != "2" ]; then
    echo "POST $path answered $status:" >&2
    cat "$out" >&2; echo >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

# A failure after the tenant exists leaves it behind (there is no tenant delete on this stack), and a
# re-run refuses the taken slug. Say what was created and how to finish by hand instead of leaving
# an operator to work it out.
TENANT_ID=""
USER_ID=""
resume_hint() {
  [ -n "$TENANT_ID" ] || return 0
  echo >&2
  echo "The tenant '$SLUG' was created ($TENANT_ID) before the failure; this script cannot be re-run" >&2
  echo "for it. Finish in the console: Platform -> Tenants -> $SLUG -> Members (grant a membership)," >&2
  echo "then Platform -> Users -> Set password. Or archive the tenant if it was a mistake." >&2
  if [ -n "$USER_ID" ]; then echo "The user was also created: $USER_ID ($EMAIL)." >&2; fi
}

TENANT_BODY=$(python3 -c 'import json,sys; print(json.dumps({"slug":sys.argv[1],"name":sys.argv[2],"tier":sys.argv[3],"region":sys.argv[4]}))' \
  "$SLUG" "$NAME" "$TIER" "$REGION")
TENANT_JSON=$(post /v1/platform/tenants "$TENANT_BODY")
TENANT_ID=$(printf '%s' "$TENANT_JSON" | tenant_id)
echo "tenant   $SLUG  ($TENANT_ID)"

NEW_USER_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')
USER_BODY=$(python3 -c 'import json,sys; print(json.dumps({"user":{"id":sys.argv[1],"email":sys.argv[2],"displayName":sys.argv[3]},"membership":{"tenantId":sys.argv[4],"primaryRole":sys.argv[5],"secondaryRoles":[],"status":"active"}}))' \
  "$NEW_USER_ID" "$EMAIL" "$DISPLAY" "$TENANT_ID" "$ROLE")
USER_JSON=$(post /v1/platform/users "$USER_BODY") || { resume_hint; exit 1; }
USER_ID=$NEW_USER_ID
WARN=$(printf '%s' "$USER_JSON" | role_warnings)
echo "user     $EMAIL  ($USER_ID, role $ROLE)"
if [ -n "$WARN" ]; then
  # The server warns rather than refuses (a tenant's own activated manifest may declare roles this
  # deployment's pack does not), so stop here instead: a password for a login that authorizes
  # nothing is a support call, not an onboarding.
  echo "warning  $WARN" >&2
  resume_hint
  echo "stopped before setting a password. Fix the role in Platform -> Tenants -> $SLUG -> Members," >&2
  echo "then set the password in Platform -> Users." >&2
  exit 1
fi

# 20 base64url characters is ~120 bits; the server's floor is 12 characters.
PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(15))')
CRED_BODY=$(PW="$PASSWORD" UID_="$USER_ID" python3 -c 'import json,os; print(json.dumps({"password":os.environ["PW"],"confirmUserId":os.environ["UID_"]}))')
post "/v1/platform/users/$USER_ID/credential" "$CRED_BODY" >/dev/null || { resume_hint; exit 1; }

[ -n "${DOMAIN:-}" ] || DOMAIN=$( [ -f .env ] && grep '^DOMAIN=' .env | cut -d= -f2- || true)

cat <<EOF

Send this to the customer (over a channel you trust), and ask them to change the password at
/account after they sign in:

  Sign in at:  https://${DOMAIN:-<your domain>}/login
  Workspace:   $SLUG
  Email:       $EMAIL
  Password:    $PASSWORD
EOF
