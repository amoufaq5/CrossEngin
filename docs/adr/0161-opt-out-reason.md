# ADR-0161: `opt_out_reason` audit context column (Phase 2 M6.7.zz.tenant.opt-out.reason)

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0155 (M6.7.zz.tenant META_TENANT_RETENTION_POLICIES), ADR-0159 (M6.7.zz.tenant.dashboard effectiveRetention), ADR-0160 (M6.7.zz.tenant.opt-out opt_out flag) |

## Context

ADR-0160 / M6.7.zz.tenant.opt-out shipped the `opt_out` flag on META_TENANT_RETENTION_POLICIES. Operators can now mark a tenant as exempt from retention pruning — legal holds, 21 CFR Part 11 clinical trials, VIP contracts. ADR-0160 Q1 lined up the follow-up:

> Q1: Opt-out reason field. A future `opt_out_reason TEXT` column for audit context ("legal_hold:case#42", "vip_contract:tenant-xyz", "21cfr11:trial-9"). Useful for compliance dashboards. Defer until operators demand structured reason tracking.

The pain it solves:

1. **Audit blind spot.** A list of opt-out tenants without reasons is operationally useless. "Why is tenant X opted out?" requires hunting through tickets, Slack, lawyer emails, contract addenda.
2. **Onboarding handoff.** When the operator who set the opt-out leaves the team, the institutional knowledge "tenant Y is under SEC investigation hold" disappears with them. A reason column makes the policy self-documenting.
3. **Compliance dashboards.** SOC 2 / HIPAA / 21 CFR 11 audits regularly ask "show me every customer whose data retention deviates from default and the documented reason." Without a reason column, operators answer with a spreadsheet maintained in parallel.
4. **Per-reason metrics.** "How many legal holds are active?" / "How many tenants opt out for compliance vs business reasons?" requires structured reason classification.

M6.7.zz.tenant.opt-out.reason closes Q1.

## Decision

Add `opt_out_reason TEXT` (NULLABLE, no `NOT NULL`) column to META_TENANT_RETENTION_POLICIES with a length CHECK:

```ts
{
  name: "opt_out_reason",
  type: "TEXT",
  check: "opt_out_reason IS NULL OR (char_length(opt_out_reason) BETWEEN 1 AND 256)",
}
```

Threading:

- `TenantRetentionPolicyRow.optOutReason: string | null` — surfaced on every list call.
- `RetentionRunResult.optOutReason?: string | null` — populated when `status === "skipped_opt_out"`.
- `RetentionPreviewResult.optOutReason?: string | null` — same.
- `EffectiveRetentionResolution.tenant_opt_out` variant gains `optOutReason: string | null`.

### Schema choices

**NULLABLE, not NOT NULL.** Three reasons:
1. Most rows in production won't have a reason (opt_out=false majority). Forcing every row to carry an empty string violates "the data should mean what it says."
2. Operators backfilling pre-M6.7.zz.tenant.opt-out.reason rows can leave reasons null without re-prompting the team.
3. Forward compatibility: a future migration tightening to NOT NULL is easier than relaxing NULL.

**No CHECK tying reason to opt_out state.** Considered:

- `CHECK ((opt_out = false AND opt_out_reason IS NULL) OR opt_out = true)` — forces reason only when opted out.
- `CHECK ((opt_out = true) OR opt_out_reason IS NULL)` — same shape.

Rejected because:

1. **Historical context preservation.** An operator lifting opt-out (opt_out flips false) may want to KEEP the reason on the row as a "this tenant was opted out previously due to X" historical signal. Forcing null on lift-off destroys audit history.
2. **Staged opt-outs.** Operators may pre-populate `opt_out_reason` ahead of flipping `opt_out=true` (e.g., legal team writes the reason during contract review; operations team flips the flag after sign-off). Forcing reason-implies-opt-out blocks the staging workflow.
3. **Simplicity.** The reason column is informational; the substrate doesn't enforce semantic alignment between two columns that operators may want to use independently.

