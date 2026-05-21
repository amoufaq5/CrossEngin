# ADR-0190: `crossengin retention diff-timeline --with-actor-names` actor display name surfacing on diff-timeline (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-timeline.with-actor-names)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0189 (diff-timeline base), ADR-0185 (--with-actor-names on retention history), ADR-0186 (--actor-id filter), ADR-0170 (history table) |

## Context

ADR-0189 shipped `crossengin retention diff-timeline` merging two tenants' history events into a single chronological timeline tagged `[A]`/`[B]`. The output answered "when did A and B diverge?" but not "who made each change." Operators reading a divergence audit had to either inspect JSON output + look up each `actorId` against `meta.users` manually, or correlate with `crossengin retention history --with-actor-names` per tenant (defeating the merge convenience).

ADR-0185 shipped `--with-actor-names` on `retention history` — LEFT JOIN `meta.users` + render `display_name (uuid)` with email fallback + `<system>` for null actor_id. The pattern was operationally proven; ADR-0189 Q3 listed this as future work.

M6.7.zz.tenant.opt-out.cli.diff-timeline.with-actor-names closes ADR-0189 Q3 by adding the same flag to `retention diff-timeline`, composing the ADR-0185 LEFT JOIN infrastructure with the ADR-0189 timeline merge.

## Decision

### CLI surface

```
crossengin retention diff-timeline <tenant-a> <tenant-b> <table>
                                   [--since DATE]
                                   [--until DATE]
                                   [--limit N]
                                   [--with-actor-names]
                                   [--format human|json]
```

- Boolean flag, default off — backward-compatible.
- When set, adapter does `LEFT JOIN meta.users u ON u.id = h.actor_id` and returns `actorDisplayName` + `actorEmail` on each `TimelineEntry`.
- When omitted, adapter omits the JOIN entirely — no extra query cost on the default path.

### Adapter changes

`DiffHistoryTimelineInput` gains `joinActor?: boolean`:

```ts
export interface DiffHistoryTimelineInput {
  readonly tenantIdA: string;
  readonly tenantIdB: string;
  readonly tableName: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly joinActor?: boolean;  // NEW
}
```

`TimelineEntry` gains a required `actorId` (previously omitted!) plus optional `actorDisplayName` + `actorEmail`:

```ts
export interface TimelineEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantSide: "A" | "B";
  readonly tableName: string;
  readonly eventKind: OptOutHistoryEventKind;
  readonly actorId: string | null;  // NEW
  readonly occurredAt: string;
  readonly prevState: Record<string, unknown> | null;
  readonly nextState: Record<string, unknown> | null;
  readonly attributes: Record<string, unknown>;
  readonly actorDisplayName?: string | null;  // NEW (when joinActor=true)
  readonly actorEmail?: string | null;  // NEW (when joinActor=true)
}
```

### Why `actorId` is now required (not added in ADR-0189)

The original ADR-0189 design omitted `actorId` from `TimelineEntry` since the human output didn't need it (the timeline was already tagged by `tenantSide`). With `--with-actor-names` the actor must be available to the renderer regardless of whether the JOIN ran (so `<system>` can be detected for null actor_id). Surfacing `actorId` is a one-time forward-compat improvement.

This is a minor breaking change in the kernel-pg public type surface but contained — no production consumer relies on the absence of `actorId`. Tests that constructed `TimelineEntry` literals were updated to include `actorId: null` (or a real UUID) in the few CLI test cases that pre-existed under ADR-0189.

### SQL aliasing

