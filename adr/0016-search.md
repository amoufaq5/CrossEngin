# ADR-0016: Search

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0003, ADR-0004, ADR-0006, ADR-0008, ADR-0014, ADR-0018 |

## Context

Every CrossEngin tenant searches. The pharmacist types a drug name into the dispensing search bar; the procurement officer types a vendor ID into the contract search; the auditor types an entity-ID into the audit log search; the construction PM types a drawing reference into the documents search. Search is one of the most-used features and one of the most-frustrating when it fails.

Search in CrossEngin must:

- **Find entities across types** (the global search bar). A tenant typing "amoxicillin" should see drug records + recent prescriptions + dispensing events containing that drug.
- **Find within an entity type** (the in-list search). A tenant on the Prescriptions list filters by patient name.
- **Find content inside files** (OCR text from ADR-0014). The user types "batch 2025-04-A12" and sees scanned batch records mentioning it.
- **Semantic search.** The AI Architect retrieves "similar manifests" (per ADR-0005) and "relevant compliance pack sections" via vector similarity, not keyword match.
- **Multilingual.** Arabic + English at minimum for ME tenants; expandable to French, Spanish, etc.
- **Permission-aware.** Search results are filtered by RBAC + ABAC; a user must never see results they cannot read.
- **Fast.** Sub-200 ms p95 for typeahead; sub-1 s for cross-entity global search.
- **Per-tenant.** Tenants never see each other's results.

Round 1 decided **BGE-large-en / BGE-M3** as the embedding model. Round 1 also picked **Supabase Postgres** as the data store. Postgres has FTS (full-text search) and via pgvector handles vector search. A third candidate — Typesense or Meilisearch — is needed for cross-entity typeahead, where Postgres FTS would require expensive multi-table queries.

## Decision

CrossEngin uses three search engines in concert, each suited to different patterns:

| Engine | Use | Data location |
|---|---|---|
| **Postgres FTS** (`tsvector` + GIN index) | Entity-internal full-text search; field-by-field queries; permission-integrated SQL search | Per-tenant schema |
| **pgvector** (extension of Postgres) | Semantic / similarity search; AI Architect RAG; file-content retrieval | Per-tenant schema |
| **Typesense** (managed search engine) | Cross-entity global typeahead; faceted search; "search anything in CrossEngin" UX | Per-tenant Typesense collection |

### Search declaration in the manifest

```jsonc
"search": {
  "entities": {
    "prescription": {
      "indexedFields": [
        { "field": "patient.name", "weight": "A", "kind": "text" },
        { "field": "drug.name",    "weight": "A", "kind": "text" },
        { "field": "drug.brandName", "weight": "B", "kind": "text" },
        { "field": "id",            "weight": "C", "kind": "exact" }
      ],
      "globalIndex": true,
      "displayInGlobalResults": {
        "title": "$drug.name",
        "subtitle": "$patient.name • $status",
        "url": "/prescriptions/$id"
      },
      "facets": ["status", "drug.category", "writtenAt"]
    },
    "drug": {
      "indexedFields": [
        { "field": "genericName",   "weight": "A" },
        { "field": "brandName",     "weight": "A" },
        { "field": "ndc",           "weight": "B", "kind": "exact" },
        { "field": "category",      "weight": "C" },
        { "field": "indications",   "weight": "C" }
      ],
      "globalIndex": true,
      "facets": ["category", "schedule"]
    }
  },
  "files": {
    "globalIndex": true,
    "ocr": true,
    "embedding": true
  }
}
```

Manifests declare which fields are indexed, with weights (Postgres FTS `tsvector` setweight: `A` > `B` > `C` > `D`), whether the entity appears in the global search, and faceting axes. The kernel translates declarations into Postgres GIN indexes and Typesense schemas.

### Postgres FTS

Each indexed entity has a generated `search_vector` column:

```sql
ALTER TABLE t_<id>.prescription
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(patient_name, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(drug_name, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(drug_brand_name, '')), 'B')
  || setweight(to_tsvector('simple', coalesce(id::text, '')), 'C')
) STORED;

CREATE INDEX prescription_search_gin ON t_<id>.prescription USING GIN (search_vector);
```

