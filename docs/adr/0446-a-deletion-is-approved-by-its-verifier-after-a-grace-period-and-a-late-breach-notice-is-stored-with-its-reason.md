# ADR-0446: A deletion is approved by its verifier after a grace period, and a late breach notice is stored with its reason

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0379 (per-subject erasure refused; `--deletion-subject-scope`), ADR-0387 (Article 12(3) deadline sweep and extension), ADR-0372 (`present_not_erased`, unevidenced controls), ADR-0363 (widening proof and `constraint_widening_unproven`), ADR-0437 (pinned chain keys), ADR-0438 (removed flags refused at parse), ADR-0424 (`crossengin_app`), ADR-0313 (recorded reads), ADR-0338 (refuse only when nothing correct breaks), ADR-0351 (proof content tags) |

## Context

The external due-diligence audit, verified against the tree at `f6faf05`, left four privacy and
compliance findings open or partly fixed, and register P2.13 recorded a fifth.

- **C-04, mitigated.** ADR-0379 refused the dishonest kind, but per-subject erasure does not exist,
  `--deletion-subject-scope tenant` destroys every subject, and a verified deletion had **no grace
  period**: nothing between verification and execution let it be cancelled.
- **H-05, open.** Four-eyes on deletion and erasure was a self-asserted body string: `approvedBy` on
  the delete and erase routes and `submittedBy` on submit were free text, so one holder of the grant
  could delete or erase a tenant. `--deletion-runner-approved-by` set the runner's approver from
  configuration. Latent: the deletion flags are off in the shipped compose.
- **H-19, partly fixed.** Compliance outputs reported success with no evidence. Measured:
  auto-revocation recorded a fresh revoke decision every tick for the same items and never moved
  them, because the transition map forbade `pending`/`in_review` → `auto_revoked`, so the boot line
  said `revoked=N` forever and a campaign could not complete; the four-control report still printed
  `CERTIFIABLE`; the audit-chain control checked links and content and no signatures; and the
  encryption control checked schema `meta`, which declares no at-rest column, so it was always
  `scope_absent`.
- **H-20, partly fixed.** No Article 15/20 path; no route listing pending requests; the deadline
  extension (ADR-0387) had no surface; `meta.users` survives a tenant erasure unnamed;
  `present_not_erased` carries no reason or horizon.
- **P2.13.** A breach notification past its 72-hour deadline could not be stored:
  `incident_communications_breach_window_check` and the contract both refused it, so the first fact a
  regulator asks for was unrepresentable. Article 33(1) requires a late notification to carry the
  reasons for the delay.

## Decision

**A deletion is approved by the principal who verified it, read from the stored request.** The
synchronous delete and erase routes require a `relatedDeletionRequestId` and take the approver from
that request's verifier. A body `approvedBy` is 400 `approver_is_the_verifier`; a caller who is the
verifier is 403 `four_eyes_required`. A body `submittedBy` on submit is 400
`submitter_is_the_credential`, because the submitter is the authenticated caller, which is what gives
the verify route's own four-eyes check teeth. The delete route claims the request `in_progress`, then
marks it `completed` with the tombstone, or `rejected` when the rollback is proven; an unknown failure
leaves it `in_progress`. `--deletion-runner-approved-by` is **refused at parse**, naming the reason:
what it set was an approval nobody authenticated, so there is no hatch.

**A verified deletion waits a grace period, which gives way to Article 12(3).** Default 7 days,
`--deletion-grace-days` (0–90), announced at boot. Execution is due no later than one day before the
request's deadline. The rule is applied in the runner's SQL and on both synchronous routes, which
refuse with 409 `grace_period_running`. The existing reject route is the cancellation.

**The deadline extension and the pending list have routes.** `POST …/deletion-requests/{id}/extend-deadline`
under the verify grant, and `GET …/deletion-requests/pending` under
`--deletion-request-reconcile-role`, with optional `?standing` and `?limit`; the read is recorded.

**A late breach notification is stored with its reason.** `breachNotificationDelayReason` is required
past the 72-hour deadline. `incident_communications_breach_window_check` is widened, and
`incident_communications_delay_reason_check` refuses a reason on an on-time notice.

**A compliance control says what it checked.**

- Auto-revocation resolves the item: `pending` and `in_review` reach `auto_revoked`,
  `autoRevokedItem()` builds the resolved item, and the persisting runtime writes it after recording
  the decision.
- The boot line no longer says `revoked=N`; it says the revoke decisions were recorded and not
  applied, because the reviewed grants come from configuration.
- The report heading reads "Control readiness: … every automated control satisfied" or "NOT READY",
  with a line saying it is not a certification.
- The encryption control reads a new `encryptionSchema` setting, default `public`, where entity
  tables live.
- The audit-chain control also checks signatures against the deployment's pinned chain keys
  (ADR-0437). With no pinned keys it is unsatisfied and says why.

## Alternatives considered

- **A boot hatch for `--deletion-runner-approved-by`.** Refused: the flag configured an approval no
  principal made, so keeping it would keep H-05 behind a flag. Nothing in `deploy/` passes it, and
  refusing a removed flag at parse matches ADR-0438.