The adapter now uses `h.` consistently for the history table (matching ADR-0185's pattern):

```sql
SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
       h.occurred_at, h.prev_state, h.next_state, h.attributes
       [, u.display_name AS actor_display_name, u.email AS actor_email]
FROM meta.tenant_retention_opt_out_history h
[LEFT JOIN meta.users u ON u.id = h.actor_id]
WHERE (h.tenant_id = $1 OR h.tenant_id = $2)
  AND h.table_name = $3
  [AND h.occurred_at >= $4]
  [AND h.occurred_at <= $5]
ORDER BY h.occurred_at ASC, h.id ASC
LIMIT $N
```

Aliasing-always (not just when JOIN-present) keeps the query shape uniform — easier to reason about, avoids any column-ambiguity surprise if `meta.users` adds new columns shadowing history columns. The 2 ADR-0189 tests that asserted bare-column SQL substrings were updated to use the `h.` prefix; no semantic change.

### CLI rendering

`formatActor` helper from ADR-0185 generalized to accept any entry shape with `actorId` + optional `actorDisplayName` + `actorEmail`:

```ts
function formatActor(e: {
  readonly actorId: string | null;
  readonly actorDisplayName?: string | null;
  readonly actorEmail?: string | null;
}): string {
  if (e.actorId === null) return "<system>";
  const name = e.actorDisplayName ?? e.actorEmail;
  if (name === undefined || name === null) return e.actorId;
  return `${name} (${e.actorId})`;
}
```

The signature was widened from `OptOutHistoryEntry` to a structural type so both ADR-0185 (retention history) and this milestone (diff-timeline) can reuse it. No new helper; no duplication.

### Output format

**Human (with `--with-actor-names`):**

```
Timeline for tenants on workflow_traces:
  Tenant A: 11111111-1111-1111-1111-111111111111
  Tenant B: 22222222-2222-2222-2222-222222222222

Events (3):
  2026-01-15T10:00:00.000Z  [A] retention_set    retention=30 opt_out=false enabled=true  by Alice Smith (33333333-3333-3333-3333-333333333333)
  2026-02-01T14:23:11.000Z  [B] retention_set    retention=90 opt_out=false enabled=true  by Bob Jones (44444444-4444-4444-4444-444444444444)
  2026-03-10T08:45:00.000Z  [A] opt_out_set      retention=30 opt_out=true reason=legal-hold  by alice@example.com (33333333-3333-3333-3333-333333333333)
  2026-04-22T16:30:00.000Z  [A] policy_deleted   (policy deleted)  by <system>
```

The `  by <actor>` suffix appended to each event line:
- `display_name (uuid)` when `actorDisplayName` populated
- `email (uuid)` fallback when `display_name` is null but `email` present
- raw `uuid` when both are null (orphan FK)
- `<system>` for null `actor_id`

**Human (without `--with-actor-names`):** unchanged from ADR-0189 — no `by` suffix.

**JSON:** envelope gains `withActorNames: boolean` (echoed for downstream consumers); each entry conditionally carries `actorDisplayName` + `actorEmail` fields only when the flag is set.

```json
{
  "action": "diff-timeline",
  "tenantIdA": "...",
  "tenantIdB": "...",
  "tableName": "workflow_traces",
  "since": null,
  "until": null,
  "limit": 100,
  "withActorNames": true,
  "result": {
    "tenantIdA": "...",
    "tenantIdB": "...",
    "tableName": "workflow_traces",
    "entries": [
      {
        "id": "...",
        "tenantId": "...",
        "tenantSide": "A",
        "tableName": "workflow_traces",
        "eventKind": "opt_out_set",
        "actorId": "33333333-3333-3333-3333-333333333333",
        "occurredAt": "2026-03-10T08:45:00.000Z",
        "prevState": null,
        "nextState": {...},
        "attributes": {},
        "actorDisplayName": "Alice Smith",
        "actorEmail": "alice@example.com"
      }
    ]
  }
}
```

## Use cases unblocked

**1. Canonical "Alice vs Bob's policy timeline"**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces --with-actor-names
# Reads like English — see who did what when across both tenants.
```

**2. Compliance review with actor attribution**

```bash
crossengin retention diff-timeline <regulated-a> <regulated-b> workflow_traces \
  --with-actor-names --since 2026-Q1 --format json | \
  jq '.result.entries[] | {when: .occurredAt, who: (.actorDisplayName // .actorEmail // "system"), what: .eventKind, side: .tenantSide}'
# Quarterly compliance export with human-readable actor column.
```

**3. Incident timeline reconstruction**

```bash
crossengin retention diff-timeline <suspect-a> <suspect-b> workflow_traces \
  --with-actor-names --since <incident-window-start> --until <window-end>
# Forensic timeline with named actors for incident post-mortem.
```

**4. Orphan-actor detection**

```bash
crossengin retention diff-timeline <a> <b> workflow_traces \
  --with-actor-names --format json | \
  jq '.result.entries[] | select(.actorId != null and .actorDisplayName == null and .actorEmail == null) | .actorId' | sort -u
# Surfaces FK orphans (actor_id pointing to deleted meta.users rows).
```

## Drawbacks

1. **`TimelineEntry` minor breaking change** — `actorId` is now required where it was absent in ADR-0189. Contained scope: no production consumers; existing test literals updated to add `actorId: null`. Worth the one-time fix for forward-compat consistency with `OptOutHistoryEntry`.
2. **LEFT JOIN cost on every paginated call** — same caveat as ADR-0185. `meta.users.id` is PK index-only, no row-count expansion (1:1 by actor_id), bounded by `LIMIT`. Negligible at typical scales.
3. **Cross-schema dependency** — adapter SQL references `meta.users` directly when `joinActor=true`. If operators deploy a custom test fixture with `tenant_retention_opt_out_history` but no `meta.users`, the flag fails at query time. Substrate ships both tables together so not a regression.
4. **No multi-tenant filter on `meta.users`** — `meta.users` is platform-wide. A cross-tenant actor (platform admin) appears with the same display_name in both tenants' history. Matches operator intent ("who did this?") but ambiguous for operator-level analysis. Acceptable.
5. **No email-only mode** — operators wanting "show only emails (skip display_name)" wrap with `jq` on JSON output. Substrate ships both fields; CLI rendering picks display_name first. Documented.
6. **The `formatActor` rename** — widening the parameter type from `OptOutHistoryEntry` to a structural shape is type-level only; no behavior change. Tests confirm.

## Alternatives considered

1. **Embed actor names in default output (no flag)** — would add LEFT JOIN cost to every `retention diff-timeline` call. Opt-in keeps the default cheap. Rejected.
2. **New action `retention diff-timeline-with-actors`** — adds CLI surface for one flag. Rejected — flag-on-existing matches the ADR-0185 / 0186 precedent.
3. **Render `display_name` only (no UUID)** — strips audit context for stale logs reviewed years later when display_name may have changed. Rejected — `(uuid)` is forensically required.
4. **Render `display_name <email>` format** — mixes with `<system>` placeholder syntax. Rejected — `display_name (uuid)` is unambiguous.
5. **Separate `--actor-names` flag emitting just names (no JOIN)** — would require operator-side lookup. Rejected — substrate-side JOIN is the right boundary.
6. **Always include `actorId` regardless of `joinActor`** — would surface raw UUIDs in the JSON envelope even without the JOIN. Useful but a separate decision; this milestone always includes `actorId` (the field is now required) but doesn't auto-render it in human output without the flag.
7. **Add `actorId` rendering to the default human output without `--with-actor-names`** — adds vertical noise to the timeline for operators not running an audit. Rejected — flag-gated keeps the default crisp.
8. **Cache user lookups across paginated calls** — operator-side concern; substrate stays stateless. Defer.
9. **Specialized "audit-mode" preset bundling `--with-actor-names` + `--since` + `--limit 1000` defaults** — premature; operators wrap their own scripts. Defer.

## Open questions

1. **`--actor-id <uuid>` filter on diff-timeline** — composes with ADR-0186's actor filter infrastructure. Useful for "show all of Alice's mutations across both tenants on this table." Defer.
2. **`--actor-name-equals <name>` filter** — requires display_name → UUID resolution. Pairs with ADR-0185 Q2 + ADR-0186 Q1. Defer.
3. **Show user status (active / suspended / deleted) alongside name** — useful for compliance "this action was done by a now-suspended user." Defer.
4. **Display user's tenant_membership role** like `Alice (erp_admin)` — requires additional JOIN to `meta.user_tenant_membership`. Different scope; defer.
5. **Surface `actorDisplayName` in JSON envelope by default** when `actorId` is present, regardless of flag — would change envelope shape for backward-compat callers. Defer until measured demand; opt-in is safe default.
6. **N-way timeline with actor names** — pairs with ADR-0189 Q1 (N-way diff-timeline). When N-way ships, `--with-actor-names` composes naturally on the per-event LEFT JOIN. Defer.
7. **Cross-table timeline with actor names** — pairs with ADR-0189 Q2 (cross-table diff-timeline). Same composition. Defer.
