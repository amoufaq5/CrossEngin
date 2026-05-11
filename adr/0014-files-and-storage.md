# ADR-0014: Files and Storage

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0015, ADR-0019 |

## Context

Every real CrossEngin tenant uploads, generates, or exchanges files:

- A **pharmacy** scans paper prescriptions, uploads prescriber license PDFs, generates dispensing labels and patient information leaflets, attaches batch records and certificates of analysis to inventory items.
- A **hospital** stores patient consent PDFs, lab result attachments, imaging-study summaries, scanned ID cards.
- A **procurement office** receives RFP submissions as zipped document sets, generates contract PDFs, archives bid evaluations.
- A **construction project** stores drawings (DWG, PDF, IFC for BIM), photos from site visits, daily-log PDFs.
- A **graduate-school admissions** office accepts transcripts, recommendation letters, sample work.

Files are first-class data alongside entities. They must be:

- **Stored cheaply** at scale (terabytes to petabytes across tenants).
- **Region-aware** (per ADR-0010 residency profile).
- **Encrypted at rest** (per ADR-0009).
- **Virus-scanned** before users download them.
- **OCR'd** when relevant (prescriptions, regulatory filings — the AI Architect needs text content for RAG).
- **Auditable** (every upload, download, regenerate, delete).
- **Retention-aware** (compliance packs impose minimum retention).
- **Signed-URL accessible** (no static public URLs to tenant content).
- **Lifecycle-managed** (auto-archival to cold tier; auto-deletion at retention expiry).
- **Mobile-friendly** (Capacitor / PWA upload via camera, document picker).

Round 1 picked **Cloudflare R2** as the file storage backend. R2 has multi-region buckets, S3-compatible API, no egress fees, and Cloudflare's WAF in front. Round 9 added BGE self-hosted for embeddings, which is relevant for file-content indexing (embedding OCR'd PDF text).

## Decision

`packages/files` is the file integration layer. The kernel exposes a `FileReference` type as a first-class field type (per ADR-0003); manifests declare file-typed fields with lifecycle rules; the kernel and renderer (ADR-0018) handle the rest.

### File reference type

```typescript
type FileReference = {
  id: string;                          // UUID v7
  tenant_id: string;
  storage_key: string;                 // R2 object key
  filename: string;
  mime_type: string;
  size_bytes: number;
  checksum_sha256: string;
  status: "uploading" | "scanning" | "available" | "quarantined" | "archived" | "deleting";
  uploaded_by: string;                 // user_id
  uploaded_at: string;
  scanned_at?: string;
  ocr_status?: "pending" | "done" | "skipped" | "failed";
  ocr_text_key?: string;               // R2 key of OCR sidecar
  embedding_status?: "pending" | "done" | "skipped";
  retention_class: string;             // Determined by manifest + compliance pack
  archive_after?: string;              // ISO 8601 date
  delete_after?: string;
  data_class: "public" | "commercial_sensitive" | "pii_basic" | "pii_strict" | "phi" | "gxp_record";
  metadata: Record<string, JsonValue>;
};
```

`FileReference` rows live in `meta.files` with per-tenant partitioning. R2 objects use the key pattern:

```
crossengin-files-<region>/
├── t_<tenant_id>/
│   ├── prescriptions/
│   │   └── 2026/05/<file_id>.pdf
│   ├── batch-records/
│   │   └── 2026/05/<file_id>.pdf
│   └── ...
```

### File-typed fields in manifests

