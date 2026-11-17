# ADR-0423: The document store enforces `unique` and `reference`

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0360 (the column store's unique indexes, and "0 of 32 enforced" on `--store pg`), ADR-0424 (the confined role, which cannot create these indexes), ADR-0121 (the GL account fallback), ADR-0359 (a wrong answer is worse than a refusal) |

## Context

**H-09**: on `--store pg` — the shipped compose default — `meta.operate_entity_records` is one table
for every entity, whose only UNIQUE is `(tenant_id, entity, record_id)`. So the store enforced
**none** of a manifest's 32 `unique` declarations and **none** of its reference fields. Register
P0.7's correction had measured the consequence: two invoices with one `invoice_number` both answer
201, both `send`, and the GL holds two entries under that number. A reference could name a record
that never existed, or one deleted afterwards.

## Decision

`document-integrity.ts` gives the document store the column store's two guarantees:

- **Uniqueness** by one partial unique *expression* index per (entity, field) —
  `(tenant_id, …scope, (document ->> 'field')) WHERE entity = 'E'` — created from the served
  manifest, so the race is the database's and a duplicate is **409 `unique_violation`**. Index names
  share `DOCUMENT_RUNTIME_INDEX_PREFIX`, which the catalog declares as `runtimeIndexPrefix` on
  `META_OPERATE_ENTITY_RECORDS` so the reconciler does not report them as undeclared drift.
- **References** by one indexed lookup per written reference, taken `FOR KEY SHARE`; a dangling one
  is **422 `reference_not_found`**. On delete each reference's declared `onDelete` is applied as the
  column store's foreign key would: `restrict` → **409 `record_referenced`**, `cascade` deletes,
  `set_null` nulls. `--allow-dangling-references` turns the reference half off; the unique half
  stays.

**Who creates the indexes.** Postgres refuses `CREATE INDEX` — `IF NOT EXISTS` included — to a
non-owner with `42501`, and ADR-0424 makes the API a non-owner. So index creation is a separate
owner-run step, `operate-server document-indexes --pack <pack>`, which the compose runs as the
one-shot `document-indexes` service between `migrate` and `api`, with the same `--pack`. At boot the
API **reads back** what exists: an index that is present and valid counts as enforced even though
this role could not have built it, and `[unique]` reports `N of M enforced`.

**A server-created reference that does not resolve is a named 409.** H-09 turned register P2.18 on
`--store pg` from a silently dangling GL reference into a refusal — the literal fallback account
codes (`"accounts_receivable"`, …) now fail the reference check. That was a bare 500 naming nothing.
`writeTxn` now answers **409 `server_reference_unresolved`** naming the entity, field and target,
and for a `LedgerAccount` target names the remedy: set the tenant's finance account codes. Nothing is
written; the invoice stays draft.

## Alternatives considered

- **Create the indexes from the API at boot.** Impossible under ADR-0424 without giving the API
  ownership back, which is the thing that increment removes.
- **A per-entity table on `--store pg`.** That is `--store pg-columns`.

## Consequences

`--store pg` and `--store pg-columns` now answer a duplicate and a dangling reference the same way.
A tenant with no finance settings cannot send an invoice on either store and is told why — on
`pg` it used to succeed with a GL line pointing at nothing.

## Implementation notes

Verified live on PG 16 in compose order: `document-indexes` as the app role exits 1 with 0/32
enforced (`not_owner`); as the owner 32/32, idempotent; the API boots with `[unique] 32 of 32
enforced` and `[references] enforced, 78 fields`. Duplicate → 409, dangling → 422, delete of a
referenced record → 409; an unconfigured tenant's `send` → 409 `server_reference_unresolved` with
the remedy and the invoice still draft, then 200 `sent` after configuring the codes.

## Open questions

1. A tenant's own activated manifest gets no indexes until an operator re-runs the step with that
   manifest — the step takes the boot pack.
2. P2.18's ledger question (refuse versus keep a fallback) is answered by refusal on both stores;
   whether the Architect should provision default ledger accounts is open.

## References

- `packages/operate-runtime-pg/src/document-integrity.ts`, `store.ts`;
  `apps/operate-server/src/node.ts` (`runDocumentIndexes`); `deploy/docker-compose.yml`
