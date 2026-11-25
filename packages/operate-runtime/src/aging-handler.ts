import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";

import { computeAging, type AgingReport, type CreditNoteShape } from "./aging.js";
import { drainList, type BoundedReadDeclaration } from "./list-drain.js";
import type { EntityRecord, EntityStore } from "./store.js";
import { readAppliedPayments, type PaymentSettlementSpec } from "./write-guards.js";

/** One AR/AP aging section the handler can produce. */
export interface AgingSpec {
  /** The document entity (e.g. "Invoice", "Bill"). */
  readonly entity: string;
  /** Document states included as open (issued/approved but not paid/void/draft). */
  readonly openStates: readonly string[];
  /**
   * The Payment field linking to this document and the direction that settles it, from
   * `SETTLEMENT_COVERAGE_DOCUMENTS` — so the open balance this report prints is the one the GL
   * carries: a payment whose money cleared the other control account applies nothing here (ADR-0468).
   */
  readonly payment: PaymentSettlementSpec;
  readonly numberField: string;
  readonly dueDateField?: string;
  readonly withholdingField?: string;
  /** Credit notes in the open set, and the states their credited originals are fetched from. */
  readonly creditNote?: CreditNoteShape & { readonly creditedStates: readonly string[] };
}

export interface AgingHandlerContext {
  readonly store: EntityStore;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly viewerRoles: ReadonlySet<RoleName>;
  readonly sections: Readonly<Record<string, AgingSpec>>;
  readonly paymentEntity?: string;
  readonly paymentStateField?: string;
  readonly paymentCompletedState?: string;
  readonly paymentAmountField?: string;
  readonly clock?: { now(): Date };
  /**
   * The largest set either read here reads **in full** — the tenant's completed payments, and each
   * section's open documents. Reaching it is *declared* on the answer rather than silently
   * truncated, which is the whole difference from the `limit` it replaces: both reads used to take
   * one page of this size and discard the cursor beside it, so the figures were computed from a
   * prefix and said nothing about the rest.
   */
  readonly maxRows?: number;
}

/**
 * 20_000 rather than 5000, because both populations here are lifetime-cumulative: there is no purge
 * or archive job for Payment, Invoice or Bill anywhere in the packs, so a tenant's completed
 * payments and its open documents only ever grow and 5000 is reached by ordinary trading history
 * rather than by anything unusual.
 *
 * And 20_000 rather than the 100_000 the tenant-wide effects take, because what bounds a report is
 * its **response** and not its fold. `AgingReport` carries `documents` beside `totalsByBucket` and
 * `totalOpen`, so this ceiling is a row count in the body: measured from the real pack, the widest
 * money record is `Invoice` at 777 bytes of JSON, which makes 100_000 a ~74 MiB answer against
 * today's ~3.7 MiB. 20_000 is four times the correctness at four times the response, and past it
 * the answer is `complete: false` with the bounded reads named — which is the point, since the
 * figure was wrong because it was *silent* and not because it was bounded.
 */
const DEFAULT_AGING_MAX_ROWS = 20_000;

/**
 * The payment read's name in {@link AgingResponse.bounded}, beside the section names.
 *
 * A section called `payments` would be indistinguishable from it. Unreachable from a manifest —
 * `compile.ts` mints exactly `ar` and `ap` — and harmless if a direct caller does it, since both
 * spellings say the same thing to a reader: a read behind this report stopped short. Namespacing
 * would cost the one consumer that joins `bounded` against `sections` a second spelling of each key.
 */
const PAYMENT_READ_NAME = "payments";

/**
 * `GET /v1/meta/aging`'s body: the sections, and how far the reads behind them got.
 *
 * It extends `BoundedReadDeclaration` rather than restating `complete`/`bounded`, so the two reports
 * cannot drift into two spellings of one claim — and so `complete` is a compiler obligation on every
 * answer rather than a convention. `bounded` names `payments` for the tenant-wide payment read and a
 * section's own name for its document read, and which one it is matters because the two errors point
 * **opposite** ways and so do not even cancel predictably: a dropped payment leaves a document's
 * applied total too small, overstating every balance it touches, while a dropped document is absent
 * from the report altogether, understating total receivables.
 */
