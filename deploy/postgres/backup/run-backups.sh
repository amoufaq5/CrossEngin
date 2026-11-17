#!/bin/bash
# The compose stack's scheduled backup: one `pg_dump`, restored into a scratch database before it
# is kept, then a retention sweep that can only run after a verified dump exists.
#
# Three things a cron line beside the stack (deploy/ORACLE.md) cannot do, which is why this is a
# service and not only a runbook: it runs wherever the stack runs, with no host crontab; it RESTORES
# every dump, so a backup is a tested restore and not a hope; and its health is visible to
# `docker compose ps`, so a backup that has stopped working is a state the stack reports rather than
# a log nobody reads.
#
# What it does not do: copy anything off the host. The dumps sit on the same disk as the database
# they back up, so a lost disk loses both. BACKUP_DIR can name a host path that is itself a mount of
# remote storage; nothing here does that for you (deploy/README.md, "Backups").
set -euo pipefail

dir=/backups
interval="${BACKUP_INTERVAL_SECONDS:-86400}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
retry="${BACKUP_RETRY_SECONDS:-600}"
restore_check="${BACKUP_RESTORE_CHECK:-1}"
scratch="${PGDATABASE}_restore_check"

case "$interval$retention_days$retry" in
  *[!0-9]*) echo "[backup] BACKUP_INTERVAL_SECONDS, BACKUP_RETENTION_DAYS and BACKUP_RETRY_SECONDS must be whole numbers" >&2; exit 2 ;;
esac
if [ "$interval" -lt 60 ] || [ "$retry" -lt 60 ]; then
  echo "[backup] the interval and the retry must each be at least 60 seconds" >&2
  exit 2
fi
if [ ! -w "$dir" ]; then
  echo "[backup] $dir is not writable by uid $(id -u); a bind-mounted BACKUP_DIR must be owned by uid 999 (postgres)" >&2
  exit 2
fi

drop_scratch() {
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS \"$scratch\"" >/dev/null
}

# One run. Every failure returns non-zero before the file is renamed, so the directory only ever
# holds dumps that restored, and the retention sweep below is unreachable on a failed run — the
# order ORACLE.md's dump.sh measured the hard way.
#
# Every step is checked by hand, because `set -e` does not reach here: bash ignores it inside a
# function called as an `if` condition, which is how the loop below calls this one. Measured with
# a psql that fails both count queries: the unchecked form compared two empty strings, printed
# "restore check passed:  tables" and kept the dump.
backup_once() {
  local stamp out tmp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$dir/crossengin-$stamp.dump"
  tmp="$dir/.partial-$stamp.dump"
  # `-Fc -f` and no pipe: pg_dump's own exit status is the status, and the custom format is what
  # pg_restore can verify and restore selectively. A partial file is removed on any failure.
  if ! pg_dump -Fc --no-password -f "$tmp" "$PGDATABASE"; then
    rm -f "$tmp"
    return 1
  fi
  if ! pg_restore --list "$tmp" >/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  if [ "$restore_check" = "1" ]; then
    # A real restore into a scratch database in the same cluster, as the owner. `--exit-on-error`
    # so a single failed statement fails the check rather than producing a partial database that
    # reads as restored. The table count is compared against the source, because a restore that
    # created nothing also exits 0.
    if ! drop_scratch || ! createdb "$scratch" \
      || ! pg_restore --exit-on-error --no-owner -d "$scratch" "$tmp"; then
      drop_scratch || true
      rm -f "$tmp"
      return 1
    fi
    local q="SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"
    local want="" got=""
    want="$(psql -X -tA -v ON_ERROR_STOP=1 -d "$PGDATABASE" -c "$q")" || want=""
    got="$(psql -X -tA -v ON_ERROR_STOP=1 -d "$scratch" -c "$q")" || got=""
    drop_scratch || true
    # Both must be counts: a query that failed yields "", and two empty strings are equal.
    case "$want$got" in *[!0-9]*) want="" ;; esac
    if [ -z "$want" ] || [ -z "$got" ] || [ "$want" != "$got" ] || [ "$got" = "0" ]; then
      echo "[backup] restore check failed: source has '$want' tables, the restored copy has '$got'" >&2
      rm -f "$tmp"
      return 1
    fi
    echo "[backup] restore check passed: $got tables"
  fi
  if ! mv -- "$tmp" "$out"; then
    rm -f "$tmp"
    return 1
  fi
  date +%s > "$dir/.last-verified" || return 1
  rm -f "$dir/.last-failed"
  echo "[backup] wrote $out ($(du -h "$out" | cut -f1))"
  # Only after a verified dump exists, and never the one just written: `-mtime +N` is strictly older
  # than N whole days. A leftover partial from a killed run is swept too.
  find "$dir" -maxdepth 1 -name 'crossengin-*.dump' -mtime +"$retention_days" -print -delete
  find "$dir" -maxdepth 1 -name '.partial-*.dump' -mmin +60 -delete
}

echo "[backup] every ${interval}s into $dir, keeping ${retention_days} days, restore check: $restore_check"
while true; do
  if backup_once; then
    sleep "$interval"
  else
    # Read by the health check, so a failed run is unhealthy at once and not only once the last
    # good dump has aged past two intervals (up to two days at the default).
    date +%s > "$dir/.last-failed" || true
    echo "[backup] FAILED; the previous dumps are untouched, retrying in ${retry}s" >&2
    sleep "$retry"
  fi
done
