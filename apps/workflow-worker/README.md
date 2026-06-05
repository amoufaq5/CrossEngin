# `@crossengin/workflow-worker-app` — the `workflow-worker` binary

The distributed background-progression worker for CrossEngin workflows. It
advances time-based and async workflow work that the in-process runtime parks:
firing due timers, retrying failed activities, timing out instances + activities,
running async-scheduled activities, reaping expired leases, and self-healing
projection drift — all over the Postgres event log, safe to run as **N parallel
processes**.

It is one of three apps under `apps/` (`architect-cli` authors manifests,
`operate-server` serves them, `workflow-worker` advances their workflows).

## How it works

Workflow instances are event-sourced: the engine appends events to
`meta.workflow_events` and projects them into `workflow_instances` /
`_activities` / `_signals` / `_timers`. Some progression is **deferred** — a
timer that fires later, an activity that failed and must retry, an instance past
its deadline, an async activity awaiting execution. The worker drains that
deferred work.

### Coordination — two strategies

- **Advisory-lock bulk tick** (`--mode tick`). One `WorkflowWorker` runs the
  engine's bulk `tickTimers` inside `pg_advisory_lock`, so N processes serialize
  on one lock — only one ticks at a time, and the engine's `status='scheduled'`
  guard prevents double-fires. Postgres releases the lock on session death
  (failover). Simple, single-threaded throughput.
- **Per-unit `FOR UPDATE SKIP LOCKED` claim** (the parallel modes). Each worker
  atomically claims a **disjoint** batch of due rows (stamping a
  `claimed_by`/`lease_expires_at` lease), processes each via an idempotent,
  settled-guarded engine primitive, and releases the lease. N workers drain in
  parallel with no global lock — `SKIP LOCKED` partitions the rows, and the
  primitives' idempotency covers any residual race.

The engine's five per-unit primitives — `fireTimer`, `retryActivity`,
`timeoutInstance`, `executeActivity`, `timeoutActivity` — are all idempotent and
race-safe, so a reclaim of a crashed worker's lease can never double-process.

### The lease lifecycle

