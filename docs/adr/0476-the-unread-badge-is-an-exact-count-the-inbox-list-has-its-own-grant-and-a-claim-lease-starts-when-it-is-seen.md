# ADR-0476: The unread badge is an exact count, the inbox list has its own grant, and a claim lease starts when it is seen

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0385 (notifications page; Q1, Q4, Q6), ADR-0418 (Q4), ADR-0451 (claim lease; Q7), ADR-0447 (digest override and authoring markup; Q4, Q8), ADR-0309 (read state), ADR-0364 / ADR-0376 (the viewer is the credential), ADR-0331 (bigint as string), ADR-0370 (`assertBindArity`), ADR-0372 (tests that pin a defect) |

## Context

Five follow-ups from four earlier records, all on the notification surface. Each was re-measured
against the tree before designing, and two of the briefs' remedies did not survive the measurement.

**The badge counted a page.** `GET /v1/notifications/unread` read one page of notices
(`--read-state-unread-scan`, accepted 1–1000) and partitioned it in process. The notice store clamps
any page to `NOTIFICATION_LIST_MAX_LIMIT = 200`, so 201–1000 were accepted and silently served 200,
and a viewer with more than 200 notices saw a floor, flagged only by `truncated`. The response had
no way to say *how many* it had not looked at. The read-state tables were already indexed for the
exact question: `notification_read_states` UNIQUE `(tenant_id, user_id, dispatch_id)`,
`notification_read_watermarks` UNIQUE `(tenant_id, user_id)`, dispatches `(tenant_id, queued_at)`,
deliveries `(dispatch_id, attempt_number)` — measured in the catalog, none missing.

**The inbox list was granted by the AI design roles.** `node.ts` passed `--ai-design-role` into the
list route's one `allowedRoles` set, so whether a person could read their own inbox depended on
whether they could design manifests, while the badge counting the same notices was granted by
`--read-state-role`. The two could disagree about who may see the page (ADR-0385 Q6, ADR-0418 Q4,
register P1.16c).

**A `rendering` row with no `started_at` was reclaimable at once** (ADR-0451 Q7). The claim predicate
read `started_at IS NULL OR started_at < now() - lease`. A row a pre-ADR-0451 replica claimed carries
no claim time, so every drain tick reclaimed it, and a fan-out longer than the lease could be taken
by a second drain while the first was still sending. The brief proposed falling back to `queued_at`
or `updated_at`. `meta.notification_dispatches` has **no `updated_at`**, and `queued_at` is refuted:
a backlog queued long before it was claimed is "lapsed" by `queued_at` the instant it is claimed, so
the fallback reclaims exactly the rows the predicate already did.

**A refused digest override fell back silently** (ADR-0447 Q8). `renderDigest` dropped a tenant's
authored digest template for the platform default on any of four conditions and said nothing. The
brief said the drain should report it; measured, `renderDigest` has one caller, `node.ts`'s
`resolveDigest`, on the **read** path of `GET /v1/meta/notifications` — the drain never renders a
digest's copy. So the report belongs on the read path, and the read path runs on every inbox poll.

**Authoring admitted a placeholder where it is not escaped** (ADR-0447 Q4). A placeholder is
substituted HTML-escaped (quotes included) and spaces are not, so it is safe in element text and in a
quoted attribute value and nowhere else in a tag. `<{{x}}>` and `</{{x}}>` were invisible to the tag
scanner (`<{` opens no tag), `<a {{x}}=1>` read as the attribute `x`, and `<a title={{x}}>` passed
because `title` is allowed — and renders as `title=a onmouseover=…`.

## Decision

1. **The count is the store's, exact, and reads no page.** `PostgresNotificationStore.unreadCountFor`
   is one statement: a `WITH` over the viewer's watermark, then `count(*)` of the tenant's dispatches
   with `NOT EXISTS` a read-state row for `(tenant, user, dispatch_id)` and
   `queued_at >= date_trunc('milliseconds', read_through_at) + 1 ms`. The comparison is the contract's
   own `isUnread` (both instants compared at millisecond precision, `q > w`), written sargably; the
   equivalence was checked live against the non-sargable `date_trunc(q) > date_trunc(w)` form. The
   channel and the recipient scope are bound parameters; an empty recipient list is bound as `'{}'`,
   so the statement answers 0 by itself rather than by a short-circuit. `count(*)` arrives as a
   string and is parsed and refused if not a non-negative safe integer; a missing row throws.
   The route answers `{unread, exact: true, readThroughAt}`. `truncated` is not emitted any more:
   nothing about the figure is a floor.
