# ADR-0478: operate-web runs its own tests, and the console stops answering small questions wrongly

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-25 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0412 (the test-runner rule and its one exemption), ADR-0385 (the notifications page and the badge), ADR-0398 (the proxy's response headers), ADR-0418 (request-failure classification), ADR-0435 (design review), ADR-0430 (the starter jobs and their account codes), ADR-0447 (the console's web hardening), ADR-0448 (sessions and sign-out), ADR-0475 (the aging `asOf` refusals), ADR-0476 (the exact unread count) |

## Context

`apps/operate-web` was the one workspace member with TypeScript and no test runner.
`TEST_RUNNER_EXEMPT_MEMBERS` carried it with its consequence (ADR-0412), and ADR-0385 had measured
what that costs: deleting the notifications page's one publish line left both `tsc` and
`next build` green, so a UI fix there was fenced by nothing. The only tests of the app's own code
lived in `packages/testing/src/operate-web.test.ts`, which imported the app's modules across the
package boundary because the app could not run them itself.

Beside that, the console answered a set of small questions wrongly. Each was re-measured against the
tree before it was changed:

- **Two unused bindings** survived because the app set neither `noUnusedLocals` nor
  `noUnusedParameters`: `lib/schema.ts`'s `roles` in `inboxEntitySpecs` (`viewerActions` already
  filters by role) and the `schema` prop on `RelatedRecords` in `app/e/[slug]/[id]/page.tsx`.
  Turning both options on produced exactly those two errors.
- **A malformed 2xx body read as an outage** (ADR-0418 Q2). `classifyRequestFailure` sent every
  error without a numeric status to `unreachable`, whose sentence ends *"Is operate-server
  running?"* — including the `SyntaxError` that `Response.json()` throws on a body it cannot parse,
  which means a response *did* come back.
- **A sibling subdomain could read through the proxy** (ADR-0447 Q5). `crossSiteRefusal` admitted
  `GET`/`HEAD` before consulting `Sec-Fetch-Site`, and the session cookie is `SameSite=Strict`, which
  a same-*site* request carries. So a page on `evil.example.com` could make a viewer's browser `GET`
  `erp.example.com/api/*` with that viewer's session; the response is unreadable to the page, but a
  read can have an effect — an audit-read route writes a row per read.
- **`/setup` lost review decisions on a busy tenant** (ADR-0385 Q7, ADR-0418 Q5). It read the newest
  50 in-app notices and kept the decisions and digests among them; the scouting pass for this ADR
  reported 0 of 253 on a busy inbox. The list route already filters by `templateId`. Its error arm
  also rendered a raw message rather than the sentence every other page now uses.
- **A tenant-status 403 read as a role refusal** on the three report pages (ADR-0418 Q8): each
  tested `msg.startsWith("403")`, and `--tenant-status-gate` is on in the shipped compose, so a
  suspended tenant's reader was told their role was insufficient.
- **The design review page did not say who designed the proposal** (ADR-0435 Q3), so a reviewer
  could not see the fact `designer_cannot_approve` refuses on.
- **The settings form could not set six finance account codes** (ADR-0430 Q6) that the starter jobs
  and the inventory postings read: depreciation expense, accumulated depreciation, inventory, COGS,
  GRNI and inventory price variance. The save already preserved keys the form does not manage, so a
  code set by the starter chart survived a save; it simply could not be set here.
- **Sign-out ignored the server's answer** (ADR-0448 Q8). `/api/auth/logout` always clears the cookie
  and answers `{ok, ended}`, where `ended` is whether operate-server revoked the session. The shell
  read nothing from the body, so a sign-out whose server half failed looked the same as one that
  succeeded, while the token stayed valid until its TTL for anyone holding a copy.
- **The aging picker offered dates the server refuses** (ADR-0475). The server answers a past or
  malformed `asOf` with 400 `as_of_not_served` / `as_of_malformed`, comparing against its own UTC
  date; the page offered any date and rendered either refusal as a generic error.
