# ADR-0152: RouterInstrumentation extends to embed() path — embed_call_started/completed/failed (Phase 2 M6.7.z.embed)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0141 (M6.7.z RouterInstrumentation + META_LLM_CALL_TRACES) |

## Context

ADR-0141 / M6.7.z shipped RouterInstrumentation for `DefaultLlmRouter.complete()`. Three event kinds: `llm_call_started`, `llm_call_completed`, `llm_call_failed`. Operators got first-class per-LLM-call audit trails for completion workloads. ADR-0141 Q2 deferred the embed path:

> Q2: `embed()` path instrumentation?
> _Current direction:_ Additive. New event kinds `embed_call_started/completed/failed`. Separate milestone.

The deferral made sense at the time — the `embed()` path doesn't go through the same retry-fallback loop as `complete()`, and instrumenting it needs a slightly different event shape (embeddings have `vectorCount` + `dim` instead of completion-text tokens). M6.7.z.embed closes that Q.

Operators lose three workflows without embed instrumentation:

1. **Cost attribution** for embedding-heavy applications (RAG ingest, semantic search). Embedding cost is small per call but accumulates across batch indexing.
2. **Failure diagnosis** for embedding rollouts. Did the new embedding model fail? Substrate has no signal.
3. **Provider comparison** for embedding latency. Operators choosing between `text-embedding-3-small` and `titan-embed-text-v2` need data.

## Decision

Three additions, mirroring the `complete()` instrumentation pattern from ADR-0141:

1. **Three new event kinds** in `ROUTER_INSTRUMENTATION_KINDS`: `embed_call_started`, `embed_call_completed`, `embed_call_failed`. Total kinds: 6.
2. **Wire instrumentation into `DefaultLlmRouter.embed()`.** Same lifecycle pattern: started before fetch (with attempt context), completed on success, failed per-provider with `willFallback` derived from the choice chain.
3. **Extend `META_LLM_CALL_TRACES.kind` CHECK constraint** additively to allow the new kinds. No migration needed for pre-existing data (still in the original 3 kinds).

### Event shapes

The `RouterInstrumentationEvent` interface stays unchanged (additive on kinds, not shape). Per-kind attributes differ:

**`embed_call_started`**:
```ts
{
  attemptIndex: number,
  totalChoices: number,
  inputTextCount: number,   // texts.length from the request
}
```

**`embed_call_completed`**:
```ts
{
  costUsd: number,
  inputTokens: number,
  outputTokens: number,     // typically 0 for embedding models
  cachedInputTokens: number,
  vectorCount: number,      // response.vectors.length
  dim: number,              // response.dim
  attempts: 1,
}
```

**`embed_call_failed`**:
```ts
{
  errorKind: string,
  errorMessage: string,
  willFallback: boolean,   // true if more providers remain in the choice chain
}
```

The `task` field on every event is hardcoded to `"embedding"` (the only task kind for the embed path).

### Why no `attempts` count > 1?

The `complete()` path supports retry-within-provider (the router wraps each provider invocation in `withRetry`). The `embed()` path doesn't retry within a provider — it just falls over to the next choice on retryable errors. So `attempts: 1` always on success; the `failed` event represents a single attempt that exhausted; fallback attempts produce additional `embed_call_started` events.

This matches the actual implementation behavior. Operators counting "how many provider tries did this embed take" count `embed_call_started` events with the same `(tenantId, sessionId, occurredAt)` correlation window.

### Handling missing sessionId

`EmbeddingRequest.sessionId` is OPTIONAL (unlike `CompletionRequest.sessionId` which is required). The instrumentation event's `sessionId` field is `string` (required). Three options:

- **(a)** Change the event interface to `sessionId: string | null`. Requires schema migration on `META_LLM_CALL_TRACES.session_id` to NULLable.
- **(b)** Use a sentinel value (e.g., `"<embed-no-session>"`).
- **(c)** Use empty string `""` when not provided.

**Decision: (c).** Empty string is a valid `NOT NULL` value that passes through PG cleanly. It surfaces in audit queries as an obvious "no session set" marker. Migration-free. Operators wanting strict sessionId tracking enforce it at their embed-call sites.

### Schema impact: META_LLM_CALL_TRACES.kind CHECK constraint

The 124th meta-schema table (`META_LLM_CALL_TRACES`) has:

```sql
check: "kind IN ('llm_call_started', 'llm_call_completed', 'llm_call_failed', 'embed_call_started', 'embed_call_completed', 'embed_call_failed')"
```

This is an additive extension of the original 3-value CHECK. No migration story needed for existing rows (still valid values).

### Why same shape as llm_*_call_* (not a separate event type)?