```jsonc
"entities": {
  "prescription": {
    "fields": {
      "scan": {
        "type": "file -> StorageReference",
        "fileType": "prescriptionScan"
      }
    }
  }
},
"files": {
  "prescriptionScan": {
    "label": { "en": "Prescription Scan" },
    "allowedMimeTypes": ["application/pdf", "image/jpeg", "image/png", "image/heic"],
    "maxSize": "20MB",
    "storage": { "bucket": "crossengin-files-{region}", "prefix": "prescriptions/" },
    "virusScan": true,
    "ocr": { "enabled": true, "language": "eng+ara" },
    "embedding": { "enabled": true, "scope": "tenant" },
    "retention": { "minYears": 7, "compliancePackOverride": "21-cfr-part-11" },
    "lifecycle": [
      { "phase": "hot", "durationDays": 180 },
      { "phase": "archive", "tier": "infrequent" }
    ],
    "signedUrl": { "defaultExpiry": "PT15M", "maxExpiry": "P1D" },
    "dataClass": "phi"
  }
}
```

Manifest declares the **policy** for a file type. The kernel enforces it at upload/download/delete.

### Upload flow

```
1. Tenant calls POST /api/v1/files/upload-init with metadata.
2. Kernel validates against manifest fileType.
3. Kernel issues a pre-signed PUT URL to R2 (15 min expiry).
4. Tenant uploads directly to R2 via PUT URL.
5. Cloudflare emits an R2 object-create event → webhook into CrossEngin.
6. Kernel marks the FileReference as `scanning`.
7. Inngest job (ADR-0015) runs virus scan (ClamAV via container or Cloudflare's scanner).
8. On clean, kernel marks `available`; on virus, marks `quarantined` and notifies admin.
9. If OCR enabled, parallel Inngest job runs OCR; result stored as `<key>.txt.gz` sidecar.
10. If embedding enabled, OCR text chunked + embedded via BGE (per ADR-0006), vectors stored in pgvector.
11. Audit row written.
```

The upload UI shows progress + scan status + OCR status when applicable. Tenants can use the file once `available`.

### Download flow

```
1. Tenant calls GET /api/v1/files/<id>/url.
2. Kernel checks RBAC + ABAC + field-level read permission on the entity owning the FileReference.
3. Kernel checks file status — `available` only; `quarantined` returns 403 with reason.
4. Kernel issues a pre-signed GET URL (default 15 min; manifest-controlled max).
5. Audit row written (download intent).
6. Tenant fetches the file directly from R2 via the signed URL.
```

R2 access logs are aggregated daily and reconciled with kernel audit logs to detect anomalies (e.g., signed URLs being shared externally).

### Region and residency

The bucket is selected by `tenant.residency.primaryRegion` (per ADR-0010):

- `eu-central` tenants → `crossengin-files-eu`
- `me-uae` tenants → `crossengin-files-uae` (self-hosted S3-compatible when ME region exists)
- `us-east` tenants → `crossengin-files-us`

Cross-region access is forbidden. Tenant migration (ADR-0010) copies files to the target region.

### Encryption

R2 server-side encryption is AES-256 by default. Compliance-pack tenants (HIPAA, GxP) opt into customer-managed keys (CMK) via Cloudflare's R2 customer-managed encryption (Year 3+ feature).

Pre-signed URLs use Cloudflare's signing mechanism with HMAC-SHA256.

### Virus scanning

Two-tier scanning:

- **Sync at upload:** Cloudflare's built-in scanner (Phase 4+ when Cloudflare R2 adds it natively, currently Roadmap) or our own ClamAV container deployed on Fly Machines. Sync scan completes within 5 seconds for files < 10MB; larger files go async with a `scanning` status preventing download.
- **Periodic rescans:** monthly background job re-scans archived files against latest signatures; flags newly-detected matches as `quarantined` and audits the change.

Quarantined files are NOT deleted automatically — they're kept for incident review. Tenant admin can purge with confirmation.

### OCR

OCR runs on file types with `ocr.enabled: true`:

- **Engine:** Tesseract 5 (open-source) for v1; supports 100+ languages.
- **Alternative:** AWS Textract / Azure Document Intelligence for higher-accuracy PDF / handwritten extraction (Phase 5+ paid-tier feature).
- **Language detection:** `eng+ara` for ME tenants; `eng+fra` for some EU tenants; tenant-configurable.
- **Output:** plain text sidecar (`<key>.txt.gz`) + structured JSON when document has form fields (`<key>.fields.json`).

