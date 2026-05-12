# ADR-0023: Testing Strategy

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-11 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0003, ADR-0004, ADR-0005, ADR-0008, ADR-0012, ADR-0017, ADR-0020 |

## Context

CrossEngin's testing requirements differ from typical SaaS products because of three traits:

- **Manifest-driven runtime.** A tenant's manifest can declare arbitrary entities, workflows, permissions. We cannot enumerate all possible runtime states by hand; we must test the *generators* (the kernel + AI Architect) such that any manifest they produce is correct.
- **Compliance bound.** Regulated workloads accept zero pre-shipped bugs in audit, signature, retention, and access-control paths. Test coverage on these paths must be high and explicit.
- **AI-Architect-mediated.** The AI Architect is the primary editor. Its output (manifest patches) must be evaluated against a curated suite that grows over time.

A solo / duo team cannot maintain massive hand-written test suites. The strategy must:

- **Lean on property tests** where invariants are clear (manifest validation; access-control decisions).
- **Use snapshot tests** for compiled artifacts (DDL output, Inngest function code, Rego policies).
- **Run integration tests against real services** in CI (test Supabase + test Inngest + test Typesense + test ClickHouse + test BGE).
- **Run an AI Architect eval suite** that gates model + prompt changes.
- **Use Playwright for end-to-end coverage** on critical user journeys.
- **Make tests fast.** A CI loop > 10 min throttles velocity.
- **Cover the compliance packs as first-class subjects** — every pack ships its own test suite.

This ADR formalizes the test stack, test pyramid, coverage targets, CI gates, and per-subsystem testing patterns.

## Decision

CrossEngin uses a tiered test pyramid:

```
┌──────────────────────────────────────────────────────────────┐
│           Manual exploratory + UAT (low volume)              │
├──────────────────────────────────────────────────────────────┤
│           E2E Playwright (10s of tests, critical paths)      │
├──────────────────────────────────────────────────────────────┤
│           Integration (100s of tests, per-subsystem)         │
├──────────────────────────────────────────────────────────────┤
│           AI Architect eval suite (curated; growth target)   │
├──────────────────────────────────────────────────────────────┤
│           Property + snapshot tests (1000s of cases)         │
├──────────────────────────────────────────────────────────────┤
│           Unit tests (10,000s of cases)                       │
└──────────────────────────────────────────────────────────────┘
```

### Test stack

| Layer | Tool |
|---|---|
| Unit | **Vitest** (TypeScript-native; fast cold start) |
| Property-based | **fast-check** integrated with Vitest |
| Snapshot | Vitest's built-in `expect().toMatchSnapshot()` |
| HTTP mocking | **MSW** (Mock Service Worker) for unit / integration |
| Integration | Vitest + real services (Docker compose / GHA service containers) |
| E2E | **Playwright** |
| Eval (AI Architect) | Custom runner in `tools/architect-eval` (per ADR-0005) |
| Visual regression | **Storybook + Chromatic** (Phase 4+ when renderer is stable) |
| Performance | **Lighthouse CI** (frontend); custom load tests with **k6** |
| Accessibility | **axe-core** integrated with Playwright |
| Security | **gitleaks**, **pnpm audit**, **Socket.dev**, **OWASP ZAP** (Phase 5+) |

### Unit tests

Cover individual functions and pure logic:

- **Kernel:** manifest validator, DDL generator, Rego policy evaluator, manifest resolver, permission decision computation.
- **Renderers:** field-widget logic, form-validation derivation, theme overlay resolution.
- **AI Architect:** tool dispatcher, loop runner state transitions, diff explainer.
- **Auth:** role inheritance resolution, ABAC policy evaluation.
- **Compliance packs:** pack-loader + pack-rule validation.
- **Integration mesh:** adapter normalization, retry logic, circuit breakers.

Coverage target: **80%** statement coverage on `packages/`. Excludes generated code and trivial getters/setters. CI fails if coverage drops more than 1% on a PR.

### Property tests

Where invariants are clearer than examples:

- **Manifest spec:** generate random manifests; the parser must either accept (and validate) or reject (with clear error). No crashes.
- **DDL generator:** for any valid manifest, the emitted DDL must be valid Postgres SQL parseable by `pg-parser` and idempotent.
- **Permission decisions:** for any (role, abac-predicate, entity-state), the decision must agree between the kernel's TS evaluator and a Rego ground-truth reference.
- **Audit log integrity:** every kernel mutation must emit exactly one audit row; replay of audit log must reconstruct entity history.
- **Workflow state machines:** every state must be reachable from the initial state (unless explicitly marked terminal-only); no transition can leave a terminal state.
- **CDC pipeline:** any sequence of Postgres writes, replayed through the shipper, must produce equivalent ClickHouse rows (eventually consistent).

