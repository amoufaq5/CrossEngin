# ADR-0280: Running the model on the same box (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-26 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0264 (Docker-Compose VM deploy), ADR-0263 (`--openai-base-url`), ADR-0267 (AI onboarding) |

## Context

ADR-0263 added a base-URL override so `operate-server` could point its OpenAI-compatible client at
a self-hosted model instead of OpenAI, and ADR-0264's compose file runs Postgres, the API, the UI
and TLS on one VM. Together those were supposed to make "everything on our own box, including the
model" possible. **Neither half actually worked.**

## What was broken

Wiring it up end to end surfaced a bug that no unit test could have caught, because each piece was
correct in isolation: `OpenAiProvider` gated **every** model id against OpenAI's own catalogue,
regardless of `baseUrl`. The constructor threw on an unlisted `defaultModel`, `resolveModel`
rejected one, and `computeUsageCost` indexed `OPENAI_PRICING[model]` and would have thrown a
`TypeError`. `buildDesignProviderFromEnv` compounded it by silently rewriting an unlisted
`--ai-model` to `gpt-4o`.

So you could point the client at Ollama and then only ask it for models Ollama does not serve. Live,
that is `provider error: model 'gpt-4o' not found` — the failure every self-hosted deployment would
have hit on its first request.

## Decision

- **The OpenAI catalogue describes `api.openai.com`.** When the caller sets a different base URL it
  is no longer authoritative and must not gate anything. That single rule fixes the constructor,
  both model resolvers, and the design-provider factory. It holds equally for a genuinely different
  engine (Ollama serving `qwen2.5:14b-instruct`) and for a proxy in front of OpenAI (OpenRouter,
  LiteLLM, Azure), which is why it is the right rule rather than an Ollama special case.
- **Cost computation becomes total, returning 0 for an unknown model.** Zero is the honest answer: a
  self-hosted model has no per-token vendor cost, and stamping OpenAI's list price onto someone
  else's endpoint would put a wrong number in a cost ledger. It does not throw and does not guess.
- **Compose overlays rather than a profile.** `docker-compose.ai.yml` adds an `ollama` service (never
  published — reachable only by the API over the compose network) and a one-shot `ai-pull` that
  fetches the model into a named volume before the API starts, mirroring how `migrate` gates the API
  today. `docker-compose.ai-gpu.yml` layers the GPU reservation on top, so the CPU and GPU paths
  differ by one `-f`. Overlays were chosen over profiles because the AI path must also **override
  the `api` command** to add `--ai-design`, which a profile cannot do.
- **The base file stays AI-free.** Running without the overlay contacts no model at all.

## Consequences

- **Verified live** against a stub that behaves like Ollama — serving exactly one model and 404ing
  anything else: with `--ai-model qwen2.5:14b-instruct` the server asked for
  `qwen2.5:14b-instruct`, designed a manifest and stored the proposal as
  `openai/qwen2.5:14b-instruct`; **without** it, the same server asked for `gpt-4o` and got
  `model 'gpt-4o' not found`, reproducing the bug this ADR fixes. All three compose permutations
  validate via `docker compose config`, and the base file contains no AI wiring.
- Cost-zero for an unlisted model is covered by unit tests (a streamed `usage_final` with
  `cost === 0`); it is **not** live-verified here, because the cost ledger only records when a
  per-tenant budget is configured.
- Behaviour against OpenAI's own base URL is unchanged — every touched branch short-circuits to the
  original path, and the pre-existing provider tests pass unmodified.
- `deploy/README.md` gains the hosting guidance this exercise produced: the long-running-process
  constraint that rules out serverless for the API (the schedulers would never fire), a provider
  comparison, and the recommendation to take managed Postgres earlier than feels necessary since the
  `dr` package's RPO/RTO targets are aspirational without backups.
- `deploy/.env.example` now documents the api-key's 4th field, which ADR-0278 made load-bearing — a
  key without a user id gets an empty notification inbox.
- +33 tests (ai-providers-openai **80**; operate-server **63 files / 1577**). Full workspace build +
  typecheck + test green.
- Follow-up: nothing pins the model's *quality* — a small model that drifts out of JSON fails
  manifest validation, which the README warns about but the code does not detect and report
  distinctly from any other design failure.
