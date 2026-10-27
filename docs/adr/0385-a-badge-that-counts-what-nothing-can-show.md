# ADR-0385: A badge that counts what nothing can show

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-26 |
| **Authors** | Platform |
| **Reviewers** | Platform |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0376 (withheld this flag, naming the surface it was blocked on), ADR-0364 (an argument that expired and nothing noticed; its addendum's error-arm class), ADR-0331 (a claim is not a gap), ADR-0334 (a remedy that cannot work is worse than naming none), ADR-0309 (the read-state tables), ADR-0330 (their store), ADR-0362 (a comment asserting a property the code does not have) |

## Context

Register item P1.16 reads, in part, *"**and no notifications page**, which ADR-0376 established
while trying to default `--read-state-routes` on."* ADR-0376 withheld that flag from the shipped compose and wrote
its reason into a fence:

> It is blocked on a **surface** and not on a default decision: a notifications page plus a mark-read
> affordance, and then this flag on the same day.

That reasoning is sound and it names the right remedy. What neither it nor the register has is the
sharper half, which this increment measured before designing anything: **the badge's accurate path
was incoherent and its approximate path was coherent**, so nothing could have noticed.

There is no notifications link in `operate-web`. The unread badge hangs off **"AI Studio" →
`/setup`** (`components/Sidebar.tsx:240-253` before this change). Its two paths are:

- **primary** — `fetchUnreadCount("in_app")`, the server's per-viewer unread count over **every**
  in-app notice;
- **fallback** — `recentDecisionCount(page.data)`, which skipped any notice where
  `decisionOf(n) === null && !(isDigest(n) && n.digest != null)` — *precisely the union of
  `reviewDecisions` and `digestNotices`*, the two lists `/setup` renders
  (`app/setup/page.tsx:518` and `:532`).

So while the read-state routes were unmounted — every shipped deployment — the badge equalled the
items behind the link. Mounting them replaces that with a strict superset. Measured live against the
real binary and the real UI proxy, with three delivered `in_app` notices (one review decision, one
digest with no rendered copy, one `invoice.overdue`):

| | figure |
|---|---|
| notices delivered to this viewer | 3 |
| server unread count (badge, primary path) | **3** |
| `/setup` renders (decisions + digests) | **1** |
| old fallback `recentDecisionCount` | 1 |

A badge reading 3 leading to a page showing 1, with no surface anywhere for the other 2.
ADR-0376's *"nothing can clear it"* understates it: **nothing can display what it counts.**

The comment that authorised the primary path reasons about the wrong axis. `Sidebar.tsx:70-73`, before this change,
argued that the server's figure "is the question the badge was approximating, so the superset is the
better answer, not a widening" — a claim about *which figure better answers "how many notices have
you not seen"*, and never about whether the link the badge sits on can show them.

Narrowing the count instead is not available: `fetchUnreadCount` took only `channel` and so does
the route (`read-state-routes.ts:571`). There is no template
filter on either side.

## Decision

**One page whose subject is the badge's subject, the badge moved onto it, and the flag defaulted on
the same day ADR-0376 said it should be.**

1. **`/notifications`** lists `listNotifications({channel: "in_app"})` with per-notice **Mark read**
   and **Mark all read**, which gives `markNoticeRead` and `markReadThrough` their first consumers
   in this app.

2. **Read state is rendered per notice, from the server's own partition.**
   `GET /v1/notifications/unread?detail=partition` returns `notices: {read: [...], unread: [...]}`
   (`read-state-routes.ts:611-614`), and the page renders **three** states from set membership:
   `read`, `unread`, and **`unexamined`** for a notice neither list mentions. That third state is
   ADR-0331's distinction inside a row: the partition covers a bounded page, so a notice the lists do
   not mention is one *nobody looked at*, not one found read. Calling it read is the reassuring
   direction; calling it unread inflates the figure the page exists to make honest.

3. **The page works with the read-state routes unmounted**, and says what is missing by name.
   `listNotifications` needs no read-state route, so the list renders either way; only the
   affordances degrade. `describeReadStateFailure` classifies the failure over four kinds
   (`available` / `unmounted` / `ungranted` / `unavailable`), and **three** total maps carry what the
   page does with each — `READ_STATE_MAY_MARK` (may a viewer in this state be offered a control),
   `READ_STATE_FAILURE_HEADING`, and `UNEXAMINED_TITLE_BY_KIND` — so a fifth kind has to declare all
   three rather than inherit whichever arm a ternary ended on, which in the banner's case would have
   been the vaguest of them.

   **The third map is a correction, and it is ADR-0334's shape inside a tooltip.** With no partition
   every row is `unexamined`, and one sentence served all four causes, ending *"Refresh to re-ask."*
   That is true of `available` (an answer exists; the window moved, or the notice is newer than the
   answer) and of `unavailable` (a 503 may well be transient), and **false** of `unmounted` and
   `ungranted`, where refreshing cannot mount a route or grant a role — a remedy that cannot work, in
   the increment citing ADR-0334 twice. The banner above the rows named the real cause and a per-row
   tooltip does not reach it. So the sentence is keyed on *why there is no answer*, which is not a
   property of the row, and `noticeReadStateTitle` is the one producer of a row's title.
   `READ_STATE_STYLE` is left holding the dot and the label, which are the two things that really are
   properties of the row; its former `title` field would otherwise have become a field with no
   reader.

   **`unmounted` is read off the status alone, and that is structural rather than convenient:**
   `buildUnreadHandler` has no 404 arm at all — its answers are 401/403 from `resolveViewer`, 503,
   and 200 — so a 404 on `/unread` is the gateway's `no_route`. Measured both ways: mounted, the
   route answers 200 and a bogus id on `POST /{id}/read` answers `404 no such notice in this inbox`;
   unmounted, `/unread` answers `404 no route for GET /v1/notifications/unread`.

4. **The badge's figure is one number, shared, and that closes this increment's own class.**
   `Sidebar` is mounted by `AppChrome` in the **root layout**, so it does not remount on client
   navigation and its fetch effect runs once per document load. With the count in component state
   the badge could therefore only ever go **up** within a session: mark everything read, the page
   shows 0, and the badge keeps its old number until a full document reload — a badge disagreeing
   with the page it points at, which is the defect this whole increment exists to close,
   reintroduced from the other side. ADR-0376's *"a number that only goes up is not information"*
   applied to the session rather than to the deployment.

   `lib/notifications.ts` holds the figure in a module-level store read through
   `useSyncExternalStore` — module `let`, listener set, `use*` hook. That is **`lib/subscription.ts`'s
   existing shape** and not an invention: it is how this app already crosses a 402 from the API layer
   to a banner in the chrome. It carries the **number** and not a staleness signal, so the badge and
   the page cannot disagree about the count; there is one. The page publishes from **one** effect
   over `partition`, so the three things that learn the figure (the initial load, a per-notice mark,
   a mark-all re-read) have one writer rather than three that must be kept in step — and
   `reportUnreadBadgeCount` is a no-op on a repeat, which is what makes an effect over a re-rendered
   partition free and safe under React's dev double-invocation. `partition === null` publishes
   nothing: on the degraded arm the page has no authoritative figure, and the badge's own fallback is
   a better answer than a zero that reads as *you are up to date*.

   The one hazard a module-level figure carries — **one viewer's count surviving into another's
   session** — is closed by a mechanism this app already relies on and already argues for: every
   exit from an authenticated session is a `window.location.href` assignment and therefore a full
   document load (`ShellBar.signOut`, `redirectToLogin`), and both say in so many words that they do
   it because the module-level caches in `lib/` have no invalidation. The badge count is the
   **fourth** member of that set, after the schema, the reference labels and the subscription
   problem, so `ShellBar`'s comment is restated as the property rather than left as a roster of
   three — it had already gone stale by the time this increment read it.

5. **`--read-state-routes --read-state-role erp_admin --read-state-role platform_admin`** is on the
   shipped compose, and ADR-0376's fenced *absence* is now a fenced *presence* with the measurement
   that earned it.

## Alternatives considered

- **Option A: render the list flat, with no read/unread distinction.**
  - **Pros:** one request per page load instead of two; no `unexamined` state to explain.
  - **Cons:** a page that cannot show *which* notices are unread, beside a badge that counts them.
  - **Why not:** it reproduces this increment's own finding one layer in. The badge would agree with
    the page about a *total* and disagree about everything a reader wants to do with it.

- **Option B: derive read state client-side from `readThroughAt`.**
  - **Pros:** no second request; the count response already carries the watermark.
  - **Cons:** it is a second implementation of `isUnread`.
  - **Why not:** measured in the contract — `isUnread` consults the per-notice rows **and** the
    watermark and **fails open** on an unparseable `queuedAt` (`packages/notifications/src/read-state.ts:121-133`),
    whose own comment says *"the cost of silently filing a notice as read is a notice nobody ever
    sees."* A client derivation would disagree with the server exactly on the notices it is most
    important not to hide. The same argument is why **mark-all re-reads the partition** while
    **mark-one moves one id**: the per-notice response *is* the server's answer about that notice, so
    moving it is not a derivation; the watermark's effect on a *set* is.

- **Option C: hide the affordances when read state is unavailable.**
  - **Pros:** no disabled controls.
  - **Cons:** silence about a deployment flag.
  - **Why not:** partly taken, with the explanation it needs. There is one banner naming the cause
    and the flag, and no per-row buttons — twenty disabled controls each repeating one sentence is
    noise, and the banner is the explanation their absence needs. A page with neither would be
    ADR-0334's shape.

- **Option D: `describeReadStateFailure` for the write failures too.**
  - **Pros:** one classifier.
  - **Cons:** **wrong, and this increment shipped it for twenty minutes.**
  - **Why not:** the 404 discriminator is sound for `/unread` *because that handler has no 404 arm*,
    and `POST /{id}/read` has one. Reusing the classifier answered *"This deployment does not serve
    notification read state… `--read-state-routes`"* for a notice that is simply not the caller's —
    naming a flag the deployment already passes. Measured live, side by side:
    `WRITE path: "no such notice in this inbox."` against
    `READ classifier: "This deployment does not serve notification read state…"`. That is ADR-0364's
    addendum class (an error arm enumerating causes and thereby ruling out the real one), committed
    inside the increment citing it, and found by re-reading rather than by a test.
    `readStateWriteFailure` carries the server's own sentence, because every refusal on those two
    routes names its cause and none is a sentence this module could improve on.

- **Option E: one `--read-state-role`.**
  - **Pros:** one line.
  - **Cons:** the other role is silently on the approximation.
  - **Why not:** the grant has **no default** (`readStateRoles` starts `[]`, `cli.ts:665`) and the
    flag is repeatable and additive. `.env.example`'s bootstrap grants `primaryRole:
    "platform_admin"` and no secondary roles, so that is the one login a fresh deployment has; the
    same file tells a reader to name an erp-core role for somebody who is meant to *use* the ERP,
    and points at `erp_admin`. The boot line **names** the granted roles for exactly this reason, so
    naming one would leave the other quietly approximating. `--ai-design-role` on the same command
    passes two for the same argument.

- **Option F: narrow the fallback to keep `recentDecisionCount`.**
  - **Pros:** no behaviour change in the degraded path.
  - **Cons:** a badge that reads zero for a tenant whose notices are not decisions.
  - **Why not:** that narrowing was only ever right because the link went to `/setup`. With the badge
    on a page that lists everything, the fallback has to approximate *that* subject — so
    `recentNoticeCount` counts every notice in the window. It remains a floor (it cannot know what
    has been read), and a floor over the right subject beats an equality over the wrong one.
    Measured on the same three notices: old 1, new 3, page 3. `recentDecisionCount` is **replaced**
    rather than kept beside it, because its only caller was this one and a second recency function
    with no caller is a defect class here.

- **Option G: refresh the badge on navigation, or on a timer.**
  - **Pros:** no shared store at all; one dependency array or one `setInterval`.
  - **Cons:** neither event is the one that changes the count.
  - **Why not:** a `pathname` dependency refires on **every** navigation — N requests for a figure
    that has usually not moved — and still misses the case that matters, because the count changes
    *while* the reader sits on `/notifications` with the path unchanged, which is precisely when they
    are clearing it. An interval closes the window only on average and makes a nav badge poll. Both
    leave two numbers that agree most of the time, where the store leaves one; and the store is this
    app's own idiom rather than a new mechanism (`lib/subscription.ts`).

## Consequences

- **Positive.** The badge's subject is the page's subject on both paths. `markNoticeRead` and
  `markReadThrough` have consumers. A deployment's read state is now visible per notice rather than
  as one number, including the case where the server did not look.
- **Positive.** ADR-0376's withheld default is on, with its reason spent rather than overruled, and
  the fence that recorded the absence now records the presence.
- **Negative.** Two requests per page load instead of one. This is the stated price of rendering
  read-vs-unread honestly, and it is bounded: the partition is one bounded read the badge already
  makes on every page load.
- **Negative, bounded, and named with its figure.** The badge follows a **per-notice** mark in the
  same React commit that re-renders the row — **zero** further requests, because the page already
  holds the server's answer about that notice. It follows **mark-all** only after **one**
  `GET /v1/notifications/unread?detail=partition`, because that path re-reads instead of deriving.
  Publishing an optimistic `0` there would close the window and be **wrong**: `isUnread` fails open
  on an unparseable `queuedAt` (`packages/notifications/src/read-state.ts:121-133`), so a successful
  `markReadThrough` does not imply zero unread — the same measurement that makes Option B wrong is
  what makes this one-request window the honest price rather than an oversight. Separately, nothing
  polls, so a notice **delivered** while the page is open is counted by neither the page nor the
  badge until a refresh; that is unchanged by this increment and is what the cursor in the open
  questions would address.
- **Negative.** A notice past the examined window reads `Unknown` until it is marked, because the
  unread route has no cursor. Marking it read still works, and **what the page then shows took a
  correction**: the server's reply about that one notice moves its id into the read set, so the row
  renders **Read** immediately and returns to **Unknown** on the next Refresh, when the partition —
  which can only speak about ids inside the examined window — stops mentioning it. Both answers are
  the server's own and neither is the other's bug; the row is written either way, and only what the
  page can be *told* differs. An earlier draft of this bullet said the row "stays `unexamined` to the
  page", which was a claim about React derived from a run that rendered nothing — see
  **Verification**.
- **Neutral.** `/setup` keeps its own review-decisions and digest sections — that is the AI Studio's
  own content — and loses the badge. A digest's rendered body is still read there, which is why the
  new page links to it rather than opening a second `dangerouslySetInnerHTML` site.
- **Reversibility.** The flag is two compose lines and a test assertion. The page is additive: with
  the flag removed it lists everything and names the flag.

## Implementation notes

**The prefix property, which is why the partition can answer for the page.** The store clamps a list
to `MAX_LIMIT = 200` (`notification-store.ts:105`) and the unread answer examines
`DEFAULT_UNREAD_SCAN_LIMIT = 200` (`read-state-routes.ts:149`) of the **same** ordering —
`ORDER BY queued_at DESC, dispatch_id` (`notification-store.ts:304`), a total order since
`dispatch_id` is UNIQUE — under the **same** recipient filter, since `recipientFilterFor(scope:
"self")` and `selfNoticeFilter` both resolve through `ctx.resolveIdentity`. So a page of 50 is a
prefix of the examined window. Measured by walking the whole list over 253 delivered notices: row
200 is `unread`, row **201** is `unexamined`, the walk terminates after 6 pages with 253 distinct
ids and the tally is `{read: 0, unread: 200, unexamined: 53}`.

**Verification.** `apps/operate-web` has no test runner (its devDeps are types, tailwind, postcss,
autoprefixer and typescript), so adding one is a workspace decision and not part of this increment —
see the open questions. Verification is `npx tsc --noEmit`, `npx next build` — **19** pages
(`app/**/page.tsx`) over **23** route-table entries, those 19 plus three `app/api` handlers and
`/_not-found`, of which **16** are marked `○ (Static)` and `/notifications` is one of them, so
`AppChrome`'s prerendering property is preserved and the module-level badge store did not cost it
(an earlier draft called 19 the *route* count: it is the page count, and the two differ by the four
non-page entries) — and a live run: a throwaway PG 16.13 cluster, the catalog applied, `operate-server` serving `erp-core` on
`--store pg` **as the non-owner `serving` role**, and `next start` proxying to it. The page's own
library was then driven against that stack through the real `/api` proxy with the session cookie the
documented bootstrap mints, which exercises `listNotifications`, `fetchUnreadPartition`,
`noticeReadState`, `recentNoticeCount`, `describeReadStateFailure`, `readStateWriteFailure`,
`markNoticeRead` and `markReadThrough` against real responses.

**The badge store was executed, not only read.** `lib/notifications.ts` is loaded through `jiti`
(already in this app's dependencies) and the three non-hook members plus `noticeReadStateTitle` are
driven directly — the module under test is the file and not a copy. 18 checks: the initial snapshot
is `null` and not `0` (a gap is not a claim), a publish notifies once, **a repeat is a no-op** (which
is what makes an effect over a re-rendered partition free and safe under dev double-invocation), the
figure **goes down**, a negative clamps, a fraction truncates, `NaN` is `0` rather than `NaN` in the
nav, unsubscribing unsubscribes; the title map is total over `READ_STATE_KINDS` with four **distinct**
sentences, a refresh is invited by exactly `{available, unavailable}` and refused by name with its
flag in `{unmounted, ungranted}`, and `read`/`unread` do not vary with the kind. The first version of
that refresh assertion tested `/refresh/i` and **failed on correct sentences**, because the two
unrefreshable kinds mention refreshing in order to say it cannot help: a predicate reading the word
for the act, which is the same mistake as a comment asserting a property the code does not have.

**And the wiring that joins the two is fenced by nothing, which is stated rather than implied.**
Measured: commenting out the page's one publish line leaves `npx tsc --noEmit` **and**
`npx next build` green — `apps/operate-web/tsconfig.json` sets no `noUnusedLocals`, so the import it
orphans is not even a warning, and the lint step passes vacuously. So the defect this increment
closes can be reopened by deleting one line with every check in the repository still green. That is
the `deploy/` argument one app across (an artifact outside every rule), and its owner is the test
runner in the open questions below.

**What none of this covers is React rendering, and two sentences in this ADR were wrong because of
it.** There is no browser driver in this app's devDeps, so nothing here renders a component: the run
answers *what did the server say* and never *what does the row show*. One claim about a row
(`unexamined` after a mark) and one absent claim about the badge (that it could not go down in a
session) both slipped through on that gap, and the second was a real defect rather than only a wrong
sentence. So every statement below about what a **row** or the **badge** displays is read off the
component and off the store's semantics — structural, and labelled as such — while the request and
response figures are measured. Closing the gap is a test runner plus a renderer, which is register
P1.3 and the open question below.

What that produced, in order:

```
[read-state] per-viewer notification read state mounted for roles: erp_admin, platform_admin

initial                badge=3 truncated=false | alpha=unread bravo=unread charlie=unread
markNoticeRead         outcome=inserted readAt=2026-10-26T23:13:47.684Z
after one              badge=2 truncated=false | alpha=read   bravo=unread charlie=unread
markNoticeRead (again) outcome=already_read readAt=2026-10-26T23:13:47.684Z
markReadThrough        outcome=advanced clamped=false
after all              badge=0 truncated=false | alpha=read   bravo=read   charlie=read
markReadThrough future outcome=advanced clamped=true
```

and, on `--read-state-unread-scan 2` over the same three notices,
`badge=2 truncated=true | alpha=unread bravo=unread charlie=unexamined` — then marking `charlie`
answered `inserted` and wrote the row, and a fresh partition **still reported it `unexamined`**,
because that id is outside the examined window.

That last figure is a measurement of the **library against the server** and not of the rendered row,
and conflating the two put a wrong sentence in this ADR twice: the page moves the id on the server's
per-notice reply, so the row renders `Read` at once and `Unknown` again after the next Refresh. The
partition's answer and the row's are two different claims and the run only covered one of them.

The degraded arm was measured on the **realistic** configuration, which took one correction: removing
`--read-state-routes` from a server that also lacked `--ai-design` un-mounts
`GET /v1/meta/notifications` as well, because `notificationStore` is constructed iff
`(aiDesign || perTenantManifests || designReview || readStateRoutes) && conn !== undefined`
(`node.ts:1716-1720`). With `--ai-design` present, as the shipped compose has it:

```
list      -> HTTP 200, rows 3
partition -> HTTP 404 {"detail":"no route for GET /v1/notifications/unread"}
describeReadStateFailure: kind=unmounted
  detail: This deployment does not serve notification read state, so nothing can record that you
          have seen a notice. It is mounted with `--read-state-routes` on operate-server.
READ_STATE_MAY_MARK[unmounted] = false
```

and on `--read-state-role warehouse_clerk`, a role the membership does not hold:

```
describeReadStateFailure: kind=ungranted
  detail: notification read state is not granted to this role. This surface is governed by
          `--read-state-routes`, which mounts it, and `--read-state-role`, which grants it per role.
```

That 403 branch carries the **server's** sentence and names **both** governing flags without
claiming which is the cause, because the route has three distinct 403 details
(`read-state-routes.ts:231-252`) whose remedies differ, and discriminating them on their prose would
break the first time one is reworded. The run also found that the server's details carry no full
stop, so appending a second sentence produced *"…not granted to this role This surface is governed
by…"*; `sentence()` terminates a clause that is not already terminated.

**The test change, and its mutations.** `deployment-defaults.test.ts`'s "the default that was
measured and then withdrawn" becomes "the default that was withdrawn and is now earned": the routes
flag is present, at least one role is paired with it (structural — with none, the routes mount and
refuse every request, `node.ts:2839`), and `--read-state-backfill-role` is asserted **absent** with
the distinction that it is the one grant here that gates something. `valuesAfter` is a second helper
beside `valueAfter`, because reading only the first occurrence of a repeatable flag is how
`--ai-design-role` came to be passed half way.

**The role assertions are read from disk in both directions, which took a correction.** The first
version read the bootstrap curl's `primaryRole` from `.env.example` and then **hardcoded**
`erp_admin` for the second grant while its own comment said the file named it — so the half most
likely to drift was the half nothing compared. Two claims live in that file and both are now checked:
the curl's `primaryRole` must be one of the granted roles (what the bootstrap *hands out*), and the
file's restatement of this command's grant line — a backtick span reading
`` `--read-state-role erp_admin --read-state-role platform_admin` `` — must equal the command's
granted set **exactly, both ways**, so a third role added to the compose and not to the doc fails,
which is what the doc's own *"A THIRD role needs another `--read-state-role` line"* sentence promises
a reader. The roles are extracted from backticked spans and never from the raw prose, because three
lines below that claim the same file writes the flag with **no value after it**, so a scan over the
prose would read the word "line" as a role name; a span carrying the flag alone yields no pair, which
is a structural discriminator rather than a list of words to ignore.

Mutation-checked **six** ways, each reversed by the inverse string replacement with the mutation
asserted present exactly once first (never `git checkout --`: parallel slices held uncommitted lines
in these files, and the script refuses to act unless the source string occurs exactly once and the
target not at all — which is what caught two of these mutations being written as deletions to the
empty string, where `count("")` is meaningless and nothing was modified):

1. commenting out `--read-state-routes` → 1 of 20, *expected [ 'node', …(41) ] to include
   '--read-state-routes'*;
2. commenting out both role grants → **3**, because the pairing, the bootstrap cross-check and the
   set comparison each lose their subject;
3. `.env.example`'s `primaryRole` → a role the compose does not grant → 1, the bootstrap
   cross-check alone;
4. renaming the **compose's** `erp_admin` under `--read-state-role` → *expected [ 'controller',
   'platform_admin' ] to deeply equal [ 'erp_admin', 'platform_admin' ]*;
5. renaming the **doc's** claimed role → the same comparison the other way round;
6. removing the backticks from the doc's restatement → the vacuity guard by name,
   *.env.example no longer restates the command's --read-state-role grant: expected 0 to be greater
   than 0*, which is why that guard carries a message: the cause is a doc edit and not a compose one.

20 passed after each reversal. The count in an earlier draft of this paragraph read "five" over a
list of six — a figure wrong inside a correction, which is this file's own P3.1 class and is why it
is written out as a list.

**Two stale figures in comments were replaced by the content they were standing in for**, since this
increment makes both more wrong: `lib/unauthorized.ts` claimed "33 call sites across six modules"
where the measured figure is 41 sites in 12 files (the six *error paths* it enumerates are still
right), and `AppChrome.tsx` argued a rejected alternative would be "a 15-page move" where the app now
has 19 pages. Neither argument depended on its number.

**And one figure this increment itself wrote was false provenance.** `deploy/ORACLE.md` §14 said the
compose passes "three that used to be in the table below and are now defaults", folding this flag in
with the two ADR-0376 promoted. Measured over every committed revision of that file: at the commit
before ADR-0376 the table held **2** rows, for `--notification-drain-ms` and `--tenant-status-gate`,
and `--read-state` is mentioned **zero** times in **all six** revisions — it was never a row and was
never named, because ADR-0376 *withheld* it rather than listing it as a flag an operator could turn
on. The claim is true of two and false of the third, so the sentence is split: two that used to be
rows, and one that was withheld with its reason and became a default the day the page landed. Folding
them together would have told an operator they had been able to turn this on all along.

## Open questions

| Question | Owner | Deadline |
|---|---|---|
| `--read-state-unread-scan` accepts up to `MAX_UNREAD_SCAN_LIMIT = 1000` while `PostgresNotificationStore.listForTenant` clamps a page to `MAX_LIMIT = 200`, so 201–1000 are silently ineffective. Measured over 253 delivered notices: scan 200, 500 and 1000 all answer `examined=200`. That makes `MAX_UNREAD_SCAN_LIMIT`'s own comment — *"Raising the number buys a larger floor under `unread`"* — false past 200. Refuse the flag above 200, raise the store's clamp for this caller, or say so in the help text? | Platform | 2026-11-30 |
| `apps/operate-web` has **zero** tests and no runner, and no renderer either — which is the gap two wrong sentences in this ADR came through. Re-measured: **41** `fetch` sites across **12** files, of which **7** are `lib/*.ts` (36 sites) and **9** carry no JSX at all (38 sites) — those 7 plus `app/api/[...path]/route.ts` and `app/api/auth/login/route.ts`, and the first of those two is the proxy that turns the session cookie into the API's bearer token, so it is the most load-bearing of the nine. All nine are testable under the existing `vitestPreset` with no new dependency, which is the cheapest honest first step (register P1.3); a **renderer** is a second decision and is what would have caught the badge defect. An earlier draft of this row read "9 of its 12 … are plain `lib/*.ts`", taking the count from one predicate and the description from the other. | Platform | 2026-12-15 |
| `UiViewer` carries `primaryRole` and `roles` and no user id, display name or email, so this page cannot say *whose* inbox it is and `/account` names a role rather than a person (register P1.16). The field this page wants is `userId`; `displayName` would let the subtitle name the recipient. Server-side `UiSchema` change. | Platform | 2026-12-15 |
| A notice past the examined window reads `Unknown` for ever, because the unread route has no cursor. A `?after=` on it, or a per-page partition, would close it; an anti-join would make the whole bound unnecessary, which is the fix `MAX_UNREAD_SCAN_LIMIT`'s comment already names as the honest one. | Platform | 2026-12-31 |
| `GET /v1/meta/notifications` is mounted iff `aiDesign \|\| perTenantManifests \|\| designReview \|\| readStateRoutes`, and `--notification-drain-ms` is **not** in that list — so a deployment with the drain and none of those four delivers notices no route can read. Latent on the shipped compose, which passes `--ai-design` and now `--read-state-routes`. | Platform | 2026-12-31 |
| **This page is governed by two grants and nothing says so.** Its *list* is `GET /v1/meta/notifications`, whose `allowedRoles` is `new Set(options.aiDesignRoles)` (`node.ts:2943`) — so the list is granted by **`--ai-design-role`** while the read state beside it is granted by `--read-state-role`, and the nav link is unconditional. Latent on the shipped compose only because the two sets are identical there (`erp_admin, platform_admin` both times, measured), so narrowing either one silently half-breaks the page: drop a role from `--ai-design-role` and they get an empty list with a working badge; drop it from `--read-state-role` and they get the list with the approximation. Whether the tenant inbox should keep borrowing the AI-design grant is the decision; a boot line naming both would be the cheap half. | Platform | 2026-12-31 |
| `/setup`'s decision list reads the newest **50 notices** (`DECISION_LIMIT`), not the newest 50 decisions, so on a busy tenant a review decision falls off that page while remaining in the inbox. Measured: with 253 notices the newest 50 contained no decision and `/setup` rendered 0. | Platform | 2026-12-31 |
| The page renders a one-line summary per notice and links to AI Studio for a digest's body and a decision's notes. Whether notice *content* belongs on this page — which would mean a second server-rendered-HTML site — is a product decision. | Platform | 2027-01-31 |

## References

- ADR-0376 — withheld this flag and named the surface it was blocked on; this closes that.
- ADR-0364 and its addendum — an argument that expired and nothing noticed; the error-arm class
  Option D reproduced and this increment corrected.
- ADR-0309, ADR-0330, ADR-0331 — the read-state tables, their store, and the claim-versus-gap
  distinction `unexamined` applies to a row.
- ADR-0334 — a remedy that cannot work is worse than naming none (why the truncation banner names no
  flag to raise, and why the degraded banner names one that works).
- `packages/notifications/src/read-state.ts:121-133` — `isUnread`'s fail-open, which Option B would
  have had to reimplement.
- `apps/operate-server/src/read-state-routes.ts` — the three routes, the partition, and the three
  403 details.