- **Keep the body `approvedBy` and check it differs from the executor.** Refused: a string the caller
  types is not evidence that anyone approved.
- **A fixed grace period that ignores the deadline.** Refused: a wait that can push execution past the
  Article 12(3) deadline trades one obligation for another. The wait gives way instead.
- **Keep refusing a late breach notification.** Refused: the record a regulator asks for first could
  not be stored, and Article 33(1) expects late notices with reasons.
- **Build the Article 15/20 export now.** Not taken in this slice. The implementer's reason, that no
  mapping from a data subject to records exists, was refuted by review for the platform subset:
  `meta.users.email` is UNIQUE, and memberships, preferences and audit actor fields key on the user
  id. The export is unbuilt work, not impossible work.

## Consequences

- **Positive:** one principal can no longer delete or erase a tenant alone; a verified deletion can
  be cancelled for a week; operators can list pending requests and extend a deadline over HTTP; a late
  breach notice is storable with its reason; auto-revocation completes campaigns; and three controls
  no longer report success they did not check.
- **Negative:**
  - The delete and erase routes now act only under a verified request, so mounting them without
    `--deletion-request-routes` gives routes that answer 404 `deletion_request_not_found` to every
    call. Review added a boot warning for each.
  - A synchronous delete inside the grace period is 409 where it used to run.
  - A refused delete now **settles the verified request `rejected`** — see open question 1.
  - The audit-chain control is unsatisfied on every deployment that pins no chain keys.
- **Neutral:** the `delay_reason_check` is reported on populated tables; the table is empty
  everywhere today, because `PostgresCustomerCommsStore` still has no caller.
- **Reversibility:** the grace period can be set to 0. The approver rule and the refused flag are
  route and parser changes; the CHECK widening is a schema change that would need a narrowing to
  undo.

## Implementation notes

- Changed: `packages/incident-response/src/comms.ts`,
  `packages/incident-response-runtime-pg/src/comms-store.ts`,
  `packages/kernel/src/bootstrap/meta-schema.ts`, `packages/tenant-lifecycle/src/gdpr-deletion.ts`,
  `packages/tenant-lifecycle-pg/src/` (`deletion-request-store.ts`, `deletion-runner.ts`,
  `deletion-reconciliation.ts`), `packages/access-reviews/src/items.ts`,
  `packages/access-reviews-runtime/src/enforcement.ts`,
  `packages/access-reviews-runtime-pg/src/persisting-runtime.ts`,
  `packages/certification-runtime/src/report.ts`, and in `apps/operate-server/src/`
  `deletion-request-routes.ts`, `tenant-deletion-routes.ts`, `tenant-erasure-routes.ts`,
  `certification.ts`, `cli.ts`, `deletion-scheduler.ts`, `node.ts`, `node.test.ts`, each with tests.
- **Migration (review supersedes the implementer).** The implementer reported the widened
  `breach_window_check` as standing manual SQL. Review measured it on a populated table: the
  `EXPLAIN` probe returns `One-Time Filter: false`, so it is proven a widening and planned
  automatically once the new column exists. The new `delay_reason_check` is implied by no live
  constraint, so it is the one reported as `constraint_widening_unproven` with its SQL.
- **Review fixes:** boot warnings when the delete or erase routes mount without the request routes,
  with a text fence in `node.test.ts`; the grace line printed by each synchronous route's block, not
  only by the runner's; a false comment in `gdpr-deletion.ts` claiming a test compared the JS function
  and the SQL predicate. Review measured that on PG 16 with session time zone Asia/Tokyo: the store's
  SQL against `deletionExecuteNotBefore` over 4,000 random instants gave 0 disagreements (3,019 due).
- **In process:** kernel 973, tenant-lifecycle 513, tenant-lifecycle-pg 535, incident-response 155,
  incident-response-runtime-pg 330, certification-runtime 71, access-reviews 214,
  access-reviews-runtime 126, access-reviews-runtime-pg 201, testing 906, all passing.
  operate-server typecheck clean; the implementer's full run was 6,033 of 6,034, the one failure being
  `manifest-view.test.ts`, which no file here touches and whose cause was not traced. Review ran the
  scoped files only (593 passing, `node.test.ts` 57).
- **Mutation-checked, each reversed:** verifier-equals-caller check removed (2 fail); chain control
  passing without pinned keys (1); auto-revoked item write removed (1); breach `>` to `>=` (1);
  reason-on-an-on-time-notice refusal removed (1); `?standing` filter removed (1); extend-deadline
  `not_found` → 404 mapping broken (1); certification passing whatever the signature verdict (1);
  grace dropped from `dueForExecution` (1); the erasure-route warning text (1).
- **Live, implementer, PG 16 as the non-owner `serving` role:** late breach notice without a reason
  refused by `breach_window_check`, with a reason stored, on time with a reason refused by
  `delay_reason_check`, on time without stored; the runner query with the 7-day wait returned only the
  request verified 8 days ago and the one near its deadline, and without it all three; the verifier as
  executor 403, a request in its grace period 409, a different executor approved; the pending list and
  the extension worked. The server was not booted.