OCR text feeds the embedding pipeline (per ADR-0006) for RAG retrieval in the AI Architect.

### Embeddings of file content

When `embedding.enabled: true`, OCR text is chunked (1024-token chunks with 128-token overlap) and embedded via BGE (`packages/embeddings`). Vectors stored in pgvector on the tenant's Postgres schema, in a `t_<id>.file_embeddings` table:

```sql
CREATE TABLE file_embeddings (
  file_id UUID,
  chunk_idx INT,
  chunk_text TEXT,
  embedding vector(1024),
  PRIMARY KEY (file_id, chunk_idx)
);
CREATE INDEX file_embeddings_ivfflat ON file_embeddings USING ivfflat (embedding vector_cosine_ops);
```

The AI Architect's `readUploadedDocument` tool (ADR-0005) queries this table for relevant chunks during conversations.

### Generated files

Some files are generated by CrossEngin rather than uploaded:

- **Dispensing labels** generated as PDF on `dispense` transition.
- **Batch certificates** generated by the QA workflow.
- **Permit documents** generated by the procurement workflow.
- **Compliance reports** generated by the reporting pipeline (cross-link ADR-0013).

Generated files go through the same `FileReference` lifecycle (status, audit, retention) but skip virus scan (CrossEngin-trusted source) and may skip OCR (we authored the content; OCR adds no info).

Generation runs in an Inngest job triggered by the workflow effect. Templates live in `packages/files/templates/<name>` and use Handlebars + Puppeteer for PDF rendering.

### Retention and lifecycle

Each file's `retention_class` is determined at upload:

- Manifest's `files.<type>.retention.minYears` is the baseline.
- Compliance packs override via `compliancePackOverride` (e.g., `21-cfr-part-11` sets 7 years for gxp_record class).
- Tenant cannot reduce below pack-mandated minimum.

Lifecycle phases:

- **Hot** (R2 Standard) — first 180 days (or per `lifecycle[0].durationDays`).
- **Archive** (R2 Infrequent Access) — after hot. ~50% cheaper. Slight retrieval latency.
- **Cold** (Glacier-equivalent) — after archive expires. Used for very-long-retention compliance files (7+ years).
- **Delete** — at `delete_after` date. Hard delete from R2 + `FileReference` row + OCR sidecar + embeddings.

Lifecycle transitions are R2-native (via lifecycle rules); deletion is kernel-side (audited).

### Permission integration

File access permissions follow the owning entity's permissions (per ADR-0008):

- A user who can `read` a `prescription` can fetch a signed URL for its `scan`.
- Field-level read restrictions on the file field hide the link (and reject signed-URL requests).
- Downloads emit audit rows tied to the user, IP, user-agent.

The signed URL is a short-lived bearer token; once issued, the file is fetchable until the URL expires. The kernel cannot revoke an active signed URL — the safeguard is short expiry (default 15 minutes).

### Mobile uploads

Capacitor wrapper (ADR-0019) exposes:

- **Camera** → JPEG/PNG capture.
- **Document picker** → PDF / image from device storage.
- **PDF generation** → server-side via the same pipeline as web.

Mobile uploads go through the same pre-signed PUT flow. Capacitor's `Filesystem` plugin handles offline queuing (file held locally until network available); the upload service worker syncs on reconnect.

### Tenant quotas

Per-tenant storage quota (set per plan tier; default 10 GB for Operate base, 100 GB for premium). Quota enforced at upload-init; over-quota returns 403 with upgrade prompt. Soft warning at 80%.

Compliance-pack obligations don't relax quota — quota usage includes pack-archived files; tenants on heavy retention pay for storage.

## Alternatives considered

### Option A — AWS S3 instead of Cloudflare R2

