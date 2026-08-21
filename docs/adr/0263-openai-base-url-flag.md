# ADR-0263: `--openai-base-url` — point the OpenAI provider at any compatible endpoint (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0064 (`ai-providers-openai`), ADR-0072 (multi-vendor router in chat), ADR-0077 (Phase 4) |

## Context

`crossengin chat` can already run against a self-hosted OSS model via `--provider local`
(the `@crossengin/ai-providers-local` `LocalLlmProvider` — zero pricing, arbitrary model
names, its base URL *includes* the `/v1` segment). But the real `OpenAiProvider` — the one
that carries OpenAI model names + pricing and participates in the `auto` router's
Anthropic→OpenAI fallback — was hard-pinned to `https://api.openai.com`. Its constructor
already accepts a `baseUrl` (ADR-0064), yet the CLI exposed no way to set it, so an
operator could not point the *OpenAI-format* path at Azure OpenAI, an internal
gateway/proxy, or an OpenAI-compatible OSS server (Ollama, vLLM, LocalAI) they want treated
as `openai`.

## Decision

- **`OpenAiProvider.endpoint` (ai-providers-openai)** — a public read-only getter returning
  the effective host (`this.baseUrl`, default `https://api.openai.com`; the `/v1/...` path is
  appended per request). Purely additive observability seam — nothing else changes.
- **`--openai-base-url <url>` + `OPENAI_BASE_URL` (architect-cli)** — `buildChatProvider`'s
  opts gain `openaiBaseUrl?`; the shared `makeOpenai()` closure passes `baseUrl` to every
  `OpenAiProvider` it mints (single `--provider openai` **and** the `auto` router's OpenAI
  leg) when the flag or env is a non-empty string. Precedence: `--openai-base-url` flag >
  `OPENAI_BASE_URL` env > default. An empty value is ignored (keeps the default host). The
  override is the host **without** `/v1` (e.g. `http://localhost:11434`), matching the
  provider's `<baseUrl>/v1/chat/completions` convention — deliberately different from
  `--local-url`, which includes `/v1`.

## Consequences

- The Architect runs fully offline against a self-hosted OSS model on the OpenAI path:
  `crossengin chat --provider openai --openai-base-url http://localhost:11434 --openai-model gpt-4o`
  (`OPENAI_API_KEY` still required — a dummy token satisfies the constructor; most OSS
  servers ignore it). The same override reaches Azure OpenAI or a corporate gateway.
- Two OSS routes now coexist by intent: `--provider local` (dedicated zero-cost provider,
  arbitrary model names) and `--provider openai --openai-base-url` (real OpenAI provider +
  pricing + router fallback participation, pointed elsewhere). The `auto` router's OpenAI
  fallback honours the override too, since both legs share `makeOpenai()`.
- App + provider-getter only; no META tables, no schema-count change, no runtime LLM added
  to the served platform (`operate-server`/`operate-web` still call no model). +6
  architect-cli tests (default host, flag override, env override, flag>env precedence,
  empty-ignored) and +2 ai-providers-openai tests (`endpoint` default + custom). Full build +
  typecheck + workspace tests green.
- Follow-up (open): expose `--organization`/`--project` and a residency override for the
  OpenAI provider; a `--openai-embedding-model` flag for the router's embedding task.
