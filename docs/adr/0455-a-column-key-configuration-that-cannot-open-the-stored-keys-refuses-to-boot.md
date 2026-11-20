# ADR-0455: A column-key configuration that cannot open the stored keys refuses to boot

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0331 (an absence of evidence is not evidence), ADR-0338 (derived column keys; refuse only what serves nothing correctly), ADR-0347 (the data-key envelope, `seeded_from_derived`), ADR-0349 (the rekey writes `random`), ADR-0362 (ask Postgres whether a session is confined), ADR-0372 (no falsely-true control), ADR-0373 (one bad row must not take the page), ADR-0424 (the API connects as the confined `crossengin_app`), ADR-0445 (the column-secret ring; this closes its first open question) |

## Context

ADR-0445's first open question, found live: two column-key configurations boot clean and then
answer every PHI request for the affected tenants with an opaque 500, explained only in the log.

1. **`--column-key-mode derived` over stored data keys.** Derived mode computes every column key
   from `COLUMN_ENCRYPTION_SECRET` and never reads `meta.tenant_data_keys`. A tenant whose current
   row is `random` — a rekey wrote it (ADR-0349), or envelope mode provisioned it — has its columns
   under a key derived mode cannot compute. Reads fail; worse, **writes succeed**, under the derived
   key, so the tenant's columns split across two keys with nothing on any row recording which.
2. **A new `COLUMN_ENCRYPTION_SECRET` with rows still wrapped under the old one and no
   `COLUMN_ENCRYPTION_SECRET_PREVIOUS`.** With the generation bumped, the rows record a KEK
   generation the ring holds no secret for (`DataKeyKekUnavailable`); with it unbumped, the ring
   holds a secret for that generation and it is the wrong one (`DataKeyUnwrapFailed`).

The key rows are readable at boot and answer both questions without touching tenant data — except
for a tenant that holds ciphertext and **no** key row, about which no key row can say anything (a
replaced generation-1 secret with nothing stored reads as a clean, empty table). The other
complication is the read: `meta.tenant_data_keys` carries one isolation policy and **no platform
arm**, so the shipped `crossengin_app` role reads **zero rows** from an unscoped count, with no
error code — byte-identical to a deployment that holds no keys, which is the one answer this check
must never give falsely.

## Decision

**Both configurations refuse to boot**, through `column-key-consistency.ts`, called in
`resolveStore` right after the secret ring is resolved and before any key source is built, in both
modes. The refusal names the condition, the affected tenant count and the remedy, never a tenant id,
a secret or key bytes. Five refusing conditions:

| Condition | Mode | Established by |
|---|---|---|
| `derived_mode_over_random_keys` | derived | any tenant's current row has provenance `random` |
| `derived_secret_not_seed` | derived | a seeded row's key is not the key this secret derives |
| `kek_generation_unheld` | envelope | rows record a KEK generation the ring holds no secret for |
| `kek_secret_mismatch` | envelope | no sampled row at a held generation opens under the ring's secret for it |
| `ciphertext_key_mismatch` | both | ciphertext held by tenants with **no** key row opens under none of the keys this configuration would read it with |

`COLUMN_KEY_CONDITION_EFFECT` is a total map over every condition to `refuse` / `warn` /
`unknown`, so a new condition is a compile error rather than a branch nobody chose. (The first
draft of this sentence counted eight; there were nine, and with the ciphertext conditions there
are twelve — so the count is gone rather than corrected.)

**Decided from key rows, one sample set per generation, never from data rows.** The KEK is
`HKDF(secret, salt = tenantId, info = generation)`, so whether a secret is right for a generation is
a property of the secret, not of the tenant: one row opening proves it, a wrong secret opens none.
The survey reads each tenant's **current** (highest-generation) row grouped by (provenance, KEK
generation), with up to `SAMPLES_PER_GROUP = 32` sample rows per group **drawn at random per boot**
(`ORDER BY random()` unconfined, reservoir sampling on the per-tenant route), and opens only the
samples. A secret is called wrong only when **every** sample at that generation fails; samples that
disagree mean the secret is right and the failing rows are corrupt (`rows_unopenable`, a `warn`),
because the request path already refuses those tenants per tenant and refusing the deployment over
damaged rows refuses what works.