2. **The partition is a window with an honest size.** `?detail=partition` lists through the
   notification listing with `limit` 1–200 (`UNREAD_PARTITION_WINDOW_MAX`, the store's own clamp) and
   `cursor` (the listing's cursor), and returns `examined`, `nextCursor` and `truncated`
   (`nextCursor !== null`, kept because the window is still a page). A limit outside 1–200 or
   a cursor the listing cannot read is **400**, not clamped; `limit` or `cursor` on the plain count is
   **400**, because the count takes neither. `--read-state-unread-scan` is **refused by name** at
   parse with the replacement — a flag that is accepted and changes nothing is a remedy that cannot
   work.
3. **The list has a self grant and a tenant grant.** `selfRoles` replaces `allowedRoles` and lists
   the caller's own notices only; `tenantScopeRoles` lists the tenant (audited as before). A holder of
   either is admitted. `node.ts` grants the self list from the read-state roles when any are granted,
   falling back to `--ai-design-role` only when none is, and the `[notifications]` boot line says
   which governs (warn on the fallback). A self-grant holder asking `?scope=tenant` keeps its own
   list. With no identity resolver every list is the tenant's, so a self-only caller is refused
   `self_scope_unavailable` rather than handed it — unreachable from `node.ts`, which builds the
   resolver with the store, and stated so a deployment-supplied context fails closed.
4. **A claim lease starts when the claim is seen.** `claimQueued` first stamps `started_at = now()` on
   this tenant's `rendering` rows that have none, under `FOR UPDATE SKIP LOCKED`, and the claim
   predicate requires `started_at IS NOT NULL` before calling a lease lapsed. An unstamped row is
   therefore reclaimed one lease after it is first seen, not at once. A drain renews its claim with
   `renewClaim` (an `UPDATE … WHERE status = 'rendering'`, tenant-scoped) every `lease / 3`, paced by
   the drain's clock and aged from the batch's claim time. **Every row the batch still holds is
   renewed, not only the one being drained**, because a batch is claimed together and drained one
   dispatch at a time, so the rows behind a long fan-out age with it; a row is released from the
   batch's held set once its dispatch has been drained. A refused renewal is reported through
   `onError` and the drain continues.
5. **A refused digest override says why, once.** `decideDigestOverride` is the one decision, with four
   reasons (`override_channel_not_rendered`, `override_refused_source`, `override_missing_variables`,
   `override_refused_rendered`). `renderDigest` returns `overrideRefusal` and calls a **required**
   reporter that travels with the override. The report carries the tenant, the template row's id,
   version, locale, the reason and a missing-variable count — **no body content**, not the source, the
   rendering or a variable name. `onceDigestOverrideReporter` says each (tenant, template, version,
   reason) once and, when its bounded memory fills, clears rather than freezes, because repetition is
   the honest failure and silence is not.
6. **Authoring refuses a placeholder outside element text or a quoted value.** A placeholder in a tag
   name (opening, closing or spaced) is `unsafe_markup` "placeholder in a tag name"; anything left in a
   tag after removing quoted values that still contains `{{` is `unsafe_markup` "placeholder in a tag
   outside a quoted attribute value". `<p>{{x}}</p>` and `<p title="{{x}}">` are kept. The digest
   renderer reads the same function, so a stored override in either shape now falls back as
   `override_refused_source`.

The rule across all six: **a figure, a grant and a lease each say what they are about.** A count says
whether it is exact; a list says whose rows it may return; a lease is aged from a time it actually
recorded; a fallback says why it fell back.

## Alternatives considered

- **Keep the page scan and raise its limit.** Refused: any page is a floor for someone, and a limit
  past the store's clamp is silently ignored, which is how 201–1000 came to be accepted.
- **Count in process over every page.** Correct and unbounded per request; the indexes the SQL needs
  already exist.
- **`COALESCE(started_at, queued_at)` for the lease.** Refuted above: a long-queued backlog is lapsed
  on arrival, so it reclaims the same rows. `updated_at` does not exist on the table.
- **Report a digest refusal on every render.** The render runs on every inbox poll of every viewer, so
  an unconditional reporter is noise an operator filters, taking the finding with it.
- **A sanitiser for placeholders in tags.** Refused for the authoring route's existing reason: a body
  rewritten silently shows the author something they did not write.
- **Make the self list fall back to the tenant list when no resolver is wired.** That is the leak the
  recipient filter exists to close.

## Consequences

- The badge is exact on any inbox size. A client reading `truncated` from the count sees it absent,
  which reads as false; a client rendering "N+" from it stops doing so. `examined` and `truncated`
  are present only with `?detail=partition`, where they describe the window.
- A deployment passing `--read-state-unread-scan` refuses to start, with the replacement named.
- On the shipped compose the self list's grant is unchanged in membership (read-state and AI design
  roles are both `erp_admin`, `platform_admin`); a deployment granting read state to more roles now
  grants those roles their inbox too.
- `claimQueued` issues one extra `UPDATE` per tick per tenant (zero rows in the common case).
- Once a third of the lease has passed since the last renewal, the next drain step issues one
  `UPDATE` per row the batch still holds (at most the batch size, 25 by default).
- A digest override that the platform would refuse is logged once per version and reason, at warn,
  under `[notifications]`.
- Stored templates with a placeholder in a tag name or an unquoted attribute position no longer
  render as authored; the digest falls back and says so.

## Implementation notes

- `apps/operate-server/src/notification-store.ts`: `unreadCountFor`, `parseNotificationListCursor`,
  `NOTIFICATION_LIST_MAX_LIMIT` exported.
- `apps/operate-server/src/read-state-routes.ts`: count from `unreadCountFor`;
  `decidePartitionWindow`, `UNREAD_PARTITION_WINDOW_MAX`; the scan constants are deleted.
- `apps/operate-server/src/notification-routes.ts`: `selfRoles`, `self_scope_unavailable`,
  `notificationListGrant`, `formatNotificationListGrant`.
- `apps/operate-server/src/delivery-store.ts`: the stamp statement, the `IS NOT NULL` predicate,
  `renewClaim`, `claimLeaseMs` readable. `apps/operate-server/src/delivery-drain.ts`:
  `CLAIM_HEARTBEAT_FRACTION`, the heartbeat at the start of each dispatch, after each recorded
  attempt and before each send.
- `apps/operate-server/src/digest-template.ts`: `decideDigestOverride`, `DIGEST_OVERRIDE_REFUSALS`,
  `onceDigestOverrideReporter`; `renderDigest` takes `override: {template, onRefused}`.
- `apps/operate-server/src/notification-template-routes.ts`: `PLACEHOLDER_TAG_NAME_RE` and the
  quoted-value check in `scanAttributes`.
- Shared files: `node.ts` (the list grant and its boot line, the once-reporter on `resolveDigest`,
  the removed `unreadScanLimit`), `cli.ts` (the flag refused by name, `--read-state-role` help).
- Tests: the delivery-store fake now calls `assertBindArity`, models the stamp and the renewal, and
  requires a claim time before a lease lapses; the notification-store count fake calls
  `assertBindArity` and throws on any other statement. Two existing tests that pinned the old
  behaviour were rewritten rather than deleted (ADR-0372): the crash-recovery test expected an
  unstamped row to be reclaimed at once, and a digest test asserted the source scan could not see a
  tag-name placeholder. Mutation-checked: restoring `started_at IS NULL OR` in the claim predicate,
  making the heartbeat skip every renewal, disabling the self-scope refusal, and disabling each of the
  two authoring arms each fails at least one test (1, 3, 1, 4 and 3 failures). After review:
  renewing only the row being drained (`[...held].slice(0, 1)`) fails the held-batch test.

## Verification

Live on PostgreSQL 16.15, the catalog applied with `crossengin apply --confirm` as the owner (994
statements) and `deploy/postgres/roles/app-role.sql` run as the compose does, the API connecting as
`crossengin_app` (NOSUPERUSER, NOBYPASSRLS, owning no table), `--store pg`.

- **Exact count.** A viewer with 253 delivered in-app notices, a watermark at `00:19:00.000400`,
  explicit reads of five notices past it and one under it, and one notice queued at
  `00:19:00.000900` (same millisecond as the watermark). `GET /v1/notifications/unread` answered
  `unread: 227, exact: true`; `?channel=in_app` the same. Controls: the partition paged with
  `limit=200` (examined 200, then 53 via `cursor`) unioned to 227 unread and 26 read — the contract's
  own `partitionByRead` over all 253 — and an owner-side SQL in the non-sargable
  `date_trunc(q) > date_trunc(w)` form answered 227. The admin, with 40 own notices and no read
  state, answered 40. `ap_clerk` (no read-state role) answered 403. `?limit=50` on the count, and
  `limit=201` or `cursor=garbage` on the partition, answered 400.
- **Grant split.** Started with `--read-state-role erp_admin --read-state-role erp_viewer`; the boot
  line read `own-inbox list granted to the read-state roles: erp_admin, erp_viewer`. `erp_viewer`
  listed its own notices (200 rows, `scope: self`); with `?scope=tenant` it still got `scope: self`;
  `ap_clerk` got 403.
- **Lease.** A `rendering` row with `started_at` NULL: the pre-change predicate, run as the same role,
  selected it at once (control). `claimQueued` claimed nothing and stamped it; a second claim inside
  the lease claimed nothing; after the stamp was aged two minutes past a 60 s lease the next claim
  took it, while a second unstamped row was stamped and left. `renewClaim` moved a `rendering` row's
  `started_at`, and answered `false` for a completed row and under another tenant.
- **Authoring.** With `--notification-template-routes`, `POST /v1/notification-templates` answered 422
  `template_content_rejected` for `<{{name}}>`, `</{{name}}>`, `<a {{name}}=1>` and
  `<a title={{name}}>`, naming the construct; `<p>Hello {{name}}</p>` answered 201 and
  `<p title="{{name}}">` passed content validation (409 on the reused version).
- **Not verified live:** the digest-override report (unit-tested only: one report per version and
  reason, none for an applied override, no body content in the event) and the drain heartbeat under a
  real slow provider (unit-tested with a stepping clock).

## Open questions

1. **A renewal does not prove ownership.** `renewClaim` renews any `rendering` row, so a drain whose
   claim lapsed and was taken by a second drain can renew the second drain's claim. A claim token on
   the row would close it; there is no column for one.
2. **A single step longer than two thirds of the lease still lapses.** The heartbeat runs between
   steps; a provider send that outlasts the remaining lease is not renewed during the send.
3. **`override_refused_rendered` is reachable, through a scheme in a substituted value.** A value is
   escaped for markup (`<`, `>`, quotes) and not for a URL scheme, so a digest member whose stored
   `templateId` carries `javascript:` puts the scheme into `{{itemLines}}` and only the rendered
   whole-body scheme check sees it (tested). `meta.notification_dispatches.template_id` constrains only
   length, so it is reachable from a stored row and from no in-repo producer.
4. **The count's watermark disjunction** (`w.read_through_at IS NULL OR …`) keeps the planner from a
   range scan on `(tenant_id, queued_at)`; at the measured sizes the plan is a scan of the tenant's
   dispatches with an index-only anti-join on read states. Large tenants may want the two arms split.
5. **The web client** still reads `examined`/`truncated` from the count response and does not page the
   partition with `cursor`; that is the console's change, not this one. The partition keeps
   `truncated`, which `apps/operate-web/app/notifications/page.tsx` renders its "read state Unknown"
   banner from — but that banner also says "the unread figure above is a floor", which is false now,
   and a comment beside it names `--read-state-unread-scan`, which is refused.
6. **With no identity resolver, a tenant-scope holder reading the default (self) scope gets the
   tenant list without the tenant-scope audit row.** Unreachable from `node.ts`; a context that
   omits the resolver should probably route that read through the audited arm.

## Review

An adversarial review of this record's first version found and fixed three defects:

1. **The heartbeat renewed only the row being drained.** A batch (25 by default) is claimed in one
   statement and drained one dispatch at a time, so during a long fan-out on the first dispatch every
   later row in the batch aged unrenewed, could lapse, and could be reclaimed and sent by a second
   drain before this one reached it — the duplicate delivery the lease exists to prevent. The
   heartbeat now renews the batch's held set and releases a row once its dispatch is drained.
2. **The partition dropped `truncated` along with the count.** `apps/operate-web` renders its
   explanation for "Unknown" rows from `partition.truncated`, so removing it silenced the explanation
   while the rows still read Unknown. It is kept on the partition, where it is true.
3. **Open question 3 claimed `override_refused_rendered` was probably unreachable.** It is reachable
   through a scheme in a substituted value; a test now exercises it.

Re-verified live after the fixes, same cluster and data, API as `crossengin_app`: the count answered
`unread: 227, exact: true` with no `truncated`; the partition answered `examined: 200`,
`nextCursor` set, `truncated: true` (197 unread), and its second page `examined: 53`,
`nextCursor: null`, `truncated: false` (30 unread) — 197 + 30 = 227; `ap_clerk` 403 on the count;
`erp_viewer` 200 on its own list. The batch-wide renewal is unit-tested only (its SQL is the
`renewClaim` statement measured above); it was not run against a slow real provider.

## References

- `apps/operate-server/src/notification-store.ts`, `read-state-routes.ts`, `notification-routes.ts`,
  `delivery-store.ts`, `delivery-drain.ts`, `digest-template.ts`, `notification-template-routes.ts`
- `packages/notifications/src/read-state.ts` (`isUnread`, `partitionByRead`)
- ADR-0385, ADR-0418, ADR-0447, ADR-0451
