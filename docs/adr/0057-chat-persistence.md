# ADR-0057: Chat persistence to META_ARCHITECT_* (Phase 2 M5.7)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0056 (write tools), ADR-0055 (tool-driven chat), ADR-0054 (chat mode), ADR-0035 (audit + forensics) |

## Context

M5.5 + M5.6 + M5.8 closed the developer-facing authoring loop: chat against Claude, dispatch read tools, propose writes with human approval. What's missing is the **paper trail**. When a developer says "Claude approved a manifest change yesterday", today there's no record of it. The chat output is on the developer's terminal; once the session ends, the transcript is gone. For a production-grade tool — especially one that can write to disk — this is unacceptable.

Three constraints shaped the design:

1. **Audit-quality persistence.** Operators need to answer "who proposed what, when, and was it applied?" That requires structured records: sessions, per-turn messages, tool invocations with input/output, and proposals with decisions. Joining these supports questions like "show me every proposal denied this week" or "list all writes to `/etc/...`".

2. **Persistence is opt-in.** Local development doesn't need a Postgres — that's overhead for the common case. Persistence activates only with `--persist`. Without it, the CLI behaves exactly as M5.8 left it. Tests don't need a live database; an in-memory transcript stub suffices for offline CI.

3. **The chat engine stays stateless.** The chat code shouldn't know SQL. It emits lifecycle events (`onSessionStart`, `onMessage`, `onToolInvocation`, `onProposal`, `onSessionEnd`) into an abstract `Transcript` interface; the Postgres implementation owns the SQL. This keeps the chat code testable and lets the same lifecycle events flow into a future web-UI transcript (e.g., websocket-streamed to a dashboard).

## Decision

Four changes across four packages:

### 1 — `kernel`: four new meta-schema tables

Added to `packages/kernel/src/bootstrap/meta-schema.ts` (table count 115 → 119):

- **`META_ARCHITECT_SESSIONS`** — one row per chat session. Columns: `id` (UUID), `tenant_id` (UUID, FK), `session_id` (TEXT, unique within tenant via compound constraint), `model`, `system_prompt_sha256`, `started_at`, `ended_at?`, `turn_count`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `cost_usd`. RLS on. The `(tenant_id, session_id)` unique constraint means a developer can keep using the same human-readable session id across runs without colliding with another tenant's id.

- **`META_ARCHITECT_MESSAGES`** — one row per message in a turn. Columns: `id`, `tenant_id`, `session_id` (FK → architect_sessions.id), `turn_index`, `message_index`, `role` (`system`/`user`/`assistant`/`tool`, check constraint), `content`, `tool_call_id?`, `tool_uses?` (JSONB), `input_tokens?`, `output_tokens?`, `cached_input_tokens?`, `cost_usd?`, `created_at`. Composite index `(session_id, turn_index, message_index)` for ordered playback. RLS on.

- **`META_ARCHITECT_TOOL_INVOCATIONS`** — one row per tool call. Columns: `id`, `tenant_id`, `session_id` (FK), `message_id?` (FK → architect_messages.id; nullable because tool invocations can predate persisting the assistant message in some flows), `tool_call_id`, `tool_name`, `input` (JSONB), `output` (TEXT), `is_error`, `duration_ms?`, `started_at`. Index on `(session_id, started_at)` + `tool_name`. RLS on.

- **`META_ARCHITECT_PROPOSALS`** — one row per `propose_manifest_edit` invocation. Columns: `id`, `tenant_id`, `session_id` (FK), `tool_invocation_id?` (FK), `target_path`, `is_new`, `old_hash?`, `new_hash` (CHAR(64) NOT NULL), `entities_added`, `entities_removed`, `entities_modified`, `decision` (one of `auto_approved` / `interactive_approved` / `interactive_denied` / `no_changes` / `invalid_manifest`), `applied`, `denial_reason?`, `proposed_at`, `decided_at?`. Indexes on `(session_id, proposed_at)`, `target_path`, `decision`. RLS on.

