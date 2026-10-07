# ADR-0346: The opaque cursor that was not

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0345, ADR-0342, ADR-0340, ADR-0338, ADR-0336, ADR-0329, ADR-0302, ADR-0301 |

## Context

ADR-0345 made a record-bearing ABAC policy on an entity's `list` grant filter rows out of the page,
and left one residual it named first among its own open questions:

> the cursor discloses the **position** of withheld rows: the sort key and the `id`. That is
> irreducible for any sound stateless paging over a filtered set … At `limit=1` a caller can walk the
> collection and collect one id per page, including ids of rows they cannot read, which is an
> enumeration this repo did not previously permit.

The class is **a format that was never meant to be read, and was**. `ListQuery.cursor` has been
documented as an "opaque keyset cursor" since it was written, and `encodeKeyset` is
`base64url(JSON.stringify({k: [...sort values], id}))`. Opaque by *convention* is not a property, and
row filtering is what turned the convention into a disclosure: `nextCursor` comes from the last row
of the **store's** slice, which under filtering may be a row the caller is never shown.

### The three pins were never what CLAUDE.md said they were

ADR-0338 is recorded in CLAUDE.md as having added "no cipher to a package with three pins asserting
it has none". Read them. `KEY_ALGORITHMS` is `MAC_ALGORITHMS ∪ SIGNATURE_ALGORITHMS` — the algorithms
a registered `KeyHandle` may have. `KEY_PURPOSES` is what a handle may be *for*. `CRYPTO_OPERATIONS`
is the audited **key-management** vocabulary. All three describe the key *registry*, and that is
exactly why ADR-0338 could add `key-derivation.ts` and leave all three alone: a derived key is not a
handle, has no material at rest, no `meta.crypto_keys` row and no lifecycle.

**An AEAD over a derived key is outside all three for the same reason.** So this increment adds the
package's first cipher and the pins stay, with `isCryptoOperation("encrypt")` still false. That is a
decision rather than a technicality, and it has a structural test: adding `aes-256-gcm` to
`KEY_ALGORITHMS` would mean a *registered* cipher key, which would need the private-material column
`meta.crypto_keys` does not have. A cursor seal must not be audited either — one per page at request
rate is the 124 TB/yr argument that refused `meta.feature_flag_evaluations` a writer (ADR-0336).

## Decision

**Seal the keyset cursor with AES-256-GCM under a per-tenant derived key, bound to the request it may
be replayed in, and refuse to boot when a list grant filters rows and the cursor is left in the
clear.**

### The cheap shape: an envelope at the handler boundary

The cursor is opaque to the **client**, not to the store. So sealing is open-on-the-way-in,
seal-on-the-way-out in the list handler, and `store.ts`, `entity-ops.ts`, `column-store.ts` and
`list-sql.ts` are untouched — they go on producing and consuming the plaintext keyset they always
did. That is the whole reason this is a small increment rather than a store rewrite.

### `packages/crypto/src/aead.ts`

```ts
export function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
export function aeadOpen(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array | null;
```

Wire format `nonce || ciphertext || tag`, 12 ‖ n ‖ 16 — a contract rather than an implementation
detail, since other code transports these bytes. The nonce is first so `aeadOpen` can slice it off
before it knows anything else; the tag is a fixed-width suffix, so both ends are addressable from a
length alone.

- **A fresh random nonce per seal, never a counter.** There is no state here and nothing to persist a
  counter in, so a counter would restart at zero every process — and GCM nonce reuse under one key is
  catastrophic rather than merely weakening: two messages under one nonce disclose the XOR of their
  plaintexts and leak the authentication subkey, which lets an attacker forge tags for messages that
  were never sealed.
- **`aeadOpen` answers `null` for every rejection and throws for none.** A failed open is *expected
  input*: the first consumer's `sealed` is a string a client sends back, so a stale value, one under
  a rotated key, one bound to another context and one somebody edited all arrive by the ordinary
  path. A throw would make each a 500.
- **A wrong-length key throws.** That is a deployment bug, wrong for every input and never going to
  start working, and answering it with `null` would make it indistinguishable from a tampered value —
  so every request would look like an attack and nothing would name the real cause.
