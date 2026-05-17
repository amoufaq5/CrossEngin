# ADR-0038: SSO and federated identity

| Field | Value |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-05-16 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0004 (auth), ADR-0007 (compliance packs), ADR-0008 (audit), ADR-0036 (tenant lifecycle), ADR-0037 (incident response) |

## Context

ADR-0004 defined `@crossengin/auth` — RBAC, ABAC, field-level permissions, role definitions, principals. That covers **what an authenticated user is allowed to do**. It does **not** cover **how the user authenticates**. In CrossEngin's enterprise buyer profile, the answer is rarely "with a password we store" — it is "through their existing identity provider."

The buyers we target (regulated healthcare, public sector, large retail/F&B, large construction, financial services) all run their own IdP — Okta, Auth0, Azure AD, Google Workspace, JumpCloud, OneLogin, PingFederate, ADFS, Keycloak — and require federation as a hard gate. Many also expect **SCIM 2.0** for automated provisioning: when HR fires someone in Workday, that person must lose CrossEngin access without a human in the loop.

The shape of this need is well-known but the threats are subtle: outdated signature algorithms (rsa-sha1, HS256), missing PKCE on public OIDC clients, weak NameID formats, replay windows that don't validate `notBefore`/`notOnOrAfter`, MFA bypass via session reuse, JIT-created users with no tenant scoping or default-deny, and unauthenticated SCIM endpoints. We want these guardrails enforced at the contract layer so no runtime implementation can drop them.

This ADR establishes the contract types for SSO + SCIM + federated session management. It does **not** include the actual SAML XML parser, OIDC token verifier, SCIM HTTP server, or JWKS fetcher — those are Phase 2 build artifacts that consume these contract types.

## Decision

SSO contract has **seven modules** in `@crossengin/sso`:

1. **`providers.ts`.** Two protocols (SAML, OIDC) × 10 IdP vendors (Okta, Auth0, Azure AD, Google Workspace, JumpCloud, OneLogin, PingFederate, ADFS, Keycloak, custom) × 5 lifecycle statuses (draft → testing → active → suspended → archived) with `PROVIDER_TRANSITIONS` state machine. `SsoProviderSchema` discriminated by protocol — `SamlProviderConfig` requires entity IDs, ACS URL, certificate fingerprint, signature/digest algorithms, allowed NameID formats, audience URI, clock skew tolerance; `OidcProviderConfig` requires issuer, all four endpoints, client ID + secret fingerprint (or public-client flag), scopes, response/grant types, PKCE method, redirect URIs, ID-token sign algorithm. Cross-cutting refinements: public OIDC clients must use PKCE S256; confidential OIDC clients must declare clientSecretSha256; active providers must be enabled. Helper `requiresMandatoryRetest()` flags providers stale > 90 days.

2. **`saml.ts`.** Six SAML 2.0 NameID formats, 3 bindings (POST, Redirect, Artifact), 4 signature algorithms (rsa-sha1, rsa-sha256, rsa-sha512, ecdsa-sha256), 3 digest algorithms (sha1, sha256, sha512), 8 AuthnContext classes. `WEAK_SIGNATURE_ALGORITHMS` and `WEAK_DIGEST_ALGORITHMS` flag sha1-family. `SamlSpMetadataSchema`, `SamlAuthnRequestSchema`, `SamlAssertionSchema` model the SP-side state. Assertions enforce `notOnOrAfter > notBefore` and audience presence. Helpers: `isAssertionTimeValid()` (with clock-skew), `isAudienceAccepted()`, `isAllowedNameIdFormat()`, `requiresStrongAuthnContext()` (MultiFactor, TimeSyncToken, MobileTwoFactorContract).

3. **`oidc.ts`.** Five response types, 5 grant types (including device_code and token_exchange), 5 token-endpoint auth methods (including `none` for public clients), 2 PKCE methods (S256 required, plain forbidden), 8 ID-token signing algorithms (HS256 flagged as weak/symmetric). `OidcDiscoveryDocSchema` mirrors RFC 8414. `OidcAuthorizeRequestSchema` enforces: nonce required when response_type includes id_token or code; codeChallenge requires codeChallengeMethod; plain PKCE forbidden. `validateIdTokenClaims()` returns a structured outcome — `issuer_mismatch`, `audience_mismatch`, `id_token_expired`, `id_token_iat_in_future`, `id_token_not_yet_valid`, `nonce_mismatch`, `auth_age_exceeded`. `isPublicClient()`, `isValidRedirectUri()` (exact match, no wildcards), `parseScopeString()`.

