# ADR-0011: Integration Mesh

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0007, ADR-0008, ADR-0014, ADR-0015, ADR-0017 |

## Context

CrossEngin apps live in ecosystems. A pharmacy talks to drug formularies, insurance clearinghouses, regulatory authority APIs, and POS networks. A hospital exchanges HL7/FHIR with labs, imaging, and EMRs. A construction firm pulls drawings from BIM systems, sends invoices to accounting, files permits with municipal portals. A ministry's e-procurement portal exchanges bid documents with vendor portals over EDI or signed PDF.

Every real CrossEngin tenant has integrations. The kernel must offer:

- **Inbound integrations:** receive data from external systems (webhooks, HL7 messages, file drops, EDI transmissions).
- **Outbound integrations:** send requests to external services (REST APIs with OAuth, HL7 messages, EDI X12 transmissions, signed PDFs).
- **Transformations:** map between the external schema and the tenant's manifest entities.
- **Idempotency:** the same external event delivered twice must not double-create entities.
- **Retries:** transient external failures recover automatically.
- **Audit:** every integration call is logged with payload, response, latency, success/failure.
- **Rate-limit and quota:** per-tenant, per-integration limits prevent runaway costs and respect external API limits.
- **Compliance:** PHI, batch records, financial data crossing the boundary must respect data-classification rules.

Three integration shapes dominate v1:

1. **Generic HTTP** — most third-party APIs (Stripe, QuickBooks, drug formularies, Cloudflare).
2. **Healthcare protocols** — HL7v2 (legacy), FHIR R4 (modern), claims X12 837/835/270/271.
3. **Document exchange** — EDI (X12, UBL for the GCC region), file drops (SFTP), signed PDF.

Integrations are **declared in the manifest** (ADR-0004) and **invoked from workflows** (ADR-0007). The mesh provides the runtime plumbing.

## Decision

`packages/integrations` is the integration mesh. It has four layers:

```
Layer 4: Adapters per protocol (HTTP, HL7, EDI, S/FTP, OAuth)
Layer 3: Transformation pipeline (incoming → entity; entity → outgoing)
Layer 2: Mesh runtime (retries, idempotency, audit, rate-limit, queues)
Layer 1: Manifest integrations (declared in `integrations` section)
```

### Manifest declaration

```jsonc
"integrations": {
  "drugFormularyDailymed": {
    "kind": "outbound.http",
    "label": { "en": "DailyMed Drug Formulary" },
    "auth": { "kind": "none" },
    "endpoint": "https://dailymed.nlm.nih.gov/dailymed/services/v2",
    "rateLimit": "60/min",
    "operations": [
      {
        "name": "lookupDrug",
        "method": "GET",
        "path": "/spls.json",
        "query": { "drug_name": "$input.name" },
        "responseTransform": "drugFormularyResponse",
        "cacheTtl": "PT24H"
      }
    ]
  },
  "stripeBilling": {
    "kind": "outbound.http",
    "label": { "en": "Stripe Billing" },
    "auth": { "kind": "bearer", "token": { "vault": "stripe.secretKey" } },
    "endpoint": "https://api.stripe.com/v1",
    "rateLimit": "100/sec",
    "operations": [
      { "name": "createCustomer", "method": "POST", "path": "/customers" },
      { "name": "createInvoice",  "method": "POST", "path": "/invoices" }
    ]
  },
  "labResultsHl7": {
    "kind": "inbound.hl7",
    "label": { "en": "Lab Results (HL7)" },
    "endpoint": "/api/integrations/hl7/inbound",
    "messageTypes": ["ORU^R01"],
    "auth": { "kind": "mtls", "ca": { "vault": "lab.caBundle" } },
    "transform": "labResultsToManifest",
    "idempotencyKey": "$message.MSH-10"
  },
  "moh-claims-x12": {
    "kind": "outbound.edi",
    "label": { "en": "MoH Claims (X12 837)" },
    "transport": { "kind": "sftp", "host": "claims.moh.gov.ae", "credentials": { "vault": "moh.sftpCredentials" } },
    "transactionSets": ["837", "835", "270/271"],
    "schedule": "0 18 * * 1-5 Asia/Dubai",
    "transform": "claimsToX12"
  }
}
```

