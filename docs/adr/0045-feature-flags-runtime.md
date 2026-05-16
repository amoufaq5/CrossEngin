# ADR-0045: Feature flags runtime

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0008 (audit), ADR-0017 (observability), ADR-0020 (deploy), ADR-0037 (incident response), ADR-0039 (notifications), ADR-0041 (workflow engine), ADR-0043 (rate limiting), ADR-0044 (API gateway) |

## Context

`META_FEATURE_FLAGS` exists in the deploy package as a minimal table (key, kind, default_value, rules JSONB, enabled). It's enough for "flag is on/off" but not enough for everything we've shipped since:

- **Rollouts** — every package that touches a customer flow needs gradual rollout (incident_response runbooks, api_gateway routes, notifications templates, workflow_engine definitions).
- **Kill switches** — `data-lineage` retention policies, `rate-limiting` policies, `api-gateway` security headers, `ai-architect` safety gates all want emergency-off semantics with audit.
- **Targeting** — tenant-tier-based, principal-attribute-based, percentage-bucket-based targeting is needed everywhere (deploy gates, billing experiments, ML rollouts).
- **Evaluation audit** — when a customer asks "why did my tenant get the old behavior?" we need a typed evaluation record showing which rule matched.
- **Change history** — every flag mutation is a deploy-equivalent change that needs four-eyes for high-risk operations and append-only audit.

This ADR establishes the runtime contracts that compose with the existing `META_FEATURE_FLAGS` definition table to give us a full feature-flag platform. The actual evaluator runtime (in-memory cache, Redis pub/sub propagation, SDK client hooks) is Phase 2 — these types are what it consumes.

## Decision

Feature-flags contract has **six modules** in `@crossengin/feature-flags`:

1. **`flags.ts`.** Seven flag kinds (boolean, string, number, json, multivariate, percentage_rollout, kill_switch) with `HIGH_RISK_FLAG_KINDS` set (kill_switch). Four lifecycle statuses (draft → active → paused/archived) with transition map. Four risk levels (low, medium, high, critical). `FlagVariant` declares key + label + value + weight (basis points 0-10000) + description. `FlagDefinition` enforces: multivariate needs ≥ 2 variants with weights summing to 10000; no duplicate variant keys; kill_switch requires killedValueJson + requiresFourEyesToToggle + high/critical risk; only multivariate/percentage_rollout can declare variants; archived needs archivedAt + archivedBy + archivedReason; defaultValueJson + killedValueJson must be valid JSON. Helpers: `isFlagActive(flag, now)` honors expiresAt; `isFlagInEnvironment`, `isHighRiskFlag`, `parseDefaultValue` / `parseKilledValue`.

2. **`targeting.ts`.** Ten targeting rule kinds (all_users, specific_tenants, specific_principals, tenant_attribute_equals, tenant_attribute_in, principal_attribute_equals, principal_attribute_in, percentage_bucket, segment_match, custom_predicate) as a discriminated union. Six segment kinds (role_based, tenant_tier_based, tenant_attribute_based, geo_based, device_based, custom_predicate). `TargetingRule` enforces exactly one of servedVariantKey or servedValueJson; valid JSON. `Segment` is reusable composition of conditions. The deterministic evaluator `evaluateTargetingCondition(condition, context, segmentResolver?)` handles every kind purely; `computeStableBucket(bucketingValue, salt)` uses FNV-1a (good distribution on similar-prefix tenant IDs). `sortRulesByPriority` honors priority order.

3. **`rollouts.ts`.** Nine rollout stages (paused, ramping_1pct, ramping_5pct, ramping_10pct, ramping_25pct, ramping_50pct, ramping_75pct, full_100pct, rolled_back) with `ROLLOUT_STAGE_PERCENTAGES` map. Four ramp strategies (manual, scheduled_linear, scheduled_exponential, metric_driven_auto). State machine prevents stage-skipping (10pct → 25pct → 50pct, not 10pct → 100pct); allows any → rolled_back; rolled_back → paused for re-evaluation. `RolloutPlan` enforces: paused needs reason; rolled_back needs full audit; metric_driven_auto needs blockingMetricSloIds; schedule must be monotonic in time AND percentage (no ramp-down in schedule). `isInRollout(plan, bucketingValue)` is the deterministic check used at evaluation time. `nextScheduledStage` + `isObservationWindowSatisfied` drive the Phase 2 advance loop.

