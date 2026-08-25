# ADR-0277: The digest template — a pool becomes copy (Phase 4)

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-25 |
| **Authors** | amoufaq5 (with AI assistance) |
| **Reviewers** | _pending_ |
| **Related** | ADR-0276 (digest assembly), ADR-0275 (quiet hours + batching), ADR-0273 (tenant notifications) |

## Context

ADR-0276 turned a pool of held notices into one summary dispatch, but that dispatch carried only a
hash of its variables and a membership list — no words. A tenant's inbox showed a digest with
nothing in it. `@crossengin/notifications` modelled `TemplateContent` for six channels and
`validateRenderInput` to check a context against a template's declared variables, but it had **no
renderer at all**: nothing anywhere turned a template plus variables into text.

## Decision

- **The renderer belongs in the contracts package**, next to the validator that was already there.
  `renderTemplateContent(content, context)` substitutes `{{name}}` placeholders across all six
  channels and returns the rendered title/body/plain-body plus the names it could not fill. A
  missing variable renders **empty and is reported** — never left as a raw `{{name}}` in text a
  person will read, and never thrown.
- **Escaping is chosen per field, not per channel.** A value going into `email.htmlBody`,
  `in_app.htmlBody` or `voice_call.ssmlBody` is markup-escaped (ampersand first, or you
  double-escape); one going into `webhook.payloadJsonTemplate` is JSON-escaped so a quote cannot
  break the payload; plain-text fields are not escaped at all. The in-app body is rendered in a
  browser, so this is the module's security boundary, not a nicety.
- **The platform's default copy is code, not a row.** `meta.notification_templates.created_by` is
  a NOT NULL foreign key to a real user and an `approved` template needs a four-eyes approver —
  a built-in default that ships with the release has neither, and inventing them would be
  fabricated provenance. So `DEFAULT_DIGEST_CONTENT` is a constant, and the table is reserved for
  what it honestly models: **tenant- or operator-authored overrides**.
- **Resolution happens in SQL**, in `PostgresTemplateStore.find`: approved rows only, the tenant's
  own row beating the platform's, then the highest version — compared as
  `string_to_array(version,'.')::int[]`, because a text sort ranks `9.0.0` above `10.0.0`. A
  region-qualified locale falls back to its language (`en-GB` → `en`) with a second query issued
  only on a miss. Reads match `(tenant_id = $1 OR tenant_id IS NULL)`; writes are always
  tenant-scoped, so a tenant can never author the platform default or another tenant's template.
- **An override is untrusted copy.** If rendering it leaves any variable unfilled, or it is written
  for another channel, the built-in default renders instead. A half-substituted notice still
  showing `{{...}}` is worse than the platform's own words.
- **Copy is rendered at read time from the pool**, matching the decision in ADR-0273: the ledger
  stores a hash by design, so the readable half is joined when it is read rather than duplicated
  into a second table. `GET /v1/meta/notifications` gains a `digest` fragment, gated on the
  template id — an ordinary notice's `correlationId` points at a proposal, not a pool, and
  resolving one as the other would render nonsense.

## Consequences

- **Verified live** against a real Postgres, end to end through the running server and the web UI:
  three pooled decisions (two approvals, one rejection) assembled and rendered as
  *"3 notifications — 3 notifications from 2 kinds of update / 2 x Design review approved /
  1 x Design review rejected"*. Inserting a tenant override at `10.0.0` alongside one at `9.0.0`
  produced the **v10** copy — the case a text sort gets backwards. Adding a deliberately broken
  override at the *highest* version (`11.0.0`, referencing undeclared variables) fell back to the
  platform default with **no raw placeholder leaking**. Another tenant saw none of these rows. The
  `/setup` Summaries section rendered both digests.
- `@crossengin/notifications` can now render, not just validate — every template in the catalog
  gains a renderer, not only the digest.
- +115 tests (notifications **63** in templates.test.ts; operate-server **62 files / 1462**). Full
  workspace build + typecheck + test green; operate-web build green.
- One thing the live run exposed: **the tenant inbox is tenant-scoped, not user-scoped**, so an
  admin sees every admin's digest rather than only their own. That predates this change and is the
  next thing to fix in the read path.
- Other follow-ups: no route yet authors a template, so an override must be inserted directly —
  `upsert` exists and is tested but unexposed; `renderedSizeBytes` is not yet checked against
  `CHANNEL_CAPABILITIES[channel].maxBodyBytes` before sending; and the digest's `dedup_sha256`
  remains unused, which is where "you already saw this" would live.
