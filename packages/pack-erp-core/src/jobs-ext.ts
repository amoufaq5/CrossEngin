import type { JobDeclaration } from "@crossengin/jobs";

type DataClass = JobDeclaration["inputDataClass"];
type Trigger = JobDeclaration["trigger"];

interface JobOpts {
  readonly concurrencyLimit?: number;
  readonly inputDataClass?: DataClass;
  readonly outputDataClass?: DataClass;
  readonly alertChannel?: string;
}

function job(id: string, name: string, description: string, trigger: Trigger, opts: JobOpts = {}): JobDeclaration {
  return {
    id,
    name,
    description,
    trigger,
    concurrency: { limit: opts.concurrencyLimit ?? 10, key: "event.data.tenant_id" },
    retry: {
      maxAttempts: 5,
      backoff: { kind: "exponential", initialDelay: "PT10S", maxDelay: "PT15M", jitter: true },
    },
    onFailure: opts.alertChannel !== undefined
      ? { strategy: "alert-and-dead-letter", alertChannel: opts.alertChannel }
      : { strategy: "dead-letter" },
    idempotent: true,
    inputDataClass: opts.inputDataClass ?? "internal",
    outputDataClass: opts.outputDataClass ?? "internal",
  };
}

const scheduled = (cron: string): Trigger => ({ kind: "scheduled", cron, timezone: "UTC" });
const event = (eventName: string): Trigger => ({ kind: "event", eventName });

// ---- Integration connectors (external systems) ------------------------------

export const PAYMENT_GATEWAY_SYNC_JOB = job(
  "erp-core-payment-gateway-sync",
  "Payment gateway reconciliation",
  "Polls the payment gateway (Stripe/Adyen) for settled transactions and reconciles them against open invoices and payments.",
  scheduled("*/15 * * * *"),
  { concurrencyLimit: 5, inputDataClass: "commercial_sensitive", alertChannel: "finance-ops" },
);

export const BANK_STATEMENT_IMPORT_JOB = job(
  "erp-core-bank-statement-import",
  "Bank statement import",
  "Imports bank statement lines via the banking integration (Plaid/SWIFT MT940) and matches them to payments for reconciliation.",
  scheduled("0 5 * * *"),
  { concurrencyLimit: 3, inputDataClass: "commercial_sensitive", alertChannel: "finance-ops" },
);

export const FX_RATE_REFRESH_JOB = job(
  "erp-core-fx-rate-refresh",
  "FX rate refresh",
  "Pulls daily foreign-exchange rates from the rates provider so multi-currency documents revalue against a current rate table.",
  scheduled("0 4 * * *"),
  { concurrencyLimit: 1 },
);

export const TAX_CALCULATION_JOB = job(
  "erp-core-tax-calculation",
  "External tax calculation",
  "On quote send, calls the tax engine (Avalara/TaxJar) to compute jurisdiction-accurate tax for each line and writes the result back.",
  event("erp.quote_sent"),
  { inputDataClass: "commercial_sensitive" },
);

export const EINVOICE_SUBMISSION_JOB = job(
  "erp-core-einvoice-submission",
  "E-invoice submission",
  "On invoice issue, submits a compliant e-invoice to the government/clearance portal (Peppol/ZATCA/SAT) and stores the clearance reference.",
  event("erp.invoice_issued"),
  { inputDataClass: "commercial_sensitive", alertChannel: "finance-ops" },
);

export const SHIPMENT_TRACKING_SYNC_JOB = job(
  "erp-core-shipment-tracking-sync",
  "Carrier tracking sync",
  "Polls carrier APIs (FedEx/DHL/UPS) for in-transit shipments and advances each shipment's state as tracking events arrive.",
  scheduled("*/30 * * * *"),
  { concurrencyLimit: 5 },
);

export const CRM_LEAD_ENRICHMENT_JOB = job(
  "erp-core-crm-lead-enrichment",
  "Lead enrichment",
  "On lead creation, enriches the record via a data provider (Clearbit/ZoomInfo) with firmographics before routing it to a sales rep.",
  event("erp.lead_created"),
  { inputDataClass: "pii", outputDataClass: "pii" },
);

export const PAYROLL_DISBURSEMENT_JOB = job(
  "erp-core-payroll-disbursement",
  "Payroll disbursement",
  "On payroll approval, pushes net-pay disbursement instructions to the payroll/banking provider and records the transfer references.",
  event("erp.payroll_approved"),
  { concurrencyLimit: 2, inputDataClass: "commercial_sensitive", alertChannel: "people-ops" },
);

// ---- Workflow automation (cross-entity orchestration) -----------------------

export const INVENTORY_REORDER_JOB = job(
  "erp-core-inventory-reorder",
  "Inventory reorder point (MRP)",
  "Nightly MRP-style sweep: compares stock levels to reorder points and drafts purchase orders for items below threshold.",
  scheduled("0 2 * * *"),
  { concurrencyLimit: 5 },
);

export const SALES_ORDER_TO_INVOICE_JOB = job(
  "erp-core-sales-order-to-invoice",
  "Sales order to invoice",
  "On sales-order fulfillment, auto-generates the customer invoice from fulfilled lines and advances the order to 'invoiced'.",
  event("erp.sales_order_fulfilled"),
  { inputDataClass: "commercial_sensitive" },
);

export const WORK_ORDER_COMPLETION_JOB = job(
  "erp-core-work-order-completion",
  "Work order completion posting",
  "On work-order completion, consumes component stock per the BOM and receives the finished good into the warehouse via stock movements.",
  event("erp.work_order_completed"),
  { concurrencyLimit: 5 },
);

export const DEPRECIATION_RUN_JOB = job(
  "erp-core-depreciation-run",
  "Monthly depreciation run",
  "Month-end batch that computes period depreciation for in-service fixed assets and posts the corresponding journal entries to the GL.",
  scheduled("0 1 1 * *"),
  { concurrencyLimit: 1, inputDataClass: "commercial_sensitive", alertChannel: "finance-ops" },
);

export const ERP_EXT_JOBS: Readonly<Record<string, JobDeclaration>> = {
  "erp-core-payment-gateway-sync": PAYMENT_GATEWAY_SYNC_JOB,
  "erp-core-bank-statement-import": BANK_STATEMENT_IMPORT_JOB,
  "erp-core-fx-rate-refresh": FX_RATE_REFRESH_JOB,
  "erp-core-tax-calculation": TAX_CALCULATION_JOB,
  "erp-core-einvoice-submission": EINVOICE_SUBMISSION_JOB,
  "erp-core-shipment-tracking-sync": SHIPMENT_TRACKING_SYNC_JOB,
  "erp-core-crm-lead-enrichment": CRM_LEAD_ENRICHMENT_JOB,
  "erp-core-payroll-disbursement": PAYROLL_DISBURSEMENT_JOB,
  "erp-core-inventory-reorder": INVENTORY_REORDER_JOB,
  "erp-core-sales-order-to-invoice": SALES_ORDER_TO_INVOICE_JOB,
  "erp-core-work-order-completion": WORK_ORDER_COMPLETION_JOB,
  "erp-core-depreciation-run": DEPRECIATION_RUN_JOB,
};