### Integration kinds

| Kind | Use case | Adapter |
|---|---|---|
| `outbound.http` | Most third-party REST APIs | `packages/integrations/adapters/http` |
| `outbound.graphql` | GraphQL APIs | `packages/integrations/adapters/graphql` |
| `outbound.hl7` | HL7v2 / FHIR send | `packages/integrations/adapters/hl7` |
| `outbound.edi` | X12 / UBL document exchange | `packages/integrations/adapters/edi` |
| `outbound.ftp` / `outbound.sftp` | File drops | `packages/integrations/adapters/sftp` |
| `inbound.webhook` | Receive webhooks (Stripe, GitHub, etc.) | `packages/integrations/adapters/webhook` |
| `inbound.hl7` | Receive HL7 messages | `packages/integrations/adapters/hl7` |
| `inbound.fhir` | FHIR R4 resources | `packages/integrations/adapters/fhir` |
| `inbound.edi` | Receive EDI transmissions | `packages/integrations/adapters/edi` |
| `inbound.sftp` | SFTP file polling | `packages/integrations/adapters/sftp` |

### Authentication

Auth methods supported:

| Method | Use |
|---|---|
| `none` | Public APIs |
| `apiKey` | Header or query API key |
| `bearer` | Bearer token (OAuth access token, static API key) |
| `basic` | HTTP Basic |
| `oauth2.clientCredentials` | Service-to-service OAuth |
| `oauth2.authorizationCode` | User-delegated OAuth (Stripe Connect, QuickBooks user-auth) |
| `mtls` | Mutual TLS (HL7 inbound, regulator endpoints) |
| `hmac` | HMAC-signed requests (Twilio webhooks, Cloudflare) |

All credentials referenced via vault (per ADR-0004); no inline secrets.

### Transformations

Each operation declares a transformation that maps between external shape and manifest entity shape. Transformations are declarative (JSONLogic / JMESPath) for simple mappings and code-callouts (named TypeScript functions in `packages/integrations/transforms/<name>.ts`) for complex ones.

```jsonc
{
  "name": "drugFormularyResponse",
  "kind": "declarative",
  "spec": {
    "drugId":        "$response.data[0].setid",
    "brandName":     "$response.data[0].title",
    "genericName":   "$response.data[0].generic_name",
    "manufacturer":  "$response.data[0].labeler_name",
    "ndcs":          "$response.data[0].packaging[*].ndc"
  }
}
```

For complex mappings (HL7 → manifest, EDI X12 837 → manifest claim entity), TypeScript transforms run in a sandboxed VM (`isolated-vm`) with strict timeouts.

### Mesh runtime

Every integration call passes through the mesh runtime:

```
Manifest call site (workflow or AI Architect)
     │
     ▼
1. Resolve integration definition + tenant context + residency check
     │
     ▼
2. Idempotency check (key = $idempotencyKey || hash(input))
     ├── Already-processed → return cached result
     └── New → continue
     │
     ▼
3. Rate-limit check (per-integration + per-tenant token buckets)
     ├── Over limit → queue or reject (per integration policy)
     └── Under limit → continue
     │
     ▼
4. Auth resolution (fetch credential from vault; refresh OAuth if needed)
     │
     ▼
5. Adapter call (HTTP / HL7 / EDI / SFTP)
     │
     ▼
6. Response transformation
     │
     ▼
7. Audit emission (request + response + latency + outcome)
     │
     ▼
8. Cache write (if cacheTtl configured)
     │
     ▼
Return to caller
```

### Idempotency

Every outbound call carries an `idempotencyKey`:

- Default: SHA256 of (integration_id + operation_name + serialized input).
- Manifest-specified: `idempotencyKey: "$input.invoice_id"` uses a domain-specific key.
- Inbound calls use protocol-specific keys (MSH-10 for HL7, ISA13 for X12, header `X-Idempotency-Key` for webhooks).

Idempotency state lives in `meta.integration_calls` with TTL by operation (default 24 h; configurable to 30 days for financial integrations).

