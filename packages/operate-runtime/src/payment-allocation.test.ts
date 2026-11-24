import { readFileSync } from "node:fs";

import type { Manifest } from "@crossengin/kernel/manifest";
import { buildErpCorePack } from "@crossengin/pack-erp-core";
import { describe, expect, it } from "vitest";

import { defaultEffectStamps, paymentSettlementDocuments } from "./compile.js";
import {
  PAYMENT_ALLOCATION_COMPLETION_SUFFIX,
  PAYMENT_ALLOCATION_REFUSAL_CASES,
  PAYMENT_ALLOCATION_REFUSAL_CODES,
  PAYMENT_ALLOCATION_REFUSALS,
  paymentAllocationDetail,
  paymentAllocationGuard,
  paymentAllocationShape,
  paymentAllocationViolation,
  type PaymentAllocationShape,
} from "./payment-allocation.js";
import { InMemoryEntityStore } from "./store.js";
import type { PaymentSettlementGlConfig } from "./write-effects.js";
import { SETTLEMENT_COVERAGE_DOCUMENTS, type WriteGuardInput } from "./write-guards.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const core = buildErpCorePack();
const coreEntities = core.entities ?? [];
const shape = paymentAllocationShape(core)!;

function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** A copy of erp-core whose `Payment` has its `direction` field replaced (or removed with `null`). */
function withDirection(
  type: { kind: "enum"; values: string[] } | { kind: "text" } | { kind: "integer" } | null,
  required?: boolean,
): Manifest {
  return {
    ...core,
    entities: coreEntities.map((e) =>
      e.name !== "Payment"
        ? e
        : {
            ...e,
            fields:
              type === null
                ? e.fields.filter((f) => f.name !== "direction")
                : e.fields.map((f) =>
                    f.name === "direction"
                      ? { ...f, type, ...(required === false ? { required: false } : {}) }
                      : f,
                  ),
          },
    ),
  };
}

/** erp-core whose `Payment` lacks `bill_id` while `Bill` stays declared. */
function withoutBillReference(): Manifest {
  return {
    ...core,
    entities: coreEntities.map((e) => (e.name !== "Payment" ? e : { ...e, fields: e.fields.filter((f) => f.name !== "bill_id") })),
  };
}

/** erp-core with no `Bill`: the entity, its lines, and every field referencing it are gone. */
function withoutBill(): Manifest {
  return {
    ...core,
    entities: coreEntities
      .filter((e) => e.name !== "Bill" && e.name !== "BillLine")
      .map((e) => ({ ...e, fields: e.fields.filter((f) => !(f.type.kind === "reference" && f.type.target === "Bill")) })),
  };
}