- **Pros:** Most mature ecosystem. More compliance certifications (BAA available, FedRAMP, ITAR).
- **Cons:** Egress fees are real money at scale. Multi-region setup is per-region S3 buckets.
- **Why not:** R2's no-egress model is meaningfully cheaper for our access patterns (downloads dominate). Revisit S3 for BAA-required HIPAA tenants when Cloudflare BAA roadmap clarifies.

### Option B — Supabase Storage instead of R2

- **Pros:** One vendor with Postgres + auth. Simpler integration.
- **Cons:** Supabase Storage is built on S3; pricing is okay but worse than R2 for cold storage. Multi-region story is less mature. Fewer compliance certs at our 2026 cutoff.
- **Why not:** R2 is cheaper and aligns with Cloudflare-fronted SaaS.

### Option C — Tenant-supplied storage (BYOC files)

Tenants point CrossEngin at their own S3 / GCS / Azure Blob.

- **Pros:** Maximum residency control.
- **Cons:** v1 too complex. Per-tenant credential management. Multi-tenant ingress/egress patterns vary.
- **Why not:** Year 4 BYOC feature, not v1.

### Option D — Database BLOB storage (files in Postgres bytea)

Store files in Postgres tables.

- **Pros:** Single backup. Transactional integrity (file metadata + content commit together).
- **Cons:** Files larger than ~1 MB are pathologically bad in Postgres. Storage cost is ~10× R2. Backups balloon.
- **Why not:** Industry consensus: don't store files in Postgres. Postgres holds the `FileReference`; R2 holds the bytes.

### Option E — IPFS / decentralized storage

Use IPFS for content-addressed storage.

- **Pros:** Censorship-resistant. Content addressing.
- **Cons:** Not compliance-friendly. Doesn't fit B2B SaaS norms. Doesn't help residency.
- **Why not:** Wrong fit.

## Consequences

### Positive

- **Cheap at scale.** R2's no-egress pricing dominates for download-heavy workloads.
- **Manifest-driven file policies.** Per-file-type allowed types, sizes, lifecycle, retention — all declared.
- **Compliance-aware retention.** Packs automatically override; tenants can't accidentally violate.
- **OCR + embeddings out of the box.** AI Architect can reason about uploaded docs from day one.
- **Region-locked.** Files never leave tenant residency boundary.
- **Audited.** Every upload, download, regenerate, delete recorded.

### Negative

- **Virus-scan infrastructure** is real ops. Cloudflare's R2 scanner is roadmap; until then we run ClamAV on Fly Machines. Mitigation: a separate Fly Machines service with auto-scaling.
- **OCR + embedding cost** adds GPU compute and storage. Tenant-tier-aware (default tenants get OCR; heavy embedding requires premium). Mitigation: opt-in per file type.
- **Generated-file template maintenance.** Each compliance pack ships templates; templates evolve with regulation changes. Mitigation: ship templates as part of pack versioning.
- **Quota enforcement is a UX surface.** Tenants need clear "you have X% of your storage used" + upgrade flow. Mitigation: standard dashboard widget.

### Neutral

- **R2 lifecycle rules** handle the tiering automatically; we only handle the final delete.
- **Signed URLs** are standard.

### Reversibility

**Moderate cost** to swap R2 for S3 if Cloudflare changes business model. Most code is S3-API compatible.

**Low cost** to evolve manifest file-type declarations.

**High cost** to deprecate generated-file templates that tenants depend on for printed compliance documents. Sunset windows.

## Implementation notes

- **Package locations:**
  - `packages/files` — file types, upload/download API, lifecycle manager.
  - `packages/files/templates` — Handlebars + Puppeteer PDF templates.
  - `packages/embeddings` — chunking + BGE call (cross-link ADR-0006).
  - `apps/virus-scanner` — ClamAV-backed Fly Machines service.
