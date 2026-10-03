# ADR-0324: A finding the chain cannot raise gets an incident

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Authors** | amoufaq5 |
| **Reviewers** | amoufaq5 |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0288, ADR-0293, ADR-0294, ADR-0304, ADR-0313, ADR-0318, ADR-0322, ADR-0323 |

## Context

ADR-0323 gated deletion reconciliation on verification and closed with this as its first open
question, calling it the most valuable remaining follow-up in the line:

> `evidence_unverified` and `ambiguous_evidence` are findings that the chain cannot raise and nothing
> escalates. Both deserve a `sev1` through ADR-0293's `IncidentDeclarer`, with a once-per-episode key
> so a 3-second scheduler does not declare repeatedly.

The "cannot raise" is the whole point and bears restating. Nothing in the forensic chain commits to a
tombstone's **scope** — ADR-0318 excluded it deliberately — and `proofSha256` commits to
`contentManifestSha256` rather than to the scope. So editing a stored tombstone's scope leaves every
digest and the chain entry byte-identical, and `--integrity-proof-config` reports an intact chain over
a falsified erasure record. ADR-0323 verified that live: 9 destroyed invoices rewritten to 1, with
`proof_sha256`, `content_manifest_sha256` and `chain_entry_hash` all unchanged.

So the platform's one automated tamper alarm is structurally blind to this class, and the only two
detectors that can see it were reporting to a log line and two routes. A finding that nothing else
will ever notice is precisely the finding that needs an incident.

## Decision

**`--deletion-escalation-config` declares a `sev1` and pages when a deletion proof does not verify,
one incident per request, closed out when the finding resolves.**

`DeletionEvidenceEscalator` sits in the app beside `IntegrityEscalator`, consuming reconciliation
verdicts and audit findings. Three rules shape it.

### One incident per episode, keyed on the request

The scheduler re-examines a stranded request every tick — every three seconds in the live run — so a
declaration per pass would be hundreds of incidents for one tampered row.
`findOpen(deletionEvidenceKey(requestId))` asks the store what this request already has open before
declaring, which is ADR-0294's rule, and it survives a restart because the answer is a row rather than
a memory. Verified live: one `INC-2026-0001` across a dozen ticks, adopted thereafter.

The key is the **request**, not the tombstone: the request is the unit the scheduler re-derives, and
it is also the unit `ambiguous_evidence` is about (two tombstones, one request).

### No fallback declarer — the opposite of the integrity escalator

ADR-0304 gave `IntegrityEscalator` a `FallbackIncidentDeclarer` so a one-shot compromise finding still
pages when the store is unreachable, accepting a possibly-colliding in-process id as the price.

This finding is **not** one-shot. The next scheduler tick re-derives it from the same two rows, so a
failed declaration is retried rather than lost, and an in-process id would risk colliding with a
stored one for no gain. That is exactly ADR-0293's reasoning for the SLO loop, and the two escalators
now differ for a stated reason rather than by accident.

### A recovery closes it out

An evidence finding is not permanent — ADR-0323 verified that restoring a tampered scope let the next
tick complete the request. So `RESOLVING_VERDICTS` (`completed_by_evidence`, `not_stranded`) closes out
whatever the request has open: cancelled, or left alone when a human has triaged it, which is the
declarer's rule and not a shortcut here.

`never_committed` is deliberately **not** resolving. A request that escalated as `evidence_unverified`
had a tombstone; reading `never_committed` later means that tombstone has since *vanished*, which is
worse than what was declared. The incident stays open.

`never_committed` and `too_recent` ask the declarer **nothing** — no `findOpen`, no write. That matters
because they are the common case on every tick.

### The audit route escalates too, even though a human triggered it

`GET .../unproven` (ADR-0323) is human-triggered, and this still declares. The audit's whole purpose is
to find a compromise the chain cannot see; one found warrants the incident and the page regardless of
who was looking, and the escalator's idempotence means re-running the audit adopts rather than
declares. Verified live: two consecutive audits, one incident.

`POST .../{id}/reconcile` escalates through a separate hook, because a deployment may expose these
routes without running the scheduler (ADR-0321 allows it) and that would otherwise be the only path
that ever sees an `evidence_unverified`.

### And the inconsistency ADR-0323 flagged against itself

`GET .../stranded` is now audit-recorded like `.../unproven`, with the same reader's-tenant rule and
the same refusal when none resolves (ADR-0313). It was the one privileged read in this surface that
left no trace.

## Alternatives considered

- **Option A:** escalate from inside `DeletionReconciler`, where the finding is produced.
  - **Pros:** no app-level wiring; every caller of the reconciler gets escalation for free.
  - **Cons:** `tenant-lifecycle-pg` would depend on `incident-response-runtime` and carry policy —
    severity, category, who declares, where to page — that belongs to a deployment.
  - **Why not:** `IntegrityEscalator` already established the shape: the finding is produced in a
    package, the escalation policy lives in the app.

- **Option B:** reuse `IntegrityEscalationConfigSchema` rather than defining a sibling.
  - **Pros:** one schema, literally identical fields.
  - **Cons:** its defaults carry integrity-verdict reasoning, and a deployment should be able to page
    a different rotation for "this tenant's erasure proof is false" than for "the audit chain is
    broken".
  - **Why not:** the duplication is four fields; the coupling would be a policy decision disguised as
    a type.

- **Option C:** key the episode on the tombstone rather than the request.
  - **Pros:** a tampered row is arguably the thing that is wrong.
  - **Cons:** `ambiguous_evidence` has two tombstones and no single subject, and the *request* is what
    the scheduler re-derives — so a tombstone key would still need a request fallback.
  - **Why not:** one key for both findings, and it matches what gets re-examined.

