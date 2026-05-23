# ADR-0225: Retention history JSON envelope rename to canonical conventions

- **Status**: Proposed
- **Date**: 2026-05-23
- **Tier**: 2 (Phase 1-3)
- **Phase**: 2
- **Milestone**: M6.7.zz.tenant.opt-out.cli.history.envelope-rename
- **Closes**: ADR-0224 future Qs 1-3 (history envelope inconsistencies vs
  canonical conventions)
- **Related**: ADR-0224 (family-wide JSON envelope shape conventions just-
  shipped), ADR-0199/0200/0207/0210/0211/0214/0217/0218/0219/0220/0221/0222/
  0223 (13 prior multi-value milestones that established the canonical
  envelope conventions)

## Context

ADR-0224 codified the canonical JSON envelope shape conventions for
retention CLI actions across all 3 surfaces (history, diff-timeline, diff-
history). The codification identified 3 inconsistencies in the **history**
surface envelope vs the canonical conventions:

1. **`eventKinds` / `eventKindsNot` vs canonical `kinds` / `kindsNot`** —
   history echoed the adapter input field name; canonical convention says
   envelope field names derive from CLI flag names (`--kind` → `kinds`).
2. **Missing `action` discriminator** — diff-history + diff-timeline emit
   `action: "diff-history"` / `action: "diff-timeline"`; history omitted.
3. **Missing `withActorNames` echo** — diff-history + diff-timeline echo
   `withActorNames` boolean in envelope; history parsed the flag but
   didn't echo it.

ADR-0224 deferred all 3 to a follow-up rename milestone (this ADR) to keep
the codification milestone "pure documentation + test additions" without
breaking changes.

## Decision

Apply the 3 history-envelope renames to match canonical conventions from
ADR-0224. Breaking change to operator JSON parsing scripts but session-
recent code with no external consumers contained scope.

### Envelope changes (3 changes in history JSON envelope)

```ts
// Before (ADR-0221/0222 state):
{
  tenantFilter: tenantFilter ?? null,
  tableFilter: tableFilter ?? null,
  eventKinds: eventKinds ?? null,           // (1) deviation
  eventKindsNot: eventKindsNot ?? null,     // (1) deviation
  actorIds: actorIds ?? null,
  // ... (no action field — (2) deviation)
  // ... (no withActorNames field — (3) deviation)
}

// After (this ADR — canonical):
{
  action: "history",                         // (2) added
  tenantFilter: tenantFilter ?? null,
  tableFilter: tableFilter ?? null,
  kinds: eventKinds ?? null,                 // (1) renamed
  kindsNot: eventKindsNot ?? null,           // (1) renamed
  actorIds: actorIds ?? null,
  // ...
  withActorNames,                            // (3) added
  // ...
}
```

### Field positioning

Canonical positioning (matches diff-history/diff-timeline patterns):
- `action` discriminator first
- Filter args (`tenantFilter`, `tableFilter`) — history-specific
- Multi-value tuple filters (`kinds`, `kindsNot`, `actorIds`, `actorIdsNot`)
- Actor presence booleans (`systemOnly`, `noSystem`)
- Boolean flags (`withActorNames`)
- Range filters (`since`, `until`)
- Pagination (`afterId`, `beforeId`, `range`, `limit`)
- Result-level (`count`, `entries`, `nextAfterId`, `nextBeforeId`)

### Test updates

5 existing tests reading `parsedJson.eventKinds` / `parsedJson.eventKindsNot`
updated to `parsedJson.kinds` / `parsedJson.kindsNot`. The 3 "known
inconsistencies" tests from ADR-0224 (which verified the deviations were
intentional current state) are replaced with 4 canonical-convention tests
(kinds verified, action discriminator verified, withActorNames=true when
flag set, withActorNames=false when flag not set).

## Rejected alternatives

1. **Keep history's current shape, document the deviations as "history-
   specific naming" in a separate convention** — defeats the purpose of
   ADR-0224 (single canonical reference); operators reading JSON across
   surfaces would have surprise field-name differences.
2. **Add the new canonical fields ADDITIVELY without removing the
   deprecated ones (history emits BOTH `eventKinds` and `kinds`)** —
   doubles the envelope size; ambiguous operator interpretation; future
   removal would still be a breaking change.
3. **Use a CLI flag (`--canonical-envelope`) to opt into the new shape** —
   adds CLI complexity without enduring benefit; once the canonical
   conventions are documented and tested, operators should use the
   canonical shape unconditionally.
4. **Defer the rename indefinitely** — leaves the 3 documented future Qs
   open; recurring source of friction for operators using JSON output;
   the rename is mechanical now that conventions are codified.
5. **Rename diff-history/diff-timeline to match history's `eventKinds`
   instead** — wrong direction; history is the outlier; CLI-flag-derived
   naming (`kinds`) is the more common pattern across 13 milestones.
6. **Add an `eventKindsAlias` field that always equals `kinds` for backward
   compat** — operator scripts that read both would break with conflict;
   single canonical field is cleaner.

## Future questions

1. **JSON Schema generation from envelope shapes** — automated cross-
   surface schema generation for IDE autocomplete + operator-side
   validation. Defer — would require schema tooling + adapter changes;
   ADR-0224 future Q4.
2. **CLI output format variants** — `--format=csv`, `--format=tsv`,
   `--format=yaml`. Defer — operator-ergonomics milestone; ADR-0224
   future Q5.
3. **Result-level field naming unification documentation** — document the
   2-level separation (envelope echoes operator INPUT; result contains
   actual DATA) more rigorously. Defer — current state is correct, just
   under-documented; ADR-0224 future Q6.
4. **Migration guide for operators** — write a docs/operator-migration-
   guides/retention-history-envelope.md explaining the rename. Defer —
   session-recent code with no external consumers; PR description
   suffices.
5. **`tenantFilter` / `tableFilter` field naming consistency** — these
   use the `Filter` suffix only on history (because they're optional
   filter args); other surfaces use positional tenant/table args. Defer
   — surface-specific concern; the `Filter` suffix accurately reflects
   the optional nature.
6. **Versioned envelope shape (`envelopeVersion: 2`)** — would allow
   gradual migration with operators opting into new shapes. Defer —
   no external consumers; adds complexity without immediate benefit.

## Consequences

- **All 3 history-envelope inconsistencies closed** — history now matches
  diff-history/diff-timeline canonical conventions.
- **Test count: 9,152 → 9,153** (+1 net: -3 inconsistency tests + 4
  canonical convention tests).
- **Breaking change to operator JSON parsing scripts** — scripts reading
  `parsedJson.eventKinds` on history must update to `parsedJson.kinds`;
  `parsedJson.eventKindsNot` → `parsedJson.kindsNot`. Scripts CAN now
  reliably discriminate by `action: "history"` field.
- **No adapter changes** — the rename is entirely CLI-side envelope
  rendering; `ListOptOutHistoryInput` adapter field names (`eventKinds`,
  `eventKindsNot`) preserved.
- **Cross-surface scripts simplified** — operators can write
  `env.kinds` once and use it across all 3 retention surfaces.
- **Canonical conventions fully realized** — ADR-0224 + ADR-0225 together
  establish the canonical JSON envelope shape, codify it, and bring all
  3 surfaces into compliance.
- **Future multi-value milestones inherit the conventions** — new
  surfaces or new actions follow the documented canonical patterns
  without per-milestone re-decision.
- **Follow-up milestones unblocked** — cross-flag contradiction detection,
  --csv output format, --explain flag, and other ergonomic improvements
  can be designed against a stable, canonical envelope shape.
