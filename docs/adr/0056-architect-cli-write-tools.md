# ADR-0056: Architect CLI write tools with human-in-the-loop approval (Phase 2 M5.8)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-17 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0055 (tool-driven chat), ADR-0054 (chat mode), ADR-0053 (Anthropic provider), ADR-0005 (AI Architect contract) |

## Context

M5.5 + M5.6 gave the Architect agent read-side capability: chat against Claude, dispatch validate / hash / diff / summarize / read_file tools, iterate until a terminal response. The remaining gap is the write side. Without a way to commit proposed changes to disk, every authoring session ends with "here's a draft manifest, save this somewhere" — the developer still copies text out of chat. The whole point of the CLI is to remove that copy-paste step.

Three constraints shaped the design:

1. **The human stays in the loop.** A misconfigured prompt, a hallucinated entity, an over-eager refactor — any of these could silently overwrite a developer's manifest if the LLM had unfettered write access. Every write must surface a diff + summary to the human and require explicit approval, except in opt-in automated scripts where the developer takes responsibility up-front.

2. **Approval can't fight stdin.** The interactive chat REPL is already reading from stdin line-by-line for user messages. An approval prompt also needs to read one line from stdin (y/N). Two readers competing for the same fd corrupts the stream. The same line reader must serve both purposes — when an approval is pending, the next line is approval; otherwise it's the next chat message.

3. **One-shot mode has no human.** A scripted `crossengin chat --prompt "..." --allow-file-write` has nobody to prompt. The CLI must either refuse the combination (forcing `--auto-approve-writes` to be explicit) or silently treat all writes as denied. Refusing is the safer default — script authors learn about the requirement at parse time, not at runtime when a tool returns `applied: false`.

## Decision

Three changes across the CLI app:

### 1 — `tools.ts`: `WriteApprover` interface + `propose_manifest_edit` tool

`WriteApprover` is a single-method interface:

```ts
interface WriteApprover {
  approve(request: WriteApprovalRequest): Promise<boolean>;
}

interface WriteApprovalRequest {
  path: string;
  isNew: boolean;
  newHash: string;
  diffSummary: { entitiesAdded, entitiesRemoved, entitiesModified };
}
```

`autoApprover(approve = true)` returns an approver that always returns the configured boolean. The catalog only includes the write tool when **both** `allowFileWrite: true` AND `approver` are supplied — gating from two directions prevents accidental enablement.

The `propose_manifest_edit({path, new_manifest_json})` tool flow:

1. **Validate path.** Reject anything not ending in `.json` with a `ToolExecutionError`.
2. **Parse new manifest.** `ManifestSchema.safeParse` first (catches structural errors with full Zod issue list), then `tryValidateManifest` (catches cross-reference errors). On either failure → `{applied: false, reason: "invalid_manifest", errors: [...]}`.
3. **Load existing file** (if present + parses cleanly). If absent → `isNew: true`.
4. **Short-circuit no-changes.** If `manifestHash(existing) === manifestHash(proposed)` → `{applied: false, reason: "no_changes"}` (no approval needed).
5. **Compute diff.** `computeManifestDiff(existing, proposed)` for updates; full-add for creates.
6. **Call approver.** If denied → `{applied: false, reason: "user_denied", diff_summary}`.
7. **Verify parent dir exists.** Fail loudly with a `ToolExecutionError` if not — the tool doesn't `mkdir -p`; the developer is in control of the directory layout.
8. **Write file.** Pretty-printed JSON + trailing newline.
9. **Return success envelope.** `{applied: true, path, hash, is_new, diff_summary, summary}`.

### 2 — `chat.ts`: `LineReader` + `interactiveApprover`

`LineReader` is a single-method abstraction over an async iterator that returns `null` on EOF:

```ts
interface LineReader { next(): Promise<string | null>; }
```

`lineReaderFromIterable(iter)` wraps any `AsyncIterable<string>` (including `linesFromReadable(process.stdin)`) so consumers can pull one line at a time, deterministically, instead of for-awaiting.

`interactiveApprover({io, reader})` writes a multi-line prompt to stdout (action + path + hash + entity diff counts + "Apply? [y/N]: "), then pulls one line via `reader.next()`. Accepts `y` / `yes` (case-insensitive, trimmed) as approval; everything else — including EOF — denies. The approver shares the SAME line reader that the REPL loop uses, so:
- When the REPL is waiting for the next chat message, lines go to the REPL.
- When a tool is mid-execution and calls the approver, lines go to the approver.
- The two never collide because tool execution is sequential within an exchange.

