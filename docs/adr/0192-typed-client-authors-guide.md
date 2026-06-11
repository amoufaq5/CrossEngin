# ADR-0192: typed client author's guide (Phase 3 P3.37)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-06-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0186 (operate reporting & discovery consolidation doc), ADR-0187–0191 (OpenAPI + operate-web discovery schemas), ADR-0080 (Phase 3 P3 plan) |

## Context

P3.26–P3.36 built a complete, typed discovery surface across both serving apps:
operate-server's OpenAPI 3.1 document (component schemas, nullability, RFC 9457
errors, per-caller RBAC filtering) and operate-web's `WebApiDescriptor` (per-entity
field schemas, view-model shapes, route envelope schemas). ADR-0186's consolidation
doc *maps* that surface, but there was no **task-oriented** guide for the consumer:
someone writing a typed client had to assemble the how-to from a dozen ADRs.

## Decision

Add `docs/typed-client-authors-guide.md` — a single end-to-end guide for building a
typed client. Docs-only (no code change). It covers:

- **Choosing a surface** — data/integration client → operate-server OpenAPI;
  dynamic UI over the platform's view models → operate-web `/ui/_describe`.
- **Auth** — API key vs JWT, on the discovery request and every call.
- **Path A (OpenAPI):** fetch `/v1/openapi.json`, feed to `openapi-typescript` /
  `openapi-generator`; what's in the component schemas (entity schemas, nullable
  optionals, `ReportData`, `ProblemDetails`); the success/error table per operation;
  keyset pagination + typed filters + projection.
- **Path B (`WebApiDescriptor`):** the three schema layers (`entities[].schema`
  redacted field shape, `models` view-model shapes, `routes[].responseSchema`
  envelopes); resolving the self-contained `#/models/<Name>` `$ref`; the envelope
  table by route kind; a worked example typing `GET /ui/Product`.
- **Per-caller gotchas** — documents are scoped to the credential; redaction is
  structural (absent ≠ null); errors are RFC 9457; the server is the boundary.
- **Quick reference** — a side-by-side of both surfaces.

## Consequences

- A consumer has one place to learn how to generate types and call the API, with
  copy-pasteable codegen commands and a `$ref` resolver. The consolidation doc
  (ADR-0186) cross-links to it and both now reference the through-P3.36 range.
- Docs-only: **64 packages + 4 apps, 125 meta-schema tables, ~7,124 offline tests +
  52 gated real-Postgres integration tests + five CI gates** — unchanged. No new
  META_ tables, no source change.
- A generated reference client (committed under `sdk-clients`) driven off this
  guide is the natural follow-up.
