# ADR-0428: An entity write is recorded in the transaction that makes it

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-17 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0406 (the chain key from the environment, `--checkpoints` / `--integrity-proof` on in the compose), ADR-0286 (a record and its chain anchor commit together, `appendWithin`), ADR-0421 (`created_by` / `updated_by` stamped from the principal), ADR-0422 (a second pooled connection inside a write transaction deadlocks the pool), ADR-0338 (classified fields are ciphertext at rest), ADR-0313 (an unrecordable privileged act is refused, not served unaudited), ADR-0427 (sign-in admission and lockout), ADR-0424 (the API connects as `crossengin_app`) |

## Context

The external due-diligence audit ranked **C-05** critical: *no audit trail in the shipped
deployment, and entity writes never reach the audit log in any configuration*. Its live evidence
(L8) was 0 rows in `meta.audit_log` and in `meta.forensic_chain_entries` after about forty writes,
including posting and reversing journal entries.

Verified against the tree at `f6faf05`, the finding was **true at the audit commit and partly fixed
since**. ADR-0406 gave the chain an environment route and turned `--checkpoints` and
`--integrity-proof` on in the compose, so a shipped deployment now has a request-level chain: the
verification's shipped arm measured **404 chain entries and still 0 `meta.audit_log` rows** for
entity writes. What was unchanged:

- `operate-runtime` had **no audit hook at all**. A create, update, delete or transition wrote no
  row; its only trace was the request-level chain entry, whose payload is request, operation and
  status — no entity id, no before, no after.
