# ADR-0164: `crossengin retention expiring` CLI subcommand (Phase 2 M6.7.zz.tenant.opt-out.cli)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0159 (M6.7.zz.tenant.dashboard effectiveRetention), ADR-0160 (M6.7.zz.tenant.opt-out opt_out flag), ADR-0161 (M6.7.zz.tenant.opt-out.reason opt_out_reason), ADR-0162 (M6.7.zz.tenant.opt-out.expiry opt_out_until), ADR-0163 (M6.7.zz.tenant.opt-out.alerts expiringOptOuts resolver) |

## Context

ADR-0163 / M6.7.zz.tenant.opt-out.alerts shipped the `expiringOptOuts(input)` resolver — a query surface for alert pipelines. ADR-0163 Q4 lined up the last-mile delivery:

> Q4: CLI exposure. `crossengin retention expiring --within-days 30 [--include-expired]`. Defer to the M6.7.zz.tenant.cli milestone (ADR-0159 Q5).

Without a CLI, operators are still writing custom scripts to call the resolver — defeating the purpose of building a stable substrate-side query. The `crossengin` binary is the canonical operator surface for the rest of the substrate (apply, chat, sessions, gateway); retention belongs in the same place.

M6.7.zz.tenant.opt-out.cli closes Q4 with a new `retention` top-level subcommand and its first action `expiring`. Follows the established `sessions` / `gateway routes` pattern: top-level subcommand → action verb → flags.

## Decision

Add `retention` to `SUBCOMMANDS` in `apps/architect-cli/src/cli.ts`. New module `src/retention.ts` exports `runRetention(command, ctx)` following the `runSessions` shape. First action: `expiring`.

```
crossengin retention expiring [--within-days N] [--include-expired]
                              [--format human|json]
```

### Defaults

- `--within-days`: defaults to **30** (matches the most common operator workflow — monthly review window).
- `--include-expired`: defaults to **false** (the upcoming-window query).
- `--format`: inherits the workspace-standard `human` default; `--format=json` emits structured JSON for piping into alert systems.

### Output shapes

**Human format (empty):**

```
no opt-outs expiring within 30 day(s)
```

With `--include-expired`:

```
no opt-outs expired or expiring within 30 day(s)
```

**Human format (with results):**

```
Opt-outs expiring within 30 day(s) (2 total):
  5.0d                 <tenant-uuid>  workflow_traces  legal_hold:case#42
  20.0d                <tenant-uuid>  llm_call_traces  <no reason>
```

Negative days render as `EXPIRED Nd ago`:

```
Opt-outs expired or expiring within 30 day(s) (1 total):
  EXPIRED 3.2d ago     <tenant-uuid>  workflow_traces  legal_hold:case#42
```

Null `optOutReason` renders as `<no reason>` to give operators an immediate signal: this opt-out is missing the audit context that ADR-0161 introduced.

**JSON format:**

```json
{
  "withinDays": 30,
  "includeExpired": false,
  "count": 2,
  "results": [
    { "tenantId": "...", "tableName": "workflow_traces",
      "optOutUntil": "2026-06-15T00:00:00.000Z",
      "optOutReason": "legal_hold:case#42",
      "daysUntilExpiry": 5.04 },
    ...
  ]
}
```

The JSON envelope includes the resolved `withinDays` + `includeExpired` flags so downstream consumers can confirm the query parameters without re-parsing the command line. `daysUntilExpiry` is the float from the resolver — operators round / format for display.

### Validation at the CLI boundary

`--within-days` must parse as `Number.isFinite() && >= 0`. Negative, NaN, or non-numeric input fails fast with exit code 2 and a clear error message:

```
retention expiring: invalid --within-days '-5' (must be a finite number >= 0)
```

Mirrors the resolver-side validation from ADR-0163 — caught at the CLI boundary so operators see the typo immediately, before any PG connection attempt.

### PG env resolution

`retention` requires PG env vars (`PGHOST`, `PGDATABASE`, etc.) — same pattern as `sessions` and `gateway routes`. The new `RetentionContext.retentionOverride?` field injects a mock for testing:

```ts
export interface RetentionContext extends RunContext {
  readonly retentionOverride?: PostgresTraceRetention;
}
```

Operators running the CLI in production set PG env; tests inject `retentionOverride` to avoid real DB connections.

### Action-verb pattern (vs flat subcommand)

Considered `crossengin retention-expiring` (flat) vs `crossengin retention expiring` (action-verb under top-level `retention`). The action-verb form wins because:

1. Matches the established `sessions list/show/replay` and `gateway routes list/register/...` patterns. Operators don't have to remember which subcommands are flat and which nest.
2. Reserves room for future actions: `retention effective`, `retention opt-out`, `retention opt-in`, `retention list-policies` — these all live under one verb namespace.
3. CLI help text groups related actions together.

### Why ship `expiring` only this milestone