claim (a `SKIP LOCKED` claim store stamps the lease) → process (an idempotent
primitive) → lazy reclaim (the next claim's `lease_expires_at < now` predicate)
→ **proactive reap** (`--mode reap` clears expired leases) → observe (the
heartbeat counters) → **detect** dead workers (`--monitor`).

## Modes (`--mode`)

| mode | what it runs | over |
|---|---|---|
| `tick` | advisory-lock bulk timer tick | `pg_advisory_lock` + `engine.tickTimers` |
| `claim` | parallel per-unit timer claim | `PostgresTimerClaimStore` + `fireTimer` |
| `retry` | activity retry executor | `PostgresActivityRetryClaimStore` + `retryActivity` |
| `timeout` | instance **and** activity deadline sweep | instance + activity timeout claim stores |
| `execute` | async activity queue | `PostgresActivityExecuteClaimStore` + `executeActivity` |
| `reap` | clear expired leases (maintenance) | `PostgresLeaseReaper` |
| `resync` | projection drift sweep (opt-in, heavy) | `WorkflowReplayer.bulkResync` |
| `all` | **default** — `claim + retry + timeout + execute + reap` | the parallel production set |

`resync` is **not** in `all` (a full re-projection rewrites correct rows too);
enable it on its own slow cadence.

## Flags

```
--mode <m>                 see the table above (default all)
--worker-id <id>           lease owner id (default a random id)
--schema <name>            Postgres schema for the workflow tables (default meta)
--tick-interval-ms <n>     bulk-tick poll interval (default 5000)
--claim-interval-ms <n>    timer-claim poll interval (default 1000)
--retry-interval-ms <n>    activity-retry poll interval (default 5000)
--timeout-interval-ms <n>  instance + activity timeout poll interval (default 10000)
--execute-interval-ms <n>  async-activity execute poll interval (default 2000)
--reap-interval-ms <n>     expired-lease reaper poll interval (default 30000)
--resync-interval-ms <n>   projection drift-sweep interval (default 300000)
--resync-max <n>           max instances re-projected per drift sweep (default 500)
--batch-size <n>           claim batch size (default 50)
--lease-ms <n>             claim lease duration (default 30000)
--definitions <file>       JSON array of WorkflowDefinitions to run (default none)

# observability
--heartbeat-interval-ms <n>   heartbeat flush interval (default 15000)
--no-heartbeat                disable the meta.worker_heartbeats heartbeat
--monitor                     watch heartbeats + declare an incident for stale workers
--monitor-interval-ms <n>     stale-worker monitor poll interval (default 30000)
--stale-after-ms <n>          heartbeat age that marks a worker stale (default 60000)
--monitor-declared-by <uuid>  actor id for auto-declared incidents
--persist-incidents           write stale-worker incidents to meta.incidents (requires --monitor)
--page-webhook-url <url>      POST resolved page directives to this webhook (else logged; requires --monitor)
```

## Observability

- **Heartbeats** (on by default). Each worker upserts a `meta.worker_heartbeats`
  row (status, cumulative `poll_count` / `claimed_total` / `processed_total` /
  `error_count`, `last_heartbeat_at`, hostname). A dead worker is one query:

  ```sql
  SELECT * FROM meta.worker_heartbeats
   WHERE status = 'running' AND last_heartbeat_at < now() - interval '1 minute';
  ```

- **Stale-worker monitor** (`--monitor`). Polls the heartbeat table, summarizes
  health, and declares an `IncidentRecord` for stale (presumed-dead) workers —
  severity scaled (sev3 at 1–2 stale, sev2 at 3+). It holds one incident per
  stale period (no re-declare while ongoing), **escalates** its severity if more
  workers go stale (and **re-pages** on-call at the higher urgency through the
  `PageDeliverer` transport seam — `LoggingPageDeliverer` by default, or
  `--page-webhook-url <url>` to **POST** each resolved page directive as JSON to
  a PagerDuty/Slack/Opsgenie/any HTTP sink), and **resolves** it
  when workers recover — each transition appending a timeline entry. With
  `--persist-incidents` it writes/transitions the incident in `meta.incidents`;
  otherwise it logs. The flow: **write → detect → plan → page → run → persist →
  escalate → re-page → resolve**.

## `incidents` subcommand (one-shot query)

Read the `meta.incidents` audit table from the shell. `workflow-worker
incidents …` runs a single query and exits (it does not start the worker loop):

```bash
# incidents that are still open (status not resolved/closed/cancelled)
workflow-worker incidents open [--limit N] [--format human|json]

# every incident declared within a window
workflow-worker incidents period --from <iso> --to <iso> [--limit N] [--format json]

# timeline drift sweep over a window — exits 1 if any incident's timeline
# drifted from declared -> (escalated)* -> resolved (gate CI on it)
workflow-worker incidents verify --from <iso> --to <iso> [--format json]

# operational KPIs over a window: MTTP / MTTA / MTTM / MTTR (mean/p50/p95/max),
# open/resolved counts, per-severity gauges, escalation totals
workflow-worker incidents metrics --from <iso> --to <iso> [--limit N] [--format json]

# record the ack / mitigate milestones (drives MTTA / MTTM). Idempotent:
# a no-op (absent / already past that state) still exits 0.
workflow-worker incidents ack      <incident-id> [--actor <uuid>]
workflow-worker incidents mitigate <incident-id> [--actor <uuid>]
```

`verify` reports per-incident issues (`empty_timeline`,
`first_entry_not_declared`, `non_monotonic_timeline`, the resolved
status/stamp/entry disagreements, …) and a clean/with-issues summary; a non-zero
exit means drift was found. All three honor `--schema` (default `meta`).

## Postgres

Connects via the standard `PG*` env vars (`PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE`, `PGSSLMODE`, `PGAPPNAME`). The connecting role should
see **all tenants'** workflow rows (`BYPASSRLS` / table owner), since one worker
drains every tenant. Apply the meta-schema first with `crossengin-pg apply` (or
`crossengin apply`).

## Deployment recipe

```bash
# apply the schema (once)
crossengin-pg apply

# run the parallel production set, N replicas
PGHOST=… PGUSER=worker PGPASSWORD=… PGDATABASE=crossengin \
  workflow-worker --mode all --definitions /etc/crossengin/defs.json

# a dedicated drift-sweep + monitor process (one replica)
workflow-worker --mode resync --resync-interval-ms 600000 &
workflow-worker --mode all --monitor --persist-incidents
```

Run as many `--mode all` replicas as throughput needs; `SKIP LOCKED` keeps them
disjoint. Run **one** `--monitor` process (multiple would declare duplicate
incidents). The poll timers are `unref`'d; the bin holds the loop open and shuts
down cleanly on `SIGINT`/`SIGTERM`.

## Tests

Unit/wiring tests run offline (no DB). A gated real-Postgres integration suite
runs the full claim → process loops, lease lifecycle, heartbeat, stale detection,
and incident persistence:

```bash
CROSSENGIN_PG_TEST=1 PGHOST=localhost PGUSER=… PGPASSWORD=… PGDATABASE=… \
  PGSSLMODE=disable pnpm --filter @crossengin/workflow-worker-app test
```
