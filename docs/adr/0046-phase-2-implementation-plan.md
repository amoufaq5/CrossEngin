# ADR-0046: Phase 2 implementation plan

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | Every prior ADR (this is the bridge) |

## Context

Phase 1 is essentially complete. 40 packages, 113 meta-schema tables, ~4,700 tests, 45 prior ADRs, zero type errors, zero placeholder code. Every concept that needs a typed record shape has one. Every state machine that needs transitions has them. Every audit chain that needs a sha256 has one declared.

But the entire repo today is **pure**. Nothing opens a socket, hits a database, runs cryptography, or starts a process. The kernel emits SQL strings; it does not apply them. The marketplace declares ed25519 signature shapes; it does not verify signatures. The api-gateway describes pipeline stages; it does not execute them. The workflow-engine has activity definitions; it does not schedule them.

This is by design — Phase 1 was about getting the *shape* of the platform right before committing implementation choices. That phase has paid off: we caught several mistakes in cross-package consistency (compensation strategies, classification propagation rules, four-eyes enforcement) at the type-checking step rather than at runtime debugging.

Phase 2 turns the contracts into a running system. This ADR defines the order, the milestones, the exit criteria for each, and the unifying architectural principles. It does **not** specify low-level implementation choices (Postgres extensions, Redis vs Memcached, Express vs Fastify) — those are per-milestone ADRs to come.

## Decision

Phase 2 ships in **eight milestones**, each ~1–2 months. Each milestone has a single exit-criterion (a demoable behavior) and one or more new ADRs that lock its specifics. The order is dictated by dependency — each milestone consumes what the previous one shipped.

### Milestone M1 — Kernel DDL execution

- **Goal.** `pnpm crossengin meta-schema apply` connects to a real Postgres, applies the 113 emitted CREATE TABLE / CREATE INDEX / ENABLE RLS / CREATE POLICY statements idempotently, and reports drift against a fresh `emitMetaBootstrapSql()` output.
- **What lands.** `@crossengin/kernel-pg` with a `pg`-backed `MigrationApplier`. `tools/cli` package gating the operation behind environment + dry-run + confirm. Drift detection against an existing schema via `pg_catalog` introspection.
- **Exit criterion.** A clean Postgres goes from empty to all 113 tables + RLS policies + indexes in one command. Re-running is a no-op. Removing a column from `meta-schema.ts` shows up in `drift report` as a deletion.
- **ADR.** ADR-0047 (DDL execution, Postgres extension requirements, migration locking).

### Milestone M2 — Real cryptography

- **Goal.** Every sha256/HMAC/ed25519 field in the meta-schema is populated by a real verifiable hash/signature, not a string.
- **What lands.** `@crossengin/crypto` with `libsodium-wrappers` (ed25519, BLAKE2b) + `node:crypto` (HMAC-SHA256, SHA-256). Per-tenant key management interface (returns key handles, not raw key material). Wired into `marketplace` (pack signing), `sdk` (webhook HMAC), `forensics` + `access-reviews` + `data-lineage` (evidence sealing), `tenant-lifecycle` (tombstones).
- **Exit criterion.** A marketplace pack with a corrupted byte fails signature verification at install time; an unmodified pack passes. A webhook with a wrong HMAC is 401. An evidence pack with a tampered sealedSha256 fails `Article15EvidencePack` re-validation.
- **ADR.** ADR-0048 (cryptography choices, key management interface, BYO-KMS support).

### Milestone M3 — Workflow engine runtime

- **Goal.** Workflow instances declared via `WorkflowDefinition` can be started, run activities, advance state, fire timers, receive signals, and produce a queryable `PipelineExecution`-like event history.
- **What lands.** `@crossengin/workflow-runtime` consuming the contracts from `@crossengin/workflow-engine`. Event-sourced state via the append-only event log. In-process executor first (deterministic, replayable); distributed executor (Postgres queue) as second step. Saga compensation actually runs.
- **Exit criterion.** A 4-state purchase-approval workflow declared in TypeScript runs end-to-end: emits 8+ event records, fires a timer-based escalation, accepts a manual_action signal, completes successfully, replays deterministically from the event log.
- **ADR.** ADR-0049 (workflow runtime semantics, in-process vs distributed, replay invariants).

### Milestone M4 — API gateway runtime