Alternative: introduce a new `EmbedInstrumentationEvent` interface distinct from `RouterInstrumentationEvent`. Cons:

- Two `onEvent` overloads on the `RouterInstrumentation` interface = consumer complexity.
- Two trace tables = duplicate retention story + duplicate operator dashboards.
- Same conceptual surface (per-call audit trace).

Pattern: same interface, discriminated via the `kind` enum. Consumers route on kind in their handler.

## Cross-cutting invariants enforced

- **Additive extension.** `ROUTER_INSTRUMENTATION_KINDS` grows from 3 → 6. No existing kinds removed/renamed.
- **Same event interface.** `RouterInstrumentationEvent` shape unchanged; only `kind` discriminator expanded.
- **No breaking change.** Existing `complete()` callers continue with the original 3 kinds. New embed events only flow when operators use `embed()`.
- **Noop default preserved.** `NoopRouterInstrumentation` continues as the default; operators opt in.
- **PG-side additive only.** CHECK constraint extension is non-breaking; existing rows valid.
- **Per-attempt granularity.** N embed attempts in a fallover scenario produce 2N events (started + completed/failed pair per attempt).
- **`willFallback` derived from choice index.** Same logic as `complete()` — terminal failures show `willFallback=false`.
- **Empty-string sessionId is the canonical "no session" marker on embed.**
- **`task: "embedding"` is always literal on these events.** Operators filter by task to separate complete vs embed dashboards.

## End-to-end semantic

```ts
import { DefaultLlmRouter, captureRouterInstrumentation } from "@crossengin/ai-router";
import { PostgresRouterInstrumentation } from "@crossengin/ai-router-pg";

const router = new DefaultLlmRouter({
  ...,
  instrumentation: new PostgresRouterInstrumentation({ conn }),
});

// Embed call emits start + completed (or start + failed[+start+completed/failed]):
const result = await router.embed({
  texts: ["hello", "world"],
  tenantId: "tenant-a",
  sessionId: "rag-ingest-job-42",
});

// Operator dashboards:
// 1. Embedding cost by provider over the last day
//   SELECT provider_id, SUM((attributes->>'costUsd')::NUMERIC) AS total_usd
//   FROM meta.llm_call_traces
//   WHERE kind = 'embed_call_completed' AND occurred_at > now() - INTERVAL '1 day'
//   GROUP BY provider_id;
//
// 2. Embedding failure rate per model in the last hour
//   SELECT model_id,
//          COUNT(*) FILTER (WHERE kind = 'embed_call_failed') AS failures,
//          COUNT(*) FILTER (WHERE kind = 'embed_call_completed') AS successes
//   FROM meta.llm_call_traces
//   WHERE occurred_at > now() - INTERVAL '1 hour' AND task = 'embedding'
//   GROUP BY model_id;
//
// 3. Average vectors-per-call by provider (efficiency comparison)
//   SELECT provider_id, AVG((attributes->>'vectorCount')::INTEGER) AS avg_vecs
//   FROM meta.llm_call_traces
//   WHERE kind = 'embed_call_completed'
//   GROUP BY provider_id;
//
// 4. Find all embed calls for a session
//   SELECT kind, provider_id, model_id, duration_ms, attributes
//   FROM meta.llm_call_traces
//   WHERE tenant_id = $1 AND session_id = 'rag-ingest-job-42'
//   ORDER BY occurred_at ASC;
```

The event sequences match `complete()`:

- Happy path: `embed_call_started → embed_call_completed`
- Fallover: `embed_call_started → embed_call_failed (willFallback=true) → embed_call_started → embed_call_completed`
- Terminal exhaustion: `embed_call_started → embed_call_failed (willFallback=true) → embed_call_started → embed_call_failed (willFallback=false)`
- Non-retryable first attempt: `embed_call_started → embed_call_failed (willFallback=false)`

## Alternatives considered

- **Introduce a separate `EmbedInstrumentation` interface.**
  - **Considered.** Type-distinct event shapes.
  - **Cons.** Two onEvent overloads, two trace tables, duplicate dashboards. Same conceptual concern.
  - **Decision.** Same interface; kind-discriminator.

- **Reuse `llm_call_*` kinds with `task: "embedding"` discriminator only.**
  - **Considered.** Fewer kinds.
  - **Cons.** Confuses operators reading traces — "is this an LLM call or an embed call?" The kind enum should be self-documenting; task discriminator is a secondary index.
  - **Decision.** Distinct kinds.

- **Make sessionId required on EmbeddingRequest.**
  - **Considered.** Type-system enforcement of session traceability.
  - **Cons.** Breaking change for existing callers. Many embedding workloads (one-shot reindex jobs, batch processing) don't have a natural session.
  - **Decision.** Keep optional; default to empty string in events.

