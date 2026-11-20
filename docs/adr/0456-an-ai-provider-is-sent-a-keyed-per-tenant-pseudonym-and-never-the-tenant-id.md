# ADR-0456: An AI provider is sent a keyed per-tenant pseudonym, and never the tenant id

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0302 (a per-tenant value derived from one deployment secret), ADR-0338 (derive, store nothing), ADR-0346 (`CURSOR_ENCRYPTION_SECRET`), ADR-0347 (one secret, two purposes, separated by HKDF info), ADR-0377 (the cursor secret is uncommented in `.env.example`), ADR-0386 (an optional field with a safe default makes its own omission unobservable), ADR-0393 (a fourth HKDF label), ADR-0450 (this closes its open question on the provider wire) |

## Context

ADR-0450 recorded, as an open question: *the tenant id reaches the internal `CompletionRequest`
only; the OpenAI-compatible body carries no `user` field, so nothing on the provider wire names the
tenant.* Measured against the three request builders (`buildAnthropicRequest`, `buildOpenAiRequest`,
`buildLocalRequest`) and both embedding bodies, it was true of all five: no body carried any
per-tenant field.

That is a privacy-correct default with an operational cost. Every major provider runs abuse
detection keyed on a per-request end-user identifier — Anthropic's `metadata.user_id` ("a uuid,
hash value, or other opaque identifier … to help detect abuse"), and OpenAI's `user` — and acts on
what it detects by throttling or revoking the **API key**. With no identifier, one abusive tenant is
indistinguishable from the deployment, so the remedy a vendor applies takes every tenant's AI design
down at once, and when a vendor reports a flagged request there is nothing in it to say which tenant
sent it.

The tempting fixes are both wrong:

- **The raw tenant id** discloses an internal identifier to a third party, which the provider then
  holds beside the tenant's business description (the prompt). It is a stable join key across
  everything the vendor retains.
- **`sha256(tenantId)`** looks opaque and is not. Tenant ids are UUIDv7 — a 48-bit millisecond
  timestamp plus 74 random bits — and the timestamp is roughly guessable from when a tenant signed
  up; more to the point, anyone who learns a candidate id from any other channel can hash it and
  confirm the match. An unkeyed digest is a pseudonym only against a party that cannot compute the
  function, and every party can compute sha256.

## Decision

**Every provider request carries an opaque, keyed, per-tenant pseudonym, and no request carries the
tenant id.**

1. **Derivation** (`@crossengin/crypto`, `deriveAiTenantPseudonym`):
   `ctp_` + hex(HKDF-SHA256(ikm = `CURSOR_ENCRYPTION_SECRET`, salt = tenantId, info =
   `crossengin.ai-tenant-pseudonym.v1`, 16 bytes)) — 36 characters of `[a-z0-9_]`. A fifth HKDF
   label beside the column, cursor, KEK and request-signing labels, never a reuse of one. No
   generation suffix: the point is that the value stays the same.
2. **Wire contract** (`@crossengin/ai-providers`): `CompletionRequest.tenantPseudonym` and
   `EmbeddingRequest.tenantPseudonym`, optional, validated by `TENANT_PSEUDONYM_PATTERN`
   (`^ctp_[0-9a-f]{32}$`). Every builder reads it through one helper, `tenantPseudonymForWire`, which
   answers `undefined` (field omitted), the value, or **throws `MalformedTenantPseudonym`**, and the
   error does not quote the value. What that fence proves is narrower than "no raw id is sent": it
   refuses any value not of the `ctp_<32 hex>` shape (a hyphenated id, a bare digest, the wrong
   length or case) and the request's **own** tenant id with its hyphens removed — the one raw-id
   spelling the pattern admits, since a UUID is 32 hex digits, and the one a request can check
   because it carries `tenantId` (a required parameter of the helper, so no call site can skip it).
   It **cannot** tell a keyed value from an unkeyed one of the same shape:
   `"ctp_" + sha256(tenantId).slice(0, 32)` — Option B — passes it. The guarantee that what is sent
   is keyed is that its only producer is `deriveAiTenantPseudonym`, reached through the server's
   `tenantPseudonymForOf`, not the pattern.
3. **Placement**: Anthropic `metadata.user_id`; OpenAI and the local OpenAI-compatible provider
   `user`, on both chat and embedding bodies.
