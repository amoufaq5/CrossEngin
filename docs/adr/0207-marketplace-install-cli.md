# ADR-0207: marketplace install CLI (Phase 3 P5.1)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0081 (marketplace install runtime), ADR-0203 (sdk-releases CLI), ADR-0159 (slo subcommand) |

## Context

P5 (ADR-0081) shipped the install runtime — the pure lifecycle engine + the
`PostgresPackInstallationStore`. There was no operator surface to drive it: a tenant
couldn't install/uninstall a pack or query its ledger from the shell, unlike the
incident / SLO / SDK ledgers (each with a read + verify subcommand).

## Decision

A `marketplace` read + write CLI, mirroring the `incidents` / `slo` / `sdk-releases`
subcommands but adding write commands that drive the engine.

- **`@crossengin/marketplace-pg` `query.ts`** — the framework-neutral runner:
  `parseMarketplaceArgs` + `runMarketplace` over a structural `MarketplaceSource`
  (`listForTenant`/`activeForPack`/`record`, satisfied by the store) + injected
  `{ now, newId }` deps (so the runner stays pure/testable). Commands:
  - `list --tenant <uuid> [--status] [--limit]` — the tenant's installs.
  - `verify --tenant <uuid>` — runs the pure `verifyInstallations` cross-row sweep
    (a tenant must have **at most one active install per pack**;
    `duplicate_active_install` otherwise) and **exits 1 on drift**.
  - `install --tenant --pack --version --by [--update-policy]` — refuses if an
    active install of the pack exists, else drives the engine
    `newInstallationRequest → beginInstall → completeInstall` and records the
    `installed` record.
  - `uninstall --tenant --pack --by` — finds the active `installed` install and
    drives `requestUninstall → completeUninstall`, recording the `uninstalled`
    record.
- **`apps/operate-server`** — `marketplace-cli.ts` re-wraps the parser (translating
  `CliUsageError`), `node.ts`'s `executeMarketplace` builds the store as the source
  with `now: () => new Date()` + `newId: () => randomUUID()` (the install id must be
  a UUID for the table PK), and the bin gained an `argv[2] === "marketplace"` branch
  (alongside incidents / slo / openapi-client / sdk-releases).

## Consequences

- **68 packages + 4 apps, 126 meta-schema tables, ~7,299 offline tests + 54 gated
  real-Postgres integration tests + six CI gates.** New offline tests:
  `query.test.ts` (verifyInstallations clean/duplicate/terminal, the runner's
  list/verify/install/uninstall paths incl. the refuse cases, the parser) + an
  operate-server `marketplace-cli.test.ts` re-wrap. No new META_ tables; the parser
  is reused, not re-implemented.
- An operator can now install/uninstall a pack for a tenant and audit the ledger
  from one binary, with every write driven through the guarded lifecycle engine +
  RLS-scoped to the tenant. Resolving the installed pack's manifest into the
  tenant's *served* surface (the deeper integration) + a gated PG test are the
  follow-ups.