The application layer treats reason as informational. The resolver populates `optOutReason` ONLY on the `tenant_opt_out` variant — when the row's `opt_out = false`, no `tenant_opt_out` variant is emitted and the reason is never surfaced through the resolver (operators reading the raw row via `listTenantPolicies` see it).

**Length [1, 256].** Lower bound 1 prevents empty strings (which would be ambiguous: "no reason set" vs "the reason is the empty string"). Upper bound 256 caps storage and forces operators to write CONCISE classifiers. Long-form context belongs in linked ticket systems, not the retention table.

**No pattern constraint.** Considered slug-pattern `^[a-z][a-z0-9_:.-]{0,255}$` to encourage structured tokens like `legal_hold:case#42`. Rejected:

1. Substrate prescribes structure operators may not want (free-form English: "Subpoena from SEC, see ticket #12345").
2. Operator-defined classification taxonomies vary by company.
3. Adding a pattern later is non-breaking if needed; removing one is breaking.

Operators wanting structured reasons enforce that at their application layer.

## Threading details

### `effectiveRetention` resolver

The `tenant_opt_out` variant gains a required `optOutReason: string | null` field. The resolver populates it from the row's `opt_out_reason` column. When the row has no reason (column is NULL), the variant carries `optOutReason: null`. Consumers narrow on `source === "tenant_opt_out"` and access `.optOutReason` with full type safety.

### Prune + preview results

`RetentionRunResult` and `RetentionPreviewResult` gain optional `optOutReason?: string | null`. Optional because the field is only meaningful when `status === "skipped_opt_out"` — populated in that branch, omitted otherwise.

Type-theoretically a discriminated union over status would be cleaner (`{status: "skipped_opt_out", optOutReason: ...}` vs other variants without the field), but the flat structure of `RetentionRunResult` was set in ADR-0155 / ADR-0160; refactoring to discriminated union would be invasive. Optional field threads in additively without breaking existing consumers.

### SQL changes

`listTenantPolicies` SELECT expands to include `opt_out_reason`.
`effectiveRetention` SELECT expands to include `opt_out_reason`.

No changes to DELETE / UPDATE / COUNT queries — reason is purely informational for the read path.

## Use cases unblocked

**1. Compliance dashboard "opt-out reasons by category"**

```sql
SELECT
  CASE
    WHEN opt_out_reason LIKE 'legal_hold:%' THEN 'Legal Hold'
    WHEN opt_out_reason LIKE '21cfr11:%' THEN '21 CFR Part 11'
    WHEN opt_out_reason LIKE 'vip_contract:%' THEN 'VIP Contract'
    WHEN opt_out_reason IS NULL THEN 'No reason recorded'
    ELSE 'Other'
  END AS category,
  COUNT(*) AS tenant_count
FROM meta.tenant_retention_policies
WHERE opt_out = true
GROUP BY category;
```

**2. Audit report "show every opt-out with documented reason"**

```sql
SELECT tenant_id, table_name, retention_days, opt_out_reason, last_pruned_at
FROM meta.tenant_retention_policies
WHERE opt_out = true
ORDER BY opt_out_reason NULLS LAST;
```

Auditors get a single-query answer. Compliance teams can filter on missing reasons to identify gaps (`WHERE opt_out_reason IS NULL`).

**3. Dashboard tooltip enrichment**

```ts
const r = await retention.effectiveRetention(tenantId, "workflow_traces");
if (r.source === "tenant_opt_out") {
  ui.showBadge("Opt Out", {
    tooltip: r.optOutReason ?? "No reason recorded",
    severity: r.optOutReason?.startsWith("legal_hold:") ? "alert" : "info",
  });
}
```

UI surfaces reason on hover, color-codes by reason category.

**4. Prune-run audit trail with reasons**