- **Option D:** share `onReconciled` instead of adding `onEscalate`.
  - **Pros:** one callback.
  - **Cons:** `onReconciled`'s rule (ADR-0322) is to report **only what was written**, precisely so a
    standing fact is not logged every tick. Escalation needs the opposite — the verdicts that were
    *not* applied are the whole point.
  - **Why not:** the two hooks want opposite inputs. Escalation is safe to hand everything because it
    is idempotent per episode; logging is not.

- **Option E:** declare but do not page, to avoid requiring an alert policy.
  - **Pros:** a deployment could turn this on with no routing configured.
  - **Cons:** ADR-0288 already settled it — "escalation with nowhere to page is not escalation" — and a
    sev1 nobody is told about is a row in a table.
  - **Why not:** `alertPolicy` is required, as it is for the integrity escalator.

## Consequences

- **Positive:** the one tamper class the forensic chain is structurally unable to detect now raises a
  paging `sev1`, once per episode, and cancels itself when the evidence is put right. Both directions
  feed it — the scheduler's reconciliation and the audit of already-completed requests.
- **Negative:** a deployment without `--deletion-escalation-config` is exactly where it was: the
  finding is a log line and two routes. The flag is off by default because it requires an alert policy,
  so this is opt-in protection.
- **Negative:** the escalator declares `securityIncident: true` and `sev1` on every finding, with no
  gradation. A tombstone that is merely `unwitnessed` (no chain entry) is treated as gravely as one
  whose scope was rewritten, though the first can happen to a row written outside the pipeline.
- **Neutral:** the page is a `console.error` line, as the integrity escalator's is. Wiring
  `PageDirective` to a real provider is unaddressed platform-wide and not this increment's to invent.
- **Reversibility:** off unless the config file is given, and the config itself requires an explicit
  alert policy, so nothing escalates by default.

## Implementation notes

- `apps/operate-server/src/deletion-evidence-escalation.ts` and `deletion-escalation-config.ts`; the
  scheduler gained `onEscalate` (awaited, given every result) and the routes gained `escalate` /
  `escalateVerdict` hooks so the route layer imports no incident types.
- Two severity vocabularies meet here and the test now pins the bridge: an `AlertPolicy` route is keyed
  by the **alert** severity (`P0`–`P3`) while the incident carries `sev1`–`sev5`, and
  `planPageDirective` maps between them via `SEVERITY_TO_ALERT_SEVERITY`. The first fixture wrote
  `sev1` into a route and was refused by the schema.
- `pnpm -r typecheck` also caught a test-only slip the whole app suite could not: a `page` callback
  written as `(page, incident) => pages.push(...)` returns `number`, not `void`. Running vitest is not
  running the type checker, which is the point of ADR-0307's overlay.
- `node.ts` captures the escalator into a `const` through an IIFE before building the closures rather
  than relying on control-flow narrowing of a `let` inside a callback.
- `--deletion-escalation-config` implies `--deletion-request-routes`, so it is covered by
  `needsAuditEmitter` through that flag; it is in the per-flag test list anyway, which now guards the
  implication (ten entries).
- Verified live against a real Postgres and the real server, through the whole lifecycle. Tampering
  `tomb_59408969…`'s scope and stranding its request produced **`INC-2026-0001`**, `sev1`, `security`,
  `security_incident = true`, `auto_declared_for = deletion_evidence:dreq_24cc38db…`, affected tenant
  recorded, and a page to `pagerduty_phone` — then **one** incident across a dozen three-second ticks,
  declared exactly once. Restoring the scope let the next tick complete the request and **cancelled**
  the incident with `cancelled_reason = "verdict is now completed_by_evidence"`. Pointing a *completed*
  request at a missing tombstone and loading `GET .../unproven` twice declared **`INC-2026-0002`**
  ("Deletion proof is missing for completed request …") on the first call and **adopted** it on the
  second. The stranded listing now writes a `platform.deletion_requests_stranded_read` audit row.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Every finding is a `sev1` security incident. An `unwitnessed` tombstone — plausibly a row written outside the pipeline — is graded the same as a rewritten scope, where a per-defect severity map would be more honest. | amoufaq5 | _unscheduled_ |
| A `PageDirective` is still only logged, here and in the integrity escalator. Nothing in the platform delivers one to a real provider, so the page is a claim about intent. | amoufaq5 | _unscheduled_ |
| Nothing schedules `auditCompleted` (ADR-0323's open question, still open): the reverse direction escalates only when a human loads the route. The forward direction is covered by the scheduler. | amoufaq5 | _unscheduled_ |
| The escalation itself is not written to `meta.audit_log`. `IntegrityEscalator` takes an audit emitter so its escalation is anchored in the chain (ADR-0286/0288); this one declares the incident and pages without leaving an anchored audit row. | amoufaq5 | _unscheduled_ |
| A tombstone with no `relatedDeletionRequestId` — every one the synchronous route of ADR-0320 writes — is still outside both directions, so a tamper on one is escalated by nothing. | amoufaq5 | _unscheduled_ |

## References

- ADR-0323 (the open question this closes, and the live proof that the chain cannot see a scope
  tamper), ADR-0318 (why the chain commits to digests and identity but not the scope), ADR-0293 (the
  declarer seam, and why a retried loop needs no fallback), ADR-0294 (`autoDeclaredFor` and adopting an
  open episode), ADR-0304 (the fallback declarer, and why this escalator does not use it), ADR-0288
  (escalation with nowhere to page is not escalation), ADR-0313 (an unrecordable privileged read is
  refused), ADR-0322 (`onReconciled`'s log-only-what-you-wrote rule, which is why escalation needed its
  own hook).
