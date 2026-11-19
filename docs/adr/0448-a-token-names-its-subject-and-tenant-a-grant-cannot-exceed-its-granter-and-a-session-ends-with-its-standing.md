# ADR-0448: A token names its subject and tenant, a grant cannot exceed its granter, and a session ends with its standing

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-19 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0386 (required JWT claims, `--jwt-optional-claim`), ADR-0369 (scopes read as roles; the foreign-scope widening it could only warn about), ADR-0381 (the membership revocation check, 30 s), ADR-0364 (the password routes, `sessionsRevoked`), ADR-0365 (the membership role fence), ADR-0358 (credential login, the pepper), ADR-0398 (scrypt parameter ceilings), ADR-0338 (refuse only when nothing correct breaks), ADR-0301 (no secrets on argv) |

## Context

The external due-diligence audit, verified against the tree at `f6faf05`, left five auth and session
findings open or partly fixed.

- **H-03, partly fixed.** ADR-0386 made `exp`, `iss` and `aud` required, but `sub` was not, so one
  identity could be shared, and a foreign token with no `tenant_id` let the `x-tenant-id` header pick
  the tenant. Reachable only with a `--jwks-*` flag, which the shipped compose does not pass.
- **H-04, partly fixed.** Platform authority is a bare role name with no tenant binding. Anyone able
  to grant memberships could grant `platform_admin`, and since ADR-0369 every scope of an IdP token
  is read as a role. ADR-0369 could only warn about the foreign-scope widening, recording that the
  resolver did not know which key verified the token.
- **H-07, partly fixed.** `meta.users.status` was not checked per request, a password change ended
  no session, logout cleared the cookie only, the minimum password length was 1, and there is no
  MFA or forgot-password. Measured: the self-service password route reported
  `sessionsRevoked: false`, and live, a suspended user's existing session answered 200 for up to
  30 s.
- **M-09, partly fixed.** The scrypt default was still `n = 2^15` with `p = 1`, the hash carried no
  pepper version, and the `credential_hash` CHECK was unbounded.
- **M-28, open.** The Stripe secrets could only be passed on argv, API keys had no entropy floor, and
  a malformed key spec echoed its token.

## Decision

**A foreign token must name its subject and its tenant.** `sub` and `tenant_id` join the required
claims, so a missing or empty one is 401 `required_claim_absent` before the header-chosen tenant can
apply. The relaxation is ADR-0386's own hatch, `--jwt-optional-claim sub|tenant_id`, so the
header-tenant behaviour now has to be declared. The tenant and subject a token was verified with
reach the resolver as `PrincipalResolverInput.bearer = {kid, claims}`.

**A grant cannot exceed its granter.** `platform-authority.ts` holds a total map over every
`ServeOptions` role-list field, so a new `--…-role` flag does not compile until someone says whether
it grants platform authority. A provision, a membership grant, or a membership transition to
`active` may name a platform-authority role only if the person doing it holds that role; otherwise
it is 403 `role_escalation`, recorded before any write. Revoking stays unrestricted.

**A platform role arrives only from the deployment's own key.** `withForeignPlatformRolesDropped`,
wired innermost in `server.ts`, drops platform roles from a token signed by any key other than the
deployment's login key. `--idp-platform-roles` allows them again, and the boot line states what is
enforced. ADR-0369's recorded blocker no longer holds, because the resolver now sees the `kid`.

**A session ends when its holder's standing changes.** `meta.users.session_epoch` and a `sep` claim
form a counter: setting a password, an operator reset, and the new `POST /v1/account/logout` each
advance it. `session-standing.ts` reads `meta.users.status` and the epoch on every request, cached
for 30 s and invalidated at once on the replica that performed the act, including a user or
membership status transition. The self-service password route reports `sessionsRevoked: true`.

**A password has a floor and a current hash.** The minimum length is 12 code points
(`--min-password-length`, at least 8, requires `--credential-login`), checked only when a password
is set, including by `set-credential`; stored hashes are unaffected. The scrypt default is
`{n: 32768, r: 8, p: 3}`. The hash carries its pepper version (`k<N>$`), with retired peppers from
`CREDENTIAL_PEPPER_RETIRED_<N>` and the current one chosen by `CREDENTIAL_PEPPER_VERSION`. A stale
hash is rehashed at login, conditionally on the old hash still being there, and the rehash ends no
session. The `credential_hash` CHECK is bounded, version tag included.