Property tests use `fast-check` arbitraries that model the manifest spec. Failure cases shrunk to minimal reproducers stored in `__snapshots__/`.

### Snapshot tests

For deterministic compiled output:

- **Compiled DDL:** representative manifests → expected SQL.
- **Compiled Inngest functions:** workflow definitions → expected TypeScript output.
- **OpenAPI specs:** generated from manifest entity definitions.
- **Form schemas:** generated Zod schemas from entity fields.
- **Diff explainer output:** structured diffs → English bullets (the deterministic explainer per ADR-0005).

Snapshot diffs in PRs are reviewed manually; intentional changes update snapshots, accidental changes fail review.

### Integration tests

Per-subsystem, against real services:

- **Kernel ↔ Postgres:** ephemeral Supabase branch + run manifest apply + verify schema + run queries with RLS.
- **Auth + Rego:** real opa-wasm evaluator over canned manifests + canned sessions.
- **AI Architect ↔ Fireworks:** recorded fixtures (`__fixtures__/`) for deterministic replay; nightly live tests against real Fireworks (with budget cap).
- **Integration mesh ↔ external APIs:** test endpoints + recorded fixtures; some adapters have provider sandboxes (Stripe test mode, HL7 test loops).
- **Workflow runtime:** Inngest local dev runtime executes workflows; assertions on state transitions + audit emissions.
- **CDC pipeline:** Postgres + ClickHouse instances in Docker; verify shipper lag and correctness.
- **File pipeline:** Minio (S3-compatible) + Tesseract container; verify upload → scan → OCR → embed.
- **Search:** test Postgres + test Typesense + sample data; verify permission filtering + relevance.

CI uses GitHub Actions service containers for Postgres + Typesense + Minio + ClickHouse. Inngest runs in dev mode.

### AI Architect eval suite

Per ADR-0005:

- **Hand-crafted conversations:** ~50 at Phase 5; target 200+ by Year 2.
- **Replayed real conversations:** with user consent; 500+ target by Year 2.
- **Property checks:** generated manifests must validate, must pass kernel apply on a sandbox tenant, must render correctly.
- **Regression gate:** > 5% degradation on the eval suite blocks deploys.

Eval runs nightly on `main` + on every PR that touches `packages/ai-architect/` or `packages/ai-providers/`.

### Compliance pack tests

Per ADR-0012, every pack has:

- **Valid-manifest tests:** representative manifests that should accept; pack adds expected fields/traits/permissions.
- **Invalid-manifest tests:** manifests that violate the pack's rules; pack must reject with citation-annotated error.
- **Cross-pack composition tests:** pack-combination edge cases.

CI runs all pack tests on every PR. Failures block merge.

### E2E tests (Playwright)

Critical user journeys:

- **Tenant signup → first AI Architect conversation → first manifest apply → first entity created.**
- **Pharmacy: pharmacist signs in → views inbox → verifies prescription with e-signature → dispenses → patient gets notification.**
- **Manager dashboard view: KPIs render correctly with permission scoping.**
- **File upload → virus scan → OCR → search finds content.**
- **Workflow: orchestration completes end-to-end across sleep + retry.**
- **Tenant deletion (30-day soft → hard delete).**
- **Region migration: tenant changes residency profile; data moves.**
- **Permission edge cases: a user with limited role attempts an operation; UI shows correct restrictions.**

E2E run on staging post-deploy; failures alert and rollback.

### Performance tests

- **Lighthouse CI:** on every PR; budget gates for frontend (FCP, TTI, CLS, JS bundle size).
- **k6 load tests:** weekly on staging; scenarios for typical tenant load (100 RPS sustained), spike (1000 RPS for 1 min), AI Architect concurrent sessions.
- **Per-renderer perf:** automated render-budget checks for representative views (list of 1000 rows, dashboard with 8 widgets, form with 50 fields).

Performance regressions > 20% on any budget block PRs.

### Accessibility tests