- **Live, independent run, PG 16, API as `crossengin_app`** (supersedes both where they differ):
  - submit naming `submittedBy` 400 `submitter_is_the_credential`; the submitter verifying 403
    `four_eyes_required`; a second person verifying (`email_link`) 202, tenant read-only, execution
    allowed after 7 days;
  - the verifier deleting 403 `four_eyes_required`; a body `approvedBy` 400 `approver_is_the_verifier`;
    a delete inside the grace period 409 `grace_period_running`;
  - pending list 200; extension with a blank reason 400, beyond three months 409
    `exceeds_article_12_cap`, by two months 200;
  - grace 0, as the owner, on a tenant with data: 200, a v4 tombstone approved by the verifier and
    executed by a third person, tenant `deleted`;
  - `--deletion-runner-approved-by` and `--deletion-grace-days 91` each exit 2;
  - late breach notice as app: no reason refused, with a reason stored, on time with a reason refused,
    on time stored; the contract reports the late one as not timely.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 1. **A refused delete consumes the verified request.** *Half closed in the commit that landed this ADR*: a refusal that settles the request `rejected` now restores the tenant from `pending_deletion` to `active` through the same `TenantStateMover` the reject route uses, and the 409 carries `tenantRestored` (`null` when nothing was asked). The move is also recorded in `meta.tenant_lifecycle_events` as a `restore`, through the reject route's own recorder, and the 409 carries `lifecycleRecorded` — a review after the commit found the first version moved the row and wrote no event, so the trail's last word stayed `schedule_deletion` while the tenant was `active`. What stays open: the request itself is still consumed. On the shipped `crossengin_app` role **every** delete is refused (`rls_would_confine_this_session`), so the Article 17 deletion surfaces cannot complete on the default role at all; an empty tenant (`scope_empty`) and a caller's body mistake (`input/performed_subsystem_attested`) are also recorded as rejections. The contract has no `in_progress` → `verified` edge, and adding one is a decision about ADR-0321's runner rule rather than a patch. | CrossEngin platform | _unscheduled_ |
| 2. **Per-subject erasure** is still refused at parse (ADR-0379): `tenant` scope destroys every subject. | CrossEngin platform | _unscheduled_ |
| 3. **Article 15/20 export is not built.** Implementable for the platform subset (see Alternatives); `data-lineage` has no importers. | CrossEngin platform | _unscheduled_ |
| 4. **`meta.users` after a tenant erasure is not named in the proof**, and `present_not_erased` still has no reason or horizon: both need new signed content (`content.v5`), and erasing `meta.users` would meet the restrictive references into it. | CrossEngin platform | _unscheduled_ |
| 5. **The verify body accepts any `verificationMethod`**, while the column admits five; a bad value is 409 `illegal_transition` carrying the raw constraint name instead of a 400 naming the allowed values. | CrossEngin platform | _unscheduled_ |
| 6. **An api-key naming no person can submit a request**, recorded under the one placeholder id every such key shares. | CrossEngin platform | _unscheduled_ |
| 7. **`refused_four_eyes` requests stay `verified` and take runner batch slots every tick**, which could starve other requests. Reachable only with `--deletion-runner-executed-by` set to a verifier's UUID; the default `system:deletion-runner` cannot collide. | CrossEngin platform | _unscheduled_ |
| 8. **No reviewer decision route (H-19)**: campaigns complete only through auto-revocation under revoking policies; it needs an attestation and four-eyes design. | CrossEngin platform | _unscheduled_ |
| 9. **Recorded revoke decisions are not applied to access**: the reviewed grants are operator-edited configuration. | CrossEngin platform | _unscheduled_ |
| 10. **No shared transaction** between an auto-revocation decision and its item write; a failed item write is re-planned on the next tick. | CrossEngin platform | _unscheduled_ |
| 11. **The encryption control covers one configured schema**, so per-tenant `t_<hex>` schemas are not checked. | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-server/src/deletion-request-routes.ts`, `tenant-deletion-routes.ts`,
  `tenant-erasure-routes.ts`, `certification.ts`, `cli.ts`, `deletion-scheduler.ts`, `node.ts`
- `packages/tenant-lifecycle/src/gdpr-deletion.ts`; `packages/tenant-lifecycle-pg/src/deletion-request-store.ts`,
  `deletion-runner.ts`, `deletion-reconciliation.ts`
- `packages/incident-response/src/comms.ts`; `packages/kernel/src/bootstrap/meta-schema.ts`
- `packages/access-reviews/src/items.ts`; `packages/access-reviews-runtime/src/enforcement.ts`;
  `packages/certification-runtime/src/report.ts`
- GDPR Articles 12(3), 15, 17, 20 and 33(1)
- ADR-0379, ADR-0387, ADR-0372, ADR-0363, ADR-0437, ADR-0438, ADR-0424, ADR-0338
