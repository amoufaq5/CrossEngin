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

Phase 2 M1 + M2 + M2.5 + M2.6 + M2.7 + M2.8 + M2.8.5 + M2.9 +
M2.9.5 + M3 + M3.5 + M3.6 + M3.7 + M4 + M4.5 + M4.6 + M4.7 +
M4.7.5 + M4.7.6 + M5 + M5.5 + M5.6 + M5.7 + M5.8 + M5.9 + M6 +
M6.5 + M6.5.5 + M6.5.6 + M7 + M7-wire + M7.5 + M7.6.5 + M7.7 +
M7.8 + M7.9 landed: **55 packages + 1 app, 119 meta-schema
tables, 6,344 tests**, all green, no type errors. M4.7.6 closed
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

ADRs 0001-0075 are fully drafted in `docs/adr/` — no reserved
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
hot-reload via SIGHUP + periodic refresh).

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
  `converse` (non-streaming), and `invoke` (embeddings via Titan
  or Cohere) endpoints. 7 modules: pricing (8 chat models —
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
  completeNonStreaming + embed — embed dispatches on family,
  loops over Titan or batches Cohere). Capabilities:
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

ADRs 0001-0075 exist as markdown in `docs/adr/`. Every shipped
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
(URL-fetched JWKS + SIGHUP/periodic hot-reload). When you ship
a new package, write the matching ADR in the same session,
following `0000-template.md` and the style of the existing
0026-0037 batch.