4. **`scim.ts`.** SCIM 2.0 surface — 5 resource types (User, Group, EnterpriseUser, Role, Entitlement), 7 operations, 3 patch ops, 10 filter operators (eq/ne/co/sw/ew/pr/gt/ge/lt/le), 10 outcomes (success/created/conflict/invalid_filter/invalid_path/invalid_value/not_found/forbidden/rate_limited/schema_violation), 7 core schemas. `ScimUserSchema` (RFC 7643 §4.1), `ScimGroupSchema` (RFC 7643 §4.2), `ScimPatchRequestSchema` (RFC 7644 §3.5.2), `ScimBulkRequestSchema` (RFC 7644 §3.7). Bulk requests capped at 1000 ops; POST ops require unique bulkIds; remove ops require path. `parseScimFilter()` parses single-clause filters; `normalizeUserName()`, `isValidPatchPath()`.

5. **`mapping.ts`.** Claim-to-attribute pipeline. 8 claim sources (saml_attribute, saml_nameid, oidc_id_token, oidc_userinfo, scim_user, scim_group, http_header, static_value) → 11 target fields (user.email, user.userName, user.fullName, user.givenName, user.familyName, user.locale, user.timezone, user.role, user.tenantMembership, user.department, user.title). 12 transform kinds (identity, lowercase, uppercase, trim, regex_extract, regex_replace, split_first, split_last, lookup_map, prefix_strip, suffix_strip, join). 4 JIT user policies (disabled, create_only_known_idp, create_with_group_lookup, update_existing_only). 3 group sync modes (replace_all, merge_add_only, ignore). `MappingSet` enforces: no duplicate mapping IDs, no duplicate target fields, JIT-enabled sets require a required mapping to `user.email`. `applyTransform()`/`applyTransforms()` execute deterministically. `decideJitOutcome()` returns one of `create_user / update_existing / no_op_existing / denied_unknown_user / denied_no_group_match / denied_email_domain` with reason — used by the SSO callback handler to gate user creation.

6. **`sessions.ts`.** Federated session lifecycle. 4 statuses (active → expired/revoked/logged_out, all terminal), 7 SLO kinds (sp_initiated, idp_initiated, idle_timeout, absolute_timeout, admin_revoke, policy_violation, mfa_step_up_failed), 4 bindings (cookie, jwt_bearer, opaque_token, ldap_kerberos). `SsoSessionSchema` enforces: expiresAt > startedAt; absoluteExpiresAt ≥ expiresAt (rolling expiry capped by absolute); active sessions cannot have terminatedAt/terminationKind set; non-active sessions require terminatedAt; non-expired termination requires terminationKind. Helpers: `isSessionActive()`, `shouldRefreshSession()`, `computeIdleTimeoutReached()`, `extendSession()` (caps at absoluteExpiresAt), `terminateSession()` (transition-validated), `isMfaStillFresh()` (TTL since `mfaSatisfiedAt`).

7. **`audit.ts`.** Login + SCIM provisioning audit records. 8 login outcomes (success, mfa_required, mfa_failed, password_expired, account_locked, idp_unreachable, attribute_invalid, denied_by_policy), 3 initiations (sp_initiated, idp_initiated, scim_invoked), 5 MFA factors (totp, webauthn, push_notification, sms, security_question), 6 failure categories (network, credential, mfa, policy, attribute, account). `FAILURE_BY_OUTCOME` maps outcome → category; `LoginRecordSchema` cross-validates outcome ↔ failureCategory ↔ principalId ↔ mfaFactor and enforces latencyMs = completedAt − initiatedAt within 1ms. `ScimProvisioningRecordSchema` enforces latency + requires errorMessage on failure outcomes. `aggregateLogins()` returns `LoginAggregateStats` with success rate, p50/p99 latency, failure breakdown. `isLoginBurstFailure()` detects credential-spray for the same federated subject.

Five meta-schema tables: `META_SSO_PROVIDERS` (nullable tenant_id for platform-wide providers with custom RLS policy `tenant_id IS NULL OR …`), `META_SSO_LOGINS`, `META_SSO_SESSIONS`, `META_SCIM_CLIENTS` (bearer-token sha256, allowed IP ranges, revocation audit), `META_SCIM_PROVISIONING` (per-call audit). All five FK back to `META_SSO_PROVIDERS` so deletes are blocked while history exists.

## Alternatives considered

- **Option A:** Only support OIDC and skip SAML.
  - **Pros:** Smaller surface; OIDC is more modern.
  - **Cons:** ~60% of enterprise IdPs in our buyer profile still front their primary federation with SAML (especially ADFS, PingFederate, Workday→SaaS integrations). Healthcare and public sector in particular skew SAML-heavy.
  - **Why not:** SAML is required to win enterprise deals.

