# ADR-0465: An approved workspace gets a starter chart of accounts, written through the create handler after the approval commits

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-11-23 |
| **Authors** | CrossEngin platform |
| **Reviewers** | _N/A_ |
| **Supersedes** | _N/A_ |
| **Superseded by** | _N/A_ |
| **Related** | ADR-0464 (access requests), ADR-0423 (`server_reference_unresolved`), ADR-0430 (the system writer), ADR-0428 (the entity audit trail), ADR-0121 (GL account resolution), ADR-0313 (record before the write), ADR-0429 (reversals mirror the original) |

## Context

ADR-0464's approval creates a tenant, its first admin, a password and default settings in one
transaction, and leaves the workspace with **no ledger accounts**. Every posting effect resolves its
account through a finance setting (`arAccountCode`, `revenueAccountCode`, …) and falls back to a
literal (`accounts_receivable`, `revenue`, …) when the setting is unset. That literal is written into
`JournalLine.ledger_account_id`, a required reference to `LedgerAccount`, so since ADR-0423 both
Postgres stores refuse it `409 server_reference_unresolved`. An approved customer's first invoice was
therefore refused until their admin had created accounts by hand and pointed each of seventeen
settings at them. That was ADR-0464's open question 4 and the owner asked for it closed.

## Decision

### The chart

`packages/operate-runtime/src/starter-chart.ts` declares **21 accounts**:

- 18 are the targets of the 18 finance `*AccountCode` settings;
- 3 have no setting: 1500 property and equipment, 3000 owner's equity, 3100 retained earnings. They
  exist so opening balances and fixed-asset cost have somewhere to go by manual journal.

`STARTER_ACCOUNTS_BY_SETTING` is a **total map** over `FinanceAccountCodeKey`, a type derived from
`FinanceSettingsSchema` itself. A new `*AccountCode` setting is a compile error until the chart says
which account serves it, so a posting effect cannot gain an account the chart leaves unresolved. The
types follow what each posting does. Nothing reads `account_type` at posting time; only the list view
shows it. Accumulated depreciation is `asset` with a credit balance, because the type enum has no
contra member. `STARTER_CHART_VERSION` (`2026-11`) is recorded with every provisioning, so a later
reader knows which chart a workspace was given.

### When it is written: after the approval commits, through the handler