describe("paymentAllocationShape", () => {
  it("names erp-core's two references and says its direction can express inbound", () => {
    expect(shape.references.map((d) => [d.entity, d.refField, d.settledBy])).toEqual([
      ["Invoice", "invoice_id", "inbound"],
      ["Bill", "bill_id", "outbound"],
    ]);
    expect(shape.directionExpressible).toBe(true);
  });

  it("is null with no Payment, and with no document the declaration names", () => {
    expect(paymentAllocationShape({ ...core, entities: coreEntities.filter((e) => e.name !== "Payment") })).toBeNull();
    expect(
      paymentAllocationShape({ ...core, entities: coreEntities.filter((e) => e.name !== "Invoice" && e.name !== "Bill") }),
    ).toBeNull();
  });

  it("references are the settlement wiring's documents narrowed to the references Payment declares", () => {
    // The relation, stated: shape.documents = the wiring's documents, and shape.references = those
    // whose refField `Payment` declares. They coincide for erp-core and for a manifest without Bill,
    // and differ by exactly the undeclared reference when `Payment` lacks one — where the coverage
    // guard must stay (a settlement nothing can pay is still refused) and this guard has nothing to read.
    for (const manifest of [core, withoutBill(), withoutBillReference()]) {
      const s = paymentAllocationShape(manifest)!;
      const fromCompile = paymentSettlementDocuments(manifest);
      expect(s.documents.map((d) => d.refField)).toEqual(fromCompile.map((d) => d.refField));
      const paymentFields = new Set(
        (manifest.entities ?? []).find((e) => e.name === "Payment")!.fields.map((f) => f.name),
      );
      expect(s.references.map((d) => d.refField)).toEqual(
        fromCompile.filter((d) => paymentFields.has(d.refField)).map((d) => d.refField),
      );
    }
    expect(paymentAllocationShape(core)!.references.map((d) => d.refField)).toEqual(["invoice_id", "bill_id"]);
    expect(paymentAllocationShape(withoutBill())!.references.map((d) => d.refField)).toEqual(["invoice_id"]);
    expect(paymentSettlementDocuments(withoutBillReference()).map((d) => d.refField)).toEqual(["invoice_id", "bill_id"]);
    expect(paymentAllocationShape(withoutBillReference())!.references.map((d) => d.refField)).toEqual(["invoice_id"]);
  });

  it("the wired application effects settle exactly the wiring's documents", () => {
    // `paid_at` is stamped by the application effect and nothing else, so the stamp list names the
    // entities one was built for — dropping a declared document from the effect loop fails here.
    for (const manifest of [core, withoutBill(), withoutBillReference()]) {
      const settled = defaultEffectStamps(manifest)
        .filter((st) => st.field === "paid_at")
        .map((st) => st.entity);
      expect(settled).toEqual(paymentSettlementDocuments(manifest).map((d) => d.entity));
    }
    expect(paymentSettlementDocuments(withoutBill()).map((d) => d.entity)).toEqual(["Invoice"]);
  });
});

describe("paymentAllocationViolation — the literal truth table", () => {
  type Ref = "none" | "invoice" | "bill" | "both";
  const refs: Record<Ref, Record<string, unknown>> = {
    none: {},
    invoice: { invoice_id: "inv_1" },
    bill: { bill_id: "bil_1" },
    both: { invoice_id: "inv_1", bill_id: "bil_1" },
  };
  const amounts = { "-": "-10.00", "0": "0.00", "+": "10.00" } as const;
  // Written out, not derived: direction × reference × amount → the refusal case, or null.
  const TABLE: readonly [string, Ref, keyof typeof amounts, string | null][] = [
    ["inbound", "none", "-", "amount_negative"],
    ["inbound", "none", "0", null],
    ["inbound", "none", "+", null],
    ["inbound", "invoice", "-", "amount_negative"],
    ["inbound", "invoice", "0", null],
    ["inbound", "invoice", "+", null],
    ["inbound", "bill", "-", "inbound_names_outbound_document"],
    ["inbound", "bill", "0", "inbound_names_outbound_document"],
    ["inbound", "bill", "+", "inbound_names_outbound_document"],
    ["inbound", "both", "-", "several_documents"],
    ["inbound", "both", "0", "several_documents"],
    ["inbound", "both", "+", "several_documents"],
    ["outbound", "none", "-", "amount_negative"],
    ["outbound", "none", "0", null],
    ["outbound", "none", "+", null],
    ["outbound", "invoice", "-", "outbound_names_inbound_document"],
    ["outbound", "invoice", "0", "outbound_names_inbound_document"],
    ["outbound", "invoice", "+", "outbound_names_inbound_document"],
    ["outbound", "bill", "-", "amount_negative"],
    ["outbound", "bill", "0", null],
    ["outbound", "bill", "+", null],
    ["outbound", "both", "-", "several_documents"],
    ["outbound", "both", "0", "several_documents"],
    ["outbound", "both", "+", "several_documents"],
  ];

  it("has 24 rows, one per combination", () => {
    expect(TABLE).toHaveLength(24);
    expect(new Set(TABLE.map(([d, r, a]) => `${d}/${r}/${a}`)).size).toBe(24);
  });

  for (const [direction, ref, amount, expected] of TABLE) {
    it(`${direction} × ${ref} × ${amount} → ${expected ?? "allowed"}`, () => {
      const v = paymentAllocationViolation({ direction, amount: amounts[amount], ...refs[ref] }, shape);
      expect(v === null ? null : v.case).toBe(expected);
    });
  }

  it("a payment naming both documents is refused as naming several, whatever its direction", () => {
    // Check 1 precedes check 2: an outbound payment naming both would otherwise read as a mismatch
    // on the first reference.
    expect(paymentAllocationViolation({ direction: "outbound", amount: "5.00", ...refs.both }, shape)?.code).toBe(
      "payment_names_several_documents",
    );
  });

  it("a numeric invoice_id names nothing", () => {
    expect(paymentAllocationViolation({ direction: "inbound", amount: "5.00", invoice_id: 42 }, shape)).toBeNull();
    // Beside a real bill reference it is not a second document: the bill alone is named.
    expect(
      paymentAllocationViolation({ direction: "inbound", amount: "5.00", invoice_id: 42, bill_id: "bil_1" }, shape)?.case,
    ).toBe("inbound_names_outbound_document");
    expect(paymentAllocationViolation({ direction: "inbound", amount: "5.00", invoice_id: "" }, shape)).toBeNull();
  });

  it("an unreadable amount passes, being the validator's to refuse", () => {
    expect(paymentAllocationViolation({ direction: "inbound", amount: "n/a" }, shape)).toBeNull();
  });
});

