# ADR-0085: Bedrock per-request guardrail override (Phase 2 M2.9.8.x)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0084 (M2.9.8 Bedrock Guardrails), ADR-0071 (M2.9 Bedrock provider) |

## Context

M2.9.8 wires AWS Bedrock Guardrails into the provider via a constructor option (`BedrockProviderOptions.guardrailConfig`). Once configured, every request from that provider instance carries the same guardrail. ADR-0084 Q3 noted the limitation: real workloads need per-request specificity.

Examples of where one-config-per-provider falls apart:

- **Mixed-sensitivity workloads.** A SaaS application serving both anonymous trial users and authenticated enterprise customers wants stricter PII redaction for the trial path. Two providers (one per guardrail) work, but tenant routing becomes complex.
- **A/B testing guardrails.** Roll out a new content policy to 10% of traffic to measure refusal rates without changing the production provider config.
- **Admin escape hatches.** Internal-only operations (security ops, compliance reviews) need to inspect raw model output without input/output filtering. A different provider instance per use case is overkill.
- **Per-tenant guardrail tiers.** Bronze tenants get the default guardrail; Gold tenants get a stricter one keyed to their compliance pack (e.g. `hipaa01`).

The pre-M2.9.8.x workaround is "construct N providers." Functional, but couples guardrail policy to provider construction, which is heavy (validates credentials, derives residency, builds signing state) and ties the chain into the router's task-policy resolution.

The design constraints:

- **Don't change the kernel `CompletionRequest` schema.** Guardrails are Bedrock-specific; adding a provider-extension field to the kernel surface is a cross-cutting commitment we shouldn't make for one provider.
- **Don't change `LlmProvider.complete()` signature.** The kernel-facing API stays stable. The router consumes `LlmProvider` uniformly across providers.
- **Validate overrides at call time.** Bad override → throw before the request flies. Same fast-fail discipline as construction-time validation.
- **Preserve backwards compat with M2.9.8.** `complete()` and `completeNonStreaming()` behave byte-identically to M2.9.8.

## Decision

Two new Bedrock-specific public methods on `BedrockProvider`:

```ts
async *completeWithGuardrail(
  req: CompletionRequest,
  guardrailOverride?: BedrockGuardrailConfig | null,
): AsyncIterable<CompletionChunk>;

async completeNonStreamingWithGuardrail(
  req: CompletionRequest,
  guardrailOverride?: BedrockGuardrailConfig | null,
): Promise<BedrockConverseResponse>;
```

The override has three semantically distinct states:

- **`undefined`** (or argument omitted) → use the provider's default `guardrailConfig`.
- **`null`** → explicitly DISABLE guardrails for this request, even if the provider has a default.
- **`BedrockGuardrailConfig`** → use this config; validated via `buildBedrockGuardrailConfig` at call time.

The existing `complete()` (kernel-facing) and `completeNonStreaming()` (Bedrock-specific) methods are unchanged — they continue to use the provider's default. The new `*WithGuardrail` siblings are siblings: same shape + body, just an extra param.

### Internal refactor

Pre-M2.9.8.x, `complete()` directly built the request and made the fetch. Post-M2.9.8.x, both `complete()` and `completeWithGuardrail` delegate to a shared private `completeInternal(req, effectiveGuardrail)`. Same pattern for non-streaming. The private internal method takes the resolved effective guardrail (provider default or override).

### Resolution helper

```ts
private resolveGuardrailOverride(
  override: BedrockGuardrailConfig | null | undefined,
): BedrockGuardrailConfig | undefined {
  if (override === null) return undefined;                  // disable
  if (override !== undefined) return buildBedrockGuardrailConfig(override);  // validate + use
  return this.guardrailConfig;                              // fall back to default
}
```

Three-state semantics in one helper. The validation in the override branch happens AT CALL TIME — bad override throws before the request goes out.

## Cross-cutting invariants enforced

- **Kernel `CompletionRequest` schema is untouched.** Provider-specific extensions stay in provider-specific methods.
- **`complete()` and `completeNonStreaming()` are byte-identical to M2.9.8.** Verified by test: when called from a provider with `guardrailConfig: {default01, DRAFT}`, both methods produce the same request body as before.
- **Override validation is fast-fail.** Bad identifier/version/trace throws synchronously (rejected promise for non-streaming) BEFORE any network activity. Verified by test: zero fetches captured.
- **`null` override explicitly DISABLES the provider default.** Verified by test: request body has no `guardrailConfig` field.
- **Override works without a provider default.** Operators can construct a provider with no guardrailConfig + pass a per-request override.
- **`buildBedrockGuardrailConfig` is called once per override.** The override is fully validated on every call; no caching that could mask a downstream config typo.

## End-to-end semantic

```ts
// Provider with default guardrail
const provider = new BedrockProvider({
  accessKeyId: "...",
  secretAccessKey: "...",
  guardrailConfig: {
    guardrailIdentifier: "default01",
    guardrailVersion: "DRAFT",
  },
});

// Default — uses {default01, DRAFT}
await provider.completeNonStreaming(req);

// Stricter guardrail for a sensitive tenant
await provider.completeNonStreamingWithGuardrail(req, {
  guardrailIdentifier: "phi12345",
  guardrailVersion: "3",
  trace: "enabled",
});

// Admin override — no guardrail at all for this request
await provider.completeNonStreamingWithGuardrail(req, null);

// Streaming with per-request override
for await (const chunk of provider.completeWithGuardrail(req, customConfig)) {
  // handle chunk
}
```

