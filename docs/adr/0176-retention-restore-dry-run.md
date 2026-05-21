# ADR-0176: `retention restore --dry-run` + `previewRestoreTenantPolicy` adapter (Phase 2 M6.7.zz.tenant.opt-out.cli.restore.dry-run)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-21 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0171 (retention restore CLI + restoreTenantPolicy), ADR-0174 (retention prune --dry-run) |

## Context

ADR-0171 / M6.7.zz.tenant.opt-out.cli.restore shipped the `retention restore <history-id>` action, applying a history row's `prev_state` to recover a per-tenant policy. ADR-0174 / M6.7.zz.tenant.opt-out.cli.prune added `--dry-run` to `retention prune` for safe preview.

ADR-0171 Q1 lined up the corresponding restore dry-run:

> Q1: `--dry-run` flag. Show prev_state from the source history row + which mutation method would be called. Defer.

Restore is destructive (overwrites the current policy state with the historical state). Operators want to **see what would change before applying** — same safety motif as prune. Currently they run `retention history --limit 1 --format json` to inspect `prev_state` manually and mentally derive which mutation method would fire. Error-prone for compliance-driven recoveries.

M6.7.zz.tenant.opt-out.cli.restore.dry-run closes Q1.

## Decision

### Adapter

Add a separate `previewRestoreTenantPolicy(input)` method on `PostgresTraceRetention`, mirroring the dual-method pattern from prune (`prune` + `previewPrune`):

```ts
export interface PreviewRestoreTenantPolicyInput {
  readonly historyId: string;
}

export type RestoreTenantPolicyPreview =
  | { kind: "would_delete"; tenantId; tableName; sourceHistoryId }
  | { kind: "would_set_opt_out"; tenantId; tableName; retentionDays;
      optOutUntil; optOutReason; sourceHistoryId }
  | { kind: "would_set_retention"; tenantId; tableName; retentionDays;
      enabled; sourceHistoryId };

async previewRestoreTenantPolicy(
  input: PreviewRestoreTenantPolicyInput,
): Promise<RestoreTenantPolicyPreview>;
```

Discriminated union with three variants mirroring the actual dispatch branches in `restoreTenantPolicy`:

- `would_delete` ↔ `deleteTenantPolicy` (when `prev_state IS NULL`)
- `would_set_opt_out` ↔ `setTenantOptOut` (when `prev_state.opt_out === true`)
- `would_set_retention` ↔ `setTenantRetention` (otherwise)

### Algorithm

Same lookup as `restoreTenantPolicy` (SELECT the source history row), but:

1. NO `actorId` parameter accepted — preview is purely read-only, no audit row written.
2. NO `attributes` parameter — same reason.
3. NO call to the underlying mutation method — the preview RETURNS what it would have called.
4. Same defensive validation: `retention_days` must be a number when `prev_state` is non-null.

The result variants intentionally carry the EXACT arguments that would be passed to the underlying mutation method. Operators reading the preview can verify the planned action without ambiguity.

### Why a separate adapter method vs `restoreTenantPolicy({dryRun: true})`

Considered extending `restoreTenantPolicy` with a `dryRun?: boolean` parameter that returns a discriminated union of `RestoreTenantPolicyResult | RestoreTenantPolicyPreview`. Rejected:

1. **Type system pollution.** The method's return type would become `Result | Preview`, forcing every caller to discriminate. The existing callers of `restoreTenantPolicy` are guaranteed to never see a preview; the type narrowing would be noise.
2. **Mirrors the prune pattern.** ADR-0143 ships `prune` + `previewPrune` as separate methods; ADR-0153 explicitly documented why — distinct types + distinct behaviors warrant distinct method names.
3. **Clearer audit logs.** A future operator reading the SQL trace sees `previewRestoreTenantPolicy` vs `restoreTenantPolicy` — the intent is obvious from the method name alone.

### CLI: `--dry-run` flag

```
crossengin retention restore <history-id> [--dry-run] [--actor <uuid>] [--format human|json]
```

Branches at the start of `runRetentionRestore`:
- `--dry-run` → call `previewRestoreTenantPolicy`, render preview.
- Else → existing live-restore flow.