The kernel emits this DDL during manifest apply. Queries use `plainto_tsquery` or `websearch_to_tsquery`:

```sql
SELECT id, patient_name, drug_name, status, ts_rank(search_vector, query) AS rank
FROM t_<id>.prescription, websearch_to_tsquery('english', $1) AS query
WHERE search_vector @@ query
  AND <ABAC predicate translated to SQL>
ORDER BY rank DESC
LIMIT 20;
```

The `simple` dictionary is used by default (no stemming) for multilingual support. Tenants can opt into `english`, `arabic`, `french` dictionaries per language; the kernel routes by `i18n.defaultLocale`.

### pgvector for semantic search

OCR text (ADR-0014) and file content are chunked, embedded via BGE-M3 (`packages/embeddings`), and stored in per-tenant `file_embeddings` tables:

```sql
CREATE TABLE t_<id>.file_embeddings (
  file_id UUID,
  chunk_idx INT,
  chunk_text TEXT,
  embedding vector(1024),
  PRIMARY KEY (file_id, chunk_idx)
);
CREATE INDEX file_embeddings_ivfflat ON t_<id>.file_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Entity-level embeddings (for "similar prescriptions" / "similar manifests") use a parallel table per entity type. The manifest controls which entities have embedding-based semantic search enabled.

The AI Architect's `searchSimilarManifests` and `readUploadedDocument` tools (ADR-0005) hit pgvector directly.

### Typesense for global typeahead

Typesense provides:

- Cross-entity search in one query.
- Fast typeahead (<50 ms).
- Built-in faceting + filtering.
- Typo tolerance.

Per-tenant collections in Typesense:

```
collection: t_<tenant_id>__global
  schema:
    - id (string)
    - entity_type (string, facet)
    - title (string)
    - subtitle (string)
    - body (string, for OCR text + searchable content)
    - tags (string[], facet)
    - created_at (int64, sortable)
    - url (string)
    - permission_tags (string[], facet) [used for permission filtering]