The first version sampled **three** rows, **the first three by tenant id**, and that was a defect a
review found: `meta.tenant_data_keys` carries one `ALL`-scope isolation policy and no `UPDATE` fence,
so a tenant-context session may rewrite its own `wrapped_key`, and three tenants at the head of the
id order corrupting their own rows would have turned into a permanent whole-deployment refusal on
every boot, with a remedy telling the operator their secret was wrong. Now a refusal needs every one
of 32 randomly chosen rows to fail — in a generation of 32 tenants or fewer, every row, when every
tenant there fails anyway.

The `kek_secret_mismatch` remedy is branched on which secret is wrong: the previous one (the
generation is already right, so only its value is), the current one mid-rotation (a second rotation
would drop the previous generation's rows), or the current one with no rotation in progress (which
may have been meant as one). The first version gave the third advice in all three, which in the
first case described the configuration already in place.

**A tenant with no key row is checked from one ciphertext value.** In derived mode every such tenant
is read under `deriveTenantColumnKey(COLUMN_ENCRYPTION_SECRET, tenant)`; in envelope mode its first
data key is **seeded** from `seedSecretOf(ring)` and `ensure` never revisits a row — so a wrong
generation-1 secret is a 500 per PHI read in derived mode and a **permanent** mis-seed in envelope
mode. `checkKeylessCiphertext` reads, from the boot data schema's at-rest columns
(`introspectEncryptedColumns`, `bytea` only), one stored ciphertext value per tenant that has no key
row, and asks pgcrypto whether the key that tenant would be read under opens it
(`octet_length(pgp_sym_decrypt_bytea($1, $2))` — the plaintext never leaves the database, the key is
a bound parameter). It stops at the first that opens, tries at most
`KEYLESS_CIPHERTEXT_SAMPLES = 32` tenants, and refuses (`ciphertext_key_mismatch`) only when every
value tried was refused with pgcrypto's own SQLSTATE `39000`; any other error (pgcrypto absent,
`42883`) makes the check `ciphertext_unchecked`, an `unknown` line. On a confined session each
tenant is read under its own context and the decrypt runs inside a savepoint, because pgcrypto's
refusal is an error that would abort the scan. It asks the boot schema the column store writes to and
**not** per-tenant manifest schemas (`t_<uuid>`), and the consistent line says so.

Envelope mode at a generation where the ring no longer holds the seed secret
(`ColumnKeySeedUnavailable`, ADR-0445) is **`ciphertext_seed_unheld`, a `warn`**: those tenants are
refused per request by name and nothing is written, and the only remedy — the generation-1 secret
back as the previous one — would leave every row at a later generation unheld, so a boot refusal
would trade a per-tenant refusal for a whole-deployment one with no configuration that clears it.

**Derived mode over seeded rows is not refused when it can be shown harmless.** A
`seeded_from_derived` key *is* the derived key of the generation-1 secret (ADR-0347), so derived
mode reads that tenant correctly exactly when `COLUMN_ENCRYPTION_SECRET` is that secret — a rollback
from an envelope trial. The check opens a sample under `deriveTenantKek(current, tenant, g)` and
compares the key with `derivedSeed(current, tenant)` — the same function the seeding used, now
exported rather than restated:

- opens and equals → consistent;
- opens and differs → `derived_secret_not_seed` (at any generation);
- opens nowhere at KEK generation 1 → `derived_secret_not_seed`, because a generation-1 seeded row
  was both seeded from and wrapped by the generation-1 secret, so failing to open is proof;
- opens nowhere at KEK generation ≥ 2 → **`seed_unverifiable`**, an `unknown` line and not a
  refusal: the rows were re-wrapped by a later secret derived mode does not hold, and the current
  secret may well be the seed secret. The key rows cannot settle it, and decrypting a data row to
  settle it was judged not worth a second mechanism (below).

**Reading under RLS: ask Postgres, then read per tenant.** The survey asks
`row_security_active` (`probeSessionPolicyVisibility`, ADR-0362). Unconfined — the owner opt-out, or
a `BYPASSRLS` role — it reads every tenant in two statements. Confined — the shipped default — it
reads the tenant list from `meta.tenants` (no RLS, and every key row's tenant is there by the
foreign key) and each tenant's row under that tenant's own `app.current_tenant_id`, in one
transaction, two statements per tenant. That stops at `PER_TENANT_SURVEY_CEILING = 10,000` tenants
and says how many it did not examine (`survey_incomplete`). An unreadable table, an unreadable row
(`rows_unreadable`, via `readRowsWithUnreadable`, field path and issue code only) and an incomplete
survey are each an `unknown` **warn** line — never an all-clear (ADR-0331, ADR-0372) — and none
masks a refusal established over the tenants that were read.