The CLI surface is incremental. `expiring` is the first action because it directly closes ADR-0163 Q4 and unblocks the daily-alert-sweep workflow. Other actions (`effective`, `opt-out`, `opt-in`, `list-policies`) are documented as future milestones — each is a thin wrapper over an existing resolver method, mechanically derivable from this template.

## Use cases unblocked

**1. Daily cron job**

```bash
# /etc/cron.daily/retention-alerts
crossengin retention expiring --within-days 30 --format json \
  | jq '.results[]' \
  | while read row; do
      send_slack_alert "$row"
    done
```

Compliance team gets a daily digest of opt-outs expiring in the next 30 days.

**2. Pre-flight check before manual review**

```bash
$ crossengin retention expiring --within-days 7
Opt-outs expiring within 7 day(s) (3 total):
  0.5d                 <tenant>  workflow_traces  legal_hold:case#42
  3.0d                 <tenant>  llm_call_traces  21cfr11:trial-9
  6.2d                 <tenant>  workflow_traces  vip_contract:xyz
```

Operator runs ad-hoc before a weekly compliance meeting.

**3. Quarterly audit report**

```bash
crossengin retention expiring --within-days 365 --include-expired --format json \
  > q3-2026-retention-audit.json
```

Auditor gets a single JSON document with every time-bound opt-out for the year.

**4. CI / monitoring integration**

```bash
COUNT=$(crossengin retention expiring --within-days 1 --format json | jq '.count')
if [[ $COUNT -gt 0 ]]; then
  echo "⚠️ $COUNT opt-out(s) expire in 24 hours" | sendmail compliance@example.com
fi
```

Bash-pipeable JSON enables operator-defined alert tiers without modifying the CLI.

## Drawbacks

1. **No built-in scheduling.** Operators wire their own cron / Inngest / Kubernetes CronJob. Mirrors ADR-0163's "substrate stays passive" stance.
2. **No notification delivery.** Output goes to stdout; operator pipes into their notification system. Adding a `--slack-webhook` flag would couple substrates; deferred.
3. **No history / dedup.** Same row appears in 30 consecutive daily runs as it approaches expiry. Operators dedup at their notification layer (most providers support correlation keys). Substrate intentionally doesn't track "have we alerted before?" state.
4. **Wide table output on small terminals.** Tenant UUIDs are 36 characters; the human format assumes a wide terminal. JSON output is the answer for narrow terminals.
5. **No tenant filter flag.** `--tenant-id` could narrow the result; deferred — operators with that need filter via `jq` on JSON output. The resolver method doesn't take tenant-scope today either.

## Alternatives considered

1. **Flat subcommand `crossengin retention-expiring`.** Rejected — breaks the established action-verb pattern from sessions / gateway routes.
2. **Add `expiring` as an action under `sessions` or `gateway`.** Rejected — retention is its own substrate concern; the action belongs under `retention`.
3. **Default `--within-days` to 7 instead of 30.** Rejected — 30 matches the most common "monthly review" cadence; 7 is too aggressive for a default.
4. **Default `--include-expired` to true.** Rejected — operators want the upcoming-window query by default (the most common use case); already-expired rows are a separate audit query they explicitly opt into.
5. **Built-in Slack / email delivery.** Rejected — couples substrates; operators wire delivery via their existing notification system.
6. **Filter flags `--table`, `--tenant-id`, `--reason-pattern`.** Rejected this milestone — keep the surface minimal; operators filter via `jq` on JSON for now. Add if operators ask.
7. **Pagination / `--limit`.** Rejected — opt-out count is bounded in practice (rare events); add if measured.
8. **Wrap in an Inngest job definition shipped with the CLI.** Rejected — operators have different schedulers (cron, Inngest, K8s CronJob, AWS EventBridge); CLI stays scheduler-agnostic.

## Open questions

1. **Sibling `retention` actions.** `retention effective <tenant> <table>`, `retention opt-out <tenant> <table> --until <date> --reason <reason>`, `retention opt-in <tenant> <table>`, `retention list-policies [--tenant <id>]`. Each is a thin wrapper over an existing resolver method. Defer to the M6.7.zz.tenant.cli milestone (ADR-0159 Q5) once `expiring` proves the pattern in production.
2. **Tenant filter flag.** `--tenant-id <uuid>` to narrow results. Deferred — `jq` covers it on JSON output.
3. **Table filter flag.** `--table workflow_traces|llm_call_traces` to narrow results. Same as Q2.
4. **Exit code on results.** Currently exit 0 regardless of result count. A future `--exit-on-found` could exit 1 when results are present (useful for CI gates: "fail the build if any opt-out expires in <1 day"). Defer until requested.
5. **Output sorting flags.** Currently sorted by `opt_out_until ASC` (soonest first) per the resolver. A `--sort tenant|reason|until` flag would let operators reorder. Defer.
6. **CSV output format.** A `--format csv` for spreadsheet exports. Defer — JSON + `jq` covers it.
7. **Verbose flag for debugging.** Show the resolved cutoff timestamp + clock source. Defer until a real debugging need emerges.
