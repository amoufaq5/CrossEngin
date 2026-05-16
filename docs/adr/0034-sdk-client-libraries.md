# ADR-0034: SDK client libraries

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-15 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0017, ADR-0024, ADR-0026, ADR-0027 |

## Context

ADR-0027 defined the **public API contract** — operations, scopes, versioning, errors, pagination, idempotency, webhooks. That ADR describes what calls a partner can make. This ADR describes **how partners actually make those calls** — the language-specific client libraries we generate, version, distribute, and support.

Three concrete needs drive this:

1. **First-class language support.** TypeScript, Python, and Go are the languages our buyers and integration partners actually write in. They need idiomatic clients (camelCase in TS, snake_case in Python, sync APIs in Go).
2. **Generated, not hand-written.** The API surface is large enough that hand-maintaining six language clients in parallel would produce drift. Code-gen from an OpenAPI spec keeps them aligned.
3. **Industrial release discipline.** Clients ship to npm, PyPI, Go modules. They have versions independent of API versions. Security advisories happen. Critical CVEs require yanking. Old clients keep working against new APIs (compatibility matrix). Customer engineering teams need usage telemetry to plan upgrades.

A fourth concern: **client-side observability**. The platform's SLOs (ADR-0017) measure server-side latency. Client-perceived latency includes network, retries, serialization. Clients should record per-request telemetry that maps to W3C trace context so partner traces can correlate with platform traces.

This ADR establishes the contract types for the client-library production pipeline. It does **not** include the actual code-gen runtime, OpenAPI generator config, or registry-publishing CLI — those are Phase 2 build artifacts that consume these contract types.

## Decision

SDK clients contract has **six modules** in `@crossengin/sdk-clients`:

