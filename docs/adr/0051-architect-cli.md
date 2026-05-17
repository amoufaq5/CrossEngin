# ADR-0051: Architect CLI (Phase 2 M5)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004 (manifest specification), ADR-0005 (AI Architect contract), ADR-0024 (repo strategy), ADR-0046 (Phase 2 plan), ADR-0047 (kernel-pg) |

## Context

`@crossengin/kernel` declares the `Manifest` schema, the `validateManifest` / `computeManifestDiff` / `tryValidateManifest` / `manifestHash` helpers, the `patchManifest` reducer. `@crossengin/kernel-pg` ships `crossengin-pg apply` to take meta-schema DDL all the way to a live Postgres. `@crossengin/ai-architect` declares the AI Architect session contract — refusals, gates, cost ceilings, eval gates, redteam policy.

All of that is shaped, tested, and ready. There is no app yet. The shell where a developer says "I have a manifest, validate it / diff it against last week's / apply it to my local Postgres" doesn't exist. That's M5.

Three concrete requirements drive this milestone:

1. **First app under `apps/`.** Up to now the workspace has been packages only. M5 establishes the `apps/` shape and proves that the contract packages compose into a working binary.
2. **No live LLM yet.** The chat mode (which would call into `@crossengin/ai-providers` + Anthropic SDK) lands in M5.5 once a real provider client is bound. M5 ships only the LLM-free subcommands: `init`, `validate`, `diff`, `patch`, `hash`, `apply`. `chat` exists as a stub that exits with a clear "not implemented in M5" message.
3. **Exit-criterion-shaped.** Each subcommand has a measurable, scriptable outcome: `crossengin validate manifest.json && echo "valid"` works in CI; `crossengin diff a.json b.json --format json` produces machine-readable output; `crossengin apply --pgdatabase=crossengin_local --dry-run` shows what would change.

## Decision

`apps/architect-cli` ships with **six modules** + a bin entry:

1. **`cli.ts`.** Command dispatcher. `parseArgs(argv)` extracts the subcommand + flags + positional args. Validates them against the per-command spec. Returns a `ParsedCommand` discriminated union. The runtime walks the union and dispatches to the corresponding command function. Exit code is the command's return code (0 for success, 1 for validation/runtime errors, 2 for usage errors).

2. **`format.ts`.** Output formatting:
   - `printSuccess(message)`, `printError(message)`, `printJson(obj)`.
   - `formatValidationErrors(errors)` — pretty stack of path + message.
   - `formatDiff(diff)` — human or JSON. Counts of added/removed/modified per top-level category.
   - `formatManifestSummary(manifest)` — short human view of meta + entity/workflow counts.
   - All output goes to stdout for success / JSON; errors to stderr. Format mode (`--format human|json`) is the toggle.

3. **`commands/init.ts`.** Writes a starter `manifest.json` to the supplied path. The starter has a minimal `meta` block (name + slug + version 1.0.0 + description) and empty arrays for entities / workflows / etc. Refuses to overwrite an existing file unless `--force` is passed.

4. **`commands/validate.ts`.** Reads a manifest JSON file from disk, calls `validateManifest` (or `tryValidateManifest` for the soft variant). On success: prints "manifest is valid" + the manifest hash. On failure: prints a structured list of validation errors. Exits 0 / 1.

5. **`commands/diff.ts`.** Reads two manifest files. Calls `computeManifestDiff(oldManifest, newManifest)`. Prints the diff in `human` or `json` format. Exit code 0 always (the diff is not pass/fail).

6. **`commands/patch.ts`.** Reads a manifest file + a patch file (which is also a manifest). Calls `patchManifest(base, patch)` from `@crossengin/kernel`. Writes the result back to the manifest path (or `--output` if supplied). Reports the new hash.

7. **`commands/hash.ts`.** Reads a manifest file, prints `manifestHash(manifest)` (just the hex). Useful in CI guards.

8. **`commands/apply.ts`.** Two roles: (a) emit DDL via `emitMetaBootstrapSql()` to stdout for inspection, or (b) call `MigrationApplier` from `@crossengin/kernel-pg` to actually apply against `PGHOST/PGDATABASE/...`. Always passes through `--confirm` for production-looking databases.

9. **`commands/chat.ts`.** Stub. Prints "chat mode is not implemented in M5; ships in M5.5 alongside the Anthropic SDK provider binding." Exits 0.

Plus `bin/crossengin.ts` — the `#!/usr/bin/env node` entry point that calls `cli.run(process.argv)`.

## Cross-cutting invariants enforced

- **Determinism.** No subcommand reaches for `Date.now()` directly; clock injection threads through. (This is mostly for the `chat` mode in M5.5 — for now the LLM-free commands are pure functions over JSON files.)
- **stdout vs stderr split.** Machine-parseable output (JSON, hashes, valid statuses) always goes to stdout. Errors, warnings, and human-readable progress goes to stderr. `crossengin hash manifest.json > .last-hash` works.
- **Exit-code discipline.** 0 = success. 1 = command ran but found problems (invalid manifest, drift detected, apply failure). 2 = misuse (bad args, file not found, malformed input). The bin entry does `process.exit(code)`.
- **No side effects on validate/diff/hash.** These commands never write to disk, never touch the network, never spawn subprocesses. Pure reads.
- **`apply` requires explicit confirmation.** `--confirm` is required when `PGDATABASE` matches a production-looking pattern, matching the same gate as `crossengin-pg apply`.
- **Each command is independently testable.** Commands are pure functions over `{ argv, stdout, stderr, fs }` that return an exit code. The bin entry is a thin wrapper.

