import { InvoiceSchema, type Invoice } from "@crossengin/billing";
import type { PgConnection } from "@crossengin/kernel-pg";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA = "meta";
const TABLE = "invoices";

interface InvoiceRow {
  readonly line_items: unknown;
  readonly id: string;
  readonly tenant_id: string;
  readonly subscription_id: string;
  readonly number: string;
  readonly stripe_invoice_id: string | null;
  readonly status: string;
  readonly currency: string;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly discount_cents: number;
  readonly total_cents: number;
  readonly amount_paid_cents: number;
  readonly amount_remaining_cents: number;
  readonly issued_at: string | Date;
  readonly due_at: string | Date;
  readonly paid_at: string | Date | null;
  readonly voided_at: string | Date | null;
  readonly period_start: string | Date;
  readonly period_end: string | Date;
  readonly pdf_url: string | null;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function rowToInvoice(row: InvoiceRow): Invoice {
  const lineItems =
    typeof row.line_items === "string" ? (JSON.parse(row.line_items) as unknown) : row.line_items;
  return InvoiceSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    number: row.number,
    stripeInvoiceId: row.stripe_invoice_id,
    status: row.status,
    currency: row.currency,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    amountPaidCents: row.amount_paid_cents,
    amountRemainingCents: row.amount_remaining_cents,
    issuedAt: iso(row.issued_at),
    dueAt: iso(row.due_at),
    paidAt: isoOrNull(row.paid_at),
    voidedAt: isoOrNull(row.voided_at),
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    lineItems,
    pdfUrl: row.pdf_url,
  });
}

/**
 * Persists engine-drafted `Invoice`s into the canonical `meta.invoices` table
 * (the draft's shape is a valid `Invoice`). Keyed on the tenant's invoice number
 * (`(tenant_id, number)` unique), so re-drafting a period's invoice `UPSERT`s
 * rather than duplicating. Tenant-RLS-scoped.
 */
export class PostgresInvoiceStore {
  constructor(private readonly conn: PgConnection) {}

  async upsert(invoice: Invoice): Promise<void> {
    const valid = InvoiceSchema.parse(invoice);
    await withTenantContext(this.conn, valid.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (
           id, tenant_id, subscription_id, number, stripe_invoice_id, status,
           currency, subtotal_cents, tax_cents, discount_cents, total_cents,
           amount_paid_cents, amount_remaining_cents, issued_at, due_at, paid_at,
           voided_at, period_start, period_end, line_items, pdf_url
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21)
         ON CONFLICT (tenant_id, number) DO UPDATE SET
           status = EXCLUDED.status,
           subtotal_cents = EXCLUDED.subtotal_cents,
           tax_cents = EXCLUDED.tax_cents,
           discount_cents = EXCLUDED.discount_cents,
           total_cents = EXCLUDED.total_cents,
           amount_paid_cents = EXCLUDED.amount_paid_cents,
           amount_remaining_cents = EXCLUDED.amount_remaining_cents,
           line_items = EXCLUDED.line_items,
           paid_at = EXCLUDED.paid_at,
           voided_at = EXCLUDED.voided_at`,
        [
          valid.id,
          valid.tenantId,
          valid.subscriptionId,
          valid.number,
          valid.stripeInvoiceId,
          valid.status,
          valid.currency,
          valid.subtotalCents,
          valid.taxCents,
          valid.discountCents,
          valid.totalCents,
          valid.amountPaidCents,
          valid.amountRemainingCents,
          valid.issuedAt,
          valid.dueAt,
          valid.paidAt,
          valid.voidedAt,
          valid.periodStart,
          valid.periodEnd,
          JSON.stringify(valid.lineItems),
          valid.pdfUrl,
        ],
      );
    });
  }

  async getByNumber(tenantId: string, number: string): Promise<Invoice | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<InvoiceRow>(
        `SELECT * FROM ${SCHEMA}.${TABLE} WHERE number = $1 LIMIT 1`,
        [number],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToInvoice(row);
    });
  }

  async listByTenant(tenantId: string, limit = 100): Promise<readonly Invoice[]> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const result = await tx.query<InvoiceRow>(
        `SELECT * FROM ${SCHEMA}.${TABLE} ORDER BY issued_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map(rowToInvoice);
    });
  }
}