describe("a Payment whose direction cannot say inbound", () => {
  for (const [label, manifest, direction] of [
    ["declares no direction", withDirection(null), undefined],
    ["declares the enum ['in','out']", withDirection({ kind: "enum", values: ["in", "out"] }), "in"],
    ["declares an integer direction", withDirection({ kind: "integer" }), undefined],
  ] as const) {
    it(`${label}: every payment reads outbound, so naming an invoice is refused and a bill is allowed`, () => {
      const s = paymentAllocationShape(manifest)!;
      expect(s.directionExpressible).toBe(false);
      const base = { amount: "5.00", ...(direction === undefined ? {} : { direction }) };
      expect(paymentAllocationViolation({ ...base, invoice_id: "inv_1" }, s)?.case).toBe("inbound_inexpressible");
      expect(paymentAllocationViolation({ ...base, bill_id: "bil_1" }, s)).toBeNull();
    });
  }

  it("a text direction can hold 'inbound', so it is expressible and the sentence names the remedy that works", () => {
    // The write validator admits "inbound" for a `text` field, and `paymentDirectionOf` reads it as
    // inbound — so the posting clears AR for it. Saying "declares no 'inbound' direction" here was false.
    const s = paymentAllocationShape(withDirection({ kind: "text" }))!;
    expect(s.directionExpressible).toBe(true);
    expect(paymentAllocationViolation({ direction: "inbound", amount: "10.00", invoice_id: "inv_1" }, s)).toBeNull();
    expect(paymentAllocationViolation({ direction: "outbound", amount: "10.00", invoice_id: "inv_1" }, s)?.case).toBe(
      "outbound_names_inbound_document",
    );
  });
});

describe("a payment with no direction naming an invoice", () => {
  it("is told it carries no direction, not that it is outbound", () => {
    const s = paymentAllocationShape(withDirection({ kind: "enum", values: ["inbound", "outbound"] }, false))!;
    expect(s.directionExpressible).toBe(true);
    for (const missing of [{}, { direction: null }, { direction: "" }]) {
      expect(paymentAllocationViolation({ amount: "10.00", invoice_id: "inv_1", ...missing }, s)?.case).toBe(
        "unset_names_inbound_document",
      );
    }
    // A stated outbound keeps its own sentence.
    expect(paymentAllocationViolation({ direction: "outbound", amount: "10.00", invoice_id: "inv_1" }, s)?.case).toBe(
      "outbound_names_inbound_document",
    );
    const detail = PAYMENT_ALLOCATION_REFUSALS.payment_direction_mismatch.details.unset_names_inbound_document;
    expect(detail.startsWith("a payment with no direction")).toBe(true);
    expect(detail).not.toContain("an outbound payment");
  });
});

