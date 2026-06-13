# ADR-0231: marketplace publish registry (Phase 3 P7.7)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0228 (gated install), ADR-0081 (marketplace install runtime), ADR-0026 (marketplace + extensions) |

## Context

P7.4/P7.5/P7.6 built the **install** half ("…installs the upgrade into a sandbox tenant").
The **publish** half ("the agent publishes…") had no runtime — the `marketplace` package
ships the pack-version *contracts* (`PackVersionRecord`, the draft → in_review → published →
deprecated/withdrawn lifecycle + `canTransitionVersion`, signatures, the security-review
gate) and the meta-schema already has a column-mapped `meta.pack_versions` table, but nothing
drove the lifecycle or persisted it.

## Decision

A publish engine + a registry store in `@crossengin/marketplace-pg` over the **pre-existing**
`meta.pack_versions` table (no new META table):

- **`publish-engine.ts`** (pure): `newPackVersionDraft(input)` mints a `draft`;
  `transitionPackVersion(record, to, patch)` applies a **guarded** transition
  (`IllegalVersionTransitionError` on an illegal from→to) re-validated through
  `PackVersionRecordSchema` (so published⇒publishedAt/By, deprecated⇒deprecatedAt/Reason,
  the stable-channel-requires-passed-review invariant always hold); named helpers
  `submitForReview` / `recordSecurityReview` / `publishPackVersion` / `deprecatePackVersion`
  / `withdrawPackVersion` drive the lifecycle. A `stable` publish without a `passed`/`exempt`
  review is rejected by the schema.
- **`pack-version-store.ts`**: `PostgresPackVersionStore` — `record` upserts on
  `(pack_id, version)` (signature as `$N::jsonb`), `get` / `listForPack` reconstruct through
  the schema (BIGINT size → number, JSONB signature, `Date` → ISO, null optional columns
  omitted), `latestPublished(packId, channel?)` reuses the contract's `latestPublishedVersion`.
  The table is platform-wide (a pack is published globally, then installed per-tenant), so
  no RLS / tenant context.

## Consequences

- **72 packages + 4 apps, 128 meta-schema tables, ~7,464 offline tests + 61 gated
  real-Postgres integration tests.** No new META_ tables (reuses `meta.pack_versions`). New
  tests: `publish-engine.test.ts` (5 — draft→review→publish, illegal transition, stable
  publish blocked without a review then allowed with one, deprecate+withdraw) +
  `pack-version-store.test.ts` (6 — row reconstruction incl. null-optional omission + a
  deprecated row, upsert SQL shape, `get`, `latestPublished` semver pick) + a gated
  `integration-publish.test.ts` (publish two versions → read back, `latestPublished` picks
  the higher semver — green on live Postgres 16). Fixed a flaky test pack-id generator (a
  base36 random suffix could start with a digit, violating the pack-id regex).
- The publish half of the P7 exit criterion is now real: the registry holds the published
  pack lifecycle, queryable by latest-published-per-channel. Wiring publish into an
  agent/CLI surface (so "the agent publishes" is one command/tool) is the natural follow-up;
  **P7 is otherwise complete.**
