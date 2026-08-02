# ADR-0152: `operate-server --license` — offline entitlement at boot

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0150 (offline license keys), ADR-0149 (entitlement gate), ADR-0087 (operate-server) |

## Context

ADR-0150 shipped `LicenseEntitlementResolver` (verify a signed license offline), and ADR-0149
the gate that consumes an `EntitlementResolver`. What was missing was the boot wiring — a way
to actually run an on-prem `operate-server` gated by a license file, with no cloud call.

## Decision

- **CLI (`cli.ts`).** Two flags: `--license <file>` (path to the Ed25519 license token) and
  `--license-key <base64>` (the licensor's public key). `--license` requires `--license-key`
  (can't verify without it); both default to null. Added to the help text.
- **Boot (`node.ts serve()`).** When both are set, reads the token file and constructs a
  `LicenseEntitlementResolver(token, publicKey)`, passed as `entitlementResolver` into
  `buildOperateHttpServer`.
- **Wiring (`server.ts`).** `BuildOperateHttpServerOptions.entitlementResolver` threads into
  `buildOperateGateway`'s gate. Omitted → ungated (unchanged).

## Consequences

- `operate-server --pack … --license tenant.lic --license-key <pub>` runs a fully on-prem,
  subscription-gated server: an active license serves, a canceled/expired/wrong-tenant
  license yields 402 — no network dependency. Proven end-to-end over raw HTTP (active → 200,
  canceled → 402 `subscription_canceled`, other-tenant → 402 `no_subscription`).
- The offline-licensing arc is now usable end to end: mint (`signLicense`) → distribute →
  `--license` at boot → gate enforces.
- 6,644 tests pass (+6: CLI parse + validation, and the three raw-HTTP license cases). Full
  build + typecheck green.
- Follow-ups: a licensor CLI (`crossengin license mint/rotate`); reload the license without a
  restart; a short post-expiry grace window.