`--actor` is ignored when `--dry-run` is set (preview doesn't write an audit row). Documented in help text; doesn't error if both provided.

### Output rendering

**Human format:**

```
Restore preview (no changes applied):
  Source history: <id>
  Tenant:         <uuid>
  Table:          workflow_traces
  Action:         setTenantOptOut
    retention_days: 90
    opt_out_until:  2027-01-01T00:00:00.000Z
    opt_out_reason: legal_hold:case#42
```

For `would_delete`:

```
  Action:         deleteTenantPolicy (prev_state was null)
```

For `would_set_retention`:

```
  Action:         setTenantRetention
    retention_days: 30
    enabled:        yes
```

Reuses the conventions from existing render helpers — `indefinite` for null `optOutUntil`, `<no reason>` for null `optOutReason`.

**JSON format:**

```json
{
  "action": "restore",
  "dryRun": true,
  "historyId": "<id>",
  "preview": { "kind": "would_set_opt_out", ... }
}
```

Live mode emits `dryRun: false` + `result` instead of `preview`:

```json
{
  "action": "restore",
  "dryRun": false,
  "historyId": "<id>",
  "result": { "kind": "restored", "policy": {...} }
}
```

The `dryRun` boolean is the canonical discriminator (matches the prune envelope convention from ADR-0174).

## Use cases unblocked

**1. Pre-restore safety check**

```bash
# Inspect what restore would do
crossengin retention restore <history-id> --dry-run
# Confident? Apply for real
crossengin retention restore <history-id> --actor "$(whoami | uuidv5)"
```

Two-command safety pattern; operators preview then act.

**2. Compliance workflow validation**

```bash
crossengin retention restore <history-id> --dry-run --format json | \
  jq '.preview.kind'
# "would_set_opt_out"
```

Compliance team validates restore intent matches the audit log expectation.

**3. CI gate**

```bash
KIND=$(crossengin retention restore <history-id> --dry-run --format json | jq -r '.preview.kind')
if [[ "$KIND" != "would_set_opt_out" ]]; then
  echo "❌ Expected restore to set opt-out; got $KIND" >&2
  exit 1
fi
```

Migration scripts assert restore semantics before committing.

**4. Forensic investigation**

```bash
# What WOULD have happened if we restored this historical event?
crossengin retention restore <id-from-last-month> --dry-run
```

Operators reconstruct counterfactuals without mutating live state.

**5. Comparing planned restore with current state**

```bash
# Get the preview of what restore would set
PREVIEW=$(crossengin retention restore <id> --dry-run --format json)
# Get the current policy state
CURRENT=$(crossengin retention effective <tenant> <table> --format json)
# Compare via jq
```

Multi-command analysis without applying changes.

## Drawbacks

1. **No `--diff` shortcut.** Operators wanting "what's the delta between current policy and what restore would produce?" need to chain `retention effective` + `retention restore --dry-run` + `jq`. A future `retention restore --diff-current` could combine. Defer.
2. **No cross-history-event preview.** Operators wanting "preview restoring from event A AND from event B side-by-side" run two separate commands. Defer.
3. **`--actor` silently ignored on `--dry-run`.** Could error instead. Rejected — operators may script with both flags always set; ignoring is friendlier.
4. **Preview is single-snapshot.** It shows the planned action at query time. Between the dry-run and the live restore, another operator could mutate the source history row's `prev_state` (which is JSONB, not append-only by DDL — only by convention). Documented.
5. **Three variants instead of one.** Operators must `switch (preview.kind)` to extract fields. Mirrors `RestoreTenantPolicyResult`'s discrimination — consistent shape across the family.

## Alternatives considered

1. **Single method `restoreTenantPolicy({dryRun: true})` returning a discriminated union.** Rejected — type system pollution, breaks the prune separate-method pattern, audit-log clarity weaker.
2. **`previewRestoreTenantPolicy` returning the same shape as `RestoreTenantPolicyResult`.** Rejected — would conflate "what happened" with "what would happen." The `would_*` variants make the difference explicit at the type level.
3. **CLI flag `--explain` instead of `--dry-run`.** Rejected — `--dry-run` matches the established convention from `apply --dry-run`, `retention prune --dry-run`.
4. **Implicit preview when stdout is a TTY, live when piped.** Rejected — magic behavior; operators script regardless of TTY.
5. **Error when `--actor` is set with `--dry-run`.** Rejected — operators may script with both flags always set; silent ignore is friendlier.
6. **`--diff-current` flag to combine preview with current state.** Rejected this milestone; deferred to a future combined-mode milestone.
7. **Preview method accepting `actorId` for "what would the actor row look like."** Rejected — preview is read-only; actor info is meaningless without a write.
8. **JSON `preview` field renamed to `result` for parity.** Rejected — semantically distinct; `preview` vs `result` is the right vocabulary for the read-only-vs-write split.

## Open questions

1. **`--diff-current` flag combining preview with `effectiveRetention`.** Defer.
2. **Bulk dry-run for multiple history-ids.** `crossengin retention restore --dry-run --bulk file.csv`. Defer.
3. **Multi-version preview** showing what restoring to history-id A vs history-id B would each produce. Defer.
4. **`--from-time DATE` to preview restoring to the policy state at a given moment** (would require walking multiple history rows). Defer along with `restore --to-time` from ADR-0171 Q2.
5. **Confirmation prompt on live restore that's been preceded by `--dry-run`.** Currently no link between the two invocations. A session-scoped cache could remember "user just dry-ran this id," but adds complexity. Defer.
6. **Preview integration with `retention diff-history`** to show "what restoring to A would look like compared to current."  Defer.