### 2 — `ai-architect`: record schemas

New module `packages/ai-architect/src/session-records.ts` with zod schemas:
- `ArchitectSessionRecordSchema` / `ArchitectMessageRecordSchema` / `ArchitectToolInvocationRecordSchema` / `ArchitectProposalRecordSchema`.
- `ARCHITECT_PROPOSAL_DECISIONS` enum.

Zod is the source of truth — types derive via `z.infer`. The package keeps its existing contracts-only stance; no behavior added.

### 3 — `ai-architect-pg`: new package with four stores + orchestrator

`packages/ai-architect-pg` is the seventh `*-pg` adapter package (after `kernel-pg`, `workflow-runtime-pg`, `api-gateway-pg`). Six modules:

- **`session-store.ts`** — `PostgresArchitectSessionStore.startSession(input)` returns the inserted record; `endSession(input)` UPDATEs `ended_at = now()` + aggregate totals; `getById(id)`; `listForTenant({tenantId, limit?})`.
- **`message-store.ts`** — `append(input)` INSERTs one message; `listForSession(sessionId)` returns ordered messages. JSONB serialization of `toolUses` with safe parse on read-back (handles both object and string forms Postgres returns).
- **`tool-invocation-store.ts`** — `append(input)` INSERTs one tool call; `listForSession(sessionId)`.
- **`proposal-store.ts`** — `append(input)` INSERTs one proposal with `decided_at = now()`; `listForSession(sessionId)`.
- **`transcript.ts`** — `Transcript` interface (5 lifecycle methods) + `PostgresTranscript` class that wraps all four stores. Threads the session UUID + tenant id captured at `onSessionStart` into subsequent calls so callers don't have to pass them every time.
- **`index.ts`** — re-exports.

23 tests covering insert / list / round-trip paths using the mock-PgConnection pattern from existing `*-pg` packages.

### 4 — `architect-cli`: wiring