**Said either way.** A consistent survey prints how many tenants hold a stored key and what was
proved; an unknown one prints only warn lines, so "checked and fine" is distinguishable from "not
checked" in the log.

**No escape hatch.** ADR-0338's test is whether the degraded state is coherent. Derived mode over a
random key is not degraded but **destructive**: its writes split a tenant's columns across two keys
irreversibly. The envelope conditions are not destructive, but there is no degraded mode worth a
flag either: every remedy is a configuration change the operator already holds (set the previous
secret, restore the old one, switch the mode back), and a flag would buy only the 500s this exists
to replace. The `unknown` arm is the one place the check yields, and it yields by booting with a
warning rather than by a flag.

## Alternatives considered

- **Answer a tenant with no key row with an `unknown` line instead of decrypting.**
  - **Pros:** no new mechanism; key rows only.
  - **Cons:** the case it leaves is the one the slice names — a replaced generation-1 secret with no
    key rows — and in envelope mode booting under it mis-seeds every such tenant permanently. The
    first version of this ADR did not even say `unknown`: it printed `consistent — no stored data key
    rows`, a line that reads as a verdict, and claimed the gap was covered by
    `ColumnKeySeedUnavailable`, which is thrown only when `seedSecretOf` answers `null` and never for
    a wrong generation-1 secret.
  - **Why not:** the decrypt needs no column plan (the catalog says which columns are at-rest), so
    the mechanism is one catalog read and one value per tenant.
- **Decrypt one data row per tenant to settle `seed_unverifiable` too.**
  - **Pros:** closes the last case key rows cannot answer; the mechanism now exists.
  - **Cons:** a second use of it for one rollback shape (envelope rotation, then back to derived
    holding the generation-1 secret) that is itself incoherent to keep running.
  - **Why not here:** left an `unknown` line and an open question.
- **Refuse derived mode whenever any key row exists.**
  - **Pros:** simplest; no unwrapping.
  - **Cons:** refuses the one coherent case — rolling back an envelope trial whose tenants were all
    seeded — which serves correctly.
  - **Why not:** ADR-0338's rule; the refusal would break something that works.
- **Count rows with one unscoped query.**
  - **Pros:** one round trip.
  - **Cons:** as the confined `crossengin_app` it answers 0 with no error, i.e. a false all-clear on
    the shipped stack.
  - **Why not:** that is the silent zero ADR-0333 and ADR-0400 record; the confinement is asked and
    the confined route reads per tenant.
- **Probe every tenant's key instead of sampling per generation.**
  - **Pros:** would name every corrupt row.
  - **Cons:** one AEAD open and one HKDF per tenant on every boot, for no added verdict: the
    secret's correctness is a per-generation fact.
  - **Why not:** sampling three per group answers the question; per-tenant corruption is the
    request path's refusal.
- **Refuse on `unknown`.**
  - **Pros:** no deployment boots unverified.
  - **Cons:** a database that is merely not up yet, or a role missing `SELECT` on `meta.tenants`,
    would refuse a deployment that serves correctly.
  - **Why not:** ADR-0334's asymmetry between `missing` and `unreachable`; a refusal on an
    unestablished fact refuses what works.

## Consequences

- **Positive:** both configurations from ADR-0445's open question are boot failures naming the
  condition, the tenant count and the remedy, instead of a clean boot and a 500 per PHI request;
  derived mode can no longer start writing a random-keyed tenant's columns under a second key.
