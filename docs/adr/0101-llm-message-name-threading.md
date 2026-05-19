# ADR-0101: Kernel LlmMessage.name enforcement + OpenAI threading (Phase 2 M2.X.10)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-19 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0060 (M2.8 OpenAI provider), ADR-0088 (M2.X.5 content union) |

## Context

The kernel `LlmMessage` schema has had a `name?: string` field since M2.7, but it was effectively unused: only the OpenAI tool-role message branch threaded it through (a holdover from the original `function`-role pattern). The other roles (system, user, assistant) silently dropped it.

OpenAI's Chat Completions API accepts an optional `name` field on all four message roles. It's used for:
- **System** — naming the system persona (rare, but documented).
- **User** — disambiguating multiple parties in a multi-user conversation (chatrooms, multi-tenant agent orchestration).
- **Assistant** — tagging the assistant identity in multi-agent systems.
- **Tool** — already supported pre-M2.X.10 (tool result attribution).

The OpenAI API enforces the regex `^[a-zA-Z0-9_-]{1,64}$` on name values. The kernel schema had no constraint — operators could pass any string, OpenAI would 400.

M2.X.10 closes both gaps: enforce the OpenAI naming rules at the kernel layer, and thread `name` through all four OpenAI Chat roles.

## Decision

Three coordinated changes.

### 1. Kernel schema validation

```ts
export const LLM_MESSAGE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const LlmMessageNameSchema = z.string().regex(LLM_MESSAGE_NAME_PATTERN);

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: LlmContentSchema,
  name: LlmMessageNameSchema.optional(),
  // ...
});
```

The regex matches OpenAI's documented rules. Bad names fail at parse time instead of at the OpenAI HTTP boundary. `LLM_MESSAGE_NAME_PATTERN` + `LlmMessageNameSchema` are exported so operators can validate / construct names with kernel-level helpers.

### 2. OpenAI Chat translator: thread `name` on all four roles

Pre-M2.X.10: only `tool` messages carried `name`.

Post-M2.X.10:

- **`system`** — `{role: "system", content, ...(m.name !== undefined ? {name: m.name} : {})}`
- **`user`** — same pattern, applied to both the string-content path and the array-content path. The `name` field appears on the final `user`-role OpenAI message even when M2.X.5.x tool-result blocks split off into separate tool-role messages first.
- **`assistant`** — same pattern, applied to all four return paths (string content + null content + array content + content-with-tool-calls).
- **`tool`** — unchanged; was already threaded.

### 3. Other providers ignore `name`

- **Anthropic** — Messages API has no `name` field on any role. Kernel `name` is silently dropped at translation. Documented but no test (negative-space behavior).
- **Bedrock** — Converse API has no `name` field on messages. Same drop-silently behavior.
- **OpenAI Responses API** — input items use role + content; the Responses API doesn't expose a name field on the message item shape. Drop silently.

