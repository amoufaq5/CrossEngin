# ADR-0244: SOC 2 / HIPAA certification runtime (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-12 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0070/0071 (encryption coverage), ADR-0060 (SLO enforcement), the DR-readiness + access-reviews runtimes, ADR-0077 (Phase 4) |

## Context

The platform *models* every control an auditor asks about — periodic access recertification
(`access-reviews`), encryption of PHI/regulated columns at rest (`kernel-pg` coverage), tamper-evident
hash-chained audit logs (`forensics`), and disaster-recovery readiness (`dr-runtime`). But nothing
*asserts* those modeled controls against a named certification framework and produces a single,
tamper-evident verdict an auditor can consume. Each evidence source has its own report shape and its own
notion of "healthy"; there was no aggregation into "is this platform SOC 2 / HIPAA certifiable, and which
controls are deficient?".

## Decision

Ship **`@crossengin/certification-runtime`** — a pure, in-process package (the established
`-runtime` shape, no new META tables, no live infra) that aggregates control-evidence into a
per-framework certification report.

- **Framework enum reuse.** Import `COMPLIANCE_FRAMEWORKS` / `ComplianceFramework` from
  `@crossengin/access-reviews` (the only enum covering all six targets: `soc2_type2`, `iso27001`,
  `hipaa_security_rule`, `pci_dss_v4`, `gdpr_article_32`, `cfr_21_part_11`, `custom`) rather than minting
  a fifth incompatible framework vocabulary.
- **`controls.ts` — the modeled-control catalog.** `DEFAULT_CONTROL_CATALOG` is four platform controls
  (`access.periodic_review`, `data.encryption_at_rest`, `audit.tamper_evident_log`,
  `resilience.dr_readiness`) across four domains; each carries a `requiredEvidence` source kind and a
  `frameworkRefs` map to the *external* control references it satisfies per framework (e.g. encryption →
  SOC 2 CC6.7, HIPAA 164.312(a)(2)(iv), PCI 3.5.1). `controlsForFramework` scopes the catalog to a
  framework — a control not mapped to that framework is out of scope, not a gap.
- **`evidence.ts` — structural adapters.** A normalized `ControlEvidence`
  (`{controlId, sourceKind, satisfied, summary, findings, observedAt, detailRef}`) plus four pure
  adapters that convert each source report into it — `evidenceFromEncryptionCoverage`,
  `evidenceFromDrReadiness`, `evidenceFromForensicChain`, `evidenceFromAccessReviewEvidence`. The
  adapters take **structural** input shapes (`EncryptionCoverageLike`, `DrReadinessLike`,
  `ForensicChainLike`, `AccessReviewEvidenceLike`) that the real reports from `kernel-pg` / `dr-runtime` /
  `forensics` / `access-reviews` satisfy without a direct dependency — so the runtime stays pure and
  decoupled from those (impure or heavy) producers.
- **`assessment.ts` — verdicts.** `assessControl` maps a control + its matching evidence to
  `satisfied | deficient | not_assessed` (no evidence → `not_assessed`; any failing evidence →
  `deficient`, surfacing findings). `assessFramework` scopes to the framework's controls and computes
  `certifiable = every in-scope control satisfied` (a `deficient` *or* a `not_assessed` control fails it —
  missing evidence is not a pass).
- **`report.ts` — sealed report + engine.** `buildCertificationReport` produces a `cert_`-id'd,
  schema-valid `CertificationReport` and seals it with a deterministic sha256
  (`certificationReportSealSha256`, over canonical sorted-key JSON with a domain tag);
  `verifyCertificationReportSeal` re-derives it to detect tampering; `formatCertificationReport` renders
  a PASS/FAIL/MISS control ledger. `CertificationEngine` holds a catalog + injectable clock/ids +
  tenant, exposing `certify(framework, evidence)` / `certifyAll(frameworks, evidence)`.

## Consequences

- The platform can now answer "is this tenant SOC 2 / HIPAA certifiable today, and which controls are
  deficient?" as one sealed report, derived from the same evidence sources the runtime already produces —
  closing the loop from *modeling* controls to *asserting* them.
- Pure + structural: `certification-runtime` depends only on `access-reviews` (framework enum), `crypto`
  (seal), and `zod`. It ingests reports; it does not open sockets. A future `certification-runtime-pg`
  sibling + `operate-server` serve-level wiring would pull the four evidence sources from live infra
  (encryption coverage over the live catalog, DR readiness, sealed access-review evidence, chain
  verification) and persist the reports — the same pure-runtime → -pg → serve pattern used throughout.
- The catalog is data — a deployment can extend `DEFAULT_CONTROL_CATALOG` (new controls, new framework
  refs) or pass its own; `certifiable` is fail-closed (missing evidence is a MISS, not a silent pass).
- +41 tests (clock/ids; catalog validity + framework scoping; four evidence adapters, pass + fail; per-
  control + per-framework assessment; sealed report build + tamper detection + determinism + format +
  engine). Full build + typecheck + workspace tests green. No META tables, one new package.
- Follow-ups (open): the `-pg` sibling + serve-level wiring against live infra; a crosswalk to
  `security`'s `CertificationStandard` roadmap enum; per-control evidence *history* (trend over
  audit periods) rather than a point-in-time snapshot; richer control refs (the framework-ref lists are a
  representative subset, not the exhaustive control set).
