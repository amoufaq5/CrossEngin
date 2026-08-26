# ADR-0279: Unaudited privileged access is not granted (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0278 (per-user inbox), ADR-0277 (digest template), ADR-0008 (audit immutability) |

## Context

ADR-0278 scoped the notification inbox to its recipient and left one deliberate escape hatch:
`?scope=tenant`, gated to roles named by `--notification-audit-role`, so an operator can still read
the whole tenant's notifications. That is a real need — and it was completely unrecorded. Someone
could read every notification in a tenant and leave no trace, which is the thing an audit trail
exists to prevent.

## Decision

- **`meta.audit_log` finally has a writer.** `@crossengin/auth` has modelled `AuditLogEntry`,
  `AuditActor` and the `AuditEmitter` seam since Phase 1, and the table has existed just as long,
  but **nothing had ever written to it.** `PostgresAuditEmitter implements AuditEmitter` over it —
  general-purpose, not notification-specific. **No new table; the count stays at 139.**
- **Append-only, structurally.** A plain INSERT with no `ON CONFLICT`, no update path and no delete
  method anywhere on the class. A record that can be rewritten is not an audit record.
- **The caller's clock is the event time.** `occurredAt` is bound as supplied rather than defaulting
  to SQL `now()`; silently substituting the database's clock would misdate the record.
- **Recorded before the data is served, and a failed record refuses the read.** This is the whole
  point: an after-the-fact write can be lost precisely when the read is one someone later needs to
  account for. So a granted escalation writes its record first, and if that write fails the request
  returns **503 `audit_unavailable`** rather than quietly serving unaudited data.
- **A refused escalation is recorded best-effort.** Someone asking for a scope they do not hold is
  worth knowing about, but the self-scoped list they *are* entitled to must not be denied because
  the audit table is down. The asymmetry is deliberate: audit is a **precondition** for privileged
  access and an **observation** of an ordinary one.
- **The record says what was read**, not merely that something was — the caller's principal, their
  roles, and the filters they ran (channel, templateId, limit, whether they paged).
- An ordinary self-scoped read writes nothing. Reading your own inbox is not privileged, and
  auditing it would bury the events that matter in noise.

## Consequences

- **Verified live** against a real Postgres:
  - a self read wrote **nothing**;
  - a granted `?scope=tenant&channel=in_app&limit=5` wrote `notifications.read_tenant_scope` with
    the actor, `["platform_admin"]`, and `{"limit":5,"paged":false,"channel":"in_app"}`;
  - a refused escalation wrote `notifications.tenant_scope_denied` with `["erp_admin"]`;
  - with `meta.audit_log` renamed away, the tenant-scope read returned **503 `audit_unavailable`**
    while the self read stayed **200** and the refused escalation still served its self-scoped list;
  - restoring the table restored the escalation, and the trail resumed.
- The platform now has a working general audit writer. Every other privileged operation that should
  leave a record — a platform-admin tenant mutation, a design-review decision, a template override —
  can use it without new machinery.
- +47 tests (operate-server **63 files / 1573**). Full workspace build + typecheck + test green.
- Follow-ups: nothing **reads** the audit trail over HTTP yet, so an operator inspects it in SQL;
  the entries are not chained or signed, unlike the `forensics` chain the audit-chain config already
  writes per request, so a database superuser could still alter history — reconciling those two
  audit paths is the real remaining work; and the other privileged operations named above are still
  unaudited, now only for want of wiring.
