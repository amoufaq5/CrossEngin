# ADR-0377: A cursor carries what the ordering does not

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-20 |
| **Authors** | platform |
| **Reviewers** | platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0338 (at-rest PHI), ADR-0345 (row filtering and the cursor), ADR-0346 (sealing the cursor), ADR-0357 (the disclosure, surveyed and reported), ADR-0359 (a surface whose drop changes which rows), ADR-0376 (the deployment's defaults) |

## Context

ADR-0357 measured that `keysetOf` maps over the **whole declared sort** and renders the value from
the record, so `?sort=<classified field>` hands that field's plaintext back in `nextCursor` inside a
response whose body the gateway has just redacted on the same caller's grants. It surveyed the
members, reported them at boot, and fixed nothing — on the stated grounds that a refusal would
refuse every deployment there is and that the available hatch concedes more than the finding asks
for.

Two things were then left half-true, and both are the register's P0 item 2.

**The mitigation was one environment variable, and the canonical quickstart told the operator to
leave it unset.** `deploy/.env.example` carries `COLUMN_ENCRYPTION_SECRET` and
`CURSOR_ENCRYPTION_SECRET` **commented out identically**, while `ORACLE.md`, `README.md` and
`VERCEL-SUPABASE.md` all treat the cursor one as required. So the register's "mitigated by one
variable and still open by default" understated it: the variable was not merely defaulted-empty in
compose, it was commented out in the file an operator copies.

**And ADR-0357's own write-up claimed a second defect that does not exist.** It recorded the column
store as *worse* than the document store, with "a soundness bug in the keyset beside the
disclosure", because `columnExpr` answers `unavailable` for an `encryptAtRest` column so `?sort=mrn`
is dropped from `ORDER BY` while the value is still in the record and still rendered into the
cursor. The disclosure is real. The soundness claim is not.

## Decision

**A cursor may carry a position the ordering actually describes, and nothing else.**

Two parts.

**1. `CURSOR_ENCRYPTION_SECRET` is uncommented in `deploy/.env.example`, with a generator line, and
named in `README.md`'s first-launch list beside the two login secrets.** The asymmetry with
`COLUMN_ENCRYPTION_SECRET` — which stays commented — is measured on the pack this compose serves
rather than chosen: resolved `erp-core` declares **0** `phi`/`regulated` fields and **1** classified
field a list view can sort by. So the at-rest secret is genuinely not needed here and the cursor
secret is.

*Rule: a secret whose absence is a live disclosure on the pack this compose serves belongs in the
set an operator is handed filled in, not in the set they are told to leave alone.*

**1b. And an unreplaced placeholder is refused at boot, which is what makes 1 safe and is the
sharpest thing in the increment.** An adversarial pass over part 1 *as first written* found that it
shipped a falsely-true control, and it was right: `REPLACE_WITH_32_PLUS_RANDOM_CHARS` is **33 bytes
with 19 distinct byte values**, above both of `refuseWeakSecret`'s floors (32 and 16), so
`parseCursorEncryptionSecret` **accepts it**. An operator running `cp .env.example .env` without
replacing that one line would have moved from a *true* `console.warn` naming the exact field and
remedy to a *false* `console.info` asserting "none of their values travels back in the clear", with
every cursor sealed under a key derivable from a string committed to a public repository — the
disclosure fully intact and its only alarm switched off by the line meant to close it. ADR-0337's
direction, created by the fix.

So `SECRET_PLACEHOLDER_PREFIX` and a third `COLUMN_SECRET_REFUSAL_REASONS` member,
`unreplaced_placeholder`, checked **first** in the one shared `refuseWeakSecret`. That closes the
cursor secret, the column secret **and the credential pepper** in one change — and the pepper was
**already live**: `OPERATE_TOKEN_SIGNING_KEY`'s placeholder is 31 characters and genuinely refused,
so the documented path is *verbatim copy → boot fails naming the signing key → replace that one
line → boot succeeds*, which leaves the pepper at the published placeholder on a `meta.users` that
has **no RLS**, i.e. the one thing ADR-0358 says makes a dump of that table insufficient.

*Rule: an entropy floor cannot see the one weakness a placeholder has, which is that it is
published — so the check is on the literal and not on its strength.*

**2. `nullDroppedSortComponents` blanks the cursor component of any sort key whose `ORDER BY` the
store had to drop**, applied by `ColumnMappedEntityStore` where it builds `nextCursor`. The
component is **nulled in place and never removed**, because `seekPredicate` indexes `cursor.k` by
the key's *declared* position and that indexing is ADR-0359's own fix for the
`?sort=mrn,family_name` mis-comparison; `null` is already a legal component, so no format moves.

And ADR-0357's soundness claim is **corrected in the code that carries it**: the dropped key
contributes no clause to `seekPredicate`, which builds from `usable` alone and pushes the id
tiebreaker unconditionally — so the component was read by nothing. It was **dead payload**, which is
what makes withholding it free, and the comment at the report site now says so instead of repeating
the claim.

## Alternatives considered

- **Option A: make the secret mandatory in the binary** — flip
  `CURSOR_DISCLOSURE_MAY_SERVE.plaintext_disclosing` to `false`.
  - **Pros:** closes it for every deployment, not only the one this file configures.
  - **Cons:** the refusal predicate is the same conjunction as ADR-0357's (a member exists ∧ no
    secret), and `erp-core` has a member while `erp-core` is the compose default — so
    `plaintext_disclosing` is the verdict on **every deployment there is** and the flip refuses all
    of them.
  - **Why not:** ADR-0334's reason `--tenant-status-gate` was opt-in, and ADR-0357's first ground is
    still decisive. A default in the file an operator edits gets the same outcome for the shipped
    stack at no cost to anyone else's.
