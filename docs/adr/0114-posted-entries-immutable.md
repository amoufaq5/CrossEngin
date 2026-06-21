# ADR-0114: Posted journal entries are immutable

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-20 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0112 (posting invariants), ADR-0107 (finance depth) |

## Context

ADR-0112 made a journal entry impossible to *post* wrong (balanced + open
period). But once posted, nothing stopped it from being *edited* or *deleted*, or
its lines from being changed — which would silently rewrite a closed book. The
accounting rule is absolute: a posted entry is a permanent record; you correct it
by posting a reversal, never by editing.

## Decision

Extend the write-guard seam (ADR-0112) to delete, and add a second default guard
that makes posted entries immutable.

**Seam: guard the delete path too.** `WriteGuardInput.operation` gains `"delete"`;
the handler's delete branch now fetches the record and runs the guards (with
`after = before`) before removing it. Guards therefore cover create, update,
transition, **and** delete.

**`postedEntryImmutabilityGuard`.** Once a journal entry's `state === posted`:
- **delete** → `422 posted_entry_immutable`;
- **update/transition** → allowed *only* if it's a reversal — `state` moves to
  `reversed` and no other field changes (audit fields `created_at`/`updated_at` and
  `posted_at` are ignored) — otherwise `422 posted_entry_immutable`;
- **its lines** (create/update/delete on `JournalLine` whose parent entry is
  posted) → `422 posted_entry_locked_lines`.

Entity/field names and the `reversed` state are configurable, mirroring the
posting guard. Both guards are wired automatically by `compileOperateServer` when
the manifest declares `JournalEntry` + `JournalLine` (opt out with
`writeGuards: []`).

## Consequences

- The GL is now correct on both edges: an entry can't be posted wrong, and once
  posted it can't be changed except by reversal — verified through the real
  gateway (edit posted → 422, delete posted → 422, edit/add line → 422
  `posted_entry_locked_lines`, reverse → 200 `state=reversed`).
- The delete-path guard coverage is general: any future "can't delete X while Y"
  invariant now has a home.
- The reversal escape hatch keeps corrections possible without mutating history;
  a posted entry is reversed, then a fresh correcting entry is posted.
- 6,5xx tests pass (+6 immutability cases), zero type errors, `operate-web` build
  green.
- Follow-ups: auto-generate the mirror reversal entry on reverse (negated lines,
  same period if open); block reopening a `locked` fiscal period that has posted
  entries; the same immutability pattern for issued invoices/filed tax returns.
