# ADR-0418: A diagnosis the console had not measured

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-16 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0396 (the viewer identity on `UiViewer`, and its two closure sentences this corrects), ADR-0412 (`operate-web` has no test runner), ADR-0385 (the notifications page and its two grants), ADR-0364 (the users console and the two 404s it already separated), ADR-0334 (a remedy that cannot work is worse than none), ADR-0338 (a remedy that changes the answer for a working deployment), ADR-0301 (credentials never on argv), ADR-0337 (the falsely-true direction) |

## Context

Register P1.16 read as five missing pages. Measuring it found that none of the five harms a
shipped deployment, because none of their server surfaces is mounted, and that the console was
wrong about three things the entry did not name. A refuter aimed at that measurement then found
the first of the three was one member of a class rather than the class.

### Defect 1: seven pages told a user the API was down whenever anything failed

Seven pages appended `Is operate-server running?` to every load failure that did not hit an earlier
arm (aging and WHT: 403; billing: 402/403): the schema-driven home
page, `/platform`, `/platform/reviews`, `/setup`, `/reports/aging`, `/reports/wht` and
`/admin/billing` (`grep -rn "operate-server running" apps/operate-web` before the fix, plus the
proxy's own hint in `app/api/[...path]/route.ts`). Aging and WHT already had a 403 arm; `/platform`,
`/platform/reviews` and `/setup` routed every error to the outage sentence.

So a tenant user who opened a page their role does not reach was told the API was down. On the
shipped flags the tenant list and the design-review queue need `platform_admin`, which resolved
`erp-core` does not declare among its 15 roles, and the AI list needs `erp_admin` or
`platform_admin` — so, by the refuter's derivation from the built pack and the handler code,
**all 15** declared `erp-core` roles were told the API was down on Tenants and Design Reviews and
**14 of 15** on AI Studio. The sidebar renders the Platform section, AI Studio, Settings and Billing
to every signed-in user, so this is one click away for the ordinary tenant persona.

And the one case where the sentence is true was already distinguished: the proxy answers its own
**502 `upstream_unreachable`** only when its `fetch` to operate-server throws. Nothing on the seven
pages read it.

`/admin/billing` was the sharpest member because it needs no role at all. Its first request is
`GET /v1/meta/entitlement`, and the entitlement and usage routes are registered only when a
subscription source exists (`compile.ts` registers `meta.entitlement.read` inside
`if (resolver !== undefined)`). No compose file passes `--license` or `--stripe-webhook-secret`, so
on every shipped deployment the gateway matcher answered **404** `no route for GET
/v1/meta/entitlement` and every signed-in user read *"Could not load your subscription: 404: {…}. Is
operate-server running?"* — a false diagnosis whose implied remedy, restarting the API, cannot work.

The same page carried a **second** false diagnosis: `msg.startsWith("402") || msg.startsWith("403")`
showed *"This workspace's subscription is inactive"*. The entitlement route is registered ungated and
`withEntitlement` answers 402, never 403, so a 403 there can only be a tenant-status-gate or gateway
refusal — and calling it an inactive subscription is a claim nothing supports.

### Defect 2: ADR-0396's identity half was recorded as shipped and was not

ADR-0396 put `userId`, `principalKind`, `displayName` and `email` on `UiViewer`, and its
Consequences say *"the avatar initial comes from a name instead of from `erp_admin`, and `/account`
shows the holder."* Both sentences were false. `ShellBar.tsx` — the only avatar in the app — still
computed `initial = (roleName ?? "A").trim().charAt(0)` from `roleLabel(primaryRole)` and printed
the role; ADR-0396's commit `918c7f1` touched `account/page.tsx`, `Sidebar.tsx` and `lib/schema.ts`
and **not** `ShellBar.tsx`. And `/account`'s change in that commit only replaced the
*"your name and email are not served"* paragraph with a note shown when `viewerName` is `null`, so
when the name *was* resolved the page printed neither name nor email. The server sent both on every
schema read for a resolved person; only one of the three surfaces that ADR and CLAUDE.md say
consumed them (`Sidebar.tsx`) did.

## Decision

**One pure helper, `apps/operate-web/lib/request-failure.ts`, decides what a failed request means,
and the outage hint is given only where no HTTP answer came back.** `classifyRequestFailure(err)`
reads `status`, `code` and `detail` off any `lib/` error **structurally** — `in` narrowing, no
cast, no common base class — and sorts it into four kinds:

| kind | condition | sentence |
|---|---|---|
| `unreachable` | no status, status 0 (`/setup`'s wrapper for a non-HTTP failure), or 502 with code `upstream_unreachable` | `<detail>. Is operate-server running?` |
| `role_refused` | 403 with code `forbidden` | `your role does not grant this (<detail>).` |
| `not_served` | 404 whose detail is the gateway matcher's `no route for …` | `this deployment does not serve it.` |
| `refused` | anything else | `<detail>.` — the server's own words |

`requestFailureSentence` renders them through a **total map** over `RequestFailureKind`, so a fifth
kind is a compile error rather than a fall-through. All seven sites use it, and each keeps its own
more specific arm where it had one: the aging and WHT role panels, and billing's 402. The aging and WHT
arms are an exception to the rule below and are recorded as such: they still read
`msg.startsWith("403")` (`app/reports/aging/page.tsx:34`, `app/reports/wht/page.tsx:45`), so a
tenant-status-gate 403 — `title: "Workspace unavailable"`, no `error` key — is still labelled
*"You don't have access to finance reports"* there. Pre-existing and untouched by this change;
open question 8.

**The code, not the status, is the discriminator**, and both code conditions are load-bearing.
operate-server emits a 502 of its own — `billing-portal-handler.ts` answers
`json(502, {error: "billing_portal_unavailable"})` — so a bare 502 does not prove an outage. And
not every 403 is a role refusal: the tenant-status gate answers `title: "Workspace unavailable"` with
`reason: tenant_reads_blocked` and **no** `error` key, and activation answers
`error: "review_required"`. Every role 403 reachable from the seven pages carries
`error: "forbidden"` (`platform-admin.ts`, `design-review-routes.ts`, `ai-design-routes.ts`,
`aging-handler.ts`, `wht-reconciliation-handler.ts`, `admin-handlers.ts`).

To carry the code, `PlatformError` and `DesignError` gained a nullable `code` (null when the body
carried no `error`) read off the body's `error`, and `lib/api.ts`'s **17** `throw new Error(...)` sites became `ApiError`, whose `message`
keeps the `<status>: <body>` shape it always had — so `parseValidationErrors` and the pages that
read that prefix with `startsWith` are unaffected — while `status`, `code` and `detail` are the
same facts parsed once. `lib/schema.ts`'s fetch throws an `ApiError` too, and `useSchema`'s `error`
is now already a sentence.

**`detailNamesNoRoute` is the one spelling of the gateway's not-mounted 404.** The prefix
`"no route for "` was tested inline at three sites (`account/page.tsx`, `platform/[id]/page.tsx`,
`platform/users/[id]/page.tsx`) and is now one predicate, with the classifier its fourth reader.
It is prose, so a reworded gateway message makes it answer `false` and the page falls back to the
server's own detail — the safe direction. The proxy imports `UPSTREAM_UNREACHABLE` rather than
spelling the string it answers with.

**`/admin/billing` says what is true on the shipped stack and names no flag.** On `not_served` it
shows *"This deployment has no subscription source configured, so no plan applies to this workspace
and nothing is limited by one."* "Nothing is limited" holds because with no resolver the `gate`
wrapper and `withRecordLimit` are not applied, and `node.ts` passes the resolver at both
`buildOperateHttpServer` sites, so the boot and per-tenant servers agree. Only a 402 now means
*inactive*; a 403 falls to the helper.

**`viewerLabel(schema)` is the one spelling of the name-else-role fallback**, read by `ShellBar`
(initial, label, and a `Name · Role` title) and by `Sidebar`, which spelled
`viewerName(schema) ?? roleLabel(schema, primaryRole)` inline. Two spellings is how only one of
them was updated for ADR-0396. **`/account` renders Name and Email rows** exactly when
`viewerName(schema) !== null`, which needs at least the email; a null name reads as a dash rather
than as the role. The server sends `displayName` and `email` together or not at all
(`ui-schema.ts` spreads both only when the identity is non-null, and `UiUserIdentity.email` is a
required string), so the two rows cannot half-appear.

## Consequences

**Typecheck and build, both at HEAD.** `npx tsc --noEmit` in `apps/operate-web` exit 0 after every
edit batch. `next build` compiled with *"✓ Generating static pages (18/18)"* in the run immediately
before the commit, and again as part of the orchestrator's workspace `pnpm -r build` at HEAD
`51b81a7` (`apps/operate-web build: Done`), with `pnpm -r typecheck` reporting `operate-web
typecheck: Done` and exit 0.

**A throwaway probe over 16 error shapes**, compiled from `lib/request-failure.ts` into the
scratchpad and deleted afterwards: a network `TypeError` and `/setup`'s status-0 wrapper read
`unreachable`; both proxy 502 shapes read `unreachable` (*"TypeError: fetch failed. Is
operate-server running?"*); the billing portal's 502 reads `refused` (*"provider said no."*); the
two role 403s read `role_refused`; the tenant-gate 403, the `review_required` 403 and a
code-less notifications 403 read `refused`; both matcher 404s read `not_served` while a handler's
own 404 reads `refused`; a non-JSON 500 reads `refused` and an empty-body 500 renders *"Request
failed (500)."*; and `new ApiError(422, body).message` still reads `422: {…}`.

**Mutation-checked on the probe's compiled copy, never the source.** Dropping the code conditions
(`status === 403 && code === "forbidden"` → `status === 403`, and the 502 equivalent) moved
exactly the three shapes they exist for: the tenant-gate 403 and `review_required` 403 to
`role_refused`, and the billing-portal 502 to `unreachable` (*"provider said no. Is operate-server
running?"*). So both code conditions carry weight.

**Not verified live.** Both operate-server processes the slice could have driven were down
(`curl` exit 7), so every finding here is derived from code, the built registry and the built pack —
as the measurement and the refuter both were; nobody booted the stack and clicked, in any pass. The
orchestrator's own live run at HEAD `51b81a7` (PG 16, non-owner `serving`, both stores) booted the
server with the shipped compose flags minus the `--ai-design` family and `--require-design-review`
(and with `--scheme http`), so the AI Studio and Design Reviews routes were not mounted in that run,
and it drove no console page. The six live arms the slice specified are
open and are the first follow-up below.

**Fenced by nothing that will run again.** `operate-web` has no test runner (ADR-0412, register
P1.3), and the brief forbade adding one, so the only checks left in the tree are `tsc` and
`next build` — and the next refactor could revert any of the seven call sites with both green.
Earlier increments measured that gap from inside it (ADR-0335, ADR-0385, ADR-0398), and ADR-0412
built the runner rule that declared this app's exemption.

**Two closure sentences become true rather than being withdrawn.** ADR-0396's *"the avatar initial
comes from a name … and `/account` shows the holder"* was **wrong when written** — `git log -S'the
avatar initial comes'` names `918c7f1`, the same commit whose diff omits `ShellBar.tsx` and adds no
name or email row to `/account` — and is true as of this change. The record should say *false from
`918c7f1` until this commit*, not rewrite the sentences as still false.

## Corrections

- **CLAUDE.md's `apps/operate-web` entry** states the fallback chain as
  `displayName ?? email ?? primaryRole`. `viewerName` is `displayName ?? email ?? null` and already
  was at `918c7f1`, whose own comment says *"Falling back to the role is what this app used to do
  and is the thing being fixed"*; each caller supplied its own role fallback and ShellBar supplied
  none. **Wrong when written**: `git log -S'displayName ?? email ?? primaryRole' -- CLAUDE.md` names
  `918c7f1`. The role fallback lives in `viewerLabel` now.
- **The measurement named a flag that does not exist.** *"with no `--license-file`/`--license-key`"*:
  the flag is `--license` (`licenseFile` is the options field, `cli.ts`). The conclusion is
  unaffected — the word "license" appears in none of the three compose files nor `.env.example` —
  but the name was about to be carried into the register — register P3.1's `requiresHttpsTransport`
  class, a cited symbol that has never existed.
- **The measurement's prescribed billing remedy was harmful on one of its two arms.** It would have
  told the reader *"an operator enables one with a licence or the Stripe webhook"*. With a resolver
  wired, `compile.ts` wraps every entity handler in `withEntitlement`, `evaluateEntitlement(null)`
  blocks everything including reads, and `PostgresEntitlementResolver.resolve` answers `null` for a
  tenant with no subscription row — so following that sentence with `--stripe-webhook-secret` turns
  every request of every existing tenant into a **402** until each has a Stripe subscription row, and
  takes a secret on argv (ADR-0301). The page is also shown to tenant users who can act on neither
  flag. So the sentence states the fact and names no flag (ADR-0334, and ADR-0338 read the other
  way).
- **Fixing billing alone would have been a count reduction inside the class.** The measurement
  called billing *"the one page of 19"* with the false diagnosis, which is true of the narrow
  predicate (a page fetching an unmounted route family) and false of the defect, which is the
  sentence: billing is 1 of 4 shipped-reachable members. The helper costs about the same as the
  special case.
- **The measurement's two-fields remedy is wrong when written, not a remedy that cannot work.** The
  register said ADR-0396's identity was *"a server-side `UiSchema` change rather than a UI one"*; the
  server half worked and was necessary, and the client half — ShellBar and `/account` — was always
  owed. Filed as *cannot work* it would tell the next reader the identity seam was a mistake.

## Alternatives

**Fix `/admin/billing` alone.** Refused: it is one of four shipped-reachable members of the class,
and the false sentence is the defect, not the unmounted route.

**Key the classification on the status alone.** Refused on two measured counterexamples: the
billing portal's own 502, and two 403s that are not role refusals (the tenant-status gate,
`review_required`). The mutation above is that refutation run.

**Parse the `"<status>: <body>"` message prose.** Refused in favour of `ApiError` carrying the
parsed facts while keeping that message for its existing readers — a reader should not have to
re-parse prose that one constructor already parsed.

**Name the remedy flag on the billing page.** Refused: see the third correction.

**Hide the unreachable sidebar links instead.** Refused for this increment: hiding them honestly
needs the server to say what is mounted and granted, which is a `UiSchema` contract change. The
pages now say *"your role does not grant this"* rather than claiming an outage, which is the
smaller true statement available today.

## Open questions

1. **The live arms.** With the web app in front of the shipped compose: `/admin/billing` as an
   `erp_admin` person should show the no-subscription-source panel and no outage hint, with
   `GET /v1/meta/entitlement` answering 404 `no route for …`; `/platform` and `/platform/reviews` as
   a non-`platform_admin` session, and `/setup` outside `--ai-design-role`, should read *"your role
   does not grant this (insufficient role)."*; stopping operate-server should make `/platform` read
   *"… TypeError: fetch failed. Is operate-server running?"*, the one place the hint belongs; the
   ShellBar's initial, label and title should follow `display_name`, then the email, then the role;
   on `/account` the Name and Email rows should appear only for a resolved person — Name showing
   `display_name` or a dash, Email always the email — while an api-key principal gets no rows and
   the machine-credential note; and three regressions should hold (per-field 422s on entity create, the
   billing portal's 409, the aging and WHT 403 panels).
2. **A non-network throw reads `unreachable`.** A `SyntaxError` from `res.json()` on a malformed 2xx
   has no status and so gets the outage hint. In the browser a fetch failure and a programming bug
   are both `TypeError`s, so there is no clean discriminator; the doc comment says so.
3. **The sidebar still links every user to pages their role cannot reach** — the Platform section,
   AI Studio, Settings and Billing. Only Reports (`FINANCE_ROLES`), WHT (the entity exists), My Inbox
   (`approvals_inbox`) and the entity groups are gated.
4. **`/notifications` lists through a route granted by `--ai-design-role`** while its badge is driven
   by `--read-state-role`, so by the refuter's count 14 of 15 `erp-core` roles get *"insufficient
   role"* on the list behind an unconditional link. That page prints its own message rather than the
   outage hint, so it is outside this class and is live rather than latent.
5. **`/setup`'s *"Could not load review decisions"*** still renders a raw message. It never printed
   the outage hint, so it is outside this increment; it can take `requestFailureSentence` for
   consistency.
6. **Enabling the subscription gate is undocumented and blocks every tenant without a subscription
   row.** No deploy document mentions entitlement or subscription, so the first operator to pass
   `--stripe-webhook-secret` learns the 402 from a dead deployment. Worth a boot line or a README
   paragraph independent of this increment.
7. **P1.16's five named gaps are five different blockers** and want filing as such in the register: no
   server for the incident surface or a report builder, no instance that can exist for an
   orchestration view, and an unmounted route family plus a decision for preferences and deletion.
8. **The aging and WHT role panels are still keyed on the status alone**, so a tenant-status-gate
   403 on those two pages reads as a role refusal — the misdiagnosis the Alternatives refuse for
   status-only keying. Narrowing both arms to `classifyRequestFailure(e).kind === "role_refused"`
   closes it.
