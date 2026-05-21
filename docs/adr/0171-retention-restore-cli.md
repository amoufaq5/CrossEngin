# ADR-0171: `crossengin retention restore` CLI action + `restoreTenantPolicy` adapter (Phase 2 M6.7.zz.tenant.opt-out.cli.restore)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0169 (M6.7.zz.tenant.retention-delete), ADR-0170 (M6.7.zz.tenant.opt-out.history) |

## Context

ADR-0170 / M6.7.zz.tenant.opt-out.history shipped the audit-log table capturing every per-tenant policy mutation with `prev_state` + `next_state` JSONB columns. ADR-0169 Q7 + ADR-0170 Q4 lined up the natural follow-up:

> Q4: `retention restore <history-id>` action. Use a history event's `prev_state` to roll back to a prior policy. Defer.

Operators making mistakes (wrong tenant, wrong table, wrong retention days) currently fix them by re-running the correct mutation — but they have to remember or look up what the prior state was. With the history table in place, the data is already there; we just need a thin wrapper that reads `prev_state` and applies it.

The high-impact use case: an operator runs `retention delete <tenant> workflow_traces` against the wrong tenant. Today they recover by re-creating the deleted policy from memory or a screenshot. With `retention restore <history-id>`, they restore from the history row in one command.

## Decision

Add `restoreTenantPolicy(input)` adapter method that **delegates** to the existing mutation methods based on the source's `prev_state`. Add `retention restore <history-id>` CLI action.

### Adapter

```ts
export interface RestoreTenantPolicyInput {
  readonly historyId: string;
  readonly actorId?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export type RestoreTenantPolicyResult =
  | { kind: "restored"; policy: TenantRetentionPolicyRow }
  | { kind: "deleted"; tenantId: string; tableName: string };

async restoreTenantPolicy(
  input: RestoreTenantPolicyInput,
): Promise<RestoreTenantPolicyResult>;
```

### Algorithm

1. SELECT the source history row by `id`. Throw if not found.
2. Build `attributes = { ...input.attributes, restored_from: input.historyId }` for downstream audit.
3. Dispatch on `source.prev_state`:
   - **`prev_state === null`** → call `deleteTenantPolicy(...)`. Return `{ kind: "deleted", tenantId, tableName }`.
   - **`prev_state.opt_out === true`** → call `setTenantOptOut(...)` with `retentionDays`, `optOutUntil`, `optOutReason` from prev_state. Return `{ kind: "restored", policy }`.
   - **Otherwise** (active per-tenant override OR disabled stand-by) → call `setTenantRetention(...)` with `retentionDays` and `enabled` from prev_state. Return `{ kind: "restored", policy }`.

The discriminated-union return surfaces "restored to absence" vs "restored to state" — operators see both cases distinctly. The CLI renders each with appropriate output.

### Why delegate to existing mutation methods (vs custom restore SQL)

Three alternatives considered:

1. **Custom CTE that captures source history + applies prev_state in one statement.** Rejected — the source history row's structure varies based on event_kind, and the polymorphic apply step (DELETE vs INSERT-or-UPDATE with optional opt_out fields) would push the CTE complexity beyond what's readable.
2. **One generic `applyPolicyState(state)` method that handles all variants.** Rejected — would essentially duplicate the existing four mutation methods. Delegation reuses them and inherits their tests + behavior (including atomic history writes for the restore event itself).
3. **Restore-via-delegation (chosen).** The restore is a meta-operation that ultimately calls one of three existing methods. The history row written by the underlying method emits the natural event_kind (`policy_deleted` / `opt_out_set` / `retention_set`) and includes `restored_from: <history-id>` in attributes for audit traceability.

### Why no new `policy_restored` event_kind

Considered adding a 5th event kind to OPT_OUT_HISTORY_EVENT_KINDS. Rejected:

1. **Audit clarity is preserved via `attributes.restored_from`** — the audit log shows the actual mutation that occurred plus the historical source. Operators see "opt_out_set with restored_from=xxx" rather than an ambiguous "policy_restored."
2. **Restore is a meta-operation, not a new policy state.** The schema's event kinds describe what happened on the row; restore tells *how* the operator decided what to do, but the row mutation is one of the existing four kinds.
3. **Additive schema change deferred.** No new CHECK constraint widening needed.
4. **Operator query "show me every restore" works via `WHERE attributes->>'restored_from' IS NOT NULL`** — no separate kind needed.

### Why `attributes.restored_from` not a dedicated column

The attributes JSONB column was designed precisely for this — extensible audit metadata that doesn't deserve schema-level columns. `restored_from` joins `source: "cli"`, `correlationId: "req_abc"`, and other operator-defined keys.

### CLI

```
crossengin retention restore <history-id> [--actor <uuid>] [--format human|json]
```

Required positional `<history-id>` (exit 2 if missing). Optional `--actor` threads through to the underlying mutation's actorId.

Human output for `kind: "restored"`:

```
Tenant restored: <tenant-uuid> / workflow_traces
  Retention:  90 day(s)
  Enabled:    no
  Opt-out:    yes
  Until:      2027-01-01T00:00:00.000Z
  Reason:     legal_hold:case#42
```

(Reuses the shared `formatPolicyChange("restored", policy)` helper.)

Human output for `kind: "deleted"`:

```
restored from <history-id>: policy deleted (prev_state was null) — tenant <uuid> / workflow_traces
```