- **axe-core via Playwright:** runs on every E2E test path. WCAG 2.1 AA violations fail.
- **Manual screen-reader testing:** pre-Phase 5 launch (VoiceOver + NVDA on representative pages).
- **Per-renderer a11y tests:** Storybook + axe-storybook on every renderer variant.

### Security tests

- **`gitleaks`** pre-commit hook + CI step.
- **`pnpm audit`** in CI; blocks Critical/High advisories.
- **Socket.dev** on every `package.json` change.
- **OWASP ZAP** (Phase 5+): automated security scanning of the staging environment.
- **Pen-test** annually starting Phase 5 (per ADR-0009).
- **AI Architect red-team:** prompt-injection, jailbreak, exfiltration attempts; annual.

### Test data and fixtures

- **Synthetic data generators:** per-vertical (pharmacy, hospital, procurement) data generators in `packages/testing/fixtures/`. Generate realistic but PHI-free data for tests.
- **Tenant fixtures:** representative manifests in `packages/testing/manifests/` covering each family.
- **Compliance pack fixtures:** representative compliant + non-compliant manifests per pack.
- **AI Architect conversation fixtures:** the eval suite (per ADR-0005).
- **Integration fixtures:** recorded HTTP + HL7 + EDI samples.

No production data ever ends up in test data. CI scanners verify.

### CI test execution

GitHub Actions parallelized jobs:

- **install** (1 min) → **typecheck + lint** (2 min in parallel) → **unit + property + snapshot** (3 min) → **integration** (5 min) → **e2e-smoke** (4 min) → **eval** (conditional; 10 min when run).

Total: ~10 min for a typical PR; up to 20 min for AI Architect changes.

Fast PRs (typo fix): turbo `--filter=...affected` cuts unchanged-package tests; ~3 min.

### Test ownership

Per CrossEngin convention:

- **Package authors write tests for their package.**
- **Cross-package contract tests** in `packages/testing/contracts/`.
- **Compliance pack tests** authored by pack authors (CrossEngin compliance officer + engineering).
- **Eval-suite curation** owned by AI Architect team (Year 2+: dedicated AI engineer; until then: founder).

### Test-failure triage

- **Flaky test policy:** any test failing > 5% across recent runs is quarantined (`.skip()`) within 24 hours, with a tracking issue. No flaky test in CI.
- **CI failure broadcast:** Slack + email; founder sees within minutes.
- **Post-mortems** for production incidents caused by tests that should have caught them.

### Test coverage exclusions

Acceptable to exclude from coverage:

- Generated code (Inngest function output, OpenAPI specs).
- Type-only files.
- Trivial property getters.
- Logging-only branches.
- Vendor-supplied integrations (Fireworks SDK calls covered by integration tests, not units).

Coverage tool: **Istanbul / V8 coverage** via Vitest.

## Alternatives considered

### Option A — Jest instead of Vitest

- **Pros:** Most-used in the TypeScript ecosystem.
- **Cons:** Slow cold start; CommonJS / ESM tension; slower than Vitest at our scale.
- **Why not:** Vitest is the modern fit.

### Option B — Cypress instead of Playwright

- **Pros:** Mature; popular.
- **Cons:** Slower; uses browser-iframe model; weaker on cross-browser; weaker on accessibility integration.
- **Why not:** Playwright is the modern choice in 2026.

### Option C — Manual QA pass-through (no automated E2E)

- **Pros:** No automation cost.
- **Cons:** Doesn't scale. Regressions slip in.
- **Why not:** Automated E2E pays for itself within months.

### Option D — Test in production (no staging environment)

- **Pros:** Cheaper.
- **Cons:** Tenants see bugs first. Compliance-incompatible.
- **Why not:** Staging is non-negotiable for regulated workloads.

### Option E — TDD as mandatory practice

- **Pros:** Test-first culture.
- **Cons:** Solo / duo team; TDD discipline can be a productivity drag in early product exploration phase. Adopt rigorously once core stabilizes.
- **Why not:** Encouraged where appropriate; not mandatory.

### Option F — Skip AI Architect eval suite v1

- **Pros:** Cheaper to ship.
- **Cons:** Model swaps + prompt changes regress without warning. Tenants notice.
- **Why not:** Eval suite is the only way to defend AI Architect quality across model changes.

## Consequences

### Positive