- **`aad` is a required parameter.** Lane review corrected the reasoning here and the correction is
  worth recording: an empty AAD is *cryptographically identical* to never calling `setAAD`, since GCM
  takes a zero-length AAD. So requiring the parameter buys nothing at the cipher level. What it buys
  is at the call site — an AEAD used with no binding still encrypts and still authenticates, so
  nothing looks wrong while the seal is valid in every context instead of the one it was issued for.
  The protection is a type signature, not a mode of operation.

### The key is derived, not stored

`deriveTenantCursorKey(secret, tenantId, generation)` is HKDF-SHA256 with the **tenant id as salt and
the generation in the info**, which is ADR-0338's shape and its argument, reached for the third time
after ADR-0302's bounce secret. It returns **raw bytes** where the column key returns base64, and the
difference is the consumer: `pgp_sym_encrypt(plaintext, key)` takes text, `aeadSeal` takes bytes, so
base64 here would be an encode-then-decode round trip with a chance to disagree about padding.

The two derivations are separated **only by their info strings**, and that is what keeps one
compromise from being two: a leaked cursor key must not decrypt a PHI column. So each consumer gets
its own `*_KEY_DERIVATION_INFO` and never a reuse, pinned by a test asserting the two keys differ for
one secret and one tenant.

`CURSOR_ENCRYPTION_SECRET` arrives by **environment, never argv** (ADR-0301: `ps` can read argv), and
goes through the same private `refuseWeakSecret` as the column secret — one floor, so a secret good
enough for a PHI column is good enough for a cursor. Its **message** is parameterised, because
"column encryption secret refused" would send an operator configuring the cursor secret to the wrong
variable.

### The envelope: a declared tag, one refusal, three bindings

`SEALED_CURSOR_PREFIX = "s1."`, read at a **fixed offset** rather than recognised. That is ADR-0329's
rule — a verifier selects the version from an explicit field and never by inferring it — and the
concrete reason it matters is that the two formats are not distinguishable by inspection: "does it
parse as `{k, id}`?" would read a sealed cursor whose random nonce happened to decode into JSON as
plaintext. `s1.` leaves room for an `s2.` an `s1.` reader will refuse rather than misread.

**One refusal reason, `not_for_this_request`, and that is a fact about the cryptography rather than a
simplification of it.** GCM authentication fails identically for a tampered ciphertext, a cursor
sealed for another tenant, one for another entity, one under a different sort, and one under a key
since rotated: the context is an *input to the authenticator*, not a field that comes back to be
compared. Two reasons would claim a distinction the primitive does not make, and a caller told "wrong
tenant" would be reading a guess.

The binding is **canonical JSON of `[tenantId, entity, sortSpec]`**, not a delimiter-joined string: a
`:`-joined form would rest on an assumption about what characters an entity or field name cannot
contain, and `entity:"A"` + `field:"b:asc"` collides with `entity:"A:b"` + `field:"asc"` under it —
which a test pins. `limit` and `filters` are deliberately **not** bound: the keyset is a position in
the *sort* order, so replaying under a different limit or filter is still a well-formed comparison,
and the probing route it would otherwise open is already closed by ADR-0345's `withheldAddressing`
for exactly the fields that matter.

**Not bound to the principal**, deliberately. Two callers in one tenant are served slices of one
store ordering — row filtering is post-hoc, at the handler — so A's position *is* a sound position for
B, and binding would refuse a legitimate replay (a shared link, a second credential for one person)
while buying no confidentiality: the position it discloses is the same one either caller's own walk
would reach.

**A soundness fix falls out of the sort binding.** `isAfter` compares the cursor's `k[i]` against
`sort[i]`'s field, so a cursor replayed under a different `?sort` produces a meaningless keyset
comparison today. A sealed cursor is refused instead. Partial by construction — the legacy path keeps
the hole — and that is said rather than left to read as closed.

### Legacy plaintext is accepted

So a rollout breaks no walk already in flight. Safe for confidentiality on a narrow argument: a
client can only ever construct a plaintext cursor whose contents it already knows, so accepting one
discloses nothing it did not already hold. The threat closed here is a caller *reading ours*; forging
one was always possible because the format was public, and remains possible while the legacy path is
open. The cost is that a legacy cursor carries no binding, so none of the confinement reaches it.

### Sealing is uniform, and the boot refusal has an escape hatch

When a secret is present **every** entity-list cursor is sealed, including for entities whose rows
are not filtered. One format going forward beats a per-entity matrix, it costs one AES-GCM operation
per page, and it means cursors stop being a readable surface at all rather than only where somebody
remembered to close them.

