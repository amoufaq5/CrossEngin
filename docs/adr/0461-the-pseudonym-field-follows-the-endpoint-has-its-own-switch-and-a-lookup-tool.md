# ADR-0461: The tenant pseudonym's field follows the endpoint, it has its own switch, and a vendor report can be mapped back

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-20 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0301 (a secret never travels on argv), ADR-0331 (a claim is not a gap), ADR-0333 (a confined read answers a silent zero), ADR-0346 (`CURSOR_ENCRYPTION_SECRET`), ADR-0357 (the cursor disclosure sealing closes), ADR-0362 (ask Postgres for the confinement verdict), ADR-0386 (an optional field with a safe default makes its own omission unobservable), ADR-0456 (this closes three of its open questions) |

## Context

ADR-0456 sends every AI provider request an opaque, keyed, per-tenant pseudonym
(`ctp_<32 hex>`, HKDF of `CURSOR_ENCRYPTION_SECRET` under its own label) in place of the tenant id.
It left six open questions; three of them are decisions that need no new evidence, and this record
takes them.

1. **The OpenAI field.** The pseudonym rode on `user` for both OpenAI arms and the local provider.
   OpenAI documents `user` on Chat Completions as deprecated in favour of `safety_identifier`; the
   OpenAI-compatible servers a custom base URL points at (vLLM, Ollama, LM Studio, gateways) know
   `user` and not `safety_identifier`. One field cannot be right for both.