### Retries and circuit breakers

Per adapter:

- Transient failures (5xx, timeouts, 429): exponential backoff (1s, 2s, 4s, 8s, 16s; max 5 attempts).
- Permanent failures (4xx except 429): no retry; surface to caller.
- Circuit breaker per (integration, operation): opens after 5 consecutive failures in 60s; half-open after 60s; closes on first success.

Retries are durable via Inngest (per ADR-0015) so a process crash doesn't lose the in-flight retry.

### Audit and compliance

Each integration call writes to `meta.integration_calls`:

```jsonc
{
  "id": "...",
  "tenant_id": "t_...",
  "integration_id": "stripeBilling",
  "operation": "createInvoice",
  "direction": "outbound",
  "idempotency_key": "...",
  "request": { "headers_redacted": {...}, "body_redacted": {...} },
  "response": { "status": 200, "headers": {...}, "body_redacted": {...} },
  "latency_ms": 432,
  "retries": 0,
  "ok": true,
  "data_class": "commercial_sensitive",
  "occurred_at": "..."
}
```

Sensitive fields (PHI, PII, secrets) are redacted in the audit log per data-classification rules (ADR-0009). The full payload is stored in cold storage (R2; per ADR-0014) with a 90-day retention default; compliance packs may raise to 7 years.

### Inbound webhook security

Inbound webhook endpoints (`/api/integrations/webhooks/<integration_id>`) are signed with HMAC where the provider supports it (Stripe, GitHub, Twilio). Each integration declares its signing scheme:

```jsonc
{
  "kind": "inbound.webhook",
  "verification": {
    "kind": "hmac",
    "header": "Stripe-Signature",
    "secret": { "vault": "stripe.webhookSecret" },
    "algorithm": "sha256",
    "tolerance": "PT5M"
  }
}
```

Unsigned webhooks are accepted only when explicitly opted in by the tenant admin, with a UI warning.

### Outbound webhook dispatch (CrossEngin → external)

Tenants can subscribe external systems to CrossEngin events. The mesh dispatches:

```jsonc
{
  "kind": "outbound.webhook",
  "subscriptions": [
    {
      "events": ["prescription.verified", "prescription.dispensed"],
      "endpoint": "https://customer.example.com/crossengin-webhook",
      "secret": { "vault": "customer.webhookSecret" },
      "retries": "exponential",
      "deadLetter": "log"
    }
  ]
}
```

Same retry / circuit-breaker / audit as outbound HTTP.

### HL7v2 and FHIR

- **HL7v2 inbound:** TCP MLLP socket-server (`apps/hl7-listener` as a separate Fly Machines deployment) receives messages, parses with `simple-hl7`, dispatches to the kernel for processing. Per-tenant MLLP ports.
- **HL7v2 outbound:** the kernel pushes via MLLP socket-client.
- **FHIR R4 inbound:** HTTP REST endpoints under `/api/integrations/fhir/<tenant_id>/<resource_type>`. Resource validation via `fhir.js`.
- **FHIR R4 outbound:** standard REST with bearer auth. Bundle support for batch operations.

### EDI X12 / UBL

- **X12** (US healthcare 837/835/270/271, supply chain 850/810/856): parsed/serialized via `node-x12`. Transport via SFTP (most common) or AS2 (later).
- **UBL** (used in GCC procurement, EU public-sector): XML-based; parsed/serialized via `xml2js` + schema validation.

### Operational dashboards

Per ADR-0017, integration metrics are exposed:

- Per-integration: request rate, p50/p95 latency, success rate, retry count, circuit-breaker state.
- Per-tenant: integration calls last 24h, error breakdown, costs (if metered).
- Cross-tenant ops: aggregate health by integration provider.

## Alternatives considered

### Option A — Single HTTP adapter; treat HL7 / EDI / SFTP as user code

Manifests embed HL7 / EDI parsing logic; CrossEngin just makes HTTP calls.