`resolveCursorSealing` answers three modes — `sealed` / `plaintext_accepted` / `absent` — and
`cursor_discloses_withheld_rows` is the fifth boot refusal, firing iff a list grant filters rows
**and** the mode is `absent`. `--allow-cursor-disclosure` accepts the disclosure knowingly.

That hatch is ADR-0338's `--allow-plaintext-phi` shape and deliberately **not** ADR-0340's no-hatch
shape. ADR-0340 refused a flag because serving a grant with its qualifier removed is the *opposite*
of what the manifest declares. A plaintext cursor is degraded-but-coherent: the filter works, the
rows are withheld, and only their positions leak, which an operator whose ids are opaque and whose
sort key is uninteresting may reasonably accept. One who has not thought about it is refused.

The flag **accepts** a disclosure rather than requesting one, so it does not suppress sealing: a
deployment that sets the secret gets sealed cursors either way, and the redundant flag is warned
about.

## Alternatives considered

- **Option A: a server-side opaque handle** — store `{k, id}` in a table keyed by a random token.
  - **Pros:** the client holds a bare token with nothing in it at all.
  - **Cons:** cursors become stateful. A new table, a TTL, a write per page, and a cursor that can
    outlive its row — a failure mode keyset paging exists to avoid, and `applyListQuery`'s own doc
    advertises "no offset drift on inserts/deletes" as the property.
  - **Why not:** it trades a disclosure for durable state and a new expiry semantics, which is a
    worse deal than one AES-GCM operation per page.

- **Option B: HMAC the cursor instead of encrypting it.**
  - **Pros:** no cipher, so the three pins never even come up; tamper-evident.
  - **Cons:** HMAC gives integrity, not confidentiality. The values stay readable.
  - **Why not:** the disclosure is the whole problem. Integrity was never missing.

- **Option C: drop the sort values and keep only the `id`.**
  - **Pros:** a smaller cursor and no sort-value disclosure.
  - **Cons:** the `id` is the enumeration channel ADR-0345 named, and keyset seeking needs the sort
    values to compare against — without them a cursor cannot express a position under any sort but
    the primary key.
  - **Why not:** it closes the lesser half of the disclosure and breaks paging.

- **Option D: a deterministic seal, so one cursor has one representation.**
  - **Pros:** sealed bytes would be an equality key; a client could tell two pages apart.
  - **Cons:** a fixed nonce under one key is GCM's catastrophic case, and a synthetic-IV construction
    is a different primitive than the one ADR-0338's DEK envelope will want.
  - **Why not:** nothing needs cursor equality, and the cost of being wrong here is total.

- **Option E: bind the seal to the principal as well.**
  - **Pros:** a cursor could not be handed between credentials.
  - **Cons:** refuses a legitimate replay while buying nothing — the position is the same one either
    caller's own walk reaches, because filtering is post-hoc over one store ordering.
  - **Why not:** it would make a shared link or a second credential for one person a 400 for no gain.

- **Option F: refuse legacy plaintext cursors once sealing is on.**
  - **Pros:** every cursor would then carry the binding, closing the sort-mismatch hole completely.
  - **Cons:** every walk in flight at deploy time dies on its next page.
  - **Why not:** the legacy path discloses nothing a client did not already have, so the breakage buys
    only the soundness half — and that half is available later by retiring the prefix, which the
    versioned tag is there to make possible.

- **Option G: leave it, as ADR-0345 did, and state the disclosure.**
  - **Pros:** no cipher, no secret, no flag, no boot refusal.
  - **Cons:** an id enumeration at `limit=1` stands.
  - **Why not:** ADR-0345 named it the top open end precisely because stating a disclosure is not
    closing it.

## Consequences

- **Positive:** the cursor stops being readable. A deployment that filters rows is refused unless it
  has decided; a deployment that sets the secret gets opaque cursors on *every* entity list, not only
  the filtered ones. A sealed cursor is confined to the tenant, entity and sort it was issued for,
  which closes a pre-existing soundness hole as a side effect. And the AEAD is the primitive
  ADR-0338's DEK envelope has been blocked on.
- **Negative:** a deployment that filters rows now needs a secret or an explicit flag — a new boot
  refusal. One AES-GCM operation and one HKDF per page (the key cached per tenant). A wrong-length
  key would be a 500 rather than a 400, which is right in direction and is unreachable today because
  the only key source derives exactly `AEAD_KEY_BYTES`, pinned by a test. And `packages/crypto` now
  contains a cipher, which is a surface that did not exist.