- **The notifications page described an unread count that no longer exists** (ADR-0476). The count
  is now one SQL anti-join answered with `exact: true`, while the page still rendered
  *"N+ unread of M examined"* from `truncated`/`examined` and showed a banner calling the figure a
  floor and naming `--read-state-unread-scan`, which the server now refuses by name. Separately, the
  per-row read state came from a single 200-notice partition window, so every row the page loaded
  past it read **Unknown** although the partition is pageable with the listing's own cursor.

## Decision

**The app has a runner, and the exemption is gone in the same change.** `apps/operate-web` gains a
`vitest.config.ts` (the shared `vitestPreset`, node environment, the `@/*` alias matching
`tsconfig.json`'s paths, `.next/` excluded), a `test: vitest run` script and devDependencies on
`@crossengin/testing` and `vitest`. `packages/testing/src/operate-web.test.ts` is deleted and its
cases moved into the app (`lib/session.test.ts`, `lib/csv.test.ts`, `lib/proxy-guard.test.ts`,
`security-headers.test.ts`, `app/api/guards.test.ts`). `TEST_RUNNER_EXEMPT_MEMBERS` is `{}`: the
biconditional now requires the runner, and the rule's own tests pass their exemption map explicitly
so the shape tests do not depend on the real map being non-empty. The app's `tsconfig.json` sets
`noUnusedLocals` and `noUnusedParameters`, and the two errors are fixed.

**The rule for the helpers is that a pure function the page depends on is where the decision lives
and where it is tested.** No jsdom; every change below that carries a decision is a function in
`lib/` with its own test, and the page calls it.

- `forwardedResponseHeaders` and `NULL_BODY_STATUSES` move from the proxy route to `lib/upstream.ts`
  verbatim, so they are testable; the route imports them, and a text test fences against a second
  spelling in the route.
- `REQUEST_FAILURE_KINDS` gains **`malformed_response`**: a `SyntaxError` with no status, with its
  own sentence in the total map (*"the API answered, but with a body this page could not read …"*).
  A `TypeError` stays `unreachable`, because that is what a failed `fetch` throws.
- `crossSiteRefusal` holds a read to **`Sec-Fetch-Site: same-origin` or `none`** (a user navigation)
  and refuses `same-site` and `cross-site` with 403; a write still needs `same-origin`. With no
  `Sec-Fetch-Site`, the `Origin` host comparison is unchanged, and a read carrying neither header is
  admitted, because Chromium and Firefox send no `Origin` on a same-origin `GET` and refusing that
  arm would refuse every page load in a browser sending no `Sec-Fetch-Site`. Two populations reach
  it: an engine that predates the header (Safari before 16.4, March 2023), and **every** engine on a
  console served over plain HTTP from a non-`localhost` host, since Fetch Metadata is sent only to a
  potentially trustworthy origin. The shipped stack terminates TLS at Caddy, so it is held by the
  first arm; a plain-HTTP deployment gets no read protection from this. `OPTIONS` stays
  credential-free.
- `/setup` reads one page per template through `listSetupNotices` (`SETUP_NOTICE_TEMPLATE_IDS` is
  derived from the decision map plus the digest template) and merges them de-duplicated, newest
  first, through `mergeNoticePages`. One failed template fails the read: a page silently missing the
  rejections would be a wrong answer. The error renders `requestFailureSentence(e)`.
- The aging, WHT and period-close pages decide a 403 panel with
  `classifyRequestFailure(e).kind === "role_refused"` and otherwise render the sentence, so a
  tenant-status 403 reads as what it is.
- `Review.designedBy` is optional-and-nullable, and `designedByLabel` keeps the two absences apart:
  an absent field (this server does not send it) shows nothing, `null` shows *"not recorded"*. The
  page prints it beside "reviewed by" and on pending proposals.
- `lib/finance-settings.ts` declares the account-code fields once (`ACCOUNT_CODE_FIELDS`, now
  eighteen, with the six added), and `buildFinance` / `FORM_FINANCE_KEYS` / `unmanagedFinance` are
  derived from it. The save keeps preserving keys the form does not manage, and the help text says
  what each new code is read by.
- Sign-out reads the body. `signOutDestination` sends the browser to
  `/login?signed_out=session_open` **only on an explicit `ended: false`**; a body this build cannot
  read claims nothing. The login page reads the parameter after mount (from `window.location`, for
  the static-prerender reason it already reads `next` that way) and says the server session could
  not be ended and stays valid until its time limit.
- The aging picker's `min` is the server's date when the server has reported one (the response's
  `asOf` to a request without one), else this browser's clock in UTC; `agingAsOfRefusal` renders each
  refusal code with its own sentence, and a refusal hides the stale table rather than showing it
  under a new date.
- The notifications page reads `exact` and renders `unreadCountLabel` — `N unread`, or `N+ unread`
  only when the server did not say the figure is exact (a server a build behind ADR-0476). The floor
  banner is deleted. `examined` and `nextCursor` now live on `UnreadPartition` alone, describing the
  partition window and never the count, and `fetchUnreadPartitionCovering` pages the partition with
  the listing's cursor until it covers every row the page has loaded. "Load more" extends it; "Mark
  all read" re-reads it over the loaded count. A partition extension that fails keeps the partition
  already held. An extension reads only the pages after the partition it starts from
  (`partitionPagesAfter`) and lands onto the partition the page holds **by then**
  (`extendPartitionOnto`), through a ref the page writes on every change; extensions run one after
  another, and one started while a full re-read is in flight, or before any partition has landed,
  becomes a re-read of its own (see the review addendum).

## Alternatives considered

- **Keep the tests in `packages/testing`.** It worked, and it is the reason the app could carry an
  exemption: a test suite outside the member fences the member's code and leaves the member reading
  as runnerless. Moving them is what lets the biconditional hold for every member with no exception.
- **jsdom and React component tests.** Refused for this increment: every decision here can be a pure
  function, and the brief excluded a browser environment. The cost is that the pages' wiring (that a
  page calls the helper) is fenced by `tsc` and the call sites rather than by a test.