- **Goal.** The 17-stage pipeline declared in `@crossengin/api-gateway` runs as middleware. Auth → rate-limit → idempotency → route → dispatch → audit, all producing typed `PipelineExecution` records to the meta-schema.
- **What lands.** `@crossengin/api-gateway-runtime` with stage-by-stage middleware. JWT/HMAC verification calls into `@crossengin/crypto` (M2). Rate-limit + idempotency reads/writes via `@crossengin/kernel-pg` (M1). Adapter exports for Vercel Edge, Cloudflare Worker, and Node HTTP server.
- **Exit criterion.** A POST /v1/tenants request from an unauthenticated client returns 401 with the canonical `authentication_required` problem details; same request with a valid JWT but exceeded quota returns 429 with retry-after; replay of the same idempotency key returns the cached 201; pipeline executions are queryable per request.
- **ADR.** ADR-0050 (gateway runtime architecture, adapter shapes, stateful vs stateless deployments).

### Milestone M5 — First app: `apps/architect-cli`

- **Goal.** A real Node CLI that consumes the AI Architect contracts to author manifests via conversation. Smoke test that contracts compose into a working binary.
- **What lands.** `apps/architect-cli` with subcommands: `init`, `chat`, `validate`, `diff`, `patch`, `apply`. Reads/writes manifest files. Uses `@crossengin/ai-providers` (M2 has real provider clients via Anthropic SDK by now) to drive the conversation. Exits cleanly with non-zero on policy violations from `@crossengin/ai-architect`.
- **Exit criterion.** A developer runs `crossengin chat` from an empty directory; through conversation, produces a valid manifest; `crossengin apply` runs the kernel DDL emission against a local Postgres and persists the result.
- **ADR.** ADR-0051 (CLI design, terminal UX conventions, exit codes).

### Milestone M6 — Notifications + workflow signal bridge

- **Goal.** Notifications actually send. Workflows actually receive external signals. The notification dispatch records connect to provider clients (SendGrid, Twilio); workflow signals route from webhooks (validated by M4 gateway) to running instances (executed by M3).
- **What lands.** `@crossengin/notifications-runtime` with provider adapters. `@crossengin/workflow-runtime` extended with signal correlation that consumes webhook payloads. `@crossengin/integrations-runtime` for outbound provider calls with retry + circuit-break + observability.
- **Exit criterion.** A workflow waiting on `external.approve` signal advances when a partner POSTs to the signed webhook URL; rejected signature emits a `denied_rate_limit_exceeded`-style audit. A user receiving a notification dispatch gets a real email/SMS within the policy's latency budget.
- **ADR.** ADR-0052 (provider adapter shapes, retry/backoff contracts, outbound observability).

### Milestone M7 — First vertical manifest pack: Operate ERP — Retail F&B

- **Goal.** The first declarative app pack ships, exercising the manifest contracts against the running runtime. Pick Retail F&B (high commercial pull, well-understood domain).
- **What lands.** `manifests/operate-retail-fnb/` with entity manifests (Tenant, Outlet, Product, Order, Inventory, Payment), workflow definitions (order-to-receipt, daily-cashout), report definitions, dashboard definitions. Wired through every Phase 2 runtime. AI Architect can chat-modify the pack.
- **Exit criterion.** A new tenant created via the architect CLI applies the pack, gets a functional F&B ERP (entities, workflows, dashboards) backed by the meta-schema, in < 5 minutes of conversation.
- **ADR.** ADR-0053 (manifest pack distribution, signing & marketplace integration, upgrade paths).

### Milestone M8 — Observability + SLO enforcement

- **Goal.** The SLO definitions from `@crossengin/observability` are real. Error-budget burn is computed. Synthetic checks run. OTel traces flow from gateway → workflow → notifications. Incident response gets auto-paged on SLO violations.
- **What lands.** `@crossengin/observability-runtime` consuming OTel SDKs, Prometheus exporters, error-budget compute against the live request stream. Wired to `@crossengin/notifications-runtime` for SEV1 paging. `@crossengin/feature-flags-runtime` for emergency kill-switch activation.
- **Exit criterion.** A simulated 5xx burst on `POST /v1/orders` burns the SLO; a SEV2 incident is declared in `META_INCIDENTS`; the on-call rotation gets a notification; a kill-switch activation rolls the offending feature flag back to its safe value, all in <2 minutes.
- **ADR.** ADR-0054 (observability runtime, SLO compute, paging integration).

## Cross-cutting principles for Phase 2

These apply to every milestone:

1. **Runtime packages live next to their contract packages.** `@crossengin/workflow-engine` (contracts) gets a sibling `@crossengin/workflow-runtime` (impl). The contract package never depends on the runtime. The runtime depends on the contract for its types. This lets the contract be consumed by anything (browser, edge, server, eval) while the runtime is server-only.
2. **Provider clients behind interfaces.** Anthropic, OpenAI, Stripe, Twilio, SendGrid — every one of them sits behind an interface defined in the contract. A test double or a stub mocks the interface; production binds the real client. No package directly imports a vendor SDK.
3. **Deterministic functions stay pure.** The decision logic shipped in Phase 1 (`evaluateTokenBucket`, `decideJitOutcome`, `propagateClassification`, etc.) must stay byte-identical. The runtime calls these; it does not duplicate them.
4. **Audit-first.** Before a runtime acts, it writes the record. Before it commits the record, it computes the hash. Before it commits a side-effect, it computes the compensation. This means more writes than reads; we pay that cost gladly.
5. **No shortcuts in the gateway.** Every request goes through every stage in the canonical order. "Skip auth for internal calls" is a feature flag, not a code path.
6. **One package = one ADR.** The exit criterion ADR for each milestone covers its concrete runtime choices. We do not re-open old ADRs to add Phase 2 details — Phase 2 ADRs supersede where needed.

