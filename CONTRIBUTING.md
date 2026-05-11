# Contributing to CrossEngin docs

This repository holds architectural decisions, not code. The contribution model is light, but the standards for individual ADRs are high.

## Proposing a new ADR

1. Pick the next unused number `NNNN` from [`adr/index.md`](adr/index.md).
2. Copy [`adr/0000-template.md`](adr/0000-template.md) to `adr/NNNN-<short-slug>.md`.
   - `<short-slug>` is lowercase, hyphenated, derived from the title.
3. Fill in every section. Skipped sections must be marked **N/A** with a reason.
4. Add an entry to `adr/index.md` with status **Proposed**.
5. Open a pull request. PR title: `ADR-NNNN: <title>`.

## ADR status lifecycle

```
Proposed  ->  Accepted  ->  (later) Superseded by ADR-XXXX  or  Deprecated
```

- **Proposed** — written, in review, not yet binding.
- **Accepted** — merged. The decision is now the official position.
- **Superseded by ADR-XXXX** — a later ADR replaced this one. Update both: this ADR's status to `Superseded by ADR-XXXX`, and the new ADR to include `Supersedes: ADR-NNNN`.
- **Deprecated** — no longer applies, no successor.

Never edit an Accepted ADR. Write a new one that supersedes it.

## Style

- **Plain English.** No corporate-speak. No hype. No marketing voice.
- **Specific.** "Use Postgres" is not a decision. "Use Postgres 16, one schema per tenant, row-level security for shared-schema tables, pgvector for embeddings, ClickHouse mirror for analytics" is.
- **Honest about trade-offs.** The Alternatives Considered section is usually the most valuable part of an ADR.
- **Cite alternatives by name.** "We considered MongoDB and DynamoDB" beats "we considered other databases."
- **Dates and authors.** Every ADR carries the decision date and author(s).
- **Reversibility.** Every decision names how hard it is to reverse and what it would take.

## Review

Every ADR needs at least one reviewer before moving from Proposed to Accepted. Reviewers focus on:

1. Is the problem clearly stated?
2. Are the alternatives realistic and fairly described?
3. Are the negative consequences named honestly?
4. Does this conflict with another ADR? If so, which one wins?
5. Are open questions tracked with owners and deadlines?

Reviewers should push back on vague language, missing trade-offs, and hand-waving.

## What is *not* an ADR

- Implementation plans → live in code repos as PR descriptions, RFCs, or design docs.
- Tactical bug fixes or refactors → PR descriptions.
- Personnel or operational decisions → wiki or internal docs.
- Vision / strategy → [`vision.md`](vision.md), not an ADR.

An ADR records a decision that **constrains future architecture** and that **someone in the future will want to understand the reasoning behind**.