- **Refuse every proxy read without `Sec-Fetch-Site`.** Rejected: it would break the residual engines
  that send neither header for a same-origin `GET`, and the `Origin` fallback is the brief's
  instruction. Admitting `none` for a read is what keeps a typed URL or a bookmark working.
- **Derive the notifications page's read state from `readThroughAt`.** Rejected as before (ADR-0385):
  `isUnread` also consults the per-notice rows and fails open on an unparseable `queuedAt`, so a
  client rule would disagree with the server on exactly the rows not to hide. Paging the partition is
  a second request, not a second derivation.
- **One partition window of 200 with Unknown past it**, which is what shipped. Kept honest but
  needlessly incomplete once the partition was pageable.
- **Changing `/api/auth/logout` to answer `ended: null` when there was no cookie**, so the warning
  could not fire for a browser holding no session. Not taken: the handler is outside this slice, and
  the sign-out button is reachable only signed in, where the cookie exists.

## Consequences

- `apps/operate-web` runs **192 tests in 11 files** (186 as first written; the review added six); `pnpm --filter @crossengin/operate-web test`
  joins the workspace's test sweep, and the test-runner rule exempts no member.
- A same-site read through the proxy is now a 403. A deployment that served a second console or a
  tool on a sibling subdomain that read `/api/*` with the viewer's cookie stops working; that is the
  hole closed, not a regression.
- The settings form can set all eighteen account codes; nothing about what the server accepts
  changed.
- The notifications page asks for more partition pages as more of the list is loaded, at most one
  extra request per "Load more" of up to 200 notices.