- **Option B: have `keysetOf` render only the sort fields the `ORDER BY` applied.** The obvious
  place, since it is where the value is read.
  - **Pros:** one function, both stores.
  - **Cons:** refused by two measurements. On `--store pg` every field is expressible
    (`document ->> '<field>'`), so nothing is dropped and the option closes **0 of 14** members on
    the shipped store. And doing it anyway is *wrong* there: the JSONB seek would change from a real
    keyset to `document ->> 'mrn' IS NULL AND record_id > $2`, confining the walk to the NULL tail.
  - **Why not:** `keysetOf` knows neither the store nor which keys it dropped. That is exactly why
    the new function takes the `unserveable` list and lives beside `buildListSql`, and why the store
    applies it.
- **Option C: drop the component from the `k` array rather than nulling it.**
  - **Pros:** a shorter cursor, and arguably says "this key is not part of the position".
  - **Cons:** `seekPredicate` indexes `cursor.k[key.at]` by declared position, so a shifted array
    compares the next key's cursor value against this key's column — the defect ADR-0359's own
    comment names.
  - **Why not:** it re-opens a closed bug to save bytes.
- **Option D: split `--allow-cursor-disclosure` into a field hatch and a row hatch.** Measured: the
  one flag gates `cursorDisclosing` on `mode === "absent"`, so it concedes both this field
  disclosure *and* `cursor_discloses_withheld_rows`, which is about rows a caller was never shown.
  - **Pros:** a hatch may concede only the thing it is reached for, and this would retire the second
    of ADR-0357's two grounds for report-not-refuse.
  - **Cons:** three modules and a CLI surface, for a hatch no shipped configuration passes.
  - **Why not:** it is hatch hygiene rather than a disclosure, and it is the prerequisite for
    reconsidering Option A honestly — so it belongs with that reconsideration. Recorded as the first
    open question.

## Consequences

- **Positive:** an operator following the quickstart gets sealed cursors, so the field disclosure
  ADR-0357 surveyed is closed on the shipped stack rather than reported on it. And on
  `--store pg-columns` a dropped sort key no longer puts **decrypted PHI** in a token — the one
  place the disclosure survives sealing is a deployment that has not set the secret, where this part
  still holds.
- **Negative:** one more required secret in `.env`. A deployment that rotates it pays one 400 per
  cursor in flight and a restarted page walk, which `.env.example` says. And the placeholder
  refusal is a **boot-breaking change for a deployment already running on one** — which is correct
  in direction (a published secret is not a secret) and has a real cost for the pepper
  specifically: changing it makes every existing password unverifiable, so every user needs a new
  one. `.env.example` says that beside the variable, and it is the reason to set it correctly the
  first time rather than an argument against the refusal.
- **Neutral:** the dropped-key component changes from the record's value to `null` in a cursor
  clients are told is opaque. Nothing reads it; the walk is unchanged, which is measured.
- **Reversibility:** part 1 is a comment character. Part 2 is one call, and removing it is a
  **compile error** rather than a silent revert, because the import then goes unused under
  `noUnusedLocals` — which is how the mutation test below had to remove two things.

## Implementation notes

**Verified live** on PG 16.13 against a throwaway cluster, with the catalog fully applied, and the
before/after arms taken by reversing the edit, rebuilding, measuring, and restoring (sha256
byte-identical afterwards).

