import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";

import { computeWhtReconciliation } from "./wht-reconciliation.js";
import type { EntityStore } from "./store.js";

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
 * `GET /v1/meta/wht-reconciliation` — reconciles tax withheld at recognition (each
 * invoice's `withholding_total`) against the WHT certificates confirmed for it, surfacing
 * the uncertified gap. Authorized to finance/admin viewer roles (fail-closed).
 */
export function buildWhtReconciliationHandler(ctx: WhtReconciliationHandlerContext): Handler {
  const invoiceEntity = ctx.invoiceEntity ?? "Invoice";
  const withholdingField = ctx.withholdingField ?? "withholding_total";
  const certificateEntity = ctx.certificateEntity ?? "WhtCertificate";
  const certStateField = ctx.certificateStateField ?? "state";
  const certConfirmedState = ctx.certificateConfirmedState ?? "confirmed";
  const certInvoiceField = ctx.certificateInvoiceField ?? "invoice_id";
  const certAmountField = ctx.certificateAmountField ?? "amount";
  const maxRows = ctx.maxRows ?? 5000;

  return async ({ principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const roles = [primaryRole, ...(secondaryRoles ?? [])];
    if (!roles.some((r) => ctx.viewerRoles.has(r as RoleName))) {
      return json(403, { error: "forbidden", detail: "finance role required" });
    }

    // Invoices carrying a positive withholding total (filter pushed down; re-checked below).
    const invoicePage = await ctx.store.listPage(tenantId, invoiceEntity, {
      limit: maxRows,
      cursor: null,
      sort: [],
      filters: [{ field: withholdingField, op: "gt", value: "0" }],
    });
    const invoices = invoicePage.records.filter((inv) => num(inv[withholdingField]) > 0);

    // Confirmed certificates, summed by their invoice.
    const certPage = await ctx.store.listPage(tenantId, certificateEntity, {
      limit: maxRows,
      cursor: null,
      sort: [],
      filters: [{ field: certStateField, op: "eq", value: certConfirmedState }],
    });
    const certifiedByInvoice = new Map<string, number>();
    for (const cert of certPage.records) {
      if (cert[certStateField] !== certConfirmedState) continue;
      const ref = cert[certInvoiceField];
      if (typeof ref === "string" && ref.length > 0) {
        certifiedByInvoice.set(ref, (certifiedByInvoice.get(ref) ?? 0) + num(cert[certAmountField]));
      }
    }

    const report = computeWhtReconciliation({
      invoices,
      certifiedByInvoice,
      ...(ctx.numberField !== undefined ? { numberField: ctx.numberField } : {}),
      withholdingField,
      ...(ctx.currencyField !== undefined ? { currencyField: ctx.currencyField } : {}),
    });
    return json(200, report);
  };
}