The REPL loop refactor: `runChatRepl` was using `for await (line of opts.stdin)`. That's replaced by `while (true) { const line = await opts.lines.next(); ... }` so the engine pulls explicitly via the same `LineReader`. The `ChatReplOptions.stdin: AsyncIterable<string>` field is replaced by `lines: LineReader`.

### 3 — `commands.ts.runChat`: flag plumbing + approver construction

New flags:
- `--allow-file-write` — enables `propose_manifest_edit` in the catalog (along with constructing an approver).
- `--auto-approve-writes` — skips the y/N prompt (uses `autoApprover(true)`).

The decision tree in `runChat`:
1. Build a single `LineReader` from `ctx.lineReader ?? ctx.stdin ?? process.stdin`. Tests pass `lineReader` directly; the bin gets one derived from `process.stdin`.
2. If `--allow-file-write`:
   - If `--auto-approve-writes` → `autoApprover(true)`.
   - Else if one-shot mode (`--prompt` or `--one-shot`) → **exit 2** with a friendly error explaining the combination needs `--auto-approve-writes`.
   - Else → `interactiveApprover({io, reader: lines})` (REPL mode, can prompt).
3. Build catalog with `{allowFileRead, allowFileWrite, approver}` so the tool is included only when both flags + approver align.
4. Pass `lines` (not `stdin`) to `runChatRepl`.

`RunContext` gains `lineReader?: LineReader` for tests; production passes `stdin`.

## Cross-cutting invariants enforced

- **Two-flag gate for writes.** `propose_manifest_edit` only appears in the catalog when `allowFileWrite === true` AND an approver is supplied. The catalog builder enforces both — missing either means the tool isn't registered, so Claude doesn't see it in its tool list.
- **Default denies, never approves.** Removing `--allow-file-write` removes the tool entirely. Removing `--auto-approve-writes` falls back to interactive. There's no `--allow-file-write --no-approve` combo that silently denies — the only paths are "explicit y per write" or "explicit auto-approve per session".
- **One-shot + write requires opt-in.** Scripts that want write-capable chat must explicitly include `--auto-approve-writes`. The CLI fails fast (exit 2) at flag parse, not at runtime — script authors discover the requirement during development, not in CI.
- **Same line reader, no fd contention.** The REPL loop and the approver share `opts.lines`. The approver pulls one line during tool execution; the REPL picks up the next line afterward. The for-await→manual refactor of the loop is what makes this safe — for-await semantically owns the iterator until exhausted; manual `.next()` lets multiple consumers cooperate.
- **No mkdir.** The tool fails if the parent directory doesn't exist. Creating `mkdir -p` semantics inside a chat tool would risk creating arbitrary directory trees on a developer's filesystem. The developer is responsible for setting up the destination directory; the tool just writes.
- **No overwrite without diff.** Even `--auto-approve-writes` runs the diff calculation + no-changes short-circuit. An auto-approved write of an identical manifest still returns `{applied: false, reason: "no_changes"}` — never an empty no-op write that bumps the mtime.
- **Schema validation gates approval.** A proposal that fails `ManifestSchema.safeParse` OR `tryValidateManifest` never reaches the approver. The approver sees only proposals that would, in principle, be writable; it just decides whether to actually write them.

## Alternatives considered

- **Two-tool flow: `propose_manifest_edit` (returns proposal_id) + `apply_proposal({id})` (writes).**
  - **Pros.** Approval is purely model-driven: Claude proposes, user confirms in next chat turn ("yes apply that"), Claude calls `apply_proposal`.
  - **Cons.** Two round-trips per write. Stale proposals accumulate. User's "yes" goes through Claude, which could misinterpret or add extra steps. The y/N prompt is faster + more deterministic.
  - **Decision.** Single-tool with synchronous approval is simpler. The two-tool pattern is the right shape for an async / web-UI deployment (Phase 3 chat-on-the-web), but in a terminal it's friction.

- **Run the approval through a readline `question()` call.**
  - **Pros.** Native interactive UX (cursor, line editing).
  - **Cons.** Readline competes with for-await on stdin. Either A) drain stdin into readline's buffer (loses the existing REPL flow), or B) suspend readline while REPL is active (state machine, race conditions). The shared `LineReader` is simpler.
  - **Decision.** Shared LineReader. Phase 3 GUI can layer readline on top.

