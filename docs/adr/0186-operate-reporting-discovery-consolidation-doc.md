# ADR-0186: operate reporting & discovery consolidation doc (Phase 3 P3.31)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-10 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0177–0185 (the P3.22–P3.30 report + discovery increments), ADR-0080 (Phase 3 P3 plan) |

## Context

The report-execution and API-discovery surface grew over ten increments
(P3.22–P3.30) across two serving apps, three executors, two discovery descriptors,
and the SSR pages. The per-increment detail lives in CLAUDE.md + ADR-0177–0185,
but there was no single onboarding-level map of how the pieces fit.

## Decision

Added `docs/operate-reporting-and-discovery.md` — a concise architecture/ops doc
covering: the report-execution contract + the three executors (in-memory + the
two SQL-pushdown executors, with fail-closed redaction + sort/limit pushdown);
operate-server's `GET /v1/reports/:report` + per-caller `GET /v1/openapi.json`;
operate-web's report-backed JSON + SSR views + the `GET /ui/_describe` descriptor;
a discovery-at-a-glance table; and the offline/gated testing split. It references
the real symbols/files and points back to CLAUDE.md + ADR-0177–0185 for detail.

## Consequences

- Docs-only; no source, no tests, no META_ tables. A new reader can grasp the
  report + discovery surface from one page instead of reconstructing it from ten
  ADRs. The doc is a living summary — increments that extend the surface (e.g.
  OpenAPI component schemas, a generated client) should update it.
