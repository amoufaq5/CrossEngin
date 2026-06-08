# ADR-0151: Gateway pipeline-execution drift CI gate (Phase 3 P2.42)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-08 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0050 (api-gateway-runtime — the 17-stage pipeline + PipelineExecution), ADR-0050/M4.6 (api-gateway-pg — GatewayReplayer + verifyPipelineExecutionShape), ADR-0135 (incident drift CI gate), ADR-0136 (PHI encryption CI gate), ADR-0145 (schema drift CI gate), ADR-0087 (apps/operate-server), ADR-0077 (Phase 3 plan) |

> **Numbering.** ADRs 0080–0085 remain reserved for Phase 3 P3–P8 (per
> ADR-0077). This is a P2 follow-on increment (P2.42).

## Context

`@crossengin/api-gateway-pg` ships `GatewayReplayer` — a typed read side over
`meta.gateway_pipeline_executions` with `verifyPipelineExecutionShape` /
`verifyExecution` / `bulkVerify` / `summarize`. The pure shape checks flag drift
in a persisted `PipelineExecution`: stages out of order, a stage repeated, the
final stage/outcome disagreeing with the last stage entry, a `pass` outcome that
carries a 4xx/5xx, a `deny` without a 4xx/5xx, a terminating outcome that isn't
last, an inconsistent total duration, and a `rateLimitDecisionId` that points at
no `meta.rate_limit_decisions` row. This is the gateway's exact counterpart to the
incident timeline (`incidents verify`, ADR-0135) and the SLO enforcement history
replayers — a symmetric write ↔ read+verify shape over an append-only audit
table.

But nothing GATES on the integrity of those persisted rows in CI. The
`integration` job already runs three self-policing gates — schema-drift
(ADR-0145), incident-drift (ADR-0135), and PHI-encryption (ADR-0136) — each a bin
that exits 1 on drift. The gateway-execution audit had no such gate; a regression
that began persisting malformed `PipelineExecution` rows (e.g. a `pass` recorded
with a 4xx status, an out-of-order stage sequence) would pass CI silently. P2.42
adds the fourth gate.

## Decision

- **A new `bin/crossengin-gateway-pg.ts`** in `@crossengin/api-gateway-pg` — the
  package had no CLI bin, so one was added (the package gained a `bin` entry and
  its `tsconfig` `rootDir` moved to `.` with `bin/**/*` included, mirroring
  `kernel-pg`; `main`/`types`/`exports` shifted to `dist/src/…` accordingly, a
  path-only change since every consumer imports via the package name through
  `exports`). The bin is a thin dispatcher: `crossengin-gateway-pg executions
  <verify|summary>` opens a `PgConnection` (`createNodePgConnection(
  parsePgEnvConfig())`), builds a `GatewayReplayer`, and runs the verify sweep —
  exactly the `crossengin-pg drift` / `incidents verify` contract.
- **The decision/exit logic lives in a tested `src/verify-runner.ts` module**, not
  the bin. `parseExecutionsArgs` (inline `--k=v` + spaced `--k v` forms,
  `CliUsageError` on misuse) produces resolved `ExecutionsCliOptions`;
  `runVerifyExecutions(options, source, out)` runs `source.bulkVerify(...)` over a
  structural `ExecutionVerifySource` (satisfied by `GatewayReplayer`) and **exits 1
  when any execution drifted** (`verify`) — `summary` reports the same counts but
  always exits 0. `summarizeExecutionReports` / `formatExecutionVerifyReport` fold
  the per-execution reports into clean/drifted/issue counts + per-issue lines.
  Offline-tested over a fake source (18 new tests).
- **A new `Gateway execution drift gate` step** in
  `.github/workflows/ci.yml`'s `integration` job, **after** the gated suites (so
  any executions they persist are populated), running `crossengin-gateway-pg
  executions verify --since 2000-01-01`. The bin `process.exit`s the exit code, so
  any drifted execution fails the job; an empty/clean table verifies clean (exit
  0). Reuses the job's `PG*` env + provisioned DB — no new service or fixture.

## The gate is vacuous today — and that is documented, not hidden

`GatewayRuntime.handleRequest` returns the `PipelineExecution` on its
`HandleResult`, but **it does not own an execution store** — persisting the
execution is the caller's responsibility. `apps/operate-server`'s
`OperateHttpServer.dispatch` consumes only the response and **discards the
execution**; `buildOperateGateway` wires no `PostgresPipelineExecutionStore`. So
the operate-server gated suite drives real requests through the gateway but
**writes nothing to `meta.gateway_pipeline_executions`** — the table is empty in
CI and the gate verifies clean vacuously.

This is wired deliberately anyway, for the same reason the incident-drift gate was
wired before the incident loop was fully exercised: the gate becomes
**non-vacuous the moment any consumer wires a `PostgresPipelineExecutionStore`
into the serving path** (operate-server's `dispatch` capturing
`result.execution` → `store.record(execution)`), with zero further CI changes.
The verify logic, the bin, and the gate are all proven now (offline tests + a
local bin smoke run); only the *population* is pending. The gate is correct on an
empty table and correct on a populated one — exactly the schema-drift gate's
posture (it ran green against a clean baseline before any drift existed to catch).

## Cross-cutting invariants enforced

- **Empty table passes.** `runVerifyExecutions` over a fake source returning `[]`
  → "verified 0 execution(s) … OK — no pipeline-execution drift", exit 0.
- **Any drift fails.** A single report with `drifted: true` → exit 1 (the gate
  fails the job); `summary` over the same reports → exit 0 (report-only).
- **Bin dispatch.** `crossengin-gateway-pg version` → exit 0; `help` → exit 0; an
  unknown command → exit 2 (`CliUsageError` → exit 2 in `main`'s catch). Validated
  locally.

## Alternatives considered

- **Skip the gate until executions are persisted.**
  - **Decision.** No — wiring the gate now (empty-table-clean) means the audit
    integrity check is in place the instant the population lands, mirroring how the
    incident/encryption gates were staged. The bin + verify-runner are reusable by
    any `meta.gateway_pipeline_executions` consumer regardless.
- **Add the bin to `apps/operate-server` instead of the package.**
  - **Decision.** No — the replayer + verify logic live in `api-gateway-pg`; the
    bin belongs beside them (any gateway-execution consumer can reuse it), exactly
    as `crossengin-pg drift` lives in `kernel-pg`.
- **Reuse the existing `crossengin-pg` bin.**
  - **Decision.** No — that bin lives in `kernel-pg` and has no dependency on
    `api-gateway` / `api-gateway-pg`; a dedicated bin keeps the dependency edge
    correct (the gateway replayer needs the gateway contracts).
- **Run in the offline `build-test` job.**
  - **Decision.** No — `bulkVerify` needs a live Postgres; it belongs in the
    `integration` job beside the suites that (will) write the rows.

## Consequences

- **62 packages + 3 apps, 124 meta-schema tables** (unchanged — no new package, no
  new table). `api-gateway-pg` gains a bin + `verify-runner` module + **18 new
  offline tests** (60 → 78 in the package). CI's `integration` job now runs a
  **fourth self-policing gate** beside schema-drift, incident-drift, and
  PHI-encryption — the gateway request-audit integrity check.
- **The gate is correct-but-vacuous today** (operate-server doesn't persist
  executions) and becomes non-vacuous the moment a `PostgresPipelineExecutionStore`
  is wired into the serving path — at which point every persisted `PipelineExecution`
  is shape-verified on every push/PR.