JSON envelope: `{ action: "restore", historyId, result: RestoreTenantPolicyResult }` — the discriminated union carries through so downstream `jq` consumers can branch on `.result.kind`.

### Defensive validation on `prev_state`

The schema stores `prev_state` as `JSONB` with no fixed shape. The restore reads `retention_days` (number), `opt_out` (boolean), `enabled` (boolean), `opt_out_reason` (string|null), `opt_out_until` (string|null) — all expected from the live policy row's structure. If `prev_state` is malformed (e.g., manually inserted by an operator), the runtime check on `typeof retention_days !== "number"` throws with a clear error.

## Use cases unblocked

**1. Recover from accidental delete**

```bash
# Find the history row for the deletion
crossengin retention history --tenant <uuid> --kind policy_deleted --limit 1 --format json
# Pluck the id and restore
crossengin retention restore <history-id> --actor "$(whoami | uuidv5)"
```

The deleted policy is recreated with the pre-deletion state. The new history row carries `attributes.restored_from = <history-id>` for forensic clarity.

**2. Undo a wrong opt-out**

Operator accidentally runs `retention opt-out <tenant-A> workflow_traces` for tenant-A when they meant tenant-B. Find the most recent `opt_out_set` history row for tenant-A; restore. The prev_state captures the pre-opt-out policy; restoration reverts.

**3. Roll back a tier migration mistake**

Operator runs `retention set <tenant> workflow_traces --days 7` thinking it's the right tier. Later realizes 90 was correct. `retention restore <history-id>` reverts to the pre-mutation `retention_days`.

**4. Compliance audit "restore proof"**

```bash
crossengin retention history --format json | \
  jq '.entries[] | select(.attributes.restored_from != null) | {id, restored_from: .attributes.restored_from, occurred_at}'
```

Compliance team sees every restore action with the source-of-truth history reference.

**5. CI test recovery**

Test sets up a per-tenant retention, asserts behavior, then needs to teardown. A `restore` to a fresh history row's prev_state cleanly resets.

## Drawbacks

1. **prev_state shape drift risk.** If the live policy schema gains a new column, historical prev_state JSONB blobs won't have it. The restore applies only the fields it knows about (retention_days, enabled, opt_out, opt_out_reason, opt_out_until). New columns get default values from the mutation methods. Document as expected behavior.
2. **Two queries.** SELECT the history row, then one mutation. A single-statement CTE would halve round-trips but at the cost of polymorphic complexity (rejected above).
3. **No chained restore.** Restoring history-id A produces a new history row B. Restoring B restores to A's `prev_state` — which is correct, just confusing to operators. Documented behavior.
4. **No restore for `tenant_retention_opt_out_history` history rows themselves.** The history table is append-only; "restore" applies to per-tenant policy rows only. Operators wanting to undo a history-row insertion can't — that's an intentional append-only property.
5. **No `--dry-run` flag.** Operators wanting "show me what would happen" run `retention history --limit 1 --format json` to inspect the source row's prev_state, then mentally simulate. Future Q if requested.
6. **Idempotent in the multi-restore sense, but not no-op-safe.** Restoring the same history-id twice produces two history rows. First restore: mutation. Second restore: another mutation (same final state). Operators wanting "restore only if state differs" implement that at their layer.

## Alternatives considered

1. **Single CTE for source-lookup + restore.** Rejected — polymorphic apply on event_kind would make the CTE unreadable.
2. **One generic `applyPolicyState(state)` adapter method.** Rejected — duplicates the existing four mutation methods.
3. **New `policy_restored` event_kind.** Rejected — audit clarity preserved via `attributes.restored_from`; restore is a meta-operation, not a new policy state.
4. **Dedicated `restored_from` column on the history table.** Rejected — attributes JSONB is the canonical place for extensible audit metadata.
5. **Refuse restore for `policy_deleted` events (since the row's gone).** Rejected — DELETE history rows have valid `prev_state` from `RETURNING d.*`; restoring re-creates the policy. This is exactly the headline use case (accidental delete recovery).
6. **`--dry-run` flag.** Rejected this milestone — defer.
7. **Restore by tenant + table (most recent event).** Rejected — ambiguous; operators may want to restore to a specific historical state, not just the last one. By-history-id is unambiguous.
8. **Atomic restore-and-emit-policy_restored event in one CTE.** Rejected — see #1 + #3.
9. **`restore --to-time DATE` (restore to state as of timestamp).** Rejected — would need to walk multiple history rows to compute the state at time T. Defer to a future advanced restore action if requested.
10. **Cascade restore across multiple history rows.** Rejected — semantics unclear; defer.

## Open questions

1. **`--dry-run` flag.** Show prev_state from the source history row + which mutation method would be called. Defer.
2. **`restore --to-time DATE`.** Walk history to compute state at time T. Defer.
3. **Batch restore.** `crossengin retention restore-bulk <history-ids.csv>`. Defer.
4. **Confirmation prompt for destructive restores.** When restore would DELETE a currently-existing policy (because prev_state was null), the operator might want confirmation. Match the existing apply `--confirm` pattern. Defer.
5. **`restore-from-snapshot` for cross-tenant bulk operations.** Defer.
6. **Restore preserving rather than overwriting `lastPrunedAt`.** Currently the underlying mutation methods reset (or preserve via existing CTE) — restore inherits their behavior. Document semantic.
7. **GUI / dashboard integration.** Future admin UI shows the history timeline with one-click restore. Out of CLI scope.
