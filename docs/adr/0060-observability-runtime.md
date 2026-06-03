# ADR-0060: Observability + SLO enforcement runtime (Phase 2 M8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-06-02 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0046 (Phase 2 plan, M8), ADR-0037 (incident response), ADR-0045 (feature-flags runtime), ADR-0039 (notifications), ADR-0044 (api-gateway lifecycle) |

## Context

`@crossengin/observability` defines the *shape* of SLOs (`SloSchema` with availability / latency / incident targets), alert policies + routes + rules, synthetic checks, and W3C trace context. But the definitions are inert: nothing computes error-budget burn, nothing decides when a burn warrants paging, nothing ties a burn to a declared incident, an on-call page, or a feature-flag kill switch. M8 is the last milestone in the Phase 2 plan (ADR-0046) and its exit criterion is a closed enforcement loop:

> A simulated 5xx burst on `POST /v1/orders` burns the SLO; a SEV2 incident is declared in `META_INCIDENTS`; the on-call rotation gets a notification; a kill-switch activation rolls the offending feature flag back to its safe value, all in <2 minutes.

Three constraints shaped the design:

1. **Pure runtime, no sockets.** Like `@crossengin/workflow-runtime` (M3) and `@crossengin/ai-router` (M6.5), the M8 runtime is in-process and deterministic — it consumes contracts and produces records. It does not open OTel exporters, push to PagerDuty, or write to Postgres. Persistence is a future `observability-runtime-pg` sibling (M8.5); paging delivery rides the existing notifications dispatch path. The runtime's job is the *decision*, expressed as schema-valid records the rest of the platform already knows how to persist and deliver.

2. **Compose existing contracts, don't fork them.** A breach declaration is an `IncidentRecord` from `@crossengin/incident-response` (→ `META_INCIDENTS`). A rollback is a `KillSwitch` from `@crossengin/feature-flags`. A page is an `AlertRouteResolution` from `@crossengin/observability`. The runtime builds these via their own zod schemas, so every emitted artifact is valid by construction — `IncidentRecordSchema.parse` / `KillSwitchSchema.parse` run inside the planners.

3. **Multi-window burn-rate alerting (Google SRE).** A single threshold either pages on noise (too sensitive) or misses slow burns (too lax). The runtime evaluates each threshold over a long *and* a short window and fires only when both exceed the burn-rate multiplier — fast detection without flapping.

## Decision

`@crossengin/observability-runtime` exports **7 modules** plus an index. It depends on `@crossengin/observability`, `@crossengin/incident-response`, `@crossengin/feature-flags`, and `zod`. **No new META_ tables** — it emits records typed by existing contracts.

### `clock.ts` — time + duration parsing

- `Clock` interface (`now()` / `nowMs()` / `nowIso()`), `SystemClock`, `FixedClock` (advance / set, refuses to move backward, never leaks its internal `Date`).
- `parseDurationMs("5m" | "1h" | "6h" | "30d" | "2w")` — the unit grammar (`s/m/h/d/w`) the burn-rate windows speak.

### `window.ts` — request-outcome ingest + rolling counts