- **Property tests catch entire classes of bugs** at low maintenance cost. A property-test-discovered manifest bug is fixed once and prevented for all future random inputs.
- **Eval suite makes model swaps safe.** We can experiment with Fireworks → Anthropic → self-hosted without losing AI Architect quality.
- **Compliance pack tests are first-class.** Auditors can see pack tests run as part of every CI pipeline.
- **CI is fast enough** to not throttle the team (under 10 min typical).
- **Coverage target is realistic.** 80% with property + snapshot tests is more meaningful than 95% with trivial unit tests.

### Negative

- **Integration tests' real-service dependency** introduces CI flakiness from third-party services. Mitigation: recorded fixtures for deterministic replay; live tests nightly with retries.
- **AI Architect eval suite is expensive** in token cost (real Fireworks calls). Mitigation: budget cap per CI run; recorded fixtures for most cases.
- **E2E maintenance cost.** Playwright tests break on UI changes. Mitigation: page-object pattern + careful selectors; renderer-driven UI is more stable than ad-hoc JSX.
- **Test data generation work** is real. Mitigation: build generators incrementally as new entity types ship.

### Neutral

- **Vitest + Playwright + fast-check** is mainstream TypeScript test stack.
- **Storybook + Chromatic** (visual regression) deferred to Phase 4+ when renderer stable.

### Reversibility

**Low cost** to swap individual tools (Vitest for Jest, Playwright for Cypress). Standardized APIs.

**Moderate cost** to evolve the eval-suite shape (per ADR-0005).

**High cost** to remove tests after tenants depend on the stability they enforce.

## Implementation notes

- **Package locations:**
  - `packages/testing` — shared test utilities, fixtures, generators.
  - `packages/testing/contracts` — cross-package contract tests.
  - `tools/architect-eval` — AI Architect eval runner.
- **Test naming:** `*.test.ts` for unit; `*.integration.test.ts`; `*.e2e.spec.ts` for Playwright.
- **Test parallelism:** Vitest pools workers automatically; Playwright shards across CI machines.
- **Service containers in CI:** GHA service containers for Postgres / Typesense / ClickHouse / Minio / Inngest dev mode.
- **AI Architect recorded fixtures:** stored in `packages/ai-providers/__fixtures__/`; one folder per (provider, model, prompt-version) tuple.
- **Coverage reporting:** Codecov or simple Vitest coverage report posted as a PR comment.
- **Flaky-test detection:** weekly report of flake rate per test; auto-quarantine on > 5%.
- **Storybook stories** for every renderer variant; Chromatic visual diffs (Phase 4+).
- **Compliance pack test runner:** `tools/pack-test` runs each pack's tests in isolation + composition mode.
- **Per-PR fixture isolation:** integration tests use unique tenant IDs per test; cleanup at teardown.
- **CI test artifacts:** Playwright traces + screenshots uploaded on failure for triage.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Visual regression cadence — Storybook + Chromatic when renderer stable. Cost vs. value. | _pending design hire_ | Phase 4 |
| Pen-test vendor selection (cross-link ADR-0009 open question). | amoufaq5 | Phase 5 |
| Eval suite size — 50 → 200 hand-crafted; how do we scale curation? | amoufaq5 | Phase 4 → Year 2 |
| Performance regression sensitivity — 20% block threshold; tune based on signal-to-noise after launch. | amoufaq5 | Phase 5 |
| Production traffic replay — record (anonymized) production requests + replay against staging for regression detection. Privacy-bound. | amoufaq5 + _pending compliance hire_ | Year 2 |
| Mutation testing — adopt Stryker or similar? High signal but slow. | amoufaq5 | Year 2 |
| Test-data PHI scanner — automatic flagging of real-looking data in test files. | _pending compliance hire_ | Phase 5 |
| Per-tenant production smoke tests — synthetic checks running against real tenants on a low cadence to detect tenant-specific breakage. | amoufaq5 | Year 2 |

## References

- ADR-0003 (Meta-schema and dynamic entity engine) — defines manifest spec under property test.
- ADR-0004 (Manifest specification) — defines manifest validators under property + integration test.
- ADR-0005 (AI Architect contract) — defines eval suite.
- ADR-0008 (RBAC v2, ABAC, audit) — defines permission decisions under property test.
- ADR-0012 (Compliance pack architecture) — defines pack tests.
- ADR-0017 (Observability and SLOs) — defines performance budgets.
- ADR-0020 (Build, packaging, and deployment) — defines CI pipeline.
- Vitest documentation; Playwright documentation; fast-check; axe-core.
