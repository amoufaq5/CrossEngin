# ADR-0204: `crossengin retention diff-history --with-actor-names` actor display name surfacing on diff-history (Phase 2 M6.7.zz.tenant.opt-out.cli.diff-history.with-actor-names)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-22 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0203 (--actor-id expectation check), ADR-0198 (--kind expectation check), ADR-0190 (--with-actor-names on diff-timeline), ADR-0185 (--with-actor-names on retention history), ADR-0173 (diff-history base) |

## Context

ADR-0173 shipped `retention diff-history` rendering the metadata header:

```
A: <uuid-a> at <iso> (event_kind=opt_out_set)
B: <uuid-b> at <iso> (event_kind=retention_set)
Tenant: <uuid>
Table:  workflow_traces
```

ADR-0203 just added `actor_id` to the adapter SELECT (for the `--actor-id` expectation check) but didn't surface actor identity in the metadata header — operators inspecting the diff to answer "who made each change" had to run `retention history --with-actor-names` on each of the two history-ids separately, defeating the one-command diff workflow.

ADR-0185 shipped `--with-actor-names` on `retention history` — LEFT JOIN `meta.users` + render `display_name (uuid)` with email fallback + `<system>` for null actor_id — and ADR-0190 applied it on `retention diff-timeline`. ADR-0203 Q3 + ADR-0198 Q5 both listed this milestone as future work.

M6.7.zz.tenant.opt-out.cli.diff-history.with-actor-names closes ADR-0203 Q3 + ADR-0198 Q5 by composing ADR-0185's LEFT JOIN infrastructure with `retention diff-history`.

## Decision

### CLI surface

```
crossengin retention diff-history <history-id-a> <history-id-b>
                                  [--kind <event-kind>]
                                  [--actor-id <uuid>]
                                  [--with-actor-names]    # NEW
                                  [--format human|json]
```

- Boolean flag, default off — backward-compatible.
- When set, adapter does `LEFT JOIN meta.users u ON u.id = h.actor_id` and returns `actorDisplayNameA/B` + `actorEmailA/B` on the result.
- When omitted, adapter omits the JOIN entirely — no extra query cost on the default path.
- Composes with `--kind` (ADR-0198) + `--actor-id` (ADR-0203) — all three flags are independent.

### Adapter changes

`DiffHistoryEntriesInput` gains `joinActor?: boolean`:

```ts
export interface DiffHistoryEntriesInput {
  readonly idA: string;
  readonly idB: string;
  readonly eventKind?: OptOutHistoryEventKind;
  readonly actorId?: string;
  readonly joinActor?: boolean;  // NEW
}
```

`DiffHistoryEntriesResult` gains required `actorIdA` + `actorIdB` fields (always populated from the existing `actor_id` SELECT from ADR-0203) and optional `actorDisplayNameA/B` + `actorEmailA/B` fields populated only when `joinActor=true`:

```ts
export interface DiffHistoryEntriesResult {
  // ...existing fields
  readonly actorIdA: string | null;
  readonly actorIdB: string | null;
  readonly actorDisplayNameA?: string | null;
  readonly actorDisplayNameB?: string | null;
  readonly actorEmailA?: string | null;
  readonly actorEmailB?: string | null;
}
```

`actorIdA` + `actorIdB` are required, not optional — they're always populated from the existing SELECT column since ADR-0203 added `actor_id` to the SELECT. Making them required is a minor breaking change in the result type but reflects that the data has been available since ADR-0203 just not exposed in the result. The display fields stay optional and conditional on `joinActor=true`.

### SQL shape

When `joinActor=false` (default):

```sql
SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
       h.occurred_at, h.next_state
FROM meta.tenant_retention_opt_out_history h
WHERE h.id IN ($1, $2)
```

When `joinActor=true`:

```sql
SELECT h.id, h.tenant_id, h.table_name, h.event_kind, h.actor_id,
       h.occurred_at, h.next_state,
       u.display_name AS actor_display_name,
       u.email AS actor_email
FROM meta.tenant_retention_opt_out_history h
LEFT JOIN meta.users u ON u.id = h.actor_id
WHERE h.id IN ($1, $2)
```