- **Pros:** Smaller mesh footprint.
- **Cons:** HL7 and EDI parsing is non-trivial. Every healthcare tenant would reinvent it. Compliance audit becomes harder when every tenant has bespoke parsing. The AI Architect can't reason about HL7 message structure if it isn't a first-class concept.
- **Why not:** Healthcare and government are core verticals. First-class HL7 / EDI is required.

### Option B — Off-the-shelf iPaaS (Workato, Mulesoft, Tray.io, Make.com)

Embed an iPaaS as the integration runtime.

- **Pros:** Mature catalog, drag-drop UI for tenants.
- **Cons:** Licensing wrong for our model (per-task pricing). Vendor lock-in. Cross-tenant security weaker. Manifest-driven model conflicts with iPaaS visual-flow paradigm.
- **Why not:** Wrong abstraction layer. We are the platform.

### Option C — Cloud-vendor event bus (AWS EventBridge, GCP Eventarc)

Use a managed event bus + Lambda transformers.

- **Pros:** Mature.
- **Cons:** Vendor lock-in. Each provider's adapter ecosystem differs. Bridges out of the iPaaS conversation but reintroduces cloud-vendor specifics.
- **Why not:** We're on Vercel + Supabase + Cloudflare; no AWS event-bus dependency. Inngest fills the event-bus role for internal CrossEngin events.

### Option D — Apache Camel embedded

Long-established integration framework (Java-based).

- **Pros:** Mature, complete protocol coverage.
- **Cons:** JVM-based; conflicts with our Node.js stack. Operational overhead.
- **Why not:** Wrong language stack.

### Option E — Code-only integrations (no manifest declaration; each integration is a code package)

Tenants extend by writing TypeScript packages.

- **Pros:** Maximum flexibility.
- **Cons:** Conflicts with manifest-driven model. Closed-source posture forbids tenant-supplied code. AI Architect can't propose integrations.
- **Why not:** Manifest-declared integrations are the right shape.

## Consequences

### Positive

- **Manifest-driven integrations.** AI Architect can propose, validate, preview, and apply integration changes alongside entity and workflow changes.
- **First-class healthcare protocols.** HL7v2 and FHIR R4 are not after-thoughts. Pharma + healthcare tenants get the protocol coverage they need.
- **Idempotency by default.** Tenants don't reinvent it; the mesh handles it.
- **Audit + redaction.** Compliance-bound integrations get audit logs scrubbed of PHI / PII without per-tenant effort.
- **Retries and circuit breakers across all adapters** mean transient external failures don't cascade into CrossEngin instability.
- **Residency enforcement.** Outbound calls respect tenant residency (per ADR-0010); a `eu-only` tenant's data doesn't go to a US-only API without explicit opt-in.

### Negative

- **Implementation cost is large.** HTTP + HL7 + FHIR + EDI + SFTP + webhook inbound + signed dispatch = ~6-8 weeks for v1 core, then per-protocol depth as customers demand. Mitigation: HTTP + webhook inbound + outbound FIRST (covers 80% of v1); HL7 + FHIR in Phase 4 when pharma manifests need them; EDI in Phase 5+.
- **HL7 listener is operationally non-trivial.** TCP MLLP socket server is a separate deployment with its own scaling profile. Mitigation: only spin up when first HL7-using tenant signs.
- **Transform sandbox is a security boundary.** Running tenant-supplied TypeScript in `isolated-vm` has its own threat model.
  - But: tenants don't supply transforms in the closed-source model; CrossEngin staff write first-party transforms. The sandbox is defense-in-depth.
- **Cold-payload storage cost.** Full payloads at 90-day retention add up. Mitigation: monthly partitioned R2 storage, with 30-day glacier transition.

### Neutral

- **Inngest provides the durable execution layer** for both workflows (ADR-0007) and the integration mesh. Reusing the same primitive is consistent.
- **HL7 / EDI specific libraries** are mature Node.js packages; no custom protocol implementations.

### Reversibility

**Moderate cost** to add a new protocol adapter — typically 1-2 weeks per protocol.

**Low cost** to swap individual transforms or operations within an integration.

**High cost** to fundamentally change the manifest-integration model (e.g., move to code-only integrations). Tenants and the AI Architect both depend on the declarative shape.