- **Neutral:** no schema change, no table, no migration. Nothing in the shipped packs declares a
  record-bearing `list` obligation, so **no shipped deployment is refused** and none changes
  behaviour unless `CURSOR_ENCRYPTION_SECRET` is set.
- **Reversibility:** high. Unsetting the secret restores plaintext cursors; legacy plaintext is
  already accepted on the way in, so in-flight sealed cursors are the only casualty and they die as
  one 400 per walk. The AEAD and the derivation stand alone.

### What is still disclosed

Nothing, through the cursor, when a secret is set. Two residuals remain and neither is the cursor:

**The per-page withheld count is derivable, and ADR-0345 overstated this.** That ADR says "the
response does not say how many rows were dropped" and treats the count as a channel it declined to
open. `applyListQuery` sets `hasMore = start + slice.length < rows.length`, and the slice only stops
early at the end of the rows — so a non-null `nextCursor` implies the slice was **full**, and
`withheld = limit − data.length` for every page but the last. The decision not to report it therefore
stands on narrower ground than that ADR claimed: it keeps the figure off the last page, where the
slice size is genuinely unknown to the caller, and keeps it from becoming a contract. The association
list is what made this visible, since its cursor is an `offset` the client sends and which advances
deterministically by `limit`, so there the count was never hidden at all.

**The association list cursor is not sealed and does not need to be.** It is a zero-based offset into
the owner's link list, carrying no row values and no ids — it discloses a count, not a position. Said
here so nobody "completes the sweep" and seals an offset.

## Implementation notes

- `packages/crypto/src/aead.ts` — the cipher. `AEAD_MIN_SEALED_BYTES` is exported beside the
  component sizes, because that floor is what `aeadOpen`'s short-buffer refusal turns on and a
  consumer validating length before calling is the obvious second reader.
- `packages/crypto/src/key-derivation.ts` — `CURSOR_KEY_DERIVATION_INFO`,
  `parseCursorEncryptionSecret`, `deriveTenantCursorKey`. `requireDerivationArguments` was extracted
  so both derivations share one copy of the empty-tenant and integer-generation refusals, for
  `refuseWeakSecret`'s own stated reason; `deriveTenantColumnKey`'s messages and behaviour are
  byte-identical. The key length is taken from `AEAD_KEY_BYTES` rather than a second literal, so
  drift is impossible rather than merely detectable.
- `packages/operate-runtime/src/cursor-seal.ts` — the envelope. `OpenedCursor` keeps `plain` and
  `opened` distinct although the handler reads only `value`: a legacy cursor carries no binding, and
  that is where a rollout metric or a retire-legacy switch would hang.
- `packages/operate-runtime/src/handlers.ts` — `HandlerContext.cursorSealer`, and one `sealing`
  object holding the sealer and the context so the open and the seal cannot read two contexts. An
  open that succeeded under one and a seal issued under another would hand the caller a cursor their
  very next request cannot use — a walk that dies on page two.
- `apps/operate-server/src/cursor-encryption.ts` — the three modes and the per-tenant key cache,
  copying `buildColumnKeySource`'s eager validation (a weak secret fails at boot naming the measured
  figures, not on the first page) and its cache-key reasoning.
- `apps/operate-server/src/abac-obligations.ts` — the fifth refusal, and `cursorSealing` as a
  **required** input. Lane review corrected the reason: the danger of an optional field is not that it
  would default to something permissive in general but that it would default to `sealed`, **asserting
  sealing this deployment does not do**. `absent` is the strict value, which is what `server.ts`
  supplies for a caller that passes nothing.
- `apps/operate-server/src/cli.ts`, `node.ts`, `server.ts` — the flag, the env read, the grouped
  `{mode, sealer}` pair, and the set-and-unused warning. The warning is `node.ts`'s shape rather than
  `cli.ts`'s refusal because whether the flag is redundant depends on an environment variable
  `parseServeArgs` deliberately cannot read.

### The refusal ordering, corrected

I had argued the cursor refusal goes last because it is computed from `rowFiltered` and would be
vacuously silent with no evaluator declared. Lane review pointed out that is **equally true of
`list_sort_addresses_withheld_field`**, so it does not order the two against each other. The real
reason is stronger: ADR-0345's addressing guard sees the manifest's *default* sort and 400s every
list request on that entity **before a cursor is ever minted**, so **sealing does not rescue a
classified default sort** — an operator who answered the cursor refusal by setting the secret would
find the entity still unservable and the sort remedy still owed. The reverse is not true. Pinned by a
test.