- **Negative:**
  - **Boot latency proportional to the tenant count, on the shipped confined role, on every
    `pg-columns` boot — including a derived deployment with no key row.** The key survey is two
    statements per tenant and the keyless-ciphertext check up to two more (until a value opens).
    Measured on a throwaway PG 16.15 over loopback as a `NOSUPERUSER NOBYPASSRLS` role with 10,000
    tenants and no ciphertext — the worst case, since nothing stops the second scan early — the key
    survey took **1.69 s** and the ciphertext check **1.76 s**; with ciphertext present the second
    stopped at the first tenant holding some (275 ms). That is ~0.08 ms per round trip; at a 1 ms
    round trip (a database across a network) it is ~40 s, which is the compose `api` healthcheck's
    `start_period: 40s`, so a large confined deployment on a remote database can be marked unhealthy
    before it listens. The unconfined route is two statements in total (12 ms). Not short-circuited:
    derived mode never *provisions* a key row, but an envelope trial that was rolled back did, and a
    confined role cannot tell an empty table from an unreadable one without asking per tenant.
  - Past `PER_TENANT_SURVEY_CEILING = 10,000` tenants the rest is `unknown`.
  - A generation whose every sampled row is corrupt (all of them, at 32 tenants or fewer) reads as
    `kek_secret_mismatch` — no sample can tell a wrong secret from a damaged row. Every tenant there
    fails either way; the remedy reads as a misconfiguration.
  - `seed_unverifiable` boots with a warning; if the secret is in fact wrong, those tenants still
    meet the 500.
  - Keyless ciphertext in a per-tenant manifest schema (`t_<uuid>`) is not checked; the consistent
    line says which schema was.
  - `ciphertext_seed_unheld` boots with a warning: those tenants are refused per request
    (`ColumnKeySeedUnavailable`), unchanged.
- **Neutral:** the unconfined route (the owner opt-out, or a `BYPASSRLS` role) costs a handful of
  statements however many tenants there are.
- **Reversibility:** code only; deleting the call in `resolveStore` restores the previous
  behaviour.

## Implementation notes

- New: `apps/operate-server/src/column-key-consistency.ts` (`surveyDataKeyRows`,
  `assessColumnKeyConsistency`, `formatColumnKeyConsistency`, `ColumnKeyConfigurationRefused`) and
  `checkKeylessCiphertext`, `keylessCiphertextSecret`) and its test (58 tests: each refusing arm,
  the clean controls in both modes, corrupt and unreadable rows, a wide corrupt minority, the
  reservoir drawing past the first tenants by id, each mismatch remedy's text, the derived
  rows-unopenable arm and its qualified line, every keyless-ciphertext arm against a fake that
  models RLS and pgcrypto's `39000`, the confined route's savepoints, no key material in the refusal,
  and a text fence that the survey, the ciphertext check and the throw precede
  `buildEnvelopeKeySource` and are gated on the ring, not the mode).
- Changed: `data-key-envelope.ts` exports `derivedSeed` (one definition of the seed key);
  `node.ts` calls the survey after `formatColumnSecretRing`.
- The survey never throws: a failed read is `readable: false`. A mapper's error message carries no
  row value, because `unreadableDetail` passes it through.
- Mutation-checked, each reversed: dropping the "opened and differs" arm (1 fails); `random` → warn
  (3); never taking the confined route (5); calling a mixed sample a mismatch (1); an off-by-one in
  the ceiling (1); never reporting an unheld generation (3). Review round: dropping the
  keyless-mismatch arm (4); ranking samples by `tenant_id` (1); disabling the reservoir (1); the
  previous-secret remedy (1); the unqualified derived line (1). Removing the unconfined scan's
  outer early `break` fails nothing and is deliberately unfenced: the inner loop enforces the same
  bound, so it is a cost bound and not a behaviour.
- Verified on a throwaway PG 16.15 (not through the booted binary): pgcrypto answers `39000` for a
  wrong key **and** for corrupt bytes; with three tenants' ciphertext under the generation-1 secret
  and no key row, the confined role and the owner both answer `consistent` under that secret and
  `CIPHERTEXT_KEY_MISMATCH` under a replaced one.
- `packages/testing` strategy rules: 784 passed, including `pg-unreadable-rows` (the first draft's
  two throwing maps were moved onto `readRowsWithUnreadable`) and `pg-column-coverage`.
- **Not verified through the booted binary.** The live plan is the confined `crossengin_app` arms in
  the orchestrator's verification stage.

### Verified live

PG 16 in compose order (extensions, migrate, `app-role.sql`, `column-schema --pack erp-healthcare
--grant-to crossengin_app`); the built server booted as `crossengin_app` (`rolsuper` f,
`rolbypassrls` f; `row_security_active('meta.tenant_data_keys')` t) with `--pack erp-healthcare
--store pg-columns`, tenants A and B, three 48-character secrets S1–S3.

- Controls booted (readyz 200): derived S1 on an empty table (`consistent — no stored data key
  rows`, POST patient 201); envelope S1 with A seeded and B random (`consistent — 2 tenant(s) …
  every key-encryption-key generation opened`, both GETs 200); derived S1 after an envelope trial
  that only seeded A (`consistent — 1 tenant(s) … every one is a seeded key this secret derives`,
  GET 200); envelope S2 at generation 2 with S1 as previous (consistent, both GETs 200, and the reads
  re-wrapped both rows to KEK generation 2); envelope S2 at generation 2 alone afterwards (consistent).