- **Pre-signed URL signing:** Cloudflare R2's signature format; signed by an R2-managed key.
- **R2 lifecycle rules:** declared in Terraform per bucket; transitions Hot → IA at 180d, IA → Glacier-equivalent at 365d.
- **OCR pipeline:**
  - Inngest job triggered by file `available` status.
  - Tesseract container with language packs preloaded.
  - Output stored as gzipped text sidecar; deleted alongside the file on hard-delete.
- **Embedding pipeline:**
  - Inngest job after OCR.
  - Chunks via `langchain/text-splitter`; size 1024 tokens with 128 overlap.
  - BGE embedding via the GPU container (per ADR-0006).
  - Stored in `t_<id>.file_embeddings` with pgvector ivfflat index.
- **Generated file templates:** Handlebars + custom helpers for currency / date / locale; Puppeteer renders to PDF with print stylesheet.
- **Quota enforcement:** `meta.tenant_storage_usage` aggregates daily; upload-init blocks at 100%; soft warnings at 80%, 95%.
- **Audit cross-link:** every upload/download/delete emits to `meta.audit_log` (ADR-0008).
- **Quarantine flow:** quarantined file emits a P1 audit; tenant admin sees notification; purge requires confirmation; quarantine retention 90 days then auto-purge.
- **R2 access log reconciliation:** daily Inngest job pulls R2 access logs; cross-references with kernel audit; flags discrepancies (e.g., signed URLs used from unexpected IPs).
- **Testing:** Vitest unit tests for permission integration; integration tests against a localstack-equivalent (Minio + dummy ClamAV); E2E test for full upload → scan → OCR → embed → download flow.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Virus scanner — self-hosted ClamAV vs. Cloudflare's eventual R2 scanner vs. third-party (VirusTotal, Sophos). | amoufaq5 | Phase 4 |
| OCR engine — Tesseract for v1, but for handwritten / poor-quality scans we may need AWS Textract or Azure Document Intelligence. When does the accuracy gap justify the cost? | amoufaq5 | Phase 5 |
| Customer-managed keys via Cloudflare R2 — timing of Cloudflare's CMK general availability; until then, HIPAA tenants may require AWS S3 with KMS. | amoufaq5 + _pending compliance hire_ | Year 3 |
| Per-tenant storage quota tiers — exact GB by plan; how does AI Architect cost integrate with storage cost in billing UX? | amoufaq5 + commercial hire | Phase 5 |
| BAA with Cloudflare for HIPAA — Cloudflare's BAA scope at 2026; if R2 isn't in scope, HIPAA tenants need S3-backed file storage. | _pending compliance hire_ | Year 3 |
| Pre-signed URL expiry policy — 15-minute default is conservative; some compliance packs may require shorter (e.g., 5 min for PHI). | _pending compliance hire_ | Phase 4 |
| File-content embedding scope — tenant-private only, or opt-in to "cross-tenant anonymized" for the catalog (per ADR-0025)? | _pending compliance hire_ | Phase 5 |
| Tenant file-content search UI — full-text search over OCR text in addition to entity search (cross-link ADR-0016). | amoufaq5 | Phase 5 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines `file -> StorageReference` field type.
- ADR-0004 (Manifest specification) — defines the `files` manifest section.
- ADR-0006 (LLM provider router) — defines BGE embedding pipeline.
- ADR-0009 (Security model) — defines encryption at rest and signed URLs.
- ADR-0010 (Multi-region and data residency) — defines region-pinned buckets.
- ADR-0011 (Integration mesh) — defines inbound file drops via SFTP.
- ADR-0012 (Compliance pack architecture) — defines pack-imposed retention overrides.
- ADR-0015 (Jobs and async runtime) — defines Inngest jobs for scan, OCR, embedding, lifecycle.
- ADR-0019 (PWA and Capacitor mobile) — defines mobile upload mechanics.
- Cloudflare R2 documentation; Tesseract OCR; ClamAV; pgvector.