1. **`languages.ts`.** Ten target languages (TS, Python, Go, Java, C#, Ruby, Rust, PHP, Swift, Kotlin) × 10 registry kinds × 3 tiers (first_class / community / experimental). `LANGUAGE_REGISTRY` pins each language to its canonical registry; `LANGUAGE_TIER` classifies support level. `PackageCoordinatesSchema` enforces language↔registry consistency, scoped names for TypeScript, slash-paths for Go, `groupId:artifactId` for Java/Kotlin, `moduleName` for Python (distinct from package name).

2. **`generation.ts`.** Six generator tools (openapi_generator, swagger_codegen, stainless, fern, custom_template, manual) × 4 spec formats × 8 lifecycle statuses (queued → fetching_spec → generating → linting → testing → packaging → succeeded / failed). `GeneratorConfig` enforces language↔naming-convention consistency (camelCase in TS, snake_case in Python, PascalCase in Go); Go must `generateSyncMethods=true`; custom_template requires path; manual cannot generate methods. `GenerationRun` enforces succeeded needs output sha256 + storage URI + zero failed tests + zero lint errors. `defaultConfigFor(language)` produces a baseline.

3. **`releases.ts`.** Four channels (stable, beta, rc, nightly) × 5 statuses (draft / in_review / published / deprecated / yanked) with state machine. `ClientRelease` enforces semver discipline (stable channel requires plain semver, beta requires pre-release suffix); critical security advisories force yanked/deprecated; breaking changes on 0.x cannot ship to stable. `SecurityAdvisory` requires CVE or GHSA id, severity, fixedInVersion. Helpers: `isInstallable`, `hasCriticalAdvisory`, `highestSeverityAdvisory`.

4. **`compatibility.ts`.** Five-level compatibility matrix (fully_compatible / compatible_with_warnings / deprecated_supported / unsupported / blocked) keyed by (language, clientVersion, apiVersion). `resolveCompatibility()` returns a verdict + reason; `clientsAffectedByApiVersion()` finds clients needing upgrade before an API version sunset. Enforces compatible_with_warnings needs warnings ≥ 1; unsupported/blocked need notes.

5. **`auth-helpers.ts`.** Six auth methods (api_key_header, api_key_bearer, oauth2_client_credentials, oauth2_authorization_code_pkce, oauth2_refresh_token, mtls_client_cert) × 4 token storage kinds × 4 retry strategies. `AuthHelperConfig` enforces security baselines: requireHttps must be true; redactCredentialsInLogs must be true; OAuth refresh tokens cannot use in-memory storage. `RetryPolicy` forbids retrying 2xx + most 4xx (only 408 + 429 retryable); requires idempotency-key on non-idempotent retries. `nextDelayMs()` implements exponential / linear / fixed / no-retry backoff.

6. **`telemetry.ts`.** Seven request outcomes (success / client_error / server_error / timeout / network_error / auth_failure / cancelled) × 8 breadcrumb kinds. `ClientRequestRecord` enforces latency = completedAt − startedAt within 5ms tolerance, attemptNumber ≤ totalAttempts, outcome ↔ status consistency (success needs 2xx, client_error needs 4xx, etc.), traceId ⇔ spanId (W3C trace context pairing), errorCode required for error outcomes. Sensitive headers (authorization, x-api-key, cookie, password, secret, token) are detected and redacted by `redactSensitiveAttributes()`. `aggregateUsage()` produces success rate + p50/p99 + retry count.

Two meta-schema tables: `META_SDK_CLIENT_RELEASES` (platform-wide audit of every published version) and `META_SDK_CLIENT_INSTALLATIONS` (RLS tenant-scoped — tracks which client versions each tenant is actively using, with upgrade-nag status for outreach campaigns).

## Alternatives considered

- **Option A:** Hand-write a single TypeScript client, publish bindings to other languages later.
  - **Pros:** Lowest initial investment.
  - **Cons:** Python and Go customers won't wait. Drift between languages becomes inevitable as TS evolves.
  - **Why not:** First-class support for Python and Go is a buyer requirement, not optional.

- **Option B:** Ship a single neutral OpenAPI spec; let customers run their own code-gen.
  - **Pros:** No client library to maintain.
  - **Cons:** Quality of generic code-gen output is poor; idiomatic conventions are missed; we lose control over auth/retry defaults and security baselines.
  - **Why not:** We need to ship clients that match each language's conventions and bake in our security defaults.

- **Option C:** Stainless or Fern as the sole code-gen path.
  - **Pros:** Mature, opinionated.
  - **Cons:** Vendor lock-in; their templates may not match our conventions; pricing concerns at scale.
  - **Why not:** Keep optionality. `GENERATOR_TOOLS` enumerates the choices (openapi_generator is baseline, stainless / fern are alternatives, custom_template is escape hatch). Per-language tool choice is in `GeneratorConfig`.

- **Option D:** No compatibility matrix; rely on semver.
  - **Pros:** Less metadata to maintain.
  - **Cons:** Semver doesn't capture "client 1.0 calls API v2 fine but warns about deprecated field X". Buyers planning upgrades need explicit guidance.
  - **Why not:** Explicit matrix is the source of truth; semver is what the registry sees.

- **Option E:** No client-side telemetry.
  - **Pros:** Privacy-friendly default; smaller client.
  - **Cons:** Can't measure customer-experienced latency; can't drive upgrade-nag campaigns without knowing who's on what version.
  - **Why not:** Telemetry is opt-out, redacts sensitive headers, and is necessary for serviceability. Privacy controls live in the auth-helper config (redactCredentialsInLogs hard-required true).

## Consequences

- **Positive.** Partner integrators get idiomatic clients in three languages. Code-gen pipeline catches API regressions before they ship. Compatibility matrix gives explicit upgrade guidance. Security advisories have a defined lifecycle. Client-side telemetry feeds back to platform observability.
- **Negative.** Three language clients × stable + beta channels × CI/CD pipelines is non-trivial operations cost. Compatibility matrix needs maintenance per API change. OpenAPI spec quality becomes critical (input to all clients).
- **Neutral.** Java, C#, Ruby exist as `community` tier — we publish but don't promise the same response-time SLAs. Rust, PHP, Swift, Kotlin are `experimental` — community-maintained, no platform support.
- **Reversibility.** Adding languages is additive. Removing a published language is a sunset process (deprecate → freeze → eventual blocked compatibility entry). Hard to undo once partners adopt.

## Implementation notes

- **First-class scope.** Only TS / Python / Go get CI matrices, eval suites, security-advisory monitoring, and platform-team support. Other languages are best-effort.
- **Naming overrides.** `GeneratorConfig.namingConvention` accepts non-canonical conventions but the schema raises a soft warning ("override only with strong reason"). This keeps the door open for projects with established conventions (e.g., a Python codebase that already snake_case-ed everything from the JSON layer up).
- **Channel discipline.** `stable` channel requires plain semver (no `-rc`, no `+build`). `beta` requires pre-release suffix. `rc` accepts `-rc.N`. `nightly` accepts anything. The schema enforces this so a CI accident can't ship `1.0.0-rc.5` to stable.
- **Critical-advisory lockout.** A release carrying a `severity='critical'` security advisory must be `yanked` or `deprecated`. Cannot remain `published`. The schema enforces this — a buggy automation can't accidentally leave a critical CVE installable.
- **Telemetry sample rate.** Not in this schema. Sample rate is a runtime decision; the records that do flow follow this contract. Default is suggested at 1% for normal traffic, 100% for errors.
- **W3C trace context.** `traceId` (32 hex) and `spanId` (16 hex) match the standard. Both present or both absent; partial trace context is rejected.
- **Upgrade nag.** `META_SDK_CLIENT_INSTALLATIONS.upgrade_nag_status` has four levels (none / soft_warning / hard_warning / forced_upgrade_required). Driven by compatibility matrix + days-since-last-release thresholds (operations policy, not in this schema).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| OpenAPI spec generation from `@crossengin/sdk` operations catalog — manual export or automated CI | _pending_ | Phase 2 |
| Stainless vs OpenAPI Generator for first-class languages — pilot evaluation | _pending_ | Phase 2 |
| Bundle size budgets per language client | _pending_ | Phase 2 |
| Per-tenant telemetry export — privacy-friendly aggregation or per-request raw | _pending_ | Phase 3 |
| Mobile SDK story (Swift, Kotlin) — promote from experimental to community tier | _pending_ | Phase 3 |
| GraphQL client wrappers — Phase 4+ if/when GraphQL endpoint lands | _pending_ | Phase 4 |

## References

- ADR-0027 (developer SDK) — the API contract this implements client-side.
- ADR-0017 (observability and SLOs) — client telemetry feeds platform observability.
- ADR-0026 (marketplace) — pack authors are major consumers of these clients.
- RFC 9110 (HTTP semantics), RFC 9457 (problem details), RFC 8594 (Sunset header) — shared with ADR-0027.
- W3C Trace Context (https://www.w3.org/TR/trace-context/) for traceId/spanId formats.
- `packages/sdk-clients/src/` for the zod schemas and helpers.