4. **Source** (`apps/operate-server/src/ai-tenant-pseudonym.ts`): keyed when
   `CURSOR_ENCRYPTION_SECRET` is non-blank — read exactly as `resolveCursorSealing` reads it, so the
   two cannot disagree — and **absent** otherwise. Absent means **no pseudonym is sent**, never the
   raw id and never an unkeyed hash, and it is said at boot (`[ai-design] tenant pseudonym: absent —
   …`); keyed is said too, at info. The absent line's consequence is keyed on where requests go
   (`DesignProviderBuild.endpoint`): for a **vendor** (Anthropic, `api.openai.com`) it warns that
   the vendor can attribute nothing to a tenant and acts on the key as a whole; for a
   **self-hosted** model it says at info that none is needed, because there is no vendor abuse
   detection and no key to revoke; for an OpenAI **custom base URL**, which may be either, it warns
   conditionally. A secret present but too weak refuses at
   resolution, as the cursor sealer already does for the same variable.
5. **Wiring**: `buildDesignDesigner` takes `tenantPseudonymFor: ((tenantId) => string) | null`,
   **required and nullable**, so forgetting it is a compile error rather than a silent "send none"
   (ADR-0386's lesson). `designManifest` stamps it on every attempt.

### Why `CURSOR_ENCRYPTION_SECRET`, and why that does not weaken it

The repo's precedent for a second purpose on one deployment secret is a derivation separated by
HKDF info (ADR-0347: the column key and the KEK share `COLUMN_ENCRYPTION_SECRET`). HKDF-Expand is a
PRF keyed by the extracted PRK; the cursor key and the pseudonym share that PRK (same IKM, same
tenant salt) and differ only in the info label. Publishing a PRF output under one label reveals
nothing about the output under another, nor about the PRK, nor about the secret — so the provider
learning every tenant's pseudonym gives it no purchase on any tenant's cursor key, and a test pins
that the two are unrelated bytes.

Of the existing secrets it is the right one, not merely an available one:

- It is **set on the shipped stack**: `deploy/.env.example` uncomments it with a generator line and
  `README.md` lists it as required (ADR-0377). A dedicated new variable would leave every deployment
  that has not read this ADR sending nothing.
- `COLUMN_ENCRYPTION_SECRET` is commented out on the shipped pack (it declares no PHI field), so it
  would be absent exactly where this matters.
- `CREDENTIAL_PEPPER` and `OPERATE_TOKEN_SIGNING_KEY` protect against a database read and a forged
  session; their outputs never leave the process. The cursor secret's outputs already travel to
  clients (a sealed cursor), so its threat model already assumes its derived values are observed.

## Alternatives considered

- **Option A: send the raw tenant id.**
  - **Pros:** zero machinery; the vendor's report names the tenant directly.
  - **Cons:** discloses an internal identifier and gives the vendor a stable join key against the
    tenant's prompts.
  - **Why not:** the attribution benefit is fully available without disclosure.

- **Option B: send `sha256(tenantId)` (or any unkeyed digest).**
  - **Pros:** no key to manage.
  - **Cons:** confirmable by anyone holding a candidate id; UUIDv7's timestamp makes candidates
    cheaper to enumerate than "random UUID" suggests.
  - **Why not:** it is the raw id with an extra step for whoever wants it.

- **Option C: a dedicated `AI_TENANT_PSEUDONYM_SECRET`.**
  - **Pros:** independent rotation; no coupling to cursor sealing.
  - **Cons:** a new required secret, a new `.env.example` line, a new README entry and fence, and
    every deployment that does not set it sends nothing.
  - **Why not:** HKDF separation already gives cryptographic independence; the only thing a second
    variable buys is rotation independence, and rotating the pseudonym is something no operator has
    a reason to want separately (see Consequences). Two sources would also re-open the precedence
    question ADR-0406 refused.

- **Option D: a pseudonym per principal (tenant + user) rather than per tenant.**
  - **Pros:** finer abuse attribution.
  - **Cons:** discloses to the vendor how many distinct people in a tenant use the Architect, and
    when; the action a vendor takes is on the API key anyway.
  - **Why not:** the decision unit on our side is the tenant (budget, residency, suspension), so the
    identifier should be too. Revisit if a vendor starts acting per end-user rather than per key.

- **Option E: fall back to an unkeyed hash when the secret is absent.**
  - **Pros:** something is always sent.
  - **Cons:** silently downgrades a deployment to Option B, and the boot line could not be honest
    about what was sent.
  - **Why not:** fail closed — the absent state is the pre-ADR state, which is safe, and is said.

## Consequences

- **Positive:** a vendor can attribute abuse to one tenant and act narrowly; a vendor report of a
  flagged request can be mapped back by the deployment (recompute the pseudonym for each tenant id
  and compare) and by nobody else. The tenant id itself never reaches a provider, and a builder
  refuses a malformed value rather than sending it.
- **Negative — the privacy trade-off, stated plainly:** the vendor can now **link** every request
  from one tenant, across sessions, restarts and replicas, where before it saw one undifferentiated
  stream per deployment. It learns per-tenant volume, timing and the set of prompts each tenant sent.
  It cannot learn *which* tenant without the secret, and two deployments' pseudonyms for the same
  tenant id are unrelated — but linkability within a deployment is the point of the identifier and
  is the cost. A deployment that judges this cost too high leaves `CURSOR_ENCRYPTION_SECRET` unset —
  which also costs it sealed cursors, so in practice it is not an independent choice (see the open
  question).
- **Neutral:** rotating `CURSOR_ENCRYPTION_SECRET` (which today has no previous-generation ring)
  changes every tenant's pseudonym, resetting the vendor's per-tenant history. That is acceptable —
  it already 400s every in-flight cursor walk — and is stated here so nobody is surprised by it.
- **Reversibility:** trivial. Unsetting the secret stops the field; deleting the field from the
  builders reverts entirely. Nothing is stored.

## Implementation notes

- `packages/crypto/src/key-derivation.ts`: `AI_TENANT_PSEUDONYM_DERIVATION_INFO`,
  `AI_TENANT_PSEUDONYM_PREFIX`, `AI_TENANT_PSEUDONYM_BYTES`, `deriveAiTenantPseudonym`. Refusals name
  `CURSOR_ENCRYPTION_SECRET` (the KEK label's reasoning: the pseudonym has no variable of its own).
- `packages/ai-providers/src/tenant-pseudonym.ts`: pattern, schema, `isTenantPseudonym`,
  `MalformedTenantPseudonym`, `tenantPseudonymForWire`. The pattern is written independently of the
  derivation (this package does not depend on crypto); `apps/operate-server`'s
  `ai-tenant-pseudonym.test.ts` is the agreement test, since it depends on both.
- Field limits: 36 characters is under Anthropic's documented 256 for `metadata.user_id`, and under
  64, the limit OpenAI documents for `safety_identifier`; the classic `user` field carries no
  documented limit in the client code here, and 36 is conservative against any.
- The pseudonym is never logged: the boot line names the variable only, and no error quotes a
  value.
- Tests: the providers are tested for **carriage and refusal** (`tenant-pseudonym.test.ts` in each
  of the three provider packages) — the field present on chat (and embeddings for OpenAI/local),
  never containing the tenant id, absent when unconfigured, and refused, with nothing sent, when
  malformed or when it is the request's own tenant id with hyphens removed. **Stability and
  distinctness are properties of the derivation**, not of a provider that copies a field, so they
  are tested on `deriveAiTenantPseudonym` (`packages/crypto/src/ai-tenant-pseudonym.test.ts`) and
  end to end through the real providers in `apps/operate-server/src/ai-tenant-pseudonym.test.ts`;
  a first draft also asserted them per provider over a test-local HKDF, which re-tested that
  helper and is removed.
- Operator documentation: `deploy/.env.example`'s comment on `CURSOR_ENCRYPTION_SECRET` and
  `deploy/README.md`'s boot-line list both say the secret keys the pseudonym, that rotating it
  gives every tenant a new identity at the vendor, and that leaving it unset sends none — fenced
  in `deployment-defaults.test.ts`, since that comment is what an operator reads before rotating.
- `docs/adr/index.md` is regenerated by a later stage (`python3 docs/adr/generate-index.py`).

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| OpenAI documents `user` as deprecated in favour of `safety_identifier` (and `prompt_cache_key`). `user` is still accepted and is the field OpenAI-compatible servers (vLLM, Ollama, LM Studio, gateways) know; moving the `api.openai.com` arm to `safety_identifier` while the custom-base-URL and local arms keep `user` is a per-endpoint decision not taken here. | CrossEngin platform | _unscheduled_ |
| Opting out of the pseudonym and opting out of sealed cursors are one switch. If a deployment wants sealed cursors without vendor-side linkability, it needs a flag; none is added because no deployment has asked. | CrossEngin platform | _unscheduled_ |
| The Architect CLI (`apps/architect-cli`) sends `tenantId: NULL_UUID` and no pseudonym; it has no deployment secret and no tenant, so nothing is attributable there. | CrossEngin platform | _unscheduled_ |
| A reverse lookup (vendor report → tenant) is possible but has no tool; an operator would recompute pseudonyms over `meta.tenants` by hand. | CrossEngin platform | _unscheduled_ |
| Not verified live: the field reaching a real vendor, and the Anthropic arm (`AnthropicProvider` takes no base URL from the environment, so `metadata.user_id` is covered by unit tests only). The boot lines and the OpenAI-compatible and local wire bodies are verified live below. | CrossEngin platform | _unscheduled_ |
| A weak `CURSOR_ENCRYPTION_SECRET` is refused at boot by the cursor sealer as `list-cursor encryption secret refused (too_short)`, which names the purpose and not the variable; the pseudonym resolver's own refusal is never reached. | CrossEngin platform | _unscheduled_ |

## Verified live

PG 16, catalog applied in compose order (990 statements), API as `crossengin_app` (NOSUPERUSER
NOBYPASSRLS) on `--store pg --ai-design`. Two tenants provisioned over HTTP. A stub
OpenAI-compatible server recorded every request body (16 bodies across the arms).

- **Local provider, keyed** (`LOCAL_LLM_BASE_URL`): boot printed `tenant pseudonym: keyed` at info.
  Eleven alpha bodies carried one `user`, `ctp_50ee9f84e38ede043b55014165e17e85`. They came from 4
  synchronous designs and 3 jobs, two of them three-attempt retries; one job was observed `running`
  before `failed`. Three beta bodies carried `ctp_89ea72e06979cff10e2f006110242f75`. Both values
  equal `deriveAiTenantPseudonym(parseCursorEncryptionSecret(secret), tenantId)` computed
  independently.
- **Restart, same secret**: both tenants' values were unchanged.
- **OpenAI custom base URL** (`OPENAI_API_KEY` + `OPENAI_BASE_URL`, `--ai-allow-unpriced-model`):
  `user` was present on `/v1/chat/completions` and equal to the same per-tenant values.
- **Secret absent**: the captured bodies had no `user` key and no `ctp_`. The boot line said
  `absent` at **info** for the local provider, and at **warn** for an OpenAI custom base URL and for
  `api.openai.com` (boot only; no request was made). The cursor sealer reported `absent` beside it.
- **Weak secret** (`short`, 40×`a`): boot exited 1 with `too_short` / `too_uniform`. The value was
  not echoed.
- Across the whole capture, neither tenant id nor either user id appeared, hyphenated or with the
  hyphens removed. Across all 16 server log and stderr files, the secret value and any
  `ctp_[0-9a-f]{32}` appeared **0** times.

## References

- `packages/crypto/src/key-derivation.ts`, `packages/crypto/src/ai-tenant-pseudonym.test.ts`
- `packages/ai-providers/src/tenant-pseudonym.ts`, `types.ts`
- `packages/ai-providers-anthropic/src/messages-api.ts`; `packages/ai-providers-openai/src/chat-api.ts`, `provider.ts`; `packages/ai-providers-local/src/chat-api.ts`, `provider.ts`
- `apps/operate-server/src/ai-tenant-pseudonym.ts`, `ai-design.ts` (`buildDesignDesigner`), `node.ts`
- RFC 5869 (HKDF); Anthropic Messages API `metadata.user_id`; OpenAI Chat Completions `user` / `safety_identifier`
- ADR-0450 open questions

## Addendum: three open questions closed by ADR-0461

- **The OpenAI field.** Decision 3's placement is narrowed: chat to `api.openai.com` now carries
  the pseudonym as `safety_identifier`, not `user`; a custom base URL and the local provider keep
  `user`, and embeddings keep `user` on every endpoint, since the embeddings endpoint documents no
  `safety_identifier`. One predicate decides it (`openAiEndUserField`), and the boot line names the
  field read off the built provider (`… in the safety_identifier field`). The value sent and its
  refusal are unchanged.
- **One switch for two choices.** `--ai-tenant-pseudonym keyed|off` (default `keyed`) lets a
  deployment send no pseudonym while `CURSOR_ENCRYPTION_SECRET` goes on sealing cursors. `off` does
  not read the secret, is said at boot as `tenant pseudonym: off`, and is a separate source state
  from `absent` because its remedy differs. The Consequences sentence "in practice it is not an
  independent choice" is therefore no longer true.
- **Reverse lookup.** `operate-server ai-pseudonym-lookup <ctp_…>` recomputes the pseudonym over
  every `meta.tenants` row (every status), with the secret from the environment through this ADR's
  own `resolveAiTenantPseudonymSource`, and refuses rather than answers a read that RLS would
  confine. It runs as `crossengin_app`, because `meta.tenants` carries no RLS and that role holds
  `SELECT` on every `meta` table.
- **The derivation's salt is the canonical tenant id.** Decision 1's `salt = tenantId` now means a
  uuid-shaped id lowercased first (ADR-0461's review corrections): a credential spelling its tenant
  in uppercase otherwise carried a pseudonym the lookup could not reproduce from
  `meta.tenants.id::text`. An uppercase-spelled tenant's pseudonym changes once, at this change.