The dropping is intentional: forcing a throw on these three paths would be operationally noisy without value (operators using `name` for OpenAI Chat-specific disambiguation shouldn't have their cross-provider workflows blocked).

## Cross-cutting invariants enforced

- **`name` is regex-validated at parse time.** Bad names (with spaces, dots, special chars, or > 64 chars) fail before the request flies.
- **`name` is optional.** Omitting it (the common case) parses cleanly.
- **OpenAI Chat threads `name` on all four roles.** Verified by tests for each role.
- **`name` is omitted from the OpenAI request body when undefined.** Verified by test (no empty `name` field on the wire).
- **`name` survives the M2.X.5.x message-flatten path.** User messages with tool_result content blocks split into separate tool-role messages; the `name` field appears on the resulting user-role message, not the tool-role messages (tool-role gets the tool's own name field from the kernel `m.name` if set, but only on tool-role kernel messages).
- **Pre-M2.X.10 tool-role behavior unchanged.** Regression test verifies `tool` role still threads `name`.

## End-to-end semantic

```ts
const msg: LlmMessage = {
  role: "user",
  content: "what's the agenda?",
  name: "alice",
};

// → OpenAI Chat: {role: "user", content: "what's the agenda?", name: "alice"}
// → Anthropic:   {role: "user", content: "what's the agenda?"}    // name dropped
// → Bedrock:     {role: "user", content: [{text: "what's the agenda?"}]}  // name dropped
```

Multi-agent orchestration example:

```ts
const conversation: LlmMessage[] = [
  { role: "system", content: "Two assistants debate...", name: "moderator" },
  { role: "user", content: "What's 2+2?", name: "alice" },
  { role: "assistant", content: "4.", name: "claude" },
  { role: "user", content: "Sure?", name: "bob" },
  { role: "assistant", content: "Yes, 4.", name: "claude" },
];

// → OpenAI Chat: All 5 messages carry their name field for disambiguation.
// → Anthropic / Bedrock: name dropped; messages still flow correctly.
```

## Alternatives considered

- **Make `name` required when set per-role (e.g., tool-role must have name).**
  - **Considered.** OpenAI's old `function` role required `name`; tool role doesn't.
  - **Cons.** Adds a per-role validation rule with no real operational value. Tool-role `name` is OPTIONAL on OpenAI's current API.
  - **Decision.** All-roles optional.

- **Throw on Anthropic / Bedrock when `name` is set (since they can't use it).**
  - **Considered.** Loud failure tells operators their `name` field is being dropped.
  - **Cons.** Operators with multi-provider workflows would have to conditionally strip `name` per provider — defeats the kernel abstraction.
  - **Decision.** Silently drop. Document that `name` is OpenAI-Chat-specific today.

- **Use a broader regex (e.g., `^\S{1,128}$`) so operators can use display names like "Alice Smith".**
  - **Considered.** More permissive.
  - **Cons.** OpenAI would 400 on `Alice Smith` (space disallowed). Matching OpenAI's regex avoids the operator footgun.
  - **Decision.** Match OpenAI's documented rules.

- **Add a `displayName` field alongside `name` for human-readable names.**
  - **Considered.** Separate the OpenAI identifier from a presentational label.
  - **Cons.** Two fields with overlapping semantics. Operators handle display logic at their UI layer.
  - **Decision.** Single `name` field. OpenAI-rules-compliant.

- **Thread `name` through OpenAI Responses API.**
  - **Considered.** Symmetric API surface.
  - **Cons.** OpenAI Responses input items don't have a `name` field. The Responses API uses a different shape; adding name there would be inventing a non-existent field.
  - **Decision.** Drop silently on Responses API.

- **Validate name patterns per-provider (some providers might allow different chars).**
  - **Considered.** Loosest-common-denominator at the kernel, stricter at the provider.
  - **Cons.** OpenAI is the only provider that uses `name`. Validating to OpenAI's rules at the kernel catches OpenAI errors early. If other providers ship name fields with different rules later, revisit.
  - **Decision.** Kernel validates to OpenAI's rules.

- **Pass `name` through to Anthropic by prepending it to the content** (e.g., `"[alice]: what's the agenda?"`).
  - **Considered.** Operators get attribution in the model's input.
  - **Cons.** Surprising transformation; mangles content. Operators wanting that effect do it themselves.
  - **Decision.** Drop silently.

## Consequences

- **55 packages + 1 app, 119 meta-schema tables, 6,807 tests** (+13 from M2.X.10: 6 kernel + 7 OpenAI Chat). All green, zero type errors.
- **`LlmMessage.name` is now operationally meaningful.** Pre-M2.X.10 it was dead weight for three of four OpenAI Chat roles.
- **OpenAI naming errors are caught at the kernel boundary.** Bad names fail at parse time instead of as HTTP 400.
- **Pattern set for future per-provider field threading.** When a kernel field is provider-specific (only used by one of three providers), document the drop-silently semantic. Throw only when the data SHAPE is wrong, not when a provider can't use a particular field.
- **Multi-agent orchestration workflows on OpenAI Chat get first-class support.** Operators tagging messages with participant names get them through to the model.
- **`LLM_MESSAGE_NAME_PATTERN` + `LlmMessageNameSchema` are reusable.** Operators constructing names programmatically can validate via the schema or test against the pattern.

## Open questions

- **Q1:** Should `name` be threaded through the OpenAI Responses API if/when OpenAI adds a name field there?
  - _Current direction:_ Yes — same pattern as Chat Completions. Watch the Responses API changelog.
- **Q2:** What about Anthropic's multi-tenant agent identification (do they expose any equivalent)?
  - _Current direction:_ Anthropic doesn't expose a name field today. If they add one, thread it through.
- **Q3:** Should `name` be propagated to `toolUses[].name` for the tool-call function name when omitted?
  - _Current direction:_ No. `LlmMessage.name` and `toolUses[].name` have different semantics (sender identity vs function name). Keep them distinct.
- **Q4:** Should the regex be configurable per provider (e.g., loosen for non-OpenAI consumers)?
  - _Current direction:_ Out of scope. OpenAI's rules are the strictest known; matching them ensures cross-provider compatibility.
- **Q5:** Test for chat substrate emission of `name` (M5.x)?
  - _Current direction:_ Out of scope. The CLI's chat engine doesn't construct named messages today; future M5.10.5 might.
- **Q6:** Multi-name (alias) support — allow a primary `name` + a `displayName` alias?
  - _Current direction:_ Out of scope. Single field; multi-name is UI-layer concern.
- **Q7:** Should we audit-log when name is dropped on Anthropic / Bedrock?
  - _Current direction:_ Out of scope. Audit logging is M8 observability territory.