- **Option B:** Build a single `IdentityProvider` shape with protocol-specific fields all optional.
  - **Pros:** Simpler type surface.
  - **Cons:** Loses static guarantees — an OIDC provider with a SAML certificate field is meaningless and creates noise. zod's discriminatedUnion catches "wrong fields for this protocol" at validation time.
  - **Why not:** The cross-protocol refinements (PKCE for public OIDC, signature algorithm checks for SAML) are clearer when scoped to a discriminated union.

- **Option C:** Skip SCIM and require manual user provisioning.
  - **Pros:** Smaller surface.
  - **Cons:** SCIM 2.0 is table-stakes for enterprise IT teams that use Okta/Azure-AD lifecycle workflows. The alternative is a CSV upload per termination, which violates compliance attestations around "timely deprovisioning."
  - **Why not:** SCIM is non-negotiable for SOC 2, ISO 27001, HIPAA shared-responsibility attestations.

- **Option D:** Force JIT user creation always on (no policy).
  - **Pros:** Simpler.
  - **Cons:** Some buyers explicitly forbid JIT — they want users pre-provisioned via SCIM only, and reject IdP-initiated logins from unknown subjects. `update_existing_only` is a real requirement.
  - **Why not:** JIT mode must be a per-provider policy, not a platform-wide assumption.

- **Option E:** Defer signature algorithm enforcement to runtime.
  - **Pros:** Keeps contracts minimal.
  - **Cons:** Provider misconfiguration (e.g., admin uploads an rsa-sha1 IdP metadata XML) becomes a runtime surprise that only fires when a user tries to log in. By exposing `WEAK_SIGNATURE_ALGORITHMS` + `allowWeakSignatures` opt-in flag, admin UIs can warn at config-save time.
  - **Why not:** Catching weak crypto at the contract layer prevents costly remediation later.

## Consequences

- **Forces protocol-correct configuration.** Misconfigured providers fail zod validation at save time, not at user-login time.
- **Standardizes JIT decision flow.** All federated user-creation paths run through `decideJitOutcome()` — there's no second path that can drift.
- **Anchors audit at the schema level.** Every login + every SCIM call is a typed record that flows into the meta-schema audit tables. Compliance attestations (ADR-0007) and forensics (ADR-0035) can both consume these tables.
- **Phase 2 surface is well-scoped.** The actual SAML XML signer/verifier, OIDC JWKS fetcher, JWT validator, and SCIM HTTP handler are downstream consumers of these contract types. No protocol detail leaks into other packages.
- **PHI/regulated workloads get a hard "no weak crypto" gate.** Combined with ADR-0007 compliance packs, regulated tenants can be required to set `allowWeakSignatures: false` via policy.

## Open questions

- **Q1:** Should we model **device-bound assertions** (FIDO2 device binding, hardware-attested TPM keys) at the contract layer?
  - _Current direction:_ Defer until a regulated buyer asks. Captured in `MFA_FACTORS` as `webauthn` for now; device-binding metadata would be an extension.
- **Q2:** SCIM groups vs RBAC roles — do we sync IdP groups into `@crossengin/auth` `RoleDefinition`s directly, or always through a `GroupSyncRule` indirection?
  - _Current direction:_ Always through `GroupSyncRule`. Direct sync couples our role taxonomy to the IdP's group taxonomy and creates churn.
- **Q3:** How do we handle **IdP-initiated SAML with no signed AuthnRequest from us**?
  - _Current direction:_ `LoginRecord.initiation` distinguishes; per-provider policy can require sp_initiated only. Default to allow both, leave the explicit deny for high-security tenants via compliance packs.
- **Q4:** Cross-tenant federation (one IdP, multiple CrossEngin tenants) — supported via platform-wide providers (`tenant_id IS NULL`)?
  - _Current direction:_ Yes; the RLS policy on `META_SSO_PROVIDERS` already allows tenant_id-null rows to be visible. Mapping rules can target `user.tenantMembership` to route subjects to the right tenant on JIT creation.

## References

- RFC 7522 — SAML 2.0 Profile for OAuth 2.0 Client Authentication
- RFC 7521 — Assertion Framework for OAuth 2.0
- RFC 6749 — The OAuth 2.0 Authorization Framework
- RFC 6750 — OAuth 2.0 Bearer Token Usage
- RFC 7636 — Proof Key for Code Exchange (PKCE)
- RFC 8414 — OAuth 2.0 Authorization Server Metadata
- RFC 7643 — SCIM Core Schema (User, Group, EnterpriseUser)
- RFC 7644 — SCIM Protocol (Patch, Bulk, Filters)
- OpenID Connect Core 1.0
- SAML 2.0 Core (OASIS) — Conditions, Subject, AuthnStatement
- NIST SP 800-63B — Authenticator Assurance Levels 2 and 3
- ADR-0004 (auth/RBAC), ADR-0007 (compliance packs), ADR-0008 (audit), ADR-0035 (forensics)