- `RequestOutcomeSchema` — `{surface, outcome: ok|error, at, statusCode?, latencyMs?}`. A `superRefine` rejects a 5xx `statusCode` reported as `ok` (a 4xx may still be `ok` — client error isn't a server SLO miss).
- `RollingWindow` — per-surface in-memory sample buffer. `record()`, `count(surface, windowMs, now)` returns `{total, failed}` over `[now-windowMs, now]`, `prune(now)` drops samples past retention (default 24 h), bounded by `maxSamplesPerSurface` (default 100k). `failureRate(counts)` helper.

### `burn-rate.ts` — multi-window burn-rate evaluation

- `BurnRateThresholdSchema` — `{id, longWindow, shortWindow, burnRateMultiplier, severity, minSamples, description?}`. A `superRefine` requires `shortWindow` strictly shorter than `longWindow`. `severity` is the incident-response `Severity` (sev1..sev5).
- `DEFAULT_BURN_RATE_THRESHOLDS` — fast-burn (1h/5m @ 14.4×, sev2, ≥20 samples) and slow-burn (6h/30m @ 6×, sev3, ≥50 samples), the canonical SRE pair for a 30-day budget.
- `burnRate(target, counts)` = `failureRate / (1 - target)`. `1` means "burning budget exactly at the sustainable rate"; `14.4` means "burning 14.4× too fast". `target === 1` yields `Infinity` on any failure.
- `evaluateThreshold(target, measure, threshold)` — fires when *both* windows clear the multiplier *and* the long window has `≥ minSamples` (suppresses cold-start noise). `measure: (windowMs) => WindowCounts` is a closure, so the pure evaluator is testable without the `RollingWindow`.
- `evaluateBurnRate(target, measure, thresholds)` — runs every threshold, returns the highest-severity firing one as the `BurnRateVerdict` (`breached`, `worstSeverity`, `worstThresholdId`, full `evaluations[]`).

### `synthetics.ts` — synthetic-probe failure tracking

- `SyntheticResultSchema` — `{checkId, region, outcome: pass|fail, at, latencyMs?, detail?}`.
- `consecutiveFailures(results)` counts trailing fails; `evaluateSynthetic(decl, results)` compares against the declaration's `alertAfterConsecutiveFailures` (composing `SyntheticCheckDeclaration` from the contract package).
- `SyntheticTracker` — per-check ring buffer + `evaluate(decl)`.

### `enforcement.ts` — pure planners (the heart)

- `SEVERITY_TO_ALERT_SEVERITY` maps incident-response severity → observability alert severity (sev1→P0 … sev5→P3); `alertSeverityFor()`.
- `formatIncidentId(year, seq)` → `INC-YYYY-NNNN`; `formatKillSwitchId(seq)` → `fks_auto00000001` (both match the contract regexes).
- `FlagRollbackSchema` — `{flagId, safeValueJson}` with a valid-JSON refine.
- `planIncidentDeclaration(input)` → a **declared** `IncidentRecord` (one timeline entry, `autoDeclared: true` metadata; declared status needs no role assignments yet). `IncidentRecordSchema.parse` guarantees validity.
- `planPageDirective(policy, severity, incidentId)` → resolves the alert route for the mapped severity, or `null` if the policy has no route.
- `planKillSwitchActivation(input)` → a **triggered_active** `KillSwitch` with `triggerKind: automated_metric_breach` (not four-eyes-gated, so a system actor can flip it without a human co-signer), `relatedIncidentId` set, `overriddenValueJson` = the safe value.
- `EnforcementPlan = {incident, pages[], killSwitch | null}`.

### `tracing.ts` — span collection across services

- `RecordedSpanSchema` — `{context: SpanContext, name, kind, service, startMs, endMs, status, attributes}` (refine: `endMs ≥ startMs`).
- `childContext(parent, spanId)` links a child to its parent (same `traceId`, `parentSpanId = parent.spanId`, inherited `sampled`).
- `TraceCollector` — `record()` (validates), `buildTree(traceId)` (stitches a gateway → workflow → notifications tree), `traceDurationMs()`, `hasError()`, `services()`. This is the OTel-trace-flow piece of the exit criterion.

### `engine.ts` — `SloEnforcementEngine`

Constructor takes `{alertPolicy, systemActorUserId, registrations[], thresholds?, clock?, declaredBy?, window?}`. Each `SloRegistration` pairs an `Slo` with an optional incident `category`, an optional `FlagRollback`, and an optional `tenantId`.

- `recordOutcome(outcome)` feeds the rolling window.
- `evaluate(now?)` walks every registration: finds the availability target (skips SLOs without one), evaluates the burn rate against the window, and:
  - **breach + not active** → `openBreach`: mint an incident id + (if a rollback is configured) a kill-switch id, build the full `EnforcementPlan`, mark the surface active, emit `breach_opened`.
  - **breach + already active** → `breach_ongoing` (no duplicate incident).
  - **no breach + active** → clear the surface, emit `recovered` (carrying the incident + kill-switch ids so the consumer can close the incident and release the switch).
- Incident sequence + kill-switch sequence are monotonic per engine; the year comes from `now`.

### `index.ts` — re-exports all seven modules.

## Cross-cutting invariants enforced

- **Every emitted record is valid by construction.** Planners call `IncidentRecordSchema.parse` / `KillSwitchSchema.parse`; an invalid plan throws at build time, never reaches the consumer.
- **One incident per ongoing breach.** The `active` map dedups: a surface that is already breaching produces `breach_ongoing`, not a second `INC-`. The incident is only cleared on `recovered`.
- **Automated rollback respects separation of duties.** `automated_metric_breach` is deliberately *not* in `REQUIRES_FOUR_EYES` — a machine can't co-sign with itself. The kill switch records the system actor as both armer and trigger, which the `KillSwitch` schema permits for this trigger kind.
- **Burn requires a minimum sample count.** A surface with 3 requests, all failing, does not page — `minSamples` gates the fast/slow thresholds, so cold starts and low-traffic endpoints don't flap.
- **Determinism.** Same outcomes + same `FixedClock` ⇒ same decisions, same incident ids, same kill-switch ids. The engine test pins `2026-06-02T12:00:00Z` and asserts exact severities and linkage.
- **Severity mapping is total.** All five incident severities map to an alert severity; `alertSeverityFor` never returns undefined.

## Alternatives considered

- **Persist evaluations to new META_SLO_* tables in this package.**
  - **Considered.** A `META_SLO_EVALUATIONS` + `META_SLO_ENFORCEMENT_ACTIONS` pair.
  - **Decision.** Defer to `observability-runtime-pg` (M8.5). The pure runtime mirrors `workflow-runtime` (in-memory) vs `workflow-runtime-pg` (projections). Keeping M8 table-free leaves the 119-table count and the meta-schema test untouched, and the records it emits already map to `META_INCIDENTS` / the feature-flag tables.
- **Single-window threshold (error rate > X% over 5m).**
  - **Decision.** Multi-window. A single short window pages on transient blips; a single long window is slow to detect. The long+short pair is the SRE standard.
- **Page through `@crossengin/notifications` `DispatchRequest` directly.**
  - **Considered.** Build a full notification dispatch envelope.
  - **Decision.** Emit the observability `AlertRouteResolution` (`PageDirective`) instead. It already models pagerduty/slack/sms/email channels and keeps the dependency surface to three packages. The notifications dispatch layer consumes the directive at the edge — the runtime decides *who* to page, not *how* the bytes leave the building.
- **Tokenize-accurate sampling / histograms for latency SLOs.**
  - **Decision.** Out of scope for M8. The engine enforces availability burn (the exit criterion). Latency-target enforcement (p95 multiplier alerts) is a follow-up (M8.5) once the gateway feeds real percentile streams.
- **AbortController / real timers for the <2-minute deadline.**
  - **Decision.** The deadline is a property of the deployment loop (how often `evaluate()` runs), not the runtime. A 30-second evaluation cadence trivially meets <2 min. The runtime stays clock-injected and synchronous.

## Consequences

- **52 packages + 1 app, 119 meta-schema tables, 5,859 tests** (was 51 / 119 / 5,768; +1 package, +91 tests, 0 new META_ tables). Phase 2's eight milestones (M1–M8) are now complete.
- **The SLO enforcement loop is real and demoable.** The engine test reproduces the exit criterion: a 25-request 5xx burst on `POST /v1/orders` against a 99% availability SLO produces a schema-valid declared SEV2 `IncidentRecord`, a pagerduty page directive, and a `triggered_active` `KillSwitch` that rolls `ff_checkout01` back to `false` — with the incident and switch cross-linked.
- **Cross-service tracing has a collector.** `TraceCollector` stitches gateway → workflow → notifications spans into one tree, the foundation for the OTel-flow half of the exit criterion.
- **Pattern set for `observability-runtime-pg` (M8.5).** Projection stores for evaluations + enforcement actions, plus a `PostgresTraceStore`, slot in the same way the workflow/gateway `-pg` siblings did.
- **A stale assertion was corrected.** `architect-cli`'s `apply.test.ts` still asserted `tableCount === 115`; the meta-schema has emitted 119 since M5.7. Updated to 119 so the workspace is green again.
- **No adoption coupling.** No existing package depends on `observability-runtime` yet; the gateway can begin feeding `RequestOutcome`s and the engine can begin emitting plans whenever the deployment loop is wired (M8.5).

## Open questions

- **Q1:** Should `evaluate()` itself close the incident / release the kill switch on `recovered`, or just signal it?
  - _Current direction:_ Signal only. The runtime emits `recovered` with the ids; the consumer owns the close transition (which needs a `rootCause` and four-eyes for release). M8.5 may add a `planIncidentResolution` / `planKillSwitchRelease` pair.
- **Q2:** How are latency-target SLOs enforced?
  - _Current direction:_ Deferred. The engine handles availability burn. Latency needs a percentile stream from the gateway; M8.5.
- **Q3:** Where do `BurnRateThreshold`s live per SLO — global defaults or per-registration?
  - _Current direction:_ Engine-global defaults (`DEFAULT_BURN_RATE_THRESHOLDS`), overridable via the constructor. Per-SLO thresholds can be added to `SloRegistration` when a surface needs a custom budget policy.
- **Q4:** Should the trace collector enforce a sampling decision / cap memory?
  - _Current direction:_ Unbounded in-memory for now (test + short-lived loop use). `observability-runtime-pg` exports spans; the in-memory collector gains an LRU cap if a long-running process adopts it.
