# ADR-0067: CLI `sessions` subcommands (Phase 2 M5.9)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0057 (chat persistence), ADR-0054 (chat mode), ADR-0051 (architect-cli) |

## Context

M5.7 added chat persistence: every `crossengin chat --persist` session writes session / message / tool-invocation / proposal rows into META_ARCHITECT_*. The data is queryable via SQL but the CLI couldn't read it back. Operators wanting to audit which write proposals were approved, what reasoning a Claude turn produced, or how much a tenant spent on chat had to write SQL by hand.

M5.9 ships three subcommands that make the M5.7 audit data first-class in the CLI:

- **`crossengin sessions list`** — recent sessions for a tenant, table-formatted with session_id, model, started_at, turn count, USD cost, status.
- **`crossengin sessions show <id>`** — one session's complete transcript: header (tenant, model, totals), every message (turn.index, role, content, tool uses), every tool invocation (call id, name, OK/ERROR, duration, output preview), every write proposal (CREATE/UPDATE, target path, decision, applied, diff counts).
- **`crossengin sessions replay <id>`** — the same data rendered as chat-style output: `You: ...` / `Architect: ...` / `[tool result ← tu_1] ...`. Same look as the live REPL — operators reading a replay see what the developer saw during the session.

Three constraints shaped the design:

1. **Reuse the M5.7 store APIs.** The four Postgres stores already exist (`PostgresArchitectSessionStore`, `…MessageStore`, `…ToolInvocationStore`, `…ProposalStore`). One new method — `getBySessionId({tenantId, sessionId})` — was added because operators address sessions by their human-readable id (`cli-abc123`), not by the internal UUID. Everything else is direct delegation.

2. **The subcommand is one entry point, three actions.** `crossengin sessions list` and `crossengin sessions show <id>` share connection setup, tenant resolution, output formatting, and store construction. Splitting them into three top-level subcommands (`sessions-list`, `sessions-show`, `sessions-replay`) would duplicate every line. Instead, `sessions` is one subcommand that reads its first positional as the action and dispatches.

3. **Tests don't open a Postgres connection.** `SessionsContext` extends `RunContext` with an optional `storesOverride` field. Tests inject a stub of the four stores; production runs `parsePgEnvConfig` + `createNodePgConnection`. Same pattern as `--persist` chat tests use `transcriptOverride`.

## Decision

New module `apps/architect-cli/src/sessions.ts` plus minimal wiring.

### Subcommand surface

```
crossengin sessions list   [--tenant-id <uuid>] [--limit <n>] [--format json|human]
crossengin sessions show   <session-id> [--tenant-id <uuid>] [--format json|human]
crossengin sessions replay <session-id> [--tenant-id <uuid>] [--format json|human]
```

Session identifier resolution: `<session-id>` accepts either the human-readable `session_id` string (`cli-abc123`) or the internal UUID. The CLI tries UUID lookup first when the argument matches the UUID regex, then falls back to the `(tenant_id, session_id)` compound lookup.

### `runSessions(command, ctx)` flow

1. Read `command.positional[0]` as the action. Missing → exit 2 with a friendly help message. Unknown → exit 2 listing the three valid actions.
2. Resolve stores: if `ctx.storesOverride` set (test path), use it; else `parsePgEnvConfig` → `createNodePgConnection` → construct the four stores. PG env error → exit 1 with the missing-var message.
3. Dispatch on action; each handler returns its own exit code.
4. `finally` block closes the PgConnection (no-op for the override path).

### Three action handlers

**`runSessionsList`** — calls `stores.sessions.listForTenant({tenantId, limit})`. Empty result → "no sessions for tenant X" message. Otherwise → table via `formatSessionsTable` (columns: session_id / model / started_at / turns / cost_usd / status). `--format=json` emits `{tenantId, count, sessions: [...]}`.

