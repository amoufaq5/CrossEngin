# ADR-0278: The inbox is yours, not the tenant's (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0277 (digest template), ADR-0276 (digest assembly), ADR-0273 (tenant notifications) |

## Context

`GET /v1/meta/notifications` returned **every** dispatch in the tenant. Any principal holding a
notification-reading role saw every other person's notifications — decisions addressed to someone
else, and (once ADR-0277 rendered them) the contents of another admin's digest. ADR-0277's own
live run made it visible: one admin's `/setup` page listed both admins' summaries. The route was
tenant-isolated but not recipient-isolated.

## Decision

- **Your inbox is the set of dispatches you have a `delivered` delivery row for.** The dispatch
  deliberately stores no recipient identities, but `meta.notification_deliveries` already stores one
  `recipient_address_sha256` per recipient. That hash is the whole mechanism — no new table, no new
  column, and no de-anonymisation of anything the ledger was keeping hashed.
- **Filtering on `delivered` makes the semantics exact.** A notice still `deferred` by quiet hours
  has not been delivered; one `suppressed` because it was rolled into a digest, or opted out of, was
  deliberately not sent to that person. Neither belongs in their inbox — while the digest that
  replaced them does, and appears because it has its own `delivered` row.
- **An unresolvable identity yields an empty hash list, never a null one.** Null means "list the
  whole tenant"; returning it for a caller the ledger cannot identify would hand them everything —
  the exact leak being closed. The same rule holds in the store: an **empty** address array short-
  circuits to an empty page rather than degenerating into an unfiltered query.
- **`?scope=tenant` is an explicit, role-gated escalation.** Auditing the whole tenant's
  notifications is a real need, so it stays available — to roles named by
  `--notification-audit-role`, and to nobody by default. The response envelope reports the `scope`
  it actually served, so a caller can never mistake a self-scoped list for a complete one.
- **Identity comes from the principal, and the address set from the channel rule.**
  `addressHashesFor` runs the existing `addressFor(channel, recipient)` over every
  `NOTIFICATION_CHANNEL`, so a person's hashes stay correct if that rule changes — today
  `sha256(userId)` for in-app/push and `sha256(email)` for the rest. `identityFor` returns it only
  for an **active member of this tenant with an active user row**; a member of another tenant, a
  revoked membership or a suspended user all resolve to null.
- The filter is **opt-in by wiring**: with no identity resolver the route behaves exactly as before,
  so a memory-store deployment is unaffected.

## The operational change this carries

`--api-key` has always accepted `key:role:tenant[:principalId]`, and the fourth field is now
load-bearing: it must be the principal's `meta.users.id`. **A key with no user id gets an empty
inbox** — correct and safe, but surprising if unexpected. Both deployment guides now say so.

## Consequences

- **Verified live** against a real Postgres, with three keys bound to three real users:
  - Ada and Ben (both admins, both recipients) each saw the decision; **Cleo — a viewer, so never a
    recipient — saw zero.**
  - After Ben opted out of a second decision: **Ada 2, Ben 1**. The filter is genuinely
    per-delivery, not per-tenant.
  - `?scope=tenant` as `platform_admin` returned everything and reported `scope: "tenant"`; the same
    query as `erp_admin` was silently kept at `scope: "self"` — no escalation.
  - Every unidentifiable principal returned **0**: an unbound key, a key naming another tenant's
    user, and a key naming a suspended user.
- +49 tests (operate-server **62 files / 1526**). Full workspace build + typecheck + test green.
- Follow-ups: the read path identifies a caller by `principalId` as their user id, which is right for
  api-key and JWT-subject principals but has no story yet for a service principal that legitimately
  acts for many users; there is still no per-user *read state*, so "unread" remains the recency
  approximation from ADR-0273; and a tenant-scope read is not itself audited, which it should be
  before anyone relies on it for compliance.
