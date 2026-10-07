# ADR-0348: The grant that answered two questions

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-07 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0339, ADR-0340, ADR-0342, ADR-0343, ADR-0329, ADR-0338, ADR-0334, ADR-0288 |

## Context

ADR-0339 closed the field-level write authorization hole and left one item first among its own open
ends — the one this file has carried as the top follow-up since:

> **(1)** the **39 unauthored grants** — the end state is a per-field `update` and `read` grant on
> every classified field in every pack, at which point the mask becomes the default and the
> deployment declaration becomes the exception; the 12 required fields are the blocking subset and
> the boot survey names them.

Measured again here, against the built packs rather than read off that sentence: **46
sensitive-classified fields across the seven packs, 7 with grants, 39 without, 17 of them
`required`** (12 required *and* ungranted — ADR-0339's figure, confirmed). So the item was stated
correctly. What it did not say is that the 39 cannot be authored as written, and that one of the 7
"each deliberate" grants was already broken.

### What the deployment actually does today

Booted on a throwaway cluster with exactly the `deploy/docker-compose.yml` API command
(`--pack erp-core --store pg`), as the role that compose connects as:

```
[sensitive] [fields] 21 sensitive-classified field(s): commercial_sensitive 11, pii 10 (classified write mask OFF)
[fields] unreadable by every declared role: 21 — Item.standard_cost, Vendor.tax_id, …
[fields] writable by a role that cannot read it: 21 — Item.standard_cost, Vendor.tax_id, …
[fields] required and writable by no declared role, so their entity is uncreatable:
         Employee.work_email, Lead.full_name, Opportunity.amount, FixedAsset.acquisition_cost
```

Then through real HTTP: `ap_clerk` (which holds `Vendor.create`) POSTed
`{"vendor_code":"V-001","name":"Acme Supply","tax_id":"TAX-SECRET-1","contact_email":"ap@acme.test"}`
→ **201**. The row holds both values. Neither the create response nor `GET /v1/vendors` returns
either of them — **to the credential that just wrote them**. Every classified field in the default
deployment is **write-only**: a user fills in a vendor's tax ID, it saves, and the field is blank on
every subsequent view, while anyone holding entity `update` can silently overwrite it. That is not a
hardening gap; it is the ERP's own forms reading as broken.

### The class: one grant, two moments

`@crossengin/auth`'s field grant was:

```ts
FieldPermissionSchema = z.object({ read: RbacGrantSchema.optional(), update: RbacGrantSchema.optional() })
```

`validateClassifiedWriteMask` reads `fields[name].update` and the handler calls it on **create and
update alike**. So one role list answers two different questions — *who may set this value* and
*who may change it* — and three things follow, all of them measured rather than reasoned:

**(1) A live defect, shipped — and then two more of it.** `erp-government` declares
`Citizen.national_id` (`required`, `regulated`) with `update: ["gov_admin"]` while the entity's own
`create` grant is `["gov_admin", "case_worker"]`. Since ADR-0339 made an explicitly declared grant
authoritative with no flag, `POST /v1/citizens` as `case_worker` has answered:

```
HTTP 403 {"error":"forbidden","detail":"field 'national_id' on 'Citizen' is not writable by this
principal","field":"national_id","rule":"explicit_update_grant"}
```

A case worker cannot register a citizen. ADR-0339's own text says of the 7 explicit grants: *"each
deliberate, and it cannot make anything uncreatable"* — the second clause is **false**.

It is false about **three of the seven**, and the other two were found by the validator below rather
than by looking, which is the strongest evidence available that the rule was worth writing. Both are
the identical shape, confirmed against the committed tree:

| grant | `required` | entity `create` | field write grant | consequence |
|---|---|---|---|---|
| `Citizen.national_id` | ✓ | `gov_admin, case_worker` | `gov_admin` | `case_worker` cannot register a citizen |
| `WorkOrder.cost_estimate` | ✓ | `…, foreman` (`FIELD_CREW`) | `MANAGERS` | `foreman` cannot raise a work order |
| `PerishableLot.cost_per_unit` | ✓ | `…, receiving_clerk` (`ALL_GROCERY`) | `ADMIN_ONLY` | `receiving_clerk` cannot receive a lot |

The first was reproduced live as a 403; the other two are structurally identical and were **refused
by the new validator mid-increment**, which took `pack-erp-grocery`'s and
`pack-erp-construction`'s own cross-validation tests red and made the fix unavoidable rather than
optional. All three are fixed by adding only the `create` arm — no `read` or `update` list changed in
any of them.

**(2) The policy everyone actually wants is inexpressible.** *Set once at registration, never
changed afterwards* — the natural rule for a medical record number, a national id, a tax identity —
cannot be declared with one list. ADR-0339 found exactly this violated live, `front_desk`
**blind-overwriting** `Patient.mrn`, and the fix available to it could only have been to remove
`front_desk` from the one list, which would have stopped the desk registering patients at all.

**(3) The 39 are the same trap waiting.** Authoring them under one arm forces
`update ⊇ entity.create` for all 12 required ones, so the only narrowing available is on `read` —
and every pack author doing this by hand would meet (1) again.

## Decision

Four parts, in dependency order. The recurring rule holds a sixth time: **the honest fix sits one
level up from where the pain was felt.** The pain was 39 unauthored grants; the fix is the arm they
needed and the validator that makes authoring them safe, and only then the grants.

**(1) `FieldPermission.create?`** — a third arm. **Absent falls back to `update`**, so every
declaration written before it keeps its exact meaning and not one shipped grant changed behaviour.
`fieldWriteGrant(perm, writeOp)` is the one spelling of that fallback, so no reader re-derives it.

It is deliberately **not** constrained to be a subset of `read`, where `update` is, and that
asymmetry is the whole argument for a third arm over a wider list: **a principal supplying a value
already knows it, so writing it discloses nothing; changing a value you cannot read destroys one you
cannot see.**

**(2) `field_create` joins `ABAC_GRANT_POSITIONS`**, because a `create` arm can carry an `abac` key
and ADR-0340's rule is that an obligation nothing reads is worse than no obligation.
`ABAC_RECORD_AVAILABILITY.field_create` is `"never"` — `entity_create`'s answer for
`entity_create`'s reason, the record does not exist until the write commits — so `never` is now the
exact set `{entity_create, field_create}` and the ADR-0343 pin moved with a stated reason.
`surveyAbacObligations` reads the arm **directly and never through the fallback**: an inherited
`create` carries `update`'s obligation, which is already in the list, so resolving the fallback there
would report the inherited one twice and a declared one not at all.

**(3) Three coherence rules in the kernel's `validatePermissions`.** Until now a field grant was
checked for two things — the field exists, every role is declared — and all three incoherences were
reachable.

- **R1 `uncreatable`**: for a `required` field, the *effective* create grant must cover every role in
  the entity's `create` grant. This is defect (1), derived from the manifest instead of discovered by
  a 403.
- **R2 `blind overwrite`**: `update.roles ⊆ read.roles`. An **absent** read grant is not a pass — the
  field then falls to the classification default, which withholds it from every unprivileged role, so
  it is the same blind overwrite one level away, and the two cases get different messages because
  they have different remedies.
- **R3 `inert grant`**: a field role must appear in the matching entity grant. Checked **first**,
  because the other two read as puzzling when the cause is a role that cannot reach the record at
  all.

These are **validation errors, not boot refusals** — the opposite of where ADR-0340 put its ABAC
check, for a stated reason: whether a deployment can discharge an obligation is a property of the
*deployment*, while all three of these are properties of the manifest alone and so are decidable the
moment it is written, by a pack author, by `crossengin validate`, and by the reviewer approving what
the Architect designed. **A rule that can be checked earlier should be.**

**(4) The 39 grants, authored under one method**: *decide `read`; let R2 derive `update`; add `create`
only where R1 forces it or set-once is the policy.* One decision with two mechanical consequences.
The narrowing principle is to drop the general-purpose observer and clerk roles that have no need for
the value, keeping the owning role, the admin, and the finance or audit role where the figure is
legitimately theirs.

All three broken grants keep their existing `read` and `update` **byte for byte** and gain only the
`create` arm. That one line each is the whole fix, and it is the clearest possible statement of what
the third arm buys: `case_worker` registers a citizen without being able to change a national id,
`foreman` raises a work order with a cost estimate they cannot read back, `receiving_clerk` receives
a lot at a cost that stays commercially sensitive to them.

## Alternatives considered

- **Option A: widen the single `update` list to include every creating role.**
  - **Pros:** no contract change at all; the 39 could be authored today.
  - **Cons:** it makes `front_desk` able to overwrite `Patient.mrn` for ever, and `case_worker` able
    to change a national id — which is the defect ADR-0339 found live, re-introduced as the fix for
    its own open end. Every required classified field would be permanently un-narrowable.
  - **Why not:** it resolves the conflict by discarding the policy, in the unsafe direction.

- **Option B: narrow `update` and remove the affected roles from the entity's `create` grant.**
  - **Pros:** also no contract change; R1 is satisfied vacuously.
  - **Cons:** a receptionist who cannot register a patient and a case worker who cannot register a
    citizen are not a security improvement, they are a broken product. The entity grant is a
    statement about who does this job.
  - **Why not:** it makes the manifest lie about the business to satisfy a schema limitation.

- **Option C: a `setOnce: true` flag on the field instead of a `create` arm.**
  - **Pros:** one boolean, no new role list, and it reads as the intent directly.
  - **Cons:** it answers only one shape — *the creators may set it, nobody may change it* — and not
    *these may set it and those may change it*, which is exactly `Citizen.national_id`
    (`case_worker` sets, `gov_admin` changes). A boolean would also have to be read by the write
    mask, the validator and the survey, so it is not cheaper, only narrower.
  - **Why not:** strictly less expressive than the arm, at the same cost.

- **Option D: make `writeOp` a required parameter on `validateClassifiedWriteMask`.**
  - **Pros:** no default applied to silence, which is this repo's rule (ADR-0317, ADR-0328) and what
    ADR-0338 did to `operationsForEntity` for exactly this reason.
  - **Cons:** 20 existing call sites in `fields.test.ts`, all of them about the update path, would be
    edited to say what they already mean.
  - **Why not:** the arguments differ. `operationsForEntity`'s default *could not possibly be
    correct*; this one is correct for the update path and **fails closed** for the other — a
    forgotten argument enforces the narrower change grant, so the mistake refuses a create it should
    have admitted rather than admitting one it should have refused. That is the direction an omitted
    `AbacEnforcement` already fails in on the same function. It is **required** on
    `WriteMaskInput` and on `evaluateMask`, where the compiler can ask and a handler that forgot it
    would refuse a create the manifest permits.

- **Option E: enforce the three rules at boot rather than at validation.**
  - **Pros:** consistent with ADR-0340's obligation refusal, and it would catch a per-tenant manifest
    activated later (ADR-0339's open end 5).
  - **Why not:** a boot refusal is for what only the deployment knows. These are manifest-internal,
    so checking them at validation catches them in `crossengin validate`, in the pack's own test
    suite, and in a design review — three places earlier than boot. It also covers a per-tenant
    manifest for free, since activation validates.

## Consequences

- **Positive.** The default deployment stops being write-only: a classified field is readable by the
  roles that own it and writable only by those. Three shipped 403s — a case worker who could not
  register a citizen, a foreman who could not raise a work order, a receiving clerk who could not
  receive a lot — are each fixed by adding one line rather than by widening a grant, and **two of
  the three were found by the validator rather than by anybody looking for them.** The policy the
  packs plainly intended — set at registration, not changed afterwards — is expressible, and
  `Patient.mrn` now says it. Three classes of incoherent grant are refused at the earliest point they
  are decidable, so neither a pack author nor the Architect can author the trap, and the reviewer
  approving a generated manifest is told in the error message which remedy is the true one.
- **Negative.** A contracts change with cross-package consumers, so a stale `dist` makes a consumer's
  tests meaningless until `pnpm -r build` (ADR-0329, hit during this increment: a lane's `typecheck`
  failed against a kernel `.d.ts` that had snapshotted the two-arm shape while the runtime resolved
  the three-arm one). `ABAC_GRANT_POSITIONS` grew to nine, which moves three total maps and two
  pinned sets. And the grants are a **behaviour change by construction**: a role that could write a
  classified field yesterday cannot today unless its grant names it. That is the point, and it is why
  the method narrows `read` first and lets the write side follow rather than the other way round.
- **Neutral.** `--classified-write-mask` has less left to refuse, but it is still opt-in: the
  classification default governs any classified field a pack has not granted, and a tenant's own
  activated manifest can still declare one.
- **Reversibility.** The arm is additive and absent means what it always meant, so removing it would
  only lose the distinction. The grants are declarations and revert cleanly. The validator is the one
  part that cannot be removed without re-opening all three holes.

## Implementation notes

- `packages/auth/src/types.ts` — the arm, `fieldWriteGrant`, `FIELD_WRITE_OPERATIONS`.
- `packages/auth/src/abac.ts` — `field_create` in `ABAC_GRANT_POSITIONS`,
  `ABAC_RECORD_AVAILABILITY`, `ABAC_RECORD_AVAILABILITY_REASONS` and `ABAC_DENIAL_EFFECT`;
  `abacGrantPosition` maps `("create", field)` to it; `surveyAbacObligations` reads the arm.
- `packages/auth/src/fields.ts` — `validateClassifiedWriteMask` takes a trailing
  `writeOp: FieldWriteOperation = "update"` and passes it to `dischargeFieldObligation` so the
  position resolves to `field_create`.
- `packages/operate-runtime/src/write-mask.ts` — `WriteMaskInput.writeOp`, **required**. The
  candidate filter asks `fieldWriteGrant` rather than `update`, or a field whose only declared arm is
  `create` would be dropped from the candidate list on a create and its one grant skipped.
- `packages/operate-runtime/src/handlers.ts` — `evaluateMask` gains a required `writeOp`; the create
  handler passes `"create"`, both update paths `"update"`.
- `packages/kernel/src/manifest/validate.ts` — `requiredFieldsByEntity` out of the entity index
  (through `resolvedFields`, so a classified **trait** field is in scope), `FIELD_GRANT_ARMS`, and
  `checkFieldGrantCoherence`.
- The seven packs' `permissions.ts` — the grants.

### Verified

The three rules, on a minimal manifest, six cases:

| case | outcome |
|---|---|
| required field, `update` narrower than entity `create` (the shipped shape) | **refused** — `makes 'Citizen' uncreatable by 'clerk'` |
| the same grant plus a `create` arm, read and update unchanged | **accepted** |
| `update` names a role `read` does not | **refused** — `lets 'clerk' change 'note' without reading it` |
| `update` with no `read` beside it | **refused** — `because no read grant is declared beside it` |
| `create` names a role `read` does not | **accepted** — the asymmetry that earns the arm |
| `create` names a role the entity's `create` does not | **refused** — `the entity's own create grant does not name` |

And live, as a non-owner role on PG 16 against a fresh cluster whose `crossengin apply --confirm`
converged in one pass (147 `meta` base tables, 0 remaining steps, 0 unreconciled). Before: the
`erp-government` 403, and the `erp-core` write-only behaviour, both through real HTTP. After:

```
  boot survey: [sensitive] [fields] 21 sensitive-classified field(s): commercial_sensitive 11, pii 10
               — and the three [fields] warning lines are gone

  ap_clerk POSTs a Vendor                                        HTTP 201
  ap_clerk reads it back (the credential that wrote it)
      V-001  tax_id=TAX-SECRET-1   email=ap@acme.test    ← written BEFORE the grants, now readable
      V-348  tax_id=TAX-READABLE   email=ap@grant.test
  inventory_manager reads the same rows (holds Vendor.read, not the field grants)
      V-001  tax_id=(withheld)     email=(withheld)
      V-348  tax_id=(withheld)     email=(withheld)

  case_worker POSTs a Citizen        201, national_id: "NID-348"
  case_worker PATCHes national_id    403 {"rule":"explicit_update_grant"}
```

The last two lines are the whole argument for the third arm, in two adjacent requests against one
credential: a case worker may **set** a national id and may not **change** one. The
`inventory_manager` rows are what makes the first half a real grant rather than a blanket open-up —
a role holding the entity's `read` and not the field's still gets nothing.

The three boot warning lines disappearing is the other measurement: `surveySensitiveFields` reports
**0 unreadable-by-every-role, 0 writable-by-a-role-that-cannot-read, and 0 uncreatable** across all
seven packs, where it reported 21 / 21 / 4 for `erp-core` alone and 12 uncreatable across the seven.
The test that asserted those twelve by name now asserts the empty list.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `--classified-write-mask` can now be the default rather than opt-in for the shipped packs, since the boot refusal has nothing left to name there. A tenant's own activated manifest can still declare an ungranted classified field, so flipping the default needs that path surveyed too (ADR-0339's open end 5). | Platform | 2026-11-30 |
| `FieldPermission` still has no `delete` arm and no per-transition arm, so "this field may not be changed while the record is `posted`" is a write **guard** question and not a grant one. The two vocabularies do not meet. | Platform | 2026-12-31 |
| `field_create` is unreachable in practice: a `create`-arm `abac` key is refused at boot by ADR-0340's check because its availability is `never`. Correct, and it means the position exists to be refused by name rather than to be served. | Platform | _N/A_ |
| The grants narrow `read` by dropping observer roles, which is a judgement per field rather than a derivable rule. A pack author adding a classified field gets no guidance beyond the three refusals, and nothing checks that a *new* classified field was granted at all — only that a declared grant is coherent. A fourth rule ("a sensitive-classified field has a grant") would be a real fence and would refuse 0 fields today. | Platform | 2026-11-30 |
| `computeFieldRedaction` and `validateWriteMask`, the classification-unaware originals, still have no callers (ADR-0339's open end 2) and are now further from the live pair, since neither knows about the third arm. | Platform | 2026-11-30 |

## References

- ADR-0339 (the write mask, the 7 explicit grants and the 39 open ones — the open end this closes,
  and the ADR whose "cannot make anything uncreatable" this corrects), ADR-0340 (the ABAC obligation
  and the position maps `field_create` joins), ADR-0342/ADR-0343 (`deferred` and the availability
  axis), ADR-0329 (`privilegedForClass` behind both halves so a role cannot write a class it may not
  read), ADR-0338 (`operationsForEntity` made required, the contrast for the `writeOp` default),
  ADR-0334 (a page-one failure converted into an earlier refusal), ADR-0288 (the hand-maintained
  list with no forcing function).