describe("paymentAllocationGuard — the edge table", () => {
  const guard = paymentAllocationGuard(shape);
  const store = new InMemoryEntityStore();
  const bad = { direction: "outbound", amount: "10.00", invoice_id: "inv_1" };
  const run = (
    operation: WriteGuardInput["operation"],
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    entity = "Payment",
  ) => guard({ operation, entity, tenantId: TENANT, id: operation === "create" ? null : "pay_1", before, after, store });

  it("refuses a bad create, with no completion suffix", async () => {
    const r = await run("create", null, { ...bad, state: "draft" });
    expect(r).toEqual({ status: 422, error: "payment_direction_mismatch", detail: PAYMENT_ALLOCATION_REFUSALS.payment_direction_mismatch.details.outbound_names_inbound_document });
  });

  it("allows an update to a bad draft that leaves the allocation fields alone", async () => {
    expect(await run("update", { ...bad, state: "draft" }, { ...bad, state: "draft", reference: "note" })).toBeNull();
  });

  it("checks an update that changes the amount to a negative, with no suffix", async () => {
    const before = { direction: "inbound", amount: "10.00", invoice_id: "inv_1", state: "draft" };
    const r = await run("update", before, { ...before, amount: "-30.00" });
    expect(r?.error).toBe("payment_amount_negative");
    expect(r?.detail).toBe(PAYMENT_ALLOCATION_REFUSALS.payment_amount_negative.details.amount_negative);
  });

  it("checks an update that changes the direction to the wrong side, with no suffix", async () => {
    const before = { direction: "inbound", amount: "10.00", invoice_id: "inv_1", state: "draft" };
    const r = await run("update", before, { ...before, direction: "outbound" });
    expect(r?.error).toBe("payment_direction_mismatch");
    expect(r?.detail).toBe(PAYMENT_ALLOCATION_REFUSALS.payment_direction_mismatch.details.outbound_names_inbound_document);
  });

  it("checks an update that changes a reference", async () => {
    const before = { direction: "inbound", amount: "10.00", invoice_id: "inv_1", state: "draft" };
    const r = await run("update", before, { ...before, bill_id: "bil_1" });
    expect(r?.error).toBe("payment_names_several_documents");
    expect(r?.detail?.endsWith(PAYMENT_ALLOCATION_COMPLETION_SUFFIX)).toBe(false);
  });

  it("refuses entering completed, with the suffix naming the remedy", async () => {
    const r = await run("transition", { ...bad, state: "pending" }, { ...bad, state: "completed" });
    expect(r?.error).toBe("payment_direction_mismatch");
    expect(r?.detail).toBe(
      PAYMENT_ALLOCATION_REFUSALS.payment_direction_mismatch.details.outbound_names_inbound_document + PAYMENT_ALLOCATION_COMPLETION_SUFFIX,
    );
  });

  it("allows refund and fail on a bad row, and submit into pending", async () => {
    expect(await run("transition", { ...bad, state: "completed" }, { ...bad, state: "refunded" })).toBeNull();
    expect(await run("transition", { ...bad, state: "pending" }, { ...bad, state: "failed" })).toBeNull();
    expect(await run("transition", { ...bad, state: "draft" }, { ...bad, state: "pending" })).toBeNull();
  });

  it("allows a delete: `after` is `before`, so no edge is entered and nothing changes", async () => {
    expect(await run("delete", { ...bad, state: "draft" }, { ...bad, state: "draft" })).toBeNull();
    expect(await run("delete", { ...bad, state: "completed" }, { ...bad, state: "completed" })).toBeNull();
  });

  it("a create landing in completed is refused without the suffix, which an update entering it carries", async () => {
    // Unreachable on the compiled path (lifecycleStateGuard refuses a create outside the initial
    // state first), but the guard is exported and runs on its own.
    const created = await run("create", null, { ...bad, state: "completed" });
    expect(created?.error).toBe("payment_direction_mismatch");
    expect(created?.detail?.endsWith(PAYMENT_ALLOCATION_COMPLETION_SUFFIX)).toBe(false);
    const updated = await run("update", { ...bad, state: "pending" }, { ...bad, state: "completed" });
    expect(updated?.detail?.endsWith(PAYMENT_ALLOCATION_COMPLETION_SUFFIX)).toBe(true);
  });

  it("ignores every other entity", async () => {
    expect(await run("create", null, { ...bad, state: "draft" }, "Invoice")).toBeNull();
  });
});