`ensureStarterChart` writes each account **through the real create handler** as a system actor
(ADR-0430's `SystemEntityAccess`). That way every account meets the same validation, defaults, grants,
unique enforcement and per-record audit row (ADR-0428) as a person's create:

- an omitted `currency` takes the tenant's default currency, and `USD` without one;
- the audit row's reason is `provisioning:starter_chart id:<request id>`.

`SystemWriteOrigin` became a union, and its new `provisioning` arm mints `req_prov_` request ids.

The handler opens its own transaction, so the chart **cannot share the approval's**:

- node-postgres refuses nesting, and the entity store's transaction entry is private;
- a write on a second connection before the approval commits fails twice — on the
  `meta.operate_entity_records.tenant_id` foreign key, and on the tenant-status gate's
  `403 tenant_unknown`.

So the approval stays the one atomic act ADR-0464 made it, and the chart is a **reported second step**.
The approval's 201 carries `starterChart`, which is one of three things:

- the report;
- `{outcome: "not_requested"}`;
- `{outcome: "failed", error: <Error name>}`.

A throw never undoes an approval that has committed.

### Idempotent, and never wrong about an existing tenant

The same code serves `POST /v1/platform/tenants/{id}/starter-chart`. That route is for a tenant
created from the console or the script, one approved before this existed, and an approval whose chart
was refused part-way. On such a tenant the obvious implementation is wrong in a quiet way: a tenant
with its own numbering may hold `4000` as an expense or `1100` as a bank account. Pointing
`revenueAccountCode` at it would post every invoice's revenue there, in entries that balance, where
leaving the setting unset keeps the honest refusal. Four review lenses independently found this. So:

- The tenant's chart codes are **read before writing**, and an existing code is never recreated or
  changed. On `--store pg`, uniqueness depends on the one-shot `document-indexes` step (ADR-0423), so
  a 409 cannot be relied on to say the code exists.
- They are **read again after writing**, and settings are decided from that second read. A 409 on
  another unique field, or an account removed between the two reads, would otherwise point a setting
  at a code with no account. A `409 unique_violation` counts as "already there" only if the re-read
  finds the code.
- A setting is filled only when it is **unset**, and only when exactly one account carries the code
  and either this run created it, or it is of the chart's type, `active` and postable. Otherwise the
  key is reported in `settingsSkipped`: `type_mismatch`, `archived`, `not_postable`, `duplicated`, or
  `absent` (removed between the reads).
- A blank code (`""`) counts as unset. The schema admits it, and `resolveAccountId` resolves nothing
  for it.
- After the fill, every setting in effect, including ones an admin chose, is checked for an account
  carrying its code. A code naming nothing is reported in `settingsDangling`. If that check could not
  run, the field is `null`, never `[]`.
- The fill is one locked read-modify-write in the store (`FinanceAccountCodeFiller`): a
  `SELECT … FOR UPDATE` row lock, or an `INSERT … ON CONFLICT DO NOTHING` and a second locked pass
  for a tenant with no row. A caller's get-then-put would overwrite a code an admin saved in between.

The outcomes are:

| Outcome | Meaning |
|---|---|
| `complete` | Every setting is set and names an account. |
| `partial` | Some accounts or settings are in place, and the rest are listed. |
| `refused` | Nothing existed and every create was refused; rerunning gives the same answer until the cause changes. |
| `not_served` | The deployment serves no `LedgerAccount` create. |
| `duplicates_present` | More than 1,000 rows carry the chart's codes; nothing more is written. |
| `settings_unwritten` | The accounts are listed, the settings write failed, and `settingsError` names the error. |

A stored settings row the contract refuses — or, on the text path, malformed JSON — throws
`SettingsRowUnreadable` from the fill. The settings `get` path reads that row as empty rather than
throwing, so the Settings page that is the remedy can still load.

### Under whose authority

The accounts are written as **`--job-actor-role`** (default `erp_admin`), not as the operator. A
platform operator holds no grant inside a tenant (`platform_admin` reaches no entity operation), so a
write in their name would be refused. That is a **bounded escalation**: an operator holding only the
platform-admin grant causes writes authorised as `erp_admin` in any active tenant. It is bounded in
three ways:

- the operator chooses none of the content — a fixed set of accounts, and only settings nobody had
  set;
- the access-request approval already requires the user grant, which can grant `erp_admin` anyway;
- both the route's `platform.starter_chart_provisioned` record and the approval's audit detail carry
  `actingRoles` and the chart version beside the operator's own roles.

The route records the act **before** writing anything (ADR-0313): if it cannot be recorded it answers
503 and writes nothing. It is mounted only with `--platform-admin` over a Postgres store. It answers
`409 tenant_not_active` for a tenant that is not active, rather than leaving the tenant-status gate to
refuse 21 accounts one by one.

### Withholding posts to withholding accounts

Review found that the chart made a defect reachable that predates it. A withholding tax line whose
`TaxCode` names no `gl_account_code` used to fall back to the document's tax account:

- **on an invoice** it debited output tax, understating it. Confirming the WHT certificate then
  credited a WHT receivable that had never been debited.
- **on a bill** it credited input tax, an asset, for what is tax the workspace owes the authority.

Before the chart, a fresh tenant's unset codes made this refuse. With the chart, it posted wrongly.

A withholding group now resolves in this order: the code's own `gl_account_code`, then the
withholding default (`whtReceivableAccountCode` on an invoice, the new `whtPayableAccountCode` on a
bill), then the literal (`wht_receivable` / `wht_payable`). It never uses the per-jurisdiction tax map
or the document tax account. The chart's 2210 `Withholding tax payable` serves the new setting, and
2200 is renamed `Output tax payable` because reverse-charge tax lands there too. Credit notes, voids
and refunds mirror the posted entry line by line (ADR-0429), so they follow.

## Alternatives considered

- **Raw inserts inside the approval transaction.** Rejected. These would re-implement validation,
  defaults, unique enforcement and RBAC beside the handler, and would leave no per-account audit row.
  A failure would also roll back the whole approval over a chart the customer could have built
  themselves.
- **Fill every setting from the chart unconditionally.** Rejected. This replaces an admin's choices,
  and on a tenant with its own numbering it points postings at the wrong accounts.
- **Trust a 409 as "the code exists".** Rejected. On `--store pg` without `document-indexes` there is
  no 409 to trust, and when there is one, it does not say which unique field conflicted.
- **Write the accounts as the operator.** Rejected: `platform_admin` reaches no entity operation, so
  every create would be refused.
- **Default withholding to the jurisdiction's tax account.** Rejected: that map names output and
  input tax accounts, which is the defect.

## Consequences

- An approved workspace can send its first invoice, approve its first bill and record its first
  payment with no further setup. Every outcome, and why, is shown on the approval banner, on the
  tenant page (which also runs the chart again) and by `deploy/onboard-tenant.sh` (`NO_STARTER_CHART=1`
  skips it).
- **An upgrading workspace with a withholding tax code that names no `gl_account_code` is now
  refused** `409 server_reference_unresolved`:
  - on bill approve, until `whtPayableAccountCode` is set — a new setting, so no existing workspace
    has it;
  - on invoice send, until `whtReceivableAccountCode` is set, or an account coded `wht_receivable`
    exists.

  This turns a silently wrong posting into a refusal (`deploy/README.md`'s upgrade section). Entries
  posted before the upgrade stay where they were, and a certificate confirmed for such an invoice
  credits a receivable that was never debited.
- **Rolling the binary back is not safe for settings.** `FinanceSettingsSchema` is strict, so an
  older binary reading a row that carries `whtPayableAccountCode` refuses the whole document and
  reads every finance setting as empty.
- The settings form shows 12 of the 18 account codes. The other 6 are set through
  `PUT /v1/admin/settings`, and the form preserves them on save.

## Implementation notes

- Two adversarial review rounds over the change, four lenses then three. Mutation checks were run on
  copies outside the repository, and every one was killed, including the type-mismatch skip, the
  re-read deciding a 409 and the withholding default.
- `ensureStarterChart` is serialised per tenant **within one process** in `node.ts`, so an approval
  racing the console button does not create the chart twice on a store whose unique index is absent.
- The integration test drives all seven packs through the real compiled server and the real system
  writer. It also sends an `erp-core` invoice end to end: with the chart it posts the debit to 1100
  and the credit to 4000; without it, it is refused 409.
- Verified live on PG 16 in compose order (migrate, app role, `document-indexes`; for the typed
  store, `column-schema --grant-to crossengin_app`), with the shipped compose `api` command and
  the API connecting as `crossengin_app`. The same 26 checks pass on `--store pg` and on
  `--store pg-columns`:
  - an approval answers 201 with `starterChart.outcome: complete`: 21 created, 0 existing, 18
    settings filled, `settingsDangling: []`, and 21 rows in the database;
  - `arAccountCode` is `1100` and `whtPayableAccountCode` is `2210`;
  - there are 21 audit rows reading `provisioning:starter_chart id:…`, and the approval's audit
    detail carries `starterChartActingRoles: ["erp_admin"]` and `starterChartVersion: "2026-11"`;
  - rerunning the route answers 200 `complete` with 0 created and 21 existing, the row count stays
    21, and the act is recorded once with its acting roles;
  - an opt-out approval answers `not_requested` with no accounts and no version in its audit detail,
    and the route then creates all 21;
  - an unknown tenant is 404 `tenant_not_found`;
  - the tenant's own admin signs in, creates a customer and sends a 100.00 invoice, which debits
    1100 and credits 4000;
  - a 100.00 bill with a 10% withholding line approves to 2000 −90, 2210 −10 and 6000 +100.

  Booted with `--job-actor-role erp_viewer`, an approval still answers 201, and its chart is
  `refused` with all 21 creates refused `403 forbidden`, no account written and no setting filled.
  On the typed store, the first boot refused by name until the schema was granted to the app role,
  and named `--grant-to` as the remedy.

## Open questions

1. **Bill withholding cannot settle.** Nothing records the withheld amount on a bill (only invoices
   stamp `withholding_total`). Paying the supplier the net leaves the bill open; paying the gross
   leaves accounts payable in debit. Nothing posts the remittance of 2210 to the authority either.
   `GO-LIVE.md` says so, and the remedy is a stamped field on `Bill` plus the payment application,
   aging and FX documents reading it.
2. **The WHT reconciliation report counts void invoices and credit notes**, which copy
   `withholding_total`, so it can disagree with 1310 now that 1310 is posted to.
3. **A matching type is not a matching account.** On a tenant with its own numbering, an existing
   liability coded 2210 ("Accrued payroll") passes the type check and would be filled into
   `whtPayableAccountCode`. The report lists the keys it filled but does not name the accounts it
   filled them from.
4. **Two replicas are not serialised**: on `--store pg` without `document-indexes`, two concurrent
   provisionings on different replicas can each create the chart.
5. **The tenant status is checked once, before the writes.** A tenant suspended in the milliseconds
   between the check and the writes still receives the accounts, the same window every job write has.
6. **The outcome is not durably recorded.** The act is recorded before the writes and each account
   has its audit row, but a `partial` or `failed` result lives only in the response and a log line.
7. No country or industry chart variants, and no chart import.
8. A `--job-actor-role` naming a role without `LedgerAccount` create gives `refused` on every
   approval, and nothing says so at boot. The console attributes the refusal to that flag only when
   every refusal is `403 forbidden`; a boot line checking the role against the manifest's grants
   would say it before the first approval.

## References

- `packages/operate-runtime/src/starter-chart.ts`, `settings.ts`, `system-writer.ts`,
  `write-effects.ts`, `compile.ts`
- `packages/operate-runtime-pg/src/settings-store.ts`
- `apps/operate-server/src/starter-chart-routes.ts`, `access-requests.ts`, `node.ts`
- `apps/operate-web/lib/platform.ts`, `app/platform/[id]/page.tsx`,
  `app/platform/access-requests/page.tsx`, `app/admin/settings/page.tsx`
- `deploy/onboard-tenant.sh`, `deploy/GO-LIVE.md`, `deploy/README.md`
