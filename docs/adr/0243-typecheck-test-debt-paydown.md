# ADR-0243: Type-check + test-suite debt paydown (workspace genuinely green)

- **Status**: Proposed
- **Date**: 2026-05-24
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M-maint.typecheck-test-debt
- **Related**: ADR-0119 (chat content blocks), ADR-0170 (129th meta-schema
  table), ADR-0191 (`labelForIndex`), ADR-0227/0231/0241 (output formats)

## Context

The README and CLAUDE.md have long claimed the workspace is "all green,
zero type errors." That claim was **inaccurate**: `pnpm -r typecheck`
reported 13 errors and `pnpm -r test` had 1 failing test. The drift
accumulated silently across prior milestones because two gaps let it
hide:

1. **`*.test.ts` files are not type-checked.** `pnpm typecheck` runs
   `tsc` over `src/**` per each package's tsconfig; `*.test.ts` files are
   executed by Vitest (transpile-only, no `tsc`). So a `src` file can
   carry type errors while its tests pass — and a test *fixture* can use
   a stale object shape that no longer matches the kernel type without
   anyone noticing.
2. **Stale assertions track stale code.** A test whose fixture and
   assertion both use an outdated field shape passes at runtime even
   though the production code is type-broken against the current type.

The 13 errors + 1 failure broke down as:

- **`apps/architect-cli/src/retention.ts(7,3)` — `labelForIndex`
  redeclaration.** ADR-0191 exported `labelForIndex` from `kernel-pg`;
  `retention.ts` both imported it AND kept a byte-identical local copy,
  triggering TS2440.
- **`chat.ts` ×4 (160/166/288/290) — stale `.mediaType`/`.data`.** The
  image/document content-block shapes are `{format, bytes}` (ADR-0078/
  0088/0097), but `userContentToTranscriptText` + `describeAttachment`
  still read `.mediaType`/`.data` — fields that don't exist on the
  current type. At runtime these would be `undefined` and
  `undefined.length` would throw; the tests only passed because their
  fixtures used the old `{mediaType, data}` shape too.
- **`chat.ts` ×5 (205/206/378/379/382) — `readonly` → mutable variance.**
  `UserContent` is `string | readonly LlmContentBlock[]` (ADR-0119), but
  `LlmMessage.content` wants a mutable `LlmContentBlock[]`; assigning the
  readonly array directly is rejected.
- **`commands.ts(400,7)` — format-union narrowing.** `command.format` is
  the 6-value `OutputFormat` union (since csv landed in ADR-0227), but
  `runChatRepl`'s `format` param is `"human" | "json"` — chat only
  streams those two. The mismatch was a latent error from ADR-0227.
- **`apply.test.ts(47)` — stale `toBe(128)`.** The meta-schema reached
  129 tables at ADR-0170; `apply.test.ts` was never updated (the actual
  failing test).
- **`meta-schema.test.ts(120)` — stale test *name*.** `it("contains 128
  tables", …)` whose body correctly asserts `toHaveLength(129)` — a
  misleading name, not a failure.

## Decision

Fix each at its root cause rather than suppressing:

1. **`labelForIndex`** — remove the local duplicate in `retention.ts`;
   keep the import. `kernel-pg`'s exported helper is the single source
   (the reason it was exported in ADR-0191). All 6 call sites bind to the
   identical imported function.
2. **`chat.ts` field access** — read `block.format` + `block.bytes`
   (the real kernel shape) in `userContentToTranscriptText` and
   `describeAttachment`. Image + document now render consistently
   (`[image:png:14b]`, `image: png (14b)`).
3. **`chat.ts` readonly content** — add a small `toMessageContent`
   helper that copies a `readonly LlmContentBlock[]` into a fresh mutable
   array (`[...content]`) when building `LlmMessage`s. Contained to the
   CLI; does NOT widen the kernel `LlmMessage.content` type (which would
   ripple to every provider).
