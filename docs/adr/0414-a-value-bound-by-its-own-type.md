# ADR-0414: A value bound by its own type

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0359 (two stores answering one request oppositely, and `writeTxn`'s fixed 500 body), ADR-0332 (a `decimal` crosses the wire one way on both stores), ADR-0392 (the OpenAPI document, and where `file` was first described), ADR-0334 (`duration` refused at plan time — `UNDECIDED_SQL_TYPES`), ADR-0338 (the encrypt-at-rest write path), ADR-0333 (a fake connection asserts the SQL string and nothing past it) |

## Context

Measuring register P1.5 (*no object storage anywhere*) asked what erp-core's one `file` field —
`Expense.receipt` (`pack-erp-core/src/entities-finance.ts:156`) — accepts today. The measurement's
first answer was *"on every store kind, the server accepts any JSON for `Expense.receipt` and
answers 201"*. That is **false on `--store pg-columns`**, and a refuter had already measured why, at
the node-postgres layer only. Reproducing it through the store and through the HTTP route made it
wider than either had it.

### The defect

`ColumnMappedEntityStore.writePlaceholder` bound a plaintext column's value raw
(`params.push(bound)`). node-postgres serialises a parameter by its **JS** type, not by the
column's: an object becomes JSON text, a string goes out as bare text, and an array goes out as a
Postgres array literal. Against a `JSONB` column — the column the kernel plans for the `json`,
`file` and `currency_amount` kinds — three of those shapes are not JSON at all.

Measured on PG 16 as the non-owner `serving` role, through `ColumnMappedEntityStore`, over a probe
manifest carrying one field of each kind plus an `array<json>` field:

| value | `--store pg-columns` before | `--store pg` |
|---|---|---|
| `"t_abc/receipts/f1.pdf"` | `22P02 invalid input syntax for type json`, create **and** update | round-trips |
| `""` | `22P02`, create and update | round-trips |
| `["a",1]`, `[{"a":"x"}]` | `22P02`, create and update | round-trips |
| `'{"a":1}'` (a string holding JSON text) | create echoes the string; every read returns the **object** `{"a":1}` | round-trips as the string |
| `42`, `true`, `{"key":"k","n":[1]}` | round-trips | round-trips |
| `array<json>` = `["a","b"]` or `["a",{"b":2},3,null]` | `22P02` | round-trips |

The same before-and-after held for all three JSONB-typed kinds. Through the route, on erp-core:
`POST /v1/expenses` with `receipt` set to `"t_abc/receipts/f1.pdf"`, `["a",1]` or `""` answered
**`500 {"error":"write_failed","detail":"the write could not be completed"}`**, and `PATCH` answered
the same. `{"key":"k"}`, `42` and `null` answered 201. On `--store pg` all six answered 201 on
`POST` and 200 on `PATCH`.

Three things made it sharper than a 500:

- **The string was the shape the document published.** The OpenAPI schema for a `file` field was
  `{type: "string", description: "A file reference."}` — so the one shape a generated client would
  send was one of the shapes that failed, and the shape that succeeded (`{"key":"k"}`) was one the
  document declared invalid.
- **The JSON-text string is a wrong answer, not an error.** It stored, the create response handed
  back the string the caller sent, and every later read returned a parsed object. The create echo
  and the read disagreed about one write, and nothing raised.
- **The 500 named nothing.** `writeTxn`'s body is a fixed sentence by design (ADR-0359), so a caller
  told `write_failed` had no way to learn that the value's *shape* was the cause, and no remedy short
  of guessing a different shape.

### Why nothing caught it

The refuter's claim that **no write test covered a JSONB kind** is confirmed. `store-parity.test.ts`'s
`Probe` entity declares `f_json`, `f_file` and `f_currency_amount` and drove only `listPage` — a grep
for `create(` / `update(` in that file returned nothing before this change — and `column-store.test.ts`
declared no JSONB kind at all. And a fake connection could not have seen it anyway: it records
`{sql, params}` and never asks Postgres to parse `params[n]` as `json`, which is ADR-0333's boundary
exactly. The 87 existing tests across those two files pass against the fixed code before any new test
was added, which is the measure of how little they reached.

## Decision

**A JSON value must round-trip through both Postgres stores whatever its shape.** On the plaintext
write path, `writePlaceholder` now asks `jsonbBinding(mapping, bound)` before the raw bind:

- a `JSONB` column binds `JSON.stringify(value)` with `$n::jsonb`;
- a `JSONB[]` column binds **one JSON text per element** with `$n::jsonb[]`, so a string element
  survives too;
- a JS `null` returns `null` from the helper and stays **SQL NULL** — which is what it bound to
  before — rather than becoming JSON `null`.

This **converges on the document store's own idiom** rather than inventing one: `entity-ops.ts:159-160`
and `:181-182` bind `JSON.stringify(stored)` / `JSON.stringify(merged)` with `$4::jsonb`. The
encrypt-at-rest branch above it is **unchanged**, on purpose (see open question 1).

**The OpenAPI `file` schema drops `type: "string"`** and takes the description-only shape `json` and
`currency_amount` already had: *"Any JSON value. Its shape is not validated, and the server does not
resolve it to stored file content."* Both clauses are true on every store — `FIELD_TYPE_CHECKS.file`
is `acceptAny` (`validation.ts:221`, which is `() => null`), and this binary has no object storage, so
nothing resolves a value to file content. The document says less rather than something false; what a
file value *is* stays undecided, and that is register P1.5's own question.

That `type: "string"` was **wrong when written** rather than drifted: `git log -S` puts it in
`b1b27a5`, the commit that derived the body schema (ADR-0392's increment), and the validator's
`file` check is `acceptAny`, so the published constraint was enforced by nothing on any store.

## Consequences

**Verified live** (slice A), on a PG 16 cluster as the non-owner `serving` role, with two
operate-servers from the built tree — `--store pg-columns` and `--store pg`:

- **Store level, before and after.** Before: every row of the table above. After rebuilding
  `operate-runtime-pg`: every non-null shape round-trips unchanged on create, get and update on
  `--store pg-columns`, with **0** errors on that arm. `array<json>`, including mixed elements
  `["a",{"b":2},3,null]`, round-trips on create and get; its update was **not probed** (the probe's
  `array<json>` loop issues a create and a get only). `null` is echoed by create and reads back
  **absent** on get and on get-after-update, which is the pre-existing null-versus-absent gap in
  open question 4. `jsonb_typeof(f_file)` reports `string` for the string values, and **0** rows
  hold JSON `null` — a JS null is still SQL NULL.
- **HTTP, before and after.** All six `receipt` values answer 201 on `POST` and 200 on `PATCH` on
  `--store pg-columns`, and `GET` returns the same value `--store pg` returns for **five** of the six;
  `null` reads back absent on `--store pg-columns` where `--store pg` returns `null` — the
  pre-existing gap in open question 4, not this change.

**And independently by the orchestrator** on a separate PG 16 cluster at `51b81a7`, as `serving`
(`rolsuper f`, `rolbypassrls f`), booting both stores from the shipped compose flags minus the `--ai-design` family: on `--store pg`
all six values `POST` 201, `GET` the identical value, `PATCH` 200; on `--store pg-columns` all six
`POST` 201 and `PATCH` 200, and `GET` is identical for **five** — `null` reads back **absent**, which
is the pre-existing null-versus-absent gap below and not this change.

One harness defect is worth recording because it reads as a regression and is not one: the
store-level probe mints record ids deterministically, and between its two runs the column store's
table was reset while `meta.operate_entity_records` was not — the probe itself drops nothing, and the
before run had created rows under those same ids on both arms. The two together, not the determinism
alone, are why every one of the *after* run's **30** document-store rows collided (**57** `23505`
duplicate-key errors, since a shape row's create and its update arm's preliminary create both
collide and an `array<json>` row has only the create) and none of its column-store rows did. So the
`--store pg-columns` after-arm measured a fresh table. The document store's answers are
taken from the before run and from the HTTP after-run (`http-after-pg`), where all six values answer
201 / identical / 200. A destructive probe that leaves state behind makes its next run read the
previous run's rows (ADR-0400's measurement defect, again).