```

Documents are upserted via the CDC pipeline (per ADR-0013) when entities change. Permission filtering uses `permission_tags` — at search time, the kernel passes the user's role + ABAC-derived tags as a filter.

### Permission integration

Search permissions:

- **At declaration time:** an entity's `globalIndex: true` requires the entity have at least one role with `read` permission; otherwise the entity is excluded from the global index.
- **At query time:** the kernel translates the requesting session's permissions into Postgres `WHERE` clauses (for Postgres FTS) or Typesense `filter_by` expressions (for global search).
- **Result post-filtering:** as defense-in-depth, even after the query filter, the kernel re-checks each result row's permission before returning. Slower path, only used when ABAC predicates are too complex to translate to SQL/Typesense.
- **Field-level redaction:** result snippets exclude redacted fields. If a snippet would include a redacted-field-only match (the matched text is in a forbidden field), the result is suppressed with no false-positive leak.

### Multilingual handling

- **Postgres FTS:** per-tenant locale config picks the dictionary. Mixed-locale tenants (Arabic + English documents) use the `simple` dictionary with light normalization.
- **pgvector + BGE-M3:** native multilingual; same model handles all supported languages.
- **Typesense:** locale-aware tokenization; Typesense supports per-collection locales.

For RTL languages (Arabic), Typesense returns results with original text; the renderer (ADR-0018) handles bidi display.

### Search analytics

- Per-tenant: top queries, zero-result queries, click-through rate per result position. Surfaced in `apps/ops` per-tenant view.
- Cross-tenant ops: aggregate query patterns help us identify missing entities, common synonyms, manifest-default opportunities.
- Privacy: query strings logged at the tenant level; CrossEngin staff see aggregates only (per ADR-0025).

### AI Architect integration

The agent uses search internally:

- **`searchSimilarManifests`** — pgvector across the manifest catalog.
- **`searchCompliancePack`** — Postgres FTS across pack documentation; pgvector for semantic queries.
- **`readUploadedDocument`** — pgvector chunk retrieval + Postgres FTS for exact matches within the document.

User-facing search invokes the same engines but is permission-checked against the session's role (not the agent's principal).

### Index refresh and consistency

- **Postgres FTS:** `search_vector` is a generated column; always consistent with the row.
- **pgvector:** embeddings written async via Inngest job (per ADR-0015) after OCR completes. Eventually consistent within ~1 minute.
- **Typesense:** CDC pipeline upserts documents within sub-minute lag of source-of-truth changes. A "force reindex" admin action exists for recovery.

### Manifest changes and reindex

When manifest indexed-fields change:

- Postgres FTS: alter the generated column expression. Rewrites the column in place (locks briefly).
- pgvector: re-embed affected rows. Inngest job processes in batches.
- Typesense: schema update + re-upsert. Inngest job; tenants see results updating over 1-10 minutes for large indexes.

The kernel's manifest-apply pipeline serializes these reindex jobs so a manifest is not "live" until indexes complete.

## Alternatives considered

### Option A — Postgres FTS only (no Typesense)

- **Pros:** One less service. Cheaper.
- **Cons:** Cross-entity search requires UNION across many tables; slow with multiple types. Typeahead latency above 200 ms p95 at moderate data volume. Faceting is awkward in pure SQL.
- **Why not:** Typesense's specialty (fast typeahead + faceting) is hard to match in Postgres. The marginal cost of Typesense is acceptable for the UX win.

### Option B — Elasticsearch / OpenSearch

- **Pros:** Industry standard. Powerful query DSL.
- **Cons:** Operational footprint (Elasticsearch cluster). Higher memory cost than Typesense. ES license complexity historically. OpenSearch fork governance.
- **Why not:** Typesense is lighter, simpler, fits CrossEngin scale better. Reconsider Elasticsearch when scale demands sharded distributed search (Year 4+).

### Option C — Meilisearch (Typesense alternative)

- **Pros:** Similar profile to Typesense. Rust-based; fast.
- **Cons:** Multi-tenancy story less mature; per-tenant collections in Meilisearch have a max-collections constraint to watch. Smaller community than Typesense at 2026.
- **Why not:** Typesense edge; revisit if needed.

### Option D — Algolia (hosted SaaS)

- **Pros:** Best-in-class search-as-a-service. Excellent typeahead.
- **Cons:** Per-search pricing scales unpredictably; multi-tenant pricing is per-application not per-tenant. Cost dominates Typesense self-hosted.
- **Why not:** Cost. Reconsider for marketing site / public-docs search where their value over Typesense is highest.

### Option E — pgvector only (no FTS, no Typesense)

Pure semantic search everywhere.

- **Pros:** One paradigm. Modern.
- **Cons:** Semantic search is wrong for exact-match lookups (IDs, NDCs, batch numbers). Slower than FTS for keyword matching. Embedding costs grow with index size.
- **Why not:** Three engines, three patterns. Use each where it fits.

### Option F — Tenant-side BYO search

Let tenants bring their own Elasticsearch / Algolia.

- **Pros:** Tenant control.
- **Cons:** Conflicts with manifest-driven model. Closed-source posture forbids tenant code anyway.
- **Why not:** First-party search is the right v1 shape.

## Consequences

### Positive

- **Right engine for right pattern.** FTS for exact + keyword, pgvector for semantic, Typesense for cross-entity typeahead.
- **Manifest-driven.** Tenants don't author search code; they declare fields and weights.
- **Permission-integrated by construction.** No risk of leaking via search.
- **Multilingual at v1.** Arabic + English work out of the box.
- **AI Architect leverages the same infrastructure.**

### Negative

- **Three engines = three operational surfaces.** Mitigation: Typesense and pgvector are managed (Typesense Cloud + Supabase Postgres); only the CDC pipeline is bespoke.
- **CDC ↔ Typesense reliability.** Lag or drift between Postgres and Typesense leads to "the record exists but search can't find it" complaints. Mitigation: nightly reconciliation jobs; admin "force reindex" action.
- **Typesense Cloud cost.** Scales with collections and document volume. Mitigation: aggregate cold tenants into shared collections; revisit self-hosted at scale.
- **Embedding cost.** Re-embedding large file corpora on manifest changes is expensive. Mitigation: only re-embed when the embedding model itself changes; field changes alone don't trigger re-embed.

### Neutral

- **Postgres FTS is well-understood**; engineers and auditors recognize the pattern.
- **pgvector is mainstream in 2026**; documentation and tooling abundant.

### Reversibility

**Moderate cost** to swap Typesense for Meilisearch or Elasticsearch. CDC adapter changes; query layer changes.

**Low cost** to add new searchable fields or facets via manifest changes.

**High cost** to remove an engine after adoption.

## Implementation notes

- **Package locations:**
  - `packages/search` — search APIs + manifest types + permission integration.
  - `packages/search/engines/{postgres-fts,pgvector,typesense}` — per-engine adapters.
  - `apps/cdc-shipper` (per ADR-0013) extended to ship to Typesense.
- **Postgres dictionary selection:** per-tenant config in `meta.tenants.search_locale`; default `simple` for multilingual; tenant can opt into `english`, `arabic`, `french`.
- **pgvector index tuning:** `ivfflat` with 100 lists at v1; revisit `hnsw` index when pgvector 0.9+ stable.
- **Typesense version:** v0.27+ at 2026 (supports vector search; we use string + facets only at v1).
- **Permission filter generation:** `packages/auth` exposes `getPermissionTags(session, entity_type)` returning `["role:pharmacist", "store:5", "region:dubai"]` etc.; Typesense `permission_tags` field is searched with `filter_by: permission_tags:=[<tags>]`.
- **CDC reliability:** dual-write at app-level for critical Typesense documents (e.g., entity creates); CDC for everything else. Reconcile nightly.
- **Snippet generation:** Postgres `ts_headline` for FTS results; manual snippeting for Typesense (return surrounding tokens).
- **Stop-word handling:** per-tenant configurable; default minimal stop-word list to avoid losing precision on entity-name queries.
- **Force-reindex tooling:** `tools/reindex-tenant <id> --engine=<fts|pgvector|typesense>` for admin recovery.
- **Testing:**
  - Unit tests on query translation (manifest spec → SQL / Typesense).
  - Property tests on permission filter generation (every result row must satisfy session's RBAC + ABAC).
  - Integration tests against test Postgres + Typesense instances.
  - Performance tests on representative tenant data sizes (10K, 100K, 1M rows).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Typesense Cloud vs. self-hosted Typesense — costs at scale, residency implications (Typesense Cloud regional availability). | amoufaq5 | Phase 5 |
| Arabic stemming and normalization — `simple` dictionary works but loses stemming. Custom Arabic dictionary or Typesense locale handling sufficient? | _pending design hire_ (with Arabic-fluent reviewer) | Phase 4 |
| Per-tenant search-result personalization — boost-recently-clicked, boost-frequently-accessed? Risks: privacy, indexing complexity. | amoufaq5 | Phase 5 |
| Search-analytics privacy threshold — at what aggregation level can CrossEngin ops see cross-tenant patterns without violating tenant trust? | _pending compliance hire_ | Phase 5 |
| pgvector index type — `ivfflat` v1; `hnsw` once stable. Migration story when switching. | amoufaq5 | Phase 4 |
| Re-embedding cost optimization — partial re-embed when only metadata changes (skip text re-embedding). | amoufaq5 | Phase 5 |
| Cross-language search — should "amoxicillin" in English also match Arabic-text records via translation? Probably no for v1; revisit if tenant demand. | _pending compliance hire_ | Phase 5 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant schema isolation Typesense + pgvector + FTS preserve.
- ADR-0003 (Meta-schema and dynamic entity engine) — defines entities with searchable fields.
- ADR-0004 (Manifest specification) — defines the `search` manifest section.
- ADR-0006 (LLM provider router) — defines BGE-M3 embedding pipeline.
- ADR-0008 (RBAC v2, ABAC, audit) — defines permission integration.
- ADR-0014 (Files and storage) — defines OCR + embedding pipeline for file content.
- ADR-0018 (Frontend renderer architecture) — defines List renderer that consumes search results.
- Postgres FTS documentation; pgvector documentation; Typesense documentation; BGE-M3 model card.