4. **`commands.ts` chat format** — validate at the `runChat` entry that
   `--format` is `human` or `json` (exit 2 otherwise) and capture the
   narrowed value in a `const format: "human" | "json"`. This codifies
   the real contract: **chat output is human-stream or NDJSON only**;
   csv/tsv/ndjson/yaml are tabular formats that don't apply to an
   interactive token stream. Previously a `chat --format=csv` would have
   slipped through to a type-broken call.
5. **Stale tests** — `apply.test.ts` asserts 129; `meta-schema.test.ts`
   test name corrected to "contains 129 tables"; the `chat.test.ts`
   image fixture uses `{format, bytes}` with the matching assertion.

After these, `pnpm -r typecheck` reports **0 errors** and `pnpm -r test`
is **fully green** — the README/CLAUDE.md claim is now true.

## Rejected alternatives

1. **Suppress with `// @ts-expect-error` / `as any`** — hides the drift
   instead of fixing it; the code was genuinely broken (would throw at
   runtime on image/document blocks).
2. **Widen `LlmMessage.content` to accept `readonly`** — kernel-level
   change rippling to every provider + consumer for a CLI-local
   convenience; the `toMessageContent` copy is the contained fix.
3. **Widen `runChatRepl`'s `format` to the full `OutputFormat`** — chat
   genuinely can't emit csv/tsv/ndjson/yaml; validating + narrowing at
   the entry is correct and gives operators a clear error.
4. **Keep `labelForIndex` local, drop the import** — also resolves
   TS2440, but duplicates a kernel-pg helper that was exported precisely
   for reuse; single-source is cleaner.
5. **Preserve the `image/png` media-type style in placeholders** (via
   `imageMediaType(format)`) — adds an import + asymmetry with documents
   (which render bare `format`); bare `format` for both is consistent and
   minimal.
6. **Type-check `*.test.ts` as part of this milestone** — would surface
   the full backlog of never-checked test-file type errors across ~50
   packages; out of scope for a focused paydown. Deferred as a future Q.

## Future questions

1. **Type-check `*.test.ts` in CI** — the root enabler of this drift is
   that test files are transpile-only. A separate `tsc --noEmit` pass
   over test files (or a `typecheck:tests` script) would catch
   fixture/code drift early. Defer — likely surfaces a backlog to triage
   first.
2. **A `pnpm -r typecheck && pnpm -r test` pre-push/CI gate** so "all
   green, zero type errors" can't silently regress again. Defer to the
   CI-config milestone.
3. **Lint rule against duplicate-of-imported local declarations** —
   would have caught the `labelForIndex` redeclaration. Defer (ESLint
   flat-config migration is itself deferred).
4. **Runtime test coverage for chat image/document attachment
   rendering** — the `describeAttachment` image/document branches had no
   test (only `userContentToTranscriptText` did). Defer — the fixture
   fix + transcript test cover the field shape.

## Consequences

- **Workspace genuinely green** — `pnpm -r typecheck` 0 errors,
  `pnpm -r test` 0 failures; the README/CLAUDE.md invariant is now
  accurate rather than aspirational.
- **Chat `--format` contract codified** — `human` | `json` only;
  csv/tsv/ndjson/yaml exit 2 with a clear message.
- **`labelForIndex` single-sourced** from `kernel-pg`.
- **Chat attachment rendering actually works** — image/document
  placeholders read the real `{format, bytes}` shape instead of throwing
  on `undefined.length`.
- **Test count unchanged: 9,383** — no tests added/removed; the formerly
  failing `apply.test.ts` now passes (9,383 total, all green vs. 9,382
  passing + 1 failing before).
- **No new feature surface** — pure debt paydown; behavior change limited
  to chat rejecting non-human/json `--format`.
- **Recurrence risk documented** — the `*.test.ts`-not-type-checked gap
  is the systemic cause; closing it (future Q1) is the durable fix.
