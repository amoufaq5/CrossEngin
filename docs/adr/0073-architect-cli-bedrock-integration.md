# ADR-0073: Architect CLI Bedrock integration (Phase 2 M6.5.6)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-18 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0061 (M6.5.5 router integration), ADR-0071 (Bedrock provider), ADR-0072 (Bedrock embeddings) |

## Context

M2.9 + M2.9.5 shipped `@crossengin/ai-providers-bedrock` — the third concrete `LlmProvider` with chat + embeddings. M6.5.5 wired Anthropic + OpenAI into `architect-cli`'s `chat` subcommand via env-var detection (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). The Bedrock provider was complete but never visible to the CLI — a developer running `crossengin chat` against AWS credentials saw `NoProvidersConfiguredError`. M6.5.6 closes the loop.

Two things have to be true after this change:

1. **`crossengin chat` works against AWS credentials alone.** A tenant with strict residency keeping everything inside AWS sets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ optionally `AWS_SESSION_TOKEN` for STS / `AWS_REGION` for residency) and the CLI builds a single Bedrock provider, defaulting to `anthropic.claude-3-5-sonnet-20241022-v2:0`.
2. **The router's default task policies have a Bedrock fallback for every task.** When all three providers are configured (Anthropic + OpenAI + AWS), the fallback chain is three deep — if Anthropic's primary API degrades, the router tries OpenAI's equivalent, then Bedrock's equivalent. Real failover diversity across three independent control planes.

## Decision

Three additive changes to `apps/architect-cli/src/router-setup.ts` + one to `package.json` + one to `cli.ts` help text.

### Env-var detection

```ts
const awsAccessKey = input.env["AWS_ACCESS_KEY_ID"];
const awsSecretKey = input.env["AWS_SECRET_ACCESS_KEY"];
if (awsAccessKey && awsSecretKey) {
  const sessionToken = input.env["AWS_SESSION_TOKEN"];
  const region = input.env["AWS_REGION"] ?? input.env["AWS_DEFAULT_REGION"];
  providers.set("bedrock", new BedrockProvider({
    accessKeyId: awsAccessKey,
    secretAccessKey: awsSecretKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(region ? { region } : {}),
    defaultModel: resolveBedrockDefault(input.forceModel),
  }));
}
```

Both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` must be present — a half-configured AWS env triggers `NoProvidersConfiguredError` if no other provider is set. Optional fields are threaded only when set (no empty-string defaults sneaking into the provider).

`AWS_REGION` falls back to `AWS_DEFAULT_REGION` (matches the AWS SDK convention). When neither is set, the `BedrockProvider` constructor's `us-east-1` default applies.

### `DEFAULT_TASK_POLICIES` extension

Every task gets a Bedrock model appended to its `fallback` array:

| Task | Primary | Fallback chain |
|---|---|---|
| `planner` | `anthropic/claude-opus-4-7` | `claude-sonnet-4-6` → `openai/gpt-4o` → `bedrock/anthropic.claude-opus-4-20250514-v1:0` |
| `executor` | `anthropic/claude-sonnet-4-6` | `openai/gpt-4o-mini` → `bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `summarizer` | `openai/gpt-4o-mini` | `anthropic/claude-haiku-4-5` → `bedrock/anthropic.claude-3-5-haiku-20241022-v1:0` |
| `diff-narrator` | `anthropic/claude-haiku-4-5` | `openai/gpt-4o-mini` → `bedrock/anthropic.claude-3-5-haiku-20241022-v1:0` |
| `embedding` | `openai/text-embedding-3-small` | `bedrock/amazon.titan-embed-text-v2:0` |
| `rerank` | `anthropic/claude-haiku-4-5` | `openai/gpt-4o-mini` → `bedrock/anthropic.claude-3-5-haiku-20241022-v1:0` |
| `classifier` | `openai/gpt-4o-mini` | `anthropic/claude-haiku-4-5` → `bedrock/anthropic.claude-3-5-haiku-20241022-v1:0` |

A previously empty `embedding.fallback: []` (Anthropic has no embeddings; OpenAI was the only option) now has `bedrock/amazon.titan-embed-text-v2:0` as fallback at the same $0.02/M price. Same cost, different control plane.