describe("paymentAllocationGuard — the payment's currency against its document's", () => {
  const guard = paymentAllocationGuard(shape);
  const seeded = async () => {
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Invoice", { id: "inv_eur", currency: "EUR", total: "100.00" });
    await store.create(TENANT, "Invoice", { id: "inv_none", total: "100.00" });
    await store.create(TENANT, "Bill", { id: "bil_usd", currency: "USD", total: "50.00" });
    return store;
  };
  const run = async (
    operation: WriteGuardInput["operation"],
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ) => guard({ operation, entity: "Payment", tenantId: TENANT, id: "pay_1", before, after, store: await seeded() });

  it("refuses a payment in another currency than the document it names", async () => {
    const r = await run("create", null, { direction: "inbound", amount: "100.00", currency: "USD", invoice_id: "inv_eur" });
    expect(r).toEqual({
      status: 422,
      error: "payment_currency_mismatch",
      detail: PAYMENT_ALLOCATION_REFUSALS.payment_currency_mismatch.details.currency_differs,
    });
    expect(
      (await run("create", null, { direction: "outbound", amount: "10.00", currency: "EUR", bill_id: "bil_usd" }))?.error,
    ).toBe("payment_currency_mismatch");
  });

  it("allows the document's own currency, compared case-insensitively", async () => {
    expect(await run("create", null, { direction: "inbound", amount: "100.00", currency: "EUR", invoice_id: "inv_eur" })).toBeNull();
    expect(await run("create", null, { direction: "inbound", amount: "100.00", currency: "eur", invoice_id: "inv_eur" })).toBeNull();
  });

  it("has nothing to compare where a side carries no currency, or the document does not exist", async () => {
    expect(await run("create", null, { direction: "inbound", amount: "1.00", currency: "USD", invoice_id: "inv_none" })).toBeNull();
    expect(await run("create", null, { direction: "inbound", amount: "1.00", invoice_id: "inv_eur" })).toBeNull();
    expect(await run("create", null, { direction: "inbound", amount: "1.00", currency: "USD", invoice_id: "inv_gone" })).toBeNull();
    expect(await run("create", null, { direction: "inbound", amount: "1.00", currency: "USD" })).toBeNull();
  });

  it("checks an update that changes the currency, and entering completed carries the suffix", async () => {
    const before = { direction: "inbound", amount: "100.00", currency: "EUR", invoice_id: "inv_eur", state: "draft" };
    expect((await run("update", before, { ...before, currency: "USD" }))?.error).toBe("payment_currency_mismatch");
    const stored = { ...before, currency: "USD", state: "pending" };
    const r = await run("transition", stored, { ...stored, state: "completed" });
    expect(r?.detail?.endsWith(PAYMENT_ALLOCATION_COMPLETION_SUFFIX)).toBe(true);
    // Refund of a stored cross-currency completed row stays exempt.
    expect(await run("transition", { ...stored, state: "completed" }, { ...stored, state: "refunded" })).toBeNull();
  });

  it("a shape-level refusal answers before the currency is read", async () => {
    const r = await run("create", null, { direction: "outbound", amount: "100.00", currency: "USD", invoice_id: "inv_eur" });
    expect(r?.error).toBe("payment_direction_mismatch");
  });
});