- The two `@typescript-eslint/no-unused-vars` suppressions in `eslint-suppressions.json` for
  `lib/schema.ts` and `app/e/[slug]/[id]/page.tsx` no longer occur. The file is outside this slice
  and was left unpruned, and **an unpruned suppression is itself a failure**: measured,
  `npx eslint apps/operate-web/lib/schema.ts "apps/operate-web/app/e/[slug]/[id]/page.tsx"` (two files
  with no lint error of their own) exits **2** with *"There are suppressions left that do not occur
  anymore"*. So the two entries must be pruned in the commit that carries this change, or the lint
  job gains a reason to be red that is this change's.

## Implementation notes

- `apps/operate-web/vitest.config.ts` merges the preset with an `@` alias resolved from the config's
  own URL, and includes `**/*.test.ts` with `node_modules/**` and `.next/**` excluded.
- The test-runner rule's real-workspace floor gained a bound on `apps/operate-web`'s TypeScript count
  (`< 110`, so a count over `.next/types/**` fails) and a floor of seven test files, because a member
  whose test files all vanished would still pass the biconditional.
- `security-headers.mjs` is loaded by its test through `new URL(relative, import.meta.url).href`.
- `SIGNED_OUT_PARAM`, `SIGNED_OUT_SESSION_OPEN`, `SIGNED_OUT_SESSION_OPEN_NOTICE`,
  `signOutDestination` and `signOutNotice` live in `lib/session.ts` beside `LOGIN_PATH` and
  `NEXT_PARAM`.
- `fetchUnreadPartitionCovering` takes its page fetcher as a parameter for the tests; it caps each
  request at the server's window (`UNREAD_PARTITION_WINDOW_MAX = 200`) and stops on a page that
  examined nothing, so a server answering an empty page with a cursor cannot hold it in a loop.
- `UNEXAMINED_TITLE_BY_KIND.available` no longer speaks of "the window the server examined".

## Verification

Not live: this slice changes no SQL and no server route (`needs_live_pg: false`). Verified offline:

- `pnpm --filter @crossengin/operate-web test`: 11 files, 192 tests, green (after the review).
- `pnpm --filter @crossengin/operate-web typecheck` and `npx tsc --noEmit` in the app: exit 0 with
  `noUnusedLocals` and `noUnusedParameters` on.
- `npx next build` in the app: exit 0, every page built, run alone.
- `pnpm --filter @crossengin/testing build`, `typecheck` and `test`: 23 files, 810 tests, green with
  the exemption deleted.
- Mutation-checked one test per helper by string replacement reversed and hash-checked afterwards,
  never by `git checkout`: removing the `malformed_response` arm, admitting a same-site read, dropping
  formula escaping in `csvCell`, forwarding `set-cookie`, warning on any non-`true` `ended`, reading
  `exact` as always true, accepting any status in `agingAsOfRefusal`, removing `designedByLabel`'s
  absent arm, and dropping one account-code field were each caught by a failing test. Removing the
  empty-page guard in `fetchUnreadPartitionCovering` made its test **hang** rather than fail: the
  injected fetcher resolves in a microtask, so the loop never yields to the timer that would fire
  vitest's timeout. The process was killed and the source restored; the guard is what prevents the
  hang, and a test of a loop over an immediately-resolving promise cannot rely on the test timeout.
- `eslint` over the changed files reports no new error from this change; it reports two pre-existing
  ones (`app/admin/settings/page.tsx`'s `raw as Record<…>` assertion and `lib/session.ts`'s control
  character class, both present at HEAD), and the root `lint` is already red on files added after
  the suppressions were recorded (`lib/csv.ts`, `lib/money.ts`, `lib/period-close.ts`).

## Review addendum

An adversarial pass over the first draft found four defects, all fixed in this change.

1. **A partition extension could undo a mark the page had just shown.** `extendPartition` built on
   the `partition` its render's closure held and replaced the page's partition with the result. So a
   "Load more" whose extension landed after "Mark all read" laid the pre-mark answer for every
   earlier row over the post-mark re-read (rows the viewer had just cleared read **Unread** again),
   and one landing after a per-row mark undid that mark; and a "Load more" before the first partition
   had landed extended nothing, leaving the new rows **Unknown**. Fixed as above: the extension reads
   only the new pages, lands onto the partition held at landing time, and drops itself when that
   partition no longer ends where the extension began. `extendPartitionOnto` and
   `partitionPagesAfter` carry the decision and four tests; mutation-checked by merging onto the base
   instead of the current partition (1 failure) and by dropping the cursor comparison (1 failure).
