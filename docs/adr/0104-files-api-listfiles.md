# ADR-0104: Files API listFiles() across OpenAI + Anthropic (Phase 2 M2.X.5.aa.z.2)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0102 (M2.X.5.aa.z OpenAI Files API), ADR-0103 (M2.X.5.aa.z.1 Anthropic Files API) |

## Context

M2.X.5.aa.z + M2.X.5.aa.z.1 shipped Files API CRUD on OpenAI + Anthropic: `uploadFile` / `retrieveFile` / `deleteFile`. Both ADRs deferred `listFiles()` (Q1 / Q5 respectively) — "wait for operator demand."

Demand surfaces in three operational scenarios:

1. **Tenant offboarding** — when a tenant is decommissioned, find + delete all files attributed to them.
2. **Storage audits** — enumerate files, compute total bytes by purpose, identify long-tail files for cleanup.
3. **Reference reconciliation** — operators tracking file_id → tenant_id mappings need to detect orphaned files (in the provider's store but missing from operator records).

M2.X.5.aa.z.2 ships `listFiles(options?)` on both providers. The response types were already defined in M2.X.5.aa.z / M2.X.5.aa.z.1 (`OpenAIFileListResponse`, `AnthropicFileListResponse`) — only the methods + tests are new.

## Decision

Two coordinated additions, one per provider.

### 1. `OpenAIProvider.listFiles(options?)`

```ts
async listFiles(options: {
  readonly purpose?: OpenAIFilesPurpose;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
  readonly after?: string;
} = {}): Promise<OpenAIFileListResponse>;
```

Optional query parameters per OpenAI's documented API:
- `purpose` — filter to one of the 5 documented purposes (validated via `isOpenAIFilesPurpose`).
- `limit` — page size; validated to integer in `[1, 10000]`.
- `order` — `asc | desc` (default per OpenAI's API; provider doesn't enforce).
- `after` — cursor (the last file_id from the previous page) for pagination.

Empty options object → calls `/v1/files` with no query (returns the API's default).

### 2. `AnthropicProvider.listFiles(options?)`

```ts
async listFiles(options: {
  readonly limit?: number;
  readonly beforeId?: string;
  readonly afterId?: string;
  readonly order?: "asc" | "desc";
} = {}): Promise<AnthropicFileListResponse>;
```

Anthropic's pagination is bidirectional (`before_id` / `after_id`) vs OpenAI's forward-only (`after`). Optional parameters:
- `limit` — validated to integer in `[1, 1000]` (Anthropic's documented max).
- `beforeId` / `afterId` — cursor-based pagination via the file_id boundary.
- `order` — `asc | desc`.

Always emits the `anthropic-beta: files-api-2025-04-14` header via `filesApiHeaders()` (same path as retrieve / delete).

The kernel field names use camelCase (`beforeId`, `afterId`); the HTTP query params are snake_case (`before_id`, `after_id`) per Anthropic's documented convention. Translation happens in the method body via `URLSearchParams.set`.

### 3. Validation discipline

Both providers' `listFiles` follow the same validation pattern as their sibling methods:
- Invalid types → throw `OpenAIError` / `AnthropicError` with `kind: "invalid_request_error"`.
- Network errors → `fromNetworkError`.
- HTTP errors → `fromHttpResponse` (typed `kind`).
- JSON parse errors → `OpenAIError` / `AnthropicError` with `kind: "api_error"`.

Limit validation runs at the provider boundary BEFORE any fetch — operators get fast-fail on out-of-range values without burning a request.

### 4. Response types are reused as-is

`OpenAIFileListResponse` (M2.X.5.aa.z) and `AnthropicFileListResponse` (M2.X.5.aa.z.1) were already exported. The shapes match each provider's documented response:

- **OpenAI**: `{object: "list", data: OpenAIFile[]}` — no `has_more` field; client paginates via the `after` cursor + last result.
- **Anthropic**: `{data: AnthropicFile[], has_more, first_id, last_id}` — explicit pagination envelope.

The asymmetry is provider-documented; the kernel doesn't try to unify the shapes.

## Cross-cutting invariants enforced

- **Provider-specific query param naming.** OpenAI uses `purpose` + `after`; Anthropic uses `before_id` + `after_id`. Each provider's method exposes camelCase kernel params translated to snake_case HTTP params per provider docs.
- **Limit ranges per provider docs.** OpenAI: [1, 10000]. Anthropic: [1, 1000]. Validated at the boundary.
- **Empty options shape works.** Both providers accept zero-arg calls and emit `GET /v1/files` with no query string.
- **Beta header on Anthropic.** All Anthropic Files API methods (including `listFiles`) emit `anthropic-beta: files-api-2025-04-14` via `filesApiHeaders()`.
- **Backwards compat preserved.** No M2.X.5.aa.z / M2.X.5.aa.z.1 tests changed; only additions.
- **Error handling matches sibling methods.** Both providers' `listFiles` route errors through the same `from*Error` helpers as `uploadFile` / `retrieveFile` / `deleteFile`.

## End-to-end semantic

```ts
// OpenAI: enumerate all user-uploaded files
const openai = new OpenAIProvider({ apiKey: "sk-..." });
const all: OpenAIFile[] = [];
let cursor: string | undefined;
do {
  const page = await openai.listFiles({
    purpose: "user_data",
    limit: 100,
    after: cursor,
    order: "asc",
  });
  all.push(...page.data);
  cursor = page.data.length === 100 ? page.data[page.data.length - 1]!.id : undefined;
} while (cursor !== undefined);

// Anthropic: same shape with bidirectional pagination
const anthropic = new AnthropicProvider({ ... });
let nextCursor: string | undefined;
const files: AnthropicFile[] = [];
do {
  const page = await anthropic.listFiles({
    limit: 100,
    afterId: nextCursor,
  });
  files.push(...page.data);
  nextCursor = page.has_more ? page.last_id ?? undefined : undefined;
} while (nextCursor !== undefined);
```

## Alternatives considered

- **Add an async-iterable helper `listAllFiles()` that auto-paginates.**
  - **Considered.** Operators don't have to write the do/while loop.
  - **Cons.** Hides the pagination cursor — operators wanting to resume from a checkpoint can't. The plain `listFiles` is composable; operators can wrap it in their own auto-paginator if they want.
  - **Decision.** Plain `listFiles` only. Auto-paginator is operator-side.

- **Match query param names to HTTP conventions (snake_case `before_id` in the kernel API).**
  - **Considered.** Less translation overhead.
  - **Cons.** Inconsistent with the rest of the workspace's camelCase TypeScript conventions. Operators write camelCase everywhere else.
  - **Decision.** camelCase at the kernel boundary; translate inside the method.

- **Unify OpenAI + Anthropic response shapes at the kernel layer (`{data, hasMore, cursor}`).**
  - **Considered.** Cross-provider portable iteration.
  - **Cons.** Each provider's response carries info the other doesn't (`first_id` / `last_id` on Anthropic; nothing equivalent on OpenAI). Unification loses information. Operators iterating across providers wrap each in their own normalizer.
  - **Decision.** Provider-native response shapes. The kernel doesn't try to abstract them.

- **Validate `limit > 0` only, without an upper bound.**
  - **Considered.** Provider would return 400 on out-of-range; client validation is duplicative.
  - **Cons.** Operators occasionally pass `Number.MAX_SAFE_INTEGER`; catching at the boundary saves a wasted request + provides a clear error message.
  - **Decision.** Bounded ranges per provider docs.

- **Make `listFiles` automatically retry on transient errors.**
  - **Considered.** Convenience.
  - **Cons.** Retries are the router's concern; the provider methods are single-call surfaces.
  - **Decision.** No built-in retry. Operators use `withRetry` from `@crossengin/ai-router` if they need it.

- **Cache the result for a short TTL.**
  - **Considered.** Frequent enumeration is common in monitoring dashboards.
  - **Cons.** Caching policy is operator-specific (TTL varies by use case). The provider just transports.
  - **Decision.** No caching. Operators add their own.

- **Add `listFiles` to a kernel interface `LlmFileProvider`.**
  - **Considered.** Cross-provider abstraction for operators wanting "list files everywhere."
  - **Cons.** Each provider's pagination model is different. The shared interface would need lowest-common-denominator semantics. Provider-specific methods are clearer.
  - **Decision.** No kernel interface. Operators call each provider's `listFiles` separately.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,854 tests** (+7 from M2.X.5.aa.z.2: 4 OpenAI + 3 Anthropic). All green, zero type errors.
- **ADR-0102 Q1 + ADR-0103 Q5 closed.** Both Files APIs have full CRUD + list.
- **Tenant-offboarding workflows now viable.** Operators can enumerate files attributed to a tenant (via filename / metadata correlation) and bulk-delete them.
- **Storage audits unblocked.** Total bytes by purpose, file count, oldest-file age — all computable client-side.
- **Reference reconciliation pattern supported.** Operators tracking file_id → tenant_id in their own store can periodically diff against the provider's enumeration.
- **Pattern set for future enumeration methods.** If batch / fine-tune / etc. endpoints get list methods, the same shape applies: optional query params + provider-native pagination + boundary validation.
- **The Files API surface for both providers is feature-complete.** Future M2.X.5.aa.z.3+ would target Bedrock's batch endpoints, async-invoke APIs, or provider-specific extensions.

## Open questions

- **Q1:** Should there be a kernel-level `listFiles()` helper that takes a provider instance + returns an async iterable?
  - _Current direction:_ Operators write their own auto-paginator. Add a helper if call sites get noisy.
- **Q2:** Should `limit`'s default be set to a sane value (e.g., 100) instead of provider's default?
  - _Current direction:_ Use provider's default. Operators who want a specific size pass it explicitly.
- **Q3:** Should the response carry a typed `nextCursor` field for portable pagination?
  - _Current direction:_ Provider-native shapes only. Operators normalize.
- **Q4:** What about `head`-style requests (count without data)?
  - _Current direction:_ Out of scope. Neither provider exposes a count-only endpoint.
- **Q5:** Cursor expiry handling — what if a paginated cursor is invalidated mid-iteration?
  - _Current direction:_ HTTP 400 → typed error. Operator restarts from beginning.
- **Q6:** Should `listFiles` accept a `filter` callback (filter server-side via API params + client-side via callback)?
  - _Current direction:_ Server-side filters are param-based (purpose for OpenAI; none for Anthropic). Client-side filtering happens after the call.
- **Q7:** Bedrock files / batch enumeration — should we add equivalent methods if AWS ships them?
  - _Current direction:_ Watch the Bedrock changelog. Currently no Bedrock Files API equivalent.
