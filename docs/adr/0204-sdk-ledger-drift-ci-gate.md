# ADR-0204: SDK-ledger drift CI gate (Phase 3 P3.49)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0203 (sdk-releases CLI), ADR-0201 (ledger CLI persistence), ADR-0160 (SLO-enforcement-drift gate), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.48 shipped `sdk-releases verify` (exits 1 on cross-table release↔compatibility
drift) — the same exit-1 contract the incident / gateway / SLO drift gates use. The
four existing self-policing CI gates make those audit ledgers fail the build on
inconsistency; the SDK ledger had a verifier but no gate.

## Decision

Add a sixth CI gate to `.github/workflows/ci.yml`'s `integration` job — an
**SDK-ledger drift gate** running after the gated suites:

```yaml
- name: SDK ledger drift gate
  run: node apps/operate-server/dist/bin/operate-server.js sdk-releases verify --limit 1000
```

It runs after the gated `integration-sdk-ledger.test.ts` suite (P3.46) persists a
`ClientRelease` + `CompatibilityEntry` to `meta.sdk_client_releases` /
`meta.sdk_compatibility_entries` under `openapi-client --persist`, so the gate
audits **real persisted rows** (non-vacuous). `verifySdkLedger` (P3.48) flags a
published release without a matching compatibility entry, a compatibility entry with
no matching release, or a published release marked `unsupported`/`blocked`, and the
CLI exits 1 on any. The gated suite persists a **draft** release + a
`fully_compatible` entry — consistent (drafts need no compat; the entry maps to its
release), so the gate is green; an empty ledger also verifies clean.

## Consequences

- **65 packages + 4 apps, 126 meta-schema tables, ~7,239 offline tests + 54 gated
  real-Postgres integration tests + six CI gates** (schema-drift, incident-drift,
  PHI-encryption, gateway-execution, slo-enforcement-drift, **sdk-ledger-drift**).
  CI-config only — no source/test change (the CLI + verifier shipped in P3.48; the
  bin's `sdk-releases` dispatch was confirmed offline). No new META_ tables.
- All four persisted audit ledgers (incidents, gateway executions, SLO tables, SDK
  ledger) are now self-policing in CI — inconsistency fails the build.