History table is aliased as `h` consistently (with or without JOIN) — keeps query shape uniform + matches ADR-0185 + ADR-0190 conventions + avoids ambiguity if `meta.users` adds new columns.

**LEFT JOIN not INNER JOIN** — preserves the row even if the actor is orphaned (user deleted from meta.users; actor_id no longer matches any row) so the diff still renders. Operators reading `actorDisplayName == null && actorId != null` know it's an orphan. NULL `actor_id` (system actors from scheduled jobs) returns `actorDisplayName === null` cleanly.

### CLI rendering

When `--with-actor-names` is set, the metadata header gains a `by <actor>` suffix on each event line:

```
Diff between history events:
  A: <uuid-a> at <iso> (event_kind=opt_out_set) by Alice Smith (<actor-uuid-a>)
  B: <uuid-b> at <iso> (event_kind=retention_set) by Bob Jones (<actor-uuid-b>)
  Tenant: <tenant-uuid>
  Table:  workflow_traces

Field changes (3):
  enabled              true  →  false
  ...
```

Rendering rules (same as ADR-0185 / ADR-0190):

| actor_id | actorDisplayName | actorEmail | Rendered |
|---|---|---|---|
| `null` | _any_ | _any_ | `<system>` |
| `<uuid>` | `"Alice Smith"` | _any_ | `Alice Smith (<uuid>)` |
| `<uuid>` | `null` | `"alice@example.com"` | `alice@example.com (<uuid>)` |
| `<uuid>` | `null` | `null` | `<uuid>` |

Without `--with-actor-names`, the metadata header omits the `by ...` suffix entirely — backward-compatible.

### Reuse: formatActor helper

The existing `formatActor` helper in `retention.ts` (generalized in ADR-0190) is reused — `formatHistoryDiff` calls it twice (once per event) with the structural shape `{actorId, actorDisplayName?, actorEmail?}`. No new helper added.

### JSON envelope

When `--with-actor-names` is set, the envelope gains `withActorNames: true` discriminator + the result carries `actorDisplayNameA/B` + `actorEmailA/B`:

```json
{
  "action": "diff-history",
  "kind": null,
  "actorId": null,
  "withActorNames": true,
  "result": {
    "idA": "...", "idB": "...",
    "actorIdA": "...", "actorIdB": "...",
    "actorDisplayNameA": "Alice Smith",
    "actorDisplayNameB": "Bob Jones",
    "actorEmailA": "alice@example.com",
    "actorEmailB": "bob@example.com",
    ...
  }
}
```

When omitted, `withActorNames: false` and the result carries `actorIdA/B` but no display fields.

## Use cases unblocked

**1. One-command "who made each change" diff audit**

```bash
crossengin retention diff-history <id-a> <id-b> --with-actor-names
# Diff between history events:
#   A: <uuid> at <iso> (event_kind=opt_out_set) by Alice Smith (<alice-uuid>)
#   B: <uuid> at <iso> (event_kind=retention_set) by Bob Jones (<bob-uuid>)
```

**2. Compliance review with named actor attribution**

```bash
# Quarterly compliance report including actor names:
crossengin retention diff-history <baseline> <current> --with-actor-names \
  --format json | jq '{a: .result.actorDisplayNameA, b: .result.actorDisplayNameB,
                       diffs: .result.fieldDiffs}'
```

**3. Compose with --actor-id expectation check + display**

```bash
# Assert both events authored by Alice + render her name in metadata:
crossengin retention diff-history <id-a> <id-b> \
  --actor-id <alice-uuid> --with-actor-names
# Exit 0 + diff with "by Alice Smith (uuid)" headers on both events.
```

**4. Forensic post-mortem with named actors**

```bash
# Incident timeline: compare suspect-actor's two events with full attribution:
crossengin retention diff-history <event-before> <event-after> \
  --with-actor-names --format json | jq '.result | {when: .occurredAtA,
  who: .actorDisplayNameA, changes: .fieldDiffs}'
```

## Drawbacks