2. **The read-residual claim was false.** The draft said a read with neither header could come only
   from "a pre-2020 engine"; the code comment beside it said Safari before 16.4, which shipped in
   2023, and neither named the larger population, a console served over plain HTTP, where no browser
   sends Fetch Metadata. Both texts now say so.
3. **Nothing kept the form's account-code list equal to the server's.** The defect this change closed
   was a code the server reads that the form did not know about, and the fix was a hand list. A test
   now reads `packages/operate-runtime/src/settings.ts` as text and requires
   `ACCOUNT_CODE_FIELDS` to equal the `*AccountCode` keys `FinanceSettingsSchema` declares, both
   ways, with a floor of 18; mutation-checked by dropping `taxRecoverableAccountCode` (not one of the
   six the existing tests named), which only the new test caught.
4. **The unpruned suppressions were described as a report, and are an exit code.** Above, under
   Consequences.

Found and left, because each is outside this slice's files: `app/api/auth/logout/route.ts`'s header
comment still says *"the shell's sign-out button navigates away and does not read it yet"*, which this
change made false, and its *"which `packages/testing`'s M-07 fence reads by position"* names the file
this change deleted (the fence is `app/api/guards.test.ts` now);
`packages/testing/src/strategy/ci-workflow.test.ts` says operate-web is excluded from the test sweep
*"because it has no vitest config and no tests"*; and `apps/operate-server/src/read-state-routes.ts`
says the partition's `truncated` is what `apps/operate-web` renders its Unknown explanation off,
while this change deleted that banner and reads `nextCursor` instead.

## Open questions

1. **`canAccess` and `viewerActions` fail open on an empty role list** (`lib/schema.ts`): with no
   viewer roles the console shows every action. The server authorizes every request, so this is a
   display claim and not an authorization hole, but it is the opposite of this repo's rule.
2. **`/setup`'s per-template read drops the `proposal.reviewStatus` fallback** that `decisionOf`
   keeps for a template this build does not know: a decision notice under a new template id is not
   fetched at all until the template is added to the map.
3. **The notifications page assumes the list and the partition cover the same notices.** Both are
   self-scoped through the same identity lookup today; a page that listed the tenant-wide inbox would
   need the partition to be asked for the same scope, or every row past the viewer's own would read
   Unknown again.
4. **The logout handler answers `ended: false` when the browser held no session cookie**, which
   `signOutDestination` cannot tell from a failed revocation. Unreachable from the shell's button;
   reachable from a direct `POST`.
5. **`eslint-suppressions.json` needs pruning** for the two suppressions this change made unused, and
   the root `lint` is red on later-added files independently of this change.
6. **No test fences that a page calls its helper.** A page could stop calling `signOutDestination` or
   `unreadCountLabel` and stay green; a component-test environment would close that, and was refused
   here.

## References

- `apps/operate-web/vitest.config.ts`, `apps/operate-web/package.json`, `apps/operate-web/tsconfig.json`
- `apps/operate-web/lib/{request-failure,proxy-guard,upstream,session,notifications,aging,reviews,finance-settings}.ts`
  and their tests
- `apps/operate-web/app/{setup,notifications,login,platform/reviews,admin/settings}/page.tsx`,
  `apps/operate-web/app/reports/{aging,wht,period-close}/page.tsx`, `apps/operate-web/components/ShellBar.tsx`
- `packages/testing/src/strategy/test-runner-config.ts` and its test
- ADR-0412, ADR-0385, ADR-0398, ADR-0418, ADR-0435, ADR-0430, ADR-0447, ADR-0448, ADR-0475, ADR-0476
