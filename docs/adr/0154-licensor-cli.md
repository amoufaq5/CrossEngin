# ADR-0154: Licensor CLI (`crossengin license`)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0150 (offline license keys), ADR-0152 (`operate-server --license`) |

## Context

Offline licenses (ADR-0150) and the `--license` boot flag (ADR-0152) work, but minting a
license meant hand-writing a `signLicense` call in code. On-prem operators / the licensor
need a first-class tool to generate keys and mint/inspect licenses.

## Decision

A `license` subcommand on the existing `crossengin` CLI (`apps/architect-cli`), with three
actions (positional):

- **`keygen`** → an Ed25519 keypair (`generateEd25519Keypair`). The public key ships to
  operators via `operate-server --license-key`; the private key stays with the licensor.
- **`mint`** → `signLicense` over claims assembled from flags: `--tenant`, `--status`
  (default `active`), `--plan`, `--expires` (ISO, required), `--issued` (default now),
  `--max-records-per-entity`, `--features` (comma list), `--private-key`, `--public-key`.
  Prints the token (or `{token, claims}` with `--format json`). Missing required flags → exit 2.
- **`inspect`** `<token> --public-key <b64>` → `verifyLicense`, printing validity + claims
  (or the failure reason); exit 0 when valid, 1 when not.

Adds `@crossengin/crypto` + `@crossengin/operate-runtime` as `architect-cli` deps.

## Consequences

- The offline-licensing loop is now operator-complete and toolless-free: `crossengin license
  keygen` → `mint` → hand the token to a customer → `operate-server --license tenant.lic
  --license-key <pub>`. Verified end-to-end through the built binary.
- `inspect` gives operators a way to audit a license (tenant, status, expiry) and its
  validity before deploying it.
- 6,658 tests pass (+7: keygen, mint→inspect round-trip, expired + tampered detection,
  missing-flag/usage exits). Full build + typecheck green.
- Follow-ups: a `rotate`/`revoke` story (needs a revocation list or short expiries); reading
  the private key from a file / env instead of an argv flag (avoids shell history exposure).