1. **DiffHistoryEntriesResult breaking change** — `actorIdA` + `actorIdB` are now required fields where they were absent in ADR-0173. The data has always been available (actor_id column has existed since ADR-0170; SELECT was widened in ADR-0203). Making them required reflects reality and gives operators always-on access for the no-JOIN path. Contained-scope change since the result type isn't a public substrate consumer surface (one CLI consumer).
2. **Conditional display fields on result** — `actorDisplayName*` + `actorEmail*` only populated when `joinActor=true`; consumers branching on shape detect via `result.actorDisplayNameA !== undefined`. Matches ADR-0185 OptOutHistoryEntry + ADR-0190 TimelineEntry convention.
3. **LEFT JOIN cost** — adds one JOIN per query when set; meta.users.id is PK index-only + LEFT JOIN doesn't expand rows; negligible cost at typical scale. Opt-in flag keeps default cheap.
4. **Cross-schema dependency** — adapter SQL references meta.users when joinActor=true; if operators deploy tenant_retention_opt_out_history without meta.users (unusual but possible in custom test fixtures), `--with-actor-names` fails at query time. Documented; substrate ships both tables together so not a regression.
5. **No human-format change to field diffs** — only the metadata header gains actor suffix; the field-diff rendering is unchanged. Operators wanting per-field actor attribution (e.g., "Alice changed retention from 30 to 365") would need a different surface (defer).
6. **No multi-tenant scoping on meta.users** — same caveat as ADR-0185/0190: cross-tenant actors render with their canonical display_name regardless of which tenant's history is being audited; matches operator intent "who did this?".

## Alternatives considered

1. **Always-on JOIN no flag** — would add query cost to every diff-history call; opt-in keeps default cheap. Matches ADR-0185/0190 pattern. Rejected.
2. **New action retention diff-history-with-actors** — adds CLI surface; flag-on-existing matches ADR-0185 / ADR-0190 / ADR-0203 / ADR-0198 precedent. Rejected.
3. **INNER JOIN instead of LEFT JOIN** — silently drops events with orphan actors or null actor_id; operators lose audit context. Rejected.
4. **Render display_name only without UUID** — strips audit context for stale logs reviewed years later. Matches ADR-0185 + ADR-0190 stance: name (uuid) is the canonical format. Rejected.
5. **Separate `--actor-names-format` flag for choosing name vs email vs uuid** — overkill; formatActor falls back naturally. Rejected.
6. **Add `actorIdA/B` only when `--with-actor-names` is set** — would split the path between "data was always available" (actor_id from SELECT since ADR-0203) and "data is conditional"; making it required is cleaner since the value already exists in the row. Rejected.
7. **Make display fields required null even when joinActor=false** — would change JSON envelope shape for backward-compat callers expecting field absence; conditional shape preserves backward compat. Rejected.
8. **Cache user lookups across paginated calls** — substrate stays stateless; operators wrap caching at their layer; bounded JOIN cost makes it unnecessary here (only 2 rows per call). Rejected.

## Open questions

1. **--actor-name-equals filter on diff-history** — requires actor → UUID resolution; operators look up UUIDs first. Pairs with ADR-0186 Q3 + ADR-0203 Q4. Defer.
2. **Show user status (active/suspended/deleted)** alongside name — useful for compliance "action by a now-suspended user"; pairs with ADR-0185 Q3. Defer.
3. **Display tenant_membership role** like 'Alice (erp_admin)' — would need additional JOIN to meta.user_tenant_membership; different scope. Defer.
4. **Per-field actor attribution** — diff renders "field=X (changed by Alice) → field=Y (changed by Bob)" instead of just the global event-level attribution. Requires per-field provenance tracking in the substrate (not currently captured). Defer.
5. **`--actor-id-not <uuid>` exclusion** to compose with display surfacing for "show me events not authored by service-account X with full names" forensic narrowing. Pairs with ADR-0203 Q1 in spirit. Defer.
6. **Apply --with-actor-names pattern uniformly to retention diff-timeline-cross-table** (ADR-0192) and N-way (ADR-0191) — those surfaces also benefit; actually already shipped via ADR-0190's adapter inheritance pattern but worth verifying coverage. Defer (likely already works via existing adapter joinActor field).