## Implementation notes

- **Package locations:**
  - `packages/integrations` — runtime + types.
  - `packages/integrations/adapters/<protocol>` — per-protocol adapters.
  - `packages/integrations/transforms/<name>` — first-party transformations.
  - `apps/hl7-listener` — separate deployment for inbound HL7 MLLP (when needed).
- **Idempotency storage:** `meta.integration_calls` with `(tenant_id, integration_id, operation, idempotency_key)` unique index. TTL via Inngest scheduled cleanup.
- **Rate-limit storage:** in-memory + Supabase `kv` for cross-process consistency. Falls back to per-process limits when `kv` is unreachable.
- **OAuth token refresh:** per-integration token refresher (Inngest scheduled job) refreshes tokens 5 minutes before expiry; failures alert and disable the integration.
- **Webhook signature verification:** middleware in `apps/web/api/integrations/webhooks/[id]/route.ts` verifies before dispatching to the mesh.
- **Inbound queue:** webhook payloads land in `meta.integration_inbound_queue`; mesh processes asynchronously with retries. Synchronous 200 OK to the webhook source.
- **HL7 listener deployment:** Fly Machines (or alt) per region; mTLS terminated at the listener; messages forwarded to kernel API.
- **EDI X12 schema validation:** strict schema check; rejects malformed transactions with `997` functional-ack-reject responses.
- **Transform sandbox:** `isolated-vm` with 256 MB / 5 sec limits per transform call. No network, no fs. Imports from a curated stdlib (`lodash`, `date-fns`, common parsers).
- **Per-tenant integration toggle:** tenant admin can pause / resume any integration; pauses queue inbound and prevent outbound.
- **Health checks:** every integration has a synthetic health-check operation (e.g., `GET /healthz`) that runs every 5 minutes; failures fire P2 alerts.
- **Testing:**
  - Recorded fixtures for adapter behavior (`__fixtures__/`).
  - Integration tests against staging endpoints when providers offer sandboxes.
  - Property tests on transformations (random inputs → no panic; valid outputs satisfy schema).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| AS2 transport for X12 — Year 1 SFTP-only is enough; AS2 needed when a US healthcare clearinghouse demands it (likely Year 3). Cost of standing up an AS2 station. | amoufaq5 | Year 3 |
| FHIR R5 support — Year 1 ships R4 (current production standard); R5 is newer and adoption is growing. When does R5 become a separate adapter? | amoufaq5 | Year 2 |
| Transform sandbox engine — `isolated-vm` is solid; alternatives (V8 isolates via Cloudflare Workers, WebAssembly) may give better perf or sandbox guarantees. | amoufaq5 | Phase 4 |
| Tenant-side custom transform authoring — closed-source posture forbids tenant code; do we ship a curated DSL (templating-only) for tenants to do simple field-mapping? | amoufaq5 | Phase 5 |
| Inbound webhook reception under DDoS — Cloudflare WAF handles bulk; sustained large-payload webhook abuse needs per-tenant inbound rate-limits. | amoufaq5 | Phase 5 |
| Integration marketplace — first-party catalog vs. community-contributed (closed-source model leans first-party only). Discoverability of available integrations to tenants. | amoufaq5 | Year 2 |
| EDI ISA-receiver-ID-based tenant routing for shared inbound channels — when CrossEngin operates a shared SFTP gateway for multiple tenants, how is the inbound transaction routed to the right tenant? | amoufaq5 | Phase 5 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines entities the integration mesh maps to.
- ADR-0004 (Manifest specification) — defines the `integrations` manifest section.
- ADR-0007 (Workflow engine) — defines workflow effects that invoke integrations.
- ADR-0008 (RBAC v2, ABAC, audit) — defines audit emission and data-classification rules.
- ADR-0014 (Files and storage) — defines cold-storage layer for payloads.
- ADR-0015 (Jobs and async runtime) — defines Inngest layer for durable retries.
- ADR-0017 (Observability and SLOs) — defines integration monitoring.
- HL7v2 standard; FHIR R4 specification; X12 standards; Stripe API documentation; OAuth 2.0 RFCs.
