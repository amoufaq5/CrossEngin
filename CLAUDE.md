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

Phase 2 M1 + M2 + M2.5 + M2.6 + M2.7 + M2.8 + M2.8.5 + M2.8.6 +
M2.9 + M2.9.5 + M2.9.6 + M2.9.7 + M2.9.8 + M2.9.8.x + M2.X +
M2.X.5 + M2.X.5.x + M2.X.5.y + M2.X.5.z + M2.X.5.aa +
M2.X.5.aa.x + M2.X.5.aa.x.1 + M2.X.5.aa.y + M2.X.5.aa.z +
M2.X.5.aa.z.1 + M2.X.5.aa.z.2 + M2.X.5.aa.z.3 + M2.X.5.aa.z.4 +
M2.X.5.aa.z.5 + M2.X.5.aa.z.6 + M2.X.5.aa.z.7 + M2.X.5.aa.z.8 +
M2.X.5.aa.z.9 + M2.X.5.aa.z.10 + M2.X.5.aa.z.11 +
M2.X.5.aa.z.12 + M2.X.5.aa.z.13 + M2.X.5.aa.z.14 +
M2.X.5.aa.z.15 + M2.X.5.aa.z.16 + M2.X.5.aa.z.17 + M2.X.5.aa.z.18 + M2.X.5.aa.z.19 + M2.X.5.aa.z.20 + M2.X.5.aa.z.21 + M2.X.5.aa.z.22 + M2.X.5.aa.z.23 + M2.X.5.aa.z.24 + M2.X.5.aa.z.25 + M2.X.5.aa.z.26 + M2.X.5.aa.z.27 + M2.X.6 + M2.X.11 + M2.X.11.x + M2.X.12 + M2.X.13 + M2.X.14 + M2.X.15 + M2.X.16 + M5.10.5 + M6.6.x + M6.6.y + M6.7 + M6.7.x + M6.7.y + M6.7.z + M6.7.zz + M6.8 + M8 + M8.1 +
M2.X.6.x + M2.X.7 + M2.X.8 + M2.X.9 + M2.X.10 + M3 +
M3.5 +
M3.6 + M3.7 + M4 + M4.5 + M4.6 + M4.7 + M4.7.5 + M4.7.6 + M4.8 +
M4.8.x + M4.8.y + M4.10 + M4.10.x + M5 + M5.5 + M5.6 + M5.7 +
M5.8 + M5.9 + M5.11 + M6 + M6.5 + M6.5.5 + M6.5.6 + M6.6 + M7 + M7-wire
+ M7.5 + M7.6.5 + M7.7 + M7.8 + M7.9 landed:
**56 packages + 1 app, 127 meta-schema tables, 7,899 tests**,
all green, no type errors. M2.X.5.aa.z.27 closes ADR-0147 Q1
by adding `createProvisionedModelThroughput(input)` — the
FIRST mutation on PT resources. PT cost weight is 100×-1000×
higher than inference profiles: a one-month committed PT for
claude-3-5-sonnet at 1 model-unit runs ~$5,000/month minimum;
six-month commits lock ~$30K non-cancellable; on-demand PTs
accumulate ~$100/hour. Casual API calls cost more than most
operators' entire monthly LLM bill. The substrate's
guardrail: clientRequestToken is REQUIRED in the input type
(even though AWS docs make it optional). This contract upgrade
forces operators to deliberately mint a token (typically
crypto.randomUUID()) before each create call — trivial for
intentional creates (one-line), prohibitive for casual ones
(typescript error if omitted). Naturally retry-safe: operators
store the token alongside the intent (workflow row, DB record);
retry on failure reuses the same token; AWS dedupes server-
side. This is the FIRST CREATE endpoint in the substrate to
require the token — createBatch (ADR-0108),
createModelCustomizationJob (ADR-0131),
createInferenceProfile (ADR-0142) all leave it optional
because their cost weight is much lower. Boundary validation
in pure buildCreateProvisionedModelThroughputBody enforces 6
documented constraints BEFORE fetch: clientRequestToken
length [1, 256] + pattern ^[a-zA-Z0-9](-*[a-zA-Z0-9])*$,
modelUnits integer [1, 1000] (substrate cap on top of AWS's
higher quota — operators wanting >1000 file a separate
substrate change), provisionedModelName length [1, 63] +
slug pattern, modelId length [1, 2048] (accepts foundation/
custom/imported ARNs or IDs), commitmentDuration must be
"OneMonth" | "SixMonths" if provided (undefined = on-demand
no commit), tags max 200 with per-tag key/value length
checks and index-aware error messages. POST to
/provisioned-model-throughput (singular path; LIST/GET use
plural). Response minimal (provisionedModelArn only);
operators wanting full detail call getProvisionedModelThroughput
next since PT starts in Creating status and reaches InService
after minutes. No auto-token generation (defeats idempotency).
No substrate-side dedup (trust AWS server-side). No commitment
auto-default (operators must explicitly choose). No dryRun /
cost-projection (operators wrap above; AWS doesn't expose it
+ pricing tables drift). No status-polling (operator workflow
concern). Symmetric error propagation 404/409/403/429/402.
Bedrock control plane: 20 read + 2 stop + 3 create + 4 delete
+ 3 tag + 1 update = 33 operations. PT mutation half-done —
create shipped; update + delete remain (easier to add now
that safety pattern is established). 39 new tests: 23 in
provisioned-throughput-api.test.ts (body builder happy path +
optional field threading + 14 boundary-validation rejections
across token/modelUnits/name/modelId/commitmentDuration/tags
+ index-aware tag error messages + response parser), 16 in
provider.test.ts (POST URL + JSON body + Sig v4 headers +
control-plane-not-runtime host + token-blank pre-flight +
modelUnits-zero pre-flight + commitment/tags threading +
404/409/403/429/402 propagation + parse failures + network
errors + idempotent retry semantic where substrate makes
both API calls and AWS dedupes server-side returning the
same ARN). M2.X.5.aa.z.26 adds Bedrock
provisioned-throughput (PT) INSPECTION surfaces:
`getProvisionedModelThroughput(provisionedModelId)` +
`listProvisionedModelThroughputs(options?)`. PTs are paid
dedicated capacity (one-month ~$5K, six-month committed)
backing foundation or custom models. Operators previously
had zero substrate visibility — cost dashboards couldn't
project monthly commitments, reconciliation couldn't find
orphaned PTs leaking $5K-$50K/month each after custom-model
decommissioning, incident response had to drop to AWS
Console. This milestone closes those gaps with read-only
endpoints; mutation (create/update/delete) deliberately
deferred — PT cost per operation is 100×-1000× higher than
inference profiles so creation needs a careful idempotency
+ cost-confirmation story. New provisioned-throughput-api.ts
file hosts types + builders + parsers. AWS contract
preserved verbatim: 4 statuses (Creating / InService /
Updating / Failed), 2 commitment durations (OneMonth /
SixMonths). Three-ARN distinction surfaces clearly:
modelArn (current backing model) vs desiredModelArn (target
after pending update) vs foundationModelArn (foundation
behind any custom variants) — operators reading these
distinguish mid-migration (modelArn !== desiredModelArn)
from steady state. Detail extends summary with optional
failureMessage (only present when status === Failed) for
incident-response context. List filters: statusEquals (find
Failed PTs), modelArnEquals (find PTs for a specific model
= reconciliation primary key), nameContains, sortBy +
sortOrder, maxResults [1, 1000], nextToken. Pure boundary
validation pre-fetch; integer validation on modelUnits
guards against floating-point JSON quirks (rejecting 1.5);
unknown-status surfaces as api_error so undocumented AWS
additions fail loudly. Bedrock control plane: 20 read + 2
stop + 2 create + 4 delete + 3 tag + 1 update = 32
operations. No new transport infrastructure — reuses
signedControlPlaneGet. 58 new tests: 37 in
provisioned-throughput-api.test.ts (enums, query builder
across 8 filter dimensions + boundary rejections, 3 parsers
with required-field + optional-field + integer-validation
+ enum-validation coverage), 21 in provider.test.ts (GET
URL + URI-encoding + Sig v4 headers + control-plane host +
identifier-blank pre-flight + detail return shape +
commitment fields + failureMessage threading + 404/403/parse
propagation across both methods + filter threading via query
+ 429/network errors). M2.X.5.aa.z.25 closes ADR-0142 Q1
by adding `updateInferenceProfile(profileIdentifier, input)`
— the FIRST PATCH operation on the Bedrock control plane.
Operator pain it closes: description drift on existing
APPLICATION profiles. Previously the only path to update
description was delete + recreate, which destroyed the ARN
and broke every downstream reference. Now description is
mutable in-place. AWS contract: PATCH /inference-profiles/{id}
with body {description?: string}. New signedControlPlanePatch
transport mirrors signedControlPlanePost — Sig v4 signing,
content-type application/json, body bytes via TextEncoder.
Validation order (defensive, fail-fast): identifier blank
check → input body builder (rejects empty input `{}` since
"at least one mutable field" must be provided) → pre-flight
GET to verify existence + read type field → APPLICATION-only
guard (mirrors deleteInferenceProfile from ADR-0138; if
type !== "APPLICATION" throws invalid_request_error naming
the profile + type, NEVER issues PATCH) → PATCH wire request.
Description-only by deliberate design (tags have their own
canonical surface from M2.X.5.aa.z.24's tagResource /
untagResource; wiring tags into UpdateInferenceProfile too
would create two paths to the same outcome). PATCH semantics
not PUT (only provided fields update; omitted stays
unchanged). No bypass flag — mandatory guard. No cache —
re-read profile type on every update. Pre-flight cost = 1
extra GET per update; acceptable for operator workflow not
hot path. Race window between GET and PATCH (profile deleted
by another caller): PATCH returns 404, propagated verbatim
as not_found_error — same idempotency-via-isNotFoundError
wrap pattern as ADR-0138 applies. Bedrock control plane: 18
read + 2 stop + 2 create + 4 delete + 3 tag + 1 update = 30
operations. Operator now has FULL APPLICATION lifecycle on
the substrate (create + list + get + update + delete + tag).
PATCH transport reusable for future mutation surfaces
(updateGuardrail if AWS adds one, etc.). 21 new tests: 6 in
inference-profiles-api.test.ts (body builder happy path,
empty-input rejection, blank/length/pattern description
rejection, only-description field emitted), 15 in
provider.test.ts (pre-flight GET then PATCH on APPLICATION,
description threaded into PATCH body, SYSTEM_DEFINED refusal
with NO PATCH issued, guard error message names profile +
type, identifier-blank pre-flight before any GET, empty-input
pre-flight before any GET, identifier-before-input ordering,
ARN URI-encoding both calls, control-plane-not-runtime host,
404 from pre-flight, 404 from PATCH race, 403 from PATCH,
429 from PATCH, void on 200, PATCH content-type +
authorization headers). M2.X.5.aa.z.24 closes ADR-0142 Q2
by adding `tagResource(input)` + `untagResource(input)` +
`listTagsForResource(input)` — the FIRST multi-resource
operations on the Bedrock control plane. Previously every
CREATE method accepted `tags` at creation but operators
couldn't mutate tags post-creation; now they can across every
Bedrock ARN (custom-models + imported-models + guardrails +
inference-profiles + jobs + batches). New tagging-api.ts file
hosts types + builders + parser. AWS contract preserved
verbatim including the WIRE-SHAPE ASYMMETRY (the interesting
part): TagResource POSTs to `/tags?resourceARN={arn}` with
body `{tags:[...]}`, UntagResource POSTs to
`/untag?resourceARN={arn}` with body `{tagKeys:[...]}`,
ListTagsForResource POSTs to `/listTagsForResource` with body
`{resourceARN:"..."}` (note the uppercase ARN in the body!).
AWS doesn't document the reason for the asymmetry but the
substrate doesn't paper over it — operators reading AWS docs
see exactly the same shape they get. signedControlPlanePost
transport extended additively to accept optional query strings
(needed for TagResource + UntagResource); existing callers
unaffected. Pure boundary validation in builders enforces all
documented constraints BEFORE fetch: resourceArn length
[1, 1011] + arn:aws prefix, tag count [1, 200], tag key length
[1, 128] + pattern ^[a-zA-Z0-9\\s_.:/=+@-]*$, tag value length
[0, 256] + same pattern (empty value VALID per AWS contract,
empty key REJECTED), tagKey list count [1, 200]. Error
messages include the index of the bad tag entry for crisp
debugging on 200-tag batches: "invalid tag key at index 2".
BedrockTag is the canonical cross-resource shape; existing
per-resource tag types (BedrockBatchTag,
BedrockInferenceProfileTag, etc.) remain for documentation
clarity since they're structurally identical. Symmetric error
propagation 404→not_found_error / 403→permission_error / 429→
rate_limit_error. Bedrock control plane: 18 read + 2 stop + 2
create + 4 delete + 3 tag = 29 operations. Pattern set for
future cross-resource operations. 53 new tests: 32 in
tagging-api.test.ts (builders for all 3 methods + query
builders + parser with full edge cases including
index-aware error messages, empty tag values valid, 200-tag
boundary), 21 in provider.test.ts (POST URL + query + body
threading + URI encoding + Sig v4 headers + control-plane
host + identifier-blank pre-flight + 404/403/429 propagation +
parse failures + network errors across all 3 methods + the
asymmetry that ListTagsForResource has NO query string).
M6.8 closes ADR-0137 Q2 with a
normalized cost-tier substrate: META_LLM_COST_TIERS (126th)
+ META_LLM_TENANT_TIER_MEMBERSHIPS (127th) + extended
PostgresCostCeilingResolver. Operators with many tenants on a
shared pricing plan previously had to insert N identical rows
into META_LLM_COST_CEILINGS; updating the free-tier policy
required N UPDATEs and was racy. The tier substrate
normalizes: define `free`/`pro`/`enterprise` tiers ONCE, link
tenants via memberships, and adjust tier-wide policy via a
single UPDATE on the tier row that takes effect next request
for every member. META_LLM_COST_TIERS: tier_id TEXT PK
(pattern ^[a-z0-9][a-z0-9_-]{0,63}$ for URL-safe + log-
friendly slugs), display_name, NULLABLE policy columns same
semantics as M6.7.x (NULL = unbounded on that axis),
platform-wide no RLS (tiers are operator-defined policies
not tenant data). META_LLM_TENANT_TIER_MEMBERSHIPS:
tenant_id PK (one tier per tenant — multi-tier resolution
ambiguity blocked at the schema level), tier_id FK with
ON DELETE RESTRICT (a tier can't be deleted while any tenant
references it — forces deliberate migration; CASCADE would
be a footgun silently stripping ceiling protection from all
members), RLS-enabled with TENANT_ISOLATION_USING policy.
Resolver semantic post-M6.8 is three-level fallback: per-
tenant override (M6.7.x semantics preserved — whole-object
override) → tier (whole-object) → global (router constructor
default). Each level wins as a complete CostCeiling, no field-
by-field merge — operator reasoning stays mechanical "tenant
X has policy P, P is the law for that tenant." Field-merge
alternative was considered but rejected because it would
break M6.7.x semantics where NULL means "explicitly unbounded"
(under merge it would mean "fall back to tier"). Implementation:
TWO PG round-trips in the worst case (no per-tenant + no tier
= 2 queries); best case 1 (per-tenant exists, tier lookup
skipped). JOIN-in-one-query alternative rejected because it
forces field-merge OR clutters the SELECT with CASE WHEN
expressions per column. Three operator pains closed: free-tier
policy fan-out (1 UPDATE on the tier row affects all members
vs N UPDATEs on individual ceilings), pricing plan
normalization (tier definitions are O(tiers) rows; memberships
are O(tenants)), per-tenant override expressiveness (a Pro-tier
tenant can still get a custom raise via a row in
META_LLM_COST_CEILINGS that takes precedence over the tier).
8 new tests in cost-ceiling-resolver.test.ts: tier fallback
when no per-tenant row exists, per-tenant precedence (no tier
query issued), undefined when neither exists, JOIN SQL shape
(meta.llm_tenant_tier_memberships INNER JOIN
meta.llm_cost_tiers ON tier_id), tier with NULL fields →
empty ceiling, NUMERIC precision preservation, exactly-one-
query when per-tenant exists, exactly-two-queries when both
absent. M6.7.zz closes ADR-0120 Q5 +
ADR-0140 Q1 + ADR-0141 Q1 in one cross-cutting substrate:
META_RETENTION_POLICIES table (125th) + PostgresTraceRetention
adapter in `@crossengin/kernel-pg`. The three append-only
trace tables shipped over recent milestones —
META_WORKFLOW_TRACES (M8), META_LLM_LATENCY_SAMPLES
(M6.7.y), META_LLM_CALL_TRACES (M6.7.z) — now have a unified
retention story. At 1M LLM calls/day, llm_call_traces adds
~600MB/day after indexes; without retention the substrate
becomes unworkable within months. META_RETENTION_POLICIES
columns: table_name TEXT PK (CHECK IN
('workflow_traces','llm_latency_samples','llm_call_traces')
— the DB rejects unknown values at INSERT time + the
allowlist is the source of truth), retention_days INTEGER
NOT NULL CHECK >= 1 (zero would delete everything immediately
— operators wanting "no retention" disable via enabled
column), enabled BOOLEAN NOT NULL DEFAULT true (kill switch
without losing configured retention), last_pruned_at
TIMESTAMPTZ NULLABLE (NULL = never pruned; audit value),
updated_at TIMESTAMPTZ. No tenant_id, no RLS — retention is
a platform-policy concern (per-tenant retention is a future
Q). PostgresTraceRetention adapter in kernel-pg (most general
home since it operates on meta-schema tables; ai-router-pg
would have created a cross-package dependency for
workflow_traces): listPolicies() returns alphabetically-
ordered policy rows mapped to camelCase API; prune() iterates
policies and for each enabled+known row computes cutoffMs =
clock() - retention_days*86400_000, issues `DELETE FROM
meta.{tableName} WHERE {timeColumn} < to_timestamp($1 /
1000.0)` then updates last_pruned_at; per-policy result
returned with status enum (pruned / skipped_disabled /
skipped_unknown_table) + deletedCount + cutoffMs.
PRUNABLE_TABLES is HARDCODED in the adapter: workflow_traces
→ occurred_at, llm_latency_samples → recorded_at,
llm_call_traces → occurred_at. The hardcoded approach wins on
safety: no SQL injection (table name + column name come from
static map not row data), schema knowledge stays in code
(operators don't need to know `recorded_at` vs `occurred_at`),
defense-in-depth via DB CHECK + adapter allowlist. Adding a
new trace table = update CHECK constraint + add PRUNABLE_TABLES
entry. Adapter is idempotent (re-running prune() finds fewer
rows). Static SQL string assembly even though interpolated —
both table name + column name come from the static map. Clock
injection for testability. No outer transaction across
policies — per-policy autonomy (one prune can succeed while
another fails). 16 new tests in trace-retention.test.ts:
knownPrunableTables exposes the 3 trace tables;
listPolicies SELECTs alphabetically + maps snake-case →
camelCase + empty-array on no rows; prune issues DELETE
against workflow_traces with occurred_at + recorded_at for
latency_samples (not occurred_at) + occurred_at for
call_traces + cutoffMs computed correctly + UPDATE
last_pruned_at + skip-disabled + skip-unknown-table +
multi-policy + zero-deleted-count + default Date.now clock +
no-DELETE-on-no-policies + safety properties (allowlist is
hardcoded). M2.X.5.aa.z.23 closes ADR-0138 Q3
by adding `createInferenceProfile(input)` to BedrockProvider
— the 2nd CREATE on the Bedrock control plane (after
createBatch from M2.X.5.aa.z.6 / ADR-0108 and
createModelCustomizationJob from M2.X.5.aa.z.20 / ADR-0131).
Completes the full APPLICATION-inference-profile lifecycle on
the substrate: create (M2.X.5.aa.z.23 this) + list (M2.X.5.aa.z.9)
+ get (M2.X.5.aa.z.10) + delete (M2.X.5.aa.z.22). AWS contract
faithfully preserved: required fields = inferenceProfileName
(pattern ^([0-9a-zA-Z][_-]?){1,63}$, length [1, 64]) +
modelSource.copyFrom (length [1, 2048] no pattern — accepts
foundation-model ARNs OR system-inference-profile ARNs); optional
fields = description (pattern ^([0-9a-zA-Z][ _-]?)+$, length
[1, 200]), clientRequestToken (pattern ^[a-zA-Z0-9-]+$, length
[1, 256] for AWS idempotency), tags (max 200, per-tag key
length [1, 128] + value length [0, 256]). modelSource is a
structured object (only `copyFrom` variant today) — future AWS
expansion (e.g., hypothetical routingConfig) is an additive
type extension. NO pre-flight guard needed (vs delete which
needs one): AWS only creates type=APPLICATION via this endpoint,
operators can't accidentally create a SYSTEM profile. Response
is minimal — `{inferenceProfileArn, status}`; operators
wanting full detail call getInferenceProfile next.
Boundary validation in pure `buildCreateInferenceProfileBody`
enforces all 8 documented constraints BEFORE fetch (saves
cost + load). Symmetric error propagation: 404 →
not_found_error (copyFrom ARN missing), 409 →
conflict_error (name collision), 403 → permission_error, 429
→ rate_limit_error. clientRequestToken supports AWS's
idempotency contract: repeated POSTs with same token return
same ARN without re-creating. 34 new tests: 19 in
inference-profiles-api.test.ts (body shape happy path,
optional-field threading, all 8 boundary-validation rejections
across name + copyFrom + description + clientRequestToken +
tags-count + tag-key-length + tag-value-length + empty-tag-key,
response parsing happy + unknown status + missing arn +
non-object), 15 in provider.test.ts (POST shape + JSON body +
URL + headers + Sig v4, body bytes contain required fields,
returns parsed shape, control-plane-not-runtime host,
identifier-blank pre-flight × 2 cases, 409/404/403/429 error
propagation, optional fields thread through, parse failure as
api_error, network errors). Bedrock control plane: 18 read +
2 stop + 2 create + 4 delete = 26 operations. M6.7.z adds the
FOURTH ai-router-
pg substrate: `RouterInstrumentation` interface +
META_LLM_CALL_TRACES table (124th) +
PostgresRouterInstrumentation adapter. Closes three deferred
Qs in one milestone: ADR-0135 Q2 (router-scoped
instrumentation), ADR-0137 Q3+Q4 (ceiling audit + observability),
ADR-0140 Q3 (per-LLM-call trace rail). Pattern parity with M8
WorkflowInstrumentation — same onEvent(event):
Promise<void>|void signature, same captureRouterInstrumentation()
+ combineRouterInstrumentations() helpers, same
NoopRouterInstrumentation default (no behavior change for
existing callers — wiring is opt-in). Three event kinds:
llm_call_started (before fetch after preflight; attrs:
attemptIndex, totalChoices), llm_call_completed (on success;
attrs: costUsd, inputTokens, outputTokens, cachedInputTokens,
attempts), llm_call_failed (per-provider failure; attrs:
errorKind, errorMessage, attempts, willFallback — derived
from remaining choices at emit time so terminal short-
circuits from ADR-0091/0133/0134 show willFallback=false).
Per-attempt granularity — a complete() with fallover emits
2N events for N attempts; matches operator mental model "what
happened at each step?". Event sequences documented:
happy path (started→completed), fallover (started→failed→
started→completed), terminal non-retryable (started→failed
willFallback=false), all-exhausted (full chain ending with
AllProvidersExhaustedError). META_LLM_CALL_TRACES table:
audit-optimized (vs LATENCY_SAMPLES which is aggregation-
optimized) — full event context (tenant, session, task,
model, costUsd, tokens, errors), JSONB attributes for
flexibility, tenant-scoped with RLS_ISOLATION, three indexes
serving the three canonical operator queries — (tenant_id,
occurred_at) for "tenant recent activity", (provider_id,
kind, occurred_at) for "anthropic failures last hour",
(tenant_id, session_id) for "session audit trail
reconstruction". Distinct from LATENCY_SAMPLES on purpose:
different read patterns deserve different schemas — single
mega-table would have aggregations scan-and-decode large
rows + audits compete with high-volume sample writes.
PostgresRouterInstrumentation: single INSERT per onEvent,
no batching/buffering, mirrors PostgresWorkflowInstrumentation
verbatim. ai-router-pg adapter set now has 4 substrates:
cost-windows (M6.7), cost-ceilings (M6.7.x), latency-samples
(M6.7.y), call-traces (M6.7.z) — router is fully observable.
Append-only — retention is a future milestone (~M6.7.z.1
covering all three append-only trace surfaces uniformly).
Storage ~200 bytes/row → 1M calls/day = ~600MB/day after
indexes; PG-native partitioning is operator-side concern.
21 new tests: 11 in router.test.ts (started→completed
sequence on happy path, full event field threading, costUsd
+ token attributes on completed, durationMs null-on-started
+ non-null-on-completed, failed with willFallback=true on
retryable+fallback, full started/failed/started/completed
on fallover, willFallback=false on terminal AllProvidersExhausted,
ISO 8601 occurredAt, noop default behavior unchanged,
attemptIndex 0→1 across chain, non-retryable→willFallback=false),
10 in router-instrumentation.test.ts (INSERT shape, 9-column
param order, completed with cost+tokens, failed with
error+willFallback, JSONB attribute serialization, null
durationMs threading, verbatim ISO 8601, no batching/single
INSERT per event, PG error propagation, contract compat).
M6.7.y completes the ai-router-pg
adapter set by adding `PostgresLatencyTracker` — the third
and final persistable tracker (after PostgresCostTracker
from M6.7 and PostgresCostCeilingResolver from M6.7.x).
Three changes: (1) `LatencyTracker` interface becomes
async — both `record()` and `stats()` now return Promises.
Internal-only breaking change since the only consumer is
DefaultLlmRouter (two await sites added) plus
InMemoryLatencyTracker (mechanical async signature
upgrade). Fire-and-forget alternative was considered but
rejected: silent failures, unbounded queue if PG degraded,
inconsistency with the already-async CostTracker contract.
1ms PG INSERT overhead per LLM request is negligible
compared to LLM call duration. (2) META_LLM_LATENCY_SAMPLES
as the 123rd meta-schema table — append-only sample log,
PK on uuid_generate_v7() id, indexed (provider_id,
recorded_at), latency_ms >= 0 CHECK, NO tenant scoping
(provider-level observability, not per-tenant) and NO RLS
(platform-wide table same pattern as META_TENANTS).
(3) PostgresLatencyTracker in `@crossengin/ai-router-pg` —
record() does single INSERT; stats() does single windowed
SELECT with a CTE limiting to N most recent samples then
aggregating via PG's native percentile_cont. Index-only
scans handle "last 100 anthropic samples" in microseconds
even at millions of rows. Returns same LatencyStats shape
as InMemoryLatencyTracker. percentile_cont is continuous
interpolation; differs from in-memory's floor-index
selection only at tiny window sizes (observably nil at
window>=20). The ai-router-pg adapter set is now complete:
3 substrates (cost-windows from M6.7, cost-ceilings from
M6.7.x, latency-samples from M6.7.y). Operators wiring an
ai-router for multi-replica deployments have a fully-
persistent stack. Operator dashboards can answer "what's
anthropic's p95 over the last hour?" with a single SELECT
on meta.llm_latency_samples — `SELECT provider_id,
percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY
latency_ms) AS p95 FROM meta.llm_latency_samples WHERE
recorded_at > now() - INTERVAL '1 hour' GROUP BY
provider_id;`. 12 new tests in latency-tracker.test.ts
covering record (INSERT shape + params + success boolean),
stats (zero on empty, parsed when populated, windowed
SELECT shape, default windowSize=100, percentile_cont
syntax, NULL-percentile handling, provider filter, FILTER
aggregates, provider isolation), and LatencyTracker
contract compat (drop-in for the async ai-router
interface). M5.11 adds `--max-cost-usd $X` to
`crossengin chat` — a session-scoped post-hoc cumulative
budget cap. Independent from `--cost-ceiling-usd` (which
remains the per-request gate via router preflight); both
can coexist. Enforcement lives entirely in the REPL loop
(not router) for three reasons: (a) router's preflight uses
ESTIMATED cost while session budget needs REAL cost; (b)
router is provider-orchestration but session budget is CLI-
state, separation of concerns; (c) `maxUsdPerWindow` would
require fake-long windowSeconds — code smell. Check fires at
TOP of each REPL while-iteration BEFORE consuming the next
input line: if aggregate.cost >= maxCostUsd, emit
budget_exceeded announcement and break. Implications: the
LAST turn that pushes cumulative cost over the budget IS
allowed to complete (cost observed AFTER response streams);
NEXT input is refused — matches "give me one more answer,
then stop" UX. One-shot mode (single turn): budget check
fires AFTER the turn since there's no next iteration;
result.budgetExceeded surfaces informationally. Display
surfaces: human mode shows "Session budget: $X.XXXX USD."
header, "[budget: $Y.YYYY of $X.XXXX spent]" line after
each turn, "[session budget exceeded: $Y spent, $X budget —
exiting]" notice on exhaustion. JSON mode emits
{kind:"budget_exceeded",spent_usd,budget_usd} chunk on
exit. ChatReplResult.budgetExceeded?: boolean surfaces on
programmatic returns + JSON output. Validation: parse as
finite positive number; exit 2 on bad value. Exit 0 on
budget exhaustion (the session ran successfully; budget
honored — operators wanting hard-failure check the flag).
No breaking change: existing callers without the flag see
identical behavior. CLI flag is the client-side complement
to M6.7 (server-side PostgresCostTracker) + M6.7.x (server-
side per-tenant ceilings) — both substrates remain, neither
duplicates. 11 new tests: 9 in chat.test.ts (REPL refuses
subsequent input after budget crossed + 3-input/2-response
scenario, under-spend doesn't set flag, human header, human
per-turn line, human exit notice, JSON budget_exceeded
chunk, no-budget legacy behavior unchanged, one-shot
over/under-budget flag presence/absence), 2 in
commands.test.ts (--max-cost-usd=-1 exits 2 with clear
error, valid positive value runs the turn). M2.X.5.aa.z.22
closes ADR-0136 Q2
by adding `deleteInferenceProfile(profileIdentifier)` to
BedrockProvider — the 4th DELETE on the Bedrock control
plane and the first "smart" delete with a mandatory pre-
flight guard. The Bedrock `inference-profiles` namespace
contains TWO kinds of resources sharing the same URI path:
type=APPLICATION (operator-created + operator-deletable) and
type=SYSTEM_DEFINED (AWS-owned + immutable). A blind DELETE
on a system profile yields an opaque ValidationException
from AWS. The substrate does better: deleteInferenceProfile
runs a mandatory pre-flight `getInferenceProfile` (serving
three purposes simultaneously: existence check via 404 →
not_found_error, GET-permission check via 403 →
permission_error, and reading the `type` field for the
guard). If type !== "APPLICATION", throws
invalid_request_error with a message naming the profile +
type — NEVER issues DELETE. If type === "APPLICATION",
issues DELETE via the shared signedControlPlaneDelete
(ADR-0136). No bypass flag (substrate can't override AWS;
mandatory guard is contract). No type-from-caller (would be
a footgun — pre-flight reads ground truth). No cache (rare
operation; PG-style read every time). Pre-flight cost: 1
extra GET per delete — acceptable on a DELETE operator
action, would be expensive in a hot path. Race window
between GET and DELETE (profile deleted by another caller):
DELETE returns 404 → propagates verbatim as
not_found_error; same idempotency-via-isNotFoundError wrap
pattern as ADR-0136 applies. Bedrock control plane now has
18 read + 2 stop + 1 create + 4 delete = 25 operations.
Pre-flight-guard pattern established for future "two-typed"
resources where the same URI handles AWS-owned and
operator-owned resources. 13 new tests in provider.test.ts:
APPLICATION happy path (GET then DELETE), SYSTEM_DEFINED
refusal (NO DELETE issued), guard error message names
profile + type, ARN URI-encoding on both calls, control-
plane host, identifier-blank pre-flight (before any GET),
404 / 403 from pre-flight GET, 404 / 403 / 429 / 409 from
DELETE, 204 success. Uses a new sequencedFetch test helper
that discriminates on init.method. M6.7.x closes ADR-0135
Q1 + Q4 in
one milestone: per-tenant cost ceiling configuration as data
rather than code. Three additive changes: (1)
META_LLM_COST_CEILINGS as the 122nd meta-schema table with
columns (tenant_id, max_usd_per_request, max_usd_per_window,
window_seconds, effective_from, updated_at) — one row per
tenant, PK on tenant_id (UPSERT semantics matching
META_LLM_COST_WINDOWS), policy columns NULLABLE so NULL
means "no limit on this axis", NUMERIC(18,8) precision,
positive-value CHECK constraints, RLS tenant-isolated; (2)
new `getTenantCostCeiling?: (tenantId) =>
Promise<CostCeiling | undefined>` field on
DefaultLlmRouterOptions — when wired the router calls it
per-request and uses the result if defined, falls back to
the global `costCeiling` otherwise; resolution rule is
WHOLE-OBJECT OVERRIDE (tenant ceiling REPLACES global, not
merges — matches operator intent "this tenant's policy is
P"); (3) PostgresCostCeilingResolver in
`@crossengin/ai-router-pg` — drop-in for getTenantCostCeiling
via `resolver.resolve`; single SELECT keyed by tenant_id;
NULL columns map to omitted CostCeiling fields; ::TEXT cast
preserves sub-cent NUMERIC precision. No breaking change:
existing callers with global ceiling only continue working.
Schema is forward-compatible with history-aware reads
(effective_from already in place). 16 new tests: 7 in
router.test.ts (tenant-scoped resolution, fallback to
global, tighter override, looser override, tenantId
threading, no-ceiling flow, asymmetric ceiling), 9 in
cost-ceiling-resolver.test.ts (undefined on no row, full
ceiling shape, individual NULL field omission for each of
the three policy columns, all-NULL empty ceiling, SQL
shape, NUMERIC precision preservation). Four operator pains
closed: restart-required-to-change-ceiling, no-free-tier-vs-
enterprise-gating, trial-customer-overspend, compliance-air-
gap-by-budget. M2.X.5.aa.z.21 ships the FIRST
DELETE write surfaces on the Bedrock control plane:
`deleteCustomModel(modelIdentifier)`, `deleteImportedModel(
modelIdentifier)`, `deleteGuardrail(guardrailIdentifier,
guardrailVersion?)`. New shared `signedControlPlaneDelete`
transport (DELETE variant of GET; query optional; empty body;
Sig v4 signed via existing signRequest). The three methods
follow the established pattern: validate identifier
non-empty BEFORE fetch (saves cost + load), URI-encode the
identifier path segment (handles `:` in ARNs), control-plane
host only (not bedrock-runtime), return void on any 2xx
(200, 202, 204), propagate 404 as not_found_error
VERBATIM (caller decides idempotency — the router short-
circuit (M6.6.y) handles automated lifecycle pipelines and
operators wanting silent idempotency wrap in a 3-line try/
catch `isNotFoundError` predicate; the reverse — provider-
swallowed 404 with caller needing the signal — is
impossible to reverse), 409 → conflict_error (in-use
resource — provisioned throughput attached, guardrail used
by application), 403 → permission_error, 429 →
rate_limit_error. deleteGuardrail carries optional
guardrailVersion (omit = delete whole guardrail / all
versions; provide = delete that specific version — matches
AWS semantics; symmetric with getGuardrail's optional
version parameter). 28 new tests in provider.test.ts cover
URL shape + DELETE method + ARN URI-encoding + control-
plane host + identifier-blank pre-flight + 204 success +
404 / 409 / 403 / 429 / network propagation across all
three deletes. Three operator workflows unblocked: post-
fine-tune custom-model cleanup, rejected-upload imported-
model removal, deprecated-guardrail retirement. Bedrock
control plane now has 18 read + 2 stop + 1 create + 3
delete = 24 operations. M6.7 ships the first persisted
ai-router substrate: `@crossengin/ai-router-pg` package with
`PostgresCostTracker` (drop-in replacement for
`InMemoryCostTracker` against the same `CostTracker` interface)
+ `META_LLM_COST_WINDOWS` (121st meta-schema table — one row
per tenant, natural PK on tenant_id, NUMERIC(18,8) cost
column, RLS tenant-isolated). Closes ADR-0059's deferred
cost-tracker persistence Q. Single-row-per-tenant tumbling
window matches the in-memory contract exactly: when the
first request arrives after the window expires, the window
resets to "now"; concurrent recordUsage calls from multiple
gateway replicas safely increment via atomic UPSERT (ON
CONFLICT DO UPDATE with a CASE clause that decides
reset-vs-increment entirely in SQL — single round-trip,
race-free). TS-side clock injection for testability (same
shape as InMemoryCostTracker). checkCeiling logic identical
to InMemoryCostTracker: per-request gate first (no DB hit
when over per-request cap), window gate second (one SELECT).
NUMERIC(18,8) precision preserved via ::TEXT cast + Number()
parse on read. Three workflows unblocked: multi-replica
gateway cost enforcement (was 3× over-spend before), cross-
restart durability (was zeroed on recycle), operator
observability via `SELECT * FROM meta.llm_cost_windows`.
Established X / X-pg pattern preserved (kernel/kernel-pg,
workflow-runtime/workflow-runtime-pg, api-gateway-runtime/
api-gateway-pg, ai-architect/ai-architect-pg, now ai-router/
ai-router-pg). 18 new tests in cost-tracker.test.ts cover
getWindow (5 — null + within-window + expired + boundary +
tenant filter), recordUsage (5 — UPSERT shape + param
threading + clock injection + default window + CASE branch
shape), checkCeiling (6 — per-request + no-window-cap + within
+ exceeded + expired-window + per-request-first-gate), and
2 InMemory-parity tests (NUMERIC string round-trip + shape
match). M6.6.y extends the ai-router's
retry / fallback short-circuit list with isNotFoundError —
closes ADR-0133 Q1, the deferred Q from M6.6.x. One-line
change in `isRouterRetryable` (router.ts): not-found errors
(HTTP 404) join moderation + conflict as terminal — no
provider-level retry, no fallback-provider attempt. Semantic:
not-found means "identifier doesn't resolve (or this
principal can't see it)"; retrying with the same identifier
always fails the same way; switching to a different provider
can't help either (identifiers are provider-scoped — an
OpenAI file_id is not an Anthropic file ID is not a Bedrock
ARN; re-issuing against a different provider can't succeed).
Preserves the original error verbatim (kind +
status === 404). Existing behavior on every other error
class unchanged — rate_limit still falls over, moderation
and conflict still early-exit separately, invalid_request
still propagates as before. Three classifiers now short-
circuit: moderation (M6.6), conflict (M6.6.x), not-found
(M6.6.y). 5 new tests in router.test.ts validate the not-
found early-exit (fallback bypass + no-retry + error
preservation + distinct-from-conflict + rate_limit fallback
preserved). M6.6.x extends the ai-router's
retry / fallback short-circuit list with isConflictError —
closes ADR-0118 Q2, the deferred Q from M2.X.12. One-line
change in `isRouterRetryable` (router.ts): conflict errors
(HTTP 409) join moderation errors as terminal — no
provider-level retry, no fallback-provider attempt. Semantic:
conflict means "resource is in incompatible state"; retrying
with the same input always fails the same way; switching to
a different provider doesn't help (the conflict lives on the
operator's resource state, not the provider's availability).
Preserves the original error verbatim (kind +
status === 409 + code === "ConflictException"). Existing
behavior on every other error class unchanged — rate_limit
still falls over, moderation still early-exits separately,
invalid_request still propagates as before. Pattern set for
future classifier short-circuits: each future short-circuit
gets its own ADR with documented semantics — no lump-add. 5
new tests in router.test.ts validate the conflict early-exit
+ preserve the rate_limit fallback path. M8.1 adds activity execution
instrumentation to the workflow runtime — closes ADR-0120
Q3, the longest-outstanding deferred Q from the M8 milestone.
WORKFLOW_INSTRUMENTATION_KINDS grows from 11 → 14 with three
new event kinds: activity_started (fires before the
event-log row append; captures activityStartedAt timestamp
for duration tracking), activity_completed (fires after
handler returns success outcome; populates durationMs =
clock.now() - activityStartedAt + activityId / activityKey /
activityKind attributes), activity_failed (fires after
handler returns failed outcome OR throws an uncaught
exception; populates durationMs + errorCode + errorMessage +
retryable attributes). Three new emit calls land in the
existing applyScheduleActivity method; no new transport, no
new types. META_WORKFLOW_TRACES.kind CHECK constraint
extended additively to allow the three new kinds. Same shape
as M8's existing instrumentation events (kind + tenantId +
instanceId + definitionId + correlationId + occurredAt +
durationMs + attributes). Instrumentation fires BEFORE the
corresponding event-log append — consistent with M8's
pattern. Handler-exception path covered: both `return {
status: "failed" }` (operator-controlled failure) and
`throw new Error(...)` (uncaught) surface activity_failed
with the error context. Three workflows unblocked: activity
latency dashboards (p50/p95/p99 via durationMs aggregation
queries), activity failure alerting (errorCode +
errorMessage + retryable on a single trace event), per-
activity-kind cost attribution rail ready for M6.7
PostgresCostTracker. M2.X.5.aa.z.20 closes the
customization-job CRUD with
`BedrockProvider.createModelCustomizationJob(input)` —
LARGEST write surface remaining on Bedrock's control plane.
After M2.X.5.aa.z.17/.18/.19 shipped list + get + stop, this
milestone adds programmatic fine-tune submission. New
`buildCreateModelCustomizationJobBody(input)` pure boundary-
validator enforces 12+ documented AWS constraints BEFORE any
fetch: jobName + customModelName pattern + length [1, 63];
roleArn AWS-partition-aware IAM regex; baseModelIdentifier
length [1, 2048] (no pattern — AWS accepts foundation model
IDs / ARNs / inference profile IDs); s3Uri scheme
^s3://[a-z0-9.\-_]{1,255}/.* on both training + output +
validator URIs; hyperParameters object of string→string
(per-value typeof check); clientRequestToken shape + length
[1, 256]; customModelTags + jobTags count ≤ 200 + key length
[1, 128] + value length [0, 256]; validationDataConfig.
validators count ≤ 10; vpcConfig.subnetIds +
securityGroupIds counts in [1, 16]. All ARN patterns
AWS-partition-aware (aws, aws-us-gov, aws-cn).
`parseCreateModelCustomizationJobResponse(raw)` is strict —
{jobArn} only; missing / empty / non-string throws api_error.
AWS contract preservation: `customModelKmsKeyId` (NOT
KmsKeyArn) per CreateModelCustomizationJob docs; field-naming
asymmetry vs get (outputModelName ≠ customModelName)
preserved verbatim from M2.X.5.aa.z.18. Reuses 5 sub-types
from M2.X.5.aa.z.18 (S3Config / ValidationDataConfig /
VpcConfig / CustomizationConfig / Validator) + adds new
BedrockModelCustomizationJobTag = {key, value}. Bedrock
control-plane surface now has 18 of N operations
(customization CRUD complete). Three workflows unblocked:
programmatic fine-tune submission (CI-driven training
pipelines), automated retry-on-failure flows (catch +
re-submit with adjusted hyperparameters), distillation
lineage capture (teacher model + max response length
recorded with the job). M2.X.16 lifts the EIGHTH
cross-provider error classifier and COMPLETES the canonical
4xx/5xx classifier sweep — `isInvalidRequestError(err)` in
`@crossengin/ai-providers/invalid-request.ts`. Closes ADR-0129
Q1 mechanically. All three providers emit
`invalid_request_error` from classifyHttpStatus(400); Bedrock
additionally maps `ValidationException` via CODE_TO_KIND;
OpenAI maps via TYPE_TO_KIND. Zero provider changes.
Structurally identical to permission.ts (M2.X.15). Single-kind
tuple. Explicitly distinct from request_too_large: 400 =
structural problem (missing field, bad type, out-of-range) →
fix shape; 413 = correct shape but oversized payload → reduce
input. Canonical 4xx sweep coverage map: 400 invalid_request
+ 401 authentication + 403 permission + 404 not_found + 408
timeout (via retryable) + 409 conflict + 413 request_too_large
+ 429 rate_limit (via retryable) + 503/529 overloaded (via
retryable) + ≥500 api_error (via retryable). Moderation
kinds + network errors covered by their dedicated
classifiers. Coverage is COMPLETE — every documented kernel
error kind across all three providers maps to at least one of
the eight classifiers. New mutual-exclusivity test asserts an
`invalid_request_error` matches exactly ONE classifier
(itself) — verifying the suite remains partitioned. Three
workflow patterns enabled: CI kernel-validation tests
(assert isInvalidRequestError on malformed requests),
auto-fix workflows for LLM-generated requests (re-prompt with
error feedback when isInvalidRequestError fires), user-facing
error translation (8-way dispatch documented in ADR-0130).
M2.X.15 lifts the SEVENTH
cross-provider error classifier — `isPermissionError(err)`
in `@crossengin/ai-providers/permission.ts`. Closes ADR-0128
Q1 mechanically. All three providers emit `permission_error`
(Anthropic + OpenAI via classifyHttpStatus(403); Bedrock via
CODE_TO_KIND["AccessDeniedException"] → permission_error —
Bedrock's classifyHttpStatus collapses 401||403 to
authentication_error broadly, the typed-exception path
provides finer detail). Zero provider changes. Structurally
identical to authentication.ts (M2.X.14). Single-kind tuple
(`permission_error` only). Explicitly distinct from
authentication_error: 401 = bad credentials → rotate;
403 = valid credentials, no access → grant principal access
or use different principal. Operators wanting "any
auth-related" compose
`isAuthenticationError(err) || isPermissionError(err)`
inline (the canonical pattern documented in the test file
itself). Three workflow patterns enabled: cross-account /
cross-tenant access denial handling (translate to
TenantAccessDeniedError with structured tenant-facing
message), multi-region access policies (inference profile
routing through a region the operator lacks access to),
resource-scoped access (guardrail / custom-model /
inference-profile created in account A is 403 to account B).
M2.X.14 lifts the SIXTH
cross-provider error classifier to the kernel —
`isAuthenticationError(err)` in
`@crossengin/ai-providers/authentication.ts`. Closes ADR-0127
Q1 mechanically. All three providers (Anthropic, OpenAI,
Bedrock) already emit `authentication_error` from
`classifyHttpStatus(401)`; Bedrock additionally maps
ExpiredTokenException / InvalidSignatureException /
MissingAuthenticationTokenException / UnrecognizedClientException
via CODE_TO_KIND. The kind is wired everywhere — this
milestone adds the kernel-level predicate. Zero provider
changes required. Structurally identical to the prior five
classifiers (M2.X.6.x / M2.X.7 / M2.X.9 / M2.X.12 / M2.X.13):
AUTHENTICATION_ERROR_KINDS tuple + isAuthenticationErrorKind
predicate + isAuthenticationError(err) duck-typed
discriminator on .kind. Single-kind tuple (authentication_error
only). Explicitly EXCLUDES permission_error (HTTP 403 vs 401
have distinct remediation paths — auth = rotate credentials,
permission = grant access or use different principal);
operators wanting both compose isAuthenticationError(err) ||
isPermissionError(err). Three workflow patterns documented:
credential rotation flow (catch + refresh + retry),
multi-tenant key validation at request boundary (translate
to TenantKeyInvalidError with structured message), CI boot-
time credential check (fail loud rather than burying in
generic exception). isPermissionError (HTTP 403) is the next
mechanical lift, called out as Q1 in ADR-0128. M2.X.13 lifts
the FIFTH
cross-provider error classifier to the kernel —
`isNotFoundError(err)` in
`@crossengin/ai-providers/not-found.ts`. All three providers
(Anthropic, OpenAI, Bedrock) already emit `not_found_error`
from their `classifyHttpStatus(404)` paths; this milestone
adds the kernel-level predicate so operators can write
provider-agnostic `catch` blocks. Zero provider changes
required — the kind was already wired everywhere; only the
kernel module is new. Structurally identical to the prior
four classifiers (`isModerationError` M2.X.6.x,
`isRetryableError` M2.X.7, `isInputTooLargeError` M2.X.9,
`isConflictError` M2.X.12): `NOT_FOUND_ERROR_KINDS` tuple +
`isNotFoundErrorKind` predicate + `isNotFoundError(err)`
duck-typed discriminator on `.kind`. Single-kind tuple
(`not_found_error`); future variants extend additively. The
kernel error-space partition now has five buckets: retryable
(try again with backoff), moderation (terminal; audit),
input-too-large (terminal; reduce input), conflict (terminal;
reconcile state), not-found (terminal; resource absence —
NEW), other (auth / permission / invalid_request / unknown).
Pattern fully mature across five classifiers. Idempotent
cleanup workflows now have a documented cross-provider
pattern: `catch (err) { if (!isNotFoundError(err)) throw err }`.
M2.X.11.x wires `cacheBreakpoint`
through the Bedrock Converse translator (the deferred Q1 from
ADR-0125). Single-line change in
`@crossengin/ai-providers-bedrock/converse-api.ts`
appendKernelBlocks loop: after emitting each translated block,
if the kernel block carries cacheBreakpoint, append the shared
BEDROCK_CACHE_POINT constant
({cachePoint: {type: "default"}}). The supporting
infrastructure (BedrockCachePointBlock type,
BEDROCK_CACHE_POINT constant, isCachePointBlock discriminator)
was pre-built in M2.9 — this milestone is the call site that
finally uses them. Vocabulary asymmetry preserved: kernel uses
"ephemeral" (matching Anthropic-first naming); Bedrock wire
uses "default" (only documented value); translator maps
ephemeral → default verbatim. Cross-provider parity achieved
across Anthropic + Bedrock for the cacheBreakpoint field;
OpenAI continues to silently drop (no per-block knob in their
API). All four prior M2.X.5.* multimodal block variants
(image / document / file_id / tool_use) benefit end-to-end on
Bedrock now. Pure translator change — no new types, no new
transport, no kernel API change. Tool-role messages don't yet
preserve cacheBreakpoint (existing translator flattens to
string via contentToText) — Q1 deferred. M2.X.11 adds a
`cacheBreakpoint?:
LlmCacheBreakpoint` optional field on every LlmContentBlock
variant (text / image / image_url / document / document_url /
file_id / tool_use / tool_result — all 8 schemas extended).
`LlmCacheBreakpoint` is a `{type: "ephemeral"}` shape;
LLM_CACHE_BREAKPOINT_TYPES is a single-value const tuple
(future Anthropic extensions like persistent or named-key
caching extend the tuple without breaking call sites). Wired
through the Anthropic translator: `translateKernelBlock`
refactored to call `translateKernelBlockShape` then
post-process via `withCacheControl` that shallow-spreads
`cache_control: {type: "ephemeral"}` when the kernel field
is present. AnthropicContentBlock union widened — every
variant gains an optional cache_control field; new
AnthropicCacheControl type alias exported. OpenAI translators
(chat-api + responses-api) silently drop the field (OpenAI
handles caching implicitly via prefix-stability heuristics;
no per-block knob). Bedrock translator silently drops for
now (Bedrock Converse uses a SEPARATE `{cachePoint: {type:
"default"}}` BLOCK type — structurally different wire shape;
future M2.X.11.x can wire). Token economics: operators with
long-context chat workloads (10k+ tokens repeated across
turns) see ~10x input-cost reduction on cache hits via
Anthropic. Three patterns enabled: long static context
(document block at start of every turn marked cached),
multi-turn tool sessions (tool_result of expensive search
cached for subsequent turns), few-shot prefixes (final
example block cached so variant inputs hit cache). All
existing tests pass without modification. M2.X.5.aa.z.19 ships
`BedrockProvider.stopModelCustomizationJob(jobIdentifier)` —
the operator-initiated abort surface paired with
M2.X.5.aa.z.17/.18's read pair (the Stopping/Stopped statuses
in the 5-value tuple now have a programmatic trigger). Pure
reuse of established rails — POST endpoint via
signedControlPlanePost (M2.X.5.aa.z.5) with empty body;
URI-encoded path /model-customization-jobs/{encoded}/stop;
returns void on success. No new types / modules / transport.
Error mapping: 200 → resolve, 400 ValidationException →
invalid_request_error, 403 AccessDeniedException →
permission_error, 404 ResourceNotFoundException →
not_found_error, 409 ConflictException → conflict_error
(via M2.X.12's CODE_TO_KIND mapping; THIRD Bedrock endpoint
emitting 409 — isConflictError classifier is now load-bearing
across stopBatch + createBatch + stopModelCustomizationJob),
429 ThrottlingException → rate_limit_error. Three operational
workflows unblocked: cost-runaway kill switches for fine-tunes
(detect long-running InProgress → stop), tenant-offboarding
fine-tune cancellation sweeps (paired with
listModelCustomizationJobs({nameContains}) + status filter),
compliance kill switches (new policy lands → stop in-flight
fine-tunes that may violate it). Bedrock control-plane surface
now has 17 of N operations. Customization-job read+write
surface is feature-equivalent to batch surface (M2.X.5.aa.z.3
shipped batch list/get/stop/create; this milestone closes the
equivalent stop for customization jobs).
M2.X.5.aa.z.18 ships
`BedrockProvider.getModelCustomizationJob(jobIdentifier)` —
the rich-detail companion to listModelCustomizationJobs
(M2.X.5.aa.z.17). Fifth extended-shape detail instance after
Guardrail (M2.X.5.aa.z.8) / ImportedModel (M2.X.5.aa.z.12) /
CustomModel (M2.X.5.aa.z.14) / ModelImportJob
(M2.X.5.aa.z.16). Pattern now fully mature across 5 AWS
resource types. Structurally analogous to getCustomModel:
9 required top-level fields (jobArn / jobName /
outputModelName / roleArn / status / creationTime /
baseModelArn / trainingDataConfig / outputDataConfig) +
13 optional. Eight new typed sub-shapes in
`model-customization-jobs-api.ts`:
BedrockModelCustomizationJobS3Config, Validator,
ValidationDataConfig, TrainingMetrics, ValidationMetric,
VpcConfig, TeacherModelConfig, DistillationConfig,
CustomizationConfig — structurally mirror the
BedrockCustomModel* types from M2.X.5.aa.z.14 but typed
under their own prefix (AWS-contract preservation; if AWS
diverges them later, no shared-type refactor needed).
parseModelCustomizationJobDetail validates 9 required fields,
reuses isBedrockModelCustomizationJobStatus discriminator
from M2.X.5.aa.z.17 (5-value tuple including Stopping /
Stopped), enforces hyperParameters as Record<string, string>
matching AWS wire contract, validates trainingLoss +
validationLoss as finite numbers (NaN/Infinity throw),
validates VPC arrays of strings. Field-naming asymmetry vs
summary preserved verbatim: summary uses customModelArn /
customModelName (populated post-success); detail uses
outputModelName (required — operator's requested name) +
outputModelArn (optional — populated post-success).
Operators map between them at the application layer.
Provider validates identifier non-empty BEFORE fetch,
URI-encodes path, reuses signedControlPlaneGet rail. Bedrock
control-plane surface now has 16 of N operations; module
count unchanged at 16. Customization-job read story complete
(list + get). Five extended-shape detail instances now in
place — pattern is extremely stable. M2.X.5.aa.z.17 ships
`BedrockProvider.listModelCustomizationJobs(options?)` against
AWS's `ListModelCustomizationJobs` endpoint — the seventh
paginated control-plane enumeration. Parallels
M2.X.5.aa.z.15's listModelImportJobs surface but for
AWS-native fine-tunes/continued-pretrains/distillations (vs
externally-trained imports). BedrockCustomModelDetail
(M2.X.5.aa.z.14) surfaces a jobArn pointing to the
ModelCustomizationJob that produced the model;
listModelCustomizationJobs enumerates those jobs.
Pipeline-health monitoring, failure triage, throughput
analysis, cost attribution all unblocked. Key asymmetry vs
import jobs: customization jobs have a RICHER 5-value status
vocabulary — InProgress / Completed / Failed / Stopping /
Stopped (operators can issue StopModelCustomizationJob
mid-training to abort an expensive fine-tune). New module
`model-customization-jobs-api.ts` exports
BEDROCK_MODEL_CUSTOMIZATION_JOB_STATUSES 5-value tuple
(mixed-case preserved verbatim, case-sensitive discriminator),
boundary-validation constants, sortBy/sortOrder tuples,
BedrockModelCustomizationJobSummary (5 required fields:
jobArn, jobName, baseModelArn, status, creationTime + 5
optional: lastModifiedTime, endTime, customModelArn,
customModelName, customizationType),
BedrockModelCustomizationJobListResponse,
buildModelCustomizationJobListQuery pure boundary-validator
(8 optional parameters: creationTimeBefore/After +
nameContains + statusEquals + maxResults + nextToken +
sortBy + sortOrder), strict parsers. customizationType
preserved as string for forward-compat against AWS additions
(FINE_TUNING / CONTINUED_PRE_TRAINING / DISTILLATION
documented; AWS adds new). Provider reuses
signedControlPlaneGet rail. Bedrock control-plane surface now
has 15 of N operations; module count up to 16. Seven
paginated enumerations now in place across 7 AWS resource
types — the boundary-validator + strict-parser pattern is
fully mature. M2.X.5.aa.z.16 ships
`BedrockProvider.getModelImportJob(jobIdentifier)` — the
rich-detail companion to listModelImportJobs (M2.X.5.aa.z.15).
Failure-triage workflows now fully unblocked: when a Failed
job surfaces in the roster, operators look up the specific
job to read failureMessage (AWS's typed error),
modelDataSource.s3DataSource.s3Uri (S3 source bucket),
roleArn (IAM role for permission verification),
importedModelKmsKeyArn (KMS compliance), vpcConfig (subnet +
security-group routing). Fourth extended-shape detail
instance in the Bedrock package after Guardrail
(M2.X.5.aa.z.8), ImportedModel (M2.X.5.aa.z.12), and
CustomModel (M2.X.5.aa.z.14). Pattern fully stable. New
types in `model-import-jobs-api.ts`:
BedrockModelImportJobS3DataSource ({s3Uri}),
BedrockModelImportJobDataSource ({s3DataSource}),
BedrockModelImportJobVpcConfig ({subnetIds[],
securityGroupIds[]}), BedrockModelImportJobDetail (5 required
+ 8 optional fields). parseModelImportJobDetail strict
parser validates 5 required fields, reuses
isBedrockModelImportJobStatus discriminator from
M2.X.5.aa.z.15, validates nested s3DataSource.s3Uri + VPC
arrays of strings. Provider validates identifier non-empty
BEFORE fetch, URI-encodes path component, reuses
signedControlPlaneGet rail. Asymmetry with summary preserved:
importedModelArn + importedModelName optional in both
(populated only post-success per AWS docs); detail adds
roleArn (required), failureMessage (Failed-only),
modelDataSource (required), vpcConfig (optional),
importedModelKmsKeyArn (optional). Bedrock control-plane
surface now has 14 of N operations; module count unchanged at
15. M8 closes the workflow runtime
depth gap — the first production-grade observability surface
for workflows. New `WorkflowInstrumentation` interface in
`@crossengin/workflow-runtime/src/instrumentation.ts` with 11
documented event kinds (instance_started / instance_completed
/ instance_failed / instance_cancelled / state_transitioned /
signal_received / signal_consumed / timer_fired /
activity_scheduled / action_applied / engine_error),
`WorkflowInstrumentationEvent` shape (kind, tenantId,
instanceId, definitionId, correlationId, occurredAt,
durationMs, attributes JSONB), NoopInstrumentation default,
captureInstrumentation() in-memory buffer for testing,
combineInstrumentations(...children) fan-out helper (returns
noop for empty input, single child unchanged, sequential await
for multiple), isWorkflowInstrumentationKind discriminator.
Engine wired at 8 key paths: startInstance emits
instance_started; submitSignal emits signal_received then
signal_consumed; tickTimers emits timer_fired per fired
timer; cancelInstance emits instance_cancelled; applyTransition
emits state_transitioned; applyScheduleActivity emits
activity_scheduled; emitTerminalForStateKind emits
instance_completed / instance_failed / instance_cancelled
based on terminal kind (guarded by Set against
double-emission when runStepLoop re-enters). Internal state
widened: instanceDefinition: Map<instanceId, definitionId>
tracks definition IDs for instrumentation event correlation;
registerInstance() gains optional definitionId parameter.
`emitInstrumentation(kind, fields)` private helper builds
the typed event with occurredAt from engine clock, routes
through this.instrumentation.onEvent, and SWALLOWS exceptions
— instrumentation failures must NEVER crash the engine
(errors land in the noop sink as engine_error events for
operator-side observability). New kernel meta-schema table
META_WORKFLOW_TRACES (120th table) — observability-only,
distinct from the source-of-truth META_WORKFLOW_EVENTS:
id UUID PK, tenant_id (RLS-isolated), instance_id (FK CASCADE
to workflow_instances), definition_id (FK SET NULL to
workflow_definitions), kind (11-value CHECK constraint),
occurred_at, duration_ms, correlation_id, attributes JSONB,
created_at. Three indexes optimized for time-series queries:
(instance_id, occurred_at), (tenant_id, kind, occurred_at),
(tenant_id, correlation_id). RLS tenant_isolation policy
applied. New `PostgresWorkflowInstrumentation` in
`@crossengin/workflow-runtime-pg/src/instrumentation.ts`
implements WorkflowInstrumentation.onEvent by writing to
meta.workflow_traces via WorkflowInstanceIdResolver +
WorkflowDefinitionIdResolver — tolerates unresolved instance/
definition IDs (writes null UUIDs so engine_error events that
happen mid-startup don't break). `buildPersistentEngine`
gains two new optional inputs: `instrumentation?:
WorkflowInstrumentation` (direct hook, overrides
persistTraces) and `persistTraces?: boolean` (when true,
auto-constructs PostgresWorkflowInstrumentation against the
same connection + resolvers). resolveInstrumentation
precedence: explicit instrumentation > persistTraces auto >
NoopInstrumentation fallback. OTel-ready — event shape is a
subset of OTel SpanEvent; operators write thin adapter in
~20 lines. Backwards compat preserved — all pre-M8 engine
tests pass without modification. M5.10.5 closes the M2.X.5
loop —
the `crossengin chat` REPL in `apps/architect-cli` now accepts
inline content-block attachments. Before this milestone the
kernel `LlmMessage.content` supported `string | readonly
LlmContentBlock[]` (since M2.X.5 / ADR-0088) and all four
provider translators handled the union, but the REPL still
serialized every user turn as a plain string — operators
couldn't paste an image_url, file_id, or document_url into a
chat turn. M5.10.5 adds five new exports to
`apps/architect-cli/src/chat.ts`: `UserContent` type alias
(`string | readonly LlmContentBlock[]`), `parseUserLine(line)`
slash-command parser returning a discriminated
`ParsedUserLine` union (kinds: attach / clear_attachments /
show_attachments / exit / send / noop / error),
`composeUserContent(text, pendingBlocks)` that returns plain
string when no pending blocks or LlmContentBlock[] otherwise,
`userContentToTranscriptText(content)` that flattens blocks
to bracketed placeholders for transcript storage (transcript
schema's content field stays string-typed),
`describeAttachment(block)` human-readable single-line
description. Slash-command vocabulary: `/attach image_url
<url>`, `/attach document_url <url>`, `/attach file_id <id>`,
`/attach text <text>` (prefatory context), `/clear-attachments`,
`/show-attachments`. Existing `/exit` and `/quit` preserved.
REPL loop maintains pendingBlocks[] state — after a successful
send, pending blocks reset to empty (per-turn semantics, no
leak across turns). `ChatTurnInput.userInput` +
`ChatExchangeOptions.userInput` widened from `string` to
`UserContent`. `buildCompletionRequest` + `runChatTurn`
unchanged — type widening propagates through
`LlmMessage.content` since the kernel union already supported
it. Transcript flattens block-rich messages to placeholder
strings so DB schema unchanged. Backwards compat fully
preserved — all 42 pre-existing chat tests pass without
modification. 34 new tests cover parseUserLine (10 cases —
plain text / noop / exit / clear / show / 4 attach types /
unknown type / missing value / fall-through), composeUserContent
(4 cases — string / blocks+text / multiple blocks / empty
text), userContentToTranscriptText (5 cases — string /
image_url / file_id / document_url / image bytes),
describeAttachment (5 cases — all block types + truncation),
runChatExchange with content blocks (2 cases), runChatRepl
attachment commands (5 cases — thread through / clear /
show / parse error / no leak across turns). Pattern set for
future kernel multimodal additions: when M2.X.5.aa.z.x adds
a new block variant, the REPL gets a new /attach branch +
tests (~5 lines). M2.X.12 ships the fourth
cross-provider kernel error classifier — `isConflictError(err)`
in `@crossengin/ai-providers/conflict.ts`. Two Bedrock 409-
emitting endpoints (stopBatch from M2.X.5.aa.z.5 + createBatch
from M2.X.5.aa.z.6) plus OpenAI's documented 409 surfaces (run
state conflicts, file uniqueness) plus Anthropic forward-compat
now justify lifting the classifier to the kernel. Structurally
identical to the three prior classifiers (`isModerationError`
M2.X.6.x, `isRetryableError` M2.X.7, `isInputTooLargeError`
M2.X.9): `CONFLICT_ERROR_KINDS` tuple + `isConflictErrorKind`
predicate + `isConflictError(err)` duck-typed discriminator on
`.kind`. Single-kind tuple (`conflict_error`) for now;
future-compats additional sub-types. Three provider error
tables extended: Bedrock adds conflict_error to
BEDROCK_ERROR_KINDS, classifyHttpStatus(409) →
conflict_error, CODE_TO_KIND["ConflictException"] →
conflict_error; OpenAI + Anthropic add conflict_error to their
KINDS + classifyHttpStatus(409) → conflict_error. conflict_error
is NOT in any provider's RETRYABLE_KINDS — state conflicts are
terminal, operator must reconcile state. Two existing
M2.X.5.aa.z.5 / M2.X.5.aa.z.6 tests upgraded to assert the new
classified kind (they previously asserted only `.code` since
`.kind` was a placeholder `unknown_error`). Pattern: when ≥2
providers emit semantically-equivalent error class, lift
classifier to kernel. Trigger from M2.X.5.aa.z.5 and
M2.X.5.aa.z.6 ADRs ("dedicated conflict_error kernel kind
deferred until a second 409-emitting endpoint lands") is met.
M2.X.5.aa.z.15 ships
`BedrockProvider.listModelImportJobs(options?)` against AWS's
`ListModelImportJobs` endpoint — the sixth paginated control-
plane enumeration. BedrockImportedModelDetail (M2.X.5.aa.z.12)
surfaces a `jobArn` field; M2.X.5.aa.z.15 closes the gap by
making those jobs enumerable. Pipeline-health monitoring
("how many imports are InProgress / Completed / Failed?"),
failure triage (statusEquals=Failed enumerates broken
imports), and throughput analysis (time-range filters) now
viable. New module `model-import-jobs-api.ts` exports
`BEDROCK_MODEL_IMPORT_JOB_STATUSES` 3-value tuple (InProgress
/ Completed / Failed — mixed case preserved verbatim;
case-sensitive discriminator), boundary-validation constants,
`BedrockModelImportJobSummary` (4 required + 4 optional
fields where `importedModelArn` + `importedModelName` only
populated post-success — AWS asymmetry mirrored verbatim),
`BedrockModelImportJobListResponse`,
`buildModelImportJobListQuery` pure boundary-validator (8
optional parameters including the same time-range +
nameContains + statusEquals + sortBy/sortOrder pattern as
sibling enumerations), strict parsers. Provider reuses
signedControlPlaneGet rail. Bedrock control-plane surface
now has 13 of N operations; module count up to 15. Sixth
paginated enumeration with the boundary-validator + strict-
parser pattern — extremely stable across this many instances.
M2.X.5.aa.z.14 ships
`BedrockProvider.getCustomModel(modelIdentifier)` — the
rich-detail companion to listCustomModels. Compliance teams +
ML-ops engineers need 8 things the summary lacks: training-
data provenance (`trainingDataConfig.s3Uri`), validation-data
provenance (`validationDataConfig.validators[].s3Uri`),
output-artifact location (`outputDataConfig.s3Uri`), quality
metrics (`trainingMetrics.trainingLoss`,
`validationMetrics[].validationLoss`), hyperparameter
reproducibility (`hyperParameters` map),
distillation lineage (`customizationConfig.distillationConfig.
teacherModelConfig`), KMS-key audit (`modelKmsKeyArn`),
customization-job correlation (`jobArn`). Follows the
extended-shape pattern (third instance after Guardrail +
ImportedModel) since AWS returns substantively richer fields
than the summary — 15 detail fields vs 8 summary fields. Eight
new typed sub-shapes in `custom-models-api.ts`:
BedrockCustomModelS3Config (shared by training + output
configs), BedrockCustomModelValidator,
BedrockCustomModelValidationDataConfig (wraps validators[] —
operators can validate against multiple datasets),
BedrockCustomModelTrainingMetrics (currently
{trainingLoss?: finite-number}; AWS may add fields),
BedrockCustomModelValidationMetric (one per validator),
BedrockCustomModelTeacherModelConfig (only present for
DISTILLATION — {teacherModelIdentifier,
maxResponseLengthForInference?}),
BedrockCustomModelDistillationConfig,
BedrockCustomModelCustomizationConfig (wraps distillation —
gives AWS room to add adapter / RLHF / future configs without
breaking the kernel). hyperParameters parsed as
Record<string, string> matching AWS's wire contract (AWS
serializes numeric hyperparams as strings; operators parse at
the app layer). Strict finite-number validation on
trainingLoss + validationLoss — NaN / Infinity throw api_error.
Provider validates identifier non-empty BEFORE fetch,
URI-encodes path (handles ARN colons), reuses
signedControlPlaneGet rail. Bedrock control-plane surface now
has 12 of N operations. M2.X.5.aa.z.13 ships
`BedrockProvider.listCustomModels(options?)` against AWS's
`ListCustomModels` endpoint — the fifth paginated control-plane
enumeration after listBatches / listGuardrails /
listInferenceProfiles / listImportedModels. Bedrock has two
distinct surfaces for non-foundation models: imported models
(externally-trained, uploaded from S3 via
CreateModelImportJob — M2.X.5.aa.z.11/.12) and custom models
(fine-tunes / continued-pretrains / distillations of an
AWS-supported foundation model via
CreateModelCustomizationJob — this milestone). AWS exposes
them through separate endpoints (/imported-models vs
/custom-models) with different filter parameters; the kernel
matches the surface 1:1 rather than unifying. New module
`custom-models-api.ts` exports `BEDROCK_CUSTOM_MODEL_STATUSES`
3-value tuple (Active / Creating / Failed — mixed case
preserved verbatim from AWS, NOT uppercased like guardrails;
case-sensitive discriminator), boundary-validation constants,
`BedrockCustomModelSummary` (4 required fields: modelArn,
modelName, creationTime, baseModelArn + 4 optional:
baseModelName, customizationType as string for forward-compat
against AWS additions like DISTILLATION,
ownerAccountId, modelStatus validated against tuple when
present), and `buildCustomModelListQuery` pure boundary-
validator with the LARGEST filter set yet — 8 distinct
optional parameters (creationTimeBefore/After,
baseModelArnEquals, foundationModelArnEquals, nameContains,
isOwned boolean, modelStatus, maxResults [1, 1000], nextToken,
sortBy, sortOrder). isOwned boolean serialized as "true" /
"false" in the query string per AWS convention. modelStatus
optional in summaries (AWS omits it for some legacy entries —
strict parsing of optional fields when present, omit when
absent). customizationType preserved as raw string (same
forward-compat stance as modelArchitecture for imported
models). Provider reuses signedControlPlaneGet rail. Bedrock
control-plane surface now has 11 of N operations; module
count up to 14. Four operational workflows unblocked:
customization-job inventory ("show every fine-tune"),
base-model audit (filter by baseModelArnEquals for compliance),
cross-account discovery (isOwned=false surfaces shared-in
models), status-aware cleanup (modelStatus=Failed enumerates
broken customizations). M2.X.5.aa.z.12 ships
`BedrockProvider.getImportedModel(modelIdentifier)` — the
rich-detail companion to listImportedModels. Unlike
getInferenceProfile / getBatch (which use the type-alias
pattern since AWS returns identical shapes for list + get),
getImportedModel follows the M2.X.5.aa.z.8 getGuardrail
extended-shape pattern: AWS adds 4 fields the summary lacks
(`jobName`, `jobArn`, `modelDataSource.s3DataSource.s3Uri`,
optional `modelKmsKeyArn`). Three operational workflows
unblocked: provenance audits (compliance teams verifying
"model X imported from S3 URI Y by job Z"), KMS-key audits
(per-model encryption-key verification), import-job
correlation (linking finished models to their ModelImportJob
records). New types in `imported-models-api.ts`:
`BedrockImportedModelDetail` (independent type with explicit
fields — not a type alias because shapes diverge),
`BedrockImportedModelDataSource` (preserves AWS's 3-level
nesting `modelDataSource.s3DataSource.s3Uri` verbatim — gives
AWS room to add non-S3 data sources without breaking the
kernel), `BedrockImportedModelS3DataSource`,
`parseImportedModelDetail(raw)` strict parser. Provider
validates identifier non-empty BEFORE fetch, URI-encodes path,
reuses signedControlPlaneGet rail. Two get-shape patterns now
distinct in the Bedrock package: type-alias (batch + inference-
profile when AWS returns identical shapes) vs extended-type
(guardrail + imported-model when get returns richer fields).
The choice follows AWS's response shape, not kernel preference.
Bedrock control-plane surface now has 10 of N operations
(listBatches + getBatch + stopBatch + createBatch +
listGuardrails + getGuardrail + listInferenceProfiles +
getInferenceProfile + listImportedModels + getImportedModel).
M2.X.5.aa.z.11 ships
`BedrockProvider.listImportedModels(options?)` against AWS's
`ListImportedModels` endpoint — the fourth paginated
control-plane enumeration after listBatches / listGuardrails /
listInferenceProfiles. Custom Model Import lets customers
upload model artifacts (weights, tokenizer, config) from S3
and serve them through Bedrock alongside foundation models;
listImportedModels enumerates them for inventory + architecture-
aware routing + instruct-tuned discoverability + tenant cleanup
workflows. New module `imported-models-api.ts` exports 7
boundary-validation constants (maxResults bounds, nameContains
length bounds, sortBy + sortOrder tuples),
`BedrockImportedModelSummary` (5 required fields — modelArn,
modelName, creationTime, instructSupported,
modelArchitecture), `BedrockImportedModelListResponse`,
`buildImportedModelListQuery` pure boundary-validator
(creationTimeBefore/After ISO 8601 parseable, nameContains
length [1, 63], maxResults integer in [1, 1000], nextToken
non-empty, sortBy/sortOrder against tuples), and
`parseImportedModelListResponse` + `parseImportedModelSummary`
strict parsers. Validation discipline: modelArchitecture
preserved as raw string (AWS adds new architectures —
LLAMA2/LLAMA3/MISTRAL/FLAN/... — quarterly; strict enum
would be perpetually stale), instructSupported strict boolean
(catches API drift early). Provider reuses the existing
signedControlPlaneGet rail. Pattern stable across 4 paginated
enumerations now; adding listCustomModels /
listMarketplaceModelEndpoints is mechanical. Bedrock module
count up to 13; control-plane surface up to 9 of N
operations. M2.X.5.aa.z.10 ships
`BedrockProvider.getInferenceProfile(profileIdentifier)` — the
single-resource lookup companion to listInferenceProfiles.
AWS returns the SAME wire shape for GetInferenceProfile as a
ListInferenceProfiles entry; the kernel mirrors M2.X.5.aa.z.4's
getBatch pattern: `BedrockInferenceProfileDetail =
BedrockInferenceProfileSummary` type alias +
`parseInferenceProfileDetail = parseInferenceProfileSummary`
parser alias. Provider method validates the identifier
non-empty BEFORE the fetch (no wasted request on empty
input), URI-encodes the path component (handles dots/colons in
both ID form `us.anthropic.claude-3-5-sonnet-20241022-v2:0`
and ARN form), GETs `/inference-profiles/{encoded}` via the
existing M2.X.5.aa.z.3 signedControlPlaneGet rail, parses via
parseInferenceProfileDetail. AWS accepts BOTH the inference
profile ID and the full ARN as identifier — kernel preserves
this (strict regex would be brittle since IDs have
heterogeneous shapes across SYSTEM_DEFINED and APPLICATION
types, and AWS adds new regional prefixes regularly). Three
operational workflows unblocked: log-driven lookup (profile
ARN appears in CloudTrail / billing → fetch full record),
webhook-driven lookup (EventBridge emits Bedrock event →
look up by id), drift detection (spot-check one profile
without re-enumerating). Bedrock control-plane surface now
has 8 of N operations. Detail-alias pattern now proven twice
(M2.X.5.aa.z.4 + this); future single-resource lookups where
AWS returns identical shapes follow the same convention.
M2.X.5.aa.z.9 ships
`BedrockProvider.listInferenceProfiles(options?)` against
AWS's `ListInferenceProfiles` endpoint — the third paginated
control-plane enumeration after listBatches (M2.X.5.aa.z.3)
and listGuardrails (M2.X.5.aa.z.7). Cross-region inference
profiles route a single logical model ID (e.g.,
`us.anthropic.claude-3-5-sonnet-20241022-v2:0`) to ANY of N
regional model deployments with automatic failover — AWS's
recommended production-workload invocation path. New module
`inference-profiles-api.ts` exports
`BEDROCK_INFERENCE_PROFILE_STATUSES` (1-value tuple: ACTIVE),
`BEDROCK_INFERENCE_PROFILE_TYPES` (2-value tuple:
SYSTEM_DEFINED for AWS-managed | APPLICATION for
operator-created), discriminators, `BedrockInferenceProfileModel`
({modelArn}), `BedrockInferenceProfileSummary` (8 required
fields + optional description), `BedrockInferenceProfileListResponse`,
`buildInferenceProfileListQuery` pure boundary-validator
(typeEquals against tuple, maxResults integer in [1, 1000],
nextToken non-empty), and `parseInferenceProfileListResponse`
+ `parseInferenceProfileSummary` strict parsers. Provider
method reuses the existing `signedControlPlaneGet` rail.
Pagination pattern now proven THREE times — adding future
enumerations (listImportedModels, listCustomModels,
listMarketplaceModelEndpoints) is mechanical. Bedrock module
count up to 12; control-plane surface up to 7 of N
operations. M2.X.5.aa.z.8 ships
`BedrockProvider.getGuardrail(guardrailIdentifier,
guardrailVersion?)` — the rich-detail companion to
listGuardrails. While listGuardrails returns shallow summaries
sufficient for "show me every guardrail" audits, getGuardrail
returns the FULL policy bytes operators need for compliance
disclosures (SOC 2 / HIPAA / GDPR), drift detection between
authoring + runtime, and multi-version diffs. Response shape is
~5x the summary: 9 required top-level fields (guardrailId /
guardrailArn / name / version / status / createdAt / updatedAt
/ blockedInputMessaging / blockedOutputsMessaging) + 9 optional
(description / kmsKeyArn / statusReasons /
failureRecommendations + FIVE nested policy types). Five typed
policies modeled: contentPolicy ({filters[]} of {type:
SEXUAL|VIOLENCE|HATE|INSULTS|MISCONDUCT|PROMPT_ATTACK,
inputStrength: NONE|LOW|MEDIUM|HIGH, outputStrength:
same-tuple}), contextualGroundingPolicy ({filters[]} of {type:
GROUNDING|RELEVANCE, threshold: finite-number}),
sensitiveInformationPolicy ({piiEntities[]} of {type: string —
30+ AWS-extensible values, action: BLOCK|ANONYMIZE} +
{regexes[]} of {name, pattern, action, description?}),
topicPolicy ({topics[]} of {name, type: string — currently
only DENY, definition, examples?}), wordPolicy ({words[]} of
{text} + {managedWordLists[]} of {type: string — currently
only PROFANITY}). Validation discipline: stable AWS
vocabularies (4 enum tuples: filter strength, content filter
type, contextual grounding type, PII action) get strict
discriminators that throw on unknown; growing AWS vocabularies
(PII entity types, topic types, managed word list types)
preserve raw string for forward-compat. Field naming
asymmetry preserved verbatim: ListGuardrails uses {id, arn};
GetGuardrail uses {guardrailId, guardrailArn} — operators
map between them. Provider method validates both inputs
non-empty BEFORE the fetch, URI-encodes the path component
(ARN colons → %3A), threads optional guardrailVersion as a
query parameter (omitted → AWS returns DRAFT), reuses
signedControlPlaneGet rail. parseGuardrailDetail strict
parser: each policy parsed only when present in the response
(AWS only returns configured policies); missing required
top-level fields throw api_error. Bedrock control-plane
surface now has 6 of N operations (listBatches + getBatch +
stopBatch + createBatch + listGuardrails + getGuardrail);
Bedrock module count up to 11 (batch-api + converse-api +
embeddings + errors + event-stream + guardrails +
guardrails-api + pricing + provider + signing + index).
M2.X.5.aa.z.7 ships the second
Bedrock control-plane enumeration after listBatches:
`BedrockProvider.listGuardrails(options?)` against AWS's
`ListGuardrails` endpoint. Operators can now audit which
guardrails exist on their account, reconcile their internal
tenant→guardrail mapping against AWS's view, and detect drift
(a guardrail expected READY that's actually FAILED / DELETING)
— all through the kernel. New module `guardrails-api.ts`
exports `BEDROCK_GUARDRAIL_STATUSES` 6-value const tuple
(CREATING / UPDATING / VERSIONING / READY / FAILED / DELETING
— uppercase, AWS-verbatim), `BedrockGuardrailStatus` type +
`isBedrockGuardrailStatus` discriminator, `BedrockGuardrailSummary`
type (id / arn / status / name / version / createdAt /
updatedAt required + description optional),
`BedrockGuardrailListResponse` ({guardrails, nextToken?} —
nextToken omitted when absent / empty),
`buildGuardrailListQuery` pure boundary-validator (validates
guardrailIdentifier non-empty, maxResults integer in
[1, 1000], nextToken non-empty), and `parseGuardrailListResponse`
+ `parseGuardrailSummary` strict parsers. Provider method
reuses the existing `signedControlPlaneGet` rail from
M2.X.5.aa.z.3 — no transport changes; just a new path
(`/guardrails`). Behavioral note on AWS semantics: omitting
`guardrailIdentifier` returns the DRAFT version of every
guardrail (roster mode); supplying `guardrailIdentifier`
returns DRAFT + all numbered versions of that ONE guardrail
(version-history mode). Module separation discipline:
existing `guardrails.ts` continues to own inference-time
concerns (`BedrockGuardrailConfig`); new `guardrails-api.ts`
owns control-plane concerns. Both export through the barrel.
Bedrock control-plane surface now has 5 of N operations
(listBatches / getBatch / stopBatch / createBatch /
listGuardrails); pattern proven twice for paginated
enumeration; adding `listInferenceProfiles` /
`listImportedModels` / `listCustomModels` is now mechanical.
M2.X.5.aa.z.6 closes the Bedrock
batch CRUD with `BedrockProvider.createBatch(input)` against
AWS's `CreateModelInvocationJob` endpoint. All four documented
batch operations (list + get + stop + create) now have
provider methods. Operators can detect runaway jobs, stop
them, fix inputs, and relaunch — all through the kernel.
`buildCreateBatchBody(input)` is a pure exported boundary-
validator enforcing 14 documented AWS constraints BEFORE any
fetch: jobName pattern [a-zA-Z0-9](-*[a-zA-Z0-9])* length
1-63, modelId length 1-2048 (no pattern — AWS accepts base
IDs / ARNs / inference profile IDs / custom model ARNs / etc.),
roleArn AWS-partition-aware IAM-role pattern, s3Uri scheme
^s3://[a-z0-9.\-_]{1,255}/.* on both input + output,
s3InputFormat whitelist (only "JSONL"), clientRequestToken
shape + length 1-256, timeoutDurationInHours integer in
[24, 168], tags count ≤ 200 + key length 1-128 + value
length 0-256, vpcConfig.subnetIds + securityGroupIds counts
in [1, 16]. All ARN patterns AWS-partition-aware (aws,
aws-us-gov, aws-cn). `parseCreateBatchResponse(raw)` is
strict — `{jobArn}` only; missing / empty / non-string
throws api_error. AWS's create response really is just the
ARN — operators wanting fuller state call getBatch
immediately after. `signedControlPlanePost` widened from
M2.X.5.aa.z.5: now accepts `{path, body?}` with default empty
body; stopBatch's call unchanged (backwards-compatible).
Error mapping: 200 + {jobArn} → resolve, 400
ValidationException → invalid_request_error (e.g., role
lacks s3:GetObject), 403 → permission_error, 429 →
rate_limit_error, 409 ConflictException (jobName already
exists OR clientRequestToken reused with different payload)
→ kind: "unknown_error" + code: "ConflictException" (same as
M2.X.5.aa.z.5; dedicated conflict_error kernel kind now
justified by TWO 409-emitting endpoints — proposed as
M2.X.12). Operators get idempotency via clientRequestToken
(re-submitting same payload + same token returns same job
ARN), cost attribution via tags (threading tenant / purpose
/ cost-center to AWS Cost Explorer), and VPC-scoped batch
jobs (subnets + security groups). Boundary-validation pattern
set for future POST-with-body control-plane writes
(createGuardrail, createInferenceProfile, etc.) — pure body-
builder + exported response parser + provider thin wrapper.
M2.X.5.aa.z.5 ships
`BedrockProvider.stopBatch(jobIdentifier)` against AWS's
`StopModelInvocationJob` endpoint, completing the read/write
split on the batch surface (3 of 4 batch operations now
covered: list + get + stop; only createBatch deferred).
Method validates the identifier via the M2.X.5.aa.z.4
`isBedrockBatchJobIdentifier` regex BEFORE the fetch, URI-
encodes into `/model-invocation-jobs/{encoded}/stop`, POSTs
an empty body via a new private `signedControlPlanePost`
helper (sibling to M2.X.5.aa.z.3's `signedControlPlaneGet`
with method POST + content-type header + no query param),
returns `void` on success. AWS sig v4 handles empty bodies
correctly via SHA-256 of empty string. Error mapping:
404 ResourceNotFoundException → not_found_error, 403
AccessDeniedException → permission_error, 429
ThrottlingException → rate_limit_error, 400 ValidationException
→ invalid_request_error, network → network_error. 409
ConflictException (job already in terminal state, e.g., race
between poll + stop) surfaces with `kind: "unknown_error"` +
`code: "ConflictException"` — operators discriminating on
`.code` get clean detection; a dedicated `conflict_error` kind
deferred to when a second 409-emitting endpoint lands. Three
operational workflows unblocked: cost-runaway kill switches
(detect long-running job → stop), tenant-offboarding
cancellation sweeps (paired with listBatches({nameContains}) +
status filter), compliance kill switches (new policy lands →
stop in-flight jobs). POST rail established —
signedControlPlanePost is reusable for future control-plane
POSTs with empty bodies (state mutations on guardrails /
inference profiles / custom models). M2.X.5.aa.z.4 adds
`BedrockProvider.getBatch(jobIdentifier)` — single-job
lookup against AWS's `GetModelInvocationJob` control-plane
endpoint, pairing with M2.X.5.aa.z.3's `listBatches` for
polling, failure diagnostics, and webhook-driven retrieval
workflows. New exports in `batch-api.ts`:
`BedrockBatchJobDetail` type alias (same shape as
`BedrockBatchJobSummary` — AWS returns identical wire
formats for both endpoints), `BEDROCK_BATCH_JOB_IDENTIFIER_
PATTERN` regex covering both AWS-accepted forms (12-char
lowercase-alphanumeric unique id OR full job ARN across the
three AWS partitions: aws, aws-us-gov, aws-cn),
`isBedrockBatchJobIdentifier(value)` discriminator,
`parseBatchJobDetail(raw)` exported wrapper around the
(now-also-exported) `parseBatchJobSummary` parser.
`getBatch` validates the identifier via the regex BEFORE
the fetch (invalid input throws `BedrockError` with
invalid_request_error kind without burning a request),
URI-encodes the identifier in the path (`encodeURIComponent`
converts ARN colons to %3A), GETs
`/model-invocation-jobs/{encoded}` via the existing
M2.X.5.aa.z.3 `signedControlPlaneGet` helper, parses via
`parseBatchJobDetail`. 404s surface as typed
not_found_error via the existing CODE_TO_KIND map
(ResourceNotFoundException → not_found_error); other
errors route through `fromHttpResponse` /
`fromNetworkError` paths as M2.X.5.aa.z.3. Bedrock
control-plane surface now has 2 of N operations
(listBatches + getBatch); pattern set for future
single-resource lookups (`getGuardrail`,
`getInferenceProfile`, etc.) following the same
regex-validate → encode → signedControlPlaneGet → parse
shape. M2.X.5.aa.z.3 ships
`BedrockProvider.listBatches(options?)` against AWS Bedrock's
`ListModelInvocationJobs` control-plane endpoint. AWS does
not ship a Files API; batch inference is the closest
operational surface, and the same three workflows that
motivated `listFiles()` (tenant offboarding, storage audits,
reference reconciliation) all apply here. New `batch-api.ts`
module in `@crossengin/ai-providers-bedrock` exports
`BEDROCK_BATCH_JOB_STATUSES` (10-value const tuple matching
AWS's documented states: Submitted / InProgress / Completed /
Failed / Stopping / Stopped / PartiallyCompleted / Expired /
Validating / Scheduled), `BedrockBatchJobStatus` type +
`isBedrockBatchJobStatus` discriminator,
`BEDROCK_BATCH_SORT_BY_VALUES = ["CreationTime"]` +
`BEDROCK_BATCH_SORT_ORDER_VALUES = ["Ascending",
"Descending"]`, `BedrockBatchJobSummary` type mirroring AWS's
`InvocationJobSummary` (jobArn / jobName / modelId / roleArn
/ status / submitTime + s3InputDataConfig / s3OutputDataConfig
+ optional clientRequestToken / message / lastModifiedTime /
endTime / timeoutDurationInHours / jobExpirationTime /
vpcConfig), `BedrockBatchJobListResponse` ({invocationJob
Summaries, nextToken?} — nextToken omitted when absent/empty),
`buildBatchListQuery(options)` pure validator-builder
(statusEquals against tuple, maxResults int in [1, 1000],
nameContains length [1, 63], submitTimeAfter/Before parseable
via Date.parse, nextToken non-empty, sortBy/sortOrder against
tuples), and `parseBatchListResponse(raw)` strict parser.
`BedrockProvider.listBatches(options?)` GETs `/model-
invocation-jobs/` on the control-plane host with sig v4 +
sorted query string. Two-host model surfaced explicitly:
`controlPlaneBaseUrl` defaults to `https://bedrock.{region}.
amazonaws.com` (distinct from the existing `baseUrl` which
remains `https://bedrock-runtime.{region}.amazonaws.com`);
both use the same sig v4 service name (`bedrock`). New
private `signedControlPlaneGet({path, query})` helper threads
GET + empty body + URI-encoded query string through
`signRequest` (the `query` parameter on `signRequest` was
already supported since M2.9). Validation fast-fails BEFORE
the fetch — out-of-range maxResults / unknown statusEquals /
unparseable dates throw `BedrockError` with
`invalid_request_error` kind without burning a request. Errors
route through existing `fromHttpResponse` / `fromNetworkError`
helpers (AccessDeniedException → permission_error,
ThrottlingException → rate_limit_error, etc.). Bedrock now
has a read-only operational surface: pre-M2.X.5.aa.z.3 only
inference + embed methods existed. Three-provider enumeration
parity achieved (OpenAI listFiles, Anthropic listFiles,
Bedrock listBatches). Pattern set for future Bedrock control-
plane methods (getBatch, listGuardrails, listImportedModels,
listInferenceProfiles, listCustomModels) — same
signedControlPlaneGet rail. M2.X.5.aa.z.2 added `listFiles()`
to both OpenAI and Anthropic Files API surfaces, completing
the CRUD+list pattern. Closes ADR-0102 Q1 + ADR-0103 Q5.
Response types `OpenAIFileListResponse` and `AnthropicFile
ListResponse` were already defined in M2.X.5.aa.z /
M2.X.5.aa.z.1 — only the methods + tests are new.
`OpenAIProvider.listFiles({purpose?, limit?, order?, after?})`
GETs `/v1/files` with optional query params; limit validated
to [1, 10000]; purpose validated against
OPENAI_FILES_PURPOSES. `AnthropicProvider.listFiles({limit?,
beforeId?, afterId?, order?})` GETs `/v1/files` with the beta
header; limit validated to [1, 1000] (Anthropic's documented
max); camelCase kernel params translated to snake_case HTTP
params (`before_id`, `after_id`). Provider-native response
shapes preserved (OpenAI: just `{object, data}`; Anthropic:
`{data, has_more, first_id, last_id}`) — the kernel doesn't
try to unify pagination semantics. Use cases unblocked:
tenant offboarding (find + bulk-delete by tenant), storage
audits (total bytes by purpose), reference reconciliation
(diff operator records against provider state). M2.X.5.aa.z.1 ships Anthropic Files
API + makes the kernel `FileReferenceContentBlock` work
natively on Anthropic. Closes the throw from M2.X.5.aa.z. New
`files-api.ts` module in `@crossengin/ai-providers-anthropic`
exports `ANTHROPIC_FILES_BETA_HEADER = "files-api-2025-04-14"`
const, `AnthropicFile` / `AnthropicFileDeleteResponse` /
`AnthropicFileListResponse` types, and
`buildAnthropicMultipartUpload({bytes, filename, contentType?})`
encoder. Differs from OpenAI's encoder in two ways: NO purpose
field (Anthropic doesn't classify uploads), multipart body has
ONE part (just `file`). Same RFC 7578 quote escaping, random
per-call boundary, byte-for-byte binary preservation.
`AnthropicProvider` gains `uploadFile / retrieveFile /
deleteFile` methods POSTing/GETting/DELETEing `/v1/files` with
the beta header always present. `filesApiBetaHeader()` helper
merges + deduplicates against any operator-set `anthropicBeta`
constructor option. `FetchLike.body` widened from `string` to
`string | Uint8Array` (backwards-compatible). `AnthropicContent
Block` document variant gained a 4th source variant
`{type: "file", file_id}` alongside base64/url/text. Translator
removes the throw and emits `{type: "document", source:
{type: "file", file_id}, ...}` for kernel `file_id` blocks.
Cross-provider matrix updated: file_id now works natively on
OpenAI Responses + Anthropic; OpenAI Chat + Bedrock still throw
with actionable guidance. file_ids are NOT portable across
providers (operators upload to each provider they target). M2.X.5.aa.z adds full OpenAI Files
API integration: kernel `FileReferenceContentBlock` (8th
variant in LlmContentBlock discriminated union) +
`OpenAIProvider.uploadFile / .retrieveFile / .deleteFile`
methods. Closes ADR-0097 Q3. New types: `FileReferenceContent
BlockSchema = {type: "file_id", fileId: string.min(1).max(120)}`
(opaque text — kernel doesn't enforce the file-<24hex> shape).
Role validation: file_id rejected on tool messages (same rule
as documents/images). New OpenAI module `files-api.ts`
exports `OPENAI_FILES_PURPOSES = ["assistants", "batch",
"fine-tune", "vision", "user_data"]`, `OpenAIFile` /
`OpenAIFileDeleteResponse` types, `isOpenAIFilesPurpose`
discriminator, and `buildMultipartUpload(input)` —
manually-constructed multipart/form-data encoder producing
Uint8Array body + boundary-aware Content-Type. Random
per-call boundary (`----CrossEnginFormBoundary<rand>`); RFC
7578 quote escaping in filenames; binary content preserved
byte-for-byte. `OpenAIProvider` gained 3 methods:
`uploadFile({bytes, filename, purpose, contentType?})` POSTs
to `/v1/files` with multipart body; `retrieveFile(fileId)`
GETs `/v1/files/{id}`; `deleteFile(fileId)` DELETEs same
path. `FetchLike.body` widened from `string` to `string |
Uint8Array` (backwards-compatible). Per-provider translation:
OpenAI Responses API natively passes through to `{type:
"input_file", file_id}` (`OpenAIResponsesContentFileInput`
becomes a union of file_data + file_id variants); OpenAI Chat
Completions + Anthropic + Bedrock all THROW with actionable
"use Responses API path" / "use document block with inline
bytes" guidance. M2.X.10 enforces OpenAI's name
regex at the kernel layer + threads `LlmMessage.name` through
OpenAI Chat Completions on all four message roles (system,
user, assistant, tool). Pre-M2.X.10 only the tool-role
translator carried `name`; other roles silently dropped it.
New kernel exports `LLM_MESSAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/`
+ `LlmMessageNameSchema` (OpenAI's documented rules: 1-64
chars, alphanumeric + underscore + hyphen). Bad names fail at
zod parse time instead of as HTTP 400 from OpenAI. Anthropic +
Bedrock + OpenAI Responses silently DROP `name` at translation
(those APIs have no name field). Operators with multi-agent
orchestration on OpenAI Chat get first-class participant
attribution; cross-provider workflows aren't blocked because
of the silent-drop policy. Pre-M2.X.10 tool-role threading
preserved (regression-tested). M2.X.5.aa.x.1 expands the document
format enum from 4 to 9 formats by adding the office set
(doc, docx, xls, xlsx, html). Matches Bedrock Converse API's
full document-format set. Closes ADR-0099 Q1. New helpers
`OFFICE_DOCUMENT_FORMATS = ["doc", "docx", "xls", "xlsx",
"html"]` const tuple + `isOfficeDocumentFormat(format)`
discriminator. `documentMediaType` MIME map extended with the
5 office formats (application/msword,
application/vnd.openxmlformats-officedocument.wordprocessingml.
document, application/vnd.ms-excel,
application/vnd.openxmlformats-officedocument.spreadsheetml.
sheet, text/html). Per-provider: Bedrock translator
unchanged — already accepted all 9 formats; office formats
pass through natively. Anthropic gains an explicit throw
branch (BEFORE the text-format dispatch) for office formats
with conversion guidance: "convert to PDF, or use a different
provider (Bedrock supports office formats natively)". OpenAI
Responses gains an `isOfficeDocumentFormat` check + throw with
same conversion guidance. OpenAI Chat unchanged (still throws
on all documents). Operators using Bedrock get full 9-format
support; cross-provider workflows convert office documents to
PDF client-side. M2.X.5.aa.x expands the document
format enum from `["pdf"]` to `["pdf", "txt", "md", "csv"]`,
closing ADR-0097 Q1 (partially — office formats deferred).
New kernel helpers: `documentMediaType(format)` (single source
of truth for MIME-type mapping: application/pdf, text/plain,
text/markdown, text/csv); `isTextDocumentFormat(format)`
(discriminator between PDF and text formats). Per-provider:
Bedrock translator unchanged — the BedrockDocumentContentBlock.
format type already accepted the broader Bedrock format set;
all 4 kernel formats pass through natively. Anthropic
translator becomes format-aware — PDF uses the existing
`source: {type: "base64", media_type: "application/pdf"}`
shape; txt/md/csv use the new `source: {type: "text",
media_type, data}` shape with bytes decoded from base64 to
UTF-8 via Node's Buffer. AnthropicContentBlock document
variant extended with the text source. OpenAI Responses
translator uses `documentMediaType` for the data URL MIME
prefix — all 4 formats flow as input_file with correct MIME.
OpenAI Chat still throws (no document support). Office formats
(doc/docx/xls/xlsx/html) deferred to future milestone — only
Bedrock supports them natively; adding now would create
two-provider throw asymmetry. Document parity post-M2.X.5.aa.x:
4 formats × 3 providers (Bedrock + Anthropic + OpenAI
Responses) all native. M2.X.5.aa.y adds a URL-based document
variant alongside the M2.X.5.aa bytes variant, closing ADR-0097
Q2. New `DocumentUrlContentBlock` type `{type: "document_url",
url: string, format?: DocumentFormat, name?: string<120}` added
to the LlmContentBlock discriminated union (grows from 6 to 7
variants). URL validated via `z.string().url()` at parse time;
format + name both optional (URL Content-Type provides format
hint; provider-side defaults apply where needed). Same role rule
as document (rejected on tool messages). Per-provider
translation: Anthropic passes URL through to `{type: "document",
source: {type: "url", url}, title?}` (native support, same shape
as the M2.X.5.z URL image variant); Bedrock + OpenAI Responses +
OpenAI Chat all THROW with actionable pre-fetch / use-Files-API
guidance. Three of four provider paths throw — same asymmetry
as image_url (M2.X.5.y). Document parity post-M2.X.5.aa.y: bytes
on Bedrock + Anthropic + OpenAI Responses; URLs on Anthropic
only. Operators with mixed-provider workflows pre-fetch URLs to
bytes when targeting non-Anthropic providers. M2.X.5.aa adds a `DocumentContentBlock`
variant to the kernel content union for PDF inputs, closing
ADR-0096 Q7. New types in `@crossengin/ai-providers/src/types.ts`:
`DOCUMENT_FORMATS = ["pdf"]` const tuple (singleton; future
expansion purely additive), `DocumentFormat` type,
`DocumentContentBlockSchema = {type: "document", format,
bytes, name?: string<120}`. `LlmContentBlockSchema` discriminated
union grows from 5 to 6 variants. Same role rule as images
(rejected on tool messages). Per-provider translation: Bedrock
emits `{document: {format, name, source: {bytes}}}` (defaults
name to "document"); Anthropic emits `{type: "document", source:
{type: "base64", media_type: "application/pdf", data}, title?}`
(maps kernel `name` → Anthropic `title`); OpenAI Responses API
emits `{type: "input_file", filename, file_data: "data:
application/pdf;base64,<bytes>"}` (defaults filename to
"document.<format>"); OpenAI Chat Completions THROWS with
actionable error message pointing to the Responses API path.
Both `BedrockDocumentContentBlock` and `OpenAIResponses
ContentFileInput` added to their respective provider unions.
Anthropic's `AnthropicContentBlock` gains the document variant
with both base64 + url source types (URL variant added for
future M2.X.5.aa.y). Provider asymmetry: three of four real
provider paths support PDFs natively; OpenAI Chat throws with
actionable "use Responses API path" guidance. M2.X.5.z removes the M2.X.5.y throw
in the Anthropic translator + threads URLs through to
Anthropic's native URL source variant, closing ADR-0094 Q3.
Anthropic recently added URL source support; the
`AnthropicContentBlock` image source becomes a discriminated
union on `source.type`: existing `{type: "base64", media_type,
data}` variant unchanged + new `{type: "url", url}` variant
added. `translateKernelBlock` for `image_url` now returns
`{type: "image", source: {type: "url", url: block.url}}`
instead of throwing. Provider parity for URL-based images is
now: OpenAI Chat Completions ✓, OpenAI Responses ✓, Anthropic
✓. Bedrock ✗ (still throws — Bedrock's image source format
has no URL variant; operators with cross-provider URL workflows
pre-fetch bytes when targeting Bedrock). Format hint dropped on
URL path (Anthropic infers from response Content-Type). The
existing M2.X.5.y throw test was replaced with two passthrough
tests: pure URL translation + mixed bytes + URL in same
message. M2.X.9 adds the third kernel-level
cross-provider error classifier: `isInputTooLargeError(err)`.
Follows the same shape as M2.X.6.x (`isModerationError`) and
M2.X.7 (`isRetryableError`) — duck-types on `.kind` against a
shared tuple. New `input-too-large.ts` module exports
`INPUT_TOO_LARGE_ERROR_KINDS = ["request_too_large"]`
(singleton tuple — all three providers map HTTP 413 to this
kind via their classifyHttpStatus paths),
`InputTooLargeErrorKind` type, `isInputTooLargeErrorKind`
discriminator, `InputTooLargeDiscriminator` interface, and the
headline predicate. The kernel surface now partitions the
error space into eight COMPLETE buckets: retryable (try again
with backoff), moderation (terminal; audit), input-too-large
(terminal; reduce input — 413), conflict (terminal;
reconcile state — 409 / M2.X.12), not-found (terminal;
resource absence — 404 / M2.X.13), authentication (terminal;
rotate credentials — 401 / M2.X.14), permission (terminal;
grant access or switch principal — 403 / M2.X.15),
invalid-request (terminal; fix request shape — 400 /
M2.X.16). Canonical 4xx/5xx sweep complete — every documented
kernel error kind across all three providers has a kernel
classifier. Operators classifying errors across providers use
eight parallel discriminators with no provider-package
imports: isModerationError + isRetryableError +
isInputTooLargeError + isConflictError + isNotFoundError +
isAuthenticationError + isPermissionError +
isInvalidRequestError.
Mutual exclusivity verified by tests: a request_too_large
error is NOT retryable + NOT a moderation event.
Cross-package integration tests in all three providers verify
the predicate works against their native error classes.
Pattern continues to scale — adding a fourth classifier (e.g.
isSafetyFilterError if a provider ships a distinct kind) is an
additive tuple expansion. M2.X.5.y adds a URL-based image
variant to the kernel content union, closing ADR-0093 Q1. New
`ImageUrlContentBlock` type `{type: "image_url", url: string,
format?: ImageAttachmentFormat}` added to the LlmContentBlock
discriminated union (grows from 4 to 5 variants: text, image,
image_url, tool_use, tool_result). URL validated via
`z.string().url()` at parse time; `format` optional (URL
responses' Content-Type tells the provider). Same role rule as
image (rejected on tool messages). Per-provider translation:
OpenAI Chat Completions passes the URL through to `image_url:
{url}` (URL passthrough, OpenAI fetches server-side); OpenAI
Responses API passes through to `input_image: {image_url: url}`;
Bedrock + Anthropic THROW with explicit error message ("pre-
fetch the URL to base64 bytes and use an image block
instead") — both providers require base64 inline. Auto-
fetching deferred (operator code owns timeout / retry / cache /
SSRF policy). Payload size + latency win for OpenAI users: a
5 MB image URL is 100 bytes in the request vs ~6.7 MB inline
base64. Pattern set for future URL-only variants (audio_url,
video_url). All 6,713 pre-M2.X.5.y tests pass unchanged; 13
new tests verify URL validation, role rules, OpenAI Chat /
Responses pass-through, Bedrock + Anthropic throw semantics.
M2.8.6 threads `ImageContentBlock`
through the OpenAI Responses API path, closing ADR-0088 Q6.
Pre-M2.8.6 the Responses-API translator used `contentToText`
throughout — array content was flattened to text only, silently
dropping any image blocks. New `OpenAIResponsesContentImage
Input` type `{type: "input_image", image_url: string}` added
to the `OpenAIResponsesContentBlock` discriminated union
(grows from 2 to 3 variants: input_text, input_image,
output_text). New private `buildUserInputBlocks` helper walks
user content: string → single input_text; array content
walks each block (text → input_text, image → input_image
with `data:image/<format>;base64,<bytes>` URL matching
Chat Completions format; tool_use/tool_result skipped — they
flow via top-level function_call_output items or are kernel-
schema rejected on user role). Attachments field flows into
input_image blocks for M2.X backwards compat. Block order
preserved. Empty text blocks filtered. Empty result emits a
single empty input_text block (Responses API rejects empty
content arrays). All 19 pre-M2.8.6 Responses-API tests pass
unchanged; 7 new tests verify image-input threading,
backwards compat, attachment paths, 4 image formats, mixed
text/image ordering, empty filtering. OpenAI provider now has
full multimodal parity across both API paths. M2.X.8 ships standalone OpenAI
Moderations API support in `@crossengin/ai-providers-openai`,
closing ADR-0086 Q1. New `moderations-api.ts` module exports
`OPENAI_MODERATION_MODELS` (4 models: omni-moderation-latest as
default + 2024-09-26 dated + 2 legacy text-moderation models),
`OPENAI_MODERATION_CATEGORY_KEYS` (11 documented categories),
`buildModerationRequest` (input validation: rejects empty
string / empty array / array-with-empty-string at build time),
`normalizeModerationResponse` (folds raw response into
`{model, anyFlagged, results, flaggedCategoriesPerResult}` —
operator-facing summary plus raw results preserved),
`highestCategoryScore(result)` (returns top scoring category,
useful for soft-threshold policies). `OpenAIProvider.moderate
({input, model?})` POSTs to `/v1/moderations` with same
network / HTTP / parse error handling as other endpoints.
`OpenAIProviderOptions.defaultModerationModel?` validated at
construction; unsupported model throws synchronously. Input
accepts `string | readonly string[]` (batch up to 32 strings
per OpenAI's docs); per-call `model` override checked at call
time. Use cases: pre-screen user input before paying for a
chat call ($0.0001 moderation vs $0.005+ chat), bulk content
audits, soft-threshold risk scoring. Provider-specific method
(not on `LlmProvider` interface) because Anthropic + Bedrock
don't expose standalone moderation endpoints. M6.6 migrates `@crossengin/ai-router`
to use the kernel cross-provider helpers, validating M2.X.6.x
+ M2.X.7 with a real non-test consumer + closing a latent bug
exposed by M2.X.5. Three coordinated changes in retry.ts +
router.ts: (1) retry.ts's local `isRetryableError` becomes a
hybrid predicate — checks kernel's kind-based `isRetryableError`
first (the M2.X.7 path); falls back to the legacy `isRetryable()`
method-based duck-typing for compat with custom error classes.
(2) router.ts's `isRouterRetryable` gains an explicit
`isModerationError(err) → false` early-exit BEFORE delegating
to `isRetryableError`. Documents intent: moderation events
never trigger fallback to alternate providers (the input
itself triggered the policy violation; switching providers
won't help). Pre-M6.6 the correct behavior was accidental
(moderation errors return false from each provider's
`isRetryable()`); post-M6.6 it's explicit + tested. (3)
`estimateRequestTokens` bug fixed — was using
`m.content.length` which broke after M2.X.5 (returned block
count for array content, not char count); now uses
`contentToText(m.content).length` which handles both string +
LlmContentBlock[] shapes correctly. Three new router tests
verify: refusal from primary does NOT trigger fallback;
guardrail_intervened same; rate_limit_error DOES trigger
fallback. Six new retry tests verify the kernel-kind shape
works: errors with `.kind: "rate_limit_error" |
"network_error" | "model_stream_error"` are classified
retryable; moderation kinds + auth_error are not. All 51
existing router tests + 14 existing retry tests pass
unchanged. M2.X.7 adds a kernel-level
cross-provider retryability helper to `@crossengin/ai-providers`,
mirroring M2.X.6.x for the second cross-cutting error concern.
Closes ADR-0087 Q3. New `retryable.ts` module exports
`RETRYABLE_ERROR_KINDS` const tuple ([rate_limit_error,
overloaded_error, network_error, timeout_error, api_error,
model_stream_error] — the UNION of all three providers'
retryable sets; Bedrock-specific model_stream_error included so
kernel agrees with Bedrock's local classification),
`RetryableErrorKind` type, `RetryableDiscriminator` interface,
`isRetryableErrorKind(value)` string discriminator, and the
headline predicate `isRetryableError(err): err is Error &
{kind: RetryableErrorKind}`. Same duck-typing approach as
`isModerationError`: inspects `err.kind` against the shared
tuple. No changes to provider error classes; their existing
local `RETRYABLE_KINDS` sets + `isRetryable()` methods continue
to work. Cross-package integration tests in all three real
providers verify the kernel helper agrees with the provider's
local isRetryable() method for each shared kind; moderation +
auth kinds correctly return false. Symmetric API surface:
operators have parallel discriminators `isModerationError` +
`isRetryableError`, both narrow `.kind`, both work across
providers, neither requires provider-package imports. Pattern
set for future third cross-provider concern. M2.X.5.x adds `tool_use` +
`tool_result` content block variants to the kernel
`LlmContentBlock` discriminated union, consolidating the
tool-call surface. New types in `@crossengin/ai-providers/src/
types.ts`: `ToolUseContentBlock` (`{type: "tool_use", id, name,
input}`), `ToolResultContentBlock` (`{type: "tool_result",
toolUseId, content, status?: "success" | "error"}`), and the
`TOOL_RESULT_STATUSES` const tuple. LlmMessageSchema's
superRefine validates role-bound semantics: tool_use only on
assistant role, tool_result only on user or tool role, image
NOT allowed on tool messages (text-only by convention). All
three provider translators handle the new blocks: Bedrock
emits `{toolUse: {toolUseId, name, input}}` and `{toolResult:
{toolUseId, content: [{text}], status?}}`; Anthropic emits
`{type: "tool_use", id, name, input}` and `{type: "tool_result",
tool_use_id, content}`. OpenAI required a flatMap refactor —
`translateMessage` now returns `OpenAIChatMessage[]` because a
single kernel user message with tool_result blocks splits into
multiple OpenAI messages (tool-role per result + user-role with
remaining text). buildOpenAIChatRequest switched from `.map` to
`.flatMap`. Hybrid support: a single assistant LlmMessage can
mix the legacy `toolUses` field with inline `tool_use` content
blocks; OpenAI merges both into one `tool_calls` envelope array.
Bidirectional field compat: the legacy `LlmMessage.toolUses`
field + `role: "tool"` messages continue working unchanged;
operators can mix legacy + canonical patterns. Unblocks
parallel tool calls in a single assistant turn, bundled tool
results in a single user turn, and arbitrary text/tool
interleaving without losing order. M2.X.5 lifts the kernel
`LlmMessage.content` from `string` to a discriminated union
`string | LlmContentBlock[]`, closing the M2.X asymmetry where
user messages could carry images (via `attachments`) but
assistant messages could only emit text. New types in
`@crossengin/ai-providers/src/types.ts`: `TextContentBlock` +
`ImageContentBlock` (flat shape `{type, format, bytes}`
matching ImageAttachment for symmetry), `LlmContentBlock`
discriminated union, `LlmContent` union, and four helpers —
`isStringContent`, `isBlockContent`, `normalizeContent`
(string → `[{type: "text", text}]`), `contentToText` (extracts
text from blocks, joins, ignores images). LlmMessageSchema's
superRefine gains validation: array content + attachments
together is REJECTED (mutually exclusive); string content +
attachments still valid (M2.X backwards compat). Empty arrays
rejected via `.min(1)`. All three provider message-builders
gained a private `appendKernelBlocks(out, content)` helper
that branches on `typeof content` — Bedrock pushes
`{text}` / `{image: {format, source: {bytes}}}`, Anthropic
pushes `{type: "text", text}` / `{type: "image", source:
{type: "base64", media_type: "image/<format>", data}}`,
OpenAI pushes `{type: "text", text}` / `{type: "image_url",
image_url: {url: "data:image/<format>;base64,<bytes>"}}`.
Assistant messages with array content now emit provider-
native content arrays instead of strings — unblocks image-
generation responses and any future multimodal assistant
output. Backwards compat: 90+ existing string-content call
sites pass unchanged; verified by full pre-M2.X.5 test suite
running at 6,588. The OpenAI Responses API path uses
`contentToText` throughout (its top-level shape doesn't
support inline image parts the same way; image content is
silently dropped — future M2.8.6). Pattern set for future
content variants (audio / video / document) — append to the
discriminated union + update each provider's translator. M2.X.6.x adds a kernel-level
cross-provider moderation helper to `@crossengin/ai-providers`,
closing ADR-0084 Q7 + ADR-0086 Q3. New `moderation.ts` module
exports `MODERATION_ERROR_KINDS` const tuple ([
"guardrail_intervened", "content_filtered", "refusal"] — the
union of moderation-event kinds across Bedrock, OpenAI, and
Anthropic), `ModerationErrorKind` type, `ModerationDiscriminator`
interface, `isModerationErrorKind(value)` string discriminator,
and the headline predicate
`isModerationError(err): err is Error & {kind: ModerationErrorKind}`.
Duck-typing approach: inspects `err.kind` against the shared
tuple; works against any error class whose `.kind` matches the
moderation slice. No changes to provider error classes —
`BedrockGuardrailViolationError`, `OpenAIContentFilteredError`,
`AnthropicRefusalError` are byte-identical to M2.9.8 / M2.X.6;
they already set `.kind` to the right string values. Type
narrowing: inside the predicate's true branch, `err.kind`
narrows to `ModerationErrorKind` — verified by a TS assignment
test. Robust against non-Error inputs (null / undefined /
primitives / objects without `kind` / objects with non-string
`kind`). Cross-package integration tests in all three real
providers verify their error classes flow through the kernel
helper. Operators using the router catch one error shape
instead of three:
  if (isModerationError(err)) auditViolation(err.kind);
Pattern set for future kernel-level cross-provider helpers
(retryability, token-limit detection). Forward-compatible: a
fourth provider's novel moderation kind just gets appended to
the tuple. M2.X.6 ships parallel moderation
surfaces in `@crossengin/ai-providers-openai` and
`@crossengin/ai-providers-anthropic`, matching M2.9.8's pattern.
New `moderation.ts` module in each package exports a typed
error class (`OpenAIContentFilteredError extends OpenAIError`,
`AnthropicRefusalError extends AnthropicError`) plus
discriminator helpers (`isContentFilterFinishReason` /
`isContentFilteredResponse`, `isRefusalStopReason` /
`isRefusalResponse`) and the relevant stop-reason constants
(`OPENAI_CONTENT_FILTER_FINISH_REASON = "content_filter"`,
`ANTHROPIC_REFUSAL_STOP_REASON = "refusal"`). Both providers'
`_ERROR_KINDS` grow by one (`content_filtered` /  `refusal`);
neither is in `RETRYABLE_KINDS`. Schema extension: Anthropic's
`AnthropicResponse.stop_reason` union now includes `"refusal"`
(OpenAI's `finish_reason` already had `"content_filter"`).
Streaming detection: both `chunksFromSse` / `readSseStream`
generators track a contentFiltered / refused flag in stream
state; at the appropriate event (`finish_reason: "content_
filter"` for OpenAI, `message_delta.delta.stop_reason: "refusal"`
for Anthropic), set the flag without throwing; after yielding
`usage_final` normally, throw the typed error. Same
post-usage_final-throw ordering as M2.9.8 — cost accounting
flows even on moderation. Non-streaming asymmetry preserved:
`completeNonStreaming` returns the raw response; callers use
the discriminator helpers to detect. Cross-provider error
landscape: all three real providers now throw non-retryable
typed errors on moderation events. The shared `content_filtered`
kind name between Bedrock + OpenAI is intentional — operators
classifying logs by `error.kind` get matching coverage.
ADR-0084 Q7 (cross-provider abstraction) now has three concrete
data points to reason about; revisit in future M2.X.6.x if
patterns stabilize. Zero kernel changes: `CompletionRequest`,
`CompletionChunk`, `LlmProvider` interface — all untouched.
M2.9.8.x adds two new public methods
to BedrockProvider for per-request guardrail override:
`completeWithGuardrail(req, guardrailOverride?)` (streaming) +
`completeNonStreamingWithGuardrail(req, guardrailOverride?)`
(non-streaming). Three-state override semantics:
`BedrockGuardrailConfig` → use this config (validated at call
time via buildBedrockGuardrailConfig); `null` → explicitly
DISABLE the provider's default guardrail for this request;
`undefined` (or omitted) → fall back to provider default.
Closes ADR-0084 Q3. Internal refactor: `complete()` and
`completeNonStreaming()` now delegate to private
`completeInternal` / `completeNonStreamingInternal` taking the
effective resolved guardrail explicitly; the duplicated
`guardrailConfig` spread sites are unified. Validation timing
preserved: bad override identifier/version/trace throws BEFORE
the fetch (rejected promise for non-streaming). The kernel
`LlmProvider.complete(req)` interface is untouched — operators
wanting per-request overrides use the Bedrock-specific
sibling methods directly, bypassing the router. Operationally
unblocks: per-tenant guardrail tiers (Bronze/Gold compliance
packs), A/B testing content policies, admin escape hatches
(`null` override skips filtering for security-ops inspection),
mixed-sensitivity workloads (trial users get stricter PII
redaction than enterprise customers). M2.9.8 wires AWS Bedrock Guardrails
into `@crossengin/ai-providers-bedrock` as an opt-in safety
surface. New `guardrails.ts` module exports
`BedrockGuardrailConfig` ({guardrailIdentifier, guardrailVersion,
trace?: "enabled"|"disabled"}), `buildBedrockGuardrailConfig`
(slug-regex validator: identifier `^[a-z0-9]{6,16}$`, version
`^(DRAFT|[1-9][0-9]{0,4})$`), `BedrockGuardrailViolationError
extends BedrockError` (carries `stopReason` ∈
{guardrail_intervened, content_filtered} + optional `trace`),
plus discriminators `isBedrockGuardrailInterventionStopReason`
+ `isGuardrailInterventionResponse`. `BEDROCK_ERROR_KINDS`
grows by two — both non-retryable. `BedrockConverseRequest`
gains optional `guardrailConfig` field; `buildBedrockConverse
Request` threads it from `BuildConverseRequestOptions`; OMITTED
from request body when undefined (byte-identical to pre-M2.9.8
for unguarded providers). `BedrockProviderOptions.guardrailConfig?`
validates at construction time (fast-fail on bad config); stored
on the instance; passed to both `complete()` (streaming) and
`completeNonStreaming()`. The event-stream parser now tracks a
`ConverseStreamState` ({toolBlocks, pendingIntervention,
guardrailTrace}) instead of just a Map. At `messageStop` with an
intervention `stopReason`, the parser SETS the pending flag but
does NOT throw — `metadata` event still fires + yields
`usage_final` for cost accounting; the parser also pulls
`trace.guardrail` if present. AFTER the stream loop ends with
pendingIntervention set, throws `BedrockGuardrailViolationError`
{stopReason, trace}. Consumer ordering: text/tool chunks →
usage_final → throw. Non-streaming asymmetry: returns the raw
`BedrockConverseResponse` with `stopReason` already typed to
include the intervention values; callers inspect via
`isGuardrailInterventionResponse(response)` rather than catching
an error. `BedrockGuardrailViolationError extends BedrockError`
so `instanceof BedrockError` keeps working; the `kind` field
discriminates. Router automatically treats guardrail violations
as terminal (no retry burn). M4.10.x adds a `--by-source-pack`
flag to `gateway routes unregister-pack`, exposing M4.10's
`deleteByPackSlug` API at the CLI. When set, the entire
manifest pipeline (resolvePack → resolveManifest →
tryValidateManifest → generatePackRoutes) is skipped; the
handler issues a single `DELETE WHERE source_pack = $1`
(or `listByPackSlug` + table render under --dry-run).
Operationally unblocks three real scenarios: decommissioned
packs (slug no longer in the registry → resolvePack would
throw UnknownPackError), broken manifests (resolveManifest
fails on ExtendsCycle / UnknownParent), and forgotten old
versions (manifest changed; M4.8.x's default path would only
delete the CURRENT generation, leaving old routes orphaned).
Slug validation is enforced at the CLI boundary via the same
regex as the DB CHECK + zod schema (`^[a-z][a-z0-9-]*
(\/[a-z][a-z0-9-]*)*$`); invalid slug → exit 2. Dispatcher
short-circuit updated: `--by-source-pack` always needs PG (the
--dry-run path reads via listByPackSlug), so the
register-pack/unregister-pack PG-free short-circuit excludes
`unregister-pack --by-source-pack`. Output shapes: human
"deleted N route(s) where source_pack = 'X'" (live) or
"-- dry-run: N route(s) would be deleted (by source_pack =
'X')" (preview); JSON {pack, bySourcePack: true, deleted,
dryRun} (live) or {pack, bySourcePack: true, count, dryRun:
true, routes[{id, method, operationId}]} (preview). The
`bySourcePack: true` field is the schema discriminator for
consumers parsing M4.8.x vs M4.10.x output. Existing M4.8.x
default path unchanged — verified by test: `unregister-pack
<slug>` without the flag still issues N per-id DELETEs from
the manifest-derived ID set. M4.10 adds a `source_pack TEXT`
column (nullable + indexed + slug-pattern CHECK) to
META_GATEWAY_ROUTES, closing the three open questions across
ADR-0079/0080/0081 about which pack owns which route. The
column is set by `generatePackRoutes` to the pack slug on
every CRUD + transition route; routes registered via
`gateway routes register <route.json>` default to NULL.
`RouteDefinitionSchema` gains `sourcePack: z.string().regex
(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/).max(120).nullable
().default(null)`. `PostgresRouteRegistry` upsert grows to
16 INSERT params + ON CONFLICT writes `source_pack =
EXCLUDED.source_pack`; new methods `listByPackSlug(slug)` +
`deleteByPackSlug(slug): Promise<number>` add bulk
source-attribution queries; all three SELECT call sites
(`listAll`, `loadCompiled`, `listByPackSlug`) factor through
a shared `SELECT_COLUMNS` constant. `runRoutesSyncPack`
classification expands from three buckets to four: `added`
(generated − stored), `persistent` (generated ∩ stored),
`obsolete` (stored with sourcePack === slug, not in current
generation — SAFE to prune), `external` (stored with
sourcePack !== slug or NULL — NEVER pruned). New flag
`--prune-obsolete` opt-in deletes obsolete routes; safely
no-ops on legacy NULL-attributed routes. JSON shape gains
{obsolete, obsoleteIds[], pruned, pruneObsolete} alongside
the existing {added, persistent, external, externalIds[]}.
Human output names the obsolete bucket separately with
"use --prune-obsolete to delete" hint. Backwards compatible:
pre-M4.10 routes survive with NULL source_pack (no
auto-classification); operators backfill by re-running
register-pack which now writes the slug via ON CONFLICT.
Eleven RouteDefinition construction sites across 9 files
updated to include `sourcePack: null` — TS strict catches
any missed site at compile time. M4.8.y completes the three-verb
gateway-routes pack vocabulary: `crossengin gateway routes
sync-pack <slug> [--api-version v1] [--dry-run] [--created-by
<uuid>]`. Re-generates the desired route set, calls
`registry.listAll()` for the stored set, classifies route IDs
into three buckets: `added` (generated but not stored —
will be upserted), `persistent` (in both — will be refreshed
via upsert), `external` (in stored but not generated — left
alone, reported). Upserts all generated routes (both buckets);
NEVER deletes external routes — without a `source_pack`
column or previous-manifest snapshot we cannot reliably
classify them as "obsolete from this pack" vs "from a
different pack" vs "operator-curated." sync-pack ALWAYS needs
PG (even --dry-run reads the stored set for the diff) —
documented departure from M4.8 / M4.8.x where --dry-run was
PG-free. Output shapes: human "synced N route(s) for pack 'X'
(A added, B refreshed[, C external — left alone])" with
optional external-IDs list, JSON {pack, dryRun, total, added,
persistent, external, externalIds[]}; dry-run human prints
three sections (added / refreshed / external) with rt_<hex> +
method + path + operationId per row. Idempotent by design:
second invocation on unchanged manifest reports (0 added, N
refreshed, 0 external) and writes N upserts. CI-grade: one
command per deploy step that's safe to re-run. M4.8.x ships the companion to M4.8:
`crossengin gateway routes unregister-pack <slug> [--api-
version v1] [--dry-run]`. Same generation pipeline as
register-pack (resolvePack → resolveManifest →
generatePackRoutes) but instead of `registry.upsert` per
route, it calls `registry.deleteByRouteId(r.route.id)` —
re-deriving the deterministic hash IDs guarantees we look up
exactly the rows register-pack would have created. Soft-fail
semantics: missing routes report as `notFound` rather than
erroring (re-running idempotently surfaces "unregistered 0 of
N (N not found — already removed)"). Skips
tryValidateManifest — operators tearing down a pack don't need
post-resolve validation. Dispatcher short-circuit extended to
cover `unregister-pack --dry-run` so operators preview without
PG. Output shapes: human "unregistered N of M route(s) for
pack 'X'" (optional partial-miss suffix), JSON {pack,
attempted, deleted, notFound, notFoundIds[]}; dry-run human
prints rt_<hex> + method + path + operationId, dry-run JSON
emits {pack, count, dryRun, routes[{id, method, operationId}]}.
End-to-end verified: `crossengin gateway routes
unregister-pack operate-erp/payments --dry-run` emits the
34-row route-ID list without touching PG. M4.8 closed M4.7's manifest-driven
route-registration open question. New
`apps/architect-cli/src/gateway-pack-routes.ts` exports a pure
`generatePackRoutes({manifest, packSlug, apiVersion?})`
function that derives `RouteDefinition[]` from the resolved
manifest: 5 standard CRUD routes per entity
(list/read/create/update/delete with appropriate HTTP method +
idempotency + scope) plus one route per `entityLifecycle`
workflow transition (`POST /v1/<plural>/:id/transitions/<name>`).
Pluralizer kebabifies CamelCase + adds `s` (or `ies` for
consonant+y endings); `entityKey` produces snake_case for
operationIds + scopes. `routeIdFor({packSlug, operationId})`
emits `rt_<sha256(...).slice(0,16)>` — deterministic, regex-
safe, collision-free within a pack. New CLI action:
`crossengin gateway routes register-pack <slug>
[--api-version v1] [--dry-run] [--created-by <uuid>]` resolves
the pack via the M7.6.5 packManifestRegistry, validates
post-resolve via tryValidateManifest, generates the route
list, and either upserts every row via `PostgresRouteRegistry
.upsert` (registered N route(s) for pack '<slug>') or prints
the route table without writing (`--dry-run`). The dispatcher
short-circuits the `--dry-run` path before resolving the
registry so operators can preview routes without a running
database. Three packs immediately bulk-deployable:
core → 24 routes (4 entities × 5 CRUD + 4 invoice transitions);
payments resolved → 34 (+1 entity, +5 payment transitions);
healthcare resolved → 47 (+2 entities, +5 encounter, +3
observation transitions). End-to-end verified:
`crossengin gateway routes register-pack operate-erp/
healthcare --dry-run` emits the 47-row route table without
touching PG. M2.X closed M2.9.7 Q1 by extending the kernel
`LlmMessage` schema with `attachments?: MessageAttachment[]`
and threading vision content blocks through all three real
providers. New types in `@crossengin/ai-providers/src/types.ts`:
`IMAGE_ATTACHMENT_FORMATS = [png, jpeg, gif, webp]`,
`ImageAttachmentSchema`, `MessageAttachmentSchema`
(discriminated union on `kind`; only `"image"` today, but
audio/video/document slot in cleanly), `imageMediaType(format)`
helper. `LlmMessageSchema.superRefine` rejects attachments on
non-user roles at parse time. `ProviderCapabilitiesSchema`
gains `vision: z.boolean().default(false)`. All three real
providers flip `vision: true`; mock provider keeps false.
Provider translators wired:
`@crossengin/ai-providers-anthropic/messages-api.ts` user
branch emits `content: [{type: text}, {type: image, source:
{type: base64, media_type: image/<format>, data}}]` when
attachments present, falls back to string content otherwise;
`AnthropicContentBlock` discriminated union grows the image
variant. `@crossengin/ai-providers-openai/chat-api.ts`
`OpenAIChatMessage.content` widens to `string | null |
OpenAIContentPart[]`; user branch emits
`[{type: text}, {type: image_url, image_url: {url:
data:image/<format>;base64,<bytes>}}]`;
`extractTextFromResponse` joins text parts + ignores image_url
parts on content-part responses (forward-compat for vision
model outputs). `@crossengin/ai-providers-bedrock/converse-
api.ts` user branch appends `BedrockImageContentBlock` entries
(the type already existed from M2.9.7) — kernel-side
attachments now flow into the Bedrock builder's content array.
Router's `unionCapabilities` ORs `vision` across configured
providers so the chat substrate sees the union flag. Backward
compat: messages without attachments produce byte-identical
provider requests; existing 6,396 tests unchanged. M2.9.7 closed M2.9.5 Q6 by shipping Bedrock multimodal
embeddings (`amazon.titan-embed-image-v1`) + chat image content
block types. Two new surfaces in `@crossengin/ai-providers-
bedrock`, all additive, zero kernel changes. First — new
provider-native method `embedMultimodal({model?, text?, image
Base64?, dimensions?})` POSTs to `/model/amazon.titan-embed-
image-v1/invoke` with sig-v4. Takes EITHER text OR image OR
both; returns `{vector, dim, model, usage: {inputTextTokens,
imageCount, cost}}`. Dual billing: $0.80/M text tokens + flat
$0.00006 per image (combined inputs sum both tracks). 256/384/
1024-dim output (default 1024). New types in pricing.ts:
`BEDROCK_MULTIMODAL_EMBEDDING_MODELS`,
`BedrockMultimodalEmbeddingPricing`,
`computeBedrockMultimodalEmbeddingCost`,
`buildBedrockMultimodalEmbeddingUsage`,
`isBedrockMultimodalEmbeddingModel`. `BedrockModel` union
expands to three families (chat / embedding / multimodal
embedding); `isBedrockModel` accepts all three. `embed()` (the
kernel-facing method) now rejects `model: "amazon.titan-embed-
image-v1"` with a redirect error pointing to `embedMultimodal`
— catches the typo case that would silently pick the wrong
billing track. Second — Bedrock chat `BedrockImageContentBlock`
type added to the discriminated union (`{image: {format,
source: {bytes}}}`); `BEDROCK_IMAGE_FORMATS = [png, jpeg, gif,
webp]`; `buildBedrockImageBlock({format, imageBase64})` factory;
`isBedrockImageFormat` discriminator. `extractTextFromConverse
Response` + `extractToolCallsFromConverseResponse` skip image
blocks via the existing `"text" in block` / `"toolUse" in
block` discriminators (regression-tested). No
`buildBedrockConverseRequest` wiring yet — the kernel
`LlmMessage.content: string` is text-only; the types are ready
for a future M2.X kernel extension that adds structured
content. M2.9.6 closed M2.9 Q3 + M2.9.5 Q4 with two additive opt-in
features for the Bedrock provider. First — kernel-level
`CompletionRequest.cacheControl` now threads into Bedrock
`cachePoint` content blocks: `systemPrompt` and/or `toolSchemas`
appends a cachePoint to the end of the `system` array;
`conversationHistory` appends one to the penultimate message's
content (no-op when `messages.length < 2`); `retrievedContext`
appends one to the last message's content. Three independent
placements; operators set any combination. Anthropic-on-Bedrock
+ Claude 3.5/3.7/Opus 4 get the documented 90%-off cached-
input rate at $0.30/$1.50/$0.30 per million via the existing
`BEDROCK_CHAT_PRICING[model].cachedInputUsdPerMillion` path —
no extra cost-accounting work. New types:
`BedrockCachePointBlock`, `BEDROCK_CACHE_POINT` constant,
`isCachePointBlock` discriminator. `extractTextFromConverse
Response` + `extractToolCallsFromConverseResponse` already
discriminate via `"text" in block` / `"toolUse" in block`,
so cachePoint blocks fall through silently (regression-tested).
Second — `titanConcurrency` constructor option (default 4,
range [1, 100]) parallelizes the Titan single-text-only loop
in `embedViaTitan`. Refactored from sequential `for (const
text of texts)` to chunked Promise.all (chunks of `titan
Concurrency` size), preserving input order via pre-allocated
result array indexed by request position regardless of
completion order. Cohere unchanged — its native batching
(96 texts per call) already covers parallelism for that
family. M4.7.6 closed
M4.7.5's two follow-up questions: cloud-IdP-friendly JWKS URL
fetching + hot-reload. `apps/architect-cli/src/gateway-jwks.ts`
gained `loadJwksFromUrl(url, opts?)` (injectable FetchLike,
10s default timeout, AbortSignal-translated to typed
JwksLoadError on timeout), `normalizeJwksEntry` accepts BOTH
CrossEngin-native `{kid, publicKeyBase64}` AND RFC 7517 OKP/
Ed25519 `{kid, kty: "OKP", crv: "Ed25519", alg?: "EdDSA",
x: <base64url>}` entries (RSA / EC / oct rejected at parse
time with a clear EdDSA-only message), and a `Refreshable
JwksProvider` class wrapping an initial provider + a loader
function; `refresh()` atomically swaps the inner pointer on
success, keeps old keys on loader failure, and exposes
`startPeriodicRefresh({intervalMs, onResult})` /
`stopPeriodicRefresh()` (timer `.unref()`'d so it doesn't
keep the event loop alive). `runGatewayStart` integrated:
new flags `--jwks-url <url>` (mutually exclusive with
`--jwks-file`) and `--jwks-refresh-seconds <n>` (range [0,
86400]; defaults to 300 in URL mode, 0 in file mode where
SIGHUP is the reload path). After server boot the runtime
installs a SIGHUP handler + a periodic-refresh interval if
configured; both emit structured `{kind: "jwks_refresh",
source, ok, error?}` events (NDJSON in JSON format mode,
human prints otherwise). Initial JWKS load is hard-fail (exit
2 with typed JwksLoadError); subsequent refreshes are soft-
fail (old keys retained on loader error). `GatewayContext`
gained two test seams — `jwksFetch?: FetchLike` and
`registerReloadHandler?` — so the URL + SIGHUP paths are
exhaustively tested without real network/signals. End-to-end
verified: `crossengin gateway start --jwks-url http://...
--jwks-refresh-seconds 1` boots; SIGHUP triggers a
`jwks_refresh` event; periodic refresh fires every second.
RSA/oct JWKS endpoints, fs.watch hot-reload, lazy-on-miss
refresh, cached-on-disk JWKS responses, and per-tenant JWKS
isolation deferred to M4.7.7+. M4.7.5 closed M4.7's
two biggest open questions: JWT auth + routes management. New
`apps/architect-cli/src/gateway-jwks.ts` loads JWKS keys from a
JSON file shaped `{keys: [{kid, publicKeyBase64}, ...]}` and
returns an `InMemoryJwksProvider`; `resolveJwtFlags` is the
flag-glue layer that validates the all-or-nothing constraint
(`--jwks-file` requires both `--jwt-issuer` + `--jwt-audience`;
JWT options without `--jwks-file` are rejected with exit 2).
`runGatewayStart` resolves JWT flags BEFORE building the
runtime and spreads them via `jwtRuntimeOptions(jwt)` into the
`GatewayRuntime` constructor (both in-memory and Postgres
modes). New `gateway-routes.ts` adds `crossengin gateway routes
<list|register|unregister>` mirroring the M5.9 sessions
subcommand pattern — list renders a 7-column table (route_id /
method / path / version / operation / scopes / deprecated) or
JSON; register reads a JSON file, validates via
`RouteDefinitionSchema.parse()`, calls `registry.upsert`;
unregister deletes by route id with proper exit-code semantics.
`PostgresRouteRegistry` gained two additive methods —
`listAll()` returning RouteDefinition[] sorted by api_version /
method / route_id, and `deleteByRouteId(routeId)` returning
boolean + invalidating the cache. End-to-end verified:
`crossengin gateway start --jwks-file /tmp/jwks.json --jwt-
issuer X --jwt-audience Y` boots with JWT auth wired; anonymous
GET /__ping returns 200 (empty scopes); malformed Bearer
returns 401 + RFC 9457 problem detail with WWW-Authenticate
challenge. Documented constraint: the CrossEngin JWT verifier
accepts EdDSA only with base64-encoded public keys — different
from RSA JWKS most IdPs emit. URL-fetched JWKS, hot-reload, RSA
support, and bulk route management deferred to M4.7.6+. M6.5.6 wired the M2.9 / M2.9.5 Bedrock
provider into `architect-cli`'s `chat` subcommand by extending
`router-setup.ts` env-var detection. `AWS_ACCESS_KEY_ID` +
`AWS_SECRET_ACCESS_KEY` (required pair) plus optional
`AWS_SESSION_TOKEN` (STS) + `AWS_REGION` / `AWS_DEFAULT_REGION`
(default us-east-1) trigger BedrockProvider construction.
`DEFAULT_TASK_POLICIES` extended so every task fallback chain
ends with a Bedrock entry — planner adds `bedrock/anthropic.
claude-opus-4-20250514-v1:0`, executor adds Sonnet-on-Bedrock,
summarizer/diff-narrator/rerank/classifier add Haiku-on-
Bedrock, and the previously-empty embedding fallback gains
`bedrock/amazon.titan-embed-text-v2:0` at the same $0.02/M as
OpenAI's text-embedding-3-small. The `filterPoliciesByAvailable`
filter strips Bedrock entries when AWS env is unset — tenants
running with one or two providers see the same single/two-way
router behavior as before. New `resolveBedrockDefault(forceModel)`
helper mirrors the Anthropic + OpenAI ones. Three-key envs
return a 3-provider router with `availableProviders: ["anthropic",
"openai", "bedrock"]` for real failover diversity across
independent control planes. Help text + NoProvidersConfiguredError
message now mention all three credential paths. M2.9.5 closed M2.9's open Q4 by
implementing `embed()` for the Bedrock provider. New
`embeddings.ts` module dispatches on model family — Amazon Titan
(`amazon.titan-embed-text-v2:0` at $0.02/M with selectable 256 /
512 / 1024 dimensions, `amazon.titan-embed-text-v1` at $0.10/M)
uses a single-text-only `InvokeModel` request shape and the
provider loops over `texts: string[]`; Cohere (`cohere.
embed-english-v3` / `cohere.embed-multilingual-v3` at $0.10/M)
uses a batched `{texts, input_type}` request and the provider
makes one call per batch (max 96 per AWS). Token counts come
from Titan's `inputTextTokenCount` or Cohere's `meta.
billed_units.input_tokens` when reported; falls back to
ceil(chars/4) approximation otherwise. `BedrockProvider`
capabilities flip `embedding: false → true`; `models` expands
from 8 to 12 (4 new embedding models); constructor gains
`defaultEmbeddingModel` (default titan-embed-text-v2:0),
`defaultEmbeddingDimensions` (Titan v2 only — 256/512/1024),
`defaultCohereInputType` (search_document/_query/classification/
clustering). Same sig v4 path as chat; both endpoints hit
`POST /model/{modelId}/invoke`. Cost rounds to 6 decimals;
output_tokens always 0 for embeddings. Router (M6.5) now has a
second embedding-capable provider — operators serving non-
English markets can route `task: "embedding"` to
`cohere.embed-multilingual-v3` for 100+ language coverage while
keeping OpenAI's `text-embedding-3-small` as fallback. AWS-
native end-to-end story closed: a tenant with strict residency
requirements can now serve both chat completion AND vector
search entirely inside their AWS account in their region. M2.9 shipped the third real `LlmProvider` —
`@crossengin/ai-providers-bedrock`. AWS Bedrock converse-stream
client implementing the same contract as M2.7 (Anthropic) +
M2.8 (OpenAI). Zero runtime deps — pure `fetch` + `node:crypto`
with from-scratch AWS Signature V4 (verified against the
AWS-documented `f4780e2d...` reference signing key). 6 modules:
pricing (8 chat models — Claude on Bedrock matches first-party
pricing including 90%-off cached input + Llama 3.1 70B/405B +
Mistral Large 2407 + Titan Text Premier; per-million rates +
6-decimal cost rounding), signing (AWS sig v4 with HMAC chain
kSecret → kDate → kRegion → kService → aws4_request,
URI-encoded canonical request, signed headers always include
host + x-amz-date + x-amz-content-sha256), converse-api
(CompletionRequest → BedrockConverseRequest: system messages
lifted to top-level system array, assistant.toolUses translated
to content blocks with toolUseId, tool-role messages folded
back as user messages with toolResult blocks per Bedrock's
quirk), event-stream (AWS event-stream BINARY frame parser —
4-byte BE length prelude + headers + JSON payload + CRC, NOT
SSE; parses headers byte-by-byte, dispatches on
`:event-type` to map messageStart / contentBlockStart /
contentBlockDelta / contentBlockStop / messageStop / metadata →
CompletionChunk; tracks contentBlockIndex → toolUseId across
deltas; throws BedrockError on `:message-type: exception`),
errors (12 typed kinds including `model_stream_error` for
ModelStreamErrorException; CODE_TO_KIND maps 15 AWS exception
classes — ThrottlingException, ValidationException,
ServiceUnavailableException, ExpiredTokenException etc. — to
kernel-level kinds; same isRetryable shape as M2.7 / M2.8),
provider (BedrockProvider class with complete() +
completeNonStreaming() + embed() rejects with typed error
directing to OpenAI; constructor accepts accessKeyId +
secretAccessKey + optional sessionToken + region + clock
injectable for sig v4 testing). Residency derived from region
prefix (us-* → ["us"], eu-* → ["eu"], ap-*/me-* → ["ap"], sa-*
→ ["sa"]). Capabilities: `{chat: true, streaming: true,
toolUse: true, jsonMode: false, embedding: false,
maxContextTokens: 200_000}`. Router (M6.5) now has three real
providers to chain — failover diversity across three
independent control planes (Anthropic + OpenAI + AWS). Titan
embeddings + JWKS-style OIDC role assumption + automatic env
detection in CLI deferred to M2.9.5 / M6.5.6. M7.9 shipped the third vertical pack — `@crossengin/pack-erp-
healthcare`. Three FHIR-shaped entities (Patient with auditable +
tenant_owned + 12 user fields including mrn unique-per-account,
sex_assigned_at_birth, blood_type, allergies, preferred_language,
emergency contact; Encounter referencing Patient with FHIR
EncounterClass enum + 6-state lifecycle scheduled → checked_in →
in_progress → completed | cancelled | no_show; Observation
referencing both Encounter and Patient with code_system enum
matching LOINC/SNOMED/ICD-10 + value_quantity decimal(18,6) +
FHIR R4 ObservationStatus). Three relations: Account → Patient,
Patient → Encounter restrict, Encounter → Observation cascade.
Two new role contributions: erp_clinician + erp_front_desk merge
with core's three. Two lifecycle workflows: encounter_lifecycle
(5 transitions + 2 SLAs; only mark_no_show is automatic for the
sweep job) and observation_lifecycle (4 states matching FHIR R4
exactly; mark_in_error is admin-only for amendment discipline).
Three jobs: daily encounter-reminder, 15-min no-show-sweep,
event-triggered FHIR R4 export on `healthcare.encounter.
completed`. compliancePacks defaults to ["hipaa", "21_cfr_11"].
Registered in architect-cli's pack registry; `crossengin apply
--pack=operate-erp/healthcare` emits 65 pack statements
covering all 7 entities (4 core + 3 healthcare) with M7.7
tenant scoping intact, exercises the M7.6.5 resolver with a
second downstream consumer. M4.7 closed
the substrate-to-binary loop for the gateway pillar.
`crossengin gateway start [--port N] [--host A] [--in-memory]`
boots the M4 `GatewayRuntime` against a Node `http.createServer`
and the M4.5 Postgres-backed stores (idempotency / route registry
/ rate limit / pipeline executions). Built-in routes `GET /__ping`
+ `GET /__health` register at startup with `requiredScopes: []`
and `idempotencyRequired: false` so the server is responsive even
with an empty route registry; both flow through the full 17-stage
pipeline. New modules: `apps/architect-cli/src/gateway.ts` (CLI
entry + runtime construction), `gateway-server.ts` (Node HTTP
adapter — `buildIncomingFromNode`, `writeOutgoing`, `readBody`
with 1 MB cap, `generateRequestId` returning `req_<24-hex>`), and
`gateway-handlers.ts` (`platform.ping` + `platform.health`
handlers). `--in-memory` swaps PG adapters for in-memory
equivalents; default mode reads `PGHOST/PGDATABASE/...` env vars
and persists pipeline executions to `meta.gateway_pipeline_
executions`. `PostgresRouteRegistry.ensureLoaded()` runs as a
per-request `beforeHandle` so the route cache stays warm. SIGINT
/ SIGTERM trigger graceful shutdown — server closes, PG connection
closes, exit 0. End-to-end verified: `curl http://127.0.0.1:14250
/__ping` returns 200 + `{status:"ok",at:<ISO>}`; `/__health`
reports `uptimeSeconds` since boot; `/nope` returns 404 via the
gateway's `match_route` stage. JSON format mode emits NDJSON-
style records (`{kind:"started",...}` on boot, one
`{kind:"request",...}` per request). JWT mode + manifest-driven
route registration deferred to M4.7.5 + M4.8. M7.6.5 wired the kernel's
existing `resolveManifest` (from `packages/kernel/src/manifest/
extends.ts`) into the CLI's apply pipeline. `buildErpPaymentsPack
()` refactored to return a child-only manifest (1 entity, 1
relation, etc.) with `meta.extends: ["operate-erp/core"]`; the
inline merge with `buildErpCorePack()` is gone. `apps/
architect-cli/src/pack-registry.ts` gained `packManifestRegistry
()` factory wrapping `PACK_REGISTRY` as a `ManifestRegistry`
implementation; `apps/architect-cli/src/apply.ts`'s `buildPlan`
became async, calling `resolveManifest(rawManifest, {registry:
packManifestRegistry()})` before `tryValidateManifest`. Added
typed error handling for `ExtendsCycleError` ("pack extends-chain
cycle") and `UnknownParentManifestError` ("pack references
unknown parent: <slug>. Available: <list>"). Pack-erp-payments
tests refactored: identity tests (slug, version, extends, child
counts) use `buildErpPaymentsPack()` directly; composition tests
(5 entities merged, cross-pack FK resolves) use a new
`buildResolvedPayments()` helper. End-to-end verified: `crossengin
apply --dry-run --pack=operate-erp/payments` still emits all 5
entity tables with M7.7 tenant scoping intact — the resolver
merges, the emitter sees one unified manifest. M5.9 added three CLI
subcommands for the chat audit data: `crossengin sessions
list` renders a table of recent sessions for a tenant;
`crossengin sessions show <id>` dumps one session's full
transcript (header + messages + tool invocations + proposals)
with truncation for terminal viewing; `crossengin sessions
replay <id>` renders the messages as chat-style output
(`You:` / `Architect:` / `[tool result ← tu_1]`) matching the
live REPL's look. New `apps/architect-cli/src/sessions.ts`
dispatches on positional action; `getBySessionId({tenantId,
sessionId})` added to `PostgresArchitectSessionStore` so the
CLI looks up by the user-visible session_id string (UUID lookup
also supported via regex check). Tests inject store overrides
via the new `SessionsContext.storesOverride` so the offline
CI path mirrors the chat side's `transcriptOverride`.
M7.8 wired pack-erp-payments to
M6's `workflow-signal-bridge`. New `signal-bridge.ts` module
exports `PAYMENT_SIGNAL_NAMES` (5 lifecycle signals matching
the payment_lifecycle workflow's transitions),
`PROVIDER_EVENT_SIGNAL_MAP` (Stripe + Adyen + Braintree event
types → canonical signal names), `paymentReferenceExtractor()`
backed by a new `FirstMatchingPathExtractor` that tries
multiple dotted paths (Stripe's `data.object.id`, Adyen's
`pspReference`, Braintree's `transaction.id`, generic
`provider_reference`), `buildPaymentSignalBridge(opts)`
factory, and `buildPaymentBridgesByEvent(opts)` that returns
a map of one bridge per provider event type. End-to-end test
proves: real HMAC-signed Stripe-shaped webhook → bridge
verifies → extractor finds `pi_xxx` → submitSignal called
with `payment.captured` + correct correlation key + idempotency
key. The pack's `erp-payments-provider-webhook` job declaration
now has matching code-side wiring.
M7.5 shipped the second vertical pack —
`@crossengin/pack-erp-payments` — proving the cross-pack
composition story. The pack adds 1 entity (Payment with both
`auditable` + `tenant_owned` traits; 13 user-fields including
provider enum, provider_reference unique-within-provider,
amount + refund_amount decimal(14,2), 6-state lifecycle),
1 relation (Invoice → Payment one-to-many RESTRICT), 5
permission transitions (admin-only refund + delete; everyone
else for capture/settle/fail/cancel), the `payment_lifecycle`
workflow (pending → captured → settled active; refunded /
failed / cancelled terminal; refund reachable from captured +
settled; 2 SLAs), 2 jobs (event-triggered payment-provider
webhook handler + hourly settlement sweep backstop), 1 list
view. `buildErpPaymentsPack()` calls `buildErpCorePack()` and
merges its additions — the resulting manifest declares
`extends: ["operate-erp/core"]` for documentation but applies
as one unified manifest (5 entities, 4 relations, 5 permission
sets, 2 workflows, 4 jobs, 3 views). `tryValidateManifest`
passes; cross-pack Payment.invoice_id → Invoice reference
resolves internally via merge. Pack-erp-payments registered in
the architect-cli pack-registry; `crossengin apply
--pack=operate-erp/payments` produces deployment-grade SQL
covering both core and payment tables.
M7.7 fixed the biggest open question from M7-wire:
pack tables now isolate per tenant at the DB level. The kernel's
`tenant_owned` built-in trait gained a `tenant_id UUID NOT NULL`
(indexed) field; `emitEntity` now emits a cross-schema FK
(`<table>_tenant_fk` → `meta.tenants(id) ON DELETE CASCADE`),
`ENABLE ROW LEVEL SECURITY`, and a `<table>_tenant_isolation`
policy (`tenant_id = current_setting('app.current_tenant_id',
true)::UUID` — matches META exactly) for entities declaring the
trait. Pack-erp-core's four entities (Account, Contact,
Invoice, InvoiceLine) now use `["auditable", "tenant_owned"]`.
`crossengin apply --pack=operate-erp/core` now produces
deployment-grade DDL — every pack table carries `tenant_id`, FK
to `meta.tenants`, RLS enabled, isolation policy.
M7-wire closed the substrate-to-pack loop in the CLI.
New `apps/architect-cli/src/pack-registry.ts` maps slug →
manifest builder (today: just `operate-erp/core` →
`buildErpCorePack()`; future packs add entries). `runApply`
gains `--pack <slug>` and `--pack-schema <name>` flags
(default schema: `public`). `buildPlan` validates the pack
via `tryValidateManifest` before any DB write, then emits its
DDL via `emitManifestCreate(manifest, {schema})`. The dry-run
output streams META bootstrap SQL followed by pack DDL with a
divider; JSON mode exposes `pack` + `metaStatementCount` +
`packStatementCount` + `availablePacks`. Live apply
concatenates both statement lists into one `MigrationApplier`
run — atomic via advisory-lock + per-statement transactions.
`crossengin apply --dry-run --pack=operate-erp/core` now
produces ~730 statements total (META bootstrap + 4 ERP entity
tables in `public` with FKs, check constraints, indexes —
topologically ordered).
M2.8.5 extended `@crossengin/ai-providers-openai` with the
Responses API (`/v1/responses`) as an opt-in alternative to
Chat Completions. 2 new modules: responses-api (`buildOpenAI
ResponsesRequest` translates `CompletionRequest` to the
flat input-array shape with `instructions` instead of system
messages; `function_call` + `function_call_output` items
replace assistant `tool_calls` and tool-role messages),
responses-streaming (named-event SSE parser dispatching on
`response.output_text.delta` / `response.function_call_
arguments.delta` / `response.completed`). `OpenAIProvider`
gains `defaultApiPath: "chat" | "responses"` constructor
option (defaults to `"chat"` — backward compat) and
`reasoningEffort: "low" | "medium" | "high"` for thinking
models (o1, o3). Two new methods: `completeViaResponses` +
`respondNonStreaming`. The CompletionChunk discriminated
union is unchanged; reasoning summary surfaces only on the
non-streaming envelope via `summarizeResponsesResponse`.
M6.5.5 wired the ai-router into `architect-cli`'s `chat` subcommand. New
`router-setup.ts` exports `DEFAULT_TASK_POLICIES` (7 tasks
mapped to Anthropic-primary + OpenAI-fallback chains; cheap
tasks like summarizer/classifier go to gpt-4o-mini primary) and
`buildChatCompleter({env, forceModel?, costCeiling?})` which
chooses adaptively: one API key → single provider (legacy
behavior); both keys → `DefaultLlmRouter` wrapped in a
`RouterAsProvider` adapter so the chat engine still sees a
single `LlmProvider`-shaped interface. New `--cost-ceiling-usd`
flag enforces per-request budget when the router is active.
Strict `isAnthropicModel` check replaced with a union-aware
check against `provider.models`. Session summary now reports
`providerKind` (single | router) and `availableProviders`.
M2.8 added
`@crossengin/ai-providers-openai` — the second concrete
`LlmProvider`, mirroring M2.7's Anthropic structure. 6 modules:
pricing (5 chat models + 2 embedding models with current
per-token + cached + output rates), chat-api (Chat Completions
request builder + response normalizer with `LlmMessage.toolUses`
→ `tool_calls` translation), streaming (SSE parser for OpenAI's
indexed-tool-call delta format; `delta.tool_calls[i].index`
identifies a call across deltas; usage from the final
`stream_options.include_usage` chunk), embeddings (the FIRST
real `embed()` implementation — buildEmbeddingsRequest +
normalizeEmbeddingResponse with sorted-by-index vectors + dim),
errors (11 typed kinds matching Anthropic's shape so the
router's `isRetryable()` check works uniformly across
providers), provider (`OpenAIProvider.complete()` streaming +
`completeNonStreaming()` + `embed()`; rejects embedding model
in `complete()` and chat model in `embed()`). Zero runtime
deps — pure `fetch` + `ReadableStream`. The router can now
chain Anthropic + OpenAI with real fallback semantics; the
chat substrate can route `--task=summarizer` to gpt-4o-mini
($0.15/M) for cheap operations while keeping authoring on
Claude. Embeddings finally have a real backend.
M6.5 added `@crossengin/ai-router` — the orchestration layer
between consumers and `LlmProvider` implementations. 5 modules: retry
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

ADRs 0001-0104 are fully drafted in `docs/adr/` — no reserved
gaps. ADR-0046 is the Phase 2 implementation plan (M1 DDL → M2
crypto → M3 workflow runtime → M4 gateway runtime → M5 architect-
cli → M6 notifications + workflow bridge → M7 first vertical pack
→ M8 SLO enforcement); ADR-0047 covers M1, ADR-0048 covers M2,
ADR-0049 covers M3, ADR-0050 covers M4, ADR-0051 covers M5,
ADR-0052 covers M6, ADR-0053 covers M2.7 (Anthropic provider),
ADR-0054 covers M5.5 (architect-cli chat mode), ADR-0055 covers
M5.6 (tool-driven chat), ADR-0056 covers M5.8 (write tools with
human-in-the-loop approval), ADR-0057 covers M5.7 (chat
persistence to META_ARCHITECT_*), ADR-0058 covers M7
(`pack-erp-core` — first vertical pack), ADR-0059 covers M6.5
(`ai-router` — provider router with retry / cost / latency),
ADR-0060 covers M2.8 (`ai-providers-openai` — Chat Completions
+ embeddings + tool calls), ADR-0061 covers M6.5.5
(architect-cli router integration), ADR-0062 covers M2.8.5
(OpenAI Responses API support), ADR-0063 covers M7-wire
(CLI `--pack` apply), ADR-0064 covers M7.7 (pack tenant
scoping via `tenant_owned` trait), ADR-0065 covers M7.5
(`pack-erp-payments` — second vertical pack proving cross-pack
composition), ADR-0066 covers M7.8 (payment signal-bridge
wiring), ADR-0067 covers M5.9 (CLI sessions subcommands),
ADR-0068 covers M7.6.5 (kernel `extends` resolver wiring),
ADR-0069 covers M4.7 (CLI gateway binding),
ADR-0070 covers M7.9 (`pack-erp-healthcare` — third vertical
pack), ADR-0071 covers M2.9 (`ai-providers-bedrock` — third
real LlmProvider), ADR-0072 covers M2.9.5 (Bedrock Titan +
Cohere embeddings closing M2.9's open Q4), ADR-0073 covers
M6.5.6 (architect-cli Bedrock integration — env-var detection +
three-deep task fallback chains), ADR-0074 covers M4.7.5
(gateway JWT auth + routes subcommand closing M4.7's open
questions), ADR-0075 covers M4.7.6 (URL-fetched JWKS +
hot-reload via SIGHUP + periodic refresh), ADR-0076 covers
M2.9.6 (Bedrock cacheControl threading + Titan parallelism
closing M2.9 Q3 + M2.9.5 Q4), ADR-0077 covers M2.9.7 (Bedrock
multimodal embeddings + image content block types closing
M2.9.5 Q6), ADR-0078 covers M2.X (kernel LlmMessage.attachments
+ vision capability closing M2.9.7 Q1), ADR-0079 covers M4.8
(gateway routes from pack manifest — bulk register-pack
closing M4.7 manifest-driven question), ADR-0080 covers
M4.8.x (gateway routes unregister-pack — symmetric tear-down
via deterministic ID re-derivation), ADR-0081 covers M4.8.y
(gateway routes sync-pack — composite diff/upsert command
that completes the three-verb pack-routes vocabulary),
ADR-0082 covers M4.10 (routes.source_pack column closing
the open ownership-attribution question across ADRs
0079/0080/0081, enabling safe `sync-pack --prune-obsolete`),
ADR-0083 covers M4.10.x (`unregister-pack --by-source-pack` —
manifest-free tear-down via M4.10's `deleteByPackSlug` API,
closing ADR-0082 Q3), ADR-0084 covers M2.9.8 (Bedrock
Guardrails integration — opt-in content moderation via
guardrailConfig threaded through converse + converse-stream,
with `BedrockGuardrailViolationError` thrown after `usage_final`
for streaming consumers and `isGuardrailInterventionResponse`
helper for non-streaming), ADR-0085 covers M2.9.8.x
(per-request guardrail override via `completeWithGuardrail` +
`completeNonStreamingWithGuardrail` sibling methods, with
three-state semantics: BedrockGuardrailConfig / null / undefined),
ADR-0086 covers M2.X.6 (OpenAI + Anthropic moderation surfaces —
`OpenAIContentFilteredError` for `finish_reason: "content_filter"`
and `AnthropicRefusalError` for `stop_reason: "refusal"`,
matching the M2.9.8 post-usage_final-throw pattern), ADR-0087
covers M2.X.6.x (cross-provider moderation helper — kernel-level
`isModerationError(err)` predicate + `MODERATION_ERROR_KINDS`
shared tuple, duck-typing against `err.kind`), ADR-0088 covers
M2.X.5 (kernel LlmMessage.content as discriminated union —
lifted `content: string` to `string | LlmContentBlock[]` to
unblock multimodal assistant outputs across all three
providers), ADR-0089 covers M2.X.5.x (tool_use + tool_result
content block variants — consolidates tool-call surface with
provider translators handling Bedrock + Anthropic natively
and OpenAI via message-flattening flatMap), ADR-0090 covers
M2.X.7 (cross-provider retryable helper — kernel-level
`isRetryableError(err)` predicate + `RETRYABLE_ERROR_KINDS`
shared tuple, symmetric with M2.X.6.x's moderation helper),
ADR-0091 covers M6.6 (router uses kernel cross-provider
helpers — retry.ts hybrid predicate, explicit moderation
early-exit, estimateRequestTokens bug fix for M2.X.5 array
content), ADR-0092 covers M2.X.8 (standalone OpenAI
Moderations API — `provider.moderate(input)` calls
`/v1/moderations` for proactive content screening before
paying for a chat completion), ADR-0093 covers M2.8.6 (OpenAI
Responses API image inputs — threads ImageContentBlock through
to input_image blocks, closing the M2.X.5 vision gap on the
Responses path), ADR-0094 covers M2.X.5.y (ImageUrlContentBlock
URL variant — adds `{type: "image_url", url}` block alongside
the existing bytes-based image variant; OpenAI providers pass
URLs through, Bedrock + Anthropic throw with explicit
pre-fetch guidance), ADR-0095 covers M2.X.9 (cross-provider
input-too-large helper — third kernel-level predicate
`isInputTooLargeError`; partitions the error space alongside
isModerationError + isRetryableError), ADR-0096 covers M2.X.5.z
(Anthropic URL-source image support — removes the M2.X.5.y
throw, threads URLs through to Anthropic's native URL source
variant; provider parity expanded — OpenAI both paths +
Anthropic now accept URL-based images, Bedrock still requires
bytes), ADR-0097 covers M2.X.5.aa (DocumentContentBlock —
PDF inputs across Bedrock + Anthropic + OpenAI Responses;
OpenAI Chat throws with "use Responses API" guidance),
ADR-0098 covers M2.X.5.aa.y (DocumentUrlContentBlock —
URL-based document inputs; Anthropic native passthrough,
Bedrock + OpenAI throw with pre-fetch guidance), ADR-0099
covers M2.X.5.aa.x (document format expansion — txt/md/csv
added to DOCUMENT_FORMATS enum; Anthropic uses text-source
variant with UTF-8 decoding, OpenAI Responses uses format-
aware MIME types, Bedrock passes format through natively),
ADR-0100 covers M2.X.5.aa.x.1 (office document format
expansion — doc/docx/xls/xlsx/html added; Bedrock native,
Anthropic + OpenAI Responses throw with conversion guidance),
ADR-0101 covers M2.X.10 (kernel LlmMessage.name regex
enforcement + OpenAI Chat threading across all four roles;
Anthropic + Bedrock + OpenAI Responses silently drop),
ADR-0102 covers M2.X.5.aa.z (OpenAI Files API integration —
upload/retrieve/delete CRUD + kernel FileReferenceContentBlock
threaded through Responses API; other providers throw with
actionable guidance), ADR-0103 covers M2.X.5.aa.z.1 (Anthropic
Files API integration — same CRUD shape; removes the M2.X.5.aa.z
throw in the Anthropic translator; file_id blocks now flow
natively to both OpenAI Responses + Anthropic), ADR-0104
covers M2.X.5.aa.z.2 (listFiles() on both Files APIs — provider-
native pagination shapes preserved; tenant offboarding + audit
workflows unblocked), ADR-0105 covers M2.X.5.aa.z.3 (Bedrock
batch inference listBatches — first control-plane operation on
Bedrock; two-host model documented; pattern set for future
control-plane enumeration methods), ADR-0106 covers M2.X.5.aa.z.4
(Bedrock batch inference getBatch — single-job lookup with
identifier regex validation BEFORE fetch; polling-loop +
failure-diagnostic workflows unblocked), ADR-0107 covers
M2.X.5.aa.z.5 (Bedrock batch inference stopBatch — completes
the batch read/write split; new signedControlPlanePost helper;
cost-runaway + tenant-offboarding + compliance-kill-switch
workflows unblocked), ADR-0108 covers M2.X.5.aa.z.6 (Bedrock
batch inference createBatch — closes the four-endpoint batch
CRUD surface; pure boundary validator buildCreateBatchBody
enforces 14 documented AWS constraints; idempotency via
clientRequestToken; cost attribution via tags; VPC-scoped
batch jobs supported), ADR-0109 covers M2.X.5.aa.z.7 (Bedrock
listGuardrails — second control-plane enumeration after
listBatches; new guardrails-api.ts module separated from
inference-time guardrails.ts; pattern now proven twice for
paginated control-plane reads), ADR-0110 covers M2.X.5.aa.z.8
(Bedrock getGuardrail with policy detail — rich companion to
listGuardrails; five typed policy types; stable enums get
strict discriminators while growing enums stay as strings),
ADR-0111 covers M2.X.5.aa.z.9 (Bedrock listInferenceProfiles
— third paginated control-plane enumeration; cross-region
inference profiles; SYSTEM_DEFINED vs APPLICATION type
distinction; pagination pattern now mechanical), ADR-0112
covers M2.X.5.aa.z.10 (Bedrock getInferenceProfile — detail
companion to listInferenceProfiles via type-alias pattern;
log-driven + webhook-driven lookup workflows unblocked),
ADR-0113 covers M2.X.5.aa.z.11 (Bedrock listImportedModels —
fourth paginated control-plane enumeration; custom-imported
model inventory + architecture-aware routing), ADR-0114 covers
M2.X.5.aa.z.12 (Bedrock getImportedModel with data-source
provenance — extended-shape detail pattern; provenance +
KMS-key audit workflows unblocked), ADR-0115 covers
M2.X.5.aa.z.13 (Bedrock listCustomModels — fifth paginated
control-plane enumeration; fine-tune / continued-pretrain /
distillation inventory; 8-parameter filter set is the largest
yet), ADR-0116 covers M2.X.5.aa.z.14 (Bedrock getCustomModel
with training/validation detail — third extended-shape detail
instance; training/validation/output provenance + metrics +
hyperparameters + distillation lineage all surfaced),
ADR-0117 covers M2.X.5.aa.z.15 (Bedrock listModelImportJobs —
sixth paginated enumeration; pipeline-health monitoring +
failure triage + throughput analysis unblocked), ADR-0118
covers M2.X.12 (conflict_error kernel kind + isConflictError
cross-provider classifier — fourth in the family after
isModerationError + isRetryableError + isInputTooLargeError;
two Bedrock 409 endpoints + OpenAI 409s justify the lift),
ADR-0119 covers M5.10.5 (chat REPL widens user input to
LlmContentBlock[] — closes the M2.X.5 investment;
`/attach image_url|document_url|file_id|text` slash commands;
per-turn attachment reset; transcript flattens to placeholders),
ADR-0120 covers M8 (workflow runtime instrumentation hooks +
META_WORKFLOW_TRACES — first production-grade observability
surface for workflows; 11 documented event kinds; PG sink
opt-in via persistTraces; combineInstrumentations fan-out;
OTel-ready event shape; closes the workflow runtime depth gap),
ADR-0121 covers M2.X.5.aa.z.16 (Bedrock getModelImportJob —
fourth extended-shape detail instance; failure-triage +
KMS-audit + VPC-compliance workflows unblocked via
failureMessage / modelDataSource.s3DataSource.s3Uri / roleArn
/ importedModelKmsKeyArn / vpcConfig), ADR-0122 covers
M2.X.5.aa.z.17 (Bedrock listModelCustomizationJobs — seventh
paginated enumeration; parallels listModelImportJobs but for
AWS-native fine-tunes with a richer 5-value status vocabulary
including Stopping/Stopped), ADR-0123 covers M2.X.5.aa.z.18
(Bedrock getModelCustomizationJob with training/validation
detail — fifth extended-shape detail instance; 8 new typed
sub-shapes structurally mirroring getCustomModel; field-name
asymmetry preserved verbatim; reproducibility / triage / cost
/ distillation lineage workflows unblocked), ADR-0124 covers
M2.X.5.aa.z.19 (Bedrock stopModelCustomizationJob — pure
reuse of M2.X.5.aa.z.5's signedControlPlanePost rail;
operator-initiated mid-training aborts; third 409-emitting
Bedrock endpoint earning isConflictError its keep), ADR-0125
covers M2.X.11 (cacheBreakpoint field on LlmContentBlock +
Anthropic prompt caching — additive optional field on all
8 block variants; Anthropic translator emits
cache_control:{type:"ephemeral"}; OpenAI + Bedrock silently
drop for tight scope), ADR-0126 covers M2.X.11.x (Bedrock
cachePoint translator wiring — single-line append in
appendKernelBlocks loop; reuses M2.9's BEDROCK_CACHE_POINT
infrastructure; cross-provider parity now on Anthropic +
Bedrock), ADR-0127 covers M2.X.13 (not_found_error kernel
kind + isNotFoundError cross-provider classifier — fifth
kernel classifier; zero provider changes since the kind was
already wired everywhere; idempotent cleanup workflows now
have a documented cross-provider pattern), ADR-0128 covers
M2.X.14 (authentication_error kernel kind +
isAuthenticationError cross-provider classifier — sixth
kernel classifier closing ADR-0127 Q1; explicitly EXCLUDES
permission_error since auth and permission have distinct
remediation paths), ADR-0129 covers M2.X.15 (permission_error
kernel kind + isPermissionError cross-provider classifier —
seventh kernel classifier closing ADR-0128 Q1; pairs with
isAuthenticationError; cross-account / cross-tenant /
cross-region access denial workflows now documented),
ADR-0130 covers M2.X.16 (invalid_request_error kernel kind +
isInvalidRequestError cross-provider classifier — eighth
kernel classifier completing the canonical 4xx/5xx sweep;
closes ADR-0129 Q1; user-facing error translation pattern
documented), ADR-0131 covers M2.X.5.aa.z.20 (Bedrock
createModelCustomizationJob — largest write surface remaining
on Bedrock; customization-job CRUD now complete; 12+ boundary-
validation rules; AWS contract preserved verbatim including
customModelKmsKeyId vs KmsKeyArn asymmetry), ADR-0132 covers
M8.1 (workflow runtime activity execution instrumentation —
closes ADR-0120 Q3 — adds activity_started / activity_completed
/ activity_failed kinds with durationMs + error context),
ADR-0133 covers M6.6.x (ai-router special-cases
isConflictError for retry chain short-circuit — closes
ADR-0118 Q2 — conflict errors join moderation as terminal in
the isRouterRetryable gate), ADR-0134 covers M6.6.y (ai-
router special-cases isNotFoundError for retry chain short-
circuit — closes ADR-0133 Q1 — not-found errors join
moderation + conflict as terminal in the isRouterRetryable
gate; identifier mismatches don't benefit from fallback
because identifiers are provider-scoped), ADR-0135 covers
M6.7 (PostgresCostTracker — first persisted ai-router
substrate — closes ADR-0059's deferred cost-tracker
persistence Q — `@crossengin/ai-router-pg` package +
META_LLM_COST_WINDOWS table — atomic UPSERT with SQL-side
expiry CASE — drop-in CostTracker replacement), ADR-0136
covers M2.X.5.aa.z.21 (Bedrock DELETE control-plane
surfaces — FIRST DELETE write surfaces — deleteCustomModel
+ deleteImportedModel + deleteGuardrail + shared
signedControlPlaneDelete transport — propagates 404 as
not_found_error so router short-circuit (M6.6.y) handles
automated lifecycle pipelines and operators wanting silent
idempotency wrap with isNotFoundError predicate), ADR-0137
covers M6.7.x (per-tenant cost ceiling — closes ADR-0135 Q1
+ Q4 — META_LLM_COST_CEILINGS 122nd table +
getTenantCostCeiling resolver field on router +
PostgresCostCeilingResolver — whole-object override
semantic: tenant ceiling REPLACES global rather than
merging; ceilings are now data, not code), ADR-0138 covers
M2.X.5.aa.z.22 (Bedrock deleteInferenceProfile — closes
ADR-0136 Q2 — first "smart" delete with mandatory pre-
flight GET that reads `type` and refuses SYSTEM_DEFINED
profiles before any DELETE is issued; 4th DELETE on the
Bedrock control plane; pre-flight-guard pattern set for
future two-typed resources), ADR-0139 covers M5.11
(`crossengin chat --max-cost-usd` session budget — client-
side post-hoc cumulative cap independent of and orthogonal
to --cost-ceiling-usd; enforcement in REPL loop not router
since session budget needs REAL not estimated cost;
operators can run bounded interactive + loop scripts),
ADR-0140 covers M6.7.y (PostgresLatencyTracker —
LatencyTracker interface async-ified (internal-only breaking
change); META_LLM_LATENCY_SAMPLES as the 123rd table;
record = single INSERT, stats = single windowed SELECT with
PG percentile_cont aggregate; provider-level not tenant-
scoped; no RLS), ADR-0141 covers M6.7.z (RouterInstrumentation
+ META_LLM_CALL_TRACES + PostgresRouterInstrumentation —
closes ADR-0135 Q2 + ADR-0137 Q3+Q4 + ADR-0140 Q3 in one
milestone; pattern parity with M8 WorkflowInstrumentation;
3 event kinds — llm_call_started/completed/failed; per-
attempt granularity with willFallback derived; 124th table
audit-optimized + tenant-RLS; ai-router-pg adapter set now
at 4 substrates — cost-windows + cost-ceilings + latency-
samples + call-traces), ADR-0142 covers M2.X.5.aa.z.23
(Bedrock createInferenceProfile — closes ADR-0138 Q3 —
2nd CREATE on Bedrock control plane; completes full
APPLICATION lifecycle on the substrate (create + list + get
+ delete); pure boundary validation for 8 documented
constraints; modelSource discriminated union forward-compat;
clientRequestToken hooks AWS's idempotency contract),
ADR-0143 covers M6.7.zz (META_RETENTION_POLICIES +
PostgresTraceRetention — closes ADR-0120 Q5 + ADR-0140 Q1 +
ADR-0141 Q1 in one cross-cutting substrate; 125th meta-schema
table with hardcoded CHECK allowlist for the 3 trace tables;
adapter in kernel-pg with hardcoded PRUNABLE_TABLES map
preventing SQL injection; per-policy autonomy + idempotent
prune + clock injection; future trace surfaces add via 2-edit
mechanical change), ADR-0144 covers M6.8 (META_LLM_COST_TIERS
+ META_LLM_TENANT_TIER_MEMBERSHIPS — closes ADR-0137 Q2 —
normalized tier substrate for shared pricing plans;
three-level fallback per-tenant→tier→global with whole-object
override at each level preserving M6.7.x semantics; ON DELETE
RESTRICT prevents orphaning; tier policy changes propagate
to all members via one UPDATE on the tier row), ADR-0145
covers M2.X.5.aa.z.24 (Bedrock cross-resource tagging —
closes ADR-0142 Q2 — first multi-resource Bedrock operations;
tagResource + untagResource + listTagsForResource work
across every Bedrock ARN; AWS wire-shape asymmetry preserved
verbatim — query on tag/untag, body on list), ADR-0146 covers
M2.X.5.aa.z.25 (Bedrock updateInferenceProfile PATCH —
closes ADR-0142 Q1 — first PATCH on the Bedrock control plane;
new signedControlPlanePatch transport; APPLICATION-only
mandatory pre-flight guard mirroring deleteInferenceProfile;
description-only mutation since tags have their own canonical
M2.X.5.aa.z.24 surface; race-deleted 404 propagates verbatim;
full APPLICATION lifecycle now on the substrate), ADR-0147
covers M2.X.5.aa.z.26 (Bedrock provisioned-throughput
inspection — read-only get + list of PT resources;
three-ARN distinction surfaces clearly (modelArn vs
desiredModelArn vs foundationModelArn) — operators detect
mid-migration; mutation deferred since PT cost is 100×-1000×
higher than inference profiles needing careful design;
operator wins on cost visibility + orphan reconciliation +
incident-response failure messages), ADR-0148 covers
M2.X.5.aa.z.27 (Bedrock createProvisionedModelThroughput —
closes ADR-0147 Q1 — first PT mutation; clientRequestToken
REQUIRED in substrate input (AWS makes it optional) as
cost-safety guardrail forcing deliberate token-minting
before each $5K+/op create call; substrate's first CREATE
endpoint to mandate the token; modelUnits cap [1, 1000]
defensive on top of AWS quota; no auto-token, no auto-
commit, no dryRun, no status-polling — substrate is the
raw transport).

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
  impure package). 7 modules: connection (PgConnection interface
  + `parsePgEnvConfig` + node-postgres binding), statement-hash
  (sha256 of normalized SQL), migration-log (`_meta_migrations`
  bookkeeping), preconditions (`pg_uuidv7` extension + PG ≥ 14 +
  CREATE privilege checks), applier (advisory-lock-gated, per-
  statement transactions, halt-on-first-failure, hash-based
  skip), introspection (pg_catalog queries + pure parsers), diff
  (pure `diffSchema` vs `META_TABLES`). Ships `crossengin-pg`
  CLI with `apply`, `apply --dry-run`, `drift`, `inspect`,
  `version` commands.
- **`workflow-runtime-pg`** — Postgres-backed adapters for the
  workflow runtime. 10 modules: id-mapping
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
  guards), **instrumentation** (M8 — PostgresWorkflowInstrumentation
  implements WorkflowInstrumentation.onEvent by writing to
  META_WORKFLOW_TRACES with resolved instance/definition UUIDs;
  tolerates unresolved IDs by writing null UUIDs;
  buildPersistentEngine gains persistTraces + instrumentation
  options with explicit > auto > Noop precedence).
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
- **`api-gateway-runtime`** — HTTP gateway middleware
  (fourth impure package). 7 modules: adapters (RequestAdapter +
  ResponseAdapter for Node HTTP + edge runtimes,
  buildIncomingRequest helper), stores (PrincipalResolver +
  IdempotencyStore + RateLimitChecker + RouteRegistry interfaces
  + in-memory implementations), auth (EdDSA JWT verify with iss/
  aud/exp/nbf checks via @crossengin/crypto, opaque token matcher
  with constant-time compare, parseAuthHeader for Bearer/Basic/
  x-api-key), problems (RFC 9457 envelope builders for the 14
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
  DEFAULT_SECURITY_HEADERS on pass).
- **`workflow-runtime`** — in-process event-sourced workflow
  executor (third impure package). 8 modules: clock (Clock +
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
  no_compensation strategies), **instrumentation** (M8 —
  `WorkflowInstrumentation` interface with 11 documented event
  kinds, NoopInstrumentation default, captureInstrumentation()
  in-memory buffer, combineInstrumentations() fan-out helper;
  engine wires events at 8 paths; observability failures
  swallowed so they never crash the engine).
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
  masks. RoleDefinition, RbacGrant, principals.
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
  all non-retryable, so the router doesn't loop on them.
- **`ai-providers-bedrock`** — real AWS Bedrock client
  implementing `LlmProvider`. Zero runtime deps; pure `fetch` +
  `node:crypto` + from-scratch AWS Signature V4. Speaks Bedrock's
  `converse-stream` (binary event-stream framing, NOT SSE),
  `converse` (non-streaming), `invoke` (embeddings via Titan
  or Cohere), AND the control-plane `ListModelInvocationJobs`
  endpoint (M2.X.5.aa.z.3). Two-host model: runtime endpoints
  at `bedrock-runtime.{region}.amazonaws.com`, control-plane
  endpoints at `bedrock.{region}.amazonaws.com`, same sig v4
  service. 8 modules: batch-api (BedrockBatchJobStatus +
  BEDROCK_BATCH_JOB_STATUSES 10-value tuple +
  buildBatchListQuery validator + parseBatchListResponse
  strict parser + BedrockBatchJobSummary /
  BedrockBatchJobListResponse types — for listBatches()
  enumeration of long-running batch inference jobs), pricing
  (8 chat models —
  Claude on Bedrock, Llama 3.1 70B/405B, Mistral Large, Titan
  Premier + 4 embedding models — Titan v2/v1, Cohere
  english/multilingual), signing (sig v4 with HMAC chain
  verified against the AWS-documented `f4780e2d...` reference
  signing key), converse-api (chat request builder + response
  normalizer), embeddings (family-dispatched request builders —
  Titan single-text with selectable 256/512/1024 dimensions;
  Cohere batched up to 96 texts with input_type selector),
  event-stream (binary frame parser → CompletionChunk; tracks
  contentBlockIndex → toolUseId across deltas; throws
  BedrockError on `:message-type: exception`), errors (12
  typed kinds including `model_stream_error` for
  ModelStreamErrorException; CODE_TO_KIND maps 15 AWS exception
  classes), provider (BedrockProvider with complete +
  completeNonStreaming + embed + embedMultimodal + listBatches
  + getBatch + stopBatch + createBatch + listGuardrails +
  getGuardrail + listInferenceProfiles + getInferenceProfile
  + listImportedModels + getImportedModel + listCustomModels +
  getCustomModel + listModelImportJobs + getModelImportJob +
  listModelCustomizationJobs + getModelCustomizationJob +
  stopModelCustomizationJob + createModelCustomizationJob —
  embed dispatches on
  family, loops over Titan or batches Cohere; listBatches GETs
  the control-plane host with sig v4 + sorted query string via
  signedControlPlaneGet helper; getBatch validates jobIdentifier
  via regex BEFORE the fetch then GETs /model-invocation-jobs/
  {encoded}; stopBatch POSTs an empty body to
  /model-invocation-jobs/{encoded}/stop via
  signedControlPlanePost; createBatch validates the full input
  body via buildCreateBatchBody (14 documented AWS constraints)
  BEFORE the fetch then POSTs to /model-invocation-jobs).
  Capabilities:
  `{chat: true, streaming: true, toolUse: true, jsonMode: false,
  embedding: true, maxContextTokens: 200_000}`. The router has
  THREE real chat providers to chain — Anthropic + OpenAI + AWS
  — and TWO embedding providers — OpenAI's text-embedding-3 +
  Bedrock's Titan/Cohere. Real failover diversity across
  independent control planes; AWS-native end-to-end for tenants
  with strict residency requirements.
- **`ai-providers-anthropic`** — real Anthropic Messages API
  client implementing `LlmProvider`.
- **`ai-providers-openai`** — real OpenAI Chat Completions +
  Embeddings client implementing `LlmProvider`. Zero runtime
  deps (`fetch` + `ReadableStream`). 6 modules: pricing
  (gpt-4o / gpt-4o-mini / gpt-4-turbo / o1 / o1-mini for chat;
  text-embedding-3-small / text-embedding-3-large for
  embeddings; per-token + cached input + output rates with
  6-decimal cost rounding), chat-api (Chat Completions request
  builder translating `LlmMessage.toolUses` → OpenAI's
  `tool_calls` array; assistant.content goes to `null` when
  paired with tool calls and no text), streaming (SSE parser
  for the indexed-tool-call delta format — `tool_calls[i].
  index` identifies a call across deltas; arguments come as
  streamed JSON string fragments; usage from the final
  `stream_options.include_usage` chunk), embeddings (the FIRST
  real `embed()` implementation in the workspace; sorts vectors
  by index + derives `dim`), errors (11 typed kinds with same
  `isRetryable()` shape as Anthropic so the router treats them
  uniformly; maps `rate_limit_exceeded` + `service_unavailable`
  to the platform vocabulary), provider (`OpenAIProvider.
  complete()` + `completeNonStreaming()` + `embed()`; type
  guards reject embedding-model-in-chat and chat-model-in-embed
  locally; optional `openai-organization` + `openai-project`
  headers for enterprise routing). Capabilities `{embedding:
  true, jsonMode: true, supportsThinking: false}` — the
  complement of Anthropic's, so the router can route embedding
  tasks to OpenAI automatically. Zero runtime deps (pure
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
- **`pack-erp-healthcare`** — third vertical pack. Extends
  `operate-erp/core` via `meta.extends`. 3 entities (Patient
  with auditable + tenant_owned, references Account + Contact;
  Encounter referencing Patient with FHIR EncounterClass +
  6-state lifecycle; Observation referencing Encounter +
  Patient with FHIR R4 status enum + code_system covering
  LOINC/SNOMED/ICD-10). 3 relations (Account→Patient restrict,
  Patient→Encounter restrict, Encounter→Observation cascade).
  2 new roles (erp_clinician + erp_front_desk) that merge with
  core's three. 2 workflows: encounter_lifecycle (scheduled →
  checked_in → in_progress → completed | cancelled | no_show;
  only mark_no_show is automatic, used by the 15-min sweep job;
  2 SLAs at PT30M + P1D) and observation_lifecycle (FHIR R4 4
  states; entered_in_error is admin-only via permission gate
  for amendment discipline). 3 jobs (daily encounter-reminder
  at 08:00 UTC with phi i/o data class; */15 no-show-sweep;
  event-triggered fhir-export on `healthcare.encounter.
  completed` for downstream EHR integration). 3 list views.
  compliancePacks defaults to ["hipaa", "21_cfr_11"] — the
  meta-level signal for downstream tooling. Cross-pack
  references (Patient → Account, Patient → Contact) resolve via
  the M7.6.5 kernel resolver; standalone manifest fails
  validation by design (intentional — resolver merges first).
- **`pack-erp-payments`** — second vertical pack. Extends
  `operate-erp/core` via `meta.extends`. 1 entity (Payment
  with auditable + tenant_owned, references Invoice), 1
  relation (Invoice → Payment), 5 permission transitions,
  `payment_lifecycle` workflow (6 states: pending → captured
  → settled active; refunded / failed / cancelled terminal;
  refund reachable from captured or settled; 2 SLAs at P1D
  and P5D), 2 jobs (event-triggered provider webhook handler
  on `billing.payment_received` for the M6 signal bridge to
  consume; hourly settlement sweep as backstop), 1 list view.
  As of M7.6.5, `buildErpPaymentsPack()` returns a child-only
  manifest with `meta.extends: ["operate-erp/core"]`; the
  kernel's `resolveManifest` merges the parent at apply
  time. Cross-pack Payment → Invoice FK resolves via the
  merged manifest. Pattern for future packs that extend an
  existing pack — author declares `extends`, kernel does the
  merge work.
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
catalog of 115 platform-level Postgres tables. Each new package
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
- Customer-facing apps under `apps/` other than `architect-cli`.
  UI lives in `views` as type definitions only.

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

**No longer deferred (as of M5 + M4.7):** the developer entry
point + a running gateway. `apps/architect-cli` ships a
`crossengin` binary with the M5 subcommand surface: `init`
(scaffold a manifest), `validate` (zod-check + summary), `diff`
(computeManifestDiff with human or JSON output), `patch` (write
a manifest patch), `hash` (deterministic manifestHash), `apply`
(--dry-run emits the 3,061-line meta-schema SQL; live mode uses
MigrationApplier against PGHOST/PGDATABASE), `chat` (wired in
M5.5 — see below), `gateway start` (M4.7 — boots the gateway
runtime against a Node HTTP server, in-memory or Postgres-backed,
with built-in `/__ping` + `/__health` routes), `version`, `help`.
Every subcommand has --format human|json. Exit codes: 0 success /
1 runtime problem / 2 misuse. The CLI is the first binary that
composes contracts → real artifact, and now also the binary that
turns the M4 gateway runtime into a real listening HTTP server.

**No longer deferred (as of M5.9):** the chat audit trail is
queryable from the CLI. `crossengin sessions list / show /
replay` reads from META_ARCHITECT_* via the existing M5.7
stores and renders sessions as human-readable transcripts.
The new `getBySessionId({tenantId, sessionId})` on the
session store makes the (tenant_id, session_id) compound key
first-class. Operators debugging a "Claude gave wrong manifest"
report find the session via `list`, inspect the full
transcript via `show`, and re-read the conversation
chat-style via `replay`. M5.6 tool dispatch + M5.8 write
approvals surface verbatim in the audit data.

**No longer deferred (as of M7.8):** webhook → workflow signal
wiring for payments. `pack-erp-payments/src/signal-bridge.ts`
exports the canonical signal-name vocabulary, the provider
event-type → signal-name map (Stripe + Adyen + Braintree), a
multi-path correlation extractor (handles `data.object.id`,
`pspReference`, `transaction.id`, generic `provider_reference`),
and factory functions that wrap M6's `WorkflowSignalBridge`
with the right defaults. End-to-end verified: HMAC-signed
Stripe-shaped `payment_intent.succeeded` webhook → bridge
extracts `pi_xxx` → `submitSignal({signalName: "payment.captured",
correlationKey: "pi_xxx", tenantId, idempotencyKey})`. Pattern
for future webhook-driven packs (`pack-erp-shipping` for
carriers, etc.).

**No longer deferred (as of M7.5 + M7.6.5 + M7.9):** cross-pack
composition with kernel-driven extends resolution, exercised by
TWO downstream consumers. `pack-erp-payments` and
`pack-erp-healthcare` both declare `meta.extends: ["operate-erp/
core"]`; both return only their child additions; both resolve
via the kernel's `resolveManifest(manifest, {registry})` (which
loads the parent by slug from the CLI's `packManifestRegistry()`
and merges entities + traits + relations + roles + permissions
+ workflows + jobs + views into one unified manifest). The
healthcare pack adds 2 new roles (erp_clinician + erp_front_
desk) that merge with core's three — proving role contributions
flow correctly. `crossengin apply --pack=operate-erp/payments`
emits 5 entity tables; `--pack=operate-erp/healthcare` emits 7
(4 core + 3 healthcare); both with M7.7 tenant isolation
intact. Cycle detection (`ExtendsCycleError`) and unknown-
parent errors (`UnknownParentManifestError`) surface as typed
CLI exit codes. Pattern set for future verticals — declare
extends, kernel does the merge, marketplace enumerates
dependencies without running pack builders.

**No longer deferred (as of M7.7):** per-tenant isolation on
pack tables. The kernel's `tenant_owned` built-in trait now
injects `tenant_id UUID NOT NULL` (indexed), a cross-schema FK
to `meta.tenants(id) ON DELETE CASCADE`, `ENABLE ROW LEVEL
SECURITY`, and a `<table>_tenant_isolation` policy that uses
the same `current_setting('app.current_tenant_id', true)::UUID`
expression as every META table. Pack-erp-core's four entities
opt in via `["auditable", "tenant_owned"]`; the resulting SQL
is production-grade for multi-tenant deployments.

**No longer deferred (as of M7-wire):** the substrate-to-pack
end-to-end loop. `crossengin apply --pack <slug>` now resolves
a registered pack (today: `operate-erp/core`), validates its
manifest, emits per-entity DDL via the kernel's
`emitManifestCreate`, and concatenates with the meta bootstrap
SQL into one atomic MigrationApplier run. Five years of
contract work + nine months of runtime work produce a working
binary that ships a working schema in one command.

**No longer deferred (as of M2.8.5):** OpenAI Responses API.
The provider opts into `/v1/responses` via the `defaultApiPath`
constructor option (or per-call via `completeViaResponses`).
The Responses path collapses system messages into `instructions`,
flattens tool calls + tool results into top-level
`function_call` + `function_call_output` items, and surfaces
reasoning summaries via the non-streaming
`summarizeResponsesResponse` helper (streaming only emits
text + tool chunks; reasoning lives off-channel). Pattern set
for future named-event streaming providers (Anthropic's
upcoming responses-style endpoint, AWS Bedrock converse stream)
without touching the `CompletionChunk` discriminated union.

**No longer deferred (as of M6.5.5):** the router is live in
the CLI. `crossengin chat` now uses `buildChatCompleter` to
adapt to whichever API keys are configured. One key →
single-provider mode (legacy behavior preserved). Both keys →
`DefaultLlmRouter` with default task policies (cheap tasks to
gpt-4o-mini, premium tasks to opus, embeddings to OpenAI).
New `--cost-ceiling-usd` flag enforces per-request budget when
the router is active. The CLI's session-end summary reports
which mode was used.

**No longer deferred (as of M2.8):** the second real LLM
provider + embeddings. `@crossengin/ai-providers-openai`
covers OpenAI's Chat Completions (gpt-4o family + o1 family)
and Embeddings (text-embedding-3 family) APIs end-to-end. The
M5.6 `LlmMessage.toolUses` extension translates cleanly into
OpenAI's `tool_calls` format with no schema changes — proving
the cross-provider pattern. The router (M6.5) now has two
real providers to route between; embeddings have a real
backend for the first time. Operators can configure
`taskPolicies.summarizer = { primary: "openai/gpt-4o-mini",
fallback: ["anthropic/claude-haiku-4-5"] }` to drop cheap
summarization to a $0.15/M model while keeping authoring on
Claude.

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
Anthropic key.

## ADRs

ADRs 0001-0104 exist as markdown in `docs/adr/`. Every shipped
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
(`ai-router`), ADR-0060 covers Phase 2 M2.8
(`ai-providers-openai`), ADR-0061 covers Phase 2 M6.5.5
(architect-cli router integration), ADR-0062 covers Phase 2
M2.8.5 (OpenAI Responses API support), ADR-0063 covers Phase 2
M7-wire (CLI `--pack` apply), ADR-0064 covers Phase 2 M7.7
(pack tenant scoping via `tenant_owned` trait), ADR-0065
covers Phase 2 M7.5 (pack-erp-payments — cross-pack
composition), ADR-0066 covers Phase 2 M7.8 (payment
signal-bridge wiring), ADR-0067 covers Phase 2 M5.9 (CLI
sessions subcommands), ADR-0068 covers Phase 2 M7.6.5
(kernel `extends` resolver wiring), ADR-0069 covers Phase 2
M4.7 (CLI gateway binding), ADR-0070 covers Phase 2 M7.9
(`pack-erp-healthcare` — third vertical pack), ADR-0071 covers
Phase 2 M2.9 (`ai-providers-bedrock` — third real LlmProvider
with AWS sig v4 + binary event-stream parsing), ADR-0072 covers
Phase 2 M2.9.5 (Bedrock Titan + Cohere embeddings closing
M2.9's open Q4), ADR-0073 covers Phase 2 M6.5.6 (architect-cli
Bedrock integration), ADR-0074 covers Phase 2 M4.7.5 (gateway
JWT auth + routes subcommand), ADR-0075 covers Phase 2 M4.7.6
(URL-fetched JWKS + SIGHUP/periodic hot-reload), ADR-0076
covers Phase 2 M2.9.6 (Bedrock cacheControl + Titan
parallelism), ADR-0077 covers Phase 2 M2.9.7 (Bedrock
multimodal embeddings + chat image content block types),
ADR-0078 covers Phase 2 M2.X (kernel LlmMessage.attachments
+ vision capability — multimodal chat across Anthropic +
OpenAI + Bedrock), ADR-0079 covers Phase 2 M4.8 (gateway
routes from pack manifest — bulk register-pack via the
M7.6.5 extends resolver), ADR-0080 covers Phase 2 M4.8.x
(gateway routes unregister-pack — symmetric tear-down),
ADR-0081 covers Phase 2 M4.8.y (gateway routes sync-pack —
composite diff/upsert + external-route reporting), ADR-0082
covers Phase 2 M4.10 (routes.source_pack column — pack
attribution + safe `sync-pack --prune-obsolete`), ADR-0083
covers Phase 2 M4.10.x (`unregister-pack --by-source-pack` —
manifest-free tear-down via the source_pack column), ADR-0084
covers Phase 2 M2.9.8 (Bedrock Guardrails integration — opt-in
content moderation with thrown errors for streaming + typed
stopReason for non-streaming), ADR-0085 covers Phase 2 M2.9.8.x
(Bedrock per-request guardrail override — sibling methods with
three-state semantics for tenant-specific / A-B-cohort /
admin-escape-hatch use cases), ADR-0086 covers Phase 2 M2.X.6
(OpenAI + Anthropic moderation surfaces — typed errors for
`finish_reason: "content_filter"` and `stop_reason: "refusal"`
matching the M2.9.8 post-usage_final-throw pattern), ADR-0087
covers Phase 2 M2.X.6.x (cross-provider moderation helper —
kernel-level `isModerationError(err)` predicate + shared
`MODERATION_ERROR_KINDS` tuple), ADR-0088 covers Phase 2 M2.X.5
(kernel LlmMessage.content discriminated union — unblocked
multimodal assistant outputs across Anthropic / OpenAI / Bedrock),
ADR-0089 covers Phase 2 M2.X.5.x (tool_use + tool_result content
block variants — consolidates tool-call surface with OpenAI
flatMap refactor for message-flattening), ADR-0090 covers Phase
2 M2.X.7 (cross-provider retryable helper — kernel-level
`isRetryableError(err)` + shared `RETRYABLE_ERROR_KINDS` tuple,
symmetric with M2.X.6.x's moderation helper), ADR-0091 covers
Phase 2 M6.6 (router uses kernel cross-provider helpers —
exercises M2.X.6.x + M2.X.7 in real consumer code + fixes
M2.X.5 array-content estimation bug), ADR-0092 covers Phase 2
M2.X.8 (standalone OpenAI Moderations API — provider.moderate
for proactive pre-screening with 11-category classification),
ADR-0093 covers Phase 2 M2.8.6 (OpenAI Responses API image
inputs — closes M2.X.5 vision gap on the Responses path),
ADR-0094 covers Phase 2 M2.X.5.y (ImageUrlContentBlock — URL-
based image variant for the kernel content union, with
OpenAI pass-through and Bedrock/Anthropic throw semantics),
ADR-0095 covers Phase 2 M2.X.9 (cross-provider input-too-
large helper — third predicate in the kernel error
classification surface, completing the partition into
retryable + moderation + input-too-large + other), ADR-0096
covers Phase 2 M2.X.5.z (Anthropic URL-source image support —
threads ImageUrlContentBlock URLs through to Anthropic's
native URL source variant; provider parity expanded for
URL-based images across both OpenAI paths + Anthropic),
ADR-0097 covers Phase 2 M2.X.5.aa (DocumentContentBlock — PDF
inputs supported on Bedrock + Anthropic + OpenAI Responses
via native document/file content blocks; OpenAI Chat throws
with actionable guidance pointing to the Responses path),
ADR-0098 covers Phase 2 M2.X.5.aa.y (DocumentUrlContentBlock —
URL-based PDF inputs; Anthropic native passthrough, three other
provider paths throw with pre-fetch guidance), ADR-0099 covers
Phase 2 M2.X.5.aa.x (document format expansion txt/md/csv —
4 formats × 3 providers all native), ADR-0100 covers Phase 2
M2.X.5.aa.x.1 (office document format expansion — doc/docx/xls/
xlsx/html added; Bedrock native, two-provider throw with
conversion guidance), ADR-0101 covers Phase 2 M2.X.10 (kernel
LlmMessage.name enforcement + OpenAI Chat threading across all
four message roles), ADR-0102 covers Phase 2 M2.X.5.aa.z
(OpenAI Files API integration — upload/retrieve/delete CRUD +
FileReferenceContentBlock kernel variant; OpenAI Responses
native passthrough, three other provider paths throw),
ADR-0103 covers Phase 2 M2.X.5.aa.z.1 (Anthropic Files API
integration — mirror of OpenAI Files API but with Anthropic
beta header and document source: {type: "file"} variant; the
M2.X.5.aa.z Anthropic throw becomes a native passthrough),
ADR-0104 covers Phase 2 M2.X.5.aa.z.2 (Files API listFiles()
across OpenAI + Anthropic — provider-native pagination shapes
preserved; CRUD+list pattern complete on both providers),
ADR-0105 covers Phase 2 M2.X.5.aa.z.3 (Bedrock batch inference
listBatches — first control-plane operation on Bedrock,
exposed via a separate controlPlaneBaseUrl + signedControlPlaneGet
helper; three-provider enumeration parity achieved across
OpenAI listFiles + Anthropic listFiles + Bedrock listBatches),
ADR-0106 covers Phase 2 M2.X.5.aa.z.4 (Bedrock batch inference
getBatch — single-job lookup pairing with listBatches;
identifier validated against an AWS-partition-aware regex
BEFORE the fetch; BedrockBatchJobDetail = BedrockBatchJobSummary
alias since AWS returns identical wire shapes for both
endpoints; parseBatchJobSummary promoted from private to
exported for operator reuse), ADR-0107 covers Phase 2
M2.X.5.aa.z.5 (Bedrock batch inference stopBatch — third
batch operation, completing read/write split; new
signedControlPlanePost transport rail for empty-body POSTs;
409 ConflictException surfaces via `.code` field — dedicated
conflict_error kernel kind deferred until a second 409-emitting
endpoint lands), ADR-0108 covers Phase 2 M2.X.5.aa.z.6
(Bedrock batch inference createBatch — fourth batch operation
closing the CRUD surface; pure boundary-validator
buildCreateBatchBody enforces 14 documented AWS constraints
fast-fail at the boundary; signedControlPlanePost widened to
accept an optional body; second 409-emitting endpoint now
justifies a dedicated conflict_error kernel kind, proposed
as M2.X.12), ADR-0109 covers Phase 2 M2.X.5.aa.z.7 (Bedrock
listGuardrails — second control-plane enumeration following
the M2.X.5.aa.z.3 pattern; new guardrails-api.ts module
keeps inference-time guardrails.ts and control-plane concerns
separated; six-value status tuple matching AWS uppercase
verbatim; behavioral note documented — guardrailIdentifier
toggles between roster-mode and version-history-mode),
ADR-0110 covers Phase 2 M2.X.5.aa.z.8 (Bedrock getGuardrail
with policy detail — full guardrail body returned for
compliance disclosures + drift detection + multi-version
diffs; five typed nested policy types modeled with stable
4-tuple enums for filter strength + content filter type +
contextual grounding type + PII action; growing enums like
PII entity type preserved as strings for forward-compat;
field naming asymmetry preserved (ListGuardrails uses
{id, arn}; GetGuardrail uses {guardrailId, guardrailArn})),
ADR-0111 covers Phase 2 M2.X.5.aa.z.9 (Bedrock
listInferenceProfiles — third paginated control-plane
enumeration after listBatches + listGuardrails; cross-region
inference profiles, AWS's recommended production-workload
invocation path; SYSTEM_DEFINED vs APPLICATION type
distinction surfaced; per-region modelArn list preserved
verbatim), ADR-0112 covers Phase 2 M2.X.5.aa.z.10 (Bedrock
getInferenceProfile — detail companion mirroring the
M2.X.5.aa.z.4 getBatch type-alias pattern;
BedrockInferenceProfileDetail = BedrockInferenceProfileSummary
since AWS returns identical shapes; both ID and ARN forms
accepted as identifier), ADR-0113 covers Phase 2 M2.X.5.aa.z.11
(Bedrock listImportedModels — fourth paginated control-plane
enumeration; custom-imported model artifacts surfaced for
inventory + architecture-aware routing + instruct-tuned
discoverability + tenant cleanup; modelArchitecture preserved
as raw string for forward-compat against AWS architecture
additions), ADR-0114 covers Phase 2 M2.X.5.aa.z.12 (Bedrock
getImportedModel with data-source provenance — extended-shape
detail (not type-alias) since AWS adds jobName + jobArn +
modelDataSource.s3DataSource.s3Uri + optional modelKmsKeyArn;
two get-shape patterns now distinct in the package: type-alias
when AWS returns identical shapes, extended-type when get
returns richer fields; provenance + KMS audit + import-job
correlation workflows unblocked), ADR-0115 covers Phase 2
M2.X.5.aa.z.13 (Bedrock listCustomModels — fifth paginated
control-plane enumeration; custom models = fine-tunes /
continued-pretrains / distillations distinct from imported
models; 8-parameter filter set including
baseModelArnEquals / foundationModelArnEquals / isOwned;
mixed-case status tuple Active|Creating|Failed preserved
verbatim from AWS; modelStatus optional since AWS omits it
for legacy entries), ADR-0116 covers Phase 2 M2.X.5.aa.z.14
(Bedrock getCustomModel with training/validation detail —
third extended-shape detail instance after Guardrail +
ImportedModel; 8 new typed sub-shapes modeling AWS's contract
verbatim including S3Config / Validator /
ValidationDataConfig / TrainingMetrics / ValidationMetric /
TeacherModelConfig / DistillationConfig /
CustomizationConfig; hyperParameters as Record<string, string>
matching AWS's wire contract; strict finite-number validation
on losses), ADR-0117 covers Phase 2 M2.X.5.aa.z.15 (Bedrock
listModelImportJobs — sixth paginated control-plane
enumeration; pairs with M2.X.5.aa.z.12's BedrockImportedModelDetail
jobArn field; mixed-case 3-value status tuple
InProgress|Completed|Failed; importedModelArn +
importedModelName conditionally populated post-success per AWS
documented behavior), ADR-0118 covers Phase 2 M2.X.12
(conflict_error kernel kind + isConflictError cross-provider
classifier — fourth kernel classifier following the
established M2.X.6.x / M2.X.7 / M2.X.9 pattern; triggered by
two Bedrock 409-emitting endpoints (stopBatch + createBatch)
plus OpenAI 409 surfaces; three provider error tables extended;
conflict_error is NOT retryable; two existing tests upgraded
to assert the new classified kind), ADR-0119 covers Phase 2
M5.10.5 (chat REPL widens user input to LlmContentBlock[] —
closes the M2.X.5/.x/.y/.z/.aa investment loop;
parseUserLine slash-command parser; composeUserContent helper;
per-turn attachment reset semantics; transcript schema
unchanged via userContentToTranscriptText flattening; pattern
set for future kernel multimodal additions), ADR-0120 covers
Phase 2 M8 (workflow runtime instrumentation hooks +
META_WORKFLOW_TRACES — first production-grade observability
surface for workflows; WorkflowInstrumentation interface with
11 event kinds wired at 8 engine paths; NEW 120th meta-schema
table META_WORKFLOW_TRACES distinct from source-of-truth
META_WORKFLOW_EVENTS; PostgresWorkflowInstrumentation
implementation; buildPersistentEngine gains persistTraces +
instrumentation options; observability failures NEVER crash
the engine; OTel-ready event shape; combineInstrumentations
fan-out helper), ADR-0121 covers Phase 2 M2.X.5.aa.z.16
(Bedrock getModelImportJob — fourth extended-shape detail
instance after Guardrail / ImportedModel / CustomModel;
import-job triage workflows fully unblocked; failure
diagnostics + IAM role audit + KMS + VPC config all
surfaced via the rich GetModelImportJob response;
parseModelImportJobDetail reuses M2.X.5.aa.z.15's
isBedrockModelImportJobStatus discriminator), ADR-0122 covers
Phase 2 M2.X.5.aa.z.17 (Bedrock listModelCustomizationJobs —
seventh paginated control-plane enumeration; AWS-native
fine-tune surface paralleling listModelImportJobs but with a
richer 5-value status vocabulary including Stopping/Stopped
for operator-issued mid-training aborts; customizationType
preserved as string for forward-compat), ADR-0123 covers
Phase 2 M2.X.5.aa.z.18 (Bedrock getModelCustomizationJob with
training/validation detail — fifth extended-shape detail
instance; 9 required + 13 optional fields; 8 typed sub-shapes
including S3Config / Validator / ValidationDataConfig /
TrainingMetrics / ValidationMetric / TeacherModelConfig /
DistillationConfig / CustomizationConfig structurally
mirroring getCustomModel but typed independently per
AWS-contract preservation; field-naming asymmetry vs summary
preserved verbatim — detail uses outputModelName/outputModelArn,
summary uses customModelName/customModelArn), ADR-0124 covers
Phase 2 M2.X.5.aa.z.19 (Bedrock stopModelCustomizationJob —
operator-initiated mid-training abort companion to the
Stopping/Stopped statuses from M2.X.5.aa.z.17; pure reuse of
the M2.X.5.aa.z.5 signedControlPlanePost rail; third Bedrock
endpoint emitting 409 ConflictException — isConflictError
classifier (M2.X.12) now load-bearing across stopBatch +
createBatch + stopModelCustomizationJob), ADR-0125 covers
Phase 2 M2.X.11 (cacheBreakpoint field on LlmContentBlock +
Anthropic prompt caching — additive optional field on all 8
block variants; Anthropic translator emits cache_control:
{type: "ephemeral"} via the new withCacheControl post-process
wrapper; AnthropicContentBlock union widened; AWS Bedrock's
separate cachePoint BLOCK type wire shape deferred to a
follow-up; OpenAI implicit-caching path silently drops the
field; long-context chat workloads see ~10x input-cost
reduction on cache hits), ADR-0126 covers Phase 2 M2.X.11.x
(Bedrock cachePoint translator wiring — closes the Q1 deferred
from ADR-0125; single-line append in appendKernelBlocks loop
inserts the shared BEDROCK_CACHE_POINT constant after each
kernel block with cacheBreakpoint; M2.9's pre-built
cachePoint infrastructure earns its keep; cross-provider
parity now on Anthropic + Bedrock for the kernel
cacheBreakpoint field), ADR-0127 covers Phase 2 M2.X.13
(not_found_error kernel kind + isNotFoundError cross-provider
classifier — fifth kernel classifier in the family following
the established M2.X.6.x / M2.X.7 / M2.X.9 / M2.X.12 pattern;
zero provider changes required since all three providers
already emit not_found_error from classifyHttpStatus(404);
kernel error-space partition now has six buckets;
idempotent cleanup workflows have a documented cross-provider
pattern), ADR-0128 covers Phase 2 M2.X.14 (authentication_error
kernel kind + isAuthenticationError cross-provider classifier
— sixth kernel classifier; closes ADR-0127 Q1 mechanically;
all three providers already emit authentication_error from
classifyHttpStatus(401), Bedrock additionally via CODE_TO_KIND
for AWS-specific exception names; explicitly distinct from
permission_error since 401 and 403 have different remediation
paths; credential rotation + multi-tenant key validation + CI
boot-check workflows now documented), ADR-0129 covers Phase 2
M2.X.15 (permission_error kernel kind + isPermissionError
cross-provider classifier — seventh kernel classifier
completing the canonical 4xx/5xx classifier suite except for
invalid_request_error; closes ADR-0128 Q1 mechanically;
Anthropic + OpenAI emit permission_error from
classifyHttpStatus(403), Bedrock via
CODE_TO_KIND["AccessDeniedException"]; pairs with
isAuthenticationError for "any auth-related issue" composite
via inline OR), ADR-0130 covers Phase 2 M2.X.16
(invalid_request_error kernel kind + isInvalidRequestError
cross-provider classifier — EIGHTH AND FINAL kernel
classifier; closes ADR-0129 Q1 mechanically; completes the
canonical 4xx/5xx sweep — every documented kernel error kind
across all three providers now has a kernel classifier;
mutual-exclusivity test asserts an invalid_request_error
matches exactly ONE classifier; CI kernel-validation + LLM
auto-fix + user-facing error translation workflows have
documented patterns), ADR-0131 covers Phase 2 M2.X.5.aa.z.20
(Bedrock createModelCustomizationJob — largest write surface
remaining on Bedrock's control plane; customization-job CRUD
now complete after M2.X.5.aa.z.17/.18/.19; 7 required + 8
optional fields with 12+ boundary-validation rules; reuses 5
sub-types from M2.X.5.aa.z.18 + adds
BedrockModelCustomizationJobTag; AWS contract preservation
includes customModelKmsKeyId (not KmsKeyArn — preserved
verbatim) and create-vs-get field-naming asymmetry per
ADR-0123; three workflows unblocked: programmatic fine-tune
submission, automated retry-on-failure with adjusted
hyperparameters, distillation lineage capture), ADR-0132
covers Phase 2 M8.1 (workflow runtime activity execution
instrumentation — closes ADR-0120 Q3, the longest-outstanding
deferred Q from the M8 milestone; WORKFLOW_INSTRUMENTATION_KINDS
grows 11→14 with activity_started + activity_completed +
activity_failed; durationMs computed from engine clock;
handler-exception path covered (both controlled `return
{status: "failed"}` and uncaught `throw` surface
activity_failed with HANDLER_EXCEPTION errorCode);
META_WORKFLOW_TRACES.kind CHECK constraint widened
additively; three operator workflows enabled: latency
dashboards via durationMs aggregation, failure alerting on
the indexed kind column, per-activity-kind cost attribution
rail ready for future M6.7 PostgresCostTracker), ADR-0133
covers Phase 2 M6.6.x (ai-router special-cases isConflictError
for retry chain short-circuit — closes ADR-0118 Q2 from the
M2.X.12 conflict_error classifier milestone; one-line gate
extension in isRouterRetryable; conflict errors join
moderation as terminal; rate_limit / moderation / other paths
unchanged; pattern set for future per-classifier short-circuit
ADRs), ADR-0134 covers Phase 2 M6.6.y (ai-router special-cases
isNotFoundError for retry chain short-circuit — closes ADR-0133
Q1 from the M6.6.x conflict short-circuit milestone; same
shape one-line extension; not-found errors join moderation +
conflict as terminal in isRouterRetryable; identifier
mismatches don't benefit from fallback because identifiers are
provider-scoped — OpenAI file_id ≠ Anthropic file ID ≠ Bedrock
ARN; three classifiers now short-circuit: moderation +
conflict + not_found; rate_limit fallback path preserved),
ADR-0135 covers Phase 2 M6.7 (PostgresCostTracker — first
persisted ai-router cost accumulator — closes ADR-0059's
longest-deferred Q; new `@crossengin/ai-router-pg` package
follows the established X / X-pg adapter pattern; adds 121st
meta-schema table META_LLM_COST_WINDOWS with one row per
tenant — natural PK on tenant_id, NUMERIC(18,8) cost
precision, RLS tenant-isolated; atomic UPSERT with SQL-side
expiry CASE makes concurrent recordUsage from multi-replica
gateways race-free in a single round-trip; tumbling-window
semantic matches InMemoryCostTracker exactly so the
substitution is drop-in; closes 3 operator gaps: multi-replica
under-enforcement, cross-restart zeroing, and dashboard
observability via `SELECT * FROM meta.llm_cost_windows`),
ADR-0136 covers Phase 2 M2.X.5.aa.z.21 (Bedrock DELETE
control-plane surfaces — FIRST DELETE write surfaces ever
shipped on the Bedrock substrate; deleteCustomModel +
deleteImportedModel + deleteGuardrail + shared
signedControlPlaneDelete transport; mirrors the corresponding
GET endpoints exactly on path / identifier shape; 404
propagation pattern documented — caller decides idempotency
via isNotFoundError(err) predicate wrap, never provider-
swallowed because that would block the router short-circuit
(M6.6.y) and verify-then-recreate workflows; deleteGuardrail
preserves AWS asymmetric default — omit-version = delete all,
provide-version = delete that one; transport rail reusable
for future DELETE rollouts on inference-profiles / prompts /
flows; Bedrock control plane now has 18 read + 2 stop + 1
create + 3 delete = 24 operations), ADR-0137 covers Phase 2
M6.7.x (per-tenant cost ceiling — closes ADR-0135 Q1 + Q4
in one milestone; META_LLM_COST_CEILINGS as the 122nd meta-
schema table with one row per tenant, NULLABLE policy
columns where NULL = unbounded on that axis, NUMERIC(18,8)
precision, RLS tenant-isolated; new `getTenantCostCeiling`
field on DefaultLlmRouterOptions for resolver injection;
PostgresCostCeilingResolver in `@crossengin/ai-router-pg`
provides drop-in implementation; whole-object override
semantic — tenant ceiling REPLACES the global rather than
merging field-by-field; ceilings are now data not code so
operators adjust without redeploying; schema forward-compat
with future history-aware reads via effective_from column;
zero data migration needed — pre-existing tenants get the
global ceiling, new per-tenant rows opt-in via INSERT; per-
tier pricing now expressible (free / pro / enterprise)),
ADR-0138 covers Phase 2 M2.X.5.aa.z.22 (Bedrock
deleteInferenceProfile with system-profile guard — closes
ADR-0136 Q2; 4th DELETE on the Bedrock control plane and
the first "smart" delete with mandatory pre-flight; the
inference-profiles namespace contains two kinds of
resources sharing the same URI — APPLICATION (operator-
deletable) vs SYSTEM_DEFINED (AWS-owned + immutable); a
blind DELETE on a system profile yields opaque AWS
ValidationException so the substrate runs a mandatory pre-
flight `getInferenceProfile` serving three purposes
simultaneously (existence check via 404 → not_found_error,
GET-permission check via 403 → permission_error, type
field read for guard); type !== "APPLICATION" → throw
invalid_request_error with profile + type in message + NO
DELETE issued; type === "APPLICATION" → DELETE via
signedControlPlaneDelete; no bypass flag, no type-from-
caller, no cache; race window between GET and DELETE
propagates the DELETE-side 404 verbatim — same idempotency-
via-isNotFoundError pattern as ADR-0136 applies; pre-flight-
guard pattern established for future two-typed resources;
Bedrock control plane now has 18 read + 2 stop + 1 create +
4 delete = 25 operations), ADR-0139 covers Phase 2 M5.11
(`crossengin chat --max-cost-usd $X` session budget flag —
session-scoped post-hoc cumulative cap independent of and
orthogonal to --cost-ceiling-usd which remains the per-
request gate; enforcement lives in REPL loop not router for
three reasons (router preflight uses estimated cost while
budget needs real cost; router is transport but budget is
CLI-state; maxUsdPerWindow would need fake-long windowSeconds
as code smell); check at top of each REPL iteration BEFORE
consuming next input — last turn allowed to complete but
next refused; one-shot mode flags exceedance informationally
after the single turn; human + JSON display surfaces with
parity; no breaking change — existing callers see identical
behavior without the flag; CLI client-side budget is the
complement to M6.7 server-side multi-replica enforcement,
not a duplicate; operators can run bounded interactive
sessions or batch loops with budget guard rails), ADR-0140
covers Phase 2 M6.7.y (PostgresLatencyTracker + LatencyTracker
contract async-ification — LatencyTracker interface becomes
async — both record() and stats() return Promises; internal-
only breaking change since only the router calls record (two
new awaits) plus InMemoryLatencyTracker upgraded mechanically;
fire-and-forget alternative rejected for silent-failure +
unbounded-queue concerns + contract-inconsistency with
already-async CostTracker; 1ms PG INSERT overhead per LLM
request is negligible vs LLM call duration;
META_LLM_LATENCY_SAMPLES as 123rd meta-schema table —
append-only sample log with composite (provider_id,
recorded_at) index, latency_ms >= 0 CHECK, NO tenant scoping
(provider-level observability not per-tenant) NO RLS
(platform-wide same pattern as META_TENANTS);
PostgresLatencyTracker.record = single INSERT,
.stats = single windowed SELECT with CTE LIMIT N then PG
native percentile_cont aggregate — microseconds even at
millions of rows via index-only scans; continuous
percentile_cont interpolation differs from in-memory's
floor-index only at tiny window sizes (nil at window>=20);
operators can answer "anthropic p95 last hour?" with a
single SELECT; future Q1 retention policy, Q2 per-tenant
extension via additive ALTER TABLE), ADR-0141 covers Phase
2 M6.7.z (RouterInstrumentation + META_LLM_CALL_TRACES +
PostgresRouterInstrumentation — closes ADR-0135 Q2 +
ADR-0137 Q3+Q4 + ADR-0140 Q3 in one milestone; pattern
parity with M8 WorkflowInstrumentation — same onEvent
signature, same captureX/combineXs helpers, same NoopX
default — no behavior change for existing callers; three
event kinds llm_call_started + llm_call_completed +
llm_call_failed; per-attempt granularity (N attempts = 2N
events); willFallback derived from remaining choice index
so terminal short-circuits from ADR-0091/0133/0134 show
willFallback=false; META_LLM_CALL_TRACES as 124th meta-
schema table — audit-optimized (full event context: tenant,
session, task, model, costUsd, tokens, errors) +
tenant-scoped with RLS + 3 indexes serving canonical
operator queries (tenant-recent + provider-failures +
session-audit); distinct from LATENCY_SAMPLES on purpose —
different read patterns (aggregation vs audit) deserve
different schemas; PostgresRouterInstrumentation single-
INSERT-per-event mirroring PostgresWorkflowInstrumentation
verbatim; ai-router-pg adapter set now at 4 substrates —
cost-windows + cost-ceilings + latency-samples + call-
traces — router is fully observable; storage ~200 bytes/row;
embed-path instrumentation + correlationId field + ceiling-
resolution traces all listed as additive future Qs),
ADR-0142 covers Phase 2 M2.X.5.aa.z.23 (Bedrock
createInferenceProfile APPLICATION-only via copyFrom —
closes ADR-0138 Q3; 2nd CREATE on the Bedrock control plane
after createBatch (ADR-0108) and createModelCustomizationJob
(ADR-0131); completes the full APPLICATION-inference-profile
lifecycle on the substrate — create + list + get + delete;
AWS contract preserved with required inferenceProfileName +
modelSource.copyFrom and optional description +
clientRequestToken + tags; pure boundary validation enforces
8 documented constraints (name length+pattern, copyFrom
length, description length+pattern, clientRequestToken
length+pattern, tags count, tag key+value lengths) BEFORE
fetch; modelSource is a structured object so future AWS
expansion (hypothetical routingConfig) is an additive type
extension; NO pre-flight guard needed unlike delete (AWS
only creates APPLICATION via this endpoint, no SYSTEM
ambiguity); response is minimal — `{inferenceProfileArn,
status}` — operators wanting full detail call getInferenceProfile
next; clientRequestToken hooks AWS's idempotency contract;
symmetric error propagation 404/409/403/429; Bedrock control
plane now has 18 read + 2 stop + 2 create + 4 delete = 26
operations), ADR-0148 covers Phase 2 M2.X.5.aa.z.27 (Bedrock
createProvisionedModelThroughput — closes ADR-0147 Q1; the
FIRST mutation on PT resources; clientRequestToken REQUIRED
in the substrate input type even though AWS docs make it
optional — contract upgrade asymmetric from the other CREATE
endpoints which keep it optional because PT cost weight is
100×-1000× higher (one-month committed PT ~$5K/month, six-
month committed ~$30K non-cancellable, on-demand ~$100/hour);
mandatory-token rule forces deliberate operator gesture
before AWS call — trivial for intentional creates (one-line
crypto.randomUUID()) prohibitive for casual ones (typescript
error if omitted); naturally retry-safe — operators store
token alongside intent and reuse on failure with AWS dedupe
server-side; no auto-token generation (defeats idempotency),
no substrate-side local dedup (trust AWS), no commitment
auto-default (operators must explicitly choose); pure
boundary validation across 6 documented constraints; modelUnits
substrate cap at 1000 defensive on top of AWS quota — operators
wanting more file a separate substrate change; tags work
cross-resource with M2.X.5.aa.z.24 post-creation; minimal
response (provisionedModelArn only) — operators wanting full
detail call getProvisionedModelThroughput next; no dryRun /
no status-polling — substrate is raw transport, polling
belongs in operator code; Bedrock control plane now has 20
read + 2 stop + 3 create + 4 delete + 3 tag + 1 update = 33
operations; PT mutation half-done — create shipped, update +
delete pair-able more easily now that safety pattern is
established).
ADR-0147 covers Phase 2 M2.X.5.aa.z.26 (Bedrock
provisioned-throughput inspection — getProvisionedModelThroughput
+ listProvisionedModelThroughputs read-only surfaces; PTs are
paid dedicated capacity (one-month ~$5K, six-month committed)
backing foundation or custom models; substrate previously had
zero PT visibility — cost dashboards couldn't project monthly
commitments, reconciliation couldn't find orphaned PTs leaking
$5K-$50K/month after custom-model decommissioning, incident
response dropped to AWS Console; this milestone closes those
gaps; mutation (create/update/delete) deliberately deferred —
PT cost per operation is 100×-1000× higher than inference
profiles needing careful idempotency + cost-confirmation
design; new provisioned-throughput-api.ts with types +
builders + parsers; AWS contract preserved verbatim with 4
statuses + 2 commitment durations + path-based URI mirroring
inference-profiles; THREE-ARN distinction surfaces clearly —
modelArn (current backing model) vs desiredModelArn (target
after pending update) vs foundationModelArn (foundation
behind any custom variants) — operators distinguish mid-
migration (modelArn !== desiredModelArn) from steady state;
detail extends summary with optional failureMessage (only
present when status === Failed) for incident-response
context; list filters across 8 dimensions (statusEquals,
modelArnEquals, nameContains, sortBy, sortOrder, maxResults,
nextToken); pure boundary validation pre-fetch; integer
validation on modelUnits guards against floating-point JSON
quirks; unknown-status surfaces as api_error so undocumented
AWS additions fail loudly; no new transport — reuses
signedControlPlaneGet; Bedrock control plane now has 20 read
+ 2 stop + 2 create + 4 delete + 3 tag + 1 update = 32
operations).
ADR-0146 covers Phase 2 M2.X.5.aa.z.25 (Bedrock
updateInferenceProfile PATCH with APPLICATION-only guard —
closes ADR-0142 Q1; first PATCH operation on the Bedrock
control plane; new signedControlPlanePatch transport mirrors
signedControlPlanePost with content-type application/json +
Sig v4 signing; updateInferenceProfile uses 4-step defensive
validation order — identifier-blank → input body builder
rejecting empty-input → pre-flight GET to read type field →
APPLICATION-only guard (NEVER issues PATCH on SYSTEM_DEFINED;
mirrors deleteInferenceProfile from ADR-0138); description-
only by design — tags have their own M2.X.5.aa.z.24 canonical
surface and wiring them here would create two paths to the
same outcome confusing operators; PATCH semantics not PUT —
only provided fields update; pre-flight cost 1 extra GET per
update acceptable for operator-workflow not hot-path; race
window between GET and PATCH propagates the PATCH-side 404
verbatim — same idempotency-via-isNotFoundError pattern as
delete; pattern reusable for future mutation surfaces;
operator gain: description drift on existing APPLICATION
profiles is now fixable in-place without delete-recreate
destroying the ARN and breaking downstream references; Bedrock
control plane now has 18 read + 2 stop + 2 create + 4 delete
+ 3 tag + 1 update = 30 operations; FULL APPLICATION
lifecycle on the substrate). ADR-0145 covers Phase 2
M2.X.5.aa.z.24 (Bedrock cross-
resource tagging — closes ADR-0142 Q2; first multi-resource
operations on the Bedrock substrate — tagResource +
untagResource + listTagsForResource work across every
Bedrock ARN with no URI templating per resource type; AWS
wire-shape asymmetry preserved verbatim — TagResource +
UntagResource carry resourceARN in the QUERY string while
ListTagsForResource carries resourceARN in the BODY (with
uppercase ARN per AWS docs); signedControlPlanePost extended
additively with optional query strings — existing callers
unaffected; pure boundary validation enforces 7 documented
constraints (resourceArn length+prefix, tag/tagKey count
[1, 200], tag key length+pattern, tag value length+pattern
where empty value is VALID per AWS contract); error messages
include the index of the bad tag entry for crisp debugging
on 200-tag batches; BedrockTag is the canonical cross-resource
shape with existing per-resource tag types preserved for self-
documenting CREATE method signatures; pattern set for future
cross-resource operations; Bedrock control plane now has 18
read + 2 stop + 2 create + 4 delete + 3 tag = 29 operations).
ADR-0144 covers Phase 2 M6.8 (META_LLM_COST_TIERS + per-
tenant tier memberships — closes ADR-0137 Q2; two new
meta-schema tables 126th+127th; META_LLM_COST_TIERS is
platform-wide no-RLS with tier_id PK (slug pattern
^[a-z0-9][a-z0-9_-]{0,63}$) + display_name + nullable
policy columns same M6.7.x NULL=unbounded semantics;
META_LLM_TENANT_TIER_MEMBERSHIPS is tenant-scoped RLS-
enabled with tenant_id PK (one tier per tenant — multi-
tier ambiguity blocked schema-side) + tier_id FK with
ON DELETE RESTRICT (forces deliberate migration on tier
deletion; CASCADE rejected as silent-strip footgun);
PostgresCostCeilingResolver extended with three-level
fallback per-tenant override → tier → global; each level
wins as whole-object preserving M6.7.x semantics; field-
merge alternative rejected because it would break NULL=
unbounded meaning; two PG round-trips worst case (no per-
tenant + no tier), one best case (per-tenant exists tier
skipped); JOIN-in-one-query alternative rejected for
forcing field-merge or cluttering SELECT with CASE WHEN
per column; operator workflow: define tiers once via INSERT
into llm_cost_tiers, link tenants via memberships, adjust
tier-wide policy via single UPDATE on tier row that takes
effect next request for every member; per-tenant overrides
remain via existing META_LLM_COST_CEILINGS taking precedence
over tier; future Qs cover resolution-source reporting,
effective-from history, non-cost tier policy bundles).
ADR-0143 covers Phase 2 M6.7.zz
(META_RETENTION_POLICIES + PostgresTraceRetention cross-
cutting retention substrate — closes ADR-0120 Q5 + ADR-0140
Q1 + ADR-0141 Q1 in one milestone; the three append-only
trace tables shipped over M8 + M6.7.y + M6.7.z now have a
unified retention story preventing unbounded growth at
~600MB/day per million LLM calls; META_RETENTION_POLICIES
as 125th meta-schema table — table_name PK with hardcoded
CHECK constraint enforcing allowlist (workflow_traces,
llm_latency_samples, llm_call_traces), retention_days CHECK
>= 1 (zero blocked since it would delete everything
immediately — disable via enabled column instead), enabled
kill switch, last_pruned_at NULLABLE audit field; platform-
wide table no tenant scoping no RLS — retention is platform-
policy concern (per-tenant retention listed as future Q);
PostgresTraceRetention adapter in `@crossengin/kernel-pg`
(most general home since it operates on meta-schema tables;
ai-router-pg would have created cross-package dependency for
workflow_traces); HARDCODED PRUNABLE_TABLES map in the
adapter prevents SQL injection (table+column names from
static map not row data) + keeps schema knowledge in code
(operators don't need to know recorded_at vs occurred_at) +
defense-in-depth via DB CHECK + adapter allowlist; prune()
is idempotent — re-runs find fewer rows; per-policy
autonomy — no outer transaction so one prune can succeed
while another fails; clock injection for testability;
adding a new trace table is a 2-edit mechanical change —
update CHECK constraint + add PRUNABLE_TABLES entry; per-
policy result returned with status enum (pruned /
skipped_disabled / skipped_unknown_table) + deletedCount +
cutoffMs; the three trace substrates are now operationally
sustainable).
When you ship a new package, write the matching ADR in the same
session, following `0000-template.md` and the style of the
existing 0026-0037 batch.
