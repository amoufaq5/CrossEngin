# ADR-0009: Security Model

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0002, ADR-0004, ADR-0008, ADR-0010, ADR-0012, ADR-0014, ADR-0017, ADR-0025 |

## Context

CrossEngin's customer base includes pharma manufacturers with GxP/21 CFR Part 11 obligations, hospitals and clinics with HIPAA-equivalent obligations, government tenants with PDPL/GDPR-equivalent obligations, and ministries with sovereign-data expectations. The Round 9 decision committed CrossEngin to certifications-only regulatory posture: SOC 2 Type II, ISO 27001, and HITRUST — but no direct FDA/EMA partnerships. That posture only works if the underlying security model is genuinely defensible to a SOC 2 / ISO auditor on day one of audit.

A v1 security incident — a data leak, a credential compromise, a tenant-isolation breach — is fatal for a small platform targeting regulated buyers. Trust is the moat alongside the AI Architect; losing it once costs years to rebuild.

ADR-0002 covered multi-tenant isolation at the database layer. ADR-0008 covered RBAC, ABAC, audit, and identity. This ADR covers the remaining security surface:

- Encryption at rest and in transit.
- Key management.
- Secret management (referenced by ADR-0004; detailed here).
- Network security (WAF, DDoS, rate limits).
- Backup and disaster recovery.
- Threat model and incident response.
- Dependency / supply-chain security.
- Container security for self-hosted components (BGE embeddings; later self-hosted LLM).
- Certifications roadmap.

Decisions that constrain this ADR:

- **Supabase v1 host** (Round 1, ADR-0002). We inherit Supabase's encryption-at-rest, network controls, and SOC 2 Type II.
- **Closed-source everything** (Round 2). Source code never leaves a controlled repository; no public bug-bounty disclosure path until Phase 5+.
- **Standards certifications only** (Round 9). We target SOC 2 Type II Year 2; ISO 27001 Year 3; HITRUST when a HIPAA-regulated tenant requires it (likely Year 3 if a US hospital lands; otherwise Year 4+).
- **Self-hosted BGE for embeddings** (Round 1). The GPU inference container is the first piece of non-Supabase, non-Vercel infrastructure we operate. Its security model matters out of proportion to its size.
- **First region UAE** (Round 2). UAE PDPL applies once a UAE-resident-data tenant signs.

## Decision

CrossEngin's security model is built in five layers:

```
Layer 5: Process & Governance        — SDLC, incident response, certifications
Layer 4: Application Security        — input validation, CSRF, CSP, deps
Layer 3: Identity & Access           — covered by ADR-0008 (cross-ref only here)
Layer 2: Cryptography & Secrets      — encryption, key management, vaults
Layer 1: Infrastructure Security     — network, isolation, backup, DR
```

### Layer 1 — Infrastructure security

**Hosting model.**

- **Application:** Vercel for `apps/web`, `apps/marketing`, `apps/docs-site`. Edge functions and serverless.
- **Database:** Supabase Postgres in Frankfurt (`eu-central-1`). Encryption-at-rest is AES-256 via Supabase's underlying provisioned PostgreSQL. TLS 1.3 in transit.
- **Object storage:** Cloudflare R2 for files (ADR-0014). Server-side encryption enabled by default.
- **GPU inference (BGE):** Container running on Fly Machines or RunPod (choice TBD per ADR-0005 open question). Deployed in EU region to keep latency to Frankfurt Supabase under 50 ms.
- **CDN / WAF:** Cloudflare in front of all public surfaces. Rate limiting + bot detection + DDoS mitigation at the edge.

**Network isolation.**

- All inter-service traffic flows over TLS 1.3. No internal HTTP.
- Supabase + Vercel + Cloudflare comprise the v1 control plane. Each has its own network boundary; data crosses boundaries only over authenticated TLS.
- GPU inference container exposes only the embedding endpoint. Behind a Cloudflare-fronted authenticated gateway; never publicly reachable.
- On-prem and BYOC editions (Year 3+) deploy in customer-controlled networks; the kernel still enforces all application-layer controls.

**Backup and disaster recovery.**

- **Supabase PITR** enabled at the Pro tier — point-in-time recovery to any second within the last 7 days (v1); raised to 30 days when first regulated tenant requires it.
- **Daily logical backups** (per-tenant `pg_dump` of `t_<id>` schemas) shipped to R2 in `cold-backup/<tenant_id>/<yyyy-mm-dd>/`. Retention 90 days hot, 7 years cold for compliance-pack tenants.
- **Cross-region replica.** Once first non-EU tenant signs, we maintain a read replica in Singapore (`ap-southeast-1`) for DR. Promotion procedure documented in `RUNBOOK_DR.md`.
- **RPO / RTO targets:**
  - RPO 1 minute (PITR granularity) for tenant data.
  - RTO 4 hours for primary-region outage in Year 1; 1 hour by Year 2 once cross-region failover is automated.
  - DR drills quarterly starting Phase 5; restore one test tenant from cold backup and verify integrity.