**`runSessionsShow`** — `resolveSession()` finds the session by UUID or session_id. If missing → exit 1. Otherwise fans out three parallel queries (`messages.listForSession`, `toolInvocations.listForSession`, `proposals.listForSession`) via `Promise.all`. Renders via `formatSessionShow` with sections for header / messages / tool invocations / proposals. `--format=json` emits `{session, messages, invocations, proposals}`.

**`runSessionsReplay`** — same session resolution, but only fetches messages. Renders via `formatSessionReplay` with the chat-style line format: `You: ...`, `Architect: ...`, `[tool result ← tu_1] ...`. Includes per-assistant-turn token + cost annotations and a closing `=== Session ended: N turn(s); in=X out=Y cost=$Z ===` line.

### `getBySessionId` on the session store

```ts
async getBySessionId(input: {
  readonly tenantId: string;
  readonly sessionId: string;
}): Promise<ArchitectSessionRecord | null> {
  const result = await this.conn.query<Row>(
    `SELECT * FROM ${SCHEMA}.${TABLE} WHERE tenant_id = $1 AND session_id = $2`,
    [input.tenantId, input.sessionId],
  );
  ...
}
```

Hits the unique constraint M5.7 already declared (`architect_sessions_tenant_session_key` on `(tenant_id, session_id)`). One row max, indexed lookup.

### Three rendering helpers (exported)

- **`formatSessionsTable(records)`** — pure rendering, no I/O. Computes column widths from `Math.max(headerLen, ...rowLens)`, pads with spaces, separator line under headers.
- **`formatSessionShow({session, messages, invocations, proposals})`** — multi-section text with truncation (content > 120 chars truncated with `…`).
- **`formatSessionReplay({session, messages})`** — chat-style rendering with token annotations.

All three are pure and testable without a context.

## Cross-cutting invariants enforced

- **PG connection closes on every exit path.** Try/finally around the dispatch closes the connection even when handlers throw. Test injection bypasses connection construction entirely.
- **Tenant isolation honored.** Every query uses `tenant_id` either via RLS (the META_ARCHITECT_* tables enable RLS — but the CLI runs as a privileged user, so it must filter at the query level) or via an explicit `WHERE tenant_id = $1` clause (`listForTenant`, `getBySessionId`). The new `getBySessionId` enforces the tenant filter at the SQL level — even if RLS doesn't apply to the CLI's role, cross-tenant lookups can't succeed.
- **Output mode parity.** Every action supports `--format=json` for scripting + `--format=human` for terminals. JSON envelopes are stable shapes consumable by `jq` pipelines.
- **No mutation.** `sessions list/show/replay` are read-only. The subcommand has no write path; transcripts on disk stay immutable. (Mutation of past sessions is intentionally out of scope; auditability requires the historical record to be immutable.)
- **Session id resolution is tenant-bounded.** UUID-shaped inputs go through `getById` AND then verify `tenantId === ctx.tenantId` before being returned. A leaked session UUID from tenant A can't be displayed by tenant B because the CLI requires tenant_id to match. The session_id-shaped lookup uses the compound key directly.

## Alternatives considered

- **Add `sessions-list`, `sessions-show`, `sessions-replay` as three top-level subcommands.**
  - **Pros.** Each is parseable as a single token; help text per command lives in one place.
  - **Cons.** Three handlers duplicating connection setup + tenant resolution + format dispatch. The `sessions <action>` pattern is the same shape as `git remote list / add / remove`, `npm config get / set / list`, etc.
  - **Decision.** One subcommand + positional action. The cli.ts parser handles this with no special-case logic; the handler dispatches on `positional[0]`.

- **Implement a `--watch` mode for `list` that polls for new sessions.**
  - **Considered.** Useful for operators monitoring chat usage live.
  - **Decision.** Out of scope for M5.9. The CLI is one-shot; live monitoring is a future dashboard concern (web UI in Phase 3).

- **Allow `replay --speed=Nx` to add timing delays between messages.**
  - **Considered.** Reproduces the original pacing for demos.
  - **Decision.** Operators piping `crossengin sessions replay` into less / a file want it instantaneous. A future demo-mode flag could add pacing.

