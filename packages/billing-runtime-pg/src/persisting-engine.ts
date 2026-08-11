import {
  BillingMeteringEngine,
  type BillingMeteringEngineOptions,
  type ClosePeriodInput,
  type ClosePeriodResult,
  type MeteredUsageEvent,
  type RecordResult,
} from "@crossengin/billing-runtime";
import type { PgConnection } from "@crossengin/kernel-pg";

import { PostgresInvoiceStore } from "./invoice-store.js";
import { PostgresUsageRecordStore } from "./usage-store.js";

/**
 * A `BillingMeteringEngine` whose `closePeriod` also persists: the rolled-up
 * `UsageRecord`s land in `meta.billing_usage_records` and the draft `Invoice` in
 * `meta.invoices` (both tenant-RLS-scoped, idempotent `UPSERT`s). Metering
 * (`recordUsage`) stays in-memory; persistence happens at period close.
 */
export class PersistentBillingMeteringEngine {
  readonly engine: BillingMeteringEngine;
  readonly usageStore: PostgresUsageRecordStore;
  readonly invoiceStore: PostgresInvoiceStore;

  constructor(parts: {
    readonly engine: BillingMeteringEngine;
    readonly usageStore: PostgresUsageRecordStore;
    readonly invoiceStore: PostgresInvoiceStore;
  }) {
    this.engine = parts.engine;
    this.usageStore = parts.usageStore;
    this.invoiceStore = parts.invoiceStore;
  }

  recordUsage(event: MeteredUsageEvent): RecordResult {
    return this.engine.recordUsage(event);
  }

  async closePeriod(input: ClosePeriodInput): Promise<ClosePeriodResult> {
    const result = this.engine.closePeriod(input);
    await this.usageStore.recordMany(result.usageRecords);
    if (result.invoice !== null) {
      await this.invoiceStore.upsert(result.invoice);
    }
    return result;
  }
}

export function buildPersistentBillingEngine(
  conn: PgConnection,
  options: BillingMeteringEngineOptions = {},
): PersistentBillingMeteringEngine {
  return new PersistentBillingMeteringEngine({
    engine: new BillingMeteringEngine(options),
    usageStore: new PostgresUsageRecordStore(conn),
    invoiceStore: new PostgresInvoiceStore(conn),
  });
}