**Tests.** 52 new `column-store.test.ts` cases (among them 48 shape tests, a raw-control test, the
JSONB[] element binding and the JS-null case) plus a store-parity **write** fixture, whose JSONB
fields are **read off the column plan** rather than listed — so a fourth JSONB-typed kind lands in it
when the kernel maps one — with a floor asserting all three kinds are found, so the comparison cannot
be over nothing. Those two files: 87 → 141. `operate-runtime-pg` 714 across 24 files and
`operate-runtime` 1127 across 40, both typechecking clean.

**Mutation-checked four ways**, each restored by reverse replacement and confirmed byte-identical by
md5: disabling the JSONB bind fails **51 of 141** (all 48 shape tests, the raw-control test, the
JSONB[] test and the parity write test); binding JS null as JSON null fails 1; disabling the JSONB[]
branch fails 1; putting `type: "string"` back on the `file` schema fails 1.

**Not observed live:** the OpenAPI change. Slice A did not rebuild `operate-runtime`'s `dist`
(another slice was editing `compile.ts` in that package), so the document served by its servers
carried the old `file` schema; the change is fenced by its test and by the M4 mutation, and the
orchestrator's run did not probe `/v1/meta/openapi` for it.

## Alternatives

**Leave the cast off and rely on Postgres inferring the parameter type from the column.** Equivalent
at runtime for an `INSERT` into a typed column, and refused because it cannot be asserted in recorded
SQL: the parity fixture asserts `$3::jsonb` in the statement, which is the one thing a fake connection
can see.

