# ADR-0120: Workflow runtime instrumentation hooks + META_WORKFLOW_TRACES (Phase 2 M8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0043 (workflow-engine), ADR-0046 (Phase 2 plan), ADR-0061 (workflow-runtime M3), ADR-0083 (workflow-runtime-pg) |

## Context

`@crossengin/workflow-runtime` (M3 / ADR-0061) ships an event-sourced executor that emits authoritative `WorkflowEvent`s into `meta.workflow_events`. Those events are the source of truth for state — projection rebuilds instance state from them deterministically. But the schema is optimized for state recovery, not for observability:

- All events for an instance share the same row shape. Querying "how many state transitions happened across all tenants this hour?" requires scanning every row's payload JSON.
- No engine-internal events surface (e.g., "step loop ran N iterations", "instrumentation backend itself failed").
- Latencies aren't tracked.
- Operator-defined custom signals can't piggyback on the engine's event log because that table's schema constrains the `kind` column to a fixed enum.

OpenTelemetry-style instrumentation is the standard way to address this gap. M8 adds a `WorkflowInstrumentation` hook interface to the engine + a Postgres-backed implementation that writes traces to a new `META_WORKFLOW_TRACES` table. Operators can wire either the PG sink, a custom OTel exporter, or both in parallel via `combineInstrumentations`.

## Decision

Four surface changes, in three packages.

### 1. `@crossengin/workflow-runtime` — new `instrumentation.ts`

```ts
export const WORKFLOW_INSTRUMENTATION_KINDS = [
  "instance_started", "instance_completed", "instance_failed",
  "instance_cancelled", "state_transitioned", "signal_received",
  "signal_consumed", "timer_fired", "activity_scheduled",
  "action_applied", "engine_error",
] as const;

export interface WorkflowInstrumentationEvent {
  readonly kind: WorkflowInstrumentationKind;
  readonly tenantId: string;
  readonly instanceId: string | null;
  readonly definitionId: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
  readonly durationMs: number | null;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface WorkflowInstrumentation {
  onEvent(event: WorkflowInstrumentationEvent): Promise<void> | void;
}
```

Companion exports:
- `NoopInstrumentation` — default fallback.
- `captureInstrumentation()` — in-memory buffer for testing.
- `combineInstrumentations(...children)` — fan-out to multiple sinks; sequential await; returns the noop for empty input or the single child when one is given.
- `isWorkflowInstrumentationKind(value)` — discriminator.

### 2. `@crossengin/workflow-runtime` — engine wiring

`EngineOptions` gains `instrumentation?: WorkflowInstrumentation`. Default: `NoopInstrumentation`.

A private `emitInstrumentation(kind, fields)` helper:
- Builds the typed event with `occurredAt` from the engine clock.
- Routes through `this.instrumentation.onEvent`.
- **Swallows exceptions** — instrumentation failures must NEVER crash the engine. Errors land in the noop sink as `engine_error` events with `source: "instrumentation"` + the original event kind + the error message.

Instrumentation calls land at 8 key engine paths:
- `startInstance` → emits `instance_started`.
- `submitSignal` → emits `signal_received` then `signal_consumed`.
- `tickTimers` → emits `timer_fired` per fired timer.
- `cancelInstance` → emits `instance_cancelled`.
- `applyTransition` → emits `state_transitioned`.
- `applyScheduleActivity` → emits `activity_scheduled`.
- `emitTerminalForStateKind` → emits one of `instance_completed` / `instance_failed` / `instance_cancelled` based on terminal kind. Guarded by a `Set<string>` against double-emission when `runStepLoop` re-enters.

Internal state widened to track `instanceDefinition: Map<instanceId, definitionId>` so instrumentation events can carry the definition ID even for signal-triggered transitions on rehydrated instances. `registerInstance(...)` gains an optional `definitionId` parameter.

### 3. `@crossengin/kernel` — `META_WORKFLOW_TRACES` table

```
meta.workflow_traces (
  id              UUID PK
  tenant_id       UUID NOT NULL → tenants
  instance_id     UUID → workflow_instances ON DELETE CASCADE
  definition_id   UUID → workflow_definitions ON DELETE SET NULL
  kind            TEXT CHECK (kind IN (...11 values...))
  occurred_at     TIMESTAMPTZ NOT NULL
  duration_ms     INTEGER CHECK (>= 0 OR NULL)
  correlation_id  TEXT
  attributes      JSONB DEFAULT '{}'
  created_at      TIMESTAMPTZ DEFAULT now()
)
```

