#!/usr/bin/env bash
# Onboard one customer: create their tenant (workspace), their first user, a temporary password, and
# the starter chart of accounts.
#
#   ./onboard-tenant.sh <slug> "<Company name>" <email> "<Display name>" [role]
#   NO_STARTER_CHART=1 ./onboard-tenant.sh ...     # a company bringing its own chart of accounts
#
# Run it on the VM from crossengin/deploy, so .env is beside it. It talks to the API on the loopback
# port the compose file publishes (127.0.0.1:8787) with the bootstrap key in .env, which is the
# credential --platform-user-routes and --credential-admin-role are granted to. Override the address
# with API=https://api.yourdomain.com if you run it from somewhere else.
#
# CrossEngin has no instant self-registration: a customer either asks at /request-access and an
# operator approves it in Platform -> Access requests (which creates the starter chart by default), or
# asks some other way and this one command gives them a workspace and a login.
#
# The starter chart is 21 ledger accounts plus the finance account settings pointed at them
# (ADR-0465); without it the workspace's first invoice is refused until somebody builds a chart. It is
# the last step, so a failure there leaves a working login: the script warns, says how to finish, and
# still exits 0.
#
# The password it prints is TEMPORARY in intent only: the platform does not force a change at first
# sign-in, so tell the customer to change it at /account, and send it over a channel you trust.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <slug> \"<Company name>\" <email> \"<Display name>\" [role]" >&2
  echo "  slug: lowercase letters, digits and '-', 2-49 characters, starting with a letter" >&2
  echo "  role: one of the pack's roles; default erp_admin (the customer's own administrator)" >&2
  echo "  NO_STARTER_CHART=1 skips the starter chart of accounts" >&2
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
# The chart report in words, then a last line `complete` or `incomplete` for the script to branch on.
# The wording follows the console's (apps/operate-web/lib/platform.ts, describeStarterChart), so the
# script and the approval banner say the same thing about one report.
CHART_PY=$(cat <<'PY'
import json, sys
r = json.load(sys.stdin)["starterChart"]
out = []
refused = r["refused"]
forbidden = bool(refused) and all(x["status"] == 403 and x["error"] == "forbidden" for x in refused)
cause = ("the role this deployment writes the chart as (--job-actor-role) may not create "
         "LedgerAccount; an operator fixes that flag")
refused_line = "refused: " + ", ".join("%s (%s %s)" % (x["code"], x["status"], x["error"]) for x in refused)
in_place = len(r["created"]) + len(r["existing"])
reasons = {
    "type_mismatch": "the existing account %s is of a different type than the chart's",
    "archived": "the existing account %s is archived",
    "not_postable": "the existing account %s is not postable",
    "duplicated": "more than one account carries code %s",
    "absent": "the account %s was removed while the chart was being created",
}
o = r["outcome"]
if o == "complete":
    out.append("%d ledger accounts in place, finance settings set" % in_place)
elif o == "partial":
    if refused:
        out.append("only partly in place (%d accounts)" % in_place)
    elif not r.get("settingsSkipped") and r.get("settingsDangling") is None:
        out.append("%d ledger accounts in place; whether every finance setting names an existing "
                   "account could not be checked" % in_place)
    else:
        out.append("%d ledger accounts in place; some finance settings need a choice" % in_place)
    if refused:
        out.append(refused_line)
        if forbidden:
            out.append(cause)
    for s in r.get("settingsSkipped", []):
        out.append("%s left unset: %s, so the setting was left for the admin to choose"
                   % (s["key"], reasons.get(s["reason"], s["reason"] + " (account %s)") % s["code"]))
    dangling = r.get("settingsDangling")
    if dangling is None:
        out.append("whether every finance setting names an existing account could not be checked")
    else:
        for d in dangling:
            out.append("%s names account %s, which does not exist" % (d["key"], d["code"]))
elif o == "refused":
    out.append("no account was created: every account in the chart was refused")
    out.append(cause + "; until then a second run gives the same answer" if forbidden else refused_line)
elif o == "not_served":
    out.append("nothing was created: this deployment does not serve ledger accounts")
elif o == "duplicates_present":
    head = ("%d accounts were created, then no finance setting was written" % len(r["created"])
            if r["created"] else "nothing was written")
    out.append(head + ": more than 1,000 accounts carry the chart's codes -- duplicates; remove them first")
elif o == "settings_unwritten":
    if r.get("settingsError") == "SettingsRowUnreadable":
        out.append("%d accounts are in place; this workspace's stored settings are unreadable -- its "
                   "admin replaces them in Settings, signed in to the workspace, then the chart is "
                   "run again" % in_place)
    else:
        out.append("%d accounts are in place; the finance settings could not be written (%s)"
                   % (in_place, r.get("settingsError", "unknown")))
    if refused:
        out.append(refused_line)
else:
    out.append("outcome %s, which this script does not know" % o)
out.append("%d created, %d already present, %d refused, %d finance settings filled"
           % (len(r["created"]), len(r["existing"]), len(refused), len(r["settingsFilled"])))
print("\n".join(out))
print("complete" if o == "complete" else "incomplete")
PY
)
chart_summary() { python3 -c "$CHART_PY"; }

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

# Last, so a failure is the last thing printed and leaves the login above intact. The server leaves
# existing accounts and chosen settings alone, so once the cause a report names is fixed, running the
# chart again finishes it; running it again before then gives the same answer.
chart_hint() {
  echo "Once the cause above is fixed, finish it in the console (Platform -> Tenants -> $SLUG ->" >&2
  echo "Create starter chart of accounts), or re-run this one request from crossengin/deploy (the key" >&2
  echo "stays off the command line):" >&2
  cat >&2 <<HINT
  curl -sS -X POST "$API/v1/platform/tenants/$TENANT_ID/starter-chart" \\
    -H @<(printf 'x-api-key: %s\\ncontent-type: application/json\\n' "\$(grep '^OPERATE_ADMIN_API_KEY=' .env | cut -d= -f2- | cut -d: -f1)") \\
    --data-binary '{}'
HINT
}
echo
if [ "${NO_STARTER_CHART:-}" = "1" ]; then
  echo "chart    skipped (NO_STARTER_CHART=1): the workspace starts with no ledger accounts"
elif CHART_JSON=$(post "/v1/platform/tenants/$TENANT_ID/starter-chart" '{}'); then
  CHART=$(printf '%s' "$CHART_JSON" | chart_summary)
  printf '%s\n' "$CHART" | sed '$d' | sed '1s/^/chart    /;1!s/^/         /'
  if [ "$(printf '%s\n' "$CHART" | tail -n 1)" != "complete" ]; then
    echo "warning  the starter chart is not complete; the workspace and login above work regardless." >&2
    chart_hint
  fi
else
  # The route's own refusal (a 403 here is this key lacking the platform-admin grant, not the role the
  # accounts are written as) was printed above by post().
  echo "warning  the starter chart was not created; the workspace and login above work regardless." >&2
  chart_hint
fi
