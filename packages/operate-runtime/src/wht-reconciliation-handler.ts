import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";

import { drainList, type BoundedReadDeclaration } from "./list-drain.js";
import { computeWhtReconciliation, type WhtReconciliation } from "./wht-reconciliation.js";
import type { EntityRecord, EntityStore, ListFilter } from "./store.js";

export interface WhtReconciliationHandlerContext {
  readonly store: EntityStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly viewerRoles: ReadonlySet<RoleName>;
  readonly invoiceEntity?: string;
  readonly withholdingField?: string;
  readonly numberField?: string;
  readonly currencyField?: string;
  readonly certificateEntity?: string;
  readonly certificateStateField?: string;
  readonly certificateConfirmedState?: string;
  readonly certificateInvoiceField?: string;
  readonly certificateAmountField?: string;
  readonly issueDateField?: string;
  /**
   * The largest set either read here reads **in full** — the withholding invoices, and the
   * confirmed certificates. Reaching it is *declared* on the answer rather than silently truncated,
   * which is the whole difference from the `limit` it replaces: both reads used to take one page of
   * this size and discard the cursor beside it, so the gap this report exists to surface was
   * computed from a prefix and said nothing about the rest.
   */
  readonly maxRows?: number;
}

/**
 * 20_000 rather than 5000, because both populations here are lifetime-cumulative: there is no purge
 * or archive job for Invoice or WhtCertificate anywhere in the packs, so a tenant's withholding
 * invoices and their certificates only ever grow and 5000 is reached by ordinary trading history
 * rather than by anything unusual.
 *
 * And 20_000 rather than the 100_000 the tenant-wide effects take, for `aging-handler.ts`'s reason:
 * what bounds a report is its **response** and not its fold. `WhtReconciliation` carries `rows`
 * beside `totals`, so this ceiling is a row count in the body — at the real pack's widest money
 * record (`Invoice`, 777 bytes of JSON) 100_000 would be a ~74 MiB answer.
 */
const DEFAULT_WHT_MAX_ROWS = 20_000;

/** The two reads behind the report, as {@link WhtReconciliationResponse.bounded} names them. */
const INVOICE_READ_NAME = "invoices";
const CERTIFICATE_READ_NAME = "certificates";

/**
 * `GET /v1/meta/wht-reconciliation`'s body: the reconciliation, and how far its two reads got.
 *
 * `BoundedReadDeclaration` is extended rather than restated so this report and the aging one cannot
 * drift into two spellings of one claim, and so `complete` is a compiler obligation on every answer
 * rather than a convention. `bounded` names `invoices` and/or `certificates`, and which it is matters
 * because the two errors point **opposite** ways: a dropped invoice is absent from the report,
 * understating the withheld total and the uncertified exposure with it, while a dropped certificate
 * leaves an invoice's certified total too small, so a fully-certified invoice is reported with a gap
 * it does not have.
 */
export interface WhtReconciliationResponse extends WhtReconciliation, BoundedReadDeclaration {}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** First value of a query param (arrays carry the first), or undefined. */
function firstQuery(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value[0];
}

/** A `YYYY-MM-DD` query value, or undefined when absent/malformed (ignored). */
function dateParam(value: string | readonly string[] | undefined): string | undefined {
  const first = firstQuery(value);
  return first !== undefined && DATE_PATTERN.test(first) ? first : undefined;
}

/**
 * Whether an invoice's issue date falls inside the requested period.
 *
 * With neither bound given this is true of every invoice *including one with no issue date at all*,
 * which is deliberate and is the pre-existing behaviour: an undated invoice still carries
 * withholding, so the unfiltered report must show it, while a period query cannot place it and
 * drops it.
 */
function withinPeriod(raw: unknown, from: string | undefined, to: string | undefined): boolean {
  if (from === undefined && to === undefined) return true;
  if (typeof raw !== "string" || raw.length === 0) return false;
  const issued = raw.slice(0, 10);
  if (from !== undefined && issued < from) return false;
  if (to !== undefined && issued > to) return false;
  return true;
}

/**
 * `GET /v1/meta/wht-reconciliation` — reconciles tax withheld at recognition (each
 * invoice's `withholding_total`) against the WHT certificates confirmed for it, surfacing
 * the uncertified gap. Authorized to finance/admin viewer roles (fail-closed).
 *
 * Both reads **drain** their set rather than reading one page of `maxRows`, and a set larger than
 * that is named in `bounded` rather than truncated in silence — `READ_CEILING_EFFECT.report` is
 * `declares`, because a reconciliation over the first `maxRows` withholding invoices is still the
 * only view an operator has of the gap.
 */