export interface AgingResponse extends BoundedReadDeclaration {
  readonly asOf: string;
  readonly sections: Readonly<Record<string, AgingReport>>;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** First value of a query param (arrays carry the first), or undefined. */
function firstQuery(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value[0];
}

/**
 * `GET /v1/meta/aging` — an AR/AP aging report computed from the live store:
 * open documents (issued, unpaid) minus their applied completed payments, bucketed
 * by days past due. Authorized to finance/admin viewer roles (fail-closed). Each
 * configured section (e.g. `ar` ← Invoice, `ap` ← Bill) is returned keyed by name.
 *
 * Both reads **drain** their set rather than reading one page of `maxRows`, and a set larger than
 * that is named in `bounded` rather than truncated in silence. A report is the one position where a
 * bounded answer is still a usable answer — `READ_CEILING_EFFECT.report` is `declares`, against the
 * guard's `refuses` and the effect's `aborts` — because an aging report over the first `maxRows` of
 * a larger open set is still the only view an operator has, where a bounded balance verdict or a
 * bounded GL row would not be a degraded version of the real thing.
 */
export function buildAgingHandler(ctx: AgingHandlerContext): Handler {
  const paymentEntity = ctx.paymentEntity ?? "Payment";
  const stateField = ctx.paymentStateField ?? "state";
  const completedState = ctx.paymentCompletedState ?? "completed";
  const amountField = ctx.paymentAmountField ?? "amount";
  const maxRows = ctx.maxRows ?? DEFAULT_AGING_MAX_ROWS;

  return async ({ principal, request }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const roles = [primaryRole, ...(secondaryRoles ?? [])];
    if (!roles.some((r) => ctx.viewerRoles.has(r as RoleName))) {
      return json(403, { error: "forbidden", detail: "finance role required" });
    }
    // `?asOf=YYYY-MM-DD` ages the open set at that date — **today or later only** (ADR-0475). It
    // was documented as "a historical aging snapshot" and was not one: the date reached only the
    // days-past-due arithmetic, while the open set is today's (a document paid after `asOf` is
    // absent) and the applied payments are every payment to date (one made after `asOf` is
    // subtracted), so a past `asOf` answered a figure that was true on no day, under a 200. Both
    // errors understate the receivable. Refused by name until a point-in-time read exists — ADR-0359's
    // rule, since the drop changes which rows come back. A future date is served: no payment or
    // state change postdates today, so today's open set *is* the open set as of then, and only the
    // ageing moves. A malformed value is refused too, where it used to fall back to today in silence
    // and hand back a report for a date the caller did not ask about.
    const asOfParam = firstQuery(request.query["asOf"]);
    const now = (ctx.clock?.now() ?? new Date()).toISOString();
    if (asOfParam !== undefined && asOfParam !== "") {
      // Round-tripped rather than `Date.parse`d: ECMAScript rolls 2026-02-30 forward to 2 March,
      // so a parse alone accepts a day that does not exist and ages against a different one.
      const parsed = Date.parse(`${asOfParam}T00:00:00.000Z`);
      if (
        !AS_OF_PATTERN.test(asOfParam) ||
        Number.isNaN(parsed) ||
        new Date(parsed).toISOString().slice(0, 10) !== asOfParam
      ) {
        return json(400, { error: "as_of_malformed", detail: "asOf must be a date in the form YYYY-MM-DD" });
      }
      if (asOfParam < now.slice(0, 10)) {
        return json(400, {
          error: "as_of_not_served",
          detail:
            `asOf ${asOfParam} is before today (${now.slice(0, 10)}, UTC): this report ages today's open documents ` +
            "against every payment to date, so it cannot say what was open on a past date; omit asOf, or ask for today or later",
        });
      }
    }
    const asOf = asOfParam !== undefined && asOfParam !== "" ? `${asOfParam}T00:00:00.000Z` : now;

    // Every section's applied-payment map is filled in ONE pass over the payment pages, before the
    // section loop — the one-pass property and the per-section keying both live in
    // `readAppliedPayments` now, with the reason a shared map keyed by document id would credit an
    // invoice with a same-id bill's payments.
    //
    // Zipped back onto the sections by **position**, which is what `AppliedPaymentsRead`
    // guarantees: index *i* answers for `specs[i]`.
    const specs = Object.entries(ctx.sections).map(([name, spec]) => ({ name, spec }));
    const bounded: string[] = [];

    const paymentRead = await readAppliedPayments(
      ctx.store,
      tenantId,
      specs.map(({ spec }) => spec.payment),
      { paymentEntity, stateField, completedState, amountField, ceiling: maxRows },
    );
    if (!paymentRead.complete) bounded.push(PAYMENT_READ_NAME);
    const sections = specs.map(({ name, spec }, i) => ({
      name,
      spec,
      // `!` and not `?? new Map()`: `foldCompletedPayments` builds one bucket per ref field with
      // `specs.map(() => new Map())`, so index `i` exists for every `i` a caller can ask about
      // — the `??` arm was unreachable, and ADR-0361's reason for deleting an unreachable check is
      // that a dead arm reads as a handled case. Same spelling the fold itself uses one scope in.
      applied: paymentRead.applied[i]!,
    }));

    const report: Record<string, AgingReport> = {};
    for (const { name, spec, applied } of sections) {
      // The documents are collected rather than folded into an accumulator, because `computeAging`
      // renders one row per document — so this read is O(open documents) however it is read, which
      // is the honest cost of a per-document report and not something the drain introduced.
      const open: EntityRecord[] = [];
      const docOutcome = await drainList(
        ctx.store,
        tenantId,
        spec.entity,
        { sort: [], filters: [{ field: "state", op: "in", value: [...spec.openStates] }] },
        { ceiling: maxRows },
        (rows) => {
          for (const d of rows) {
            if (spec.openStates.includes(String(d["state"] ?? ""))) open.push(d);
          }
        },
      );
      if (!docOutcome.complete) bounded.push(name);
      // A credit note's original is voided by the act that issued it, so it is not in the open set:
      // fetched by reference so the pair can be aged together. One read per credit note, bounded by
      // the open set already drained.
      const cn = spec.creditNote;
      if (cn !== undefined) {
        const have = new Set(open.map((d) => String(d["id"] ?? "")));
        for (const d of [...open]) {
          const ref = d[cn.typeField] === cn.typeValue ? d[cn.refField] : undefined;
          if (typeof ref !== "string" || have.has(ref)) continue;
          const original = await ctx.store.get(tenantId, spec.entity, ref);
          if (original !== null && cn.creditedStates.includes(String(original["state"] ?? ""))) {
            open.push(original);
            have.add(ref);
          }
        }
      }
      report[name] = computeAging({
        documents: open,
        appliedByDocument: applied,
        asOf,
        numberField: spec.numberField,
        ...(spec.dueDateField !== undefined ? { dueDateField: spec.dueDateField } : {}),
        ...(spec.withholdingField !== undefined ? { withholdingField: spec.withholdingField } : {}),
        ...(cn !== undefined ? { creditNote: { typeField: cn.typeField, typeValue: cn.typeValue, refField: cn.refField } } : {}),
      });
    }
    // `complete` is derived from the one list rather than accumulated beside it, so the claim and
    // the names it is made of cannot disagree.
    const body: AgingResponse = { asOf: asOf.slice(0, 10), sections: report, complete: bounded.length === 0, bounded };
    return json(200, body);
  };
}
