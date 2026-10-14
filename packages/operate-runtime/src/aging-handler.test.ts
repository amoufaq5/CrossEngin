import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { RoleName } from "@crossengin/auth";
import { beforeEach, describe, expect, it } from "vitest";

import { buildAgingHandler, type AgingResponse, type AgingSpec } from "./aging-handler.js";
import { InMemoryEntityStore, type ListPage, type ListQuery } from "./store.js";

const TENANT = "00000000-0000-4000-8000-000000000001";

const principalRoles = (p: ResolvedPrincipal | null) => ({
  primaryRole: p?.grantedScopes[0] ?? "anonymous",
});

function principal(role: string): ResolvedPrincipal {
  return {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: [role],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
}

const sections: Record<string, AgingSpec> = {
  ar: { entity: "Invoice", openStates: ["sent", "overdue"], paymentRefField: "invoice_id", numberField: "invoice_number" },
};

const bothSections: Record<string, AgingSpec> = {
  ...sections,
  ap: { entity: "Bill", openStates: ["approved"], paymentRefField: "bill_id", numberField: "bill_number" },
};

const clock = { now: () => new Date("2026-06-21T00:00:00.000Z") };

function buildHandler(
  store: InMemoryEntityStore,
  overrides?: { readonly sections?: Record<string, AgingSpec>; readonly maxRows?: number },
) {
  return buildAgingHandler({
    store,
    principalRoles,
    viewerRoles: new Set<RoleName>(["erp_admin" as RoleName]),
    sections: overrides?.sections ?? sections,
    clock,
    ...(overrides?.maxRows !== undefined ? { maxRows: overrides.maxRows } : {}),
  });
}

async function invoke(
  handler: ReturnType<typeof buildHandler>,
  query?: Record<string, string>,
): Promise<HandlerOutput> {
  const request = buildIncomingRequest({
    id: "req_aging00000001",
    receivedAt: "2026-06-21T12:00:00.000Z",
    method: "GET",
    path: "/v1/meta/aging",
    headers: {},
    host: "api.example.com",
    scheme: "https",
    bodyBytes: null,
    clientIp: "203.0.113.1",
    ...(query !== undefined ? { query } : {}),
  });
  return handler({
    request,
    route: {} as never,
    principal: principal("erp_admin"),
    params: {},
    parsedBody: null,
  });
}

function bodyOf(out: HandlerOutput): AgingResponse {
  if (out.kind !== "json") throw new Error("expected json");
  return out.body as AgingResponse;
}

describe("buildAgingHandler — ?asOf", () => {
  let store: InMemoryEntityStore;
  beforeEach(async () => {
    store = new InMemoryEntityStore();
    await store.create(TENANT, "Invoice", {
      invoice_number: "INV-1",
      state: "sent",
      total: 100,
      currency: "USD",
      due_date: "2026-05-01",
    });
  });

  it("uses the clock when ?asOf is absent", async () => {
    const out = await invoke(buildHandler(store));
    expect(bodyOf(out).asOf).toBe("2026-06-21");
  });

  it("honors a valid ?asOf (historical snapshot)", async () => {
    const out = await invoke(buildHandler(store), { asOf: "2026-04-15" });
    expect(bodyOf(out).asOf).toBe("2026-04-15");
  });

  it("ignores a malformed ?asOf and falls back to the clock", async () => {
    const out = await invoke(buildHandler(store), { asOf: "not-a-date" });
    expect(bodyOf(out).asOf).toBe("2026-06-21");
  });

  it("ignores an out-of-shape ?asOf (year only) and falls back to the clock", async () => {
    const out = await invoke(buildHandler(store), { asOf: "2026" });
    expect(bodyOf(out).asOf).toBe("2026-06-21");
  });
});

/** `n` open invoices of `total` each, plus `payments` completed payments of 1 against `INV-0`. */
async function seedAging(
  store: InMemoryEntityStore,
  counts: { readonly invoices: number; readonly payments: number; readonly bills?: number },
): Promise<void> {
  for (let i = 0; i < counts.invoices; i += 1) {
    await store.create(TENANT, "Invoice", {
      id: `inv_${String(i).padStart(5, "0")}`,
      invoice_number: `INV-${i}`,
      state: "sent",
      total: 10,
      currency: "USD",
      due_date: "2026-05-01",
    });
  }
  for (let i = 0; i < counts.payments; i += 1) {
    await store.create(TENANT, "Payment", {
      id: `pay_${String(i).padStart(5, "0")}`,
      state: "completed",
      amount: 1,
      invoice_id: "inv_00000",
    });
  }
  for (let i = 0; i < (counts.bills ?? 0); i += 1) {
    await store.create(TENANT, "Bill", {
      id: `bill_${String(i).padStart(5, "0")}`,
      bill_number: `BILL-${i}`,
      state: "approved",
      total: 10,
      currency: "USD",
      due_date: "2026-05-01",
    });
  }
}

describe("buildAgingHandler — draining both reads", () => {
  it("totals every open document and every payment across pages", async () => {
    // Both sets are deliberately past **5000**, which is the cap this handler used to read in one
    // page — not past the drain's 500-row page size, which is the figure a first version of this
    // test used. 1200 and 1100 are several pages of 500 and the drain pages them correctly, but a
    // `limit: 5000` single read covered them too (`InMemoryEntityStore` does not clamp `limit`), so
    // the test passed identically against the code it was written to refute. 5200 × 10 = 52,000
    // open, less the 5100 applied to INV-0, whose own open therefore falls below 0 and drops it out
    // of the report entirely.
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 5200, payments: 5100 });
    const body = bodyOf(await invoke(buildHandler(store)));
    const ar = body.sections["ar"]!;
    expect(ar.documents).toHaveLength(5199);
    expect(ar.totalOpen).toBe(51_990);
    expect(ar.documents.some((d) => d.id === "inv_00000")).toBe(false);
    expect(body.complete).toBe(true);
  });

  it("applies a payment tail that a one-page read would have dropped", async () => {
    // The direction that matters: a dropped payment leaves `applied` too small, so the balance is
    // OVERSTATED. At `maxRows: 600` the 1100th payment is unread and INV-0 reads 10 − 600 < 0,
    // where the whole set settles it to exactly 0 and drops it.
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 2, payments: 1100 });
    const bounded = bodyOf(await invoke(buildHandler(store, { maxRows: 600 })));
    expect(bounded.sections["ar"]!.documents.map((d) => d.id)).toEqual(["inv_00001"]);
    expect(bounded.bounded).toEqual(["payments"]);

    const whole = bodyOf(await invoke(buildHandler(store)));
    expect(whole.sections["ar"]!.documents.map((d) => d.id)).toEqual(["inv_00001"]);
    expect(whole.complete).toBe(true);
  });

  it("keeps each section's applied map keyed by that section's own ref field", async () => {
    // A bill and an invoice sharing an id: records are bucketed per (tenant, entity) and a
    // caller-supplied `id` is not stripped, so one shared map keyed by document id would credit the
    // invoice with the bill's payment. Each section's payments are read off its own
    // `paymentRefField` in the single pass, so the two never meet.
    const store = new InMemoryEntityStore();
    await store.create(TENANT, "Invoice", { id: "shared", invoice_number: "INV-S", state: "sent", total: 100, currency: "USD" });
    await store.create(TENANT, "Bill", { id: "shared", bill_number: "BILL-S", state: "approved", total: 100, currency: "USD" });
    await store.create(TENANT, "Payment", { state: "completed", amount: 40, bill_id: "shared" });
    const body = bodyOf(await invoke(buildHandler(store, { sections: bothSections })));
    expect(body.sections["ar"]!.documents[0]).toMatchObject({ applied: 0, open: 100 });
    expect(body.sections["ap"]!.documents[0]).toMatchObject({ applied: 40, open: 60 });
  });

  it("reads the payments once however many sections there are", async () => {
    // The accumulators are hoisted out of the section loop, so two sections cost one payment drain
    // and not two. 1100 payments at a 500-row page is three round trips (the third short, carrying
    // the null cursor that ends the walk) — three, not six.
    class CountingStore extends InMemoryEntityStore {
      paymentPages = 0;
      override async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
        if (entity === "Payment") this.paymentPages += 1;
        return super.listPage(tenantId, entity, query);
      }
    }
    const store = new CountingStore();
    await seedAging(store, { invoices: 2, payments: 1100, bills: 2 });
    await invoke(buildHandler(store, { sections: bothSections }));
    expect(store.paymentPages).toBe(3);
  });
});

