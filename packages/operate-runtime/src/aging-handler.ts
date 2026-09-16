import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";

import { completeList } from "./complete-list.js";
import { computeAging, type AgingReport } from "./aging.js";
import type { EntityStore } from "./store.js";

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
  readonly maxRows?: number;
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
 */
export function buildAgingHandler(ctx: AgingHandlerContext): Handler {
  const paymentEntity = ctx.paymentEntity ?? "Payment";
  const stateField = ctx.paymentStateField ?? "state";
  const completedState = ctx.paymentCompletedState ?? "completed";
  const amountField = ctx.paymentAmountField ?? "amount";
  const maxRows = ctx.maxRows ?? 5000;

  return async ({ principal, request }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const roles = [primaryRole, ...(secondaryRoles ?? [])];
    if (!roles.some((r) => ctx.viewerRoles.has(r as RoleName))) {
      return json(403, { error: "forbidden", detail: "finance role required" });
    }
    const today = (ctx.clock?.now() ?? new Date()).toISOString().slice(0, 10);
    const asOfParam = firstQuery(request.query["asOf"]);
    const validAsOf = asOfParam !== undefined && AS_OF_PATTERN.test(asOfParam) &&
      (() => { try { return new Date(`${asOfParam}T00:00:00Z`).toISOString().slice(0, 10) === asOfParam; } catch { return false; } })();
    // Current records cannot reconstruct prior document states. Fail explicitly until a
    // historical ledger/snapshot source is available rather than relabel today's balances.
    const asOf = validAsOf ? `${asOfParam}T00:00:00.000Z` : `${today}T00:00:00.000Z`;
    const historicalWarning = validAsOf && asOfParam !== today
      ? "This is a current-state calculation relabeled to the requested date; configure historical snapshots before relying on it for audit reporting."
      : null;
    const currency = firstQuery(request.query["currency"]);
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) return json(400, { error: "invalid_currency" });

    // Sum completed payments once, grouped by each section's ref field.
    const payments = await completeList(ctx.store, tenantId, paymentEntity, {
      limit: maxRows,
      cursor: null,
      sort: [],
      filters: [{ field: stateField, op: "eq", value: completedState }],
    });
    const completed = payments.filter((p) => p[stateField] === completedState);

    const report: Record<string, AgingReport> = {};
    for (const [name, spec] of Object.entries(ctx.sections)) {
      const applied = new Map<string, number>();
      for (const p of completed) {
        const ref = p[spec.paymentRefField];
        if (typeof ref === "string" && ref.length > 0) {
          applied.set(ref, (applied.get(ref) ?? 0) + num(p[amountField]));
        }
      }
      const page = await completeList(ctx.store, tenantId, spec.entity, {
        limit: maxRows,
        cursor: null,
        sort: [],
        filters: [{ field: "state", op: "in", value: [...spec.openStates] }],
      });
      const open = page.filter((d) => spec.openStates.includes(String(d["state"] ?? "")) && (currency === undefined || d["currency"] === currency));
      const currencies = [...new Set(open.map(d => String(d["currency"] ?? "USD")))];
      if (currencies.length > 1) return json(422, { error: "currency_required", detail: "Select one currency; totals across currencies are not meaningful", currencies });
      const byId = new Map(open.map(d => [String(d["id"]), d]));
      for (const payment of completed) {
        const document = byId.get(String(payment[spec.paymentRefField]));
        if (document && payment["currency"] !== undefined && payment["currency"] !== document["currency"]) {
          return json(422, { error: "payment_currency_mismatch", detail: "A payment requires an explicit conversion to the document currency" });
        }
      }
      report[name] = computeAging({
        documents: open,
        appliedByDocument: applied,
        asOf,
        numberField: spec.numberField,
        ...(spec.dueDateField !== undefined ? { dueDateField: spec.dueDateField } : {}),
      });
    }
    return json(200, { asOf: asOf.slice(0, 10), ...(historicalWarning ? { warning: historicalWarning } : {}), sections: report });
  };
}