**Tenant deletion enforcement.**

Per ADR-0002, soft delete with 30-day retention then hard delete. Hard delete = `DROP SCHEMA t_<id> CASCADE` + cold-backup purge (within 90 days). GDPR Article 17 right-to-erasure mapped to this flow.

### Layer 2 — Cryptography and secrets

**Encryption at rest.**

- **Supabase Postgres:** AES-256 at-rest provided by the underlying provider. Verified annually as part of SOC 2.
- **R2 object storage:** AES-256-GCM server-side encryption.
- **Audit logs:** stored in Supabase, inherit Supabase encryption. Archived audit logs in R2 inherit R2 encryption.
- **Backups:** R2 with encryption + customer-managed key for compliance-pack tenants (HIPAA, GxP).

**Encryption in transit.**

- TLS 1.3 minimum. TLS 1.2 only for legacy integrations that demand it; logged as a deprecated channel.
- HSTS on all public surfaces.
- Certificate pinning for the iOS/Android Capacitor app (Year 3+) when it ships.

**Key management.**

- **Application secrets** (Stripe keys, Fireworks API key, NextAuth signing keys, JWT secrets) — stored in Supabase Vault. Rotated quarterly.
- **Tenant integration secrets** (OAuth tokens, X12 endpoints, drug formulary keys) — vault references per ADR-0004. Lived under `meta.integration_secrets`; vault path per tenant.
- **Customer-managed keys (BYOK)** for regulated tenants — Year 3+ feature. AWS KMS or Azure Key Vault integration; the tenant brings their CMK, CrossEngin uses it for tenant-data encryption.
- **Signing keys** for manifest signatures (per ADR-0004) — Ed25519. Root signing key stored in Supabase Vault; rotated annually; previous-version keys retained indefinitely for verification.

**Secrets in code and config.**

- No secrets in repository. CI enforces via `gitleaks` and a custom scanner that fails the build on regex matches.
- Local development uses `.env.local` files (gitignored). Production secrets injected via Vercel env vars (Supabase Vault references resolved at runtime).
- Rotation cadence:
  - JWT signing key: 90 days, overlapping for 14-day verification window.
  - NextAuth secret: 90 days.
  - Stripe restricted keys: per-deployment, rotated on personnel changes.
  - Fireworks API key: 90 days.
  - Manifest signing key: annual.

### Layer 3 — Identity and access

Covered fully by ADR-0008. Summary:

- NextAuth.js with magic-link + OAuth (Google, Microsoft, GitHub).
- WebAuthn / TOTP MFA. Required for `tenantAdmin` and roles with `transitions` on `part11Compliant` entities.
- Re-authentication challenge for e-signature on GxP transitions.
- Per-tenant Postgres roles plus session-bound search_path + RLS context.
- OPA Rego policies for fine-grained ABAC.

### Layer 4 — Application security

**Input validation.**