Three indexes:
- `(instance_id, occurred_at)` — single-instance trace timeline queries.
- `(tenant_id, kind, occurred_at)` — "show all state_transitioned events in the last hour for tenant X" queries.
- `(tenant_id, correlation_id)` — saga-level correlation lookups.

RLS: tenant isolation via the standard `TENANT_ISOLATION_USING` policy.

Distinct from `meta.workflow_events`:
- `workflow_events` is the state source-of-truth. Sequence-numbered. Immutable. Schema rigid.
- `workflow_traces` is observability-only. Indexed for time-series queries. Schema friendly to future additions via JSONB attributes.

Table count: **119 → 120**.

### 4. `@crossengin/workflow-runtime-pg` — `PostgresWorkflowInstrumentation`

```ts
export class PostgresWorkflowInstrumentation implements WorkflowInstrumentation {
  async onEvent(event: WorkflowInstrumentationEvent): Promise<void> {
    const instanceUuid = event.instanceId === null
      ? null
      : await this.instanceResolver.resolve(event.instanceId);
    const definitionUuid = event.definitionId === null
      ? null
      : await this.definitionResolver.resolve(event.definitionId);
    await this.conn.query(
      `INSERT INTO meta.workflow_traces (...)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [...]
    );
  }
}
```

`buildPersistentEngine` gains two new optional inputs:
- `instrumentation?: WorkflowInstrumentation` — direct instrumentation hook (overrides `persistTraces`).
- `persistTraces?: boolean` — when `true`, auto-constructs a `PostgresWorkflowInstrumentation` against the same connection + resolvers.

`resolveInstrumentation` precedence:
1. `instrumentation` explicit → use it.
2. `persistTraces: true` → auto-construct PG sink.
3. Neither → engine uses `NoopInstrumentation` internally.

## Cross-cutting invariants enforced

- **Observability never crashes the engine.** `emitInstrumentation` wraps `onEvent` calls in try/catch.
- **No state pollution.** Traces write to a separate table; the source-of-truth event log is untouched.
- **Pluggable sinks.** Operators can provide any `WorkflowInstrumentation` implementation (OTel exporter, structured logger, custom DB writer); the PG sink is one option.
- **Fan-out supported.** `combineInstrumentations(pgSink, otelSink, ...)` for multi-target deployments.
- **Terminal events de-duplicate.** Guard against double-emission when `runStepLoop` re-enters after a terminal state.
- **Backwards compat preserved.** All pre-M8 engine tests pass without modification. Default behavior (no `instrumentation` argument) is identical to pre-M8 — `NoopInstrumentation` swallows.
- **Per-tenant isolation at the DB layer.** RLS policy keeps trace rows scoped to the writing tenant.

## End-to-end semantic

```ts
import { buildPersistentEngine } from "@crossengin/workflow-runtime-pg";
import { combineInstrumentations } from "@crossengin/workflow-runtime";

// Sink 1: Postgres traces (META_WORKFLOW_TRACES).
// Sink 2: Custom OpenTelemetry exporter.
const otelSink: WorkflowInstrumentation = {
  async onEvent(e) {
    span.addEvent(e.kind, {
      "tenant.id": e.tenantId,
      "instance.id": e.instanceId,
      "definition.id": e.definitionId,
      ...e.attributes,
    });
  },
};

const { engine } = buildPersistentEngine({
  conn, definitions,
  persistTraces: true,                         // writes meta.workflow_traces
  instrumentation: combineInstrumentations(    // ...AND exports to OTel
    new PostgresWorkflowInstrumentation({ conn }),
    otelSink,
  ),
});