**Bind raw except for strings and arrays.** A per-shape special case, and it does not fix the worst
member: a JSON-text string would still be sent as text and re-parsed by Postgres into an object. Only
serialising **every** value is shape-independent.

**A `[files]` boot survey and a `FIELD_KIND_SERVING` map** (the measurement's proposal). Refused on the
refuter's finding that servability depends on **(kind, store)** and not on the kind alone, so a
per-kind map would be wrong for one store whichever way it answered; and a survey that fires for every
tenant with no remedy an operator can act on is ADR-0334's remedy-that-cannot-work. Once both stores
accept every shape there is nothing left for it to report.

**A `PREFIX_REGEX` check on a file value.** Refused: its only consumer has no callers, so it would
constrain a value nothing reads.

## Open questions

1. **An encrypted JSONB-kind column loses the value's type on round trip.** `writePlaceholder`'s
   encrypt-at-rest branch binds `String(bound)` (`column-store.ts:847`), so on a `phi` `json` field
   `{a:1}` echoes `{a:1}` on create and reads back as `"[object Object]"`, `["x"]` reads back as `"x"`,
   and `7` as `"7"` — measured live with a 32-character key. **Latent:** across the seven pack sources
   **0** `phi`/`regulated` fields have a `json`, `file` or `currency_amount` kind. The fix is probably
   `JSON.stringify` on write and a parse on decrypt for a JSONB-kind encrypted column, which **changes
   the stored ciphertext format** and so wants its own increment — and until it lands, a manifest that
   classifies a JSONB field `phi` gets a wrong answer rather than a refusal.
2. **`geo_point` and `geo_polygon` raise `42704` at `ensureSchema` on `--store pg-columns`.**
   `columnPlansForManifest` plans `geography(POINT)` / `geography(POLYGON)` with no refusal, and on a
   cluster without PostGIS (absent from `pg_available_extensions` on the one measured) the schema
   application raises `type "geography" does not exist`. `UNDECIDED_SQL_TYPES` (`column-plan.ts:105`)
   holds only `INTERVAL`, so this wants `duration`'s treatment from ADR-0334: a refusal at plan time
   naming the entity and field, or a provisioning check. Measured **0** geo declarations in the seven
   pack sources, and `ai-design.ts` does not offer the geo kinds, so it is reachable only from a
   hand-written manifest.
3. **210 erp-core fields publish `type: "string"` and accept the JSON number `42`.** Measured over
   erp-core's 426 own fields against the pre-change `operate-runtime` build: 407 publish
   `type: "string"`, 291 admit `42`, and by kind those are text 111, reference 78, decimal 80,
   long_text 11, country_code 5, phone 4, url 1, file 1. `decimal` coerces by design (ADR-0332), so
   excluding it the figure was **211**, and **210** once `file` stopped publishing a type. As a control,
   the other 116 string-published fields refused `42`. Closing it is a decision rather than a fix —
   enforce the type in `checkTextLength`, which changes what a working deployment accepts (ADR-0338's
   premise read the other way), or loosen the published schema — and it is its own register item.
4. **`null` reads back present on `--store pg` and absent on `--store pg-columns`, for every field
   kind.** `rowToRecord` keeps a column only `if (v !== undefined && v !== null)`
   (`column-store.ts:1152`), so a field set to `null` is omitted on the typed store while the document
   store returns `receipt: null`. Seen in slice A's run and again in the orchestrator's. Pre-existing
   and not specific to JSONB; changing it touches every column-store read and its tests, and whether a
   client should see *absent* and *null* as one fact is ADR-0331's distinction applied to a record
   rather than a decision this increment should make in passing.
5. **The parity suite still compares only what a fake can see.** The new write fixture asserts the
   bound text parses back to the caller's value in both stores; it cannot assert that Postgres accepts
   it, which is what failed. A live parity run per field kind — the shape this increment verified by
   hand — is what found this, and nothing runs one.