### Measured

`packages/crypto` 182 → 225 tests. A **known-answer vector** pins the cursor derivation, as hex
literals and recomputed independently with `hkdfSync` in the same file, because a silent change would
make every issued cursor undecipherable:

| tenant | gen | key (hex, first 16) |
|---|---|---|
| `11111111-…-111111111111` | 1 | `680bcfa97151a09d…` |
| same | 2 | `38ba7f45bed8532f…` |
| `platform` | 1 | `c64f7513dc15cb9d…` |

The column key for the same `(secret, tenant, gen 1)` is `040f876c…`, asserted **unequal**, since the
info strings are the only separation there is.

### Verified live

PG 16, non-owner role `app_rw`, one tenant, two memberships holding the **same** role and different
`department`, seven charts `l1..l7` with departments `C O O O C C O`, policy
`same_dept=department:eq_record:department`.

**The boot refusal**, with a list grant that filters rows and no secret:

```
fatal: 1 abac-qualified grant(s) filter rows out of a list page while this deployment's entity-list
cursor is unsealed, so the cursor carries back the position of a row the caller was never shown:
Chart.list requires abac policy 'same_dept' …
```

**A weak secret**, naming the right variable — the label parameterisation working:

```
fatal: list-cursor encryption secret refused (too_uniform): secret has 1 distinct byte value(s)
across 34 bytes; minimum is 16
```

**The two modes side by side, on the same request** — this is the whole increment in four lines:

```
[cursor] cursor sealing: plaintext_accepted …
  nextCursor = eyJrIjpbImwyIl0sImlkIjoicmVj...
  decodes to  {"k":["l2"],"id":"rec_muybya7w0002"}

[cursor] cursor sealing: sealed …
  nextCursor = s1.wfHmgacd6Bk4aAmtUR8EuhqK8Dv...
  decodes to  not JSON (ciphertext)
```

`l2` is an **oncology** row, withheld from this cardiology caller on every page — and in the first
mode the caller is handed its sort value and its id.

**The full walk at `limit=2` with sealed cursors**, including ADR-0345's fully-denied page:

```
page 1: rows=1 [l1]    nextCursor=sealed
page 2: rows=0 []      nextCursor=sealed
page 3: rows=2 [l5,l6] nextCursor=sealed
page 4: rows=0 []      nextCursor=null
visible to A: [l1,l5,l6]
```

**Confinement:**

```
same sort (the sort it was issued for)   -> 200
different sort                           -> 400 cursor_not_for_this_request
tampered sealed cursor                   -> 400 cursor_not_for_this_request
legacy plaintext cursor                  -> 200
```

Workspace: **17,364 tests**, build and typecheck green.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| ADR-0338's **DEK envelope and crypto-shredding** is now unblocked — the AEAD is the primitive it was waiting on. It still needs a KEK source, an unwrap cache, a decision about an unreadable DEK row, and CHECK migrations on `meta.crypto_keys`. | Platform | — |
| `ColumnSecretRefused` and `PLATFORM_COLUMN_KEY_SCOPE` are now narrower than their uses — both serve any derived key. The messages are parameterised so an operator is sent to the right variable; the class name is 38 references across four files and is a mechanical rename. | Platform | — |
| No key rotation path: a cursor sealed under generation N refuses under N+1 (pinned). The `s1.` tag leaves room for an envelope that names its generation, which is what a rotation without a page-boundary 400 would need. | Platform | — |
| Nothing reads `OpenedCursor`'s `plain`-vs-`opened` distinction, so legacy traffic during a rollout is not counted and there is no switch to retire the legacy path. | Platform | — |
| The per-page withheld count is derivable from `limit − data.length` whenever the cursor is non-null. Closing it would mean a slice whose size the client cannot infer, which conflicts with keyset paging's contract. | Platform | — |

## References

- ADR-0345 — row filtering, and the disclosure this closes.
- ADR-0338 — the derived per-tenant key, the three pins, and the DEK envelope this unblocks.
- ADR-0329 — a version selected from an explicit tag and never inferred.
- ADR-0302 — the per-tenant key derived from one deployment secret, reached first.
- ADR-0301 — a secret arrives by environment, never argv.