// Engine runs unchanged from the operator's perspective.
const { instanceId } = await engine.startInstance({
  definitionId: "wfd_purchase_v1",
  tenantId: "ten-x",
  correlationKey: "po-2026-05-19-001",
});
// Both sinks received instance_started + state_transitioned events.
```

## Alternatives considered

- **Reuse `meta.workflow_events` for observability.**
  - **Considered.** One table; simpler operationally.
  - **Cons.** That table is the state source-of-truth; its constraints (sequence numbers, kind enum, schema validation) reject anything that doesn't fit the engine's authoritative event vocabulary. Adding instrumentation rows would either pollute the enum (breaking event-sourcing replay) or require dual-purpose row interpretation.
  - **Decision.** Separate table.

- **Emit one instrumentation event per WorkflowEvent (auto-mirror).**
  - **Considered.** Trivially complete coverage.
  - **Cons.** Wastes capacity on events operators don't care about (e.g., per-variable updates). The 11 documented instrumentation kinds capture what operators actually need for monitoring.
  - **Decision.** Explicit hand-picked kinds.

- **Make `instrumentation.onEvent` throw on error and let the engine propagate.**
  - **Considered.** Operators want to know when their observability backend is down.
  - **Cons.** Observability failures must not crash workflows. The engine swallows + emits an `engine_error` event for the operator's own monitoring stack to catch.
  - **Decision.** Swallow.

- **Single global instrumentation singleton.**
  - **Considered.** Less ceremony in calling code.
  - **Cons.** Multi-tenant deployments need different sinks per tenant; multi-test test suites need isolation.
  - **Decision.** Per-engine option.

- **Sync `onEvent` only (no async).**
  - **Considered.** Simpler engine integration.
  - **Cons.** Sinks that flush to network (OTel collectors, remote DBs) need async. Sync would force batching at the sink layer.
  - **Decision.** `Promise<void> | void`. Engine awaits.

- **Schema-validated `attributes` JSONB.**
  - **Considered.** Catch typos at write time.
  - **Cons.** Schema would be perpetually stale as kernel kinds grow. JSONB queries already work; consumers project the fields they care about.
  - **Decision.** Free-form JSONB.

- **Auto-derive `correlationId` from instance metadata when missing.**
  - **Considered.** Operators forget to set correlationKey.
  - **Cons.** Hidden defaulting masks bugs in the operator's signal-routing logic.
  - **Decision.** Pass `correlationId` through verbatim; null if not set.

- **Emit `instance_started` AFTER the event-log append (so instance UUID exists before trace tries to resolve it).**
  - **Considered.** Cleaner FK chain.
  - **Cons.** Race window where the workflow's event-sourced state has the start but the observability layer hasn't seen it. Operators want the trace BEFORE the persistent state for "we attempted to start" semantics — useful when subsequent appends fail.
  - **Decision.** Trace first, then state. `PostgresWorkflowInstrumentation` tolerates resolver misses (writes `null` for missing UUIDs).

## Consequences

- **55 packages + 1 app, 120 meta-schema tables, 7,283 tests** (+31 from M8: 9 instrumentation unit + 9 engine integration + 10 PG instrumentation unit + 3 PG persistent-engine wiring + 2 kernel meta-schema). All green, zero type errors.
- **First production-grade observability surface for workflows.** Operators can build dashboards, alerts, OTel exports without touching the source-of-truth event log.
- **Engine remains backwards-compatible.** Existing code that doesn't pass `instrumentation` continues to work — `NoopInstrumentation` is the silent default.
- **PG sink is opt-in.** `buildPersistentEngine({persistTraces: true})` enables Postgres tracing; omit for engines that route through external observability stacks only.
- **OTel-ready.** The event shape is intentionally a subset of OTel `SpanEvent` — operators can write a thin OTel-export adapter in ~20 lines.
- **Meta-schema count: 119 → 120.** First new META table since M4.10's `META_GATEWAY_ROUTES.source_pack` column addition.
- **Module count: workflow-runtime gains 1 (instrumentation.ts); workflow-runtime-pg gains 1 (instrumentation.ts).**
- **Workflow runtime depth gap closed.** After 35+ M2.X / chat / Bedrock iterations, the workflow runtime now has a first-class observability story.

## Open questions

- **Q1:** Should `META_WORKFLOW_TRACES` have a retention policy?
  - _Current direction:_ Operators set their own. Future ADR could add a built-in `cleanup_workflow_traces(older_than)` SQL function.
- **Q2:** Should `WorkflowInstrumentation` also emit `engine_started` / `engine_stopped` lifecycle events?
  - _Current direction:_ Not yet. The engine doesn't have explicit lifecycle methods today.
- **Q3:** Should activity execution be instrumented (started / completed / failed)?
  - _Current direction:_ `activity_scheduled` is emitted today. `activity_started` / `activity_completed` / `activity_failed` are noted as candidates — defer to a follow-up.
- **Q4:** Built-in OpenTelemetry exporter (`OTelWorkflowInstrumentation`) in workflow-runtime?
  - _Current direction:_ Out of scope. Operators wire their own `WorkflowInstrumentation` adapter against their preferred OTel SDK.
- **Q5:** Should `combineInstrumentations` run children in parallel instead of sequentially?
  - _Current direction:_ Sequential. Determinism > marginal latency; if a sink is slow, that's a sink problem.
- **Q6:** Trace sampling (drop 99% of state_transitioned events for high-throughput workflows)?
  - _Current direction:_ Sampling is the sink's responsibility. The engine emits everything; sinks decide what to persist.
- **Q7:** Query-helper API for reading traces by instance / correlation / time range?
  - _Current direction:_ Operators use SQL directly. A `MetaWorkflowTraceQuery` class could land in a follow-up ADR if call-site patterns coalesce.