- **Persist transcripts to JSONL files in `~/.crossengin/sessions/`.**
  - **Considered.** Offline access without Postgres.
  - **Decision.** Postgres is the source of truth (M5.7 chose it deliberately). `sessions list --format=json > sessions.jsonl` gives operators the same data with one redirect.

- **Stream the replay output token-by-token to match real chat pacing.**
  - **Considered.** A more faithful "replay" experience.
  - **Decision.** Replay renders messages atomically. Token-level pacing would require persisting per-chunk timestamps (not in the M5.7 schema). M5.10 could add chunk-level events if there's a real use case.

- **Support `sessions show --since=<duration>` to filter by time.**
  - **Considered.** A common SQL pattern (last 24h, last week).
  - **Decision.** Out of scope for M5.9. `--limit N` is the only filter; the store's `listForTenant` already orders by `started_at DESC`. A `--since` flag can land in M5.9.5 if requested.

- **Make `sessions` subcommand work without Postgres by reading a local JSONL file.**
  - **Considered.** Offline / disconnected operators.
  - **Decision.** No. Persistence requires Postgres by design (M5.7's ADR-0057). The CLI fails fast when PG env is missing — easier than supporting two storage modes.

## Consequences

- **53 packages + 1 app, 119 meta-schema tables, 6,003 tests** (+20 from M5.9; no new packages, no new META tables).
- **The M5.7 audit data is now queryable from the same terminal that produces it.** Operators running chat in REPL mode can drop into `crossengin sessions list` to see their session aggregates, `crossengin sessions show <id>` to inspect the full transcript, `crossengin sessions replay <id>` to re-read the conversation chat-style.
- **Replay is a debugging tool.** When a developer says "Claude gave me the wrong manifest yesterday", an operator runs `crossengin sessions list` to find the session, then `crossengin sessions replay <id>` and reads the actual exchange — what was asked, what tools fired, what was approved. M5.6's tool dispatch and M5.8's write approvals both surface here verbatim.
- **`getBySessionId` makes the (tenant_id, session_id) compound key first-class.** Previously the unique constraint existed but no API surfaced it. Now it's the canonical session-lookup method; `getById` (UUID) stays for migration / cross-system lineage.
- **Test coverage matches the chat-side pattern.** 19 sessions tests cover the three actions (list / show / replay) × three modes (happy path / missing args / unknown action) plus pure formatter unit tests. All run offline via `storesOverride`.
- **Pattern set for future read-only audit subcommands.** A future `crossengin proposals list / show` or `crossengin tools list` follows the same shape — one subcommand, positional action, store injection for tests, render helpers for output.

## Open questions

- **Q1:** Should `sessions list` show aggregate cost across all sessions for a tenant?
  - _Current direction:_ Not in M5.9. Per-session cost shows; `SUM(cost_usd) GROUP BY tenant_id` is one SQL query operators can run directly. A future `sessions summary --tenant-id` could surface it.
- **Q2:** Does `replay` need to render tool invocations + proposals?
  - _Current direction:_ Replay is messages-only — matches what the developer saw in the chat REPL. Tool invocations + proposals are out-of-band metadata; `show` surfaces them.
- **Q3:** Should the CLI support exporting a session as a markdown document?
  - _Current direction:_ Out of scope for M5.9. Operators pipe `--format=json` through `jq` + a markdown template. A dedicated exporter could land in M5.9.5 if patterns emerge.
- **Q4:** What about a `sessions delete <id>` for GDPR Article 17 requests?
  - _Current direction:_ Defer to the existing `@crossengin/tenant-lifecycle` deletion request flow. The architect schema is tenant-scoped via FK + RLS; cascading from `meta.tenants` deletion already wipes session rows.
- **Q5:** Should the CLI emit OpenTelemetry spans for these read queries?
  - _Current direction:_ Not in M5.9. M8 (`@crossengin/observability-runtime`) is the right place. When that lands, the four store methods get span wrapping.