`--store pg-columns --pack erp-healthcare`, `COLUMN_ENCRYPTION_SECRET` set,
`CURSOR_ENCRYPTION_SECRET` unset, three `Patient` rows whose `mrn` is `bytea` beginning `c30d04`.
`front_desk` holds `Patient.list` and `Patient.read` and is **not** in `mrn.read`:

| | `GET /v1/patients?sort=mrn&limit=1` as `front_desk` |
|---|---|
| **before** | body has no `mrn`; `nextCursor` decodes to `{"k":["MRN-SECRET-1"],"id":"rec_…"}` |
| **after** | body has no `mrn`; `nextCursor` decodes to `{"k":[null],"id":"rec_…"}` |
| **after, walk** | 3 ids visited, 3 distinct, terminated on a null cursor |
| **after, `clinician`** | `mrn` in the body; cursor also `{"k":[null],…}` — the ordering was dropped for both |

And part 1, on `--store pg --pack erp-core`, the shipped pair, same binary:

| | boot line |
|---|---|
| secret unset | `[cursor] cursor disclosure: plaintext_disclosing — 1 classified field(s) … Employee.work_email (pii)` |
| secret set | `[cursor] cursor disclosure: sealed — 1 classified field(s) … none of their values travels back in the clear: Employee.work_email (pii)` |

Six tests on the primitive, each naming what it fences: the blanking, that it is **in place and
never shortens** (the ADR-0359 indexing), that it is the **identity** when nothing was dropped so
the JSONB store pays nothing (asserted by object identity, not equality), that a `filter` or
`search` surface is ignored (those are refused before a cursor exists), that the `id` is left, and
that a sort key absent from the cursor invents no component.

The placeholder refusal, verified live on the same binary:
`fatal: list-cursor encryption secret refused (unreplaced_placeholder): secret is still the
placeholder from deploy/.env.example; generate one with node -e '…randomBytes(32)…'`. Six tests on
it, the load-bearing one being that the placeholder **passes both floors** — so the refusal cannot
later be deleted on the grounds that the entropy checks already cover it — plus that all three
parsers answer the same reason, that it is checked before the floors (a 14-character placeholder
would otherwise answer `too_short` and send an operator to lengthen a string they should be
deleting), that the message names the generator and discloses no part of the secret, and that the
marker is anchored at the start so a generated secret containing it is not refused. And four more
in `deployment-defaults.test.ts`, which is a cross-package read for a stated reason: it is what
makes "ship the cursor secret uncommented" honest, so the two have to be asserted together.

One observation from the live run that is **not** this increment's: `POST /v1/employees` omitting
the required `currency` reference answers `500 {"error":"write_failed","detail":"the write could
not be completed"}` with no field named — ADR-0359's open question 3 reached by hand, on the store
this change does not touch.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Split `--allow-cursor-disclosure` into a field hatch and a row hatch, and then reconsider whether the secret should be required in the binary. The two are one piece of work: the hatch is what makes a refusal arguable, because today accepting the field disclosure also accepts `cursor_discloses_withheld_rows`. | platform | 2026-11-30 |
| A deployment that has not set the secret is still disclosing on 14 (pack, field) pairs, 8 distinct, at least one in every pack. Part 2 covers only the subset the column store drops. Nothing surveys this per *tenant* manifest either (ADR-0357's own open end). | platform | 2026-11-30 |
| `?sort=<classified field>` is still *accepted* on a field the caller cannot read, and the ordering it reveals is a channel neither this nor ADR-0345 widened or closed. ADR-0345 refuses it only while rows are being withheld. Whether to refuse it generally is undecided. | platform | _unscheduled_ |
| Decrypt-and-compare would make an encrypted column genuinely sortable and filterable rather than silently dropped (ADR-0338's open end 6). Correct, unindexed, and a sequential scan with a decrypt per row — worth it for `eq` on a unique field and not for `contains` or an `ORDER BY`. | platform | _unscheduled_ |

## References

- `packages/operate-runtime-pg/src/list-sql.ts` — `nullDroppedSortComponents`, and the corrected
  comment at the `surface: "sort"` report site
- `packages/operate-runtime-pg/src/column-store.ts` — the call at `nextCursor`
- `packages/operate-runtime/src/store.ts` — `keysetOf`, left alone and why
- `deploy/.env.example`, `deploy/README.md`
- ADR-0338, ADR-0345, ADR-0346, ADR-0357, ADR-0359, ADR-0376