export function buildWhtReconciliationHandler(ctx: WhtReconciliationHandlerContext): Handler {
  const invoiceEntity = ctx.invoiceEntity ?? "Invoice";
  const withholdingField = ctx.withholdingField ?? "withholding_total";
  const certificateEntity = ctx.certificateEntity ?? "WhtCertificate";
  const certStateField = ctx.certificateStateField ?? "state";
  const certConfirmedState = ctx.certificateConfirmedState ?? "confirmed";
  const certInvoiceField = ctx.certificateInvoiceField ?? "invoice_id";
  const certAmountField = ctx.certificateAmountField ?? "amount";
  const issueDateField = ctx.issueDateField ?? "issue_date";
  const maxRows = ctx.maxRows ?? DEFAULT_WHT_MAX_ROWS;

  return async ({ principal, request }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const roles = [primaryRole, ...(secondaryRoles ?? [])];
    if (!roles.some((r) => ctx.viewerRoles.has(r as RoleName))) {
      return json(403, { error: "forbidden", detail: "finance role required" });
    }

    // Optional `?from=YYYY-MM-DD` / `?to=YYYY-MM-DD` period filter over the invoice's issue date;
    // malformed values are ignored. Certificates clear regardless of period.
    const from = dateParam(request.query["from"]);
    const to = dateParam(request.query["to"]);

    // The period bounds go **into the query**, which does two things rather than one. It bounds the
    // set this read has to drain to the period actually asked for — and it fixes a wrong answer:
    // filtering in memory *after* a capped read meant a period query was answered from whichever
    // rows that read happened to return, and with `sort: []` leaving `ORDER BY <id> ASC` and ids
    // minted in time order, those are the OLDEST. Measured on the built tree, a tenant with 5200
    // old withholding invoices and 3 in the current month got `rows: 0, withheld: 0` for
    // `?from=2026-06-01&to=2026-06-30` — an EMPTY reconciliation under a 200, needing no unusual
    // data, only history.
    //
    // `withinPeriod` below still re-checks it, which is this file's convention for every pushed
    // filter (the withholding bound beside it does the same) and is what stops a store that could
    // not express the predicate from widening the answer. The belt is the **wider** of the two, so
    // it is a belt against a store that dropped the predicate and not against the predicate itself:
    // it slices to 10 characters, where the bound compares the stored text whole. The two therefore
    // agree exactly for a `date` field, whose every writer produces a canonical `YYYY-MM-DD` — a
    // client value is refused by `checkDate`, and the one effect that sets an issue date writes
    // `nowIso.slice(0, 10)` — and they would NOT agree for an `issueDateField` pointed at a
    // `datetime`, where `2026-06-10T09:00:00.000Z <= '2026-06-10'` is false and the bound would drop
    // the whole closing day. `compile.ts` leaves this field at its `date` default; a caller moving
    // it to an instant owes the bound a day's slack.
    const invoiceFilters: ListFilter[] = [{ field: withholdingField, op: "gt", value: "0" }];
    if (from !== undefined) invoiceFilters.push({ field: issueDateField, op: "gte", value: from });
    if (to !== undefined) invoiceFilters.push({ field: issueDateField, op: "lte", value: to });

    const bounded: string[] = [];

    // Collected rather than folded, because `computeWhtReconciliation` renders one row per invoice:
    // O(invoices in the period) however it is read, which is the honest cost of a per-row report.
    const invoices: EntityRecord[] = [];
    const invoiceOutcome = await drainList(
      ctx.store,
      tenantId,
      invoiceEntity,
      { sort: [], filters: invoiceFilters },
      { ceiling: maxRows },
      (rows) => {
        for (const inv of rows) {
          if (num(inv[withholdingField]) <= 0) continue;
          if (!withinPeriod(inv[issueDateField], from, to)) continue;
          invoices.push(inv);
        }
      },
    );
    if (!invoiceOutcome.complete) bounded.push(INVOICE_READ_NAME);

    // Confirmed certificates, summed by their invoice — folded as the pages arrive, so this read is
    // O(invoices with a certificate) however many certificates there are.
    const certifiedByInvoice = new Map<string, number>();
    const certOutcome = await drainList(
      ctx.store,
      tenantId,
      certificateEntity,
      { sort: [], filters: [{ field: certStateField, op: "eq", value: certConfirmedState }] },
      { ceiling: maxRows },
      (rows) => {
        for (const cert of rows) {
          if (cert[certStateField] !== certConfirmedState) continue;
          const ref = cert[certInvoiceField];
          if (typeof ref === "string" && ref.length > 0) {
            certifiedByInvoice.set(ref, (certifiedByInvoice.get(ref) ?? 0) + num(cert[certAmountField]));
          }
        }
      },
    );
    if (!certOutcome.complete) bounded.push(CERTIFICATE_READ_NAME);

    const report = computeWhtReconciliation({
      invoices,
      certifiedByInvoice,
      ...(ctx.numberField !== undefined ? { numberField: ctx.numberField } : {}),
      withholdingField,
      ...(ctx.currencyField !== undefined ? { currencyField: ctx.currencyField } : {}),
    });
    // `complete` is derived from the one list rather than accumulated beside it, so the claim and
    // the names it is made of cannot disagree.
    const body: WhtReconciliationResponse = { ...report, complete: bounded.length === 0, bounded };
    return json(200, body);
  };
}