4. **`kill-switches.ts`.** Eight trigger kinds (manual_admin, incident_response, security_event, data_quality_alert, performance_degradation, vendor_outage, compliance_directive, automated_metric_breach) with `REQUIRES_INCIDENT_LINK` (incident_response, security_event) and `REQUIRES_FOUR_EYES` (manual_admin, compliance_directive) sets. Four statuses (armed → triggered_active → released/expired). `KillSwitch` enforces: triggered_active requires triggeredAt + triggeredByUserId; four-eyes triggers need coTriggeredByUserId ≠ triggeredByUserId AND ≠ armedByUserId (full separation of duties); released needs full audit; expiresAt > armedAt. `isKillSwitchActive(killSwitch, now)` + `findActiveKillSwitch(switches, flagId, now)` are the runtime evaluation helpers.

5. **`evaluations.ts`.** Seventeen evaluation reasons covering every outcome path (default_returned, kill_switch_active, flag_not_found, flag_archived, flag_paused, flag_disabled_for_environment, specific_principal_match, specific_tenant_match, tenant_attribute_match, principal_attribute_match, percentage_bucket_match, segment_match, custom_predicate_match, exclusion_rule_hit, fallthrough_to_default, error_returned_default, expired_returned_default). `TERMINAL_REASONS` set partitions which can be returned directly. `FlagEvaluation` enforces: kill_switch_active needs killSwitchId; segment_match needs matchedSegmentId; rule-match reasons need matchedRuleId; error_returned_default needs errorCode + errorMessage; flag_not_found cannot have flagId. `aggregateEvaluations(evals)` returns `{ totalEvaluations, reasonCounts, variantCounts, errorCount, errorRate, p50/p99 latency µs, killSwitchHitCount }` — what the observability dashboard consumes. Latency in microseconds matches the SDK-side evaluation budget (typically < 1ms).

6. **`history.ts`.** Twenty-three change kinds (flag_created, flag_updated_metadata, flag_activated, flag_paused, flag_archived, default_value_changed, killed_value_changed, variant_added/removed/weight_changed, targeting_rule_added/removed/updated, rollout_stage_advanced/paused, rollout_rolled_back, kill_switch_armed/triggered/released, segment_added/updated, owner_transferred, expires_at_extended). `HIGH_RISK_CHANGE_KINDS` set (default_value_changed, killed_value_changed, kill_switch_triggered, rollout_stage_advanced, rollout_rolled_back). Four outcomes (succeeded, rolled_back, blocked_by_policy, blocked_by_four_eyes). `FlagChange` enforces: either actor user or system set; requiredFourEyes succeeded requires fourEyesAttested AND coActorUserId ≠ actorUserId; update-kind changes need beforeValueJson + afterValueJson; kill-switch kinds need relatedKillSwitchId; targeting-rule kinds need relatedTargetingRuleId; blocked outcomes need blockedReason; JSON values valid. `summarizeChangeHistory(changes)` returns succeeded/blocked/rolled-back/high-risk counts + time range.

Four supporting meta-schema tables wired into kernel (the existing `META_FEATURE_FLAGS` in deploy stays as the canonical definition table):

- **META_FEATURE_FLAG_TARGETING_RULES** — CASCADE FK to feature_flags. Nullable tenant_id with custom RLS (platform-wide rules apply across tenants).
- **META_FEATURE_FLAG_KILL_SWITCHES** — RESTRICT FK to feature_flags (preserve kill-switch audit through flag retirement). Nullable tenant_id with custom RLS.
- **META_FEATURE_FLAG_EVALUATIONS** — Nullable tenant_id with custom RLS. 17-reason check enum. Latency in microseconds. Append-only audit.
- **META_FEATURE_FLAG_CHANGES** — CASCADE FK to feature_flags. 23-kind check, 4-outcome check. Append-only audit.

## Alternatives considered

- **Option A:** Extend `META_FEATURE_FLAGS` directly with more columns.
  - **Pros:** Single source of truth.
  - **Cons:** `META_FEATURE_FLAGS` is referenced by deploy and works today. Adding 30+ columns + JSONB sub-structures would balloon the row size and force schema migration on every existing tenant. Supporting tables keep audit + evaluation per-event without mutating the master record.
  - **Why not:** Backwards-compatible composition wins.

