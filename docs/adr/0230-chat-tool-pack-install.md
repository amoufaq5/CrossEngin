# ADR-0230: chat-tool pack install (Phase 3 P7.6)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0229 (install command), ADR-0228 (gated pack install), ADR-0055 (tool-driven chat) |

## Context

P7.5 added a `crossengin install` operator command, but the exit criterion phrases it as
"the **agent** publishes + installs". P7.6 lets the AI Architect install a pack **mid-chat**
via a tool, completing the in-loop story — the agent proposes + (P7.2) the edit is gated, then
the agent installs through the same gated runtime.

## Decision

A `PackInstaller` seam + an `install_pack` chat tool in `apps/architect-cli`:

- **`tools.ts`** — a structural `PackInstaller` (`install({packId, version, tenantId,
  installedBy}) → { installed, reason? }`) + `ChatToolOptions.installer`. When set,
  `buildToolCatalog` exposes an `install_pack` tool (validates `pack_id` / `version` /
  `tenant_id` [UUID] / `installed_by` [UUID], then calls the installer). The tool is
  decoupled from Postgres — `tools.test.ts` drives it with a fake installer.
- **`commands.ts` `runChat`** — under `--allow-install`, opens a dedicated Postgres
  connection, builds a `PostgresPackInstallationStore`, and wires an installer that drives
  `installPackGated(store, { verdict: { decision: "allow" }, … })` (the operator authorized
  the session, so the verdict is `allow`; the connection is closed on session end alongside
  the persist connection). Without the flag, the tool is absent and chat stays offline.

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,453 offline tests.** No new META_
  tables (reuses `meta.pack_installations` via P7.4's `installPackGated`). New tests in
  `tools.test.ts` (4 — the tool is absent without an installer / present with one, drives the
  installer with the parsed fields + returns its result, surfaces a refusal result, errors on
  a non-UUID tenant). The chat tests stay offline (the tool is opt-in behind `--allow-install`).
- The agent can now install a pack mid-session — "the agent installs" in the chat loop, not
  just the CLI. The only remaining P7 item is a marketplace *publish* registry (a publish
  lifecycle + a pack-registry surface); P7 is otherwise complete.