## Alternatives considered

- **Build the first vertical pack (Operate Retail F&B) first to validate contracts before runtime work.**
  - **Pros.** Earlier customer-facing demo.
  - **Cons.** Requires manual SQL execution, manual signature verification, manual workflow execution. The "vertical pack" becomes a partial fake that doesn't exercise the runtime.
  - **Why not.** The contracts are already validated by 4,700 tests + 45 ADRs. The runtime is the actual unknown.

- **Big-bang Phase 2 (build all 8 milestones in parallel).**
  - **Pros.** Faster calendar time.
  - **Cons.** Each milestone consumes the previous one. Cryptography needs DDL execution (key storage). Gateway needs cryptography (JWT). Workflow needs gateway (signals). Parallel work would either (a) duplicate work that gets thrown away or (b) leave packages with stub deps that need rewriting.
  - **Why not.** Strict dependency order keeps each milestone exit-criterion-shaped.

- **Skip the first app (`architect-cli`) and go straight to manifest pack.**
  - **Pros.** Smaller scope.
  - **Cons.** The architect CLI is the first end-to-end smoke test that contracts compose. Without it, the first manifest pack is the smoke test, and it's harder to debug a manifest issue than a CLI issue.
  - **Why not.** Architect CLI is the natural test-harness for "are the contracts usable."

- **Use a workflow framework (Temporal, Inngest) instead of building the runtime.**
  - **Pros.** Less work.
  - **Cons.** The contracts are already shaped for our specific semantics (saga compensation, four-eyes, classification propagation flowing through workflow variables). Adapting an external framework means bridging types, which loses the type safety.
  - **Why not.** We have the contracts; the runtime is mechanical. Worth the discipline cost.

## Consequences

- **Phase 2 is 8 milestones, ~1–2 months each, ~12 months total.** Each one is independently shippable; each one exits on a demoable behavior.
- **Eight new ADRs (0047-0054)** are coming. Each milestone is gated on the matching ADR being drafted before code starts.
- **Three new packages per milestone, average.** ~24 new packages by end of Phase 2 — most of them `*-runtime` siblings to existing `*` contract packages. Final state: ~65 packages.
- **The first commercial demo target is M7** — first vertical manifest pack running on the full runtime. That's the ~10-month mark from M1 start.
- **Phase 3 (after M8)** starts the multi-vertical expansion (Healthcare, Government, Education) on top of the stable runtime.

## Open questions

- **Q1:** Is the M1-through-M8 order rigid, or can M5 (architect CLI) slip earlier as a parallel track?
  - _Current direction:_ M5 needs M2 (real AI provider client) and M3 (workflow runtime to run AI Architect sessions properly). Can start prototyping after M2 lands but exit-criterion gating waits for M3.
- **Q2:** Do we need ADR-0046 super-cession of any Phase 1 ADRs?
  - _Current direction:_ No. Phase 1 ADRs describe contracts that stay valid. Phase 2 ADRs add execution semantics on top. Where conflicts arise (rare), the Phase 2 ADR is more specific and cites the older ADR but doesn't supersede.
- **Q3:** Should the workflow runtime ship in-process first or distributed first?
  - _Current direction:_ In-process first (M3 exit-criterion). Distributed deferred to M3.5 or M6. In-process is enough for the architect CLI + first manifest pack; distributed becomes necessary when load grows.
- **Q4:** Provider clients — Anthropic SDK only in M2, or all three (Anthropic, OpenAI, Google) at once?
  - _Current direction:_ Anthropic first (per ADR-0006 default). OpenAI + Gemini adapters in M2.5 (fast-follow). Multi-provider router from `@crossengin/ai-providers` activates when all three are bound.
- **Q5:** Marketplace pack distribution channel — bundled npm registry or separate signed CDN?
  - _Current direction:_ Out of scope for this ADR. Decided in ADR-0053 (M7 milestone ADR).

## References

- **The 45 Phase 1 ADRs** — every one of them. This ADR is the bridge.
- **CLAUDE.md** — current state snapshot showing 40 packages.
- **`docs/vision.md`** — north-star this Phase 2 is implementing.
