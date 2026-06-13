# ADR-0229: architect-cli install command (Phase 3 P7.5)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0228 (gated pack install), ADR-0226 (architect-cli safety gate), ADR-0087 (operate-server) |

## Context

P7.4 built the gated install runtime in `marketplace-pg`; P7.2 wired the safety gate into
architect-cli's edit path. The exit criterion's "…the agent publishes + installs the upgrade
into a sandbox tenant" still had no architect-cli surface — install only existed on
`operate-server`. P7.5 adds the operator/agent install command to the authoring binary.

## Decision

A `crossengin install` subcommand in `apps/architect-cli`:

- **`install.ts`** — `parseInstallArgs(command)` validates `--pack <id> --version <semver>
  --tenant <uuid> --by <uuid>` (a pure, tested validator); `runInstall(command, ctx)` opens a
  Postgres connection from the `PG*` env vars, builds a `PostgresPackInstallationStore`, and
  drives `installPackGated(store, { verdict: { decision: "allow" }, … })`. The operator is the
  authority, so the verdict is `allow`; it backs onto the **same** `installPackGated` path the
  agent drives with a computed proposal-gate verdict, so a duplicate install reports
  `already_installed` (exit 0) and a refusal a non-zero exit rather than a blind write. Output
  is human or `--format=json`.
- `cli.ts` adds `install` to `SUBCOMMANDS` + help; `bin/crossengin.ts` dispatches it; the app
  gained a `@crossengin/marketplace-pg` dep.

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,449 offline tests.** No new META_
  tables (reuses `meta.pack_installations`; the real install path is covered by P7.4's gated
  PG test). New tests: `install.test.ts` (4 — `parseInstallArgs` accept + the four
  missing/invalid-flag rejections; `runInstall` exits 2 on bad flags and 1 when Postgres env
  is absent, both before touching a DB) + the `SUBCOMMANDS` list updated.
- The authoring binary can now install a pack into a tenant through the gated runtime — the
  literal "the agent installs" at the CLI surface. A chat *tool* that lets the agent install
  mid-session, and a marketplace *publish* registry, are the remaining P7 follow-ups; P7 is
  otherwise functionally complete.