- **Diff-as-text rendered into the approval prompt.**
  - **Considered.** Print a unified diff of the JSON files.
  - **Decision.** Out of scope for M5.8. The approver shows entity counts + hash; the developer can request the full diff from Claude before agreeing to write ("show me what changes you're about to make"). M5.9 can add diff rendering once the manifest diff structure has a stable text representation.

- **Silently auto-approve in one-shot mode.**
  - **Considered.** "If you wrote `--allow-file-write` without `--auto-approve-writes`, we assume you meant the latter."
  - **Decision.** No. Silent fallbacks bite in production. Exit 2 at parse time is honest.

- **Allow the tool to overwrite without checking the existing file.**
  - **Considered.** Skip the load-existing step; just write.
  - **Decision.** The diff is the value-add. Without it, the human can't decide whether to approve.

- **Persist proposals to a `.crossengin/proposals/` dir for later review.**
  - **Considered.** Every proposal saved as JSON + later `crossengin proposal review`.
  - **Decision.** Out of scope. Operators who want this redirect stdout (`crossengin chat --format=json > session.jsonl`). M5.7 (chat persistence to META_ARCHITECT_SESSIONS) is the proper landing zone.

- **Allow tools to delete files.**
  - **Considered.** A `delete_file` tool.
  - **Decision.** No. Not in M5.8, possibly never. Deletion is destructive + asymmetric (no diff to inspect). Developers can `rm` files outside chat if needed.

- **Allow tools to run `crossengin apply` directly.**
  - **Considered.** Bridge the chat into the DDL apply pipeline.
  - **Decision.** Out of scope. Apply hits a real Postgres; risk of unintended schema mutations is too high. Phase 3's `apply_proposal` (separate tool, requires explicit second approval) is the right path.

## Consequences

- **The authoring loop is closed.** A developer can now say "scaffold a manifest at /tmp/m.json for an Acme ERP, validate it, then write it" and Claude chains `propose_manifest_edit → user approves → file written → text confirmation`. No copy-paste.
- **+19 tests (5,606 → 5,625).** Tool catalog gating (3 tests), `propose_manifest_edit` flow (7 tests covering create / update / deny / no-changes / invalid / non-json path / malformed JSON), interactive approver (6 tests), one-shot guard rail (1 test), auto-approve happy path (1 test), `autoApprover` factory (2 tests).
- **Pattern set for future write tools.** `scaffold_manifest` (init from name/slug), `apply_manifest` (run kernel-pg apply), `patch_manifest` (write a partial) all fit the same shape: validate → diff → approver.approve → write.
- **`ChatReplOptions.stdin` is gone.** Replaced by `lines: LineReader`. Internal API break, but the only consumers are `commands.ts.runChat` (updated) and the test suite (updated). No external consumers — the CLI is an app, not a library.
- **`RunContext` gains `lineReader?`.** Tests inject directly; the bin derives from `process.stdin`. Backward compat with the existing `stdin?` field is preserved (the runtime derives lines from stdin if `lineReader` isn't set).

## Open questions

- **Q1:** Should the approver be able to allow + remember a per-path approval ("apply all changes to /tmp/m.json this session")?
  - _Current direction:_ Not in M5.8. Each `propose_manifest_edit` call prompts independently. Bulk-approve is a UX optimization for power users; defer until session telemetry shows it's needed.
- **Q2:** What happens if Claude proposes the same write twice in one exchange (e.g., a tool loop retries after a perceived error)?
  - _Current direction:_ Each call prompts. After the first approval, the file is written; the second call's diff would be empty → `no_changes` short-circuit, no second prompt. The duplicate is detected via hash, not via call-deduplication.
- **Q3:** Should the tool support a dry-run mode that returns the diff but always denies?
  - _Current direction:_ Not in M5.8. `--no-tools` + asking Claude to use `diff_manifests` achieves the same outcome.
- **Q4:** How does this interact with M5.7 (chat persistence)?
  - _Current direction:_ When M5.7 lands, `propose_manifest_edit` invocations get logged to `META_ARCHITECT_PROPOSALS` (separate table from messages) with the proposal + approval decision + final hash. Operators can audit "who approved what".
- **Q5:** Should `--auto-approve-writes` require a confirmation flag like `--i-know-what-i-am-doing`?
  - _Current direction:_ No. Anyone running with the flag has typed it; the CLI doesn't need to add friction beyond what's already documented.