describe("buildAgingHandler — the bounded declaration", () => {
  it("declares a complete reading with an empty bounded list", async () => {
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 3, payments: 2, bills: 3 });
    const body = bodyOf(await invoke(buildHandler(store, { sections: bothSections })));
    expect(body.complete).toBe(true);
    expect(body.bounded).toEqual([]);
  });

  it("carries `complete` on every answer, so an absent field is never the happy path", async () => {
    // The field is the claim: omitting it on a complete reading would make "we read all of it"
    // indistinguishable from an older server that never looked.
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 1, payments: 0 });
    const body = bodyOf(await invoke(buildHandler(store)));
    expect(Object.keys(body)).toEqual(["asOf", "sections", "complete", "bounded"]);
    expect("complete" in body).toBe(true);
  });

  it("names the payment read and every bounded section", async () => {
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 30, payments: 30, bills: 30 });
    const body = bodyOf(await invoke(buildHandler(store, { sections: bothSections, maxRows: 10 })));
    expect(body.complete).toBe(false);
    expect(body.bounded).toEqual(["payments", "ar", "ap"]);
  });

  it("names only the section whose own read was bounded", async () => {
    // One bounded read must not make the complete one look bounded: `ar` is 3 documents and `ap` is
    // 30, so at a ceiling of 10 the declaration names `ap` alone — and `ar`'s figures are exact.
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 3, payments: 0, bills: 30 });
    const body = bodyOf(await invoke(buildHandler(store, { sections: bothSections, maxRows: 10 })));
    expect(body.bounded).toEqual(["ap"]);
    expect(body.sections["ar"]!.documents).toHaveLength(3);
    expect(body.sections["ar"]!.totalOpen).toBe(30);
    // The bounded section is still served — a report over a prefix is the only view there is.
    expect(body.sections["ap"]!.documents).toHaveLength(10);
  });

  it("still reports complete when the set is exactly the ceiling", async () => {
    // The drain spends one page beyond its row budget to tell "exactly `ceiling` rows, and that is
    // all of them" from "`ceiling` rows and more behind them".
    const store = new InMemoryEntityStore();
    await seedAging(store, { invoices: 10, payments: 10 });
    expect(bodyOf(await invoke(buildHandler(store, { maxRows: 10 }))).complete).toBe(true);
    expect(bodyOf(await invoke(buildHandler(store, { maxRows: 9 }))).complete).toBe(false);
  });
});
