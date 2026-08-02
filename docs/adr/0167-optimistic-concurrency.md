# ADR-0167: Optimistic concurrency on update (lost-update guard for the editor)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-23 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0077 (Phase 3 P3 renderer), ADR-0079 (handler 4xx → gateway deny), ADR-0088 (entity handlers) |

## Context

The generic detail editor does a read-then-write: load a record, edit fields, PATCH the changed
ones. Two users editing the same record would silently last-write-wins — the second save clobbers
the first with no warning. Records already carry a server-managed `updated_at` (stamped on create
and bumped on every update/transition), so a version token exists; it just wasn't checked.

## Decision

- **A reserved `expectedUpdatedAt` on the update body.** A client MAY send the `updated_at` it last
  read. The update handler strips it from the stored patch (never persisted), and — inside the
  same write transaction — reads the current record: if its `updated_at` differs, the write is
  rejected **409 `conflict`** (with `currentUpdatedAt`) instead of overwriting. Absent token →
  unconditional update, exactly as before (backward compatible). A conditional update on a missing
  record 404s.
- **Console.** The detail editor sends `expectedUpdatedAt: <loaded updated_at>` with its patch. On
  a 409 it does not clobber: it shows "this record was changed by someone else — reloaded the
  latest, re-apply your edits", reloads the current record, and drops out of edit mode so the user
  re-edits against fresh data.

## Consequences

- The generic editor no longer silently loses concurrent updates — the second writer is told to
  reconcile. This is *optimistic* (no locks held between load and save); the check runs within the
  write transaction, and the PG store's `SELECT … FOR UPDATE` on the merge bounds the residual
  race to sub-transaction width.
- Opt-in and backward compatible: any existing client that doesn't send the token keeps
  unconditional updates; only the field-edit path adopts it (lifecycle transitions are already
  state-machine-guarded and unchanged).
- 6,778 tests pass (+3: stale token → 409 + record untouched then matching token → 200 + token not
  stored; no-token → unconditional 200; conditional-on-missing → 404). Full build + typecheck
  green; console typecheck-verified.
- Follow-ups: a monotonic integer `version` (cheaper to compare than a timestamp, immune to
  same-millisecond writes); conflict-aware transitions; a field-level three-way merge in the UI.
