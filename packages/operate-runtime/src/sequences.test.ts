import { describe, expect, it } from "vitest";
import type { Entity } from "@crossengin/types/meta-schema";

import {
  applySequenceDefaults,
  derivePeriodKey,
  formatSequenceNumber,
  InMemorySequenceAllocator,
  sequenceFieldPlans,
  DEFAULT_SEQUENCE_FORMAT,
} from "./sequences.js";

const NOW = new Date("2026-03-07T10:00:00Z");

describe("InMemorySequenceAllocator", () => {
  it("hands out monotonic values from the start", async () => {
    const a = new InMemorySequenceAllocator();
    const i = { tenantId: "t1", sequenceName: "invoice", periodKey: "all" };
    expect(await a.allocate(i)).toBe(1);
    expect(await a.allocate(i)).toBe(2);
    expect(await a.allocate(i)).toBe(3);
  });

  it("respects a custom start", async () => {
    const a = new InMemorySequenceAllocator();
    expect(await a.allocate({ tenantId: "t1", sequenceName: "po", periodKey: "all", start: 1000 })).toBe(1000);
    expect(await a.allocate({ tenantId: "t1", sequenceName: "po", periodKey: "all", start: 1000 })).toBe(1001);
  });

  it("isolates counters by tenant, name, and period", async () => {
    const a = new InMemorySequenceAllocator();
    expect(await a.allocate({ tenantId: "t1", sequenceName: "invoice", periodKey: "2026" })).toBe(1);
    expect(await a.allocate({ tenantId: "t2", sequenceName: "invoice", periodKey: "2026" })).toBe(1);
    expect(await a.allocate({ tenantId: "t1", sequenceName: "bill", periodKey: "2026" })).toBe(1);
    expect(await a.allocate({ tenantId: "t1", sequenceName: "invoice", periodKey: "2027" })).toBe(1);
    expect(await a.allocate({ tenantId: "t1", sequenceName: "invoice", periodKey: "2026" })).toBe(2);
  });
});

describe("derivePeriodKey", () => {
  it("buckets by reset period", () => {
    expect(derivePeriodKey("never", NOW)).toBe("all");
    expect(derivePeriodKey(undefined, NOW)).toBe("all");
    expect(derivePeriodKey("yearly", NOW)).toBe("2026");
    expect(derivePeriodKey("monthly", NOW)).toBe("2026-03");
    expect(derivePeriodKey("daily", NOW)).toBe("2026-03-07");
  });
});

describe("formatSequenceNumber", () => {
  it("zero-pads {SEQ:N} and substitutes date tokens", () => {
    expect(formatSequenceNumber("INV-{YYYY}-{SEQ:6}", 42, NOW)).toBe("INV-2026-000042");
    expect(formatSequenceNumber("{SEQ}", 42, NOW)).toBe("42");
    expect(formatSequenceNumber("B/{YY}/{MM}/{SEQ:4}", 7, NOW)).toBe("B/26/03/0007");
    expect(formatSequenceNumber(DEFAULT_SEQUENCE_FORMAT, 7, NOW)).toBe("000007");
  });

  it("does not pad when no value overflows the width", () => {
    expect(formatSequenceNumber("{SEQ:3}", 12345, NOW)).toBe("12345");
  });
});

const ENTITY: Entity = {
  name: "Invoice",
  traits: ["auditable"],
  fields: [
    {
      name: "invoice_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      default: { kind: "sequence", sequence: "erp.invoice", format: "INV-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true },
  ],
};

describe("sequenceFieldPlans", () => {
  it("extracts only sequence-defaulted fields", () => {
    const plans = sequenceFieldPlans(ENTITY);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.field).toBe("invoice_number");
    expect(plans[0]?.spec.sequence).toBe("erp.invoice");
  });
});

describe("applySequenceDefaults", () => {
  it("fills a blank sequence field with a formatted value", async () => {
    const allocator = new InMemorySequenceAllocator();
    const plans = sequenceFieldPlans(ENTITY);
    const out = await applySequenceDefaults({ record: { currency: "USD" }, plans, allocator, tenantId: "t1", now: NOW });
    expect(out["invoice_number"]).toBe("INV-2026-00001");
    const out2 = await applySequenceDefaults({ record: { currency: "USD" }, plans, allocator, tenantId: "t1", now: NOW });
    expect(out2["invoice_number"]).toBe("INV-2026-00002");
  });

  it("preserves a caller-supplied value", async () => {
    const allocator = new InMemorySequenceAllocator();
    const plans = sequenceFieldPlans(ENTITY);
    const out = await applySequenceDefaults({
      record: { invoice_number: "MANUAL-1", currency: "USD" },
      plans,
      allocator,
      tenantId: "t1",
      now: NOW,
    });
    expect(out["invoice_number"]).toBe("MANUAL-1");
  });

  it("applies a resolveSpec override (admin settings)", async () => {
    const allocator = new InMemorySequenceAllocator();
    const plans = sequenceFieldPlans(ENTITY);
    const out = await applySequenceDefaults({
      record: {},
      plans,
      allocator,
      tenantId: "t1",
      now: NOW,
      resolveSpec: (s) => ({ ...s, format: "CUSTOM-{SEQ:3}" }),
    });
    expect(out["invoice_number"]).toBe("CUSTOM-001");
  });

  it("is a no-op when there are no plans", async () => {
    const allocator = new InMemorySequenceAllocator();
    const out = await applySequenceDefaults({ record: { a: 1 }, plans: [], allocator, tenantId: "t1", now: NOW });
    expect(out).toEqual({ a: 1 });
  });
});