## Alternatives considered

- **Use `commander` / `yargs` / `oclif` for arg parsing.**
  - **Pros.** Battle-tested. Subcommand routing, help text, completions.
  - **Cons.** Each adds a dep + a layer of magic. Our subcommand surface is small (8 commands) and stable; a 100-line hand-rolled parser keeps the dep graph clean and tests deterministic.
  - **Why not.** Phase 3 may revisit if we add 30+ commands.

- **Ship the CLI inside `@crossengin/kernel`.**
  - **Pros.** One less package.
  - **Cons.** Couples a pure-contract package to a CLI runner. The kernel imports zero packages outside `@crossengin/*` workspace deps — adding a bin would expand its dependency surface for consumers who only need types.
  - **Why not.** `apps/architect-cli` is the canonical home; the kernel stays pure.

- **Use Ink / React for the UI.**
  - **Considered.** Rich TUI for `chat` mode would be nicer.
  - **Decision.** Out of scope for M5 (no chat). M5.5 may add Ink for the chat UI, but the LLM-free commands ship as plain stdout/stderr.

- **Auto-generate commands from manifest categories.**
  - **Considered.** `crossengin entity list`, `crossengin entity validate`, etc.
  - **Decision.** Out of scope. The manifest-level commands (`validate`, `diff`, `patch`, `apply`) operate at the whole-manifest level. Entity-level surgery is the job of the AI Architect (M5.5).

- **Build under `tools/cli` instead of `apps/architect-cli`.**
  - **Pros.** "Tools" is for internal CLIs, "apps" is for shipped products.
  - **Cons.** The architect CLI *is* a shipped product — it's the developer's entry point to the platform. ADR-0024 frames `apps/` as both customer-facing and developer-facing binaries.
  - **Why not.** The CLI is a Tier-1 surface; it belongs under `apps/`.

- **Make `apply` always go through Postgres.**
  - **Considered.** Drop the `--dry-run` mode.
  - **Decision.** `--dry-run` is essential for CI gates ("did this manifest change produce destructive DDL?"). It's the safe path; the live path is opt-in.

## Consequences

- **First entry in `apps/`.** The directory now has at least one binary. Future apps (admin web, customer portal) will sibling here.
- **Workspace exposes a bin.** `crossengin` is now a callable command after `pnpm install`. Developers can run `pnpm --filter @crossengin/architect-cli build && node apps/architect-cli/dist/bin/crossengin.js validate ./manifest.json`. The published bin alias is `crossengin`.
- **First end-to-end demo path exists.** `crossengin init my.json && crossengin validate my.json && crossengin apply --dry-run` proves the contracts → binary chain works.
- **Chat mode is the M5.5 follow-up.** When the Anthropic SDK binding lands, the `chat` command extends from stub to functional. The CLI shape doesn't change; only the chat handler gets a real implementation.
- **Apply re-uses `crossengin-pg`.** Rather than reimplementing migration apply, the CLI shells out to the `crossengin-pg` binary or imports `MigrationApplier` directly. The latter is cleaner — no subprocess overhead, structured output.

## Open questions

- **Q1:** Should `validate` accept a manifest from stdin too?
  - _Current direction:_ Yes, `crossengin validate -` reads from stdin. Useful for CI pipes.
- **Q2:** Should `diff` support 3-way diff (against a common ancestor)?
  - _Current direction:_ No for M5. Manifests are typically diffed against a previous version; 3-way is a Phase 3 git-style enhancement.
- **Q3:** Should `apply` accept a manifest file directly, or only operate on the kernel meta-schema?
  - _Current direction:_ M5 only does meta-schema apply (same as `crossengin-pg apply`). Manifest-driven entity DDL apply (which would translate a `Manifest` into tenant-scoped CREATE TABLE statements) is a separate concern that needs ADR-0052+.
- **Q4:** How does the CLI authenticate to Postgres?
  - _Current direction:_ Same as `crossengin-pg` — `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGSSLMODE` env vars. No password prompts in M5.
- **Q5:** Should the binary be `crossengin` or `crossengin-architect`?
  - _Current direction:_ `crossengin`. Short, memorable, no confusion in the customer's PATH. Internal CLI tools (admin, finops) can have longer names.

## References

- **ADR-0004** — Manifest specification (the shape this CLI consumes)
- **ADR-0005** — AI Architect contract (the basis for M5.5 chat mode)
- **ADR-0024** — Repository and migration strategy (positions `apps/` vs `packages/` vs `tools/`)
- **ADR-0046** — Phase 2 implementation plan (M5 sequencing)
- **ADR-0047** — Kernel DDL execution (the apply substrate)