- Every API endpoint validates input with Zod. The kernel-published types in `packages/types` are the source of truth.
- Manifest patches validated against the manifest spec (ADR-0004) before any DDL.
- LLM inputs (the user's chat message in the AI Architect) treated as untrusted. The agent's outputs are validated against the structured tool schemas before tool calls execute.

**Output encoding.**

- React's default escaping in the renderer (ADR-0018) covers most XSS surface.
- `dangerouslySetInnerHTML` is forbidden in core packages; ESLint custom rule.
- Markdown rendering (ADRs, tenant-facing helps) uses `react-markdown` with a strict allowlist of tags.

**CSRF.**

- NextAuth's CSRF tokens on state-changing forms.
- All API endpoints under `/api/v1/*` require either a session JWT (Bearer header) or a CSRF-protected form submission.

**Content Security Policy.**

- Strict CSP: `default-src 'self'; script-src 'self' 'nonce-<...>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://...; connect-src 'self' https://*.supabase.co https://api.fireworks.ai;`
- Reported to Sentry (ADR-0017) for violations.

**Rate limiting.**

- Cloudflare WAF at the edge: per-IP burst limits, geo-rate-limits on signup.
- Application layer: per-user/per-tenant token-bucket on AI Architect endpoints (cost protection) and on manifest-apply endpoints (DDL safety).

**Dependency security.**

- `pnpm audit` in CI; blocks merges on Critical/High advisories.
- Renovate bot for automated dep updates; minor/patch auto-merged on green CI, major manual.
- Snyk or Socket.dev scanning for malicious package detection on every dependency add.
- `package.json` resolutions pinned to specific versions; no caret ranges for security-sensitive packages (`@anthropic-ai/sdk`, `next-auth`, `zod`, `@open-policy-agent/opa-wasm`).
- npm 2FA enforced on the org account.

**LLM-specific risks.**

- Prompt injection: the agent's system prompt instructs it to treat user input as data, not instructions. Tool calls are validated structurally; the kernel never executes free-form LLM output.
- Data leak via LLM: the agent never receives cross-tenant data. RAG retrieval (ADR-0005) is scoped to the active tenant's manifest + opted-in shared catalog.
- Cost runaway: per-session token budget hard-stops the agent (ADR-0005).

### Layer 5 — Process and governance

**SDLC.**

- All code changes via PR with at least one review by Phase 1 end (and self-review with explicit checklist while solo).
- CI on every PR: type-check, lint, unit tests, integration tests, security scans (gitleaks, pnpm audit), preview deploy.
- `main` branch protection: green CI required; no force-pushes; signed commits where the harness supports it.
- Production deploys are automatic from `main`; rollback is a `git revert` + re-deploy.

**Incident response.**

- On-call rotation starts Phase 5. Until then, founder is on-call.
- Severity tiers:
  - **P0** — tenant data leak, RCE, cross-tenant access. Immediate disclosure to affected tenants within 24 h.
  - **P1** — service outage > 5 minutes, partial data loss, MFA bypass.
  - **P2** — performance degradation, single-feature outage.
- Public status page (statuspage.io or Vercel-hosted) from Phase 5.
- Post-mortems for every P0/P1, published internally and (for P0) to affected tenants.

**Vulnerability disclosure.**

- `SECURITY.md` at the repository root with disclosure email and PGP key.
- 90-day default disclosure timeline per coordinated-disclosure norms.
- No public bug bounty in v1; private engagement with security researchers via email.

**Pen-testing cadence.**

- External pen-test annually starting Phase 5 (pre-SaaS launch).
- Internal red-team exercise quarterly post-Phase-5 (founder + first hire).
- AI Architect-specific pen-test annually: prompt injection, jailbreaks, exfiltration attempts.

**Certifications roadmap.**

- **Year 1:** internal SOC 2 readiness — controls documented, evidence collection automated.
- **Year 2:** SOC 2 Type II audit (~12-month observation window). Pursue once first paying customer demands it.
- **Year 3:** ISO 27001 certification. HITRUST CSF v11 if a US healthcare tenant requires.
- **Year 4+:** UAE PDPL Data Officer registration (if Frankfurt-hosted UAE tenants need it); HITRUST r2 maintenance.

### Threat model (summary)

| Threat | Likelihood | Impact | Primary mitigation |
|---|---|---|---|
| Cross-tenant data leak | Low | Catastrophic | ADR-0002 schema isolation + ADR-0008 RBAC/ABAC + RLS defense-in-depth |
| Credential compromise (tenant user) | Medium | Tenant-scoped | MFA enforcement on privileged roles; magic-link or OAuth (no password reuse); short session TTL |
| Credential compromise (CrossEngin staff) | Medium | High | npm 2FA, Vercel SSO, Supabase 2FA, hardware-key for production console |
| Prompt injection in AI Architect | High | Variable | Structural validation of LLM output; kernel-only mutations; no agent-executed code |
| Supabase compromise | Very low | Catastrophic | Cross-region backup; documented restore from R2 cold backups onto an alternate Postgres |
| Supply-chain attack via npm | Medium | Variable | Pin versions; Socket.dev scanning; PR review on `package.json` changes |
| DDoS | Medium | Short-term outage | Cloudflare DDoS mitigation; per-IP rate limits |
| Insider abuse | Low (small team) | High | Audit log immutability; CrossEngin staff actions also audited per ADR-0008 |
| GPU container compromise (BGE) | Low | Embeddings disrupted; no tenant data on the container | Container has no direct DB access; only receives prompts via authenticated proxy |
| LLM provider data leak (Fireworks) | Low | Embarrassing | We do not send tenant data to Fireworks unless the tenant explicitly opts in (ADR-0025); default RAG is on-platform |

## Alternatives considered

### Option A — Run our own PostgreSQL on AWS RDS or Aurora

Skip Supabase; manage Postgres directly.

- **Pros:** Maximum control. Fine-grained network policies (VPC, security groups, PrivateLink). Customer-managed encryption keys natively via KMS.
- **Cons:** ~5× the operational complexity. Supabase's auth, Realtime, Storage, Vault, Edge Functions all replaced with bespoke or AWS-equivalent. ~6 months to set up production-grade. For a solo team, that's the project — there's no time left for the product.
- **Why not:** Solo-team operational economics favor Supabase. Migrate to self-managed when scale or compliance requires it (likely Year 3+ when on-prem ships).

### Option B — Run on AWS / GCP from day one

Build directly on cloud-provider primitives. No Supabase/Vercel intermediaries.

- **Pros:** No vendor lock-in to Supabase/Vercel. Better cost economics at scale (multi-million ARR).
- **Cons:** Multi-month infrastructure work before any product code. Worse developer experience. No managed Postgres equivalent without trading off something Supabase offers.
- **Why not:** Same as Option A. Cloud-provider direct is right for Year 3+ when self-hosted / BYOC drives margins.

### Option C — Implement column-level encryption for PHI from day one

Encrypt PHI columns with per-tenant keys at the application layer.

- **Pros:** Strongest possible at-rest protection. HIPAA / HITRUST friendly.
- **Cons:** Query patterns get awkward — encrypted columns can't be indexed for search, queried with range predicates, or aggregated. Composing with the manifest-driven kernel becomes painful.
- **Why not:** Defer until a HITRUST tenant lands and demands it. Supabase's at-rest encryption is sufficient for SOC 2 / ISO 27001 / generic GDPR.

### Option D — Open-source bug bounty program from day one

Public disclosure program with payouts.

- **Pros:** Crowdsources security review. Builds reputation in security community.
- **Cons:** We're closed-source. Bug bounty programs typically expect at least some public surface; the surface here is the SaaS app + API. Manageable but adds disclosure-management overhead before there's volume to justify.
- **Why not:** Defer to Phase 5+ when there are real attackers worth bounty-ing for. Use private engagement until then.

### Option E — Run Postgres on customer infrastructure (BYOC) from v1

Every customer gets their own Postgres in their own cloud account.

- **Pros:** Maximum data residency. No multi-tenant isolation concerns.
- **Cons:** Sales cycle goes from days to months. Operations complexity 10×. Not a v1-friendly model.
- **Why not:** BYOC is a Year 4 deliverable (Round 10 decision). SaaS first, BYOC when revenue justifies.

## Consequences

### Positive

- **Supabase + Vercel + Cloudflare** is a known-good stack that small teams operate successfully. Annual third-party audit findings are reasonable. Operational toil is low.
- **TLS 1.3 + AES-256 + Cloudflare WAF + per-tenant schema isolation** is a defensible baseline for SOC 2 / ISO 27001 audit.
- **Standards certifications path** is well-trodden; auditors exist; checklists are public. No bespoke regulatory affairs work needed.
- **Threat model is explicit.** Every threat has a primary mitigation. Gaps are surfaced as open questions.
- **Audit + RBAC + ABAC + encryption-in-transit-and-at-rest** is the table-stakes feature set for a regulated-industry SaaS in 2026.

### Negative

- **Vendor concentration risk.** Supabase + Vercel + Cloudflare provide ~80% of the stack. A coordinated outage or business-side issue (Vercel acquired by a competitor, Supabase pricing change) propagates. Mitigation: regular backup off-platform; documented escape plan to AWS/GCP.
- **GPU container is our first owned-infrastructure piece.** Operating one production GPU container is more responsibility than zero. The Fly Machines / RunPod choice (ADR-0005 open question) carries real ops risk.
- **HITRUST and full HIPAA covered-entity status are heavy lifts.** Year 3+ revenue must justify the audit + control implementation cost (~USD 100-300K initial; ~USD 50-100K annually).
- **No bug bounty in v1** means we miss external-researcher findings. Mitigation: pen-test + internal red-team starting Phase 5.

### Neutral

- **WebAuthn / TOTP are standard libraries; cost is configuration not implementation.**
- **PDPL alignment** (UAE) requires data-officer registration only when a UAE-resident-data tenant signs. Deferred to that trigger.

### Reversibility

**Low cost to evolve** layers 4 and 5 (application security + governance). Tighter CSP, additional dep scanners, more rigorous SDLC processes can all be added incrementally.

**Moderate cost to evolve** layer 2 (cryptography + secrets). Migrating from Supabase Vault to HashiCorp Vault or AWS Secrets Manager is a few weeks of careful work but feasible.

**High cost to reverse** layer 1 (infrastructure). Switching from Supabase to AWS RDS, or from Vercel to AWS Fargate, is a quarter-plus migration. Plan to outgrow Supabase by Year 3-4 when ARR justifies the move.

## Implementation notes

- **Package locations:** `packages/observability` (security telemetry, Sentry integration), `packages/auth` (per ADR-0008), `infra/inference` (GPU container definitions), `infra/terraform` (Supabase + Vercel + Cloudflare module configs).
- **`SECURITY.md`** at repo root with disclosure email, PGP key, supported versions. Created in Phase 1.
- **`RUNBOOK_INCIDENT.md`** in `docs/` with P0/P1/P2 procedures. Created in Phase 4 (pre-launch).
- **`RUNBOOK_DR.md`** in `docs/` with cross-region failover, restore-from-backup, R2-to-Postgres restore steps. Created in Phase 4.
- **GPU container hardening:** distroless base image; non-root user; read-only filesystem except `/tmp` and the model cache; no shell; signed releases.
- **CSP nonce generation:** per-request via Vercel middleware; nonces threaded through `<script>` tags in the renderer (ADR-0018).
- **Automated security scans:** `gitleaks` pre-commit hook + CI step; `pnpm audit` in CI; weekly `npm-check-updates` PR via Renovate; Socket.dev review on every `package.json` change.
- **Pen-test scope (Phase 5):** SaaS app + API + auth flows + AI Architect tool surface + manifest pipeline + tenant isolation. Specifically NOT in scope: Supabase / Vercel / Cloudflare internals (their auditors cover those).
- **Compliance evidence pipeline:** automate as much as possible — Vanta or Drata for SOC 2 evidence collection, automated control mapping, audit-trail integration.
- **Data classification labels** in `meta.entity_classifications`: `phi` (HIPAA), `pii_strict` (GDPR Special Category), `pii_basic` (GDPR), `gxp_record`, `commercial_sensitive`, `public`. Used to drive encryption choices, retention, and audit obligations.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| GPU inference host: Fly Machines vs. RunPod vs. Lambda Labs vs. AWS GPU spot. Latency from Frankfurt, cost per million embeddings, compliance posture each offers. | amoufaq5 | Phase 2 |
| Vanta vs. Drata vs. Secureframe vs. manual for SOC 2 evidence collection. Cost vs. integration breadth. | amoufaq5 | Phase 4 (pre-Phase-5) |
| Cross-region replica region for DR: Singapore vs. US-East vs. Mumbai. Depends on second-region tenant geography. | amoufaq5 | Phase 5 |
| Pen-test vendor selection: bug-bounty platform (HackerOne private engagement) vs. boutique firm (Trail of Bits, NCC Group). Trade-off: cost vs. depth. | amoufaq5 | Phase 5 |
| BYOK timeline — when does a tenant first ask for customer-managed encryption keys? Likely Year 3 with first HITRUST or UAE government deal. Pre-plan the integration via Supabase Vault → AWS KMS bridge. | amoufaq5 | Phase 5+ |
| Public bug bounty program timing — Phase 5+ or never? Trade-off: external researcher value vs. disclosure-management overhead. | amoufaq5 | Phase 6+ |
| Customer notification SLA on P0 incidents — 24 h is GDPR Article 33 (within 72 h to authorities, "without undue delay" to data subjects). Should we commit to a tighter SLA in customer contracts? | _pending compliance hire_ | Phase 5 |
| Insurance: cyber-liability policy when revenue justifies. Target Year 2 mid. | amoufaq5 | Year 2 |

## References

- ADR-0002 (Multi-tenancy model) — defines per-tenant schema isolation.
- ADR-0004 (Manifest specification) — defines `vault:` references for secrets.
- ADR-0008 (RBAC v2, ABAC, audit) — defines identity, authorization, and audit log.
- ADR-0010 (Multi-region and data residency) — defines region selection and cross-region replication.
- ADR-0012 (Compliance pack architecture) — defines pack-specific security overrides.
- ADR-0014 (Files and storage) — defines R2 encryption and virus scanning.
- ADR-0017 (Observability and SLOs) — defines security telemetry and Sentry integration.
- ADR-0025 (AI Architect safety and governance) — defines tenant opt-in for cross-tenant retrieval.
- SOC 2 Trust Services Criteria; ISO/IEC 27001:2022; HITRUST CSF v11; OWASP Top 10 (2021); CWE/SANS Top 25; UAE PDPL.