- **Migrate META_LLM_CALL_TRACES.session_id to NULLable.**
  - **Considered.** Cleaner semantic for embed-without-session.
  - **Cons.** Schema change + migration. Empty string is a working sentinel without disruption.
  - **Decision.** Keep NOT NULL; empty string for embed-no-session.

- **Add `vectorCount` as a top-level event field (not in attributes).**
  - **Considered.** Type-safe access.
  - **Cons.** Specific to embed events; doesn't apply to llm_call_*. Top-level fields should be generic across kinds. Attributes is the right home for kind-specific data.
  - **Decision.** Keep in attributes.

- **Emit only `embed_call_completed` (skip started + failed).**
  - **Considered.** Reduce event volume.
  - **Cons.** Loses pre-fetch context (provider chosen, attempt index). Failed events disappear — operator dashboards lose failure-rate signal.
  - **Decision.** Three-event pattern, same as complete.

- **Coalesce embed_call_started + embed_call_completed into one event.**
  - **Considered.** Half the storage.
  - **Cons.** Lose the temporal split — operators can't tell when a call started vs finished. The complete-side already emits both; consistency wins.
  - **Decision.** Two events.

- **Add `outputTokens` only when > 0 (omit for embedding models that return 0).**
  - **Considered.** Less noise in attributes.
  - **Cons.** Operators filtering on attribute presence get inconsistent shapes. Always emitting fields keeps the contract uniform.
  - **Decision.** Always emit; value of 0 is information.

- **Per-text-count instrumentation (one event per text in the batch).**
  - **Considered.** Granular cost attribution per text.
  - **Cons.** N×N events for batched ingestion. Operators can compute per-text cost from `costUsd / inputTextCount`. Substrate stays at request granularity.
  - **Decision.** Per-call events. The `inputTextCount` attribute exposes the batch size.

## Consequences

- **56 packages + 1 app, 127 meta-schema tables, 8,003 tests** (+12 from M6.7.z.embed: all in `router.test.ts`). All green, zero type errors. Crossed the 8K-test threshold.
- **Closes ADR-0141 Q2.**
- **`ROUTER_INSTRUMENTATION_KINDS` grows 3 → 6.** Three llm kinds + three embed kinds.
- **META_LLM_CALL_TRACES.kind CHECK constraint extended additively.** Six values now allowed.
- **Embedding workflows have full audit trails.** Cost attribution, failure diagnosis, provider comparison all unblocked.
- **No breaking change.** Existing complete-only callers unaffected.
- **Empty-string sessionId semantic established.** Documents the "embed without session" case as a first-class data shape.

## Open questions

- **Q1:** Should sessionId become NULL-able on the event interface (with a coordinated schema migration)?
  - _Current direction:_ Empty string is working. If real-world dashboards struggle with the empty marker, revisit.
- **Q2:** Should there be a `BedrockControlPlaneInstrumentation` for control-plane mutations (createPT, tagResource, etc.)?
  - _Current direction:_ Out of scope. Distinct domain (control-plane vs LLM-call). Future ADR.
- **Q3:** Should embed traces also write to a separate `meta.llm_embed_traces` table for separation of concerns?
  - _Current direction:_ No — single table avoids dashboard splitting + retention duplication. The `kind` discriminator suffices.
- **Q4:** Should the substrate add a `texts.length` upper bound for huge batches (e.g., 1000+) to protect cost?
  - _Current direction:_ Out of scope for instrumentation. The router doesn't validate embed input shape; cost-ceiling enforcement (M6.7.x) is the right surface.
- **Q5:** Should `embed_call_completed` include a `vectorByteSize` attribute (vectors are large)?
  - _Current direction:_ Computable from `vectorCount * dim * 4` (32-bit floats). Additive if operator demand exists.
- **Q6:** Should the substrate emit a `embed_call_quota_warning` event when approaching a per-tenant embedding cost ceiling?
  - _Current direction:_ Cost-ceiling enforcement happens in M6.7's preflight; that path throws CostCeilingExceededError BEFORE the embed call. A warning kind would need a new instrumentation rail.
- **Q7:** Should `embed_call_started` capture the `model` field from the request (operator-requested model vs router-chosen model)?
  - _Current direction:_ The event's `modelId` is router-chosen. Operator-requested would be additive (`requestedModelId` attribute). Defer unless real-world need.
- **Q8:** Should embed instrumentation respect a per-call instrumentation kill switch (e.g., `EmbeddingRequest.instrumentation?: false`)?
  - _Current direction:_ Operator-side wrap — they can swap instrumentation in/out at construction. No per-call flag.