- Refusals, each exit 1 with no listener: `DERIVED_MODE_OVER_RANDOM_KEYS — 1 tenant(s)`, and
  `— 2 tenant(s)` after `rekey` made A random too; `DERIVED_SECRET_NOT_SEED — 1 tenant(s)` (derived
  S2 over a seeded row); `KEK_GENERATION_UNHELD — 2 tenant(s) … generation 1` (S2 at generation 2, no
  previous); `KEK_SECRET_MISMATCH — … (2 tried)` (S2, generation unbumped); `KEK_GENERATION_UNHELD …
  generation 2 … rolled back` (S1 after the rewrap); `CIPHERTEXT_KEY_MISMATCH` for keyless ciphertext
  under a replaced secret in derived mode and in envelope mode, the latter writing no key row. No
  secret value and no tenant id appeared in any refusing boot's log.
- Unknown: with `SELECT` on `meta.tenants` revoked, `SURVEY_UNREADABLE` and `CIPHERTEXT_UNCHECKED` on
  stderr, nothing on stdout, and the server listened (a PHI GET answered 503
  `tenant_status_unavailable`, the status gate reading the same table). One of two rows at a
  generation set to `'\x00'`: `ROWS_UNOPENABLE — 1 of 2` and boot, the healthy tenant 200 and the
  corrupt one 500; the same corruption on the only row at that generation refused
  `KEK_SECRET_MISMATCH — (1 tried)`, the single-sample limit above.
- RLS: the confined role read per tenant (a `set_config('app.current_tenant_id', …)` before each key
  read, under `log_statement = all`) and the owner read unscoped; both refused the random-key arm with
  the same count. An unscoped `count(*)` on `meta.tenant_data_keys` answered 0 as `crossengin_app`
  and 2 as the owner.
- Two wording points, unchanged: `SURVEY_UNREADABLE` names `meta.tenant_data_keys` when the denied
  table was `meta.tenants` (the parenthetical carries the real error), and `ROWS_UNOPENABLE`'s
  "refused" reaches the client as an opaque 500.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `seed_unverifiable` could be settled by `checkKeylessCiphertext`'s decrypt over a seeded tenant's ciphertext; worth it only if the rollback shape it covers is seen in practice. | CrossEngin platform | _unscheduled_ |
| Boot cost on the confined route is linear in tenants (measured 3.45 s per 10,000 on loopback, ~40 s at a 1 ms round trip); folding the ciphertext read into the key survey's per-tenant transaction would save a statement per tenant, and a larger deployment may want `start_period` raised or the ceiling exposed. | CrossEngin platform | _unscheduled_ |
| Keyless ciphertext in per-tenant manifest schemas (`t_<uuid>`) is not checked. | CrossEngin platform | _unscheduled_ |
| The per-tenant route's ceiling is a constant with no flag; a deployment past 10,000 tenants boots with an `unknown` line for the rest. | CrossEngin platform | _unscheduled_ |
| `operate-server rekey` builds its own ring and store and does not run this survey; a rekey under a wrong ring fails per tenant instead of up front. | CrossEngin platform | _unscheduled_ |
| The survey reads `<--schema>.tenant_data_keys` and `<--schema>.tenants`, following `PostgresDataKeyStore`; `--schema`'s several meanings (ADR-0350's open question) apply here too. | CrossEngin platform | _unscheduled_ |

## References

- ADR-0445, open question "Two configurations boot clean and then fail every PHI request…".
- `packages/crypto-pg/src/data-key-store.ts` (`open`, `DataKeyKekUnavailable`, `DataKeyUnwrapFailed`).
- `apps/operate-server/src/column-secret-ring.ts` (`kekResolverFor`, `seedSecretOf`).

## Addendum: two sentences the live run measured false

- `survey_unreadable` said "meta.tenant_data_keys could not be read" when, in the live arm, the
  denied table was `meta.tenants` (the survey reads both). It now says "the stored data keys could
  not be surveyed (reason)", so the parenthetical names the real cause rather than contradicting it.
- `rows_unopenable` (and its keyless-ciphertext sibling) said the affected tenant's requests "are
  refused (DataKeyUnwrapFailed)"; the client sees an opaque 500, not a refusal. Both now say the
  requests fail and that the answer is a 500.