```ts
const results = await retention.prune();
for (const r of results) {
  if (r.status === "skipped_opt_out") {
    log.info("retention.prune.skipped_opt_out", {
      tenantId: r.tenantId,
      table: r.tableName,
      reason: r.optOutReason ?? "<no reason>",
    });
  }
}
```

Structured logs include reason at the event source — no separate lookup needed.

## Drawbacks

1. **Optional reason → quality drift.** Without a `NOT NULL` constraint, operators may leave reasons blank during rushed opt-outs. Compliance teams compensate with periodic audit queries flagging NULL reasons. Future tightening to NOT NULL is straightforward when operators have backfilled.
2. **No reason validation.** Free-form text accepts garbage ("test", "asdf"). Operators governing data quality at the application layer.
3. **Reason staleness.** Reasons set at opt-out time may become outdated (a case closes, a contract ends). The schema doesn't enforce reason freshness; operators audit periodically.
4. **PII risk.** Operators could accidentally write PII into the reason field ("hold for John Doe's GDPR request"). 256-char limit reduces blast radius but doesn't eliminate it. Operators trained on PII hygiene; reasons should reference IDs ("subject_request:sr_42") not names.

## Alternatives considered

1. **Reason as a separate audit table `meta.tenant_retention_opt_out_history(tenant_id, table_name, opt_out_event, reason, actor, occurred_at)`.** Append-only event log of opt-out / opt-in changes with reasons. Cleaner audit story but invasive — requires INSERT trigger or application-layer wiring on every opt-out change. Defer to a future "policy change audit log" milestone that covers all META_*_POLICIES tables uniformly.
2. **JSONB reason column for structured metadata.** `opt_out_reason JSONB DEFAULT NULL` allowing `{"type": "legal_hold", "case": "42", "expires": "2027-01-01"}`. Rejected — overkill for the current use case, harder to query for simple "category" lookups, and operators can encode the same in a structured string (`legal_hold:42:2027-01-01`).
3. **NOT NULL with DEFAULT empty string.** All rows always have a (possibly empty) reason. Rejected — empty string ≠ "no reason"; semantic ambiguity. NULL is the correct "absent" signal.
4. **Pattern enforcement (slug-only).** `CHECK (opt_out_reason ~ '^[a-z][a-z0-9_:.-]{0,255}$')`. Rejected — substrate prescribes structure operators may not want; free-form text serves the broader use cases.
5. **Reason on the opt_out flag itself (e.g., a typed enum).** `opt_out_kind TEXT CHECK IN ('legal_hold', '21cfr11', 'vip', 'other')`. Rejected — same prescription problem; operators' taxonomies vary.
6. **Reason as part of the row's `comments` field (if such existed).** No such column exists; adding one would be more invasive than a typed reason column.

## Open questions

1. **Reason expiry / freshness tracking.** A future `opt_out_reason_set_at TIMESTAMPTZ` column for reason staleness audits. Defer until operators demand "show me opt-outs with reasons older than 1 year."
2. **Actor attribution.** A future `opt_out_set_by UUID` referencing `meta.users(id)` for "who flipped this opt-out?" forensics. Pairs with ADR-0160 Q3 (opt_out impact on retention dashboard alerts). Defer to a unified policy-change audit log milestone.
3. **Reason categories.** A future companion table `meta.opt_out_reason_categories(category, description)` for operator-defined taxonomies. Would let dashboards group reasons without LIKE-pattern hacks. Defer until needed.
4. **API / CLI exposure.** `crossengin retention opt-out <tenant> <table> --reason "<reason>"` subcommand. Defer to the M6.7.zz.tenant.cli milestone (ADR-0159 Q5).
5. **Reason translation / i18n.** Compliance reports for multi-region operators may need reasons translated. Substrate keeps reasons as the operator's authored text; translation belongs in the reporting layer.
6. **Constraint tightening to require reason when opt_out=true.** Would force operators to document every opt-out. Could be added later as `CHECK ((opt_out = false) OR (opt_out_reason IS NOT NULL))` after a backfill period. Defer until operators are ready for the constraint.