- That entry is **sampled and appended after the response**, and a failed append only reaches
  `console.error`. So a write could report success and leave no record (L8's mechanism).
- `/v1/auth/token` wrote nothing to the audit log; refusals went to a log line. The login is an
  interceptor ahead of the gateway, so not even the request-level entry covered it.

Two of the audit's sub-claims are corrected rather than repeated. *"`meta.audit_log` is empty on a
shipped deployment"* is not true as a general statement: the platform-user and credential routes
already wrote rows (`platform.user_provisioned`, `platform.membership_granted`,
`platform.user_credential_set`), so only business-entity writes were absent. And *"the `auditable`
trait adds `created_at` / `updated_at` only — no actor"* is false: the trait declares
`created_by` / `updated_by`; what was missing was a producer, which ADR-0421 has since supplied.

The audit's prescribed fix — *a mandatory, unsampled row (actor, entity, id, before/after) in the
same transaction as each write* — was checked as well as the facts, and two parts of it could not be
taken literally. A verbatim `before` / `after` would copy every classified value as plaintext into
`meta.audit_log`, which is plain JSONB and is a `PLATFORM_RECORD_TABLES` member the Article 17
erasure keeps, undoing ADR-0338. And "in the same transaction" cannot mean "through the emitter as
it was", because the emitter took its own pooled connection — ADR-0422's deadlock.

## Decision

**Every successful entity create, update, delete and transition writes exactly one
`meta.audit_log` row, anchored into the tenant's chain, in the same transaction as the write. If the
row cannot be written, the write does not happen.**

- **Where.** The record call sits in the create, update, delete and transition handlers and in
  association link / unlink (`packages/operate-runtime/src/entity-audit.ts`, `handlers.ts`,
  `association.ts`). Update and delete now always load the stored record, so `before` is the stored
  value rather than `null`. A transition's name is the row's `reason` (`transition:start_working`).
- **What `after` is.** When write effects are configured — on `erp-core` that is every write — the
  record is read again from the write's own transaction store before it is recorded, so `after` is
  what will commit. Three effects write back onto a record (the withholding stamp and the booking-rate
  stamp on the triggering document, and marking a different document paid); without the re-read the
  first two left a row whose `after` and `diff` were not what committed.
- **Redaction at write time.** A value in any sensitive class (`commercial_sensitive`, `pii`,
  `phi`, `regulated`) is stored as `{"$redacted": "<class>"}` in `before`, `after` and `diff`. The
  diff still shows that the field changed.
- **Same transaction, no second connection.** The pooled connection is wrapped so a writer can find
  the transaction it is running inside (`apps/operate-server/src/ambient-transaction.ts`), and the
  recorder writes on it through `PostgresAuditEmitter.emitWithin`. A recorder that cannot find the
  write's transaction **refuses** rather than opening one.
- **Fail closed.** A failed record maps to **503 `audit_unavailable`** and the write rolls back. The
  body distinguishes *not made* (rolled back) from *made, record missing* (link / unlink, below). The
  operator log names the error code, not the database's message text.
- **No double anchoring.** When an entity write was anchored and the response was a 2xx, the
  request-level observer skips that request (`supersedes`). A write that was recorded and then
  rolled back keeps its request-level entry.
- **Sign-in** (`login-audit.ts`). A success is recorded as `auth.login` in the session's tenant
  **before** the token is returned; if it cannot be recorded the login is 503 with no token. A
  counted wrong password is `auth.login_failed` at platform scope with no actor, and the attempt that
  locks the account is `auth.account_locked`. Those two are written after the 401 is sent and are
  **not awaited**: awaiting them would make a real account's refusal slower than an unknown email's,
  which is an enumeration oracle. Attempts refused before any password check are not recorded, so an
  unauthenticated caller cannot write rows. The route's `audit` field is required; `null` means there
  is no audit table.
- **Said at boot either way.** `[audit] entity writes: …` prints on every store, reads NOT recorded
  on `--store memory`, and states that unclassified values are copied in the clear and outlive a
  tenant deletion. The recorder is passed at both `buildOperateHttpServer` call sites, so a tenant
  serving its own activated manifest records too.

The rule behind it is the audit's own, read against the repository's: a record of a write that can
be lost after the write committed is not a record of the write. Committing the row with the write is
the only ordering in which "the write happened" implies "the row exists".

## Alternatives considered

- **Keep the request-level chain entry as the record, made synchronous.**
  - **Pros:** no handler change; one mechanism.
  - **Cons:** its payload names no entity, no id, no before and no after, and the login is outside
    the gateway, so it does not cover sign-in.
  - **Why not:** "who changed what" still could not be answered for a business record.
- **Store `before` / `after` verbatim, as the audit prescribed.**
  - **Pros:** a privileged reader sees the old value.
  - **Cons:** every classified value becomes plaintext in a retained JSONB table.
  - **Why not:** it undoes ADR-0338 and survives Article 17 erasure. The marker keeps the fact of the
    change; the stated cost is that even a privileged reader sees the marker and not the value.
- **Record through the emitter's own connection after the write.**
  - **Pros:** no ambient-transaction wrapper.
  - **Cons:** not atomic; and a second pooled connection taken while the transaction holds one is
    ADR-0422's deadlock.
  - **Why not:** both halves of the audit's remedy fail.
- **Await the failed-login record.**
  - **Pros:** a lost failure record would fail closed like the success record.
  - **Why not:** it makes the refusal for an existing account slower than for an unknown email.

## Consequences

- **Positive:** for an entity write, "who changed what, when" is answerable from `meta.audit_log`,
  with actor, record id, before, after and diff, and the row is anchored in the tenant chain that
  the hourly integrity proof verifies. A write that reports success has a row.
- **Negative:** a write now fails with 503 when its record cannot be written, which it did not
  before. Writes within one tenant serialize for the window between the chain append and commit,
  because the per-tenant chain lock is held until commit. Each non-delete write with effects costs
  one extra `get`.
- **Neutral:** reads and refusals still get only the asynchronous request-level entry, so L8 is
  closed for entity writes and not for reads.
- **Reversibility:** the recorder is one option passed at two call sites; removing it restores the
  previous behaviour. Rows already written are retained by design and cannot be withdrawn from the
  chain without breaking its anchors.

## Implementation notes

Measured before the change, from code (the old binary was not booted): no audit hook in the entity
handlers; the request-level entry appended after the response with failures logged only; nothing
written by `/v1/auth/token`.

Verified live on PG 16 in compose order, the API connecting as the confined `crossengin_app`:

- Vendor create / update / delete, account and invoice create, and lead create plus
  `start_working` each wrote one row with record id, actor, before / after / diff, and the
  transition in `reason`. `tax_id` was stored as `{"$redacted":"commercial_sensitive"}` and
  `contact_email` as `{"$redacted":"pii"}`; the lead's `full_name` and `email` were markers; a
  plaintext search over the tenant's rows found **0**.
- The tenant chain held 9 entries: 7 anchored audit rows plus request-level entries only for a GET
  and a refused send. No entity write was anchored twice.
- Refused writes wrote no row: 422 `field_not_declared`, 422 `maker_cannot_approve`, 422
  `period_locked`, 409 `unique_violation`, and a 409 on `send` (5 `invoice.send` rows for 6
  attempts, one refused).
- With INSERT on `meta.audit_log` revoked, a vendor create and a lead `qualify` both answered 503 and
  rolled back (0 rows, lead state unchanged; the same requests succeeded after re-granting). A login
  answered 503 instead of returning a token.
- 140 parallel and sequential creates produced exactly 140 rows. Twelve concurrent `start_working`
  on one lead gave 1 × 200 and 11 × 409 and exactly one `lead.start_working` row.
- `--integrity-proof` read the entity rows as `verified`: tenant scope `sigs=12`, then `sigs=38`
  after the re-read fix, on `--store pg` as `crossengin_app`; `sigs=25` on `--store pg-columns`;
  platform scope `verified` in every run.
- `--store pg-columns` was run **as the owner**, because that store cannot boot as `crossengin_app`
  (`permission denied for database crossengin`). Its rows carried before / after / diff, markers for
  sensitive values, and a delete's `before`. The revoked-INSERT arm was **not** run on that store: a
  REVOKE does not bind a superuser owner.
- Cost, measured by the implementer before the re-read was added and not re-measured since: about
  +2–3 ms per sequential write (3.9–5.7 ms without auditing against 6.6–7.4 ms with); 40 parallel
  writes in one tenant took 51–78 ms without and 149–256 ms with.

Mutation-checked, each reversed: the 503 mapping, the update and delete record-loading clauses, the
redaction marker, writing outside the transaction, swallowing a failed login record, awaiting the
failure record, dropping the recorder at either `node.ts` call site, the observer ignoring
`supersedes` or its 2xx condition, `server.ts` dropping the forward, the re-read, and redaction of
`diff`. The delete-loading mutation first survived because default write guards loaded the record
anyway; its fixture now sets `writeGuards: []`.

Two facts found in passing and not changed here: `auditEmitterAvailable` answers
`store === "pg"` while the emitter is built whenever there is a connection (only `node.test.ts`
reads that function), and a pg error's `name` is `"error"`, so refusal lines read `error 42501`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Unclassified personal data in `before` / `after` outlives an Article 17 tenant deletion: 405 of `erp-core`'s 426 own fields carry no classification (every `Contact` field, `Employee` names, `Account.billing_email`, free-text `notes` / `memo`), and `meta.audit_log` is retained. Scrubbing at erasure breaks each row's chain anchor. Record field names without values, classify the personal fields, or make the proof name the retention? Stated at boot; not closed. | CrossEngin platform | _unscheduled_ |
| Effect writes to **other** records are not recorded: a Payment create marks its invoice `paid` through an effect and the invoice gets no row; journal entries posted by a transition are named only by the transition's row. Recording each costs a chain append and a signature per line. | CrossEngin platform | _unscheduled_ |
| Link / unlink commit before their record, so they cannot be atomic: a failure is a 503 saying the write stands without its record. Latent — no shipped pack declares a many-to-many relation. | CrossEngin platform | _unscheduled_ |
| The edge adapter takes a Postgres store and has no recorder option and no boot line, so an edge deployment records nothing and does not say so. Latent — nothing shipped uses it. | CrossEngin platform | _unscheduled_ |
| Failed-login records are fire-and-forget: attempts against an already-locked account are not recorded, and nothing bounds how many are pending at once (total volume is bounded by login admission and the lockout). Only the success record fails closed. | CrossEngin platform | _unscheduled_ |
| Reads and refusals still get only the asynchronous, lossable request-level entry. | CrossEngin platform | _unscheduled_ |
| Writes within one tenant serialize on the chain lock until commit; the cost under sustained single-tenant load is measured only at 40 parallel writes. | CrossEngin platform | _unscheduled_ |

## References

- `packages/operate-runtime/src/entity-audit.ts`, `handlers.ts`, `association.ts`, `compile.ts`
- `apps/operate-server/src/ambient-transaction.ts`, `entity-audit-recorder.ts`, `login-audit.ts`,
  `audit-log-store.ts` (`emitWithin`), `audit-chain.ts` (`supersedes`), `auth-token-route.ts`,
  `server.ts`, `node.ts`
- External due-diligence audit, finding C-05 and live test L8
