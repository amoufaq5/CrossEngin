# ADR-0232: serve-level DR-readiness + access-review lifecycles in operate-server (Phase 3 P8)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0228 (dr-runtime), ADR-0230 (dr-runtime-pg), ADR-0229 (access-reviews-runtime), ADR-0231 (access-reviews-runtime-pg), ADR-0227 (--slo-config pattern), ADR-0077 (P3 plan — P8) |

## Context

The two P8 runtimes and their persistence siblings (dr-runtime(+pg), access-reviews-runtime(+pg))
existed and were tested, but nothing in the running `operate-server` binary drove them — an embedder had
to wire the schedulers by hand. Following the `--slo-config` precedent (ADR-0227), this makes the
deployed process actually record DR readiness and run attestation campaigns on a cadence.

## Decision

Two config-driven lifecycles wired into `serve()`, each gated on a Postgres store (persistence needs the
connection) and started/stopped alongside the existing schedulers.

- **`--dr-readiness-config <path>`** → `dr-readiness.ts`: `DrReadinessConfigSchema` validates
  `{tenantId?, intervalMs?, input:{runbooks, backups, replication}}` (the declared, slow-changing DR
  infra, validated by the `@crossengin/dr` contract schemas). `buildDrReadinessLifecycle(conn, config)`
  builds a `buildPersistentDrRuntime` + a `DrReadinessScheduler` whose `assess` **folds the live
  failover/drill executions recorded through the API** (read back from Postgres via the stores) into the
  declared infra, assesses readiness, and persists a `dr_readiness_snapshots` row each tick — so the
  snapshot reflects real recorded DR activity, not a static repeat.
- **`--access-reviews-config <path>`** → `access-reviews-lifecycle.ts`: `AccessReviewsConfigSchema`
  validates `{systemActorUserId, campaigns, grants, principals, intervalMs?, assignReviewers?}`.
  `AccessReviewCampaignScheduler` (the `PruneScheduler` shape: `unref`'d timer, `onTick`/`onError`) each
  tick reads each campaign's **current persisted state**, starts the ones now due (materializing +
  persisting their items from the config's live grants), and plans + persists auto-revocations for
  in-progress campaigns whose items are un-attested past deadline — all through
  `buildPersistentAccessReviewRuntime`.

Both are `null` unless their flag is set; with a non-pg store the flag logs a warning and is skipped
(persistence requires the connection). Six packages join operate-server's deps
(`dr`/`dr-runtime`/`dr-runtime-pg`, `access-reviews`/`-runtime`/`-runtime-pg`).

## Consequences

- The deployed binary now *performs* the P8 safety behaviors, not just hosts the runtimes: DR readiness
  is snapshotted on a cadence against real recorded failovers/drills, and access-review campaigns run
  themselves — start, generate, escalate, auto-revoke — persisting a full attestation audit trail. This
  is the "GA means the safety mechanisms have run, not just compiled" criterion for these two loops.
- The DR lifecycle reading executions back from Postgres (rather than re-declaring them in config) means
  the config is only the stable infra topology; the volatile part (what failed over / what drilled)
  comes from the live system — the honest data source.
- The access-review scheduler keys off each campaign's *persisted* state (not the static config) per
  tick, so a campaign advances scheduled → in_progress → auto-revoke across ticks without re-starting.
- The lifecycle builders + scheduler tick are pure enough to unit-test (fake `PgConnection` for DR, an
  injected stub runtime for access-reviews, injectable timer + clock); the socket-binding `serve()` path
  stays offline-untestable, like the other schedulers.
- +17 operate-server tests. Full build + typecheck + workspace tests green. No META tables, no new
  package.
- Follow-ups (open): sourcing the access-review grant/principal set from `@crossengin/auth`'s live RBAC
  store instead of config; deriving DR infra from the deployment descriptor rather than a hand-written
  file; persisting DR readiness through the M8.5-style history for trend queries.