**A secret has an environment route, and a key has entropy.** `STRIPE_API_KEY` and
`STRIPE_WEBHOOK_SECRET` supply the Stripe secrets; if a flag and a variable are both set they must
be equal. An API-key token needs at least 128 estimated bits and 8 distinct characters, and the
published placeholder prefix is refused; a weak key refuses boot unless `--allow-weak-api-keys`. A
malformed key spec no longer echoes its token.

## Alternatives considered

- **A token denylist for sign-out.** Refused for a per-user counter, which needs no table and no
  sweep. The stated cost: signing out on one device signs out every device. The code and the boot
  line say so.
- **The audit's remedy for API-key strength, `refuseWeakSecret`.** Refused on measurement: it would
  refuse ordinary generated keys, since `openssl rand -hex 24` contains all 16 hex symbols only about
  45% of the time. The entropy estimate admits every documented generator (`openssl rand -hex 24` is
  192 bits; `randomBytes(32)` base64url about 280).
- **Keep warning about foreign platform roles** (ADR-0369's position). Refused: the warning rested on
  the resolver not knowing which key verified the token, which is no longer true.
- **Keep the Stripe cross-checks at argument parsing.** Refused: parsing cannot see the environment,
  so it refused every deployment that supplied the secret that way. They moved to boot, and the two
  `cli.test.ts` tests pinning the parse-time refusal are rewritten.
- **Refuse an unused Stripe secret wherever it comes from.** Refused by review under ADR-0338: before
  this change the binary did not read `STRIPE_*`, so a deployment carrying them for a sibling service
  booted. Those refusals now apply only to a flag (`SOURCE_IS_A_FLAG`); an environment-only unused
  secret is a warning naming the variable, never the value.
- **A precedence rule between a Stripe flag and its variable.** Refused: a deployment that set one
  and forgot the other would serve one silently. Both set must be equal.

## Consequences

- **Positive:** a foreign token cannot leave its tenant to a header or omit its subject; nobody can
  grant, provision or reactivate authority they do not hold; an IdP cannot mint platform authority;
  a suspension, a password change and a sign-out end existing sessions; a password has a floor; a
  pepper can be rotated; the Stripe secrets leave argv.
- **Negative:** four refusals of something that works today, each with an announced hatch or no
  correct case broken: required `sub`/`tenant_id` (`--jwt-optional-claim`), dropped foreign platform
  roles (`--idp-platform-roles`), weak API keys refuse boot (`--allow-weak-api-keys`), and the
  12-character floor (only when a password is set). Verification costs about 196 ms against about
  86 ms before (implementer's medians); memory is unchanged. One sign-out ends every device's
  session.
- **Neutral:** a request does one more read of `meta.users`, cached for 30 s.
- **Reversibility:** each refusal has its hatch; the counter and the bounded CHECK are additive. The
  bounded CHECK is standing manual SQL on a populated `meta.users` (Open questions).

## Implementation notes

- Changed: `packages/api-gateway-runtime/src/` (`auth.ts`, `stores.ts`),
  `packages/api-gateway/src/auth-resolution.ts`, and `packages/crypto` and `packages/kernel`, which
  were changed and re-tested (the reports name no file there); in
  `apps/operate-server/src/` the new `platform-authority.ts`, `session-standing.ts` and
  `stripe-secret-source.ts` with tests, plus `principals.ts`, `platform-users.ts`,
  `credential-store.ts`, `credential-routes.ts` (comments), `server.ts`, `node.ts`, `cli.ts`;
  `apps/operate-web` (`app/api/auth/logout/route.ts` calls the API's logout with a 5 s bound and
  clears the cookie whatever it answers; `/account` says every session has ended);
  `deploy/README.md` (the bullets on required claims and dropped IdP platform roles).
- **Review found and fixed seven defects**, each mutation-checked:
  1. `forget` did not cancel an in-flight read, which re-cached the old standing for a whole TTL on
     the replica that signed out. A per-user counter now gates caching.
  2. User and membership status transitions never called `forget`, so the boot line's "immediately"
     was false; a required `onUserStatusChanged` callback is wired in `node.ts`.
  3. Reactivating a membership bypassed the escalation rule; the implementer listed it as open.
  4. The Stripe environment refusal broke working deployments (above).
  5. No test installed either new decoration: removing `withForeignPlatformRolesDropped` or
     `withSessionStandingCheck` left 5,798 tests green. Two behavioural tests in `jwt.test.ts` now
     fail on each removal.
  6. `deploy/README.md` still said a token without `tenant_id` lets the caller pick the tenant, and
     `deployment-defaults.test.ts` pinned that sentence. Both are rewritten.
  7. Comments claiming a suspended session stays valid until expiry are corrected.
- **In process (review's figures, which supersede the implementer's 5,798):** crypto 371,
  api-gateway 249, api-gateway-runtime 400, operate-server 5,808 (153 files), testing 906; typecheck
  0 on each, `operate-web` `tsc` clean (no test runner). The implementer reported kernel 951.
- **Implementer's mutation checks**, each reversed: the foreign-role drop (3 fail), the weak-key
  refusal (1), the escalation filter (3), the password floor (3), the epoch equality (1), the
  user-status check (3), required `sub` (2), required `tenant_id` (2), pepper staleness (1), the
  entropy floor (2).
- **Implementer's live store check**, PG 16 as the non-owner `serving` role: setting a password moved
  the epoch 0 → 1; a rehash with a stale expected hash did not land and with the matching one landed
  without moving the epoch; a v2-pepper hash verifies; ending sessions returned epoch 2, and `null`
  for an unknown user; the bounded CHECK admits `scrypt$32768$8$3$…` and the `k2` form and refuses a
  9-digit `n`, `k0` and `k10000`.
- **Live through HTTP on PG 16 as `crossengin_app`, on `--store pg` and `pg-columns`** (independent
  run; supersedes both reports):

  | Arm | Before | After |
  |---|---|---|
  | Foreign JWT with no `sub`, or no `tenant_id` plus `x-tenant-id` | accepted / header picked the tenant | 401 `required_claim_absent`; full claims 200 |
  | A user admin grants `platform_admin` as primary or secondary | allowed | 403 `role_escalation`; `erp_admin` 201; a `platform_admin` granting it 201 |
  | Foreign token claiming `platform_admin` → `/v1/platform/tenants` | — | 403; the deployment's own minted token 200 |
  | Suspended user's existing session | 200 for up to 30 s | 401 at once; 200 after reactivation |
  | Self password change / operator reset / logout | sessions kept | `sessionsRevoked: true`; the acting and other sessions 401; a fresh login works |
  | 11-character password | accepted | 400 `password_too_short` |

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| 1. **Takeover through a password reset.** A credential admin can reset the password of a user holding higher platform roles and sign in as them. Closing it needs a cross-tenant membership read `PostgresCredentialStore` does not have. | CrossEngin platform | _unscheduled_ |
| 2. **Every password write fails until manual SQL runs, once `CREDENTIAL_PEPPER_VERSION` is above 1.** The bounded CHECK is standing manual SQL on a populated `meta.users`; until it runs, the old CHECK refuses a `k<N>$` hash with 23514. Nothing documents that ordering. | CrossEngin platform | _unscheduled_ |
| 3. **Another replica serves a cached standing for up to 30 s** after a suspension or sign-out; there is no fleet-wide invalidation. | CrossEngin platform | _unscheduled_ |
| 4. **The standing check runs only under `--credential-login`**, ADR-0381's scope. | CrossEngin platform | _unscheduled_ |
| 5. **MFA, TOTP and forgot-password are not built.** No mail channel, no encrypted storage for a TOTP secret in the catalog, and enrolment and recovery are a product decision. | CrossEngin platform | _unscheduled_ |
| 6. **`--idp-platform-roles` is accepted with no JWKS flag**, where it does nothing. | CrossEngin platform | _unscheduled_ |
| 7. **Documentation:** `--jwt-optional-claim` has no `--help` entry (predates this change), and `.env.example` and the deploy docs name none of `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `CREDENTIAL_PEPPER_VERSION`, `CREDENTIAL_PEPPER_RETIRED_<N>` or the new flags. | CrossEngin platform | _unscheduled_ |
| 8. **A failed web sign-out is silent:** the shell's button does not read `ended`. | CrossEngin platform | _unscheduled_ |

## References

- `apps/operate-server/src/platform-authority.ts`, `session-standing.ts`, `stripe-secret-source.ts`,
  `principals.ts`, `platform-users.ts`, `server.ts`, `jwt.test.ts`
- `packages/api-gateway-runtime/src/auth.ts`, `packages/api-gateway/src/auth-resolution.ts`
- ADR-0386, ADR-0369, ADR-0381, ADR-0364, ADR-0365, ADR-0358, ADR-0398, ADR-0338, ADR-0301