2. **One switch for two choices.** The pseudonym and sealed list cursors are both keyed off
   `CURSOR_ENCRYPTION_SECRET`, so the only way to send no pseudonym was to unset the secret — which
   also turns off cursor sealing, the protection ADR-0357 measured as live on every pack (a
   classified field's plaintext otherwise rides in `nextCursor`). A deployment unwilling to let a
   vendor link one tenant's requests had to accept a disclosure to get there.
3. **No reverse lookup.** ADR-0456's stated benefit is that a vendor's report of a flagged request
   can be mapped back to a tenant by the deployment and nobody else. The mapping is "recompute the
   pseudonym for every tenant id and compare", and there was no tool, so it was a hand-written script
   against the deployment secret.

## Decision

### 1. One predicate picks the field, per endpoint and per API

`openAiEndUserField(baseUrl, api)` in `@crossengin/ai-providers-openai`:

| request | OpenAI's own API | custom base URL |
|---|---|---|
| chat | `safety_identifier` | `user` |
| embeddings | `user` | `user` |

- "OpenAI's own API" is `isCustomOpenAiBaseUrl(baseUrl) === false`: an `https` URL on port 443 with
  no path, no query and no userinfo whose host is `api.openai.com` **or a subdomain of it** — the
  regional data-residency hosts (`eu.api.openai.com`) serve the same models and fields, and the
  domain is OpenAI's, so nothing else can sit there. Decided from the parsed URL, so case and a
  trailing slash do not move the arm; anything unparseable is custom. The same predicate gates model
  ids against the catalogue, and the server's boot line reads its endpoint class off the built
  provider (`isCustomEndpoint`) rather than off the raw environment, so the line's endpoint and the
  field it names come from one predicate (see *Review corrections*).
- `safety_identifier` only where it is documented as the replacement: Chat Completions on OpenAI's
  own API.
- `user` for any other base URL, because which server is behind it cannot be told from the URL and
  `user` is the field that ecosystem knows — `safety_identifier` there is at best ignored and at
  worst refused as an unknown argument.
- `user` for embeddings everywhere: the deprecation is documented for Chat Completions and
  Responses, the embeddings endpoint documents `user` and not `safety_identifier`, and OpenAI
  answers an argument it does not recognise with a 400.
- The local provider (`@crossengin/ai-providers-local`) keeps `user` unconditionally; Anthropic
  keeps `metadata.user_id`.

`BuildRequestOptions.endUserField` is **required**: an optional field defaulting to the old `user`
would let a forgotten argument send the deprecated field to `api.openai.com` with nothing failing
(ADR-0386). `endUserFieldOf` is the one place the field name becomes a body key, and its return type
`OpenAiEndUserBody` is a union whose every arm forbids the other key with `?: never`, so a body with
both cannot be returned from it — a `@ts-expect-error` fence in the provider's tests, which fails
`TS2578` when the arms are relaxed to a bare union. `OpenAiChatRequest` itself still declares both
keys optional; the property is held by that producer's type, not by the request interface. The provider exposes `endUserField`, and `DesignProviderBuild.pseudonymField`
reads it off the **built** provider (Anthropic `metadata.user_id`, local `user`, OpenAI
`provider.endUserField`), so the boot line names the field the requests really carry rather than a
re-derivation from the environment:

```
[ai-design] tenant pseudonym: keyed — requests to openai/gpt-4o carry an opaque per-tenant id
(ctp_<32 hex>, HKDF of CURSOR_ENCRYPTION_SECRET) in the safety_identifier field; …
```

What is sent does not change — the same value, refused by the same `tenantPseudonymForWire` — only
the key it is sent under.

### 2. `--ai-tenant-pseudonym keyed|off`, default `keyed`

- `keyed` is ADR-0456 unchanged: sent when the secret is set, `absent` (nothing sent, said at boot)
  when it is not.
- `off` sends nothing whatever the secret, and **does not read the secret for this at all**, so
  cursors stay sealed. `AiTenantPseudonymSource` gains a third member, `off`, kept apart from
  `absent` because they are different facts with different remedies (ADR-0331): `absent` is told to
  set the variable, `off` to drop the flag. `off` records whether the secret is *present* (a
  presence check, never a parse), so its remedy is true: with the secret set it says to drop the
  flag and that the secret still seals cursors; with it unset it says to drop the flag **and** set
  the variable, because dropping the flag alone would only reach `absent`.
- The level of a not-sent line follows the endpoint in both arms (warn for a vendor or an unknown
  custom base URL, info for a self-hosted model): the vendor cannot tell *why* nothing was sent, so
  the cost does not depend on the cause.
- `resolveAiTenantPseudonymSource(env, mode)` takes the mode as a **required** argument, so no call
  site reaches the keyed arm by forgetting the operator's `off` (ADR-0386).
- The flag is refused without `--ai-design`, where nothing reads it and `off` would read as a
  privacy decision the deployment had taken.

### 3. `operate-server ai-pseudonym-lookup <ctp_…>`

A maintenance subcommand that recomputes the pseudonym for every row of `meta.tenants` and prints
the matching tenant.

- **The secret is resolved by the serving process's own function**,
  `resolveAiTenantPseudonymSource(env, "keyed")`, so the command and the server cannot disagree
  about what the secret is or whether it is usable. It comes from the environment only; `--secret` is
  refused by name (ADR-0301). Unset → `secret_absent`; weak → `secret_refused` with the reason and
  never the value; both before any connection.
- **The argument is refused before any connection** unless it is `ctp_<32 lowercase hex>`
  (`isTenantPseudonym`, the wire contract's own predicate), and the refusal does not quote it,
  because what an operator pastes may be a raw identifier.
- **Every tenant status is read**, `deleted` included — retirement is `UPDATE … SET status`, so the
  row survives, and a report about a since-deleted tenant is the case most in need of an answer.
- **The derivation is over the tenant, not its spelling.** HKDF's salt is the exact string, and a
  credential may spell its tenant uuid in uppercase (`--api-key k:role:0196F2A8-…`, a foreign JWT's
  `tenant_id`) while `meta.tenants.id::text` is always lowercase. So the one mapping the server and
  the lookup share lowercases a uuid-shaped tenant id before deriving
  (`canonicalTenantIdForPseudonym`); a non-uuid string is derived as given, and can have no
  `meta.tenants` row to match anyway.
- **Every tenant is compared**, no early return: two matches are `ambiguous` and neither is
  chosen, rather than the first hiding the second.
- **A confined read is refused, not answered.** `meta.tenants` has no `rls` and no policy in
  `META_TABLES`, and `deploy/postgres/roles/app-role.sql` grants `crossengin_app`
  `SELECT … ON ALL TABLES IN SCHEMA meta`, so the shipped confined role reads every row. But a
  confined read of this table would return fewer rows with no error, and `no_match` over it is a
  false negative that looks like an answer (ADR-0333). So the command asks Postgres —
  `row_security_active('meta.tenants'::regclass)`, its own verdict (ADR-0362) — and anything other
  than `false` refuses as `read_confined`.
- A `no_match` names every cause it cannot rule out: a secret rotated since the report (only the
  previous value can match), a request from a credential whose tenant has no `meta.tenants` row
  (an api-key tenant with `--tenant-status-gate` off, which nothing here can enumerate), and a
  request sent by a server predating this record, which derived over the credential's spelling.
- Exit 0 on exactly one match (`AI_PSEUDONYM_LOOKUP_ANSWERED`, a total map over the six outcomes),
  1 on every other outcome, 2 on a usage error. The secret and every derived key are printed
  nowhere; the output pairs a pseudonym with a tenant id, which the help text says is the join the
  derivation denies the provider and must stay out of anything sent back to the vendor.

## Alternatives considered

- **Option A: `safety_identifier` on every OpenAI request, custom base URL included.**
  - **Pros:** one field; follows OpenAI's direction.
  - **Cons:** a custom base URL is usually not OpenAI; vLLM, Ollama and gateways know `user`, and a
    server that refuses unknown arguments would turn a working design into a 400.
  - **Why not:** the URL cannot say which server is behind it, and `user` is the field that cannot
    be wrong about one it does not know.

- **Option B: send both `user` and `safety_identifier` on `api.openai.com`.**
  - **Pros:** works whichever OpenAI honours.
  - **Cons:** sends the deprecated field the open question was about removing, and doubles the
    surface the wire fence has to reason about.
  - **Why not:** the deprecation is the reason for the change.

- **Option C: `safety_identifier` on embeddings too.**
  - **Pros:** symmetry with chat.
  - **Cons:** the embeddings endpoint does not document it; an unrecognised argument is a 400.
  - **Why not:** it would trade a working embedding call for nothing.

- **Option D: a dedicated `AI_TENANT_PSEUDONYM_SECRET` instead of a mode flag.**
  - **Pros:** separates the two choices and the rotation of the two secrets.
  - **Cons:** ADR-0456's reasons still hold — every deployment that does not set it sends nothing,
    and two sources re-open a precedence question. Separating *whether* to send needs one flag, not
    a second secret.
  - **Why not:** the flag answers the question asked at no new secret.

- **Option E: the lookup as an HTTP route.**
  - **Pros:** reachable from the console.
  - **Cons:** a route that maps a pseudonym to a tenant is an oracle for anyone holding its grant,
    and needs a role, a recorded read and a refusal surface; the population that receives vendor
    abuse reports is the operator with shell access.
  - **Why not:** a subcommand reaches exactly that population and nothing else; a route can be
    added beside it if one is asked for.

- **Option F: answer `no_match` without asking about RLS.**
  - **Pros:** one statement fewer; correct today, since the table has no RLS.
  - **Cons:** the day a policy lands on `meta.tenants`, a confined role answers `no_match` for a
    tenant it cannot see, which reads as an answer.
  - **Why not:** the cost is one catalog read and the failure is silent.

## Consequences

- **Positive:** `api.openai.com` receives the field OpenAI documents for this purpose; compatible
  servers keep the field they know; the boot line names the field actually sent. A deployment can
  keep sealed cursors and send no pseudonym. A vendor report maps back to a tenant in one command,
  as the confined serving role, with a refusal instead of a silent miss.
- **Negative:** the OpenAI field choice rests on OpenAI's published documentation; nothing here has
  been sent to a real vendor (the live stage uses a stub). The lookup is O(tenants) HKDF derivations
  per call over one unpaginated `SELECT` — trivial at the scale this platform serves, and stated.
- **Neutral:** `buildOpenAiRequest`'s options gained a required field, so an external caller of that
  exported builder must now say which field it wants.
- **Reversibility:** trivial; nothing is stored.

## Review corrections

An adversarial review of the first draft reported four defects; all four were real and are fixed.

1. **The lookup missed a real match.** The server derived over `principal.tenantId` verbatim while
   the lookup compared `id::text`, so a tenant whose credential spelled its uuid in uppercase got a
   pseudonym the lookup could never reproduce — `no_match`, with a detail blaming a secret rotation.
   Fixed by canonicalising inside the shared mapping (above), with a test deriving through the
   server's own mapping from an uppercase id and matching the lowercase row; dropping the
   canonicalisation fails two tests. The `no_match` detail now lists every cause it cannot exclude.
   The stated cost: a deployment that already sent pseudonyms for an uppercase-spelled tenant id
   sends that tenant a different one from this change on; ADR-0456 shipped in the same batch.
2. **Two predicates for one fact.** The boot line's endpoint class came from "is `OPENAI_BASE_URL`
   set" while the field came from the provider's normalised comparison, so
   `OPENAI_BASE_URL=https://api.openai.com/` sent `safety_identifier` and warned about "this custom
   base URL". The endpoint is read off the provider now, the model-id gate in `ai-design.ts` uses
   the same exported predicate, and OpenAI's regional hosts are decided to be OpenAI's own API.
3. **The off-mode remedy could not work alone** when the secret was unset; see the off bullet.
4. **"Typed so at most one" was not true of the type.** It is now (the `?: never` union above).
   The obvious fix, a bare union of `{user}` and `{safety_identifier}`, would not have been: a
   literal carrying both keys is assignable to either arm, which the fence demonstrates.

## Implementation notes

- `packages/ai-providers-openai`: `OPENAI_END_USER_FIELDS`, `OpenAiEndUserField`, `endUserFieldOf`
  and the required `BuildRequestOptions.endUserField` in `chat-api.ts`; `openAiEndUserField`,
  `OpenAiEndUserApi`, the exported `isCustomOpenAiBaseUrl` and the `endUserField` and
  `isCustomEndpoint` getters in `provider.ts`; `OpenAiEndUserBody` in `chat-api.ts`. Tests: the predicate both ways
  (default, default with a trailing slash and upper case, three custom URLs, embeddings on both),
  the streaming and non-streaming chat bodies carrying `safety_identifier` and not `user` on the
  default URL, a custom URL carrying `user` and not `safety_identifier`, embeddings carrying `user`,
  and an unconfigured request carrying neither. Mutating the predicate to always answer `user` fails
  five of them.
- `apps/operate-server/src/ai-design.ts`: `AiTenantPseudonymField`, `DesignProviderBuild.pseudonymField`.
- `apps/operate-server/src/ai-tenant-pseudonym.ts`: the modes, `off`, the required `mode` argument,
  and the field in the keyed line. `cli.ts`: `--ai-tenant-pseudonym`, refused without
  `--ai-design`; `node.ts`: `resolveAiTenantPseudonymSource(process.env, options.aiTenantPseudonym)`,
  fenced as text.
- `apps/operate-server/src/ai-pseudonym-lookup.ts` + `bin/operate-server.ts` + the top-level help.
  Tests run the real derivation against a fake connection that answers the two statements by shape
  and throws on anything else, with `assertBindArity`; mutating the confinement guard to
  `=== true` fails the confined arm.
- `deploy/README.md` and `deploy/.env.example` name the field per endpoint, the `off` mode and the
  lookup command, fenced in `ai-pseudonym-lookup.test.ts`.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| Not verified against a real vendor: that `api.openai.com` accepts `safety_identifier` on Chat Completions and that its embeddings endpoint still accepts `user`. Both rest on OpenAI's published API reference. | CrossEngin platform | _unscheduled_ |
| OpenAI also documents `prompt_cache_key` beside `safety_identifier`. Sending the pseudonym there would make the vendor's cache per tenant, which is a cost and isolation decision, not this one. | CrossEngin platform | _unscheduled_ |
| A custom base URL that *is* a proxy to `api.openai.com` (a gateway) receives `user`; whether the proxy forwards it, renames it, or drops it is the proxy's behaviour and is not observable here. | CrossEngin platform | _unscheduled_ |
| Whether OpenAI's regional hosts accept `safety_identifier` exactly as `api.openai.com` does is assumed from their serving the same API, not checked. | CrossEngin platform | _unscheduled_ |
| The lookup recomputes under the current secret only. `CURSOR_ENCRYPTION_SECRET` has no previous-generation ring, so a report older than a rotation cannot be mapped back by this tool; the `no_match` detail says so. | CrossEngin platform | _unscheduled_ |
| The live stage used a stub provider and did not run a `suspended` tenant or the Anthropic arm; see *Verified live*. | CrossEngin platform | _unscheduled_ |

## Live verification plan

PG 16, catalog applied in compose order, API and subcommand as `crossengin_app` (NOSUPERUSER
NOBYPASSRLS), two tenants provisioned over HTTP, a stub OpenAI-compatible server recording request
bodies. Arms: (1) `OPENAI_API_KEY` + `OPENAI_BASE_URL` → stub: chat bodies carry `user`, no
`safety_identifier`, boot line says `in the user field`; (2) default base URL (boot only, no
request): boot line says `in the safety_identifier field`; (3) local provider: `user`; (4)
`--ai-tenant-pseudonym off` with the secret set: no `user`/`safety_identifier`/`ctp_` in any body,
`[cursor] cursor sealing: sealed`, `tenant pseudonym: off`; (5) the flag without `--ai-design`: exit
2; (6) `ai-pseudonym-lookup` with a captured `ctp_` → exit 0 naming the right tenant; with a
`suspended` and a `deleted` tenant's pseudonym → found; with a pseudonym derived under another secret
→ exit 1 `no_match`; secret unset → exit 1 `secret_absent`; malformed argument → exit 2, argument not
echoed; `--secret` → exit 2; control: as the owner the same answers; the secret appears in no output.

## Verified live

PG 16, catalog applied in compose order (extensions, migrate `executed: 990 failed: 0`, `app-role.sql`,
`eraser-role.sql` as a no-op with `DELETION_PGUSER` unset, `document-indexes` 32 of 32). The API and every
subcommand run as `crossengin_app` (`rolsuper f`, `rolbypassrls f`); `CURSOR_ENCRYPTION_SECRET` 44 characters;
a stub OpenAI-compatible server recording request bodies. Tenants alpha and beta provisioned over HTTP; a third,
gamma, inserted as the owner and moved to `deleted` by `UPDATE`. As `crossengin_app`,
`row_security_active('meta.tenants')` was `f` and the row count was 3, equal to the owner's.

- **Custom OpenAI base URL** (`OPENAI_BASE_URL` → stub): boot line `… in the user field`. One design per tenant
  (422 each, one provider call each). Both bodies carried `user` equal to
  `deriveAiTenantPseudonym(parseCursorEncryptionSecret(secret), tenantId)` for that tenant. No body carried
  `safety_identifier`, and no tenant or user id appeared hyphenated, stripped or uppercased.
- **Default OpenAI base URL** (boot only, no request): `openai/gpt-4o … in the safety_identifier field`.
- **Local provider**: boot line `… in the user field`. Three bodies (two sync designs and one job) carried
  `user` with the expected values and no `safety_identifier`.
- **`--ai-tenant-pseudonym off` with the secret set**: `[cursor] cursor sealing: sealed` on stdout. On stderr
  (warn): `tenant pseudonym: off — --ai-tenant-pseudonym off, …`. Three bodies carried no `user`, no
  `safety_identifier` and no `ctp_`. Control: `GET /v1/accounts?limit=1` returned an `s1.` sealed `nextCursor`.
- **Flag refusals**: `off` and `keyed` without `--ai-design` each exited 2 with "requires --ai-design";
  `=bogus` exited 2 naming `keyed|off`.
- **Lookup as `crossengin_app`**: the captured alpha and beta pseudonyms each exited 0 with
  `match … status active`. Gamma's pseudonym exited 0 with `status deleted`. A pseudonym derived under another
  secret exited 1 with `no_match`, `examined: 3 tenant(s)`, and a detail naming rotation. With the secret unset
  the command exited 1 with `secret_absent`; with `short` it exited 1 with `secret_refused` (value not echoed).
  Both refusals were unchanged with `PGPORT` pointed at a closed port, while a valid secret against that port
  failed `ECONNREFUSED`, so neither refusal connects. A raw tenant id, `CTP_…`, and `ctp_` with uppercase hex
  each exited 2 without echoing the argument. `--secret` exited 2. `--format json` produced valid JSON with
  `outcome: "match"`.
- **Controls**: as the owner, the four lookups gave byte-identical stdout. With
  `ENABLE ROW LEVEL SECURITY` and no policy on `meta.tenants`, `crossengin_app` saw `row_security_active t` and
  0 rows. Its lookup exited 1 with `read_confined` rather than `no_match`, while the owner's lookup still
  matched. After `DISABLE`, the app's lookup matched again. The secret value had 0 hits across 56 captured
  output, log and wire files (positive control: 1), and `ctp_<32 hex>` had 0 hits in server logs.

Not run: a real vendor, a `suspended` tenant, and the Anthropic provider.
