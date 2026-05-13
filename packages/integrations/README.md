# @crossengin/integrations

Integration mesh contract types per **ADR-0011**. V1 is the pure
declaration + audit layer: zod schemas for the 12 integration kinds,
8 auth methods, transformation declarations, and the audit record
shape. The mesh runtime (adapters, idempotency cache, retries,
circuit breakers, HL7 MLLP listener, transform sandbox) is Phase 2+.

## What's here (v1)

- **`IntegrationDeclarationSchema`** — 12-variant discriminated
  union by `kind`:

| Outbound | Inbound |
|---|---|
| `outbound.http` | `inbound.webhook` |
| `outbound.graphql` | `inbound.hl7` |
| `outbound.hl7` | `inbound.fhir` |
| `outbound.fhir` | `inbound.edi` |
| `outbound.edi` | `inbound.sftp` |
| `outbound.sftp` | |
| `outbound.webhook` | |

- **`IntegrationAuthSchema`** — 8 methods: `none`, `apiKey`,
  `bearer`, `basic`, `oauth2.clientCredentials`,
  `oauth2.authorizationCode`, `mtls`, `hmac`. All credentials
  referenced via `VaultReference` per ADR-0004 § Manifest-level
  secrets.
- **`TransformationSchema`** — `declarative` (JSONPath/JMESPath
  field map) or `named` (references a first-party transform in
  `packages/integrations/transforms/<name>`).
- **`HttpOperationSchema` / `GraphqlOperationSchema`** — per-operation
  spec with method, path, query, headers, body/response transforms,
  cache TTL.
- **`WebhookVerificationSchema`** — `hmac` (with header / secret /
  algorithm / tolerance) or `none` (explicit opt-in).
- **`SftpTransportSchema`** — transport for EDI and SFTP integrations.
- **`RateLimitSchema`** — `"<count>/<sec|min|hour|day>"` (regex-enforced).
- **`Iso8601DurationSchema`** — `PT4H`, `P28D`, etc.
- **`VaultReferenceSchema`** — `{ vault: "path.to.secret" }`.
- **`IntegrationMapSchema`** — `Record<string, IntegrationDeclaration>`
  for the manifest's `integrations` section.

### Audit (`@crossengin/integrations/audit`)

- **`IntegrationCallRecordSchema`** — matches `meta.integration_calls`
  shape per ADR-0011 § Audit and compliance. Includes data
  classification, idempotency key, request/response, latency,
  retries, ok flag.
- **`DataClassSchema`** — `public`, `internal`,
  `commercial_sensitive`, `pii`, `phi`, `regulated` (per ADR-0009).

## API

```ts
import {
  // Top-level
  IntegrationDeclarationSchema,
  type IntegrationDeclaration,
  type IntegrationKind,
  INTEGRATION_KINDS,
  IntegrationMapSchema,
  type IntegrationMap,

  // Auth
  IntegrationAuthSchema,
  type IntegrationAuth,
  VaultReferenceSchema,
  type VaultReference,

  // Operations + transforms
  HttpOperationSchema,
  type HttpOperation,
  GraphqlOperationSchema,
  type GraphqlOperation,
  TransformationSchema,
  type Transformation,

  // Transport
  SftpTransportSchema,
  type SftpTransport,
  WebhookVerificationSchema,
  type WebhookVerification,

  // Primitives
  RateLimitSchema,
  Iso8601DurationSchema,

  // Audit
  IntegrationCallRecordSchema,
  type IntegrationCallRecord,
  DataClassSchema,
  type DataClass,
} from "@crossengin/integrations";
```

## Sample manifest entries

```jsonc
"integrations": {
  "stripeBilling": {
    "kind": "outbound.http",
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
    "endpoint": "/api/integrations/hl7/inbound",
    "messageTypes": ["ORU^R01"],
    "auth": {
      "kind": "mtls",
      "clientCert": { "vault": "lab.cert" },
      "clientKey":  { "vault": "lab.key" }
    },
    "transform": "labResultsToManifest",
    "idempotencyKey": "$message.MSH-10"
  },
  "stripeWebhook": {
    "kind": "inbound.webhook",
    "endpoint": "/api/integrations/webhooks/stripe",
    "verification": {
      "kind": "hmac",
      "header": "Stripe-Signature",
      "secret": { "vault": "stripe.webhookSecret" },
      "algorithm": "sha256",
      "tolerance": "PT5M"
    }
  }
}
```

## Deferred to Phase 2+

Per ADR-0011 § Implementation notes:

- Adapter implementations (`packages/integrations/adapters/<protocol>`)
  — HTTP, GraphQL, HL7, FHIR, EDI X12, EDI UBL, SFTP, webhook in/out
- Mesh runtime — idempotency check, rate-limit token buckets,
  retries with exponential backoff, circuit breakers, OAuth token
  refresh
- HL7 MLLP socket listener (`apps/hl7-listener`)
- Transform sandbox (`isolated-vm` with 256 MB / 5 sec limits)
- Webhook signature verification middleware
- Per-tenant integration pause / resume controls
- Synthetic health checks per integration
- Inngest-backed durable retry queue
- ClickHouse cost / latency dashboards
- Cold-storage payload archive (R2 with 90-day retention)
- AS2 transport for X12 (Year 3+)
- FHIR R5 adapter (when adoption grows)
- Per-tenant residency enforcement at the adapter layer

## Run tests

```bash
pnpm --filter @crossengin/integrations test
```