- **Option B:** Use LaunchDarkly / Split / Optimizely SDK shape directly.
  - **Pros:** Familiar to teams using those vendors.
  - **Cons:** Each has subtle differences (LaunchDarkly uses targeting JSON DSL, Split uses tree-structured matchers, Optimizely uses experiments). Our contract should be vendor-neutral; Phase 2 adapters can translate to/from any provider.
  - **Why not:** Vendor-neutral first; adapters later.

- **Option C:** Skip rollout state machine — let admins set any percentage directly.
  - **Pros:** Maximum flexibility.
  - **Cons:** Stage-skipping (10pct → 100pct in one click) is the #1 outage cause for feature rollouts. The state machine enforces "you must go through 25pct → 50pct → 75pct" which is what every postmortem says you should have done.
  - **Why not:** Forced gradual ramp is the value.

- **Option D:** No kill-switch concept — admins just toggle the flag off.
  - **Pros:** Simpler.
  - **Cons:** Flag-off and kill-switch-active are different audit events. Flag-off means "this experiment is over"; kill-switch-active means "this is causing pain right now, override every targeting rule and serve the killedValue until someone explicitly releases." Compliance auditors want the distinction.
  - **Why not:** Distinct semantics deserve distinct types.

- **Option E:** Don't enforce four-eyes on flag changes.
  - **Pros:** Faster.
  - **Cons:** A single rogue admin could disable kill switches, change default values for production rollouts, etc. The schema-level requiredFourEyes flag on high-risk kinds makes "blocked_by_four_eyes" a real outcome the audit captures.

- **Option F:** Skip percentage_bucket determinism (just random).
  - **Pros:** Trivially easy to implement.
  - **Cons:** "Sticky" assignment is the whole point of percentage rollout. Same tenant must always get the same bucket regardless of which gateway region serves them. FNV-1a hash on `salt|bucketing_value` gives deterministic, low-bias buckets without needing a state store.

## Consequences

- **Existing META_FEATURE_FLAGS unchanged.** Phase 2 readers of the deploy package keep working. Supporting tables join on `flag_id` for the rich behavior.
- **One evaluation vocabulary.** Every flag lookup produces a `FlagEvaluation` with one of 17 reasons. "Why did this tenant get the old behavior?" has a typed answer.
- **Kill-switch separation of duties.** Manual kills require a different person to co-attest than the one who armed and the one who triggered — three distinct users for the most dangerous operation.
- **Rollout safety baked in.** Phase 2 runtime cannot skip stages because the schema enforces the transition map.
- **Audit completeness.** 23 change kinds + 4 outcomes mean every state mutation is queryable. SOC 2 access-control evidence (ADR-0040) extends naturally.

## Open questions

- **Q1:** Should we expose flag evaluation to the SDK clients (`@crossengin/sdk-clients`) or keep it server-side?
  - _Current direction:_ Server-side for v1 — evaluation runs in the API gateway pipeline (ADR-0044) at the `dispatch_handler` stage. Phase 3 may add SDK-side caching for known-safe boolean flags.
- **Q2:** Multi-region propagation latency — how stale can a flag value be?
  - _Current direction:_ Out of scope for the contract. The runtime can use the active-active CRDT package (ADR-0032) for distributed flag state if needed.
- **Q3:** Flag expiration — auto-archive after expiresAt or just stop serving?
  - _Current direction:_ Stop serving (return `expired_returned_default` reason). Phase 2 archival is a separate scheduled job that runs on the audit trail.
- **Q4:** Customer-facing flag evaluation API — should partners be able to evaluate their own flags via the API?
  - _Current direction:_ Yes, via the `sdk` package's existing operation contract. The evaluation runs through the gateway pipeline like any other route.

## References

- **Causal A/B Testing** — Kohavi et al, "Trustworthy Online Controlled Experiments"
- **Feature Toggles** — Pete Hodgson, "Feature Toggles" (Martin Fowler blog)
- **Sticky Bucketing** — Wensel, "Statistical Methods for Online Experiments"
- **FNV-1a Hash** — Glenn Fowler / Phong Vo / Landon Curt Noll
- ADR-0008, ADR-0017, ADR-0020, ADR-0037, ADR-0039, ADR-0041, ADR-0043, ADR-0044