## Alternatives considered

- **Extend kernel `CompletionRequest` with a `providerExtensions` field.**
  - **Considered.** Allows per-request provider-specific config without method bifurcation.
  - **Cons.** Cross-cutting change. Defines a contract every provider would need to respect or ignore. The router would have to thread it through unchanged. Adds a generic extension point for one specific use case.
  - **Decision.** Provider-specific methods. The kernel surface stays generic.

- **Make `complete()` accept an overload `complete(req, opts?)` where `opts.guardrailConfig` works.**
  - **Considered.** Single method, optional second arg.
  - **Cons.** `complete()` is the `LlmProvider` interface method — changing its signature would either break LSP (consumers calling it with the second arg expecting standard behavior) or require updating the interface (cross-cutting).
  - **Decision.** New sibling methods. The `LlmProvider` interface is stable.

- **Add a `cloneWithGuardrail(override): BedrockProvider` factory.**
  - **Considered.** Returns a new provider instance with overridden config; caller uses it for a single request.
  - **Cons.** Provider construction is heavy (credential validation, etc.) and the lifetime question is unclear (cache? per-request? per-tenant?). Method overload is simpler.
  - **Decision.** Method overload. No new provider instances.

- **Three-state semantics via a sentinel value like `BEDROCK_NO_GUARDRAIL`.**
  - **Considered.** Avoid the `null` literal.
  - **Cons.** Sentinels are exotic; `null` is the JavaScript-idiomatic "explicit absence" marker. The three states (undefined / null / value) compose well with TypeScript's union types.
  - **Decision.** `null` for "explicitly off"; `undefined` for "use default."

- **Lazy validation — only validate the override when constructing the request body, not at the helper boundary.**
  - **Considered.** Slightly faster on hot paths.
  - **Cons.** Mixes validation timing — provider-construction config is validated at construction; per-request override would be validated later. Inconsistent. The validation is microsecond-scale; consistency wins.
  - **Decision.** Validate at the helper boundary, always.

- **Make the override a partial config that merges with the default.**
  - **Considered.** `provider.complete(req, {trace: "enabled"})` to enable tracing without restating identifier+version.
  - **Cons.** Merge semantics are subtle (deep merge? shallow? what if identifier conflicts?). Full-config override is unambiguous.
  - **Decision.** Full config override. Operators wanting partial overrides build the full config explicitly.

- **Per-request override on `embed()` and `embedMultimodal()` too.**
  - **Considered.** Symmetry across all provider methods.
  - **Cons.** Bedrock Guardrails apply to converse / converse-stream / invoke (chat path). Embeddings don't use guardrails in the AWS API today. Adding the parameter would be vestigial.
  - **Decision.** Chat-only. If AWS extends guardrails to embeddings later, this can be revisited.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,544 tests** (+7 from M2.9.8.x). All green, zero type errors.
- **ADR-0084 Q3 closed.** Per-tenant / per-task / per-A-B-cohort guardrails are now first-class without instantiating multiple providers.
- **Pattern set for future provider-specific per-request overrides.** OpenAI moderation policies, Anthropic content policies — same shape: sibling `complete*With<Thing>` method that accepts an override + null/undefined three-state semantics.
- **Internal refactor cleans up `complete()` and `completeNonStreaming()`.** Both delegate to private internals taking the effective guardrail explicitly; the duplication around the two `guardrailConfig` spread sites is gone.
- **Router integration unchanged.** The router uses `LlmProvider.complete(req)` — that path picks up provider defaults. Operators wanting per-request overrides bypass the router and call the Bedrock-specific method directly. (A router-aware override mechanism is future M6.6+.)
- **Test surface grew by 7.** All cover the three-state semantics (undefined / null / value), validation timing, and the unchanged `complete()` baseline.

## Open questions

- **Q1:** Should the router expose a way to thread per-request guardrails through the abstract `LlmProvider` interface?
  - _Current direction:_ Out of scope. The router operates on `CompletionRequest` and `LlmProvider`; provider-specific extensions live outside that boundary. Callers wanting per-request overrides do `const bedrock = router.getProvider("bedrock"); await bedrock.completeNonStreamingWithGuardrail(req, override)`.
- **Q2:** Should the chat substrate auto-derive guardrails from the active session's tenant compliance pack (hipaa → phi-guardrail, pci → pci-guardrail)?
  - _Current direction:_ Out of scope. The compliance-pack → guardrail mapping is a deployment-specific decision. Future M5.x could add a `tenantGuardrailResolver` callback that the chat substrate consults.
- **Q3:** Should `completeWithGuardrail` accept an array of guardrails (multi-guardrail stacking)?
  - _Current direction:_ AWS doesn't support multi-guardrail today. If they expand the API, this can be revisited.
- **Q4:** Trace storage to a persistence layer (forensics package, audit table)?
  - _Current direction:_ Out of scope. `BedrockGuardrailViolationError.trace` is the typed surface; operators decide what to do with it.
- **Q5:** What about a `guardrailConfig` resolver function passed to the constructor that returns the config based on the request (instead of static `BedrockGuardrailConfig`)?
  - _Current direction:_ The current method-overload pattern handles this — callers can use any logic they like to compute the override before calling `*WithGuardrail`. A resolver field would duplicate the same control flow.
- **Q6:** Should `completeWithGuardrail` log when the override differs from the provider default?
  - _Current direction:_ No automatic logging. Observability is a separate concern; future M8 observability hooks could intercept.