- **`chat.ts`** adds:
  - `Transcript` re-export from `@crossengin/ai-architect-pg`.
  - `NullTranscript` — a no-op transcript with dummy record returns. Default when persistence isn't requested; lets the chat engine call lifecycle methods unconditionally without null checks.
  - `systemPromptSha256(text)` — `node:crypto` sha256 hex, used for `onSessionStart`.
  - `ChatExchangeOptions.transcript?` + `turnIndex?` + `autoApprove?` so the per-message function can emit events at the right offsets.
  - `ChatReplOptions.transcript?` + `autoApprove?`.
  - `runChatRepl` calls `onSessionStart` before the first exchange and `onSessionEnd` after the last (passing the aggregate totals). The system-prompt hash is computed once and passed through.
  - `runChatExchange` emits, in order: `onMessage(user)`, `onMessage(assistant)` (with `toolUses` if present + per-turn token counts), then per tool call: `onToolInvocation` → `onMessage(tool)` → optional `onProposal` (only when `tool_name === "propose_manifest_edit"` and the result wasn't an error), then `onMessage(assistant)` for the continuation. The `messageIndex` increments across the exchange so playback is ordered.
  - `emitProposal` parses the `propose_manifest_edit` output JSON for `path` / `hash` / `is_new` / `diff_summary` / `applied` / `reason`. Maps to `decision` via `decideProposal`: `invalid_manifest` / `no_changes` short-circuit out; otherwise `applied: true && autoApprove` → `auto_approved`, `applied: true && !autoApprove` → `interactive_approved`, `applied: false` → `interactive_denied`.

- **`commands.ts`** adds:
  - `--persist` flag.
  - `RunContext.transcriptOverride?` for tests.
  - When `--persist` is set and no override is supplied: construct a `PgConnection` via `parsePgEnvConfig(ctx.env) → createNodePgConnection(config)`, wrap in `PostgresTranscript`. On parse-config failure → exit 1 with friendly error.
  - `finally` block closes the `PgConnection` even on error paths.

## Cross-cutting invariants enforced

- **Tenant isolation everywhere.** All four tables have RLS enabled with the standard `tenant_id = current_setting('app.current_tenant_id', true)::UUID` policy. Cross-tenant reads are impossible without bypassing the role.
- **FK chain is acyclic.** Sessions → Messages → Tool invocations + Proposals. Messages can reference Sessions only. Tool invocations can reference Sessions + Messages. Proposals can reference Sessions + Tool invocations. The order matches the META_TABLES insertion order so DDL emit succeeds.
- **`session_id` uniqueness per tenant, not globally.** Compound unique `(tenant_id, session_id)` so developers can use any human-readable id without coordinating across tenants. The internal UUID `id` is what other tables FK against.
- **Cost / token counts use the same precision the provider uses.** `cost_usd` is `NUMERIC(12, 6)` (6 decimals, matching `computeUsageCost`'s rounding). Token counts are `INTEGER` with `>= 0` check constraints.
- **Persistence never blocks chat semantics.** Every transcript method returns a record; the `NullTranscript` returns dummy records so the chat code can read message ids unconditionally. No `if (transcript === undefined)` branches in the per-message hot path — the engine just checks once and skips the block when there's nothing to emit.
- **Proposal decisions cover the 5 outcomes.** `auto_approved` (auto-approve flag + applied), `interactive_approved` (user said y + applied), `interactive_denied` (user said n or auto-deny), `no_changes` (hash match short-circuit), `invalid_manifest` (schema failure). Same five outcomes M5.8's tool already produces, so the persistence layer carries no new policy.
- **PG connection always closes.** `runChat`'s `finally` block closes the connection even if the chat throws. Best-effort `.catch(() => {})` because errors during shutdown shouldn't override the original error.

## Alternatives considered

- **Add transcript columns to `META_AI_CONVERSATIONS`.**
  - **Considered.** That table already exists with `total_input_tokens` / `total_output_tokens` / `total_cost_usd` and a `session_id`.
  - **Decision.** Separate tables. `META_AI_CONVERSATIONS` requires a `user_id` FK (a real authenticated user). The CLI is a dev-tool with no authenticated user. Mixing dev-local sessions with platform-level conversations would muddy the existing audit story. Architect sessions are also more granular (per-message detail, tool invocations, proposals) — squashing all that into the conversation row would be ugly.

- **Put the Postgres adapter inside `ai-architect`.**
  - **Considered.** One package, no new directory.
  - **Decision.** Workspace convention: contracts in `X`, Postgres adapter in `X-pg`. `kernel` + `kernel-pg`, `workflow-runtime` + `workflow-runtime-pg`, `api-gateway` + `api-gateway-pg`. Following the pattern keeps `ai-architect` pure-zod (consumable without `pg` as a transitive dep) and lets `ai-architect-pg` evolve independently.

- **JSON-Lines log file as the default transcript.**
  - **Considered.** `~/.crossengin/sessions/<id>.jsonl`.
  - **Decision.** Operators redirect stdout if they want a file (`crossengin chat --format=json > trace.jsonl` already works in M5.5). Postgres is the proper audit substrate — joinable, queryable, RLS-protected. File-based transcripts don't survive multi-developer / multi-machine scenarios; Postgres does.

- **Emit transcript events synchronously vs fire-and-forget.**
  - **Considered.** Run `transcript.on*` calls in the background without awaiting.
  - **Decision.** Await every call. A dropped event means a gap in the audit log, which defeats the point. The latency cost is one round-trip to local Postgres per message — negligible in a developer chat session. If production-scale chat needs lower latency, M5.7+ can add a batched-write transcript.

- **Persist the full tool output unredacted.**
  - **Considered.** Worry that `read_file` could return secrets, then the secret lives in `architect_tool_invocations.output`.
  - **Decision.** Out of scope for M5.7 — the developer is reading their own filesystem at their own risk. M6+ can layer a redaction pass over outputs before persistence (per-tool sanitizer), reusing the redaction patterns in `@crossengin/observability`.

- **Make `--persist` the default.**
  - **Considered.** Always persist; users opt out with `--no-persist`.
  - **Decision.** Persistence requires a Postgres + PG env vars. Defaulting to it would make the CLI fail-out-of-the-box for any developer without the database set up. Opt-in is right for a dev tool.

- **Use `messages.created_at` for ordering instead of `turn_index` + `message_index`.**
  - **Considered.** Avoid the extra columns.
  - **Decision.** `created_at` resolution is microseconds; two messages inserted in the same millisecond would tie. Explicit integer indices give deterministic ordering for tests + replays.

## Consequences

- **49 packages + 1 app, 119 meta-schema tables, 5,671 tests** (was 48 / 115 / 5,625; +1 package, +4 tables, +46 tests).
- **`@crossengin/ai-architect-pg` joins the impure-package roster.** Now four runtime adapters: `kernel-pg` (DDL), `workflow-runtime-pg` (workflows), `api-gateway-pg` (gateway), `ai-architect-pg` (chat). Each follows the same shape: PgConnection-based stores + a top-level orchestrator + replayer or transcript.
- **Operators can audit chat sessions.** Queries like `SELECT * FROM meta.architect_proposals WHERE decision = 'interactive_approved' AND tenant_id = '...'` answer the audit questions M5.8 introduced but couldn't answer. `JOIN architect_messages ON session_id` reconstructs the conversation context for any proposal.
- **Pattern set for future chat consumers.** A web-UI chat (Phase 3) implements its own `Transcript` (websocket-streamed to a dashboard, or pushed to a per-user PubSub) without re-implementing the chat engine.
- **No regression for offline use.** All 137 existing chat tests still pass. The new persistence wiring is strictly additive — pass `transcript: undefined` (default) or `NullTranscript`, and the chat engine behaves identically to M5.8.
- **PG connection lifecycle is owned at the command boundary.** `runChat` opens + closes the connection in a `try/finally` pair. The chat engine never sees the raw connection. This means a long-running future API server can reuse one PgConnection across many chat sessions just by passing a shared `transcript` (which internally holds the connection).

## Open questions

- **Q1:** Should the CLI emit a `transcript_url` field in the JSON summary at session end, pointing to where the session lives in Postgres?
  - _Current direction:_ Not in M5.7. The session UUID is logged in the `architect_sessions` table; operators query by tenant + session_id. M5.9 (chat dashboard) can surface a clickable URL when a UI lands.
- **Q2:** What happens when persistence is enabled but a write fails mid-session?
  - _Current direction:_ The PG error propagates up and the CLI exits 1. The chat session aborts. A more resilient design would catch transcript errors and continue with `NullTranscript` for the rest of the session — but that hides operational problems and is the wrong default. Operators should know when their audit log is broken.
- **Q3:** Should `architect_tool_invocations.input` truncate huge inputs (e.g., a developer pastes a 50 MB manifest)?
  - _Current direction:_ No truncation. JSONB handles large payloads fine. If size becomes an issue, M5.9 can add a per-column size cap with overflow stored in a separate text or blob.
- **Q4:** Does this need a complementary `crossengin sessions list / show` subcommand?
  - _Current direction:_ Out of scope for M5.7. The substrate is ready; the read-side CLI subcommand can land in M5.9 alongside the chat dashboard.
- **Q5:** Should we add an `architect_sessions.user_id` so individual developers' sessions are attributable when multi-user scenarios arrive?
  - _Current direction:_ Defer. Today the CLI is a dev tool with no auth. When SSO-protected chat ships (Phase 3 web UI), add `principal_id` + index, with a migration.
