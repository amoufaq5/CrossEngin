import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";

import { computeAging, type AgingReport } from "./aging.js";
import { drainList, type BoundedReadDeclaration } from "./list-drain.js";
import type { EntityRecord, EntityStore } from "./store.js";

/** One AR/AP aging section the handler can produce. */
export interface AgingSpec {
  /** The document entity (e.g. "Invoice", "Bill"). */
  readonly entity: string;
  /** Document states included as open (issued/approved but not paid/void/draft). */
  readonly openStates: readonly string[];
  /** The Payment field linking to this document (e.g. "invoice_id"). */
  readonly paymentRefField: string;
  readonly numberField: string;
  readonly dueDateField?: string;
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

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
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
    // An optional `?asOf=YYYY-MM-DD` pulls a historical aging snapshot; a malformed
    // value is ignored (fall back to the clock), so the param never widens/breaks the report.
    const asOfParam = firstQuery(request.query["asOf"]);
    const asOf =
      asOfParam !== undefined && AS_OF_PATTERN.test(asOfParam)
        ? `${asOfParam}T00:00:00.000Z`
        : (ctx.clock?.now() ?? new Date()).toISOString();

    // Every section's applied-payment map is filled in ONE pass over the payment pages, before the
    // section loop. The accumulators are hoisted rather than rebuilt per section because a drain is
    // a stream: rebuilding them inside the loop would either re-read every payment per section or
    // retain every payment row, where one pass holds only O(sections × documents-with-payments) and
    // discards the rows as they arrive.
    //
    // One map **per section** and not one shared map keyed by document id, because a section's keys
    // are the values of its own `paymentRefField` and nothing draws two entities' ids from one
    // space: records are bucketed per `(tenant, entity)` and a caller-supplied `id` is not stripped.
    // A shared map would credit an invoice with a same-id bill's payments.
    const sections = Object.entries(ctx.sections).map(([name, spec]) => ({
      name,
      spec,
      applied: new Map<string, number>(),
    }));
    const bounded: string[] = [];

    const paymentOutcome = await drainList(
      ctx.store,
      tenantId,
      paymentEntity,
      { sort: [], filters: [{ field: stateField, op: "eq", value: completedState }] },
      { ceiling: maxRows },
      (rows) => {
        for (const p of rows) {
          if (p[stateField] !== completedState) continue;
          for (const section of sections) {
            const ref = p[section.spec.paymentRefField];
            if (typeof ref !== "string" || ref.length === 0) continue;
            section.applied.set(ref, (section.applied.get(ref) ?? 0) + num(p[amountField]));
          }
        }
      },
    );
    if (!paymentOutcome.complete) bounded.push(PAYMENT_READ_NAME);

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
      report[name] = computeAging({
        documents: open,
        appliedByDocument: applied,
        asOf,
        numberField: spec.numberField,
        ...(spec.dueDateField !== undefined ? { dueDateField: spec.dueDateField } : {}),
      });
    }
    // `complete` is derived from the one list rather than accumulated beside it, so the claim and
    // the names it is made of cannot disagree.
    const body: AgingResponse = { asOf: asOf.slice(0, 10), sections: report, complete: bounded.length === 0, bounded };
    return json(200, body);
  };
}