describe("the refusal table", () => {
  it("is total over the codes and their cases, all 422", () => {
    expect(Object.keys(PAYMENT_ALLOCATION_REFUSALS).sort()).toEqual([...PAYMENT_ALLOCATION_REFUSAL_CODES].sort());
    for (const code of PAYMENT_ALLOCATION_REFUSAL_CODES) {
      expect(PAYMENT_ALLOCATION_REFUSALS[code].status).toBe(422);
      expect(Object.keys(PAYMENT_ALLOCATION_REFUSALS[code].details).sort()).toEqual(
        [...PAYMENT_ALLOCATION_REFUSAL_CASES[code]].sort(),
      );
      for (const c of PAYMENT_ALLOCATION_REFUSAL_CASES[code]) {
        expect(paymentAllocationDetail({ code, case: c } as never).length).toBeGreaterThan(20);
      }
    }
    expect(Object.isFrozen(PAYMENT_ALLOCATION_REFUSALS)).toBe(true);
  });

  it("every *_id a sentence names is a declared reference, and every reference is named", () => {
    const details = PAYMENT_ALLOCATION_REFUSAL_CODES.flatMap((c) =>
      Object.values(PAYMENT_ALLOCATION_REFUSALS[c].details as Record<string, string>),
    );
    const named = new Set(details.flatMap((d) => d.match(/\b[a-z]+_id\b/g) ?? []));
    const declared = new Set(SETTLEMENT_COVERAGE_DOCUMENTS.map((d) => d.refField));
    expect([...named].sort()).toEqual([...declared].sort());
  });

  it("interpolates nothing: the module has no template literal, and its details are literals", () => {
    const code = strip(readFileSync(new URL("./payment-allocation.ts", import.meta.url), "utf8"));
    expect(code.includes("`")).toBe(false);
    expect(code.includes("${")).toBe(false);
    // Non-vacuity: the fence is over a module that really holds the sentences.
    const literals = code.match(/^\s+[a-z_]+:\s*\n?\s*"[^"]{20,}"/gm) ?? [];
    expect(literals.length).toBeGreaterThanOrEqual(5);
  });
});

describe("the settlement posting reads direction through the one spelling", () => {
  it("paymentSettlementGlPostingEffect calls paymentDirectionOf and compares no raw direction", () => {
    const source = strip(readFileSync(new URL("./write-effects.ts", import.meta.url), "utf8"));
    const start = source.indexOf("export function paymentSettlementGlPostingEffect");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\nfunction ", start));
    expect(body).toContain("paymentDirectionOf(pay, PAYMENT_DIRECTION)");
    expect(body.includes("=== c.inboundValue")).toBe(false);
    expect(body.includes("[c.directionField]")).toBe(false);
    expect(body.includes("c.directionField")).toBe(false);
    expect(body.includes("c.inboundValue")).toBe(false);
  });

  it("PaymentSettlementGlConfig declares no direction override, so the posting cannot read a second spelling", () => {
    const source = strip(readFileSync(new URL("./write-effects.ts", import.meta.url), "utf8"));
    const start = source.indexOf("export interface PaymentSettlementGlConfig");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("amountField");
    expect(body.includes("directionField")).toBe(false);
    expect(body.includes("inboundValue")).toBe(false);
    // @ts-expect-error — no `directionField` on the config (evaluated by `tsconfig.typecheck.json`).
    const _override: PaymentSettlementGlConfig = { directionField: "flow" };
    void _override;
  });

  it("the fold reads direction through paymentDirectionOf and counts only a positive amount", () => {
    const source = strip(readFileSync(new URL("./write-guards.ts", import.meta.url), "utf8"));
    const start = source.indexOf("async function foldCompletedPayments");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\nexport ", start));
    expect(body).toContain("paymentDirectionOf(");
    expect(body).toContain("settledBy");
    expect(body).toMatch(/if \(amount <= 0n\) continue;/);
  });
});

// Keep the type import honest: the shape a caller builds by hand is the one the guard reads.
const _typed: PaymentAllocationShape = { documents: [], references: [], directionExpressible: true };
void _typed;
