import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";

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

  return async ({ principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const roles = [primaryRole, ...(secondaryRoles ?? [])];
    if (!roles.some((r) => ctx.viewerRoles.has(r as RoleName))) {
      return json(403, { error: "forbidden", detail: "finance role required" });
    }
    const asOf = (ctx.clock?.now() ?? new Date()).toISOString();

    // Sum completed payments once, grouped by each section's ref field.
    const payments = await ctx.store.listPage(tenantId, paymentEntity, {
      limit: maxRows,
      cursor: null,
      sort: [],
      filters: [{ field: stateField, op: "eq", value: completedState }],
    });
    const completed = payments.records.filter((p) => p[stateField] === completedState);

    const report: Record<string, AgingReport> = {};
    for (const [name, spec] of Object.entries(ctx.sections)) {
      const applied = new Map<string, number>();
      for (const p of completed) {
        const ref = p[spec.paymentRefField];
        if (typeof ref === "string" && ref.length > 0) {
          applied.set(ref, (applied.get(ref) ?? 0) + num(p[amountField]));
        }
      }
      const page = await ctx.store.listPage(tenantId, spec.entity, {
        limit: maxRows,
        cursor: null,
        sort: [],
        filters: [{ field: "state", op: "in", value: [...spec.openStates] }],
      });
      const open = page.records.filter((d) => spec.openStates.includes(String(d["state"] ?? "")));
      report[name] = computeAging({
        documents: open,
        appliedByDocument: applied,
        asOf,
        numberField: spec.numberField,
        ...(spec.dueDateField !== undefined ? { dueDateField: spec.dueDateField } : {}),
      });
    }
    return json(200, { asOf: asOf.slice(0, 10), sections: report });
  };
}
