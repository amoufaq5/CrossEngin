# ADR-0164: License minter draws caps from the plan catalog

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0160 (plan catalog), ADR-0154 (licensor CLI), ADR-0150 (offline license keys), ADR-0153 (plan record limits) |

## Context

`crossengin license mint --plan pro` recorded the plan **id** on the license but its record cap +
features had to be typed in by hand (`--max-records-per-entity`, `--features`) — so an on-prem
license could silently disagree with what the cloud path resolves for the same plan. The plan
catalog (ADR-0160) is now the single source of plan → limits; the minter should draw from it.

## Decision

- **`license mint --plan <id>` resolves caps + features from the plan catalog.** With `--plan`,
  the minter looks the plan up (`catalog.limitsFor(planId)`) and fills the license claims'
  `maxRecordsPerEntity` + `features` from it. The default is `DEFAULT_PLAN_CATALOG`;
  `--plan-catalog <file>` loads a deployment's own `{plans:[...]}` document (a parse/read failure
  exits 1 with a clear message).
- **Explicit flags still win.** `--max-records-per-entity` / `--features`, when given, override the
  catalog value — so an operator can still mint a bespoke license, but the *common* case (`--plan
  pro`) needs no cap arithmetic.
- **`license inspect`** now prints the cap (`cap: N records/entity`) alongside the plan, so a
  minted license's resolved limits are visible without decoding the token.

## Consequences

- On-prem and cloud now draw plan limits from **one** source: the same `pro` plan yields the same
  cap whether it arrives via a signed license or a Stripe webhook. No drift between deployment
  modes.
- The minter's ergonomics improve — `--plan pro` is enough; the cap comes along for free.
- Backward compatible: a mint with no `--plan` (or an unknown plan id) behaves exactly as before,
  and explicit limit flags are unchanged.
- 6,765 tests pass (+2: `--plan` resolves the catalog cap + features; explicit
  `--max-records-per-entity` overrides it). Full build + typecheck green.
- Follow-up: a real `COUNT(*)` store method for exact large-tenant usage (the last small billing
  follow-up).
