# ADR-0287: Running the audit-integrity proof, and what it could not see (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-29 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0286 (audit-log anchoring), ADR-0252 / 0255 (chain checkpoints), ADR-0279 (tenant-scope audit) |

## Context

ADR-0286 anchored every `meta.audit_log` row in the forensic chain and left the proof unrun:
*"both halves must be run together to have a proof, and nothing schedules that or exposes it
over HTTP."* A check nobody performs proves nothing — a tamper that nothing looks for is
indistinguishable from no tamper.

Building the scheduler was routine. **Verifying it live was not**: the first live run disproved
a claim this ADR's own design comment had made.

## What the live run found

The design recorded the verdict in the chain on the stated grounds that *"removing it breaks the
links"*. So the verification script deleted the newest verdict entry and asked the chain:

```
chain integrity after deleting the newest entry: {"valid":true,"brokenAt":null}
```

**A truncated chain is a shorter, perfectly well-formed chain.** Hash links detect modification
and removal from the *middle* — both orphan a `priorEntryHash`. They cannot detect removal from
the *end*, because nothing points at the tail. `verifyChainSuffix` returns `{valid: true}` on an
empty suffix (`checkpoint.ts:29`), so `verifyChainFromCheckpoint` is blind to it too.

The consequence is precise and bad: the newest entries — including the verdict that just recorded
a finding — could be deleted and **every link and signature check would still pass**. The one
record an attacker most wants gone was the one least protected.

## Decision

- **The scheduler runs both halves per scope and appends the verdict to the chain** as a
  `security_event`. One chain, as ADR-0286 established: a verdict in a log line is lost, and one
  in an ordinary table can be deleted by the same superuser who edited the audit log.
- **A third check: truncation.** A checkpoint is the external witness that makes tail removal
  visible. Once one exists at sequence N, the chain must still hold an entry at N or beyond; a
  shorter chain has lost history it was already committed to. This is checked explicitly, because
  neither existing verification path notices.
- **Truncation is unknowable before the first checkpoint, and that is reported, not guessed.**
  With no checkpoint there is no witness. Calling that `compromised` would make every fresh
  deployment a finding; calling it `verified` silently would overclaim. The report says
  `truncation: not checkable (no checkpoint yet — run the checkpoint scheduler)`. **Running the
  checkpoint scheduler alongside this one is therefore not optional**, which was previously
  presented as a mere cost optimisation.
- **Three verdicts, and only one wakes anyone.**
  - `verified` — every row matches its anchor, the chain is linked and signed, nothing truncated.
  - `unproven` — nothing disproven, but some rows carry no anchor. The permanent state of any
    deployment predating ADR-0286. Reported, never escalated: treating it as a finding would make
    the scheduler undeployable on exactly the systems that need it.
  - `compromised` — something is disproven. Only this fires `onFinding`.
  Truncation is checked *first*, since every other signal in the report looks clean when a chain
  has been cut short.
- **An idle scope is skipped, not recorded.** No chain entries and no audit rows means nothing to
  prove, so a quiet tenant does not accrue hourly verdicts about nothing. Emptiness is judged by
  the chain's **tail**, not by how many signatures the chain half checked — reading the live output
  showed that count is legitimately `0` for a chain full of entries once a checkpoint catches up to
  the tail, and keying on it would have silently stopped proving the platform chain.
- **The verdict is appended after verifying**, so it sits outside what it attests to and the next
  pass covers it. An unbroken run of verdict entries is itself the evidence that checking happened.
- **The scheduler orchestrates; it does not do SQL.** It takes injected `prove` and `record`
  functions, so interval behaviour, per-scope isolation, skip-empty and the callback contract are
  unit-testable, while the store composition is proven live. `integrityVerdictFor` is exported
  because the judgement is the part worth pinning.

## Consequences

- **Verified live** against a real Postgres, in the order the reasoning went:
  - an idle tenant was **skipped**, recording nothing;
  - two anchored rows gave **`verified`**, verdict appended at chain sequence 2;
  - an unanchored row gave **`unproven`** and `onFinding` fired **0 times**;
  - a tampered row gave **`compromised`**, `onFinding` fired once, verdict recorded;
  - deleting the newest verdict left `{"valid":true,"brokenAt":null}` — **the defect above**;
  - with a checkpoint at 3 and the chain cut to 2, the chain half still reported
    `integrity valid, signatures valid (0 checked)` while the new check reported
    `TRUNCATED: checkpoint at 3 but the chain ends at 2`. The chain half alone could not see it.
- **Verified in the real server**, booted with `--audit-chain-config --checkpoint-config
  --integrity-proof-config`: the checkpoint and proof schedulers both ran on start, a clean tenant
  logged `verdict=verified`, the platform chain `verdict=verified`, and the tenant carrying the
  tampered row logged `COMPROMISED` with the full report.
- No new table; no meta-schema change at all. The verdict is a chain entry and the proof reads
  what is already there.
- +51 tests (operate-server **65 files / 1654**; workspace **9,381**). Full workspace build +
  typecheck + test green.
- Follow-ups: **still nothing over HTTP** — an operator reads verdicts from the chain in SQL, and
  the chain stores only a commitment, so the verdict's *content* is not retrievable from it. A
  route (or a report table anchored the way ADR-0286 anchors audit rows) is the next increment.
  A finding logs and nothing more: the `incident-response` package models exactly this escalation
  and `observability-runtime` has the planners, but wiring `compromised` → declared incident is
  deliberately separate. And the truncation witness is only as good as the checkpoint cadence —
  entries written and deleted between two checkpoints leave no trace at all.
