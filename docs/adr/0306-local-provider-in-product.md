# ADR-0306: Routing the in-product Architect through the local provider (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-01 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0280 (AI provider base URLs) |

## Context

`@crossengin/ai-providers-local` exists for self-hosted OpenAI-compatible endpoints — Ollama, vLLM, LM
Studio — with zero-cost pricing built in so cost ceilings ignore it. Only `architect-cli` depended on it.
The in-product Architect's `buildDesignProviderFromEnv` knew Anthropic and OpenAI, so the self-hosted
path ran through `ai-providers-openai` pointed at a custom base URL (ADR-0280).

That worked, and the custom-base-URL fix was needed anyway for proxies. But it had a consequence beyond
tidiness: a self-hosted model billed as though it were OpenAI. Every design turn accrued OpenAI's
per-token pricing against the tenant's AI budget, so `ArchitectGuardRuntime` refused design requests on a
budget that was never spent — the one deployment where cost should not be a constraint was the one where
it bound hardest.

## Decision

`buildDesignProviderFromEnv` resolves the local provider first, from `LOCAL_LLM_BASE_URL` or
`OLLAMA_BASE_URL` — the same variables and precedence the Architect CLI already uses, so a deployment
does not learn two conventions.

A malformed URL returns `"malformed"` and **refuses**, rather than falling through to the next provider.
Falling through would mean a typo in a self-hosted endpoint silently sends the tenant's schema design —
their entity names, their business description — to a cloud vendor. That is a data-residency event caused
by a typo, so the honest outcome is a refusal naming the bad value.

An empty string reads as unset, which is the same reading `OPENAI_BASE_URL` already gets: an empty value
in a compose file or a secret mount is far more common than a missing key.

## Alternatives considered

- **Option A: leave it on `ai-providers-openai` with a custom base URL.**
  - **Pros:** already worked; nothing to change.
  - **Cons:** a self-hosted model is priced as OpenAI, so a tenant's AI budget is consumed by tokens that
    cost nothing, and the provider label in the transcript names the wrong vendor — which matters because
    the transcript is the auditable record of who designed a tenant's schema.
  - **Why not:** the pricing is the point. `ai-providers-local` exists because zero-cost is a different
    thing from cheap.

- **Option B: fall back to a cloud provider when the local endpoint is unreachable at request time.**
  - **Pros:** a design request would still succeed during a local-model outage.
  - **Cons:** an operator who self-hosts has usually done so precisely so that prompts do not leave their
    network. Silently satisfying a request by sending it elsewhere inverts the reason the endpoint exists.
  - **Why not:** `ai-router` already has explicit, policy-driven fallback with residency filters for
    anyone who *wants* that. It should not be implicit here.

- **Option C: a new variable, e.g. `DESIGN_LOCAL_BASE_URL`.**
  - **Pros:** separates the in-product designer's endpoint from the CLI's.
  - **Cons:** two names for one endpoint, and the common case is one self-hosted model serving both.
  - **Why not:** the CLI's convention was already established and documented.

## Consequences

- **Positive:** a self-hosted deployment is correctly priced at zero, so the AI budget guard stops
  refusing work that costs nothing, and the transcript names the provider that actually served the turn.
- **Negative:** local resolution comes first, so an operator who sets both a local endpoint and a cloud
  key gets the local one. The boot log says which was chosen.
- **Neutral:** `ai-providers-openai` with a custom base URL remains the right path for an OpenAI-compatible
  *proxy*, which is what ADR-0280 was actually for.
- **Reversibility:** unsetting the variable restores the previous resolution order exactly.

## Implementation notes

- `apps/operate-server/src/ai-design.ts` — `resolveLocalBaseUrl` returning
  `absent` / `malformed` / `present`, and `DesignProviderBuild` carrying the provider, its label and the
  model so the boot log and the transcript agree on one answer.
- `DEFAULT_LOCAL_MODEL` is the model when none is named; `--ai-model` overrides it.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| A weak local model that drifts out of JSON still fails indistinguishably from any other design failure (ADR-0280), and a self-hosted model is the likeliest to be weak. | amoufaq5 | _unscheduled_ |
| Per-tenant provider selection, so one tenant's designs stay on-premises while another's use a cloud model. | amoufaq5 | _unscheduled_ |

## References

- ADR-0280 (AI provider base URLs).
- Ollama / vLLM / LM Studio OpenAI-compatible endpoints.