The `filterPoliciesByAvailable` filter from M6.5.5 already strips fallback entries whose provider isn't configured. So a tenant running with `OPENAI_API_KEY` alone sees the same single-provider behavior; the Bedrock entries silently fall away.

### `resolveBedrockDefault` helper

```ts
function resolveBedrockDefault(forceModel: string | undefined): BedrockChatModel {
  if (forceModel !== undefined && isBedrockChatModel(forceModel)) return forceModel;
  return BEDROCK_DEFAULT_MODEL;  // anthropic.claude-3-5-sonnet-20241022-v2:0
}
```

Mirror of `resolveAnthropicDefault` / `resolveOpenAIChatDefault`. A `--model anthropic.claude-3-5-haiku-20241022-v1:0` invocation against Bedrock-only env vars routes to the haiku-on-bedrock build instead of the default sonnet.

### Error message + help text

`NoProvidersConfiguredError`'s message now mentions all three providers: "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, and/or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY". Tests assert the error message contains all three names so future env-var additions surface a similar update.

`cli.ts` help text gains a third entry under the chat env section: `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (required pair), `AWS_SESSION_TOKEN` (optional STS), `AWS_REGION` (default us-east-1).

### Workspace dep

`apps/architect-cli/package.json` adds `@crossengin/ai-providers-bedrock: "workspace:*"` alongside Anthropic + OpenAI.

## Cross-cutting invariants enforced

- **Single-provider behavior preserved.** A user with only one set of credentials gets a non-router provider with no policy filtering — identical to M5.5 / M6.5.5 behavior. The router only spins up when ≥ 2 providers are configured.
- **`filterPoliciesByAvailable` handles partial configurations.** Two-provider envs (e.g., Anthropic + AWS, no OpenAI) get task policies with OpenAI entries silently stripped from the fallback chains. No errors, no model-not-found failures.
- **Bedrock-prefixed model refs are stable identifiers.** Every `bedrock/<modelId>` ref in the policy map matches a real `BedrockChatModel` or `BedrockEmbeddingModel` exported from the M2.9 / M2.9.5 packages. A typo would surface at policy-filter time as a missing provider entry — but the prefix is `bedrock` and the providers map's key is `bedrock`, so the typo would just be the model ID; the router would attempt to route to a non-existent model and fail at call time.
- **Three keys = three providers.** `availableProviders` ordering is `["anthropic", "openai", "bedrock"]` when all three are set — stable for tests that pin it.
- **No silent residency override.** When the user sets `AWS_REGION=eu-west-1`, the Bedrock provider's `residency` becomes `["eu"]` automatically. The router's `unionResidency` will combine all three providers' residencies, exposing the full set to the chat substrate.
- **Same response surface as M6.5.5.** `BuildProviderOutput.provider` is still an `LlmProvider`-shaped object. The chat REPL doesn't see a router; it sees a uniform interface. Tests using `RunContext.providerOverride` are unaffected.

## Alternatives considered

- **Promote Bedrock to be a primary in some tasks (e.g., embedding).**
  - **Pros.** Closer to "AWS-first" deployment story; cheaper-per-call than OpenAI's `text-embedding-3-large`.
  - **Cons.** Bedrock Titan v2 is the same $0.02/M as OpenAI's `text-embedding-3-small`. No cost argument either way. The router stays mechanism, not policy — operators with AWS-first preferences override `taskPolicies` themselves.
  - **Decision.** Keep current primaries. Bedrock is always fallback.

- **Use AWS SDK's standard credential resolution (env → file → SSO → IMDS).**
  - **Considered.** The AWS CLI / SDK look in `~/.aws/credentials`, `~/.aws/config`, `IMDSv2`, `assume-role-web-identity`, etc.
  - **Decision.** Env vars only for now. Adding a full credential provider chain pulls in either an AWS SDK dep (against M2.9's zero-dep choice) or a substantial credential-resolution module. M6.5.7 can layer that on later — file-based credentials are the most-requested next addition.

- **Add a `--provider bedrock` flag to force single-provider mode even with all three keys set.**
  - **Considered.** A developer might want to deliberately test Bedrock by ignoring their other keys.
  - **Decision.** Out of scope. Today they can `unset ANTHROPIC_API_KEY OPENAI_API_KEY` in their shell. A future M5.5.x could add a flag.

- **Auto-discover credentials from `~/.aws/credentials` profile file.**
  - **Considered.** Common AWS workflow.
  - **Decision.** Defer to M6.5.7. INI parsing + profile selection is non-trivial; env vars are the universal pattern.

- **Make `embedding.fallback` use `bedrock/cohere.embed-multilingual-v3` instead of Titan v2 (because multilingual is a real differentiator).**
  - **Considered.** OpenAI's small + Bedrock's Titan v2 are both English-tuned at $0.02/M. Cohere's multilingual at $0.10/M is the actual differentiator.
  - **Decision.** Default fallback to Titan v2 (same price as primary, simpler match). Operators wanting multilingual coverage override `taskPolicies` explicitly.

- **Surface the active Bedrock region in the chat session summary.**
  - **Considered.** Helpful for verifying residency.
  - **Decision.** Defer. The router's `availableProviders` already reports `["bedrock"]` when active. A future enhancement can add region details under `--format=json`.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,269 tests** (+10 from M6.5.6; was 6,259 after M2.9.5). All green, zero type errors.
- **`crossengin chat` works against AWS credentials alone.** Tenants with strict residency (HIPAA-bound healthcare in `us-east-1`, EU GDPR-bound retail in `eu-west-1`) can drive the entire Architect REPL through Bedrock without leaving their AWS account.
- **The default task policies are properly three-deep.** When all three providers are configured, every task has a 3rd-control-plane fallback. Real diversity: Anthropic outage doesn't take down summarization (falls to OpenAI), and a cross-provider outage (rare) doesn't take down embeddings either (falls to Bedrock Titan v2 at the same price).
- **Pattern set for future providers.** When the next `LlmProvider` ships (Vertex? Bedrock multimodal?), the integration is now a known 4-step recipe: env-var detection → constructor invocation → workspace dep → policy fallback entries.
- **OpenAI's M6.5.5 policy preferences are preserved.** Bedrock is always fallback, never primary in the default map. Operators can override per-tenant via the router's `taskPolicies` constructor option.
- **Help text + error message reflect the new env vars.** Users running `crossengin help` see all three credential paths documented; users running with no credentials see all three names in the error.

## Open questions

- **Q1:** Should the CLI emit a warning when only `AWS_ACCESS_KEY_ID` is set but `AWS_SECRET_ACCESS_KEY` is missing (or vice versa)?
  - _Current direction:_ Silent skip. Halfways-configured AWS env vars are a real-world misconfiguration; surfacing a hint at config time would help. M6.5.7 can add `printError` or `printInfo` calls when partial env vars are detected.
- **Q2:** Should Bedrock take precedence over OpenAI in the embedding chain when Bedrock is configured?
  - _Current direction:_ No. Same price, no inherent preference. Operators with cost concerns route via custom `taskPolicies`.
- **Q3:** What about Bedrock-specific session settings (cross-account assumed roles, VPC endpoint URLs)?
  - _Current direction:_ Future M6.5.7. Today env vars cover most simple cases; complex AWS deployments will need a config file.
- **Q4:** Should the `availableProviders` reporting include the active Bedrock model + region for debugging?
  - _Current direction:_ Maybe later — current report is `["anthropic", "openai", "bedrock"]`. Adding richer per-provider info would require changing the session summary shape. Out of M6.5.6 scope.
- **Q5:** What if a developer wants to deliberately route everything through Bedrock for one session (e.g., to validate residency)?
  - _Current direction:_ They `unset` the other env vars in their shell. A future `--provider=<id>` flag could force single-provider mode. Not in M6.5.6.
- **Q6:** Should the `--cost-ceiling-usd` flag apply uniformly across all three providers?
  - _Current direction:_ It already does — the router's `CostCeiling` is provider-agnostic, applied pre-flight. No M6.5.6 changes needed.
