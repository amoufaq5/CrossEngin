# ADR-0153: serving PipelineExecution persistence — making the gateway-execution gate non-vacuous (Phase 3 P2.45)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0151 (gateway-execution drift gate / verify-runner), ADR-0050 (api-gateway-runtime), ADR-0087 (apps/operate-server), ADR-0086 (operate-runtime-pg), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.45).

## Context

P2.42 (ADR-0151) shipped the **gateway-execution drift gate**:
`crossengin-gateway-pg executions verify` runs `GatewayReplayer.bulkVerify`
over `meta.gateway_pipeline_executions` and exits 1 on any drifted persisted
`PipelineExecution`. But `apps/operate-server` did **not** persist its
executions — `GatewayRuntime.handleRequest` *returns* the `PipelineExecution` on
its `HandleResult`, and `OperateHttpServer.dispatchWithMatch` read only
`execution.routeOperationId` (for SLO surface attribution) and discarded the
rest. So the gate verified an **empty table** (exit 0, vacuously) — documented
as such in `ci.yml` + ADR-0151.

`@crossengin/api-gateway-pg` already ships `PostgresPipelineExecutionStore`
(`INSERT … ON CONFLICT (request_id) DO NOTHING` over
`meta.gateway_pipeline_executions`). The missing piece was a seam to hand it the
execution from the serving path.

## Decision

**Seam: a structural execution sink on `OperateHttpServer`, invoked by the
serving binary** — *not* a `GatewayRuntimeOptions` change.

The `GatewayRuntime` is the lower, framework-neutral layer; it already surfaces
the execution on `HandleResult` and has no store dependency. Adding a sink there
would push a persistence concern down into the pure runtime. The execution is
discarded one layer up (`OperateHttpServer.dispatchWithMatch`), so that is the
correct, lowest-churn place to record it.

- **`operate-server/src/server.ts`.**
  - **`ExecutionSink` interface** — `{ record(execution: PipelineExecution):
    Promise<void> }`; `PostgresPipelineExecutionStore` already satisfies it
    structurally (its `record(execution)` matches).
  - **`OperateHttpServer`** gains an optional `executionSink` +
    `onExecutionSinkError`. `dispatchWithMatch` `await`s `executionSink.record`
    after building the response; a record failure is routed to
    `onExecutionSinkError` (default: stderr) and **never breaks the served
    response** (try/catch around the sink call only). The 405 unknown-method
    path short-circuits before the gateway runs, so it records nothing (there is
    no execution).
  - **`buildOperateHttpServer`** threads `executionSink` / `onExecutionSinkError`
    through, and also exposes an optional **`rateLimitChecker`** (the gateway
    already supported it) so a Postgres-backed checker can persist its decisions.
- **`operate-server/src/node.ts` — `serve()` under `--persist-executions`.**
  Opens a dedicated `PgConnection` (`parsePgEnvConfig()`), builds a
  `PostgresPipelineExecutionStore` as the `executionSink`, **and** a
  `PostgresRateLimitChecker` so a persisted execution's `rateLimitDecisionId`
  resolves to a real `meta.rate_limit_decisions` row (otherwise the replayer's
  `rate_limit_decision_not_found` check would flag every execution that reached
  the rate-limit stage — the default in-memory checker emits an ephemeral
  `rld_…` id no row backs). The connection is closed on shutdown.
- **CLI.** `--persist-executions` (opt-in, default off; works with any
  `--store`, opens its own PG connection from the standard `PG*` env vars).

## Cross-cutting invariants enforced (by tests)

- **Wiring (offline, `server.test.ts`).** A fake `ExecutionSink` captures one
  `PipelineExecution` per dispatched request (`finalStage: emit_audit`, the
  `routeOperationId` matches); a denied (401) request still records its
  `deny`-outcome execution; an unknown method (405) records nothing; a sink that
  rejects is routed to `onExecutionSinkError` and the response is still 200.
- **CLI (offline, `cli.test.ts`).** `--persist-executions` parses (default
  `false`).
- **Real-PG (gated, `integration-executions.test.ts`).** Drives a create
  (201/pass), list (200/pass), RBAC denial (403/deny), and auth failure
  (401/deny) through the real gateway with the sink + Postgres rate-limit checker
  wired in; asserts (a) every request's row landed in
  `meta.gateway_pipeline_executions`, and (b) `GatewayReplayer.bulkVerify` over a
  wide window finds them and reports **NO drift** — i.e. the P2.42 gate is now
  **non-vacuous and passes on real persisted executions**. (`crossengin-gateway-pg
  executions verify --since 2000-01-01` over the same populated table reports
  `8 clean, 0 drifted`, exit 0.)

## Alternatives considered

- **Add a `pipelineExecutionStore` to `GatewayRuntimeOptions` and auto-record.**
  - **Decision.** No. It pushes a persistence concern into the pure,
    framework-neutral runtime (which every consumer shares) and would re-record on
    every `HandleResult` path. The serving binary already owns the execution; the
    sink belongs at that boundary.
- **Fold persistence under `--store pg`/`pg-columns` (no separate flag).**
  - **Decision.** No. Execution audit and entity storage are independent
    concerns — a deployment may want execution persistence with an in-memory
    store (or vice-versa). A dedicated `--persist-executions` flag + connection
    keeps them orthogonal (mirrors `--slo-persist`).
- **Persist executions but keep the in-memory rate-limit checker.**
  - **Decision.** No. The execution carries the checker's `decisionId`; with the
    in-memory checker that id backs no row, so the replayer's
    `rate_limit_decision_not_found` check would flag every rate-limited execution
    → the gate would fail. Wiring `PostgresRateLimitChecker` alongside keeps the
    persisted executions drift-clean. (Its `principal_id → meta.users` FK means
    rate-limit persistence assumes the api-key/JWT principals correspond to real
    users — true in a real deployment; the gated test seeds them.)

## Consequences

- **The P2.42 gateway-execution drift gate is now meaningful.** The moment
  operate-server runs with `--persist-executions`, `meta.gateway_pipeline_executions`
  carries real rows and `crossengin-gateway-pg executions verify` audits them
  (still exit 0 on a clean run; exit 1 the instant a persisted execution drifts).
  The gate stays exit-0 on an empty table for deployments that don't enable
  persistence.
- No new packages, apps, meta-schema tables, or columns
  (`META_GATEWAY_PIPELINE_EXECUTIONS` + `META_RATE_LIMIT_DECISIONS` already
  exist). `apps/operate-server` gains a dependency on `@crossengin/api-gateway-pg`.
- Per-request gateway audit is now durable + queryable by tenant / correlationId
  / time, joining the SLO-incident (P2.32) and entity (P1.6) persistence the
  serving app already has.
