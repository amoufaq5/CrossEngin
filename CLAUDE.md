# CLAUDE.md

Project state snapshot for AI assistants resuming work on this
codebase. Concise on purpose. Read top to bottom once, then keep
nearby.

## What this is

CrossEngin: AI-native multi-tenant platform. Three layers — a
kernel (multi-tenancy + meta-schema + DDL emit), declarative
manifests, and an AI Architect agent that authors them. ERP and
healthcare verticals ride on top.

## Where we are

Phase 2 M1 + M2 + M2.5 + M2.6 + M2.7 + M2.8 + M3 + M3.5 + M3.6 +
M3.7 + M4 + M4.5 + M4.6 + M5 + M5.5 + M5.6 + M5.7 + M5.8 + M6 +
M6.5 + M7 + M7.5 + M7.6 + M7.7 + M7.7.5 + M7.7.6 + M7.8 + M7.8.5
+ M7.8.6 + M7.9 + M7.9.1 + M2.8.5 + M2.8.6 + M8 + M8.5 + M8.6 +
M8.7 + **Phase 3 P1 + P1.5 + P1.6 + P1.7 + P1.8 + P1.9 + P1.10 +
P1.11 + P1.12 + P1.13 + P1.14 + P1.15 + P1.16 + P1.17 + P1.18 +
P1.19 + P1.20 + P1.21 + P1.22 + P2 + P2.1 + P2.2 + P2.3 + P2.4 +
P2.5 + P2.6 + P2.7 + P2.8 + P2.9 + P2.10 + P2.11 + P2.12 + P2.13 +
P2.14 + P1.23 + P1.24 + P1.25 + P2.15 + P1.26 + P2.16 + P2.17 +
P1.27 + P1.28 + P2.18 + P2.19 + P2.20 + P2.21 + P2.22 + P2.23 + P2.24 + P2.25 + P2.26 + P2.27 + P2.28 + P2.29 + P2.30 + P2.31 + P2.32 + P2.33 + P2.34 + P2.35 + P2.36 + P2.37 + P2.38 + P2.39** landed: **62 packages + 3 apps, 124
meta-schema tables, 6,665 offline tests + 36 gated real-Postgres
integration tests (17 worker + 19 operate-server) + three CI gates
(schema-drift + incident-drift + PHI-encryption)**, all green, no type errors. (Earlier
per-increment lines below say "60"/"61 packages" — those are point-in-time
snapshots; the live count is 62 after `incident-response-pg` landed in
P2.31.)
**Phase 2 is complete; Phase 3 (ADR-0077) has begun.** **P2
(ADR-0103) started the distributed-worker milestone** —
`@crossengin/workflow-worker` runs the workflow runtime as a worker
process that advances time-based workflows (firing due timers,
which drives the engine's auto-transitions) on a poll interval,
**coordinated by a Postgres advisory lock** (`WorkflowWorker.
tickOnce` = `conn.withAdvisoryLock(key, () => engine.tickTimers(
now))`). Running N workers is safe — only one ticks at a time, the
engine's `status='scheduled'` guard prevents double-fires, and PG
releases the advisory lock on session death (failover). `start(ms)`
polls (injectable unref'd timer, `onError`-routed); the engine is a
structural `TimerTickEngine` so it wraps a `buildPersistentEngine`
engine with no hard dep. `advisoryLockKey(namespace)` derives the
stable signed-64-bit lock key. No new tables. **P2.1 (ADR-0104)
added per-unit timer claiming for parallel workers** —
`WorkflowEngine.fireTimer({instanceId, timerId})` fires one timer
(idempotent + race-safe: already-fired/not-due/terminal → no-op, so
two workers can't double-fire; `tickTimers` refactored to share the
`applyTimerFired` helper), `meta.workflow_timers` gained lease
columns (`claimed_by`, `lease_expires_at` + a claim index),
`PostgresTimerClaimStore.claimDueTimers` atomically claims a
disjoint batch via `FOR UPDATE SKIP LOCKED` (stamping the lease,
returning timer id + instance `wfi_` ref), and `ClaimingTimerWorker.
runOnce` claims a batch + fires each via `fireTimer` (releasing the
lease on any that didn't fire). N claiming workers drain timers **in
parallel** — no global lock (SKIP LOCKED partitions). **P2.2
(ADR-0105) added the activity retry executor** —
`WorkflowEngine.retryActivity({instanceId, activityId})` re-runs a
failed/timed-out activity at the next attempt with its **original
input** (now persisted on the `activity_scheduled` event) and
advances the workflow on success (idempotent: succeeded/in-flight/
unknown → no-op; shares a `runActivityAttempt` helper extracted
from inline scheduling). `meta.workflow_activities` gained the same
`claimed_by`/`lease_expires_at` lease columns + a retry-claim index;
`PostgresActivityRetryClaimStore.claimDueRetries` claims
failed/timed-out, not-exhausted (`attempt_number < max_attempts`),
backoff-elapsed activities via `FOR UPDATE SKIP LOCKED`; and
`RetryExecutorWorker.runOnce` claims a batch + re-runs each via
`retryActivity`, releasing the lease after each attempt (in a
`finally`). N retry workers drain retries in parallel. A full async
activity *queue* (decouple schedule from execute) + backoff
`next_retry_at` population stay the deeper follow-up. **P2.3
(ADR-0106) shipped `apps/workflow-worker`** — the runnable
`workflow-worker` binary, the **third app** under `apps/` (after
`architect-cli` + `operate-server`). 4 src modules + a bin:
`cli.ts` (`parseWorkerArgs`: `--mode tick|claim|retry|all`
[default `all` = the parallel claim + retry combo], random
`--worker-id`, `--schema`, per-loop `--tick/claim/retry-interval-ms`,
`--batch-size`, `--lease-ms`, `--definitions <file>`), `runner.ts`
(`buildWorkerSet` — the framework-neutral core wiring the worker(s)
for the mode over one `PgConnection` + one structural `WorkerEngine`
= `TimerTickEngine & FireTimerEngine & RetryActivityEngine`:
`tick`→`WorkflowWorker`, `claim`→`ClaimingTimerWorker` over
`PostgresTimerClaimStore`, `retry`→`RetryExecutorWorker` over
`PostgresActivityRetryClaimStore`, `all`→claim+retry; each polls its
own interval, scheduler+`onError` injectable so the wiring is
fake-tested with no DB), `node.ts` (`run` opens
`createNodePgConnection(parsePgEnvConfig())`, loads the
`--definitions` JSON via the pure `parseDefinitionsJson`
[`WorkflowDefinitionSchema`-validated, keyed by id], builds the
persistent engine so every fire/retry projects through the event
log, starts the set, returns a `close()`), and
`bin/workflow-worker.ts` (parse→run→print labels; holds the loop
open with a referenced keep-alive cleared on SIGINT/SIGTERM, since
the poll timers are `unref`'d). The worker connects with a BYPASSRLS
role (drains every tenant). P2's distributed-worker library now has
a deployable artifact. **P2.4 (ADR-0107) populated the retry
backoff** so the parallel retry path honors real delays: the engine
now persists `retryPolicy` + `maxAttempts` + `timeoutSeconds` on the
`activity_scheduled` event, and stamps `nextRetryAt` (=
`computeNextRetryAt(policy, attemptNumber, now)`, null when exhausted/
no_retry) on each `activity_failed`/`activity_timed_out` event. The
backoff math (`retryDelaySeconds`: fixed/linear/exponential, capped at
`maxDelaySeconds`) is extracted once in `@crossengin/workflow-engine`
and shared by the contract's `decideActivityRetry` and the runtime;
`DEFAULT_RETRY_POLICY` (3 attempts, exponential from 1s) is the
fallback. `projectActivities` carries `maxAttempts`/`retryPolicy`/
`timeoutSeconds`/`timeoutAt`/`nextRetryAt` (cleared when the next
attempt starts), and `PostgresActivityStore` persists them all — so
the `workflow_activities` INSERT finally satisfies every NOT NULL
column and `PostgresActivityRetryClaimStore` (ADR-0105, unchanged)
sees real due times instead of always-eligible NULLs. **P2.5
(ADR-0108) added the instance timeout sweeper** — completing the
time-based-progression trio (timers fire · activities retry ·
instances time out). `WorkflowEngine.timeoutInstance({instanceId})`
fails a non-terminal instance past its overall `timeoutAt` deadline
(emits `instance_failed` with `errorCode: INSTANCE_TIMEOUT`;
idempotent + race-safe: terminal/unknown/not-yet-due → no-op),
`meta.workflow_instances` gained the same `claimed_by`/
`lease_expires_at` lease columns + `idx_workflow_instances_timeout_
claim`, `PostgresInstanceTimeoutClaimStore.claimTimedOutInstances`
claims non-terminal, past-deadline, unleased instances via `FOR
UPDATE SKIP LOCKED`, and `TimeoutSweeperWorker.runOnce` claims a
batch + fails each via `timeoutInstance` (lease released in a
`finally`). `apps/workflow-worker` gained `--mode timeout` +
`--timeout-interval-ms`, and the default `--mode all` now runs
**claim + retry + timeout** (the full parallel production set).
**P2.6 (ADR-0109) added a real-Postgres integration test** (gated on
`CROSSENGIN_PG_TEST=1`, skipped offline) that drives the full
`buildPersistentEngine` → projection → worker stack: two
`ClaimingTimerWorker`s race a backlog and **SKIP LOCKED keeps them
disjoint** (no double-fire), `RetryExecutorWorker` re-runs a failed
activity once `next_retry_at` elapses, `TimeoutSweeperWorker` fails a
past-deadline instance, and a lease blocks a second claimer until it
expires. Standing it up surfaced + fixed **latent projection NOT NULL
gaps** in `workflow-runtime-pg` (the persistent engine would have
failed on the first real write): the engine now stamps timer `kind`,
activity `label` + `sequenceCursor`, and signal `deliveryGuarantee` +
`sourceSystem` on their events, the projections + stores persist them,
and `retryActivity` runs the step loop so a retry that reaches a
terminal state emits `instance_completed`/`failed`. **P2.7 (ADR-0110)
added worker observability** — every worker now emits a normalized
`RunOutcome` (`{claimed, processed}`) via `onRun`
(claim→fired/retry→retried/timeout→timedOut), a pure `WorkerHeartbeat`
accumulator folds those + errors into cumulative counters, and
`HeartbeatReporter` flushes a snapshot (status starting→running→
stopped) to the new **platform-wide** `meta.worker_heartbeats` table
(#124, no RLS, upsert on `worker_id`) via `PostgresWorkerHeartbeat
Store` on an interval. `apps/workflow-worker` wires it (unless
`--no-heartbeat`) on `--heartbeat-interval-ms` (default 15000) with
`hostname` from `node:os`. A dead worker is now one query:
`last_heartbeat_at < now() - interval '1 minute'`. **P2.8 (ADR-0111)
added the async activity queue** — decoupling activity schedule from
execute (the deep P2 item), **additively**: a `schedule_activity`
action with `executionMode: "async"` emits `activity_scheduled` and
returns *without* running the handler (the activity stays `scheduled`,
the instance parks), while the default `"inline"` runs in-call as
before. `WorkflowEngine.executeActivity({instanceId, activityId})`
runs the first attempt of a scheduled, never-started async activity
(idempotent/race-safe — already-started/terminal/unknown → no-op),
then steps to finalize. `meta.workflow_activities` gained
`execution_mode` (inline|async, default inline) +
`idx_workflow_activities_execute_claim`,
`PostgresActivityExecuteClaimStore.claimScheduledActivities` claims
`status='scheduled' AND execution_mode='async'` via `FOR UPDATE SKIP
LOCKED`, and `ActivityExecutorWorker.runOnce` claims a batch + runs
each via `executeActivity`. `apps/workflow-worker` gained `--mode
execute` + `--execute-interval-ms`; the default `--mode all` now runs
**claim + retry + timeout + execute**. The lifecycle: schedule(async)
→ scheduled row → executor runs it → on failure the P2.4 backoff +
P2.2 retry executor take over. The engine's per-unit primitives are
now four (fireTimer · retryActivity · timeoutInstance ·
executeActivity), all leased-claim-driven. **P2.9 (ADR-0112) added a
definition-level async default** — `WorkflowDefinition` gained an
optional `defaultActivityExecutionMode` (inline|async); the engine
resolves each activity's mode by precedence (per-action `executionMode`
→ the definition default → inline), so a whole workflow can opt its
activities into async in one place while a per-action flag still
overrides. `.optional()` (not `.default()`) keeps the inferred type
back-compatible; no meta-schema change (the resolved mode still lands
in the `execution_mode` column). **P2.10 (ADR-0113) added the
activity-level timeout sweeper** — completing deadline coverage now
that async activities can sit non-settled.
`WorkflowEngine.timeoutActivity({instanceId, activityId})` times out a
non-settled activity (last event `activity_scheduled`/`activity_started`)
past its deadline (`scheduledAt + timeoutSeconds`), emitting
`activity_timed_out` with `nextRetryAt` (idempotent/race-safe);
`meta.workflow_activities` gained `idx_workflow_activities_timeout_claim`,
`PostgresActivityTimeoutClaimStore.claimTimedOutActivities` claims
`status IN ('scheduled','running') AND timeout_at <= now` via `FOR
UPDATE SKIP LOCKED`, and `ActivityTimeoutSweeperWorker` claims a batch
+ times out each. The `--mode timeout` now runs **both** the instance
sweeper + the activity sweeper (`all` includes both). The engine's
per-unit primitives are now five (fireTimer · retryActivity ·
timeoutInstance · executeActivity · timeoutActivity). **P2.11
(ADR-0114) closed the heartbeat loop with stale-worker detection** —
pure `worker-health.ts` (`classifyWorkerHealth` healthy/stale/stopped,
`summarizeWorkerHealth` → a `WorkerHealthReport` with per-class counts
+ `StaleWorkerAlert[]` oldest-first, `formatWorkerHealth`) plus a read
side on `PostgresWorkerHeartbeatStore` (`listAll` → snapshots;
`listStale({now, staleAfterMs})` pushes `status='running' AND
last_heartbeat_at < now − staleAfterMs` into SQL, returning alerts
with a computed `age_ms`). A dead/hung worker is now a typed alert a
consumer routes to an incident (workflow-worker stays off the
incident/SLO packages). **P2.12 (ADR-0115) added the lease-reaper** —
`PostgresLeaseReaper.reapExpired(now)` proactively clears expired
leases (`lease_expires_at < now`) across the three lease-bearing
tables (timers/activities/instances), returning per-table counts;
`LeaseReaperWorker` polls it on an interval. A crashed worker's
claimed rows are reclaimed proactively (not just lazily on the next
claim); `--mode reap` + `--reap-interval-ms` (default 30000), and
`all` now runs claim + retry + timeout + execute + reap. Reaping is
no less safe than lazy reclaim (the per-unit primitives are
idempotent). **P2.13 (ADR-0116) closed the heartbeat loop end-to-end**
with a stale-worker → incident bridge in `apps/workflow-worker`: a
pure `planStaleWorkerEnforcement` turns a stale `WorkerHealthReport`
into a declared `IncidentRecord` (severity scaled — sev3 at 1–2 stale,
sev2 at 3+) + `PageDirective`s via the existing observability-runtime
`planIncidentDeclaration` / `planPageDirective` planners, and a
`StaleWorkerMonitor` polls `PostgresWorkerHeartbeatStore.listAll`,
summarizes health, and hands any stale-worker incident to an
`onIncident` sink. The bridge lives in the app (which gained
observability-runtime + observability + incident-response deps), so
workflow-worker stays off the incident packages: write (P2.7) → detect
(P2.11) → page (P2.13). **P2.15 (ADR-0121) wired the monitor live**
into the binary: `--monitor` (+ `--monitor-interval-ms` /
`--stale-after-ms` / `--monitor-declared-by`) starts a
`StaleWorkerMonitor` in `run()` over `PostgresWorkerHeartbeatStore`,
minting incident ids via `formatIncidentId` and logging each declared
stale-worker incident. **P2.16 (ADR-0123) added the durable sink** —
`PostgresIncidentSink.record` writes the declared `IncidentRecord` to
`meta.incidents` (`ON CONFLICT (incident_id) DO NOTHING`, idempotent);
`--persist-incidents` (with `--monitor`) wires it into `run()`'s
`onIncident` (else log-only). **P2.17 (ADR-0124) closed the loop** —
the monitor is stateful (`openIncidentId`): staleness opening declares
*once*, ongoing staleness is a no-op (no re-declare), and recovery
fires `onResolve` (sink.resolve UPDATEs `meta.incidents` to status =
'resolved' + stamps `resolved_at`). One durable incident per stale
period, no storm, closed when workers recover. **P2.18 (ADR-0127)
added severity escalation** — the monitor tracks `openSeverity` and, on
an ongoing check, raises an open incident (sev3 → sev2) via `onEscalate`
/ `sink.escalate` when more workers go stale (never de-escalates), so a
worsening outage pages at higher urgency. Full lifecycle: open →
escalate → resolve. **P2.19 (ADR-0128) added incident timeline
entries** — `PostgresIncidentSink.resolve(id, actorUserId)` /
`escalate(id, severity, actorUserId)` now append a typed `TimelineEntry`
(`{occurredAt, actorUserId, kind, message, metadata}`, kind `resolved` /
`severity_changed`) to the incident's JSONB `timeline` in the **same
UPDATE** that flips status/severity (`timeline = timeline || $N::jsonb`,
atomic + still `status <> 'resolved'`-guarded), and `run()` threads
`--monitor-declared-by` as the actor. A stale-worker incident now
carries a self-describing audit trail (declared → severity_changed* →
resolved), each entry stamped with the system actor + a timestamp — the
deferred richer follow-up of P2.17/P2.18. **P2.20 (ADR-0129) wired
re-paging on escalation** — `staleWorkerPages(policy, severity,
incidentId)` (extracted from `planStaleWorkerEnforcement`) resolves the
alert policy into a `PageDirective[]` at a given severity, shared by the
declaration plan + the escalation path; `onEscalate`'s payload became a
`StaleWorkerEscalation` (`{incidentId, severity, pages}`) carrying the
directives recomputed at the **higher** severity, and a new
`page-sink.ts` adds the paging-transport seam (`PageDeliverer` /
`LoggingPageDeliverer` / `deliverPages`, context
`reason: declared|escalated`). `run()` delivers `plan.pages` on
declaration **and** the escalation's pages on escalation through a
`LoggingPageDeliverer` (a real PagerDuty/Slack transport swaps in behind
the interface) — so a worsening outage re-pages on-call at the higher
urgency, the deferred other half of P2.18. **P2.21 (ADR-0130) added the
incident replayer** — a typed read side over `meta.incidents` mirroring
the gateway / SLO replayers: `PostgresIncidentReplayer.listOpen` (status
not in the terminal set, newest-first) / `listForPeriod({from, to})` /
`getByIncidentId` answer "which incidents are live" / "every incident in
a window + its full timeline" in one query, and pure
`verifyTimelineShape` (8 typed drift kinds — empty / first-not-declared /
non-monotonic / invalid-entry / resolved-status↔resolved_at↔
resolved-entry disagreement) + `bulkVerify` / `summarizeIncidentIssues`
run periodic audit sweeps over stored rows. `rowToIncidentSummary`
parses the JSONB timeline leniently (malformed entries counted, not
thrown) so the read never fails on bad data. The incident loop now has a
symmetric write (sink) ↔ read+verify (replayer) shape. **P2.22 (ADR-0131)
surfaced the replayer as an operator CLI** — `workflow-worker incidents
<open|period|verify>` (a subcommand split: `argv[2]==="incidents"` runs a
one-shot query that exits, else the long-running worker loop). `open`
lists live incidents, `period --from/--to` lists a window, `verify
--from/--to` runs the drift sweep and **exits 1 on any drift** (CI gate,
like `crossengin-pg encrypt --verify`); `--format human|json`. Pure
`parseIncidentsArgs` + `runIncidents(options, source, out)` over a
structural `IncidentQuerySource` (offline-tested with a fake);
`executeIncidents` wires the real conn → `PostgresIncidentReplayer`. The
incident audit trail is now operable from the shell. **P2.23 (ADR-0132)
added incident metrics** — pure `incident-metrics.ts` over the timeline:
`incidentResolutionMs` (declared→resolved delta, null on unresolved/skew),
`computeIncidentMetrics` → MTTR (mean/p50/p95/max), open/resolved counts,
per-severity + open-per-severity gauges, escalation totals; surfaced as a
fourth `incidents metrics --from/--to [--format json]` subcommand. The
incident timeline now yields real ops KPIs. **P2.24 (ADR-0133) added
ack/mitigate milestones** — `PostgresIncidentSink.acknowledge(id, actor)`
(declared → triaged, stamps `acked_at`, appends a `status_changed`
`{status:triaged}` entry) + `.mitigate(id, actor)` (→ mitigated, stamps
`mitigated_at`, `{status:mitigated}` entry), each a single guarded UPDATE
(first-wins COALESCE, no-op once past); `incident-metrics.ts` gained
`incidentMilestoneMs` + a shared `statsFrom`, so `computeIncidentMetrics`
now reports **MTTA** (declared→triaged) + **MTTM** (declared→mitigated)
beside MTTR. The incident lifecycle is now fully measurable (declared →
acknowledged → mitigated → resolved). **P2.25 (ADR-0134) added the
ack/mitigate write CLI** — `incidents ack <id>` / `incidents mitigate
<id>` ([--actor <uuid>], default system actor) record the milestones from
the shell; the sink's `acknowledge`/`mitigate` now return whether a row
changed (`rowCount > 0`) so the command prints `acknowledged …` /
`mitigated …` on a real transition and `no-op: …` otherwise (exit 0
either way — idempotent). `parseIncidentsArgs` gained a positional id +
`--actor`; `runIncidentWrite` dispatches over a structural
`IncidentWriteSink`; `executeIncidents` builds a `PostgresIncidentSink`
for the write commands. The incident lifecycle is now fully operable from
one binary (declare/escalate/resolve automated + ack/mitigate operator;
open/period/verify/metrics read). **P2.26 (ADR-0135) wired the incident
drift gate into CI** — a new `integration`-job step runs
`workflow-worker incidents verify` over a wide window after the gated
suites populate `meta.incidents`, so any drifted timeline (e.g. a resolve
that skipped its entry) **fails the build** (exit 1); an empty/clean
table passes. The incident audit trail is now self-policing in CI.
**P2.27 (ADR-0136) added the PHI at-rest encryption gate** — a sibling CI
step runs `crossengin-pg encrypt --verify` over `meta` (the platform
catalog must carry zero plaintext PHI) **and** `public` (where the
operate-server column-store suite provisions real encrypted PHI tables —
4 hinted columns, all BYTEA ciphertext), failing the build on any
`plaintext_at_rest` / `pgcrypto_missing` drift. The data-classification
arc (declare phi → comment → mask → BYTEA → encrypt-on-write) is now
self-policing in CI too. **P2.28 (ADR-0137) shipped a webhook page
transport** — `WebhookPageDeliverer` POSTs a normalized `pagePayload`
(`{incidentId, severity, alertSeverity, reason, channels, deliveredAt}`)
as JSON to an operator-configured webhook (PagerDuty/Slack/Opsgenie/any
HTTP sink), over the global `fetch` behind an injectable `FetchLike`
seam; throws on non-2xx so `onError` routes a failed page. `run()` builds
it under `--page-webhook-url <url>` (else the Logging default), delivered
on declaration + escalation through the existing `PageDeliverer` seam — a
real-network smoke proves the POST. The P2.20 paging seam now has a
working transport. **P2.29 (ADR-0138) made paging auditable** —
`PostgresIncidentSink.recordCommsSent(id, actor, {reason, pageCount})`
appends a `comms_sent` timeline entry (no status/severity change) after a
successful `deliverPages`, so `run()` records *that on-call was paged*
(declared|escalated) on the incident's own timeline. Recording after
delivery means a thrown webhook isn't falsely logged as sent; the
verifier/metrics already accept `comms_sent`. **P2.30 (ADR-0139) added
the MTTP metric** — `incidentTimeToPageMs` (declared → first `comms_sent`)
feeds a fourth `IncidentMetrics.mttp` (mean/p50/p95/max), so
`incidents metrics` now reports the full incident-response KPI set
**MTTP · MTTA · MTTM · MTTR** — the four declared-anchored intervals
(paged → acknowledged → mitigated → resolved), each from the timeline.
**P2.31 (ADR-0140) extracted `@crossengin/incident-response-pg`** — the
incident layer the P2.16–P2.30 increments built (sink · replayer ·
metrics · CLI runner) moved out of `apps/workflow-worker` into a reusable
package (deps `incident-response` + `kernel-pg`): `sink.ts`
(PostgresIncidentSink), `replayer.ts` (PostgresIncidentReplayer +
verifyTimelineShape + IncidentSummary), `metrics.ts`
(computeIncidentMetrics + the MTTP/MTTA/MTTM/MTTR helpers), `query.ts`
(framework-neutral runIncidents / runIncidentWrite over structural
IncidentQuerySource / IncidentWriteSink). The app keeps the
`parseIncidentsArgs` parser (tied to its CliUsageError), the page-sink
transport, the stale-worker-monitor, and the node/bin wiring — now
importing the domain layer from the package. A pure reorg (no behavior
change); any `meta.incidents` consumer can now reuse it. **P2.32
(ADR-0141) made `apps/operate-server` the second consumer** — a
`slo-incidents.ts` runs the M8 `observability-runtime` SLO loop over the
serving request stream: `buildServingSloEngine` (one availability SLO,
99%/30d) + `OperateSloMonitor` (recordRequest maps 5xx→error;
sweep persists each `breach_opened` incident via the shared
`PostgresIncidentSink`, resolves on `recovered`). `node.ts`'s listener
gained an `onRequest(status, latencyMs)` hook (timed in a finally);
`serve()` wires the monitor under `--slo` (+ `--slo-persist` /
`--slo-actor` / `--slo-interval-ms`). A gated test bursts 5xx → the
declared availability incident lands in `meta.incidents` and is read back
via the shared `PostgresIncidentReplayer` — proving the P2.31 extraction's
reuse. **P2.34 (ADR-0143) mirrored the `incidents` CLI subcommand onto
`apps/operate-server`** so an operator can query/transition the same
`meta.incidents` audit table from the serving binary, backed by the shared
`@crossengin/incident-response-pg` runner. **P2.36 (ADR-0145) wired the
schema-drift gate into CI** — a sibling of the P2.26 incident-drift +
P2.27 PHI-encryption gates. A new `Schema drift gate` step in
`.github/workflows/ci.yml`'s `integration` job runs `crossengin-pg drift`
immediately after `scripts/setup-integration-db.sh` provisions +
bootstraps the database, so it gates the **freshly-provisioned baseline**
of the `meta` schema against `META_TABLES`. The bin's pre-existing
exit-1-on-drift contract **fails the build** before the gated suites run.
**P2.38 (ADR-0147) added the latency sibling** so the M8.6
`LatencySloEngine` rides the same serving stream:
`buildServingLatencyEngine` (one latency SLO, p95 ≤ 300ms / 30d, the
same P1 page route + UUID actor; budget parsed via the runtime's
`parseLatencyBudgetMs`, so `'5s'` works) plus an optional
`latencyEngine: LatencyEngineLike` on `OperateSloMonitorOptions`. With
both wired, `recordRequest` feeds both engines, and `sweep` evaluates
both — each `breach_opened` decision's `plan.incident` is persisted
as-is (the runtime stamps `category: 'availability'` from the burn-rate
engine, `'performance'` from the latency engine, so the shared
`PostgresIncidentSink` files them side-by-side without sink changes).
The sweep return became a `ServingDecision[]` with a `signal:
'availability' | 'latency'` discriminator. `--slo-latency-budget
<ms-or-duration>` is the single new CLI knob (default `'300ms'`); `--slo`
keeps enabling **both** engines. A gated test bursts 25× `(200, 2000ms)`
→ a declared `performance` incident lands in `meta.incidents` via the
same shared sink and reads back via the same shared replayer.
**P2.41 (ADR-0150) made serving latency per-route** — mirroring P2.37
for the latency signal: `buildServingLatencyEngineForManifest({manifest,
p95Budget?, …, conn?})` registers **one latency SLO per (method,
operationId)** (`<method>-<surface>-latency` id, `performance`
category), so a slow `POST /v1/orders` declares its own incident rather
than diluting a global p95. It honors `conn` via the M8.7
`buildPersistentLatencySloEngine` wrapper (which already existed) so
per-route latency decisions persist to `meta.slo_enforcement_actions` +
`meta.slo_latency_evaluations`. `LatencyEngineLike.evaluate` was widened
to allow an async result (matching the persistent wrapper, like
`SloEngineLike`), and `OperateSloMonitor.sweep` now awaits it. `serve()`
under `--slo` switched the latency engine from the aggregate
`buildServingLatencyEngine` (kept for back-compat) to the per-manifest
builder; `recordRequest(status, latencyMs, surface)` already threads the
matched route surface into **both** engines. Only manifest-derived
routes are covered (a 404/405 has no surface). Offline tests:
per-route registration count, single-route latency-breach isolation,
and availability + per-route latency composing in one monitor.
**P2.14 (ADR-0118) added a projection
drift-sweep worker mode** — a structural `DriftResyncer` (satisfied by
`WorkflowReplayer`) + `DriftSweepWorker` that periodically re-projects
a bounded batch of instances from the canonical event log and
re-upserts their projection rows (self-healing drift left by a crash /
schema change); `--mode resync` + `--resync-interval-ms` (default
300000) + `--resync-max` (500), **opt-in, not in `all`** (heavy
re-projection). The worker now has eight modes (tick · claim · retry ·
timeout · execute · reap · resync · all). **The P2 distributed-worker
arc is complete.** P1 added
`@crossengin/operate-runtime` — the serving keystone that
composes a resolved manifest into a live multi-tenant API. A
`manifest → routes → handlers` compiler derives a `RouteSpec` per
entity operation (5 CRUD + one per `entityLifecycle` transition,
camelCase operationIds + kebab-plural paths), `buildSpecHandler`
returns an RBAC-enforcing (`rbacCheck`) gateway `Handler` over an
injectable `EntityStore` (`InMemoryEntityStore` now; Postgres
RLS-backed next), and `compileOperateServer` / `buildOperateGateway`
wire routes + handlers + `redactionRegistryFromManifest` into a
`GatewayRuntime`. End-to-end through the real gateway: a cashier
`GET /v1/products` gets `unit_cost` redacted, a manager gets it,
each request emits a `PipelineExecution`. **P1.5 (ADR-0079)
closed the two gateway gaps P1 surfaced** so the *write* path runs
end-to-end too: `api-gateway-runtime`'s `parse_request` now decodes
a JSON body (by `content-type`) into `ctx.parsedBody` — the raw
bytes ride on a new `RuntimeIncomingRequest extends IncomingRequest`
(`rawBody: Uint8Array | null`, never persisted in the
`PipelineExecution`) — and `dispatch_handler` maps a handler status
`>= 400` to a `deny` (4xx, `handler-error` problem-type URI) / `error`
(5xx) stage outcome and halts, instead of recording `pass` and
tripping the "pass cannot be 4xx" invariant. operate-runtime now
serves `POST /v1/products` (body → store), RBAC 403, and a 409
lifecycle re-fire all through the real gateway; the handler's own
JSON body is preserved on the error envelope. **P1.6 (ADR-0086)
resolved ADR-0078 Q3** — `@crossengin/operate-runtime-pg` ships
`PostgresEntityStore`, a Postgres `EntityStore` over a new
`meta.operate_entity_records` table (tenant-scoped JSONB document
store, keyed by `(tenant_id, entity, record_id)`, table #123).
Every op runs inside `withTenantContext` —
`SELECT set_config('app.current_tenant_id', $1, true)` in a
transaction — so the **RLS policy** (not just `WHERE tenant_id =
$1`) confines reads/writes to the caller's tenant; the tenant id
rides as a bound parameter, never interpolated, and a malformed
tenant/schema throws before reaching SQL. It satisfies the exact
`EntityStore` contract P1 defined, so `buildOperateGateway(manifest,
{store: new PostgresEntityStore(conn), …})` serves the retail pack
from Postgres with no other change. Column-mapped per-entity tables
(DDL from the pack) stay the deeper follow-up behind the same
contract. **P1.7 (ADR-0087) resolved ADR-0078 Q4** — `apps/operate-
server` is the runnable serving binary, the second app under
`apps/`. A thin Node `http` shell over `buildOperateGateway`:
`OperateHttpServer.dispatch(raw, body)` maps a framework-neutral
`RawHttpRequest` → the 17-stage pipeline → a `RawHttpResponse`
(unknown method → 405 problem doc); `serve(--pack erp-retail|… |
--manifest f.json --store memory|pg --api-key key:role:tenant)`
loads + **resolves** the manifest at boot (retail → core, grocery
→ retail → core merge), builds the store (`InMemoryEntityStore` or
a `PostgresEntityStore` over `parsePgEnvConfig()`), wires API-key
auth (fail-closed: unknown token → 401), and listens. A real
loopback test boots it and gets a 200; every other module is
tested offline over `RawHttpRequest`/mock Node req-res. The HTTP
edge preserves every P1 guarantee — per-caller `unit_cost`
redaction, RBAC 403, lifecycle — now over raw HTTP. **P1.8
(ADR-0088) resolved ADR-0078 Q5 — the last open P1 question.**
The list endpoint is now paginated + filterable, driven by the
entity's `ListView`: `store.listPage(tenant, entity, ListQuery)`
returns a bounded `ListPage` with an opaque offset cursor;
`listConfigForEntity` reads the view's `pageSize` / default `sort`
/ sortable+filterable columns into a `ListConfig`, and
`parseListQuery` turns `?limit` (clamped to 500) / `?cursor` /
`?sort=field&order=asc|desc` (sortable fields only) / equality
filters (filterable columns only; unknown params ignored — can't
widen results) into a resolved query. The `list` handler returns
`{data, page:{limit, nextCursor}}`. `PostgresEntityStore.listPage`
pushes it into SQL — `document ->> 'field' = $n` filters, `ORDER
BY document ->> 'field' …, record_id ASC`, `LIMIT limit+1 OFFSET`
(the +1 detects a next page) — with field names identifier-
validated (only values bound; a `name; DROP` field is dropped, not
executed). **The whole P1 arc (compile → gaps → store → server →
paginated lists) is complete.** **P1.9 (ADR-0089) cashed in the
P1.7 framework-neutral seam** with an edge / Workers fetch adapter
in `apps/operate-server` (new `edge.ts`, no new package): over the
same `OperateHttpServer.dispatch` core, `fetchToRaw(Request)` maps
a Fetch API request → `RawHttpRequest`+body (client IP from
`cf-connecting-ip`), `rawToFetchResponse` → a real `Response`,
`createFetchHandler(server)` is the `(Request)→Promise<Response>`
edge counterpart of the Node listener, `buildEdgeFetchHandler`
composes one (store defaults to in-memory for socket-less
runtimes, scheme `https`), and `asModuleWorker` yields the
Cloudflare `{fetch}` default-export shape. Tests build genuine
`new Request(...)` and read `Response.json()` (Node undici
globals), proving identical behavior — per-caller `unit_cost`
redaction, RBAC 401, `?limit` pagination — on a second real
runtime from one `dispatch`. The serving stack now runs on Node
**and** any Fetch/WinterCG runtime. **P1.10 (ADR-0090) delivered the deeper ADR-0086
follow-up** — `ColumnMappedEntityStore`, the typed sibling of the
JSONB store: real per-entity tables whose columns are derived from
the manifest entity's fields (kernel `fieldTypeToPostgresType` +
`columnNameForField`; reference → `<name>_id` UUID), with a
`(tenant_id, TEXT id)` PK + RLS + idempotent DDL. `column-plan`
derives the field→column plan (carrying classification +
`encryptAtRest`); `entity-ddl` emits idempotent `CREATE TABLE IF
NOT EXISTS` + RLS (`DROP POLICY IF EXISTS`→`CREATE POLICY`) +
`crossengin.data_class=…[; crossengin.encrypt=at_rest]` column
comments (the kernel-pg applier's convention); the store maps
record↔column on every op, **sorts on the native column type** (a
real `ORDER BY "col"`, not JSONB text) and filters by safe
`"col"::text = $n`. `id` stays TEXT for cross-store record parity.
`operate-server --store pg-columns` provisions the typed tables at
boot (`ensureSchema`) and serves a pack from them — a demonstrated
drop-in for the JSONB store. **P1.11 (ADR-0091) closed the last
ADR-0090 follow-up — transparent at-rest encryption** in the
column store: a `phi`/`regulated` column is emitted as `BYTEA` and
the store wires pgcrypto in — `pgp_sym_encrypt($n::text, keyRef)`
on write, `pgp_sym_decrypt("col", keyRef) AS "col"` on read (key
by SQL *reference*, default `current_setting('app.column_
encryption_key')`, never inlined), `ensureSchema` runs `CREATE
EXTENSION IF NOT EXISTS pgcrypto`, and encrypted columns are
excluded from sort/filter (can't order ciphertext). PHI is
ciphertext at rest and plaintext to authorized callers,
transparently — closing the classification arc end-to-end through
the serving store (declare `phi` → comment → redaction → BYTEA →
encrypt-on-write/decrypt-on-read). Searchable encryption + key
rotation stay the deferred crypto follow-ups. **P1.12 (ADR-0092)
delivered the ADR-0090 FK follow-up** — the column store now
enforces referential integrity: a reference field's column is TEXT
(matching the TEXT `id`) carrying its `referenceTarget`, and
`ensureSchema` adds a **composite, tenant-scoped** FK
(`(tenant_id, <ref>_id) → target (tenant_id, id)` ON DELETE
RESTRICT) so a reference can only resolve within the same tenant.
DDL applies **two-phase**: all tables are created in
`topologicalEntityOrder` (referenced before referencer, Kahn's
algorithm), then all FKs are added once every target exists —
cycle-safe (`DROP CONSTRAINT IF EXISTS`→`ADD CONSTRAINT`, idempotent).
**P1.13 (ADR-0093) drove the FK `ON DELETE` behavior from the
manifest** — `relationDeleteIndex` reads each `many_to_one`
relation's `onDelete` (`restrict|cascade|set_null`) by
`"<from>.<field>"`, and `emitForeignKeyDdl` applies it per
reference (default RESTRICT); `set_null` uses the column-list form
`ON DELETE SET NULL ("<ref>_id")` so `tenant_id` is never nulled
(PG≥15). **P1.14 (ADR-0094) added `many_to_many` join tables** —
`joinTablePlansForManifest` derives a `<left>_<right>` link table
per m2m relation (`<left>_id`/`<right>_id` columns; self-relations
disambiguate to `_left_id`/`_right_id`), and `emitJoinTableDdl`
provisions it tenant-scoped: `(tenant_id, <left>_id, <right>_id)`
composite PK + RLS + a composite `ON DELETE CASCADE` FK from each
side to its entity's `(tenant_id, id)` (same-tenant links, cascade-
cleaned). `ensureSchema` adds them in a third phase after the
entity tables. The column store now models the manifest's full
relational intent — 1:N references *and* M:N associations. **P1.15
(ADR-0095) added the association link API** over those join tables:
`ColumnMappedEntityStore.link` (`INSERT … ON CONFLICT DO NOTHING`,
idempotent) / `unlink` / `isLinked` / `listLinks({leftId?, rightId?})`
— keyed by the relation's `(left, right)` entities, each
`withTenantContext`-wrapped, the composite FK confining a link to
the caller's tenant. Manifest-derived association *routes* (HTTP)
are the open follow-up. **P1.16 (ADR-0096) upgraded list
pagination + filtering** across all three stores (in-memory, JSONB,
column): offset cursors → **keyset** (`encodeKeyset`/`decodeKeyset`
over `{k: sortValues, id}`, stable under concurrent inserts/deletes,
no `OFFSET` scan), and equality-only filters → **typed operators**
(`eq|ne|gt|gte|lt|lte|in`). A shared `list-sql.ts` query builder
(via a `ListSqlAdapter`) serves both PG stores: filters →
`<expr> <op> $n<cast>` / `in` → `<expr>::text = ANY($n::text[])`,
keyset seek → the OR-of-AND expansion handling mixed sort
directions, order → sort + `id` tiebreaker, `LIMIT n+1`. The column
store casts the bound value to the column's native type
(`$n::NUMERIC(…)` — correct typed compare); the JSONB store
text-compares. `parseListQuery` reads `?field[op]=value` +
`?field[in]=a,b,c`, still gated to filterable columns. Field
selection (projection) is the open list refinement. **P1.17
(ADR-0097) added a production JWT/JWKS identity source** to
`apps/operate-server`, behind the existing `PrincipalWiring` seam:
`OperateGatewayOptions` gains `jwksProvider`/`jwtIssuer`/
`jwtAudience` (the gateway already does the EdDSA verify), and
`buildPrincipalWiring`'s resolver is now scheme-aware — a verified
`bearer_jwt` resolves *statelessly* from its claims
(`principalFromJwtClaims`: `sub` → a UUID via `subjectToUuid`,
scopes → grantedScopes/role, tenant from the `x-tenant-id`
`tenantHint`), while opaque `api_key_header` tokens resolve from
the registered map (unchanged). `--jwks-key kid:base64` /
`--jwks-file` + `--jwt-issuer` / `--jwt-audience` wire an
`InMemoryJwksProvider`; threads through Node *and* edge. Tests mint
a real Ed25519-signed JWT (generateEd25519Keypair + signEd25519) —
valid → 200/201 (scope drives RBAC), unknown-key/wrong-issuer/
expired → 401, fail-closed. Dev (`--api-key`) + prod (JWT) auth
coexist. **P1.18 (ADR-0098) closed the JWT/tenant cross-check gap**
in the gateway: the request tenant came from the *spoofable*
`x-tenant-id` header, while a JWT also carries an authoritative
`tenant_id` claim. `resolvePrincipalForCredential` now takes the
credential's `authenticatedTenantId` (`ctx.tenantId`, set from the
JWT claim / api-key lookup) — if it and the header hint differ it
denies with a new `tenant_mismatch` outcome (401), else the
**credential** tenant is authoritative (header only a fallback).
A spoofed `x-tenant-id` can no longer override a JWT's tenant;
fix is gateway-wide (every consumer benefits). **P1.19 (ADR-0099)
added a caching remote-JWKS provider** to `apps/operate-server`
(`jwks.ts`): `RemoteJwksProvider` fetches an IdP's JWKS endpoint
(`--jwks-url`), caches the `kid → base64 Ed25519` map for a TTL
(`parseJwksDocument` keeps OKP/Ed25519 keys, `base64UrlToBase64`
converts the JWK `x`), refetches a **stale** cache or an **unknown
kid** (rotation pickup, rate-limited by a min-refetch floor), and
keeps the last good key set on a failed fetch (resilient,
fail-closed). `fetch` is injectable for offline tests; a real
Ed25519-signed JWT verifies against keys fetched from a stubbed
JWKS endpoint end-to-end. **P1.20 (ADR-0100) added a background
JWKS refresh poller** — `JwksRefreshPoller.start()` refreshes the
remote provider immediately then every `--jwks-refresh-ms` (timer
injectable + `unref`'d so it never holds the process open;
`onError` routes a failed refresh), `stop()` clears it (wired into
`serve()`'s close handle). Requests never pay the JWKS fetch
latency; lazy refresh stays the fallback. **P1.21 (ADR-0101) added
field selection (projection)** — `?fields=a,b,c` on list + read
(`parseFields` + pure `projectRecord`, `fields` reserved so it's
never a filter). Projection only *narrows*: a manager
`?fields=sku,unit_cost` gets both, a cashier with the same query
gets `unit_cost` dropped by classification redaction at the edge —
projection can't bypass redaction. `id` is always kept. **P1.22
(ADR-0102) pushed the projection into SQL** for the column store:
`listPage` SELECTs only `id` + the requested columns + the sort
columns (needed for the keyset cursor), so unselected large/
encrypted columns are never read/decrypted; the handler still
re-projects to the exact set, and in-memory/JSONB ignore the hint
(handler-level projection, still correct). **P2.40 (ADR-0149)
persisted incident KPI snapshots for trend analysis** —
`computeIncidentMetrics` (P2.23/0132 + P2.30/0139) folds the
`meta.incidents` timeline into MTTP/MTTA/MTTM/MTTR + open/resolved/
escalation gauges, but only on demand. P2.40 freezes those KPIs to a
new platform-wide `meta.incident_metric_snapshots` table (#125, no RLS,
`ims_` ids; window_from/to + computed_at, INTEGER total/open/resolved/
escalations, JSONB by_severity/open_by_severity + a nullable JSONB
column per MttrStats) via a new `PostgresIncidentMetricsStore` in
`@crossengin/incident-response-pg`: `recordSnapshot(window, metrics)`
INSERTs one window's verdict (each call mints a fresh id → the trend is
append-only; a null MttrStat binds as SQL NULL, never the string
"null"), `listSnapshots({from,to,limit})` reads a window newest-first,
and the pure `incidentMetricsSnapshotRow` projector + `generateSnapshotId`
(Crockford-base32, matching the table's check) round out the module. A
gated operate-server test declares an incident, computes metrics over a
window via the shared `PostgresIncidentReplayer`, records a snapshot, and
reads it back. The schema-drift gate + `emit-bootstrap.mjs` pick the new
table up from `META_TABLES` automatically; the recurring snapshot writer
(a worker mode / CLI) is the deferred follow-on. **P2.39 (ADR-0148)
deepened the encrypted-column read-fidelity coverage** in the
column store — a gated real-Postgres test
(`integration-columns-encrypted.test.ts`) drives `pgp_sym_encrypt`
+ `pgp_sym_decrypt` through five edge cases (NULL PHI, empty-string
PHI, multibyte / Arabic PHI, >700-char PHI, `listPage` decryption
under projection), and surfaced a latent bug in
`ColumnMappedEntityStore.writePlaceholder`: an encrypted column
written with `value === null` was binding `String(null)` =
`"null"` and emitting `pgp_sym_encrypt('null', keyRef)` — storing
the four-character ciphertext `n,u,l,l` instead of SQL NULL, so a
clear PHI value to `null` round-tripped as the unrelated string
"null". The fix short-circuits a `null` value to a bare `NULL`
literal regardless of classification, so NULL is now a first-class
write that round-trips as `null` on read for encrypted and
plaintext columns alike (and `""` stays distinct — empty plaintext
yields a real non-null BYTEA envelope). Three offline unit tests
lock the placeholder shape. M7.9.1 added
`@crossengin/pack-erp-grocery` — the fourth vertical pack,
proving **transitive (three-level) `meta.extends` lineage**:
grocery extends `operate-erp/retail`, which itself extends core,
so `resolveManifest` recurses grocery → retail → core and merges
all three (10 entities, 9 roles, 3 workflows, 11 relations). 2
entities (Supplier → core Account; PerishableLot → retail Product
+ own Supplier; both auditable) with cross-level references that
resolve only when the whole chain is present — a test asserts
resolution *throws* when retail is available but core is not.
`Supplier.contact_email` → pii, `PerishableLot.cost_per_unit` →
commercial_sensitive; classifications survive the deeper merge
(retail's `Product.unit_cost` also propagates).
`compliancePacks: ["haccp"]`. **Phase 2's eight milestones
(M1–M8) are complete.** M7.9 added `@crossengin/pack-erp-retail`
— the third vertical pack and the second `meta.extends` consumer,
proving the pack-extension mechanism generalizes. It declares
`meta.extends: ["operate-erp/core"]` and resolves to 8 entities
(4 core + 4 retail: Product / Store / SalesOrder / OrderLine),
8 relations (two cross-pack: Account→Stores, SalesOrder→Invoice),
merged roles (retail_admin / store_manager / cashier /
retail_analyst), a SalesOrder entityLifecycle (cart → placed →
fulfilled → returned, cancel from cart/placed), 2 jobs, 2 views,
`compliancePacks: ["pci"]`. Crucially it exercises the
classification arc on a **non-PHI** domain: `Product.unit_cost` →
`commercial_sensitive` (redacted from cashiers — explicit
`fields.unit_cost.read` grant excludes them), `SalesOrder.
customer_email` → `pii`; no `phi`/`regulated`, so the
audit-required + encryption-hint invariants correctly don't fire.
`buildErpRetailPack(opts?)` cross-validates only after
`resolveManifest` merges core in. M7.8.6 surfaced the
M7.8/M7.8.5 encryption applier +
migrator as a `crossengin-pg encrypt` CLI command:
`encrypt --verify` prints an `EncryptionCoverageReport`
(`formatEncryptionCoverage`) and exits 1 on drift (plaintext PHI
/ missing pgcrypto) so CI can gate "zero plaintext PHI columns";
`encrypt --plan` (default) prints the encrypt-on-write SQL dry-run
(`formatEncryptionPlan`); `encrypt --apply [--provision]
[--confirm]` runs the migration (production-guarded). Flags:
`--schema=<name>` (default meta), `--key-ref=<sql>` (default
`current_setting('app.column_encryption_key')` — a reference,
never a raw key). The bin's flag parser was extended to read
`--k=v` values; the decision/SQL logic stays in tested `src`
modules so the bin is a thin dispatcher.
M2.8.6 added per-turn provider + cost attribution to chat:
`@crossengin/ai-router`'s `DefaultLlmRouter` gained an opt-in
`onResolved(resolution)` observer (`RouterResolution =
{task, providerId, modelId, latencyMs, fallbackDepth}`) that fires
once per successful `complete()` with the provider that actually
served it (`fallbackDepth>0` ⇒ a fallback was used; it does not
fire on `AllProvidersExhaustedError`). `architect-cli`'s
`buildChatProvider` now returns a `describeLastTurn()` label
(static `anthropic/<model>` for a single provider; router-observer
-driven `providerId/model (fallback)` for the router), and
`formatUsageLine(usage, label?)` appends `via <label>` — so the
human chat footer reads `[tokens in=… out=… cost=$… via
openai/gpt-4o (fallback)]`. No `CompletionChunk` contract change;
JSON mode + the `providerOverride` test seam are untouched.
M2.8.5 wired
the M6.5 router + the M2.8 OpenAI provider into `architect-cli`'s
`chat` command — previously it constructed a single
`AnthropicProvider` directly. The chat engine's provider type was
narrowed from `LlmProvider` to a structural `CompletionProvider`
(`{complete()}`), which both a concrete provider and a
`DefaultLlmRouter` satisfy — no adapter. `buildChatProvider`
picks the source: `providerOverride` (tests) wins; `--provider
anthropic|openai` forces a single vendor; `--provider auto`
(default) builds a `DefaultLlmRouter` (Anthropic primary →
OpenAI fallback) when **both** `ANTHROPIC_API_KEY` +
`OPENAI_API_KEY` are set, else the single available provider,
else an error. `--openai-model` (default gpt-4o) sets the OpenAI
model. Chat is now multi-vendor with real cross-vendor failover;
the test seam (`providerOverride`) is untouched, so CI still runs
offline. M7.8.5
shipped the encrypt-on-write migration that makes M7.8's
`plaintext_at_rest` go green: `kernel-pg`'s
`encryption-migration.ts` converts a hinted plaintext column to a
pgcrypto-encrypted `BYTEA` column in place — `emitEncryptColumnSql`
emits the ordered ADD `<col>__enc BYTEA` / UPDATE
`pgp_sym_encrypt(<col>::text, keyRef)` (NULLs preserved) / DROP /
RENAME / re-COMMENT directive, `emitDecryptingViewSql` builds a
`pgp_sym_decrypt` read view, and `EncryptionMigrator.migrateSchema(
schema, keyRef)` plans (plaintext-only, so re-runs are no-ops) +
runs each column in its own transaction. Key is always a SQL
*reference*, never inlined (test-enforced). After migration the
M7.8 verifier reports the column encrypted-at-rest. The
transparent *write* path (INSTEAD OF triggers) + key rotation are
the deferred follow-ups. M7.8 chose the at-rest
encryption mechanism and shipped its `kernel-pg` applier: a
`phi`/`regulated` column's `crossengin.encrypt=at_rest` hint
(M7.7) is fulfilled by **pgcrypto** symmetric encryption
(`pgp_sym_encrypt`/`pgp_sym_decrypt`, `BYTEA` ciphertext, key by
SQL *reference* — never inlined), since `@crossengin/crypto` has
no symmetric cipher. A new `encryption.ts` ships
`parseColumnDirectives` (the pure inverse of the emitter's
comment), `introspectEncryptedColumns` (reads `col_description`),
`ensurePgcryptoExtension` / `pgcryptoInstalled`,
`pgpSymEncryptExpr`/`DecryptExpr` SQL builders, and
`summarizeEncryptionCoverage` → an `EncryptionCoverageReport`
flagging `plaintext_at_rest` (hinted but stored as a plaintext
type) + `pgcrypto_missing` drift; `EncryptionApplier` ties
provision + coverage + verify. The column-rewrite-to-BYTEA +
encrypt-on-write path (a view/trigger using the builders) is the
explicit follow-up. M7.7.6 closed the
classification pipeline to zero-config:
`api-gateway-runtime`'s `redactionRegistryFromManifest(manifest,
{rolesForPrincipal, policyForEntity?, operationsForEntity?})`
builds a `RedactionRegistry` straight from a manifest — every
entity that declares a classified field (`entityClassifiedFields`)
contributes a `ResponseRedactionSpec` registered under its read
operationIds (default `<entitylower>.read|list|get`). Input is a
structural `RedactionManifestInput` (`{entities, permissions,
roles}`), so the runtime stays off `@crossengin/kernel` while a
full `Manifest` is still assignable. The deployment supplies only
what the schema can't know — the scope→role bridge and the
`SensitiveFieldPolicy` (privilegedRoles); without a policy,
sensitive fields are redacted for everyone lacking an explicit
grant (fail-closed). Declaring `classification: "phi"` on a field
now drives the whole chain — catalog comment, audit invariant,
encryption hint, default mask, edge redaction — with no
hand-written spec. M7.7.5 wired the M7.7 classification
redaction into the API gateway: `api-gateway-runtime`'s
`transform_response` stage (previously a no-op) now strips
classified fields from JSON responses per-caller. A new
`redaction.ts` ships `ResponseRedactionSpec` (classifiedFields +
roles map + `rolesForPrincipal` scope→role bridge + optional
entityPermissions/policy), a `RedactionRegistry` /
`MapRedactionRegistry` (operationId → spec),
`computeRedactedFields` (bridges the gateway `ResolvedPrincipal`
to an auth `Principal`, fail-closed: unknown roles map to an
unprivileged sentinel rather than throwing), and `redactJsonValue`
(pure tree-walk that drops named fields across records / arrays /
`{data:[…]}` wrappers). `GatewayRuntimeOptions.redactionRegistry`
is opt-in; the stage records `redacted_N_fields` in the
`PipelineExecution` audit. Handlers return the full record; the
edge redacts. M7.7 acted on the M7.6 data classification (auth +
kernel + types enhancement, no new package): a sensitive field
(pii/phi/regulated/commercial_sensitive) with no explicit `read`
grant is now redacted-by-default for non-privileged principals
via `computeClassifiedFieldRedaction` /
`validateClassifiedWriteMask` in `@crossengin/auth` (explicit
per-field grants still win; `SensitiveFieldPolicy =
{privilegedRoles?, redactByDefault?}` parameterizes it), and the
DDL emitter appends `crossengin.encrypt=at_rest` to the column
comment for phi/regulated fields (`requiresEncryptionAtRest` in
types) so the storage layer has an at-rest-encryption signal in
`pg_catalog`. Fully backward compatible — the original
`computeFieldRedaction` / `validateWriteMask` are untouched; the
classification-aware variants are additive opt-ins. Closes the
loop M7.6 opened: classification now drives masking + an
encryption hint, not just a catalog comment. M7.6 added
field-level data classification (kernel +
types enhancement, no new package): the manifest `FieldSchema`
gained an optional `classification` (`public | internal |
commercial_sensitive | pii | phi | regulated`, mirroring jobs'
`DATA_CLASSES`), the DDL emitter writes `COMMENT ON COLUMN …
'crossengin.data_class=<class>'` for each classified field (so
the class lands in `pg_catalog`), and `validateManifest` now
enforces that any `phi`/`regulated` field lives on an
`auditable` entity. `manifestClassifiedFields(manifest)` returns
the full `{entity, field, classification}` inventory;
`entityClassifiedFields` / `isFieldSensitive` /
`requiresAuditTrail` are the field-level helpers. `pack-erp-
healthcare` now classifies its PHI/PII fields (Patient.mrn →
phi, demographics → pii, Observation.value_* → phi) and still
cross-validates. Foundation for default field-redaction +
at-rest encryption hints (M7.7). M7.5 added
`@crossengin/pack-erp-healthcare` — the second
vertical pack and the first to use `meta.extends` lineage. It
declares `meta.extends: ["operate-erp/core"]` and references core
entities (Account, Invoice) by name, so it does NOT cross-validate
standalone — only once `resolveManifest` merges the core pack in
(via a `ManifestRegistry`) does `tryValidateManifest` pass (7
entities = 4 core + 3 healthcare, 7 relations, merged roles, both
lifecycle workflows). 3 entities (Patient → core Account,
Encounter → Patient + optional core Invoice, Observation →
Encounter — all auditable, PHI), 4 relations (two cross-pack:
Account→Patients + Encounter→Invoice), 4 roles (clinical_admin /
clinician / front_desk / hipaa_auditor), an Encounter
entityLifecycle (scheduled → in_progress → completed|cancelled|
no_show), 2 PHI-tagged jobs (appointment reminder + lab-result
handler), 2 views, `compliancePacks: ["hipaa"]`. Proves the
kernel's pack-extension mechanism end-to-end; template for
pack-erp-retail / -construction / -education. M2.8 added
`@crossengin/ai-providers-openai` — the second real
`LlmProvider`, binding OpenAI's Chat Completions + Embeddings
APIs to the same contract as the Anthropic client (zero runtime
deps, pure fetch + ReadableStream). 5 modules: pricing (gpt-4.1
/ gpt-4.1-mini / gpt-4o / gpt-4o-mini / o4-mini + the two
text-embedding-3 models; computeUsageCost subtracts cached from
the total prompt_tokens before charging), chat-api (system
messages stay first-class; assistant toolUses → tool_calls with
stringified arguments; tool → role:tool + tool_call_id; jsonMode
→ response_format; stream → stream_options.include_usage),
streaming (data:/[DONE] SSE parser; assembles tool_calls by
index; tool_call_end on finish_reason; shared StreamState across
read boundaries), errors (OpenAiError + isRetryable +
classifyHttpStatus; 503→service_unavailable), provider
(OpenAiProvider implements LlmProvider — complete() streaming +
real embed() via /v1/embeddings + completeNonStreaming;
capabilities jsonMode + embedding true; Bearer auth + optional
org/project; FetchLike injection). First provider with working
embeddings; the ai-router fallback chain is now genuinely
multi-vendor. M8.7 added
latency enforcement persistence to
`@crossengin/observability-runtime-pg`: a `signal`
('availability' | 'latency', default 'availability') column on
`meta.slo_enforcement_actions` so one audit table serves both
engines, plus a new `meta.slo_latency_evaluations` table
(`slle_` ids, worst_percentile p50/p95/p99, sample_count,
breaches JSONB, platform-or-tenant RLS) for latency verdict
snapshots. `buildPersistentLatencySloEngine` wraps a
`LatencySloEngine` — every decision writes a latency-signal
enforcement action, every breach_opened writes a latency
evaluation snapshot. `enforcementActionFromDecision` now accepts
`EnforcementDecision | LatencyEnforcementDecision` + a `signal`;
the M8.5 `SloEnforcementReplayer` verifies latency actions
unchanged (its checks are signal-agnostic). M8.6 added
latency-target SLO enforcement to `@crossengin/
observability-runtime` (pure compute, no new package/tables): a
`LatencySloEngine` that rides the same `recordOutcome()` stream,
computes p50/p95/p99 over a short rolling window
(`RollingWindow.latencyStats` + exported `percentile`), and on a
breach reuses the shared enforcement planners to declare a
`performance` incident, page on-call, and optionally roll a flag
back. `latency.ts` is pure: `parseLatencyBudgetMs` ("300ms"/"5s"
→ ms), `DEFAULT_LATENCY_THRESHOLDS` (latency-page ≥2×→sev2 +
latency-ticket >1×→sev3, minSamples 20), `evaluateLatencyTarget`
(fires per declared percentile when observed > budget×multiplier
and count ≥ minSamples; worst severity wins). One incident per
ongoing breach; `recovered` when latency drops back under
budget. Availability (`SloEnforcementEngine`) + latency
(`LatencySloEngine`) compose over one shared `RollingWindow`.
M8.5 added
`@crossengin/observability-runtime-pg` — the Postgres persistence
sibling for the SLO enforcement loop. 5 modules: records
(SloEvaluationRecord + SloEnforcementActionRecord schemas +
sloe_/sloa_ id generators + pure projectors
evaluationRecordFromVerdict / enforcementActionFromDecision),
evaluation-store (PostgresSloEvaluationStore — INSERT … ON
CONFLICT + countBreachesSince), enforcement-action-store
(PostgresSloEnforcementActionStore — record + listForIncident +
listRecent + countSince with a row→record mapper),
persisting-engine (buildPersistentSloEnforcementEngine wraps a
SloEnforcementEngine so every evaluate() writes an enforcement
action per decision + an evaluation snapshot per breach_opened;
tenant resolves from registration → resolveTenantId → kill
switch), replayer (pure verifyEnforcementActionShape +
verifyEnforcementHistory — ongoing/recovered-without-open,
duplicate-open, paged-without-channels, kill-switch-without-flag
— + summarizeEnforcement + SloEnforcementReplayer). Two new META_
tables: meta.slo_evaluations + meta.slo_enforcement_actions
(platform-or-tenant RLS, append-only). M8 added
`@crossengin/observability-runtime` — the SLO enforcement loop.
7 modules: clock (Clock/FixedClock + parseDurationMs), window
(RequestOutcome ingest + RollingWindow per-surface counts),
burn-rate (multi-window Google-SRE burn-rate evaluation —
fast-burn 1h/5m@14.4×→sev2, slow-burn 6h/30m@6×→sev3, fires
only when both windows clear the multiplier + minSamples),
synthetics (SyntheticTracker + consecutive-failure detection),
enforcement (pure planners: planIncidentDeclaration →
schema-valid declared IncidentRecord, planPageDirective →
AlertRouteResolution, planKillSwitchActivation →
triggered_active KillSwitch with automated_metric_breach
trigger; severity→alert-severity map; INC-/fks_ id formatters),
tracing (TraceCollector stitches gateway→workflow→notifications
spans into a tree), engine (SloEnforcementEngine: recordOutcome
+ evaluate → breach_opened/breach_ongoing/recovered decisions,
dedups one incident per ongoing breach, mints cross-linked
incident + kill-switch ids). Pure runtime, no new META_ tables —
emits records typed by existing contracts (IncidentRecord →
META_INCIDENTS, KillSwitch → feature-flag tables). The exit
criterion runs end-to-end in tests: a 5xx burst on
`POST /v1/orders` declares a SEV2 incident, pages on-call, and
rolls `ff_checkout01` back to its safe value. M6.5 added
`@crossengin/ai-router` — the orchestration layer between
consumers and `LlmProvider` implementations. 5 modules: retry
(exponential backoff + isRetryable check + withRetry wrapper),
cost-tracker (CostCeiling interface + InMemoryCostTracker with
rolling per-tenant windows + CostCeilingExceededError),
latency-tracker (rolling p50/p95 buffer per provider), resolve
(pure provider-chain resolution: parseProviderRef + residency
filter + parent/override merge), router (DefaultLlmRouter
implements LlmRouter from @crossengin/ai-providers — picks a
provider per task, retries transient errors, falls back to the
next provider on failure, enforces cost ceilings pre-flight,
buffers chunks for clean retry replays, throws
AllProvidersExhaustedError when every fallback exhausts). The
chat substrate can swap its direct AnthropicProvider for a
router whenever M2.8 (OpenAI) lands — the consumer-facing
LlmProvider surface is identical.
M7 shipped the first vertical pack — `@crossengin/pack-erp-core`: a real Manifest
with 4 entities (Account, Contact, Invoice, InvoiceLine all
on the `auditable` trait), 3 relations (Account→Contacts
cascade, Invoice→Account restrict, Invoice→Lines cascade),
3 roles (erp_admin / erp_accountant / erp_viewer), per-entity
permissions including transition grants, an entityLifecycle
workflow for Invoice (draft → sent → paid|overdue|void with
a 30-day SLA), 2 jobs (scheduled overdue-invoice-reminder +
event-driven payment-received-handler), 2 list views. The
`buildErpCorePack(opts)` builder returns the full Manifest;
`tryValidateManifest` passes — every cross-reference resolves,
proving the kernel's abstractions hold up under a real schema.
M5.7 added chat persistence:
`@crossengin/ai-architect-pg` ships
`PostgresArchitectSessionStore` / `…MessageStore` /
`…ToolInvocationStore` / `…ProposalStore` plus a
`PostgresTranscript` orchestrator that implements the
`Transcript` lifecycle interface (`onSessionStart` /
`onMessage` / `onToolInvocation` / `onProposal` /
`onSessionEnd`). The chat engine emits events via this
interface — `NullTranscript` is the default no-op, so
non-persisted runs are unchanged. Four new META_ARCHITECT_*
tables (sessions / messages / tool_invocations / proposals)
with tenant RLS + FK chain. `crossengin chat --persist` reads
PG env vars and writes a full audit trail of who proposed
what, when, and whether it was applied. Operators can join
sessions ⇒ messages ⇒ tool_invocations ⇒ proposals to
reconstruct any developer's authoring history.
M5.8 closed the authoring loop by
adding a write tool with human-in-the-loop approval.
`propose_manifest_edit({path, new_manifest_json})` shows the
developer a diff + entity counts + new hash, prompts y/N (via
a shared `LineReader` that the REPL also uses, so the approval
read doesn't compete with the for-await on stdin), and only
writes the file on approval. `--allow-file-write` gates the
tool; `--auto-approve-writes` skips the prompt (required for
one-shot scripted use). Refactored ChatReplOptions: `stdin:
AsyncIterable<string>` → `lines: LineReader` so the approver
and the REPL share one source. `tools.ts` now ships an
`autoApprover(approve = true)` and `chat.ts` exports
`interactiveApprover({io, reader})`.
M5.6 made `crossengin chat` a real authoring loop
by adding tool dispatch. The CLI exposes
`validate_manifest` / `hash_manifest` / `diff_manifests` /
`summarize_manifest` (plus opt-in `read_file` under
`--allow-file-read`) as tools Claude can invoke mid-turn. The
chat engine assembles tool inputs from streamed
`tool_call_arg_delta` chunks, executes locally via
`executeToolCall`, appends tool-role results to history, runs
continuation turns until the assistant produces terminal text
or hits `DEFAULT_MAX_TOOL_ITERATIONS` (5). To round-trip cleanly
through Anthropic's API, `LlmMessage` in `@crossengin/
ai-providers` gained an optional `toolUses: {id, name, input}[]`
field; `buildAnthropicRequest` in `ai-providers-anthropic`
encodes those as `tool_use` content blocks alongside text on
assistant messages. Pattern extends to OpenAI / Bedrock / Vertex
when M2.8+ ships.
M5.5 wired the Anthropic provider into `architect-cli`'s `chat`
subcommand. `crossengin chat` now actually talks to Claude:
streams tokens as they arrive, reports per-turn + aggregate cost
in USD, supports `--prompt` for one-shot mode + REPL otherwise,
`--model` / `--max-tokens` / `--system` / `--system-file` /
`--tenant-id` / `--session-id` flags, `--format=json` emits the
`CompletionChunk` discriminated union as NDJSON. Tests inject
a stub `LlmProvider` via `RunContext.providerOverride` so CI
runs offline. Default system prompt primes Claude as the
CrossEngin Architect.
M2.7 added `@crossengin/ai-providers-anthropic` — a real
Anthropic Messages API client implementing the `LlmProvider`
interface from `@crossengin/ai-providers`. Zero runtime deps —
pure `fetch` + `ReadableStream`. 5 modules (pricing for the
five Claude 4.x models with per-token + per-cache-tier rates,
messages-api request builder + response normalizer, SSE
streaming parser with shared state across read boundaries,
typed error classification + retry policy, and the
`AnthropicProvider` class itself with `complete()` streaming +
`completeNonStreaming()` + `anthropic-beta` header support).
The Architect agent now has a real backend to call.
M6 added `@crossengin/workflow-signal-bridge` — verify a webhook
via `sdk/webhook-signing`, extract a correlation key, route
to `workflow-runtime.submitSignal`. Pairs with the gateway as
a registered Handler so every external webhook → workflow
advance flows through one place. The four runtime pillars
(DDL execution + cryptography + workflow execution + HTTP
gateway) are in place; both impure runtime pillars (workflows +
gateway) now have production-shape Postgres adapters; M5 added
the first app under `apps/` — `@crossengin/architect-cli` ships
the `crossengin` binary with `init`, `validate`, `diff`, `patch`,
`hash`, `apply`, `chat` (stubbed for M5.5), `version`, `help`.
The end-to-end story works today: `crossengin init m.json &&
crossengin validate m.json && crossengin apply --dry-run`
produces a 3,061-line SQL dump of the full meta-schema. M3.6
added `ProjectingEventLog` + `buildPersistentEngine` to
`@crossengin/workflow-runtime-pg` — wrap a `WorkflowEngine` once
and every event append automatically projects + upserts the
instance / activity / signal / timer rows into their META_
WORKFLOW_* tables. M3.5 added
`@crossengin/workflow-runtime-pg` — PostgresEventLog + four
projection stores (instance / activity / signal / timer) backed
by the existing META_WORKFLOW_* tables, with cached wfi_*/wfd_*
→ UUID resolvers that bridge the runtime's string IDs to the
schema's UUID FKs. M4.5 added `@crossengin/api-gateway-pg` —
Postgres-backed adapters for the gateway runtime's four store
interfaces (IdempotencyStore, RouteRegistry, RateLimitChecker,
PipelineExecutionStore) backed by the existing META_GATEWAY_* +
META_RATE_LIMIT_DECISIONS tables via `@crossengin/kernel-pg`.
M4 added `@crossengin/api-gateway-runtime` — the 17-stage
pipeline as real middleware, with EdDSA JWT verification (via
crypto), idempotency-key replay detection, rate-limit denial
with Retry-After, RFC 9457 problem details for every error, and
a queryable PipelineExecution per request. M1
added `@crossengin/kernel-pg` (Postgres-backed migration applier).
M2 added `@crossengin/crypto` (real SHA-256 / BLAKE2b-512 /
HMAC-SHA256 / Ed25519). M2.5 wired crypto into marketplace + sdk
+ forensics + tenant-lifecycle. M2.6 finished M2 wiring into
`access-reviews` (`signDecisionAttestation` for digital + qualified
e-signatures; `sealEvidenceWithBundle` + `verifyEvidenceSeal` for
SOC 2 / ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11 evidence
packs) and `data-lineage` (`sealArticle15Pack` +
`deliverArticle15Pack` + `verifyArticle15PackSeal` for the GDPR
Article 15 evidence pack lifecycle). M3 added `@crossengin/
workflow-runtime` — in-process event-sourced executor consuming
`@crossengin/workflow-engine` contracts; turns workflow
definitions into actually-running instances with append-only
event log, deterministic replay-style projection, registered
activity handlers, signal correlation, timer firing, automatic
transitions, on-entry actions (set_variable / schedule_activity /
schedule_timer), and saga compensation planning.

ADRs 0001-0079 + 0086-0105 are drafted in `docs/adr/`; ADRs 0080-0085
are reserved for Phase 3 P3-P8 (per ADR-0077). ADR-0046 is the
Phase 2 implementation plan (M1 DDL → M2
crypto → M3 workflow runtime → M4 gateway runtime → M5 architect-
cli → M6 notifications + workflow bridge → M7 first vertical pack
→ M8 SLO enforcement); **ADR-0077 is the Phase 3 plan** — the
bridge from running pillars to a deployed multi-vertical product
(P1 `operate-server` serving app → P2 distributed workers → P3
`operate-web` renderer → P4 gov/edu/construction packs → P5
marketplace install → P6 multi-region → P7 AI Architect in prod
→ P8 production hardening + GA; ADRs 0080-0085 lock P3-P8; ADR-0078
covers P1, ADR-0079 covers P1.5 (gateway body parsing + handler
outcome mapping), ADR-0086 covers P1.6 (operate-runtime-pg —
Postgres EntityStore under tenant RLS), ADR-0087 covers P1.7
(apps/operate-server — the runnable serving binary), ADR-0088
covers P1.8 (list pagination + filtering from the ListView),
ADR-0089 covers P1.9 (edge/Workers fetch adapter), ADR-0090 covers
P1.10 (column-mapped entity store — typed per-entity tables),
ADR-0091 covers P1.11 (transparent at-rest encryption in the
column-mapped store), ADR-0092 covers P1.12 (foreign keys +
topological apply order in the column store), ADR-0093 covers P1.13
(per-relation delete semantics in the column store), ADR-0094
covers P1.14 (many_to_many join tables in the column store),
ADR-0095 covers P1.15 (association link/unlink API over join
tables), ADR-0096 covers P1.16 (keyset pagination + typed filter
operators), ADR-0097 covers P1.17 (production JWT/JWKS identity in
operate-server), ADR-0098 covers P1.18 (JWT/tenant cross-check in the gateway), ADR-0099 covers P1.19 (remote JWKS provider with caching + rotation), ADR-0100 covers P1.20 (background JWKS refresh poller), ADR-0101 covers P1.21 (field selection / projection on list + read), ADR-0102 covers P1.22 (SQL-level projection pushdown in the column store); ADR-0103 covers P2 (workflow-worker — the distributed tick worker), ADR-0104 covers P2.1 (per-unit timer claim + fireTimer for parallel workers), ADR-0105 covers P2.2 (activity retry executor — retryActivity + claim), ADR-0106 covers P2.3 (apps/workflow-worker — the runnable distributed worker binary), ADR-0107 covers P2.4 (activity retry backoff — next_retry_at population), ADR-0108 covers P2.5 (instance timeout sweeper — timeoutInstance + claim), ADR-0109 covers P2.6 (real-Postgres worker integration test + projection NOT NULL fixes), ADR-0110 covers P2.7 (worker observability — heartbeats + per-run outcomes), ADR-0111 covers P2.8 (async activity queue — decouple schedule from execute), ADR-0112 covers P2.9 (definition-level activity execution-mode default), ADR-0113 covers P2.10 (activity-level timeout sweeper — timeoutActivity + claim), ADR-0114 covers P2.11 (stale-worker detection over the heartbeat table), ADR-0115 covers P2.12 (lease-reaper — proactively clear expired worker leases), ADR-0116 covers P2.13 (stale-worker → incident bridge in apps/workflow-worker), ADR-0117 covers P1.23 (operate-server real-Postgres integration test), ADR-0118 covers P2.14 (projection drift-sweep worker mode), ADR-0119 covers P1.24 (ColumnMappedEntityStore real-Postgres integration test), ADR-0120 covers P1.25 (column-store m2m link + FK ON DELETE integration test), ADR-0121 covers P2.15 (live stale-worker monitor in the worker binary), ADR-0122 covers P1.26 (column-store set_null + non-bypassing-role RLS integration test), ADR-0123 covers P2.16 (stale-worker incident persistence sink), ADR-0124 covers P2.17 (worker incident lifecycle — open/resolve dedup), ADR-0125 covers P1.27 (column-store NUMERIC read fidelity), ADR-0126 covers P1.28 (column-store DATE / TIMESTAMPTZ read fidelity), ADR-0127 covers P2.18 (stale-worker incident severity escalation), ADR-0128 covers P2.19 (stale-worker incident timeline entries), ADR-0129 covers P2.20 (stale-worker re-page on escalation), ADR-0130 covers P2.21 (incident replayer — typed read API over meta.incidents), ADR-0131 covers P2.22 (incidents CLI subcommand on workflow-worker), ADR-0132 covers P2.23 (incident metrics — MTTR + open gauges from the timeline), ADR-0133 covers P2.24 (incident ack/mitigate milestones — MTTA + MTTM), ADR-0134 covers P2.25 (incidents ack/mitigate write CLI commands), ADR-0135 covers P2.26 (incident timeline drift CI gate), ADR-0136 covers P2.27 (PHI at-rest encryption CI gate), ADR-0137 covers P2.28 (webhook page transport), ADR-0138 covers P2.29 (page-delivery comms_sent timeline audit), ADR-0139 covers P2.30 (MTTP time-to-page metric), ADR-0140 covers P2.31 (incident-response-pg package extraction), ADR-0141 covers P2.32 (operate-server SLO incidents via incident-response-pg)).
ADR-0047 covers M1, ADR-0048 covers M2,
ADR-0049 covers M3, ADR-0050 covers M4, ADR-0051 covers M5,
ADR-0052 covers M6, ADR-0053 covers M2.7 (Anthropic provider),
ADR-0054 covers M5.5 (architect-cli chat mode), ADR-0055 covers
M5.6 (tool-driven chat), ADR-0056 covers M5.8 (write tools with
human-in-the-loop approval), ADR-0057 covers M5.7 (chat
persistence to META_ARCHITECT_*), ADR-0058 covers M7
(`pack-erp-core` — first vertical pack), ADR-0059 covers M6.5
(`ai-router` — provider router with retry / cost / latency),
ADR-0060 covers M8 (`observability-runtime` — SLO enforcement
loop), ADR-0061 covers M8.5 (`observability-runtime-pg` — SLO
enforcement persistence), ADR-0062 covers M8.6 (latency-target
SLO enforcement in `observability-runtime`), ADR-0063 covers
M8.7 (latency enforcement persistence in
`observability-runtime-pg`), ADR-0064 covers M2.8
(`ai-providers-openai` — second real LlmProvider), ADR-0065
covers M7.5 (`pack-erp-healthcare` — second vertical pack via
`meta.extends`), ADR-0066 covers M7.6 (field-level data
classification in `types` + `kernel`), ADR-0067 covers M7.7
(acting on the classification — auth default redaction + DDL
encryption hints), ADR-0068 covers M7.7.5 (gateway response
redaction by classification), ADR-0069 covers M7.7.6
(manifest-derived redaction registry), ADR-0070 covers M7.8
(at-rest encryption mechanism + pgcrypto coverage applier),
ADR-0071 covers M7.8.5 (encrypt-on-write migration), ADR-0072
covers M2.8.5 (multi-vendor router in architect-cli chat),
ADR-0073 covers M2.8.6 (per-turn provider + cost attribution in
chat), ADR-0074 covers M7.8.6 (`crossengin-pg encrypt` CLI), ADR-0075
covers M7.9 (`pack-erp-retail` — third vertical pack), ADR-0076
covers M7.9.1 (`pack-erp-grocery` — transitive pack lineage).

## Architecture in 90 seconds

- **`zod` schemas are the source of truth.** Types derive via
  `z.infer`. Every package exports `XSchema` + `type X` pairs.
- **Pure contracts + deterministic helpers only.** A package
  defines record shapes, state machines, and pure functions
  (validators, predicates, comparators). It does not open
  sockets, hit databases, or shell out.
- **Kernel meta-schema is the integration point.** Every package
  that needs persisted records wires `META_*` table definitions
  into `packages/kernel/src/bootstrap/meta-schema.ts`. The kernel
  emits DDL deterministically from those.
- **Tenant isolation by RLS.** Tenant-scoped tables enable PG
  row-level security with `tenant_id = current_setting(
  'app.current_tenant_id', true)::UUID`. Platform-wide tables
  skip RLS. Both are tested by the meta-schema test suite.
- **Strict TypeScript.** No `any`. No `--no-verify`. Use explicit
  return types for exported functions when inference is murky.

## Package map

Grouped by concern. Each is `packages/<name>` with `src/index.ts`
re-exporting everything.

### Substrate (the kernel itself)
- **`kernel`** — meta-schema (113 tables), DDL emit, manifest
  validate/diff/patch/topology/hash, bootstrap SQL generator.
- **`kernel-pg`** — Postgres-backed migration applier (first
  impure package). 9 modules: connection (PgConnection interface
  + `parsePgEnvConfig` + node-postgres binding), statement-hash
  (sha256 of normalized SQL), migration-log (`_meta_migrations`
  bookkeeping), preconditions (`pg_uuidv7` extension + PG ≥ 14 +
  CREATE privilege checks), applier (advisory-lock-gated, per-
  statement transactions, halt-on-first-failure, hash-based
  skip), introspection (pg_catalog queries + pure parsers), diff
  (pure `diffSchema` vs `META_TABLES`), encryption (the M7.7
  `encrypt=at_rest` hint applier: `parseColumnDirectives`,
  `introspectEncryptedColumns` via `col_description`,
  `ensurePgcryptoExtension`, `pgpSymEncrypt/DecryptExpr` builders,
  `summarizeEncryptionCoverage` → `plaintext_at_rest` /
  `pgcrypto_missing` drift, `EncryptionApplier`),
  encryption-migration (the M7.8.5 encrypt-on-write path:
  `emitEncryptColumnSql` rewrites a plaintext column to encrypted
  `BYTEA` in place, `emitDecryptingViewSql` builds a
  `pgp_sym_decrypt` read view, `EncryptionMigrator.migrateSchema`
  plans plaintext-only + runs per-column transactions). Ships
  `crossengin-pg` CLI with `apply`, `apply --dry-run`, `drift`,
  `inspect`, `encrypt --verify|--plan|--apply`, `version` commands.
- **`workflow-runtime-pg`** — Postgres-backed adapters for the
  workflow runtime. 9 modules: id-mapping
  (WorkflowInstanceIdResolver + WorkflowDefinitionIdResolver,
  cached wfi_*/wfd_* → UUID lookups against workflow_instances /
  workflow_definitions), event-log (PostgresEventLog implements
  EventLog over META_WORKFLOW_EVENTS, parses JSONB or text
  payloads, computes latestSequence via MAX(sequence_number)),
  instance-store (PostgresInstanceStore.create INSERTs
  workflow_instances + caches the UUID; upsertProjection
  UPDATEs all status / variables / awaiting* fields by
  instance_id), activity-store (UPSERT into workflow_activities
  via ON CONFLICT (activity_id) DO UPDATE), signal-store (UPSERT
  workflow_signals with COALESCE-preserving instance_id),
  timer-store (UPSERT workflow_timers with status/firedAt/
  cancelledAt), projecting-event-log (ProjectingEventLog wraps
  any EventLog + auto-runs the four projection writers after
  each append; creates the workflow_instances row on
  instance_started so the FK is satisfied; re-projects + upserts
  the instance / activities / signals / timers on every
  subsequent event), persistent-engine (buildPersistentEngine
  one-call factory: pass a PgConnection + definitions map, get
  back {engine, eventLog, stores} where the engine is wired to
  the projecting log so all engine ops persist automatically),
  replayer (WorkflowReplayer.resyncInstance re-projects from the
  event log + upserts all projection tables to fix drift;
  verifyInstance returns a per-field DriftReport comparing
  expected projection vs stored rows; bulkResync iterates with
  pagination + maxInstances cap for periodic CI / observability
  guards).
- **`workflow-worker`** — Phase 3 P2 + P2.1 + P2.2 + P2.5 + P2.7 +
  P2.8 + P2.10 + P2.11 + P2.12 + P2.14: the distributed worker. 16 modules: lock-key (advisoryLockKey(namespace) → a stable signed
  64-bit pg advisory-lock key from sha256), worker (WorkflowWorker.
  tickOnce runs engine.tickTimers(now) inside conn.withAdvisoryLock
  so N worker processes serialize on one lock — only one ticks at a
  time, the engine's scheduled-only firing prevents double-fires, PG
  releases the lock on session death → failover; start(ms)/stop()
  poll an injectable unref'd interval with onError + a status()
  snapshot; the engine is a structural TimerTickEngine, wrapping a
  buildPersistentEngine engine), claim-store (P2.1:
  PostgresTimerClaimStore.claimDueTimers atomically claims due
  scheduled timers via FOR UPDATE SKIP LOCKED + a claimed_by/
  lease_expires_at lease, returning timer id + instance wfi_ ref;
  releaseTimer clears a lease — over the new workflow_timers lease
  columns), claiming-worker (ClaimingTimerWorker.runOnce claims a
  batch + fires each via engine.fireTimer, releasing the lease on any
  that didn't fire — N of these drain timers in parallel, no global
  lock since SKIP LOCKED partitions), activity-claim-store (P2.2:
  PostgresActivityRetryClaimStore.claimDueRetries claims
  failed/timed-out, not-exhausted, backoff-elapsed activities via FOR
  UPDATE SKIP LOCKED + lease), retry-worker (RetryExecutorWorker.
  runOnce claims a batch + re-runs each via engine.retryActivity,
  releasing the lease in a finally), instance-timeout-claim-store
  (P2.5: PostgresInstanceTimeoutClaimStore.claimTimedOutInstances
  claims non-terminal, past-deadline (timeout_at <= now), unleased
  instances via FOR UPDATE SKIP LOCKED + lease — over the new
  workflow_instances lease columns), timeout-worker
  (TimeoutSweeperWorker.runOnce claims a batch + fails each via
  engine.timeoutInstance, releasing the lease in a finally),
  activity-execute-claim-store + execute-worker (P2.8 async activity
  queue: PostgresActivityExecuteClaimStore.claimScheduledActivities
  claims status='scheduled' AND execution_mode='async' via FOR UPDATE
  SKIP LOCKED + lease; ActivityExecutorWorker.runOnce claims a batch +
  runs each via engine.executeActivity — the first attempt of an async
  activity the engine left pending), activity-timeout-claim-store +
  activity-timeout-worker (P2.10:
  PostgresActivityTimeoutClaimStore.claimTimedOutActivities claims
  non-settled (status IN scheduled/running), past-deadline (timeout_at
  <= now) activities via FOR UPDATE SKIP LOCKED + lease;
  ActivityTimeoutSweeperWorker.runOnce claims a batch + times out each
  via engine.timeoutActivity — catches async activities no executor ran
  in time + in-flight activities orphaned by a dead worker), heartbeat
  (P2.7: every worker emits a normalized RunOutcome {claimed,
  processed} via onRun; the pure WorkerHeartbeat accumulator folds
  runs + errors into cumulative counters; PostgresWorkerHeartbeatStore
  upserts a snapshot to meta.worker_heartbeats on worker_id;
  HeartbeatReporter exposes onRun/onError + flushes on an injectable
  unref'd interval, status starting→running→stopped;
  PostgresWorkerHeartbeatStore.listAll/listStale read the table back),
  worker-health (P2.11: pure classifyWorkerHealth +
  summarizeWorkerHealth → a WorkerHealthReport with StaleWorkerAlert[]
  + formatWorkerHealth — flag running workers that stopped beating),
  lease-reaper (P2.12: PostgresLeaseReaper.reapExpired clears expired
  leases across timers/activities/instances; LeaseReaperWorker polls it
  — reclaims a crashed worker's rows proactively), drift-sweeper
  (P2.14: a structural DriftResyncer [satisfied by WorkflowReplayer] +
  DriftSweepWorker periodically re-projects a bounded batch from the
  event log + re-upserts — self-heals projection drift; opt-in
  --mode resync, not in all). The
  engine's per-unit primitives WorkflowEngine.fireTimer +
  retryActivity + timeoutInstance + executeActivity + timeoutActivity
  (all idempotent / settled-guarded) live in workflow-runtime. Lease columns + indexes on
  workflow_timers + workflow_activities + workflow_instances; P2.7
  adds the platform-wide meta.worker_heartbeats table. P2.4 populated
  the retry backoff (ADR-0107): the engine
  stamps next_retry_at on each activity failure (via the shared
  workflow-engine computeNextRetryAt / retryDelaySeconds), so the
  retry claim store's next_retry_at gate sees real due times. P2.5
  (ADR-0108) added the instance timeout sweeper, completing the
  time-based-progression trio (timers · retries · timeouts); P2.7
  (ADR-0110) added worker observability (heartbeats); P2.8 (ADR-0111)
  added the async activity queue (executeActivity + execution_mode +
  ActivityExecutorWorker), completing the P2 worker arc.
- **`api-gateway-pg`** — Postgres-backed adapters for the four
  gateway runtime store interfaces + a replayer. 5 modules:
  idempotency-store (INSERT … ON CONFLICT DO UPDATE on tenant+
  operation+key, TTL-based deleteExpired), route-registry
  (cache-backed lookup + listVersionsFor with configurable TTL,
  upsert that invalidates the cache), rate-limit-checker
  (per-(tenant, principal, operation) sliding-window counter;
  writes META_RATE_LIMIT_DECISIONS with allowed /
  denied_rate_limit_exceeded outcomes), pipeline-execution-store
  (INSERT … ON CONFLICT DO NOTHING for the M4 PipelineExecution,
  plus countSince audit query), replayer
  (verifyPipelineExecutionShape pure validator flagging
  stages-out-of-order, stage-repeated, final-stage/outcome
  mismatch, pass-with-4xx-or-5xx, duration-inconsistent,
  terminating-not-last; GatewayReplayer.verifyExecution adds the
  rate_limit_decision_not_found check by joining against
  META_RATE_LIMIT_DECISIONS; listRecentExecutions /
  bulkVerify paginate over META_GATEWAY_PIPELINE_EXECUTIONS;
  summarize computes pass/deny/error counts + p50/p95 latency).
  P2.42 (ADR-0151) added verify-runner (the framework-neutral
  runVerifyExecutions over a structural ExecutionVerifySource
  [GatewayReplayer satisfies it] — bulkVerify sweep, exit 1 on any
  drifted execution; parseExecutionsArgs + summarizeExecutionReports
  + formatExecutionVerifyReport) + a bin/crossengin-gateway-pg.ts
  (executions verify|summary — opens a conn, runs the sweep, exits the
  code) so CI can gate gateway request-audit integrity. NOTE: the gated
  operate-server path doesn't yet persist its PipelineExecutions
  (GatewayRuntime returns the execution on HandleResult; dispatch
  discards it — no execution store wired into buildOperateGateway), so
  the gate verifies an empty table (exit 0) today and becomes
  non-vacuous the moment a PostgresPipelineExecutionStore is wired into
  the serving path.
- **`api-gateway-runtime`** — HTTP gateway middleware
  (fourth impure package). 9 modules: redaction
  (ResponseRedactionSpec + RedactionRegistry/MapRedactionRegistry
  + computeRedactedFields fail-closed scope→role bridge +
  redactJsonValue tree-walk; `transform_response` strips
  classified fields per-caller when a redactionRegistry is set);
  manifest-redaction (redactionRegistryFromManifest builds the
  registry from a manifest's classified fields + permissions +
  roles, no kernel dep); adapters (RequestAdapter +
  ResponseAdapter for Node HTTP + edge runtimes,
  buildIncomingRequest helper → a RuntimeIncomingRequest carrying
  rawBody for parse_request to decode), stores (PrincipalResolver +
  IdempotencyStore + RateLimitChecker + RouteRegistry interfaces
  + in-memory implementations), auth (EdDSA JWT verify with iss/
  aud/exp/nbf checks via @crossengin/crypto, opaque token matcher
  with constant-time compare, parseAuthHeader for Bearer/Basic/
  x-api-key; P1.18 resolvePrincipalForCredential takes the
  credential's authenticatedTenantId — authoritative over the
  spoofable x-tenant-id header, a contradiction → tenant_mismatch
  401), problems (RFC 9457 envelope builders for the 14
  declared problem types — authenticationRequired with WWW-
  Authenticate, tooManyRequests with Retry-After, sunsetEndpoint
  with Sunset header), dispatcher (HandlerRegistry mapping
  operationId → handler, handlerOutputToResponse converting
  json/empty/bytes outputs), pipeline-runner (PipelineRecorder
  enforcing stage-order monotonicity, building schema-valid
  PipelineExecution), runtime (GatewayRuntime.handleRequest walks
  the 17 stages: receive → parse_request → validate_tls →
  parse_auth → authenticate → resolve_principal → match_route →
  negotiate_version → negotiate_content → check_idempotency →
  check_rate_limit → validate_signature → validate_schema →
  dispatch_handler → transform_response → apply_security_headers
  → emit_audit; halts on terminating outcomes; merges
  DEFAULT_SECURITY_HEADERS on pass). P1.5 (ADR-0079): parse_request
  decodes a JSON body by content-type into ctx.parsedBody (raw bytes
  from the RuntimeIncomingRequest, never persisted), and
  dispatch_handler maps a handler 4xx→deny (handler-error problem
  URI) / 5xx→error and halts, so domain errors no longer trip the
  "pass cannot be 4xx" PipelineExecution invariant.
- **`operate-runtime`** — Phase 3 P1 serving keystone: composes a
  resolved manifest into a live multi-tenant API. 6 modules: slugs
  (camelCase operationIds + kebab-plural paths + rt_ route ids),
  store (EntityStore interface — list/listPage/get/create/update/
  remove + InMemoryEntityStore; ListQuery/ListPage; P1.16: typed
  ListFilter (op eq|ne|gt|gte|lt|lte|in) + keyset encodeKeyset/
  decodeKeyset over {k: sortValues, id} + matchesFilter + pure
  applyListQuery filter→sort→keyset-seek),
  list-query (P1.8: listConfigForEntity reads an entity's ListView →
  ListConfig (pageSize/default sort/sortable+filterable columns);
  parseListQuery → a resolved ListQuery, fail-safe — unknown/non-
  filterable params ignored; P1.16 parses ?field[op]=v + ?field[in]
  =a,b,c; P1.21 parseFields → ?fields projection + projectRecord;
  P1.21 ListQuery.fields hint + P1.22 column-store SQL pushdown),
  operations (manifestRouteSpecs →
  a RouteSpec per entity op: 5 CRUD + one per entityLifecycle
  transition; the list spec carries its ListConfig; routeFromSpec →
  schema-valid RouteDefinition), handlers (buildSpecHandler:
  rbacCheck-enforced CRUD + transition over the store, returns the
  full record — redaction at the edge; list paginates via
  listPage → {data, page:{limit, nextCursor}}), compile
  (compileOperateServer → routes + handlers +
  redactionRegistryFromManifest; buildOperateGateway → a wired
  GatewayRuntime). Serves the retail pack end-to-end with per-caller
  redaction + lifecycle + paginated lists, each request emitting a
  PipelineExecution.
- **`operate-runtime-pg`** — Phase 3 P1.6 + P1.10: Postgres
  `EntityStore` bindings for the serving runtime (JSONB + column-
  mapped). 6 modules: records (EntityRecordRow
  zod schema + DocumentRow read projection + generateRecordId
  (`rec_` shape, parity with the in-memory store) + resolveRecordId +
  pure mergeRecord + rowToRecord), tenant-context
  (withTenantContext runs fn inside a transaction after
  `SELECT set_config('app.current_tenant_id', $1, true)` — tenant id
  bound, never interpolated; rejects a malformed tenant id before
  opening the tx), entity-store (PostgresEntityStore implements
  EntityStore over `meta.operate_entity_records`, a tenant-scoped
  JSONB document table under RLS: list/listPage/get/create/update
  (SELECT … FOR UPDATE then merge)/remove each wrapped in
  withTenantContext, plus an admin count; listPage pushes the query
  into SQL via the shared list-sql builder (P1.16) — `document ->>
  'field'` filters/sort (text compares), keyset seek, LIMIT limit+1;
  field names identifier-validated (only values bound); validated
  schema name is the only interpolated identifier). list-sql
  (P1.16: buildListSql over a ListSqlAdapter — one filter + keyset-
  seek + order builder for both PG stores; typed operators, in →
  ANY($n::text[]), OR-of-AND seek for mixed sort directions). Drops
  into buildOperateGateway
  unchanged. One new META table (operate_entity_records). P1.10 adds
  the typed sibling — column-plan (columnPlanForEntity maps each
  manifest field → a typed column via kernel fieldTypeToPostgresType
  + columnNameForField, carrying classification + encryptAtRest +
  referenceTarget; P1.12 adds topologicalEntityOrder +
  referencedEntities over the reference graph), entity-ddl
  (emitEntityTableDdl → idempotent
  CREATE TABLE IF NOT EXISTS with (tenant_id, TEXT id) PK + RLS via
  DROP/CREATE POLICY + crossengin.data_class=…[; encrypt=at_rest]
  comments; a phi/regulated column is emitted as BYTEA; P1.12
  emitForeignKeyDdl → composite (tenant_id, <ref>_id) → target
  (tenant_id, id) FK, idempotent; P1.13 onDeleteClause +
  relationDeleteIndex drive ON DELETE restrict|cascade|set_null per
  many_to_one relation, set_null via the column-list form so
  tenant_id is never nulled; P1.14 emitJoinTableDdl provisions a
  many_to_many link table — (tenant_id, <left>_id, <right>_id) PK +
  RLS + composite ON DELETE CASCADE FKs to both sides), column-store
  (ColumnMappedEntityStore implements EntityStore over real per-
  entity tables: ensureSchema applies the DDL in phases (all tables
  in topological order, then all FKs — cycle-safe, then m2m join
  tables) (+ CREATE EXTENSION pgcrypto when encrypted columns
  exist), CRUD maps record↔
  column, listPage (via list-sql) sorts on the native column type +
  filters with typed comparisons (`"col" <op> $n::sqlType`, `in` →
  `"col"::text = ANY($n::text[])`) + keyset seek; fields absent from
  the plan are dropped; P1.22 pushes ?fields into the SELECT (only
  id + requested + sort columns, so unselected/encrypted columns
  aren't fetched); P1.27/P1.28 (ADR-0125/0126) coerce a NUMERIC column
  back to a JS number and a DATE/TIMESTAMPTZ column — returned as a Date
  by node-postgres — back to a YYYY-MM-DD / ISO string on read, so
  decimal/date/datetime fields round-trip with the same type as the
  in-memory/JSONB stores).
  P1.11: transparent at-rest encryption — a phi/regulated column is
  pgp_sym_encrypt($n::text, keyRef) on write + pgp_sym_decrypt("col",
  keyRef) AS "col" on read (key by SQL reference, default
  current_setting('app.column_encryption_key'), never inlined);
  encrypted columns excluded from sort/filter. P1.15: link/unlink/
  isLinked/listLinks manage m2m association rows over the join
  tables (INSERT … ON CONFLICT DO NOTHING idempotent; keyed by
  (left, right) entities; withTenantContext). TEXT id keeps cross-
  store record parity; `operate-server --store pg-columns` provisions
  + serves from the typed tables (PHI ciphertext at rest, plaintext
  to authorized callers).
- **`apps/operate-server`** — Phase 3 P1.7 + P1.9: the runnable
  serving binary (second app under `apps/`, after `architect-cli`)
  + an edge/Workers fetch adapter. 7
  modules: http (RawHttpRequest/RawHttpResponse + parseMethod +
  splitTarget + rawToIncoming → a gateway IncomingRequest),
  principals (parseApiKeySpec key:role:tenant + buildPrincipalWiring
  → OpaqueTokenLookup + scheme-aware PrincipalResolver + scope→role
  bridge, fail-closed; P1.17: principalFromJwtClaims + subjectToUuid
  + buildJwksProvider resolve a verified Bearer JWT statelessly from
  its claims), jwks (P1.19: RemoteJwksProvider — caches an IdP's
  JWKS endpoint, refetches on stale/unknown-kid rotation, resilient
  on fetch failure; parseJwksDocument + base64UrlToBase64; P1.20:
  JwksRefreshPoller proactively refreshes on an interval, injectable
  unref'd timer, stop() on shutdown), manifest-source
  (loadBuiltinPack resolves a
  vertical pack's meta.extends lineage against a registry of all
  packs; loadManifestFromJson parses+validates a pre-resolved doc),
  server (OperateHttpServer.dispatch maps raw → handleRequest →
  RawHttpResponse, unknown method → 405; buildOperateHttpServer
  composes manifest+store+keys), cli (parseServeArgs: --pack/
  --manifest exactly one, --port, --store memory|pg, --schema,
  --scheme, repeatable --api-key, --help/--version), node (thin
  Node http binding: createNodeRequestListener reads the body +
  dispatches + writes, throw → 500 problem doc; serve() loads the
  manifest, builds the store, listens, returns a close handle),
  edge (P1.9: fetchToRaw(Request) → RawHttpRequest+body +
  rawToFetchResponse → a real Response + createFetchHandler/
  buildEdgeFetchHandler + asModuleWorker {fetch} shape — the
  Fetch/Workers adapter over the same dispatch core, tested
  against genuine new Request/Response undici globals).
  `operate-server` bin. A real loopback test boots it for a 200;
  all other logic is offline-tested. P1.23 (ADR-0117) added a gated
  real-Postgres integration test (CROSSENGIN_PG_TEST=1) driving HTTP →
  gateway → PostgresEntityStore → PG over the retail pack: CRUD
  persistence, tenant isolation (WHERE tenant_id + withTenantContext),
  per-caller redaction, RBAC, and keyset pagination end-to-end. P1.24
  (ADR-0119) added a column-store integration pass: ensureSchema
  provisions typed per-entity tables (NUMERIC unit_price), column-native
  filter + keyset sort, and transparent at-rest encryption (a phi
  Patient.mrn is pgp_sym_encrypt'd to BYTEA, decrypted on read). P1.25
  (ADR-0120) extended it with the m2m association link API
  (link/unlink/isLinked/listLinks over a real join table + ON DELETE
  CASCADE) and a many_to_one ON DELETE RESTRICT FK; P1.26 (ADR-0122)
  added ON DELETE SET NULL (nulls the ref column, keeps tenant_id) and
  the RLS-policy proof under a NOBYPASSRLS non-owner role (a raw SELECT
  with no WHERE tenant_id sees only the app.current_tenant_id tenant).
  An ops guide (README.md) documents the stores (memory/pg/pg-columns),
  auth (API key + JWT/JWKS), redaction/RBAC/pagination, the edge
  adapter, and a deployment recipe. P2.32 (ADR-0141) added slo-incidents.ts
  — the second consumer of `@crossengin/incident-response-pg`:
  buildServingSloEngine (one availability SLO over the serving surface) +
  OperateSloMonitor (recordRequest feeds the M8 burn-rate engine; sweep
  persists each breach_opened incident via the shared PostgresIncidentSink,
  resolves on recovered). The Node listener gained an onRequest hook;
  serve() wires it under --slo (+ --slo-persist / --slo-actor /
  --slo-interval-ms). A gated test declares + persists a serving-availability
  incident and reads it back via the shared PostgresIncidentReplayer. P2.33
  (ADR-0142) completed the SLO persistence story: buildServingSloEngine takes
  an optional PgConnection and, when set, wraps the engine via
  buildPersistentSloEnforcementEngine (from `@crossengin/observability-runtime-pg`)
  so every `recordOutcome→evaluate` cycle also writes an enforcement action
  to meta.slo_enforcement_actions per decision and an evaluation snapshot to
  meta.slo_evaluations per breach_opened (M8.5). P2.37 (ADR-0146) refined the
  single aggregate SLO into **one availability SLO per (method, operationId)**:
  `routesForManifest(manifest)` derives the route shape from `manifestRouteSpecs`
  (one entry per CRUD verb + per `entityLifecycle` transition),
  `buildServingSloEngineForManifest` constructs the engine with N registrations
  (`<method>-<surface>-availability` id, default 99% / 30d, accepts the same
  `conn` for persistence), and `OperateHttpServer.dispatchWithMatch` returns the
  matched operationId so the Node listener threads the per-request surface into
  `OperateSloMonitor.recordRequest(status, latencyMs, surface?)`. A 5xx burst on
  `POST /v1/orders` declares its own incident on `POST-salesOrder.create-
  availability`, leaving a parallel healthy `GET /v1/products` stream out of
  the burn; `serve()` builds the per-manifest engine under `--slo` (and threads
  the incident-sink conn into it under `--slo-persist` so the full audit trail —
  incident + enforcement actions + breach snapshots — is durable under one flag).
- **`apps/workflow-worker`** — Phase 3 P2.3: the runnable
  distributed-worker binary (third app under `apps/`, after
  `architect-cli` + `operate-server`). 4 src modules + a bin: cli
  (parseWorkerArgs: --mode tick|claim|retry|all [default all = the
  parallel claim + retry combo], random --worker-id, --schema,
  per-loop --tick/claim/retry-interval-ms, --batch-size, --lease-ms,
  --definitions <file>; --timeout-interval-ms; space + inline forms;
  CliUsageError on misuse), runner (buildWorkerSet — the
  framework-neutral core: for the selected mode it constructs the
  worker(s) over one PgConnection + one structural WorkerEngine
  [TimerTickEngine & FireTimerEngine & RetryActivityEngine &
  TimeoutInstanceEngine & ExecuteActivityEngine, all satisfied by
  buildPersistentEngine's engine] — tick→WorkflowWorker,
  claim→ClaimingTimerWorker over PostgresTimerClaimStore,
  retry→RetryExecutorWorker over PostgresActivityRetryClaimStore,
  timeout→TimeoutSweeperWorker (instances) + ActivityTimeoutSweeperWorker
  (activities) over their claim stores,
  execute→ActivityExecutorWorker over PostgresActivityExecuteClaimStore,
  reap→LeaseReaperWorker, resync→DriftSweepWorker over a WorkflowReplayer
  (opt-in), all→claim+retry+timeout+activity-timeout+execute+reap; each
  polls its own interval; scheduler + onError injectable so the wiring
  is fake-tested with no DB), node (run opens
  createNodePgConnection(parsePgEnvConfig()), loads the --definitions
  JSON via the pure parseDefinitionsJson [WorkflowDefinitionSchema-
  validated, keyed by id], builds the persistent engine so every
  fire/retry projects through the event log, starts the set, and —
  unless --no-heartbeat — wires a HeartbeatReporter (P2.7) over
  PostgresWorkerHeartbeatStore into each worker's onRun/onError,
  flushing meta.worker_heartbeats every --heartbeat-interval-ms
  (default 15000, hostname from node:os); returns a close() that stops
  the workers + the reporter (final stopped flush) + closes the conn),
  bin (parse →
  run → print the running labels; holds the loop open with a
  referenced keep-alive cleared on SIGINT/SIGTERM, since the poll
  timers are unref'd). The worker connects with a BYPASSRLS role
  (one worker drains every tenant). P2.13 added stale-worker-monitor
  (the consumer-side bridge: planStaleWorkerEnforcement turns a stale
  WorkerHealthReport into a declared IncidentRecord + PageDirectives
  via observability-runtime's planners; StaleWorkerMonitor polls
  PostgresWorkerHeartbeatStore.listAll → an onIncident sink). P2.15
  wires it live: run() starts the monitor under --monitor, minting
  incident ids via formatIncidentId + logging each declared incident;
  P2.16 added PostgresIncidentSink (--persist-incidents writes the
  IncidentRecord to meta.incidents); P2.17 made the monitor stateful —
  one incident per stale period (no re-declare while ongoing) +
  onResolve / sink.resolve when workers recover; P2.18 (ADR-0127) added
  severity escalation (onEscalate / sink.escalate raises an open
  incident's severity, never lowers); P2.19 (ADR-0128) made
  sink.resolve / escalate append a typed TimelineEntry to the incident's
  JSONB timeline in the same UPDATE (kind resolved / severity_changed,
  actor = --monitor-declared-by) — a self-describing incident audit
  trail. P2.20 (ADR-0129) wired re-paging on escalation: staleWorkerPages
  resolves the alert policy into a PageDirective[] at a given severity
  (shared by declaration + escalation), onEscalate's payload became a
  StaleWorkerEscalation carrying the directives recomputed at the higher
  severity, and page-sink.ts (PageDeliverer / LoggingPageDeliverer /
  deliverPages) is the paging-transport seam run() delivers plan.pages
  through on declaration + the escalation's pages on escalation; P2.28
  (ADR-0137) added WebhookPageDeliverer (POSTs a normalized pagePayload as
  JSON over global fetch / injectable FetchLike to --page-webhook-url —
  PagerDuty/Slack/Opsgenie/any sink; throws on non-2xx). P2.21
  (ADR-0130) added incident-replayer.ts — the read side over
  meta.incidents (PostgresIncidentReplayer listOpen / listForPeriod /
  getByIncidentId + pure verifyTimelineShape / summarizeIncidentIssues /
  bulkVerify), symmetric with the sink. P2.22 (ADR-0131) added
  incidents-cli.ts — the `workflow-worker incidents open|period|verify|
  metrics` operator subcommand (parseIncidentsArgs + runIncidents over a
  structural IncidentQuerySource; executeIncidents wires the conn; verify
  exits 1 on drift for CI; P2.23/ADR-0132 metrics → incident-metrics.ts
  computeIncidentMetrics = MTTR mean/p50/p95/max + open/resolved +
  per-severity gauges + escalation totals over the timeline; P2.24/ADR-0133
  added sink.acknowledge/mitigate — status_changed milestone entries +
  acked_at/mitigated_at — so metrics also report MTTA/MTTM (and P2.29/0138
  comms_sent + P2.30/0139 incidentTimeToPageMs add MTTP); P2.25/ADR-0134
  added the `incidents ack|mitigate <id>` write commands —
  runIncidentWrite over a structural IncidentWriteSink, the sink returns
  rowCount>0 so the CLI reports a real transition vs an idempotent no-op).
  **P2.31 (ADR-0140) extracted the incident sink/replayer/metrics/runner
  into `@crossengin/incident-response-pg`** (see its own entry); the app
  now imports them and keeps only `parseIncidentsArgs`, page-sink,
  stale-worker-monitor, and the node/bin wiring.
  All logic offline-tested. An ops guide (README.md) documents the 8 modes,
  flags, claim/lease model, and the heartbeat → detect → plan → page →
  run → persist → escalate → re-page → resolve flow.
- **`workflow-runtime`** — in-process event-sourced workflow
  executor (third impure package). 7 modules: clock (Clock +
  IdGenerator interfaces, SystemClock + FixedClock,
  RandomIdGenerator + CountingIdGenerator), event-log (append-
  only `EventLog` interface + InMemoryEventLog with monotonic-
  per-instance sequence enforcement), projection (pure
  `projectInstance` / `projectActivities` / `projectSignals` /
  `projectTimers` — definition-aware projection refines status
  to waiting_for_signal/timer/manual based on outgoing transition
  triggers), transitions (pure trigger matching + guard
  evaluation, defaultGuardEvaluator covers always_true /
  variable_equals / variable_predicate with 8 operators /
  role_required), activity-handlers (`ActivityRegistry` with
  specific + per-kind fallback resolution, built-in handlers for
  audit_emit + transformation), engine (`WorkflowEngine.start
  Instance` / `submitSignal` / `tickTimers` / `cancelInstance` /
  `getInstanceState` / `listEvents`; step loop runs automatic
  transitions + on-entry actions until quiescent; signals
  matched by tenant + correlationKey with exactly_once
  idempotency dedup), saga (pure `planCompensation` /
  `listCompensatableActivities` / `hasOutstandingCompensation`
  handling immediate_reverse_order / parallel / manual_review /
  no_compensation strategies).
- **`crypto`** — real cryptography over `node:crypto`. 7 modules:
  algorithms (`HashAlgorithm`/`MacAlgorithm`/`SignatureAlgorithm`
  + `KeyPurpose` allow-list), hashing (SHA-256, BLAKE2b-512, hash
  chain step, content addressing, constant-time compare), hmac
  (HMAC-SHA256 + webhook signing in `t=...,v1=...` format with
  replay-window verify), signing (Ed25519 sign/verify/keypair via
  Node JWK, public key fingerprint), key-handles (opaque
  `KeyHandle` with tenant-scoped `KeyId` and `assertHandleTenant`
  guard), key-store (`KeyStore` interface + `InMemoryKeyStore`
  with rotate + revoke + per-tenant isolation), audit (auto-audit
  for management ops, schema-validated `CryptoAuditRecord`).
- **`types`** — primitive zod types shared across the workspace
  (UUIDs, ISO 8601, slugs, etc.).
- **`config`** — shared TypeScript + lint config base.
- **`testing`** — `vitestPreset` re-export used by every package.

### Identity, security, data
- **`auth`** — RBAC + ABAC + field-level permissions + write
  masks. RoleDefinition, RbacGrant, principals. Classification-
  aware `computeClassifiedFieldRedaction` /
  `validateClassifiedWriteMask` redact / write-block sensitive
  fields (from the manifest `classification`) by default unless a
  `SensitiveFieldPolicy.privilegedRoles` principal reads/writes
  them; explicit per-field grants still win.
- **`sso`** — federated identity: SAML 2.0 + OIDC providers,
  SCIM 2.0 provisioning, claim mappings + JIT policies, session
  lifecycle, login audit.
- **`security`** — data classification, encryption keys, CSP,
  backup policy, incident classification, threat model,
  certifications.
- **`compliance`** — compliance pack architecture (21 CFR 11,
  HIPAA, GDPR, UAE-MoH). Packs contribute clauses to manifests.
- **`residency`** — 8 regions (eu-central/west, us-east/west,
  me-uae, gcc-ksa, apac-sg, ap-south), broad regions,
  residency profiles, routing.
- **`files`** — file lifecycle (upload → scan → available →
  archived), storage tier transitions, OCR, quota, audit.

### AI surface
- **`ai-providers`** — provider router contract, pricing tables,
  fallback policy, latency budgets.
- **`ai-router`** — `DefaultLlmRouter implements LlmRouter` —
  picks a provider per task using `TaskPolicyMap.primary` +
  `fallback[]`, retries transient (`isRetryable()`) failures
  with exponential backoff + jitter, falls back to the next
  provider on exhaustion, enforces per-tenant cost ceilings
  pre-flight via `CostTracker` (InMemoryCostTracker default
  ships rolling per-tenant USD windows; PostgresCostTracker is a
  future M6.6). Buffers chunks per-attempt so retry replays are
  clean. Tracks per-provider p50/p95 latency for observability +
  future latency-based routing. Throws `CostCeilingExceededError`
  / `ProviderResolutionError` / `AllProvidersExhaustedError` —
  all non-retryable, so the router doesn't loop on them. An opt-in
  `onResolved(RouterResolution)` observer reports the provider that
  actually served each `complete()` (with `fallbackDepth`), which
  architect-cli's chat footer turns into a `via <provider>` label.
- **`ai-providers-anthropic`** — real Anthropic Messages API
  client implementing `LlmProvider`. Zero runtime deps (pure
  `fetch` + `ReadableStream`). 5 modules: pricing (5 Claude 4.x
  models with per-token + cached + cache-write rates, USD cost
  rounded to 6 decimals), messages-api (request builder
  flattens system messages + re-attaches tool-role messages as
  `tool_result` blocks under user role; response normalizer
  computes Usage with cost), streaming (SSE parser + async
  generator over ReadableStream; shared StreamState across read
  boundaries so token counters survive multi-chunk fills),
  errors (11 typed kinds + RETRYABLE_KINDS set,
  `classifyHttpStatus` + `fromHttpResponse` + `fromNetworkError`
  with isRetryable() helper), provider
  (`AnthropicProvider.complete()` streaming + `completeNon
  Streaming()` + `embed()` throws invalid_request_error;
  `anthropic-beta` header for prompt caching / tool streaming
  / computer use; `FetchLike` injection for tests).
- **`ai-providers-openai`** — second real `LlmProvider`, binding
  OpenAI's Chat Completions + Embeddings APIs. Zero runtime deps.
  5 modules: pricing (gpt-4.1 / -mini / gpt-4o / -mini / o4-mini
  + text-embedding-3-small/-large; computeUsageCost subtracts
  cached_tokens from the total prompt_tokens before charging),
  chat-api (system messages stay first-class; assistant toolUses
  → tool_calls with stringified arguments; tool → role:tool +
  tool_call_id; jsonMode → response_format; stream →
  stream_options.include_usage; max_completion_tokens),
  streaming (data:/[DONE] SSE; assembles tool_calls by index;
  tool_call_end on finish_reason; shared StreamState across read
  boundaries), errors (OpenAiError + isRetryable +
  classifyHttpStatus; 503→service_unavailable; retryable =
  rate_limit/server/service_unavailable/network/timeout),
  provider (OpenAiProvider implements LlmProvider — complete()
  streaming + real embed() via /v1/embeddings +
  completeNonStreaming; capabilities jsonMode + embedding true;
  Bearer auth + optional org/project; FetchLike injection). The
  first provider with working embeddings; makes the ai-router
  fallback chain genuinely multi-vendor.
- **`ai-architect`** — AI Architect session contract, safety
  policy (refusals, gates, refusal copy, tenant settings, cost
  ceilings, eval gate, incidents, redteam). Plus session-record
  zod schemas (`ArchitectSessionRecord` / `…MessageRecord` /
  `…ToolInvocationRecord` / `…ProposalRecord`) that
  ai-architect-pg materializes into Postgres rows.
- **`ai-architect-pg`** — Postgres-backed transcript adapter for
  chat sessions. 5 modules: session-store + message-store +
  tool-invocation-store + proposal-store (each with append +
  list helpers against META_ARCHITECT_*); transcript
  (PostgresTranscript class threads sessionUUID + tenantId
  through onMessage / onToolInvocation / onProposal / onSession
  End — implements the `Transcript` interface architect-cli's
  chat engine emits into). `crossengin chat --persist` wires
  this in; tests use a fake transcript via ctx.transcriptOverride.

### Runtime + operations
- **`jobs`** — Inngest-style job kinds, idempotency keys, dead
  letters, cost ledger.
- **`observability`** — SLO definitions, error budget compute,
  redaction, synthetics, OTel-style tracing.
- **`observability-runtime`** — the SLO enforcement loop (pure,
  in-process; consumes observability + incident-response +
  feature-flags contracts). 9 modules: clock (Clock/FixedClock +
  parseDurationMs), window (RequestOutcome ingest + RollingWindow
  per-surface counts + failureRate + latencyStats p50/p95/p99 +
  exported percentile), burn-rate (multi-window
  Google-SRE evaluation: DEFAULT_BURN_RATE_THRESHOLDS fast-burn
  1h/5m@14.4×→sev2 + slow-burn 6h/30m@6×→sev3; burnRate =
  failureRate / (1−target); fires only when both windows clear
  the multiplier and the long window has ≥minSamples),
  synthetics (SyntheticTracker + consecutiveFailures +
  evaluateSynthetic against SyntheticCheckDeclaration),
  enforcement (planIncidentDeclaration → schema-valid declared
  IncidentRecord; planPageDirective → AlertRouteResolution;
  planKillSwitchActivation → triggered_active KillSwitch with
  automated_metric_breach trigger; SEVERITY_TO_ALERT_SEVERITY;
  formatIncidentId/formatKillSwitchId; FlagRollbackSchema),
  tracing (RecordedSpan + childContext + TraceCollector that
  stitches gateway→workflow→notifications spans into a tree),
  engine (SloEnforcementEngine: recordOutcome + evaluate →
  breach_opened/breach_ongoing/recovered; one incident per
  ongoing breach; mints cross-linked incident + kill-switch ids),
  latency (parseLatencyBudgetMs + DEFAULT_LATENCY_THRESHOLDS +
  evaluateLatencyTarget — pure percentile-vs-budget breach
  evaluation), latency-engine (LatencySloEngine: same shape as
  the availability engine but for SloLatencyTarget; declares
  `performance` incidents over a short rolling latency window).
  No new META_ tables — emits records typed by existing
  contracts.
- **`observability-runtime-pg`** — Postgres persistence for the
  SLO enforcement loop (availability + latency). 7 modules:
  records (SloEvaluationRecord + SloEnforcementActionRecord +
  SloLatencyEvaluationRecord zod schemas + sloe_/sloa_/slle_ id
  generators + pure projectors evaluationRecordFromVerdict /
  enforcementActionFromDecision (accepts EnforcementDecision |
  LatencyEnforcementDecision + a signal) /
  latencyEvaluationRecordFromVerdict), evaluation-store +
  latency-evaluation-store (PostgresSloEvaluationStore /
  PostgresSloLatencyEvaluationStore: INSERT … ON CONFLICT DO
  NOTHING + countBreachesSince), enforcement-action-store
  (PostgresSloEnforcementActionStore: record + listForIncident +
  listRecent + countSince + row→record mapper; signal-aware),
  persisting-engine + latency-persisting-engine
  (buildPersistentSloEnforcementEngine /
  buildPersistentLatencySloEngine each wrap their engine — every
  evaluate() writes an enforcement action per decision + an
  evaluation snapshot per breach_opened; latency actions tagged
  signal='latency'), replayer (pure verifyEnforcementActionShape +
  verifyEnforcementHistory + summarizeEnforcement +
  SloEnforcementReplayer — signal-agnostic, covers both). Three
  META_ tables: meta.slo_evaluations + meta.slo_enforcement_actions
  (+ signal column) + meta.slo_latency_evaluations
  (platform-or-tenant RLS, append-only, sloe_/sloa_/slle_ ids).
- **`integrations`** — integration call audit, idempotency at the
  integration boundary, HMAC signatures, retry policy.
- **`rate-limiting`** — unified rate-limit + quota contracts. 6
  algorithms (token_bucket, leaky_bucket, fixed/sliding window,
  sliding_log, concurrent_request) × 10 scope kinds × policies
  with 5 overage handling kinds; 10 quota targets × 7 periods × 6
  classes; RFC 9457 problem details + IETF rate-limit headers on
  every denial; 6 exception kinds with per-kind duration caps +
  four-eyes; throttle event audit.
- **`api-gateway`** — per-request edge pipeline composing auth +
  sso + rate-limiting + sdk. 17-stage pipeline (receive → ... →
  emit_audit) with state-machine ordering. 8 auth schemes × 15
  outcomes with clock-skew + audience + issuer + hmac-replay
  validation. Route matching with version negotiation + sunset.
  RFC-9457 problem details with 14 problem types. Idempotency
  with replay detection. Content + encoding + language negotiation.
  CORS + default security headers.
- **`feature-flags`** — 7 flag kinds (boolean, string, number,
  json, multivariate, percentage_rollout, kill_switch). 10
  targeting rule kinds with FNV-1a sticky percentage bucketing.
  9-stage rollout state machine (1pct → 5pct → ... → 100pct or
  rolled_back). 8-trigger kill switches with full separation of
  duties (armer ≠ trigger ≠ co-trigger). 17 evaluation reasons.
  23-kind append-only change audit with four-eyes gate.
- **`workflow-engine`** — runtime contracts for the manifest-level
  workflows declared in kernel: definitions (canonical executable
  form), instances (12 statuses), activities (10 kinds, retry
  policies, saga compensation), signals (3 delivery guarantees),
  timers (4 kinds), compensation plans, append-only event history.

### Reporting / search / UI
- **`reporting`** — reports, dashboards, schedules, ClickHouse
  audit, CDC.
- **`search`** — Typesense-style manifest, query, permission tags,
  embeddings, reindex.
- **`views`** — frontend renderer types (columns, views, theme,
  i18n, permissions, widgets).
- **`i18n`** — locales, ICU MessageFormat, CLDR plurals, bundle,
  resolution, calendar, tenant config.
- **`notifications`** — 6 channels × 18 providers, 5 content
  categories, template + audience + preference/suppression
  contracts, dispatch + delivery audit with retry/throttle/digest
  + quiet-hours decisions.

### Vertical packs
- **`pack-erp-core`** — first vertical pack. Declarative
  `Manifest` with 4 entities (Account, Contact, Invoice,
  InvoiceLine on the `auditable` trait), 3 relations, 3 roles
  (erp_admin / erp_accountant / erp_viewer), per-entity
  permissions + transition grants, an entityLifecycle workflow
  for Invoice (draft → sent → paid|overdue|void with `mark_paid`
  reachable from both sent + overdue; 30-day SLA on sent→paid),
  2 jobs (scheduled cron overdue-invoice-reminder +
  event-triggered payment-received-handler), 2 list views.
  `buildErpCorePack(opts?)` returns the full Manifest; passes
  `tryValidateManifest` end-to-end. Pattern for future
  `pack-erp-healthcare` / `pack-erp-retail` / etc. that extend
  via `meta.extends: ["operate-erp/core"]`.
- **`pack-erp-healthcare`** — second vertical pack; the first to
  use `meta.extends`. Declares `meta.extends: ["operate-erp/
  core"]` and references core entities by name, so it cross-
  validates only after `resolveManifest(pack, {registry})` merges
  core in. 3 entities (Patient → core Account; Encounter →
  Patient + optional core Invoice; Observation → Encounter; all
  auditable, PHI), 4 relations (two cross-pack: Account→Patients,
  Encounter→Invoice), 4 roles (clinical_admin / clinician /
  front_desk / hipaa_auditor) with PHI-restricted Observation
  writes, an Encounter entityLifecycle (scheduled → in_progress →
  completed|cancelled|no_show; same-day SLA), 2 PHI jobs
  (appointment-reminder cron + lab_result_received handler), 2
  views, `compliancePacks: ["hipaa"]`. `buildErpHealthcarePack
  (opts?)` returns the standalone (extends-bearing) Manifest;
  tests resolve it against a core `ManifestRegistry` and pass
  `tryValidateManifest`. Proves the kernel's pack-extension
  mechanism end-to-end.
- **`pack-erp-retail`** — third vertical pack; second `meta.extends`
  consumer. Declares `meta.extends: ["operate-erp/core"]`; resolves
  to 8 entities (4 core + Product / Store / SalesOrder / OrderLine,
  all auditable), 8 relations (cross-pack Account→Stores +
  SalesOrder→Invoice), 4 roles (retail_admin / store_manager /
  cashier / retail_analyst), a SalesOrder entityLifecycle (cart →
  placed → fulfilled → returned), 2 jobs, 2 views,
  `compliancePacks: ["pci"]`. Exercises the classification arc on a
  **non-PHI** domain: `Product.unit_cost` → commercial_sensitive
  (redacted from cashiers via the classification default + an
  explicit `fields.unit_cost.read` grant), `SalesOrder.
  customer_email` → pii; no phi/regulated, so the audit + encryption
  invariants stay dormant. `buildErpRetailPack(opts?)` passes
  `tryValidateManifest` once resolved against a core registry.
  Template for `pack-erp-construction` / `-education`.
- **`pack-erp-grocery`** — fourth vertical pack; proves transitive
  (three-level) `meta.extends`. Declares `meta.extends:
  ["operate-erp/retail"]`, so resolving it recurses grocery →
  retail → core and merges all three (10 entities, 9 roles, 3
  workflows, 11 relations). 2 entities (Supplier → core Account;
  PerishableLot → retail Product + own Supplier, 4-state
  lifecycle), with cross-level references that resolve only when
  the full chain is present — `resolveManifest` throws if retail
  is in the registry but core is not. `Supplier.contact_email` →
  pii, `PerishableLot.cost_per_unit` → commercial_sensitive;
  classifications propagate through both merge levels (retail's
  `Product.unit_cost` survives too). `compliancePacks: ["haccp"]`.

### Business operations
- **`billing`** — plans, subscriptions, metered usage, invoices,
  payments, dunning, tax, events.
- **`finops`** — 17 cost categories × 5 allocation methods,
  per-tenant attribution, budgets + breach actions, unit
  economics (LTV/CAC/contribution margin), chargeback
  statements, cost reports.
- **`tenant-lifecycle`** — 7-state lifecycle (trial → … →
  deleted), grace periods, GDPR Article 17 deletion requests,
  data exports, cryptographic tombstones.

### Delivery + operations infrastructure
- **`deploy`** — apps × environments × strategies; migrations;
  feature flags; releases; artifacts; on-prem/BYOC packaging.
- **`dr`** — 5 DR tiers (mission-critical → best-effort), RPO/
  RTO targets, replication topology, backups, failover
  records, drills, runbooks.
- **`edge`** — region routing, latency budgets per route,
  autoscaling policies, edge cache, throttling, region
  affinity.
- **`active-active`** — multi-region active-active topology, 7
  consistency levels, vector clocks, 6 CRDT kinds (G/PN counters,
  OR-set, LWW register/map, MV register), conflict detection +
  resolution, split-brain lifecycle.
- **`pwa`** — PWA manifest, service worker, IndexedDB outbox,
  sync, push notifications (PHI-safe stubs), Capacitor wrapper.

### Developer / partner surface
- **`sdk`** — public API contract (versioning, scopes, operations,
  RFC 9457 problem details, cursor pagination, idempotency,
  webhooks with HMAC-SHA256).
- **`sdk-clients`** — language-specific client generation
  contract (10 target languages × 10 registries × 3 tiers,
  generator pipeline, semver release lifecycle, compatibility
  matrix, auth + retry helpers, client telemetry with W3C
  trace context).
- **`marketplace`** — installable extension packs, pack registry
  with ed25519 signing + security review, per-tenant install
  lifecycle, permission grants, marketplace listings + reviews.
- **`migration`** — 12 source kinds (CSV, JSONL, Salesforce,
  ServiceNow, SQL dumps, FHIR, etc.), schema inference, field
  mapping, preview/dry-run, idempotent backfill ledger,
  onboarding flow (workspace_setup → … → go_live).
- **`ml-training`** — opt-in consent (phi/regulated permanently
  forbidden), training datasets, eval sets (safety_refusal
  requires 100% pass), training runs, evaluations, model
  registry with shadow/canary/production lifecycle.

### Audit + compliance operations
- **`incident-response`** — 5 SEV levels with SLA profiles, 7
  incident roles, 8-state incident lifecycle, runbook
  executions, blameless postmortems with action items,
  customer comms with GDPR 72h breach notification deadline.
- **`incident-response-pg`** — Phase 3 P2.31: the Postgres
  persistence + ops layer over `meta.incidents` (extracted from
  `apps/workflow-worker`). 4 modules: sink (PostgresIncidentSink —
  record/resolve/escalate/acknowledge/mitigate/recordCommsSent, each a
  guarded UPDATE appending a typed timeline entry), replayer
  (PostgresIncidentReplayer listOpen/listForPeriod/getByIncidentId +
  pure verifyTimelineShape [8 drift kinds] / summarizeIncidentIssues /
  rowToIncidentSummary + IncidentSummary read projection), metrics
  (computeIncidentMetrics → MTTP/MTTA/MTTM/MTTR mean/p50/p95/max +
  open/resolved + per-severity gauges + escalation totals;
  incidentTimeToPageMs / incidentMilestoneMs / incidentResolutionMs +
  formatIncidentMetrics), query (framework-neutral runIncidents /
  runIncidentWrite over structural IncidentQuerySource /
  IncidentWriteSink + formatIncidentList / formatVerifyReport +
  IncidentsCliOptions). P2.40 (ADR-0149) added metrics-store
  (PostgresIncidentMetricsStore.recordSnapshot INSERTs one window's
  computeIncidentMetrics verdict to the platform-wide
  meta.incident_metric_snapshots table [#125, ims_ ids, the four MTTx
  stats as nullable JSONB]; listSnapshots reads a window newest-first;
  the pure incidentMetricsSnapshotRow projector + generateSnapshotId) —
  a durable historical trend behind the on-demand metrics. Deps:
  `incident-response` + `kernel-pg`. The
  workflow-worker app's `incidents` CLI + `--monitor` paths wire it in;
  any other `meta.incidents` consumer can reuse it.
- **`forensics`** — hash-chained tamper-evident logs, evidence
  with sealed/retention/destruction lifecycle, chain-of-custody
  with sha256-verified transfers, legal holds with separation of
  duties, e-discovery requests, court-admissible attestations.
- **`access-reviews`** — periodic attestation campaigns (SOC 2 /
  ISO 27001 / HIPAA / PCI / GDPR / 21 CFR Part 11). Campaigns,
  items, decisions with attestation + four-eyes, exceptions with
  per-reason duration caps, templates, sealed evidence with
  per-framework control mappings.
- **`data-lineage`** — provenance graph for GDPR Article 15 right
  of access (+ CCPA / LGPD / PIPEDA / UAE peers). 14 node kinds ×
  10 edge kinds with classification propagation rules
  (pii → public via anonymized_from with k≥5, phi → internal via
  aggregated_from with k≥11). Provenance records, data subject
  registry (sha256-only identifiers), subject access requests,
  graph traversal (ancestors/descendants/path/cycle/subject impact),
  retention policies + Article 15 evidence packs.

## Cross-cutting invariants

Recurring patterns enforced by zod `superRefine`:

- **Four-eyes principle.** Anywhere an action is privileged
  (deletion, hold release, postmortem review, four-eyes
  approvals), the actor must not also be the approver. Check
  for `executedBy !== approvedBy`, `author ∉ reviewers`,
  `releasedBy !== issuedBy`.
- **State machines.** Most lifecycle types export a `*_STATUSES`
  enum, a `*_TRANSITIONS` map, and a `canTransition*` helper.
  The schema enforces status↔required-fields pairing.
- **Cryptographic anchoring.** Sha256 hashes for content
  addressing show up everywhere: dataset freezing, deletion
  proofs, evidence sealing, postmortem storage, webhook signing,
  pack signing (ed25519 there).
- **Tenant scoping.** Records with `tenant_id` get RLS. Cross-
  tenant audit/compliance records are platform-wide (cdc
  checkpoints, regions, plans, deployments, ediscovery,
  tombstones).
- **Forbidden lists.** PHI/regulated data can never be used for
  ML training (`FORBIDDEN_TRAINING_DATA_CLASSES`). Latest docker
  tag is forbidden (deploy). Two-person integrity for human
  evidence collection.
- **Deadlines.** Where regulation imposes timing (GDPR 72h
  breach, Article 12(3) 3-month deletion deadline), schemas
  enforce it.

## Meta-schema

`packages/kernel/src/bootstrap/meta-schema.ts` is the central
catalog of 124 platform-level Postgres tables. Each new package
adds tables there + updates `meta-schema.test.ts` (table count,
expected names list sorted alphabetically, column-check
assertions).

The test suite enforces two invariants:
1. Every `tenant_id`-bearing table has RLS enabled.
2. Foreign-key references resolve to a table declared earlier
   in `META_TABLES`.

When adding tables, **append them to the array at the bottom in
the order the package was built**, not alphabetically. The
expected-names test sorts independently.

## Build + test commands

```bash
# Install
pnpm install

# Per-package
pnpm --filter @crossengin/<name> build
pnpm --filter @crossengin/<name> test
pnpm --filter @crossengin/<name> typecheck

# Workspace
pnpm -r build
pnpm -r test
pnpm -r typecheck

# Build is fast; full workspace test ≈ 30s
```

There is **no top-level lint script**. ESLint config has not
been migrated to v9 flat config yet; ignore lint until asked.

### Real-Postgres integration tests (gated)

The 24 gated integration tests in `apps/workflow-worker` +
`apps/operate-server` are skipped unless `CROSSENGIN_PG_TEST=1` is set
(so the offline suite stays hermetic). To run them, provision a
throwaway database + run the gated suites:

```bash
pnpm -r build
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres PGDATABASE=crossengin_test \
  bash scripts/setup-integration-db.sh          # creates db + pgcrypto + uuid shim + applies the 124-table schema
CROSSENGIN_PG_TEST=1 PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
  PGDATABASE=crossengin_test PGSSLMODE=disable \
  pnpm --filter @crossengin/workflow-worker-app test
# … and --filter @crossengin/operate-server test
```

`.github/workflows/ci.yml` runs this automatically: a `build-test`
job (build + typecheck + offline tests) and an `integration` job (a
`postgres:16` service + `scripts/setup-integration-db.sh`, then a
**schema drift gate** (`crossengin-pg drift` against the freshly-
provisioned `meta` schema — exits 1 on any added/removed/modified
table, column, index, policy, or RLS toggle vs `META_TABLES`; runs
before the suites so it gates the bootstrap baseline, not test
pollution), then the gated suites under `CROSSENGIN_PG_TEST=1`, then
three more gates — an **incident-drift gate** (`workflow-worker
incidents verify` over a wide window, exits 1 on any drifted incident
timeline), a **PHI at-rest encryption gate** (`crossengin-pg
encrypt --verify` over `meta` + `public`, exits 1 on any plaintext PHI
column / missing pgcrypto), and a **gateway-execution drift gate**
(`crossengin-gateway-pg executions verify --since 2000-01-01`, exits 1
on any drifted persisted PipelineExecution; verifies an empty table
clean today since operate-server doesn't yet persist executions, P2.42
/ ADR-0151), all failing the build).
`scripts/emit-bootstrap.mjs`
emits the meta-schema DDL the setup script applies. (Production uses
the `pg_uuidv7` extension; the test shim is `gen_random_uuid()`.)

## Conventions

- **Module structure.** Each package: `package.json`,
  `tsconfig.json` (extends `@crossengin/config/typescript/base`),
  `vitest.config.ts` (re-exports `vitestPreset`), `src/index.ts`
  (re-exports all source modules), 4–7 `src/*.ts` source modules,
  matching `src/*.test.ts` files.
- **Naming.** Constants `SCREAMING_SNAKE_CASE`, types `PascalCase`,
  schemas `<Name>Schema`. Stable id prefixes per kind:
  `INC-YYYY-NNNN` for incidents, `EV-` for evidence, `PM-` for
  postmortems, `LH-` for legal holds, etc.
- **Tests.** Each module gets its own `*.test.ts`. Tests cover
  constants, schema validation (accept + reject paths), helper
  functions, and state-machine transitions. Aim for 15–30 tests
  per module.
- **No comments.** The codebase generally doesn't have JSDoc or
  inline comments. Don't add them unless explaining a non-obvious
  invariant.

## Workflow

The user drives construction with `go [letter]` commands. After
each completed package, propose 6–8 next options labeled A–H and
recommend one. The user picks. Each landed package follows this
shape:

1. Read the relevant ADR (or design fresh against the
   conversation context if no ADR exists yet).
2. Scaffold `package.json` + `tsconfig.json` + `vitest.config.ts`.
3. Build 4–7 source modules with comprehensive zod schemas +
   deterministic helpers. No placeholders.
4. Build `src/index.ts` re-exporting everything.
5. Wire `META_*` tables into kernel meta-schema (+ test).
6. Write `*.test.ts` files alongside each source module.
7. Run `pnpm --filter @crossengin/<name> test` until green.
8. Run `pnpm -r test` to confirm no regression.
9. Run `pnpm -r typecheck`.
10. `git commit` with a detailed multi-paragraph message
    describing each module's enums + invariants + helpers.
11. `git push -u origin claude/crossengin-development-LXLNw`.

## Git

- Working branch: `claude/crossengin-development-LXLNw`.
- Never force-push. Never skip hooks (`--no-verify`).
- Don't create PRs unless the user asks.
- Repository scope is restricted to `amoufaq5/crossengin` and
  `amoufaq5/erp`.

## What's deferred to Phase 2+

The current packages model the *shape* of the platform. The
following are intentionally out of scope until contracts settle:

- Real provider clients (Stripe, Salesforce, ServiceNow).
  Today the packages have credential refs + record types only.
  (Anthropic ships its real client in M2.7 — see below.)
- Real cryptography. Signature fields are typed as strings; the
  actual HMAC/ed25519 computation is not in this codebase.
- Customer-facing *UI* apps under `apps/`. UI lives in `views` as
  type definitions only. (Three server-side apps exist:
  `architect-cli`, `operate-server` (P1.7), and `workflow-worker`
  (P2.3).)

**No longer deferred (as of M1):** kernel DDL execution. The
`kernel-pg` package executes meta-schema DDL against a real
Postgres, with `_meta_migrations` bookkeeping for idempotent
re-runs and pg_catalog introspection for drift detection.

**No longer deferred (as of M2):** real cryptography. The
`crypto` package produces verifiable SHA-256 / BLAKE2b-512
hashes, real HMAC-SHA256 / Ed25519 signatures over `node:crypto`,
with an opaque `KeyHandle` contract that hides raw key material
behind a `KeyStore` interface.

**No longer deferred (as of M2.5 + M2.6):** downstream crypto
wiring. The crypto package is now called from six existing
packages, so previously-string-only signature/hash fields are
populated by real verifiable values: marketplace pack manifests
carry real Ed25519 signatures with sha256 public key
fingerprints; sdk webhook deliveries carry real HMAC-SHA256
signatures bound to timestamps for replay protection; forensics
chain entries carry real hash chains rooted at GENESIS_HASH plus
Ed25519 entry signatures, and evidence is sealed with real
sha256 + Ed25519; tenant-lifecycle tombstones carry
canonical-JSON-derived contentManifestSha256 + proofSha256;
access-reviews decision attestations carry real Ed25519
signatures for the four strong attestation kinds (e_signature_
digital, qualified_e_signature, two_person_attestation) and the
campaign evidence pack carries a real sealedSha256 over the
canonical evidence + bundle bytes; data-lineage Article 15
evidence packs carry a real sealedSha256 over the canonical
pack + bundle bytes for GDPR right-of-access deliverables.

**No longer deferred (as of M2.7):** real LLM provider client.
The `ai-providers-anthropic` package ships a working binding to
Anthropic's Messages API. `AnthropicProvider.complete(req)`
POSTs to `/v1/messages` with `x-api-key` + `anthropic-version:
2023-06-01` + `accept: text/event-stream`, yields the
discriminated-union `CompletionChunk` kinds (`text` /
`tool_call_start` / `tool_call_arg_delta` / `tool_call_end` /
`usage_final`) from `@crossengin/ai-providers` as SSE events
stream in. Token state is shared across `reader.read()`
boundaries via an internal `processSseEvents(raw, state)`
helper, so `usage_final` carries cumulative input/output/cached
tokens with USD cost computed at per-model rates (opus-4-7
$15/$75 per million, sonnet-4-6 $3/$15, haiku-4-5 $1/$5;
cached input 90% off; cache-write 25% premium). Errors normalize
to `AnthropicError` with `kind` + `status` + `isRetryable()`.
The provider is the first concrete `LlmProvider` implementation
— the Architect agent (M5.5 chat command) can now run against
a real backend with real cost accounting.

**No longer deferred (as of M2.8):** a second LLM provider.
`@crossengin/ai-providers-openai` binds OpenAI's Chat
Completions (`/v1/chat/completions`) + Embeddings
(`/v1/embeddings`) to the same `LlmProvider` contract, zero
runtime deps. `OpenAiProvider.complete()` streams the same
`CompletionChunk` union (parsing `data:`/`[DONE]` SSE,
assembling `tool_calls` by index, emitting `tool_call_end` on
`finish_reason`); `embed()` returns real vectors with cost
(the first provider where `embed()` works — `capabilities.
embedding = true`). Usage cost subtracts `cached_tokens` from
OpenAI's total `prompt_tokens` before charging the uncached
rate. Errors normalize to `OpenAiError` with the same
`isRetryable()` structural contract the router consumes, so a
`TaskPolicy` fallback chain (`anthropic/… → openai/…`) now
fails over across vendors for real. Two independent
implementations of one wire-format-neutral contract prove the
`LlmProvider` abstraction; Bedrock / Vertex / Mistral follow the
same five-module template.

**No longer deferred (as of M3):** workflow execution. The
`workflow-runtime` package consumes `WorkflowDefinition` shapes
and actually runs them: starts instances, threads variables,
runs automatic transitions, schedules + executes activities via
a registered handler registry, fires timers when their fireAt is
reached, accepts signals matched by tenant + correlationKey,
emits the documented 24 event kinds (instance_started /
state_transitioned / activity_* / signal_* / timer_* /
variable_updated / compensation_* / instance_completed/failed/
cancelled/suspended/resumed), and replays state by left-folding
the event stream.

**No longer deferred (as of M3.5 + M3.6 + M3.7):** workflow
persistence + wiring + recovery. The `workflow-runtime-pg`
package implements the `EventLog` interface against
META_WORKFLOW_EVENTS via `@crossengin/kernel-pg`. Events survive
process restarts; multiple worker processes can share an event
log. PostgresInstanceStore / ActivityStore / SignalStore /
TimerStore turn projected in-memory state into UPSERTs against
the corresponding META_WORKFLOW_* tables. `ProjectingEventLog`
wraps any `EventLog` and auto-runs the projection writers after
each append — drop it into a `WorkflowEngine` and every
transition, signal, timer, activity scheduling becomes a
Postgres write without the consumer needing to know.
`WorkflowReplayer.resyncInstance` re-projects from the canonical
event log + re-upserts to fix drift after crashes or schema
changes; `verifyInstance` returns a typed DriftReport for CI
guards; `bulkResync` iterates with pagination so periodic sweeps
stay bounded.
`buildPersistentEngine(conn, definitions)` is the one-call
factory that wires the whole thing together.

**No longer deferred (as of M4):** HTTP request handling. The
`api-gateway-runtime` package executes the 17-stage pipeline
declared in `@crossengin/api-gateway` as real middleware. A
POST request lands → walks the stages → produces an
OutgoingResponse + a schema-valid PipelineExecution. Unauth →
401 + WWW-Authenticate. Valid JWT + over-quota → 429 +
Retry-After. Replay with same Idempotency-Key → cached 201 with
X-Idempotent-Replay: true. Routes with required scopes plug
into @crossengin/auth's principal model.

**No longer deferred (as of M4.5 + M4.6):** production-shape
gateway persistence + audit. The `api-gateway-pg` package
implements the four store interfaces against the existing
META_GATEWAY_* + META_RATE_LIMIT_DECISIONS tables via
`@crossengin/kernel-pg`. Idempotency records survive process
restarts and persist across nodes. Route definitions live in the
database (cache reload on TTL or explicit refresh, plus upsert
API for tooling). Rate-limit decisions are auditable rows in
META_RATE_LIMIT_DECISIONS. PipelineExecutions persist to
META_GATEWAY_PIPELINE_EXECUTIONS so every request is queryable
by tenant + correlationId + time. `GatewayReplayer.verifyExecution`
returns a typed DriftIssue list per request — stages out of
order, final stage/outcome mismatches, pass with 4xx/5xx, deny
without 4xx/5xx, terminating outcome not last, duration
inconsistent, rate-limit decision orphaned. summarize / bulkVerify
power periodic SLO + audit sweeps over the execution stream.

**No longer deferred (as of M5):** the developer entry point.
`apps/architect-cli` ships a `crossengin` binary with the M5
subcommand surface: `init` (scaffold a manifest), `validate`
(zod-check + summary), `diff` (computeManifestDiff with human
or JSON output), `patch` (write a manifest patch), `hash`
(deterministic manifestHash), `apply` (--dry-run emits the
3,061-line meta-schema SQL; live mode uses MigrationApplier
against PGHOST/PGDATABASE), `chat` (wired in M5.5 — see below),
`version`, `help`. Every subcommand has --format human|json.
Exit codes: 0 success / 1 runtime problem / 2 misuse. The CLI
is the first binary that composes contracts → real artifact.

**No longer deferred (as of M6.5):** policy routing across
providers. `@crossengin/ai-router` lets a consumer hand off a
`CompletionRequest` and get back a stream with: provider chosen
via `TaskPolicyMap` (primary then fallback), residency-filtered
to the tenant's policy, retried with exponential backoff on
retryable errors, falling back to the next provider when
exhausted, and refused if the tenant's `costCeiling` would be
breached. Pre-flight cost estimate uses input length + maxTokens
× per-million pricing; the post-call `usage_final.cost` replaces
the estimate in the cost tracker. Pattern set for OpenAI /
Bedrock / Vertex once their `LlmProvider` adapters land — no
router changes needed.

**No longer deferred (as of M7):** the first vertical pack.
`@crossengin/pack-erp-core` ships a real Manifest that exercises
every kernel cross-validator. The substrate is now proven —
entities, relations, roles, permissions, workflows, jobs, and
views all resolve correctly under a realistic ERP schema. The
Architect agent has a concrete starting point: `buildErpCorePack
(opts)` returns a working Manifest a developer can validate +
hash + apply via the existing CLI flow. Pattern set for future
verticals (healthcare, retail, construction): same module shape,
same cross-validators, optional `meta.extends` lineage.

**No longer deferred (as of M7.5):** pack extension lineage.
`@crossengin/pack-erp-healthcare` is the first pack to use
`meta.extends`. It declares `meta.extends: ["operate-erp/core"]`
and references core entities (Account, Invoice) by name, so it
does NOT cross-validate standalone — `tryValidateManifest` only
passes after `resolveManifest(pack, {registry})` merges the core
pack in (4 + 3 = 7 entities, 3 + 4 relations, merged roles, both
lifecycle workflows), with the core pack's slug/version/hash
recorded in `meta.manifestResolution.parents`. Three PHI clinical
entities (Patient / Encounter / Observation), two cross-pack
relations (Account→Patients, Encounter→Invoice), HIPAA compliance
posture, PHI-tagged jobs. The kernel's dormant pack-composition
mechanism now has a real consumer with a passing cross-validation
test — the "verticals extend a base" story is demonstrated, not
just designed.

**No longer deferred (as of M7.6):** field-level data
classification. The manifest `FieldSchema` carries an optional
`classification` (`public | internal | commercial_sensitive |
pii | phi | regulated`). The kernel DDL emitter writes a
`COMMENT ON COLUMN … 'crossengin.data_class=<class>'` per
classified field so the class is queryable in `pg_catalog`, and
`validateManifest` enforces that `phi`/`regulated` fields live on
an `auditable` entity. `manifestClassifiedFields(manifest)` is
the compliance inventory; `isFieldSensitive` / `requiresAuditTrail`
the helpers. `pack-erp-healthcare` classifies its PHI/PII fields
end-to-end. Acting on the class is M7.7 (below).

**No longer deferred (as of M7.7):** acting on the data
classification. `@crossengin/auth` gained
`computeClassifiedFieldRedaction` / `validateClassifiedWriteMask`:
a sensitive field (pii/phi/regulated/commercial_sensitive) with
no explicit `read`/`update` grant is redacted / write-blocked by
default for non-privileged principals (`SensitiveFieldPolicy =
{privilegedRoles?, redactByDefault?}`; explicit per-field grants
still win). The kernel DDL emitter appends
`crossengin.encrypt=at_rest` to the column comment for
phi/regulated fields (`requiresEncryptionAtRest` in types), so a
migration applier has an at-rest-encryption signal in
`pg_catalog`. The original `computeFieldRedaction` /
`validateWriteMask` are untouched; the classification-aware
variants are additive opt-ins. PHI is now fail-closed (masked +
encryption-hinted) from the field declaration alone. Wiring the
redaction into the gateway is M7.7.5; choosing the encryption
mechanism is M7.8 (pgcrypto — see below).

**No longer deferred (as of M7.7.5):** edge redaction.
`@crossengin/api-gateway-runtime`'s `transform_response` stage
applies the M7.7 classification redaction to JSON responses. A
new `redaction.ts` ships `ResponseRedactionSpec` (classified
fields + roles map + a `rolesForPrincipal` scope→role bridge,
since the gateway `ResolvedPrincipal` carries scopes not roles +
optional entityPermissions/policy), `RedactionRegistry` /
`MapRedactionRegistry`, `computeRedactedFields` (fail-closed —
unknown roles map to an unprivileged sentinel, never throwing
into an unredacted fallback), and `redactJsonValue` (a pure
tree-walk dropping named fields across records / arrays /
`{data:[…]}` wrappers). `GatewayRuntimeOptions.redactionRegistry`
is opt-in; with none set, `transform_response` is the prior
no-op. The stage records `redacted_N_fields` in the
`PipelineExecution` audit, and the response is rebuilt through
`outgoingResponseFromJson` so `content-length` stays correct. A
front-desk principal reading `GET /v1/patients` gets
`mrn`/demographics dropped; a clinician gets them — same handler.
A manifest-derived registry is M7.7.6 (below).

**No longer deferred (as of M7.7.6):** zero-config redaction.
`api-gateway-runtime`'s `redactionRegistryFromManifest(manifest,
{rolesForPrincipal, policyForEntity?, operationsForEntity?})`
builds the whole `RedactionRegistry` from a manifest: every
entity with a classified field contributes a spec
(`redactionSpecForEntity` via `entityClassifiedFields`),
registered under its read operationIds (default
`<entitylower>.read|list|get`, overridable). The input is a
structural `RedactionManifestInput` (`{entities, permissions,
roles}`) so the runtime never imports `@crossengin/kernel`; a
full `Manifest` is assignable. The deployment supplies only the
scope→role bridge and the per-entity `SensitiveFieldPolicy`;
without a policy, sensitive fields are redacted for everyone
lacking an explicit grant (fail-closed). `classification: "phi"`
on a field now drives the entire chain — catalog comment, audit
invariant, encryption hint, default mask, edge redaction —
with no hand-written spec. Inferring `privilegedRoles` from the
entity's write grants + a write-side classification mask are the
deferred follow-ups.

**No longer deferred (as of M7.8):** the at-rest encryption
mechanism. The M7.7 `crossengin.encrypt=at_rest` hint is fulfilled
by **pgcrypto** symmetric encryption (`@crossengin/crypto` has no
symmetric cipher, so encryption lives in the database). `kernel-pg`'s
`encryption.ts` reads the hint from `col_description`
(`parseColumnDirectives` is the pure inverse of the kernel
emitter's comment), provisions pgcrypto
(`ensurePgcryptoExtension`), exposes `pgpSymEncryptExpr` /
`pgpSymDecryptExpr` SQL builders (key by *reference*, never
inlined — `BYTEA` ciphertext), and `EncryptionApplier.coverage(
schema)` returns an `EncryptionCoverageReport` flagging
`plaintext_at_rest` (a PHI column still stored as a plaintext
type) + `pgcrypto_missing` drift — a HIPAA control can assert
"zero plaintext PHI columns" against the live catalog. The
column-rewrite-to-BYTEA + encrypt-on-write path is M7.8.5 (below);
M7.8 ships the decision, provisioning, builders, and coverage
verifier.

**No longer deferred (as of M7.8.5):** the encrypt-on-write path.
`kernel-pg`'s `encryption-migration.ts` makes M7.8's
`plaintext_at_rest` go green: `emitEncryptColumnSql` converts a
hinted plaintext column to a pgcrypto-encrypted `BYTEA` column in
place (ADD `<col>__enc BYTEA` → UPDATE
`pgp_sym_encrypt(<col>::text, keyRef)` with NULLs preserved → DROP
→ RENAME → re-COMMENT the directive), `emitDecryptingViewSql`
builds a `pgp_sym_decrypt` read view for transparent reads, and
`EncryptionMigrator.migrateSchema(schema, keyRef)` plans (plaintext
columns only, so re-runs are no-ops) + runs each column in its own
transaction. Key is always a SQL *reference*, never inlined
(test-enforced). After migration the M7.8 verifier reports the
column encrypted-at-rest — closing the data-classification arc
(declare `phi` → comment + audit invariant → mask + encryption
hint → edge redaction → at-rest coverage → actual encryption). The
transparent *write* path (INSTEAD OF triggers) + key rotation are
the deferred follow-ups.

**No longer deferred (as of M8):** SLO enforcement.
`@crossengin/observability-runtime` turns the inert SLO / alert /
synthetic / trace definitions from `@crossengin/observability`
into a running enforcement loop. `SloEnforcementEngine`
ingests `RequestOutcome`s, computes multi-window Google-SRE burn
rates against each SLO's availability target, and on a breach
emits an `EnforcementPlan`: a schema-valid declared
`IncidentRecord` (→ META_INCIDENTS), an on-call `PageDirective`
resolved from the `AlertPolicy`, and a `triggered_active`
`KillSwitch` that rolls the offending flag back to its safe
value. One incident per ongoing breach (dedup), with a
`recovered` decision when the burn clears. `TraceCollector`
stitches gateway→workflow→notifications spans into a tree. Pure
in-process runtime (no new META_ tables); records persist via the
M8.5 sibling. **Phase 2's eight milestones (M1–M8) are complete.**

**No longer deferred (as of M8.5):** SLO enforcement persistence.
`@crossengin/observability-runtime-pg` is the Postgres sibling
for the enforcement loop. `buildPersistentSloEnforcementEngine`
wraps a `SloEnforcementEngine` so every `evaluate()` writes an
enforcement action per decision (→ `meta.slo_enforcement_actions`)
and an evaluation snapshot per `breach_opened` (→
`meta.slo_evaluations`). `PostgresSloEvaluationStore` /
`PostgresSloEnforcementActionStore` are append-only (`INSERT … ON
CONFLICT DO NOTHING`); `SloEnforcementReplayer` runs pure drift
checks (ongoing/recovered-without-open, duplicate-open,
paged-without-channels, kill-switch-without-flag). Two new
platform-or-tenant-RLS tables join the burn → incident →
kill-switch chain so "every SLO breach last week and what it did"
is one query.

**No longer deferred (as of M8.6):** latency-target enforcement.
`observability-runtime` now ships `LatencySloEngine` alongside
the availability `SloEnforcementEngine`. It rides the same
`recordOutcome()` stream (latency comes from `RequestOutcome.
latencyMs`), computes p50/p95/p99 over a short rolling window
(`RollingWindow.latencyStats`), and `evaluateLatencyTarget`
fires per declared percentile when observed > budget×multiplier
with ≥minSamples. A breach reuses the shared planners to declare
a `performance` incident, page on-call, and optionally roll a
flag back — one incident per ongoing breach, `recovered` when
latency drops under budget. Pure compute, no new package/tables;
availability + latency engines compose over one shared
`RollingWindow`.

**No longer deferred (as of M8.7):** latency enforcement
persistence. `observability-runtime-pg` now persists latency
decisions too. A `signal` column on `meta.slo_enforcement_actions`
('availability' | 'latency', default 'availability') lets one
audit table serve both engines, and a new
`meta.slo_latency_evaluations` table holds latency verdict
snapshots (`slle_` ids, worst_percentile, sample_count, breaches
JSONB). `buildPersistentLatencySloEngine` wraps a
`LatencySloEngine` exactly as the availability persisting engine
does; the shared `enforcementActionFromDecision` accepts both
decision unions, and the M8.5 `SloEnforcementReplayer` verifies
latency actions unchanged. "Every SLO breach — availability and
latency — and what it did" is now one query.

**No longer deferred (as of M5.7):** chat audit trail. The new
`@crossengin/ai-architect-pg` package persists every chat
session, message, tool invocation, and write proposal to four
META_ARCHITECT_* tables. The chat engine emits lifecycle events
(`onSessionStart` / `onMessage` / `onToolInvocation` /
`onProposal` / `onSessionEnd`) into an abstract `Transcript`
interface; `NullTranscript` (default) discards events,
`PostgresTranscript` writes them. Sessions are unique per
(tenant, session_id); messages are ordered by
(turn_index, message_index); proposals record `decision` (one
of auto_approved / interactive_approved / interactive_denied /
no_changes / invalid_manifest) + `applied` + `denial_reason`.
Operators query `SELECT * FROM meta.architect_proposals WHERE
decision = 'interactive_approved'` to audit writes,
`JOIN architect_messages ON session_id` to reconstruct the
conversation context for any proposal.

**No longer deferred (as of M5.8):** closed authoring loop.
`crossengin chat --allow-file-write` now exposes
`propose_manifest_edit({path, new_manifest_json})` as a tool
Claude can invoke. Every write proposal surfaces a diff
(entities added / removed / modified) + the new hash to the
developer, who approves (`y` / `yes`) or denies (`n` /
anything else / EOF). Approved writes go to disk pretty-
printed; denied / invalid / no-change proposals return
typed `{applied: false, reason}` envelopes Claude can react
to. `--auto-approve-writes` skips the prompt (required for
one-shot scripted mode, where there's no human to ask).
`WriteApprover` interface decouples approval policy from
the tool itself — `autoApprover(true)` for scripted runs,
`interactiveApprover({io, reader})` for the REPL. Both share
the same `LineReader` the REPL uses, so the approval prompt
and the chat prompt cooperate over one stdin without
competing readers.

**No longer deferred (as of M5.6):** tool-driven authoring loop.
`crossengin chat` now exposes the manifest-side CLI helpers as
tools Claude can call mid-conversation. The default catalog
(`validate_manifest` / `hash_manifest` / `diff_manifests` /
`summarize_manifest`) gives Claude what it needs to author +
verify a manifest in one session; `--allow-file-read` adds an
extension-gated, size-capped `read_file` tool when the developer
explicitly opts in. `runChatExchange` orchestrates per-message
tool dispatch with a `DEFAULT_MAX_TOOL_ITERATIONS` (5) circuit
breaker. Tool errors don't terminate the exchange — they go
back to Claude as `tool_result` envelopes so the model can
react. `@crossengin/ai-providers.LlmMessage` gained an optional
`toolUses` field so assistant tool_use blocks round-trip
correctly through Anthropic's API (required for `tool_use_id`
matching on subsequent `tool_result` blocks).

**No longer deferred (as of M5.5):** chat against a real model.
`crossengin chat` now constructs an `AnthropicProvider` (using
`ANTHROPIC_API_KEY` from env + a configurable `--model`,
defaulting to claude-sonnet-4-6) and routes through the shared
chat engine in `architect-cli/src/chat.ts`. `runChatTurn`
streams chunks from `provider.complete()` to a renderer
(plain-text for human, NDJSON for `--format=json`), accumulates
assistant text + tool calls + usage. `runChatRepl` handles both
one-shot (`--prompt "..."`) and REPL (stdin lines until `/exit`
/ EOF) modes, aggregating per-turn usage into a session total
with USD cost. Tests inject a stub `LlmProvider` via
`RunContext.providerOverride`, so CI runs offline without an
Anthropic key. (M2.8.5: chat now builds a multi-vendor
`DefaultLlmRouter` via `buildChatProvider` — Anthropic primary →
OpenAI fallback when both keys are set — through the structural
`CompletionProvider` type; `--provider auto|anthropic|openai`.)

## ADRs

ADRs 0001-0079 + 0086-0105 exist as markdown in `docs/adr/` (0080-0085
reserved for Phase 3 P3-P8). Every shipped
package has a corresponding ADR; no reserved gaps. ADR-0046 is
the bridge from Phase 1 contracts to Phase 2 runtime (8
milestones). ADR-0047 covers Phase 2 M1 (`kernel-pg`), ADR-0048
covers Phase 2 M2 (`crypto`), ADR-0049 covers Phase 2 M3
(`workflow-runtime`), ADR-0050 covers Phase 2 M4
(`api-gateway-runtime`), ADR-0051 covers Phase 2 M5
(`architect-cli`), ADR-0052 covers Phase 2 M6
(`workflow-signal-bridge`), ADR-0053 covers Phase 2 M2.7
(`ai-providers-anthropic`), ADR-0054 covers Phase 2 M5.5
(architect-cli chat mode), ADR-0055 covers Phase 2 M5.6
(architect-cli tool-driven chat), ADR-0056 covers Phase 2
M5.8 (architect-cli write tools), ADR-0057 covers Phase 2
M5.7 (chat persistence to META_ARCHITECT_*), ADR-0058 covers
Phase 2 M7 (`pack-erp-core`), ADR-0059 covers Phase 2 M6.5
(`ai-router`), ADR-0060 covers Phase 2 M8
(`observability-runtime` — SLO enforcement loop), ADR-0061
covers Phase 2 M8.5 (`observability-runtime-pg` — SLO
enforcement persistence), ADR-0062 covers Phase 2 M8.6
(latency-target SLO enforcement), ADR-0063 covers Phase 2 M8.7
(latency enforcement persistence), ADR-0064 covers Phase 2 M2.8
(`ai-providers-openai` — second LlmProvider), ADR-0065 covers
Phase 2 M7.5 (`pack-erp-healthcare` — second vertical pack),
ADR-0066 covers Phase 2 M7.6 (field-level data classification),
ADR-0067 covers Phase 2 M7.7 (acting on data classification),
ADR-0068 covers Phase 2 M7.7.5 (gateway response redaction),
ADR-0069 covers Phase 2 M7.7.6 (manifest-derived redaction
registry), ADR-0070 covers Phase 2 M7.8 (at-rest encryption
mechanism + pgcrypto coverage applier), ADR-0071 covers Phase 2
M7.8.5 (encrypt-on-write migration), ADR-0072 covers Phase 2
M2.8.5 (multi-vendor router in architect-cli chat), ADR-0073
covers Phase 2 M2.8.6 (per-turn provider + cost attribution in
chat), ADR-0074 covers Phase 2 M7.8.6 (crossengin-pg encrypt CLI),
ADR-0075 covers Phase 2 M7.9 (pack-erp-retail), ADR-0076 covers
Phase 2 M7.9.1 (pack-erp-grocery — transitive lineage), ADR-0077
is the Phase 3 plan, ADR-0078 covers Phase 3 P1
(`operate-runtime` — serving a manifest as a multi-tenant API),
ADR-0079 covers Phase 3 P1.5 (gateway request-body parsing +
handler-returned outcome mapping in `api-gateway-runtime`),
ADR-0086 covers Phase 3 P1.6 (`operate-runtime-pg` — the Postgres
`EntityStore` over `meta.operate_entity_records` under tenant RLS),
ADR-0087 covers Phase 3 P1.7 (`apps/operate-server` — the runnable
serving binary over `buildOperateGateway`), ADR-0088 covers Phase 3
P1.8 (list pagination + filtering from the ListView), ADR-0089
covers Phase 3 P1.9 (edge/Workers fetch adapter in `apps/operate-
server`), ADR-0090 covers Phase 3 P1.10 (column-mapped entity
store — typed per-entity tables in `operate-runtime-pg`), ADR-0091
covers Phase 3 P1.11 (transparent at-rest encryption in the column-
mapped store), ADR-0092 covers Phase 3 P1.12 (foreign keys +
topological apply order in the column store), ADR-0093 covers
Phase 3 P1.13 (per-relation delete semantics in the column store),
ADR-0094 covers Phase 3 P1.14 (many_to_many join tables in the
column store), ADR-0095 covers Phase 3 P1.15 (association
link/unlink API over the join tables), ADR-0096 covers Phase 3
P1.16 (keyset pagination + typed filter operators in the entity
stores), ADR-0097 covers Phase 3 P1.17 (production JWT/JWKS
identity in `apps/operate-server`), ADR-0098 covers Phase 3 P1.18
(JWT/tenant cross-check in `api-gateway-runtime`), ADR-0099 covers
Phase 3 P1.19 (remote JWKS provider with caching + rotation in
`apps/operate-server`), ADR-0100 covers Phase 3 P1.20 (background
JWKS refresh poller in `apps/operate-server`), ADR-0101 covers
Phase 3 P1.21 (field selection / projection on list + read in
`operate-runtime`), ADR-0102 covers Phase 3 P1.22 (SQL-level
projection pushdown in the column store), ADR-0103 covers Phase 3
P2 (`workflow-worker` — the distributed tick worker over the PG
event log), ADR-0104 covers Phase 3 P2.1 (per-unit timer claim + fireTimer for parallel workers), ADR-0105 covers Phase 3 P2.2 (activity retry executor in workflow-worker), ADR-0106 covers Phase 3 P2.3 (apps/workflow-worker — the runnable distributed worker binary), ADR-0107 covers Phase 3 P2.4 (activity retry backoff — next_retry_at population), ADR-0108 covers Phase 3 P2.5 (instance timeout sweeper — timeoutInstance + claim), ADR-0109 covers Phase 3 P2.6 (real-Postgres worker integration test + projection NOT NULL fixes), ADR-0110 covers Phase 3 P2.7 (worker observability — heartbeats + per-run outcomes), ADR-0111 covers Phase 3 P2.8 (async activity queue — decouple schedule from execute), ADR-0112 covers Phase 3 P2.9 (definition-level activity execution-mode default), ADR-0113 covers Phase 3 P2.10 (activity-level timeout sweeper — timeoutActivity + claim), ADR-0114 covers Phase 3 P2.11 (stale-worker detection over the heartbeat table), ADR-0115 covers Phase 3 P2.12 (lease-reaper — proactively clear expired worker leases), ADR-0116 covers Phase 3 P2.13 (stale-worker → incident bridge in apps/workflow-worker), ADR-0117 covers Phase 3 P1.23 (operate-server real-Postgres integration test), ADR-0118 covers Phase 3 P2.14 (projection drift-sweep worker mode), ADR-0119 covers Phase 3 P1.24 (ColumnMappedEntityStore real-Postgres integration test), ADR-0120 covers Phase 3 P1.25 (column-store m2m link + FK ON DELETE integration test), ADR-0121 covers Phase 3 P2.15 (live stale-worker monitor in the worker binary), ADR-0122 covers Phase 3 P1.26 (column-store set_null + non-bypassing-role RLS integration test), ADR-0123 covers Phase 3 P2.16 (stale-worker incident persistence sink), ADR-0124 covers Phase 3 P2.17 (worker incident lifecycle — open/resolve dedup), ADR-0125 covers Phase 3 P1.27 (column-store NUMERIC read fidelity), ADR-0126 covers Phase 3 P1.28 (column-store DATE / TIMESTAMPTZ read fidelity), ADR-0127 covers Phase 3 P2.18 (stale-worker incident severity escalation), ADR-0128 covers Phase 3 P2.19 (stale-worker incident timeline entries), ADR-0129 covers Phase 3 P2.20 (stale-worker re-page on escalation), ADR-0130 covers Phase 3 P2.21 (incident replayer — typed read API over meta.incidents), ADR-0131 covers Phase 3 P2.22 (incidents CLI subcommand on workflow-worker), ADR-0132 covers Phase 3 P2.23 (incident metrics — MTTR + open gauges from the timeline), ADR-0133 covers Phase 3 P2.24 (incident ack/mitigate milestones — MTTA + MTTM), ADR-0134 covers Phase 3 P2.25 (incidents ack/mitigate write CLI commands), ADR-0135 covers Phase 3 P2.26 (incident timeline drift CI gate), ADR-0136 covers Phase 3 P2.27 (PHI at-rest encryption CI gate), ADR-0137 covers Phase 3 P2.28 (webhook page transport), ADR-0138 covers Phase 3 P2.29 (page-delivery comms_sent timeline audit), ADR-0139 covers Phase 3 P2.30 (MTTP time-to-page metric), ADR-0140 covers Phase 3 P2.31 (incident-response-pg package extraction), ADR-0141 covers Phase 3 P2.32 (operate-server SLO incidents via incident-response-pg; ADRs 0080-0085 reserved for P3-P8).
When you ship
a new package, write the matching ADR in the same session,
following `0000-template.md` and the style of the existing
0026-0037 batch.
